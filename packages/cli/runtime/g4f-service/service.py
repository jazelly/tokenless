from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import uvicorn
from fastapi import APIRouter, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware

import g4f
from g4f.api import create_app
from g4f.config import AppConfig
from g4f.cookies import (
    BrowserConfig,
    CookiesConfig,
    HeadersConfig,
    read_cookie_files,
    set_cookies_dir,
)
from g4f.Provider import ProviderUtils


SERVICE_PROTOCOL = "tokenless.g4f-service.v1"
PINNED_G4F_VERSION = "8.1.2"
PINNED_G4F_COMMIT = "fdbd84b7c5129ea8faa7c66065425ca344ea5fb2"
SERVICE_REVISION = 12
SAFE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
CONTROL_PREFIX = "/tokenless/"
SERVICE_KEY_HEADER = b"x-tokenless-service-key"
AUTH_CONTEXT_HEADER = b"x-tokenless-auth-context"


@dataclass
class AuthContext:
    context_id: str
    provider: str
    profile: str
    lifetime: str
    source_type: str
    directory: Path
    source: dict[str, Any]


class AuthContextRegistry:
    def __init__(self, root: Path, allowed_roots: tuple[Path, ...]) -> None:
        self.root = root.resolve()
        self.allowed_roots = tuple(item.resolve() for item in allowed_roots)
        self.contexts: dict[str, AuthContext] = {}
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self._load_persisted()

    def create(self, context_id: str, payload: dict[str, Any]) -> AuthContext:
        if not SAFE_ID.fullmatch(context_id):
            raise HTTPException(422, "Invalid auth context id.")
        if context_id in self.contexts:
            raise HTTPException(409, "Auth context already exists.")
        provider = require_text(payload, "provider")
        if provider not in ProviderUtils.convert:
            raise HTTPException(404, "Unknown G4F provider.")
        profile = require_text(payload, "profile")
        lifetime = payload.get("lifetime", "ephemeral")
        if lifetime not in ("ephemeral", "user-persisted"):
            raise HTTPException(422, "Invalid auth context lifetime.")
        source = payload.get("source")
        if not isinstance(source, dict):
            raise HTTPException(422, "Auth context source is required.")
        source_type = require_text(source, "type")
        if source_type not in ("empty", "manual", "har", "cookie-file", "browser-cookie3", "cookie-database", "cdp"):
            raise HTTPException(422, "Unsupported auth context source.")
        directory = (self.root / context_id).resolve()
        if directory.parent != self.root:
            raise HTTPException(422, "Invalid auth context directory.")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
        context = AuthContext(context_id, provider, profile, lifetime, source_type, directory, dict(source))
        self._validate_source(context)
        self.contexts[context_id] = context
        if lifetime == "user-persisted":
            self._persist(context)
        return context

    def list(self) -> list[AuthContext]:
        return list(self.contexts.values())

    def get(self, context_id: str) -> AuthContext:
        context = self.contexts.get(context_id)
        if context is None:
            raise HTTPException(404, "Auth context not found.")
        return context

    def delete(self, context_id: str) -> None:
        context = self.contexts.pop(context_id, None)
        if context is not None:
            shutil.rmtree(context.directory, ignore_errors=True)

    def cleanup_ephemeral(self) -> None:
        for context_id, context in tuple(self.contexts.items()):
            if context.lifetime == "ephemeral":
                self.contexts.pop(context_id, None)
                shutil.rmtree(context.directory, ignore_errors=True)

    def _validate_source(self, context: AuthContext) -> None:
        if context.source_type == "manual":
            cookies = context.source.get("cookies", {})
            headers = context.source.get("headers", {})
            if not isinstance(cookies, dict) or not isinstance(headers, dict):
                raise HTTPException(422, "Manual auth cookies and headers must be objects.")
            api_key = context.source.get("apiKey")
            if api_key is not None and (not isinstance(api_key, str) or not api_key):
                raise HTTPException(422, "Manual auth apiKey must be a non-empty string.")
            allowed = provider_domains(context.provider)
            for domain in (*cookies.keys(), *headers.keys()):
                if not isinstance(domain, str) or not domain_allowed(domain, allowed):
                    raise HTTPException(422, "Manual auth material is outside the selected provider scope.")
        elif context.source_type in ("browser-cookie3", "cookie-database"):
            browser = context.source.get("browser", "chrome")
            if browser not in ("chrome", "chromium", "brave", "edge", "firefox", "opera", "opera_gx", "vivaldi"):
                raise HTTPException(422, "Unsupported cookie database browser.")
        if context.source_type in ("browser-cookie3", "cookie-database"):
            database = require_text(context.source, "path")
            resolved = Path(database).expanduser().resolve()
            if not resolved.is_file() or not any(is_beneath(resolved, root) for root in self.allowed_roots):
                raise HTTPException(422, "Cookie database path is outside the configured browser profile.")
            context.source["path"] = str(resolved)
        elif context.source_type == "cdp":
            host = context.source.get("host", "127.0.0.1")
            port = context.source.get("port")
            if host not in ("127.0.0.1", "localhost", "::1") or not isinstance(port, int) or not 1 <= port <= 65535:
                raise HTTPException(422, "CDP auth source must use a loopback host and valid port.")

    def _persist(self, context: AuthContext) -> None:
        target = context.directory / ".tokenless-context.json"
        target.write_text(json.dumps({
            "provider": context.provider,
            "profile": context.profile,
            "lifetime": context.lifetime,
            "source": context.source,
        }, separators=(",", ":")))
        os.chmod(target, 0o600)

    def _load_persisted(self) -> None:
        for directory in self.root.iterdir():
            if not directory.is_dir() or not SAFE_ID.fullmatch(directory.name):
                continue
            if directory.resolve().parent != self.root:
                continue
            metadata = directory / ".tokenless-context.json"
            if not metadata.exists():
                shutil.rmtree(directory, ignore_errors=True)
                continue
            try:
                payload = json.loads(metadata.read_text())
                if not isinstance(payload, dict) or payload.get("lifetime") != "user-persisted":
                    continue
                source = payload.get("source")
                if not isinstance(source, dict):
                    continue
                context = AuthContext(
                    directory.name,
                    require_text(payload, "provider"),
                    require_text(payload, "profile"),
                    "user-persisted",
                    require_text(source, "type"),
                    directory.resolve(),
                    source,
                )
                self._validate_source(context)
                self.contexts[context.context_id] = context
            except (OSError, ValueError, json.JSONDecodeError, HTTPException):
                continue


def require_text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(422, f"{key} is required.")
    return value.strip()


def is_beneath(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def provider_domains(provider_name: str) -> tuple[str, ...]:
    provider = ProviderUtils.convert.get(provider_name)
    host = urlparse(getattr(provider, "url", "")).hostname or ""
    domains = {host.lower()}
    if host.count(".") >= 1:
        domains.add("." + ".".join(host.split(".")[-2:]).lower())
    additions = {
        "OpenaiChat": ("chatgpt.com", ".openai.com"),
        "Gemini": (".google.com", "gemini.google.com"),
        "Perplexity": (".perplexity.ai",),
        "Copilot": (".bing.com", ".microsoft.com"),
        "BingCreateImages": (".bing.com",),
        "DeepSeek": ("chat.deepseek.com", ".deepseek.com"),
        "Grok": ("grok.com", ".x.ai", ".twitter.com"),
        "Qwen": ("chat.qwen.ai", ".qwen.ai"),
        "Yupp": ("yupp.ai",),
    }
    domains.update(additions.get(provider_name, ()))
    return tuple(item for item in domains if item)


def domain_allowed(domain: str, allowed: tuple[str, ...]) -> bool:
    normalized = domain.lower().lstrip(".")
    return any(
        normalized == candidate.lower().lstrip(".")
        or normalized.endswith("." + candidate.lower().lstrip("."))
        for candidate in allowed
    )


def reset_auth_state(empty_directory: Path) -> None:
    set_cookies_dir(str(empty_directory))
    CookiesConfig.cookies.clear()
    HeadersConfig.headers.clear()
    BrowserConfig.host = "127.0.0.1"
    BrowserConfig.port = None
    BrowserConfig.executable_path = None


def reset_provider_auth_state(provider_name: str) -> None:
    provider = ProviderUtils.convert.get(provider_name)
    if provider is None:
        return
    for attribute in (
        "_api_key",
        "_api_key_cache",
        "_access_token",
        "_token",
        "_headers",
        "_cookies",
        "_expires",
        "_metadata",
        "_metadata_auth_user",
        "_session",
        "_client",
    ):
        if attribute in vars(provider):
            setattr(provider, attribute, None)
    request_config = vars(provider).get("request_config")
    if request_config is not None:
        try:
            provider.request_config = type(request_config)()
        except TypeError:
            provider.request_config = None


def activate_auth_context(context: AuthContext, empty_directory: Path) -> None:
    reset_auth_state(empty_directory)
    reset_provider_auth_state(context.provider)
    set_cookies_dir(str(context.directory))
    if context.source_type in ("har", "cookie-file"):
        read_cookie_files(str(context.directory), list(provider_domains(context.provider)))
    elif context.source_type == "manual":
        for domain, cookies in context.source.get("cookies", {}).items():
            if isinstance(cookies, dict):
                CookiesConfig.cookies[domain] = {str(key): str(value) for key, value in cookies.items()}
        for domain, headers in context.source.get("headers", {}).items():
            if isinstance(headers, dict):
                HeadersConfig.headers[domain] = {str(key): str(value) for key, value in headers.items()}
        write_manual_auth_cache(context)
    elif context.source_type in ("browser-cookie3", "cookie-database"):
        load_cookie_database(context)
    elif context.source_type == "cdp":
        BrowserConfig.host = context.source.get("host", "127.0.0.1")
        BrowserConfig.port = context.source["port"]


def write_manual_auth_cache(context: AuthContext) -> None:
    api_key = context.source.get("apiKey")
    if not api_key:
        return
    cookies = {
        str(key): str(value)
        for scoped in context.source.get("cookies", {}).values()
        if isinstance(scoped, dict)
        for key, value in scoped.items()
    }
    headers = {
        str(key).lower(): str(value)
        for scoped in context.source.get("headers", {}).values()
        if isinstance(scoped, dict)
        for key, value in scoped.items()
    }
    target = context.directory / f"auth_{context.provider}.json"
    target.write_text(json.dumps({
        "api_key": api_key,
        "cookies": cookies,
        "headers": headers,
    }, separators=(",", ":")))
    os.chmod(target, 0o600)


def load_cookie_database(context: AuthContext) -> None:
    if sys.platform == "darwin":
        raise HTTPException(
            409,
            "browser-cookie3 and cookie-database sources are disabled on macOS; use a Tokenless managed CDP or manual provider session source.",
        )
    import browser_cookie3

    loader = getattr(browser_cookie3, context.source.get("browser", "chrome"), None)
    if loader is None:
        raise HTTPException(422, "Cookie database browser loader is unavailable.")
    cookie_file = context.source.get("path")
    for domain in provider_domains(context.provider):
        try:
            jar = loader(**({"cookie_file": cookie_file} if cookie_file else {}), domain_name=domain)
        except TypeError:
            jar = loader(cookie_file, domain) if cookie_file else loader(domain_name=domain)
        scoped: dict[str, str] = {}
        for cookie in jar:
            if domain_allowed(cookie.domain, (domain,)):
                scoped[cookie.name] = cookie.value
        if scoped:
            CookiesConfig.cookies[domain] = scoped


def context_id_from_scope(scope: dict[str, Any]) -> str | None:
    for name, value in scope.get("headers", []):
        if name.lower() == AUTH_CONTEXT_HEADER:
            return value.decode("utf-8", "strict")
    return None


def provider_from_path(path: str) -> str | None:
    match = re.match(r"^/api/([^/]+)(?:/|$)", path)
    if not match:
        return None
    provider = match.group(1)
    return provider if provider in ProviderUtils.convert else None


async def inject_manual_api_key(
    scope: dict[str, Any],
    receive: Any,
    context: AuthContext | None,
) -> Any:
    if context is None or context.source_type != "manual" or not context.source.get("apiKey"):
        return receive
    content_type = header_from_scope(scope, b"content-type") or ""
    if scope.get("method") != "POST" or "application/json" not in content_type.lower():
        return receive
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message.get("type") != "http.request":
            continue
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            break
    body = b"".join(chunks)
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return replay_body(body)
    if isinstance(payload, dict) and "api_key" not in payload:
        payload["api_key"] = context.source["apiKey"]
    return replay_body(json.dumps(payload, separators=(",", ":")).encode())


def replay_body(body: bytes) -> Any:
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


def header_from_scope(scope: dict[str, Any], target: bytes) -> str | None:
    for name, value in scope.get("headers", []):
        if name.lower() == target:
            return value.decode("utf-8", "strict")
    return None


class TokenlessBoundary:
    def __init__(
        self,
        app: Any,
        service_key: str,
        registry: AuthContextRegistry,
        empty_directory: Path,
    ) -> None:
        self.app = app
        self.service_key = service_key
        self.registry = registry
        self.empty_directory = empty_directory
        self.request_lock = asyncio.Lock()

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        supplied = header_from_scope(scope, SERVICE_KEY_HEADER)
        if supplied is None or not hmac.compare_digest(supplied, self.service_key):
            await JSONResponse({"error": {"code": "unauthorized", "message": "Unauthorized."}}, 401)(scope, receive, send)
            return
        path = scope.get("path", "")
        if path.startswith(CONTROL_PREFIX):
            await self.app(scope, receive, send)
            return
        context_id = context_id_from_scope(scope)
        async with self.request_lock:
            try:
                context = self.registry.get(context_id) if context_id else None
            except HTTPException as error:
                await JSONResponse({"error": {"code": "auth_context_invalid", "message": str(error.detail)}}, error.status_code)(scope, receive, send)
                return
            request_provider = provider_from_path(path)
            if context is not None and request_provider is not None and context.provider != request_provider:
                await JSONResponse({"error": {"code": "auth_context_provider_mismatch", "message": "Auth context provider mismatch."}}, 409)(scope, receive, send)
                return
            if context_id:
                try:
                    activate_auth_context(context, self.empty_directory)
                except HTTPException as error:
                    await JSONResponse({"error": {"code": "auth_context_activation_failed", "message": str(error.detail)}}, error.status_code)(scope, receive, send)
                    return
            else:
                reset_auth_state(self.empty_directory)
                if request_provider:
                    reset_provider_auth_state(request_provider)
            receive = await inject_manual_api_key(scope, receive, context)
            await self.app(scope, receive, send)


def remove_stock_middleware(app: FastAPI) -> None:
    retained = []
    for middleware in app.user_middleware:
        dispatch = middleware.kwargs.get("dispatch")
        if middleware.cls is CORSMiddleware or getattr(dispatch, "__name__", "") == "log_requests":
            continue
        retained.append(middleware)
    app.user_middleware = retained
    app.middleware_stack = None


def retain_private_routes(app: FastAPI) -> None:
    exact = {
        "/v1/models",
        "/v1/providers",
        "/pa/providers",
        "/images/{filename}",
        "/media/{filename}",
    }
    prefixes = (
        "/api/{provider:path}/models",
        "/api/{provider:path}/quota",
        "/v1/models/{model_name}",
        "/api/{provider:path}/chat/completions",
        "/api/{provider}/{conversation_id}/chat/completions",
        "/api/{provider:path}/responses",
        "/api/{provider:path}/messages",
        "/api/{provider:path}/images/generations",
        "/v1/providers/{provider}",
        "/pa/providers/{provider_id}",
        "/api/{path_provider:path}/audio/transcriptions",
        "/api/{provider:path}/audio/speech",
    )
    app.router.routes = [
        route for route in app.router.routes
        if getattr(route, "path", "") in exact or getattr(route, "path", "") in prefixes
    ]


def create_private_app(
    service_key: str,
    auth_root: Path,
    pa_root: Path,
    allowed_roots: tuple[Path, ...],
) -> Any:
    AppConfig.set_config(
        ignore_cookie_files=True,
        g4f_api_key=service_key,
        gui=False,
        demo=False,
        disable_custom_api_key=False,
    )
    AppConfig.load_from_env()
    for name in tuple(logging.Logger.manager.loggerDict):
        if name == "g4f" or name.startswith("g4f."):
            logging.getLogger(name).disabled = True

    import g4f.mcp.pa_provider as pa_provider
    import g4f.cookies as g4f_cookies

    pa_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(pa_root, 0o700)
    pa_provider.get_workspace_dir = lambda: pa_root
    g4f_cookies.BROWSERS = []

    app = create_app()
    remove_stock_middleware(app)
    retain_private_routes(app)
    registry = AuthContextRegistry(auth_root, allowed_roots)
    empty_directory = auth_root / "_empty"
    empty_directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    control = APIRouter(prefix="/tokenless")

    @control.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "protocol": SERVICE_PROTOCOL,
            "status": "ready",
            "g4fVersion": g4f.version.utils.current_version,
            "pinnedG4fVersion": PINNED_G4F_VERSION,
            "pinnedG4fCommit": PINNED_G4F_COMMIT,
            "workerCount": 1,
            "paAutoDownload": False,
            "paRoot": "setup-managed",
            "requestLogging": False,
            "serviceRevision": SERVICE_REVISION,
        }

    @control.post("/auth-contexts/{context_id}")
    async def create_auth_context(context_id: str, request: Request) -> dict[str, Any]:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(422, "Auth context payload must be an object.")
        context = registry.create(context_id, payload)
        return public_context(context)

    @control.get("/auth-contexts")
    async def list_auth_contexts() -> list[dict[str, str]]:
        return [public_context(context) for context in registry.list()]

    @control.post("/auth-contexts/{context_id}/files")
    async def upload_auth_files(context_id: str, files: list[UploadFile] = File(...)) -> dict[str, Any]:
        context = registry.get(context_id)
        if context.source_type not in ("har", "cookie-file"):
            raise HTTPException(409, "Auth context does not accept files.")
        accepted: list[str] = []
        for upload in files:
            filename = Path(upload.filename or "").name
            suffix = Path(filename).suffix.lower()
            if not SAFE_ID.fullmatch(filename) or suffix not in (".har", ".json"):
                raise HTTPException(422, "Only named .har and .json auth files are accepted.")
            target = context.directory / filename
            content = await upload.read()
            if len(content) > 64 * 1024 * 1024:
                raise HTTPException(413, "Auth file is too large.")
            target.write_bytes(sanitize_auth_file(context, content, suffix))
            os.chmod(target, 0o600)
            accepted.append(filename)
        return {"contextId": context.context_id, "files": accepted}

    @control.delete("/auth-contexts/{context_id}")
    async def delete_auth_context(context_id: str) -> dict[str, bool]:
        registry.delete(context_id)
        return {"deleted": True}

    @app.on_event("shutdown")
    async def cleanup_ephemeral_auth_contexts() -> None:
        registry.cleanup_ephemeral()

    app.include_router(control)
    app.middleware_stack = None
    return TokenlessBoundary(app, service_key, registry, empty_directory)


def public_context(context: AuthContext) -> dict[str, str]:
    return {
        "contextId": context.context_id,
        "provider": context.provider,
        "profile": context.profile,
        "lifetime": context.lifetime,
        "sourceType": context.source_type,
    }


def sanitize_auth_file(context: AuthContext, content: bytes, suffix: str) -> bytes:
    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(422, "Auth file must contain valid JSON.")
    allowed = provider_domains(context.provider)
    if isinstance(payload, dict) and isinstance(payload.get("log"), dict):
        entries = payload["log"].get("entries")
        if not isinstance(entries, list):
            raise HTTPException(422, "HAR auth file has no entries.")
        filtered = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("request"), dict):
                continue
            url = entry["request"].get("url")
            host = urlparse(url).hostname if isinstance(url, str) else None
            if host and domain_allowed(host, allowed):
                filtered.append(entry)
        if not filtered:
            raise HTTPException(422, "HAR auth file has no requests for the selected provider.")
        payload = {
            "log": {
                "version": payload["log"].get("version", "1.2"),
                "creator": payload["log"].get("creator", {"name": "Tokenless", "version": "1"}),
                "entries": filtered,
            }
        }
    elif suffix == ".json":
        if isinstance(payload, dict):
            normalized = []
            for domain, cookies in payload.items():
                if not isinstance(domain, str) or not isinstance(cookies, dict) or not domain_allowed(domain, allowed):
                    raise HTTPException(422, "Cookie auth file is outside the selected provider scope.")
                for name, value in cookies.items():
                    if not isinstance(name, str):
                        raise HTTPException(422, "Cookie auth file has an invalid cookie name.")
                    cookie = value if isinstance(value, dict) else {"value": value}
                    normalized.append({**cookie, "domain": domain, "name": name})
            payload = normalized
        elif isinstance(payload, list):
            if any(
                not isinstance(item, dict)
                or not isinstance(item.get("domain"), str)
                or not domain_allowed(item["domain"], allowed)
                for item in payload
            ):
                raise HTTPException(422, "Cookie auth file is outside the selected provider scope.")
        else:
            raise HTTPException(422, "Cookie auth file must contain a cookie list or domain map.")
        cookie_domains = [item.get("domain") for item in payload if isinstance(item, dict)]
        if not cookie_domains or any(not domain_allowed(domain, allowed) for domain in cookie_domains):
            raise HTTPException(422, "Cookie auth file is outside the selected provider scope.")
    else:
        raise HTTPException(422, "HAR auth file has an invalid structure.")
    return json.dumps(payload, separators=(",", ":")).encode()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--auth-root", required=True)
    parser.add_argument("--pa-root", required=True)
    parser.add_argument("--allowed-root", action="append", default=[])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.host not in ("127.0.0.1", "::1"):
        raise SystemExit("Tokenless G4F service must bind to loopback.")
    service_key = os.environ.get("TOKENLESS_G4F_SERVICE_KEY")
    if not service_key or len(service_key) < 32:
        raise SystemExit("TOKENLESS_G4F_SERVICE_KEY is required.")
    app = create_private_app(
        service_key,
        Path(args.auth_root),
        Path(args.pa_root),
        tuple(Path(item) for item in args.allowed_root),
    )
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        workers=1,
        access_log=False,
        log_level="warning",
        use_colors=False,
    )


if __name__ == "__main__":
    main()
