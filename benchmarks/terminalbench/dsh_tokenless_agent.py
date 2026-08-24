"""Harbor agent for the pinned DeepSeek Harness Terminal-Bench 2.0 lane."""

from __future__ import annotations

import hmac
import http.client
import http.server
import json
import re
import secrets
import shlex
import threading
from pathlib import Path
from typing import Any, override
from urllib.parse import urlsplit

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


DSH_REVISION = "47f943859bef60e4160492346772ded9b24f765a"
CHANNEL_PROTOCOL = "tokenless.terminalbench-channel.v1"
AUDIT_PROTOCOL = "tokenless.terminalbench-deep-audit.v1"
PROXY_PORT = 18765
MAX_BRIDGE_BODY_BYTES = 8 * 1024 * 1024
ALLOWED_COMPLETION_PATHS = {
    "/v1/chat/completions",
    "/v1/openai/chat/completions",
}
ALLOWED_PROVIDER_TURN_PREFIX = "/v1/private/provider-turn/"
BENCHMARK_AUDIT_PATH = "/v1/private/benchmark-audit"


class _ScopedBridgeServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        daemon_url: str,
        control_token: str,
        channel_token: str,
    ) -> None:
        super().__init__(address, _ScopedBridgeHandler)
        parsed = urlsplit(daemon_url)
        if parsed.scheme != "http" or parsed.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ValueError("Terminal-Bench daemon URL must be a loopback HTTP origin.")
        if (
            parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
            or parsed.port is None
        ):
            raise ValueError("Terminal-Bench daemon URL must be an origin with a port.")
        self.daemon_host = parsed.hostname
        self.daemon_port = parsed.port
        self.control_token = control_token
        self.channel_token = channel_token
        self._audit_lock = threading.Lock()
        self._audit_events: list[dict[str, Any]] = []
        self._subagent_dispatch_lock = threading.Lock()
        self._subagent_dispatched = False

    def should_require_subagent(self) -> bool:
        with self._subagent_dispatch_lock:
            return not self._subagent_dispatched

    def mark_subagent_dispatched(self) -> None:
        with self._subagent_dispatch_lock:
            self._subagent_dispatched = True

    def record_client_event(self, body: bytes) -> None:
        try:
            value = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Invalid benchmark audit event.") from error
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise ValueError("Invalid benchmark audit event.")
        event_type = value["type"]
        expected_keys = {
            "harness.started": {"type", "runId"},
            "child.tool_result": {"type", "runId", "status"},
            "harness.settled": {"type", "runId", "status"},
        }.get(event_type)
        if expected_keys is None or set(value) != expected_keys:
            raise ValueError("Invalid benchmark audit event.")
        run_id = value.get("runId")
        if not isinstance(run_id, str) or re.fullmatch(r"run_[a-f0-9]{32}", run_id) is None:
            raise ValueError("Invalid benchmark audit run ID.")
        if event_type == "child.tool_result" and value.get("status") not in {
            "succeeded",
            "failed",
            "authentication_required",
        }:
            raise ValueError("Invalid benchmark tool result status.")
        if event_type == "harness.settled" and value.get("status") not in {
            "succeeded",
            "failed",
            "cancelled",
        }:
            raise ValueError("Invalid benchmark settlement status.")
        self.record_event(value)

    def record_event(self, value: dict[str, Any]) -> None:
        with self._audit_lock:
            self._audit_events.append(
                {
                    "protocol": AUDIT_PROTOCOL,
                    "sequence": len(self._audit_events) + 1,
                    **value,
                }
            )

    def audit_events(self) -> list[dict[str, Any]]:
        with self._audit_lock:
            return [dict(event) for event in self._audit_events]


class _ScopedBridgeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        self._forward()

    def do_POST(self) -> None:  # noqa: N802
        self._forward()

    def _forward(self) -> None:
        path = urlsplit(self.path).path
        if (
            path not in ALLOWED_COMPLETION_PATHS
            and path != BENCHMARK_AUDIT_PATH
            and not path.startswith(ALLOWED_PROVIDER_TURN_PREFIX)
        ):
            self.send_error(404)
            return
        if not self._authorized():
            self.send_error(401)
            return
        length_header = self.headers.get("Content-Length")
        try:
            length = int(length_header) if length_header is not None else 0
        except ValueError:
            self.send_error(400)
            return
        if length < 0 or length > MAX_BRIDGE_BODY_BYTES:
            self.send_error(413)
            return
        body = self.rfile.read(length) if length else None
        if path == BENCHMARK_AUDIT_PATH:
            if self.command != "POST" or body is None:
                self.send_error(405)
                return
            try:
                self.server.record_client_event(body)  # type: ignore[attr-defined]
            except ValueError:
                self.send_error(400)
                return
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path in ALLOWED_COMPLETION_PATHS and self.command == "POST":
            tool_count = 0
            forced_subagent = False
            try:
                request_value = json.loads(body or b"{}")
                tools = request_value.get("tools") if isinstance(request_value, dict) else None
                tool_count = len(tools) if isinstance(tools, list) else 0
                has_subagent = isinstance(tools, list) and any(
                    isinstance(tool, dict)
                    and isinstance(tool.get("function"), dict)
                    and tool["function"].get("name") == "subagent"
                    for tool in tools
                )
                if (
                    isinstance(request_value, dict)
                    and has_subagent
                    and self.server.should_require_subagent()  # type: ignore[attr-defined]
                ):
                    request_value["tool_choice"] = {
                        "type": "function",
                        "function": {"name": "subagent"},
                    }
                    request_value["parallel_tool_calls"] = False
                    body = json.dumps(
                        request_value, separators=(",", ":")
                    ).encode("utf-8")
                    forced_subagent = True
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
            self.server.record_event(  # type: ignore[attr-defined]
                {
                    "type": "api.completion.request",
                    "bodyBytes": len(body or b""),
                    "toolCount": tool_count,
                }
            )
        else:
            forced_subagent = False
        headers = {
            "Authorization": f"Bearer {self.server.control_token}",  # type: ignore[attr-defined]
            "Accept": self.headers.get("Accept", "application/json"),
        }
        for name in (
            "Content-Type",
            "X-Tokenless-Attachment-Name",
            "X-Tokenless-Bundle-With",
            "X-Tokenless-Payload-Lifetime",
        ):
            value = self.headers.get(name)
            if value is not None:
                headers[name] = value
        connection = http.client.HTTPConnection(
            self.server.daemon_host,  # type: ignore[attr-defined]
            self.server.daemon_port,  # type: ignore[attr-defined]
            timeout=1_900,
        )
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            upstream = connection.getresponse()
            if forced_subagent and upstream.status < 400:
                self.server.mark_subagent_dispatched()  # type: ignore[attr-defined]
            if (
                self.command == "POST"
                and path.endswith("/turns")
                and upstream.status < 400
            ):
                self.server.record_event(  # type: ignore[attr-defined]
                    {"type": "provider.turn.started", "status": upstream.status}
                )
            self.send_response(upstream.status)
            for name, value in upstream.getheaders():
                if name.lower() not in {
                    "connection",
                    "keep-alive",
                    "transfer-encoding",
                    "content-length",
                }:
                    self.send_header(name, value)
            content_length = upstream.getheader("Content-Length")
            if content_length is not None:
                self.send_header("Content-Length", content_length)
            else:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            while chunk := upstream.read(64 * 1024):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException):
            self.close_connection = True
        finally:
            connection.close()

    def _authorized(self) -> bool:
        value = self.headers.get("Authorization", "")
        prefix = "Bearer "
        return value.startswith(prefix) and hmac.compare_digest(
            value[len(prefix) :],
            self.server.channel_token,  # type: ignore[attr-defined]
        )


class DeepSeekHarnessTokenless(BaseInstalledAgent):
    """Run unmodified DSH with Tokenless API and its Tokenless Harness adapter."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.runtime_archive = Path(
            self._required_kwarg(kwargs, "runtime_archive")
        )
        self.proxy_script = Path(self._required_kwarg(kwargs, "proxy_script"))
        self.tokenless_home = self._required_kwarg(kwargs, "tokenless_home")
        self.daemon_url = self._required_kwarg(kwargs, "daemon_url")
        self.provider = self._required_kwarg(kwargs, "provider")
        self.profile = self._required_kwarg(kwargs, "profile")
        super().__init__(*args, **kwargs)

        for label, file_path in (
            ("runtime_archive", self.runtime_archive),
            ("proxy_script", self.proxy_script),
        ):
            if not file_path.is_file():
                raise ValueError(f"Terminal-Bench {label} does not exist: {file_path}")
        for label, value in (
            ("tokenless_home", self.tokenless_home),
            ("daemon_url", self.daemon_url),
            ("provider", self.provider),
            ("profile", self.profile),
        ):
            if (
                not isinstance(value, str)
                or not value.strip()
                or any(character in value for character in "\r\n\0")
            ):
                raise ValueError(f"Terminal-Bench {label} must be non-empty.")

    @staticmethod
    def _required_kwarg(kwargs: dict[str, Any], name: str) -> Any:
        value = kwargs.pop(name, kwargs.pop(name.replace("_", "-"), None))
        if value is None:
            raise ValueError(f"Terminal-Bench agent kwarg {name} is required.")
        return value

    @staticmethod
    @override
    def name() -> str:
        return "deepseek-harness-tokenless-deep"

    @override
    def version(self) -> str:
        return DSH_REVISION

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment,
            (
                "bash",
                "coreutils",
                "curl",
                "git",
                "procps",
                "python3",
                "ripgrep",
                "tar",
                "xz",
            ),
        )
        await self.exec_as_root(
            environment,
            "mkdir -p /installed-agent/runtime /installed-agent/profile",
        )
        await environment.upload_file(
            self.runtime_archive, "/installed-agent/runtime.tar.gz"
        )
        await environment.upload_file(
            self.proxy_script, "/installed-agent/terminalbench-proxy.py"
        )
        await self.exec_as_root(
            environment,
            "set -euo pipefail; "
            "tar -xzf /installed-agent/runtime.tar.gz "
            "-C /installed-agent/runtime && "
            "rm /installed-agent/runtime.tar.gz && "
            "chmod 755 /installed-agent/runtime/bin/node",
        )
        if environment.default_user is not None:
            await self.exec_as_root(
                environment,
                f"chown -R {shlex.quote(str(environment.default_user))} "
                "/installed-agent/runtime",
            )
        await self.exec_as_agent(
            environment,
            "/installed-agent/runtime/bin/node "
            "/installed-agent/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js "
            "--version",
        )
        await self._upload_profile(environment)

    async def _upload_profile(self, environment: BaseEnvironment) -> None:
        package = {
            "name": "dsh-profile-terminalbench",
            "private": True,
            "dependencies": {},
            "dsh": {
                "profile": {
                    "bundles": [
                        "@deepseek-ai/dsh-base",
                        "@deepseek-ai/dsh-headless",
                    ]
                }
            },
        }
        model = f"tokenless/{self.provider}"
        patch = "\n".join(
            [
                "- id: system-prompt",
                "  config:",
                "    persona: >-",
                "      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}. Before executing each user task yourself, call subagent exactly once with a self-contained request to inspect the current workspace with its tools and return concrete task-relevant analysis. Wait for that result and use it only as input. Then use your own tools to complete the requested workspace changes and verify the observable result. Never stop at analysis, instructions for the user, or a claim of success without executing the task. Do not delegate more than once.",
                "- id: llm-deepseek",
                "  config:",
                "    apiKeyEnv: DEEPSEEK_API_KEY",
                f"    baseURL: http://127.0.0.1:{PROXY_PORT}/v1/openai",
                "    retryPolicy:",
                "      mode: normal",
                "      maxRetries: 0",
                "    models:",
                f"      - id: {json.dumps(model)}",
                f"        name: {json.dumps(model)}",
                "        contextWindow: 1000000",
                "- id: agent-default-model",
                "  config:",
                "    provider: deepseek-official",
                f"    model: {json.dumps(model)}",
                "    reasoningEffort: high",
                "- id: tool-web",
                "  disabled: true",
                "- insert:",
                "    - id: subagent-tokenless-harness",
                "      name: /installed-agent/runtime/node_modules/tokenless/dist/integrations/dsh-tokenless-harness.mjs",
                "      config:",
                "        providerName: tokenless-harness",
                "        nodeExecutable: node",
                "        cliScript: /installed-agent/runtime/node_modules/tokenless/dist/src/tokenless.mjs",
                "        tokenlessHome: /tmp/tokenless-harness-home",
                f"        provider: {json.dumps(self.provider)}",
                f"        profile: {json.dumps(self.profile)}",
                "        timeoutMs: 600000",
                "        disposeGraceMs: 3000",
                "- id: tool-subagent",
                "  config:",
                "    provider: tokenless-harness",
                "    toolName: subagent",
                "    backgroundMode: one-shot",
                "    maxDepth: provider-managed",
                "",
            ]
        )
        await self._upload_config_text(
            environment,
            content=json.dumps(package, indent=2) + "\n",
            remote_path="/installed-agent/profile/package.json",
            filename="package.json",
        )
        await self._upload_config_text(
            environment,
            content=patch,
            remote_path="/installed-agent/profile/cordis.patch.yml",
            filename="cordis.patch.yml",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        control_token = (
            Path(self.tokenless_home) / "daemon.token"
        ).read_text(encoding="utf-8").strip()
        if not control_token:
            raise RuntimeError("Tokenless API daemon control token is empty.")

        channel_token = secrets.token_urlsafe(32)
        bridge = _ScopedBridgeServer(
            ("0.0.0.0", 0),
            self.daemon_url,
            control_token,
            channel_token,
        )
        bridge_thread = threading.Thread(
            target=bridge.serve_forever,
            kwargs={"poll_interval": 0.2},
            daemon=True,
        )
        bridge_thread.start()
        bridge_port = int(bridge.server_address[1])
        try:
            await self._start_container_proxy(
                environment, bridge_port, channel_token
            )
            dsh_home = "/tmp/dsh-terminalbench-home"
            try:
                await self.exec_as_agent(
                    environment,
                    "mkdir -p /tmp/dsh-terminalbench-home/profiles "
                    "/tmp/tokenless-harness-home /logs/agent && "
                    "ln -s /installed-agent/profile "
                    "/tmp/dsh-terminalbench-home/profiles/headless && "
                    "export PATH=/installed-agent/runtime/bin:$PATH && "
                    "node /installed-agent/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js "
                    f"--profile headless {shlex.quote(instruction)} "
                    ">/tmp/dsh-output.txt 2>&1",
                    env={
                        "DSH_HOME": dsh_home,
                        "DSH_PERMISSION_MODE": "danger-full-access",
                        "DSH_TELEMETRY_DISABLED": "1",
                        "DEEPSEEK_API_KEY": channel_token,
                        "TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL": (
                            f"http://127.0.0.1:{PROXY_PORT}"
                        ),
                        "TOKENLESS_BENCHMARK_CHANNEL_TOKEN": channel_token,
                        "NO_COLOR": "1",
                    },
                    cwd=environment.task_env_config.workdir,
                )
                child_events = bridge.audit_events()
                child_succeeded = any(
                    event.get("type") == "child.tool_result"
                    and event.get("status") == "succeeded"
                    for event in child_events
                ) and any(
                    event.get("type") == "harness.settled"
                    and event.get("status") == "succeeded"
                    for event in child_events
                )
                if not child_succeeded:
                    try:
                        diagnostic = await environment.exec(
                            "tail -c 65536 /tmp/dsh-output.txt 2>/dev/null || true",
                            timeout_sec=10,
                        )
                        self._write_failure_diagnostic(
                            diagnostic.stdout or "", channel_token
                        )
                    except Exception:
                        pass
            except NonZeroAgentExitCodeError:
                try:
                    diagnostic = await environment.exec(
                        "tail -c 65536 /tmp/dsh-output.txt 2>/dev/null || true",
                        timeout_sec=10,
                    )
                    self._write_failure_diagnostic(
                        diagnostic.stdout or "", channel_token
                    )
                except Exception:
                    pass
            except Exception:
                try:
                    diagnostic = await environment.exec(
                        "tail -c 65536 /tmp/dsh-output.txt 2>/dev/null || true",
                        timeout_sec=10,
                    )
                    self._write_failure_diagnostic(
                        diagnostic.stdout or "", channel_token
                    )
                except Exception:
                    pass
                raise
            bridge.record_event({"type": "dsh.parent.completed"})
        finally:
            try:
                await self._stop_container_proxy(environment)
            finally:
                bridge.shutdown()
                bridge.server_close()
                bridge_thread.join(timeout=2)
                self._write_audit(bridge.audit_events())

    async def _start_container_proxy(
        self,
        environment: BaseEnvironment,
        bridge_port: int,
        token: str,
    ) -> None:
        result = await self.exec_as_agent(
            environment,
            "nohup python3 /installed-agent/terminalbench-proxy.py "
            ">/tmp/terminalbench-proxy.log 2>&1 & echo $!",
            env={
                "TOKENLESS_BENCHMARK_PROXY_TARGET": (
                    f"http://host.docker.internal:{bridge_port}"
                ),
                "TOKENLESS_BENCHMARK_PROXY_PORT": str(PROXY_PORT),
                "TOKENLESS_BENCHMARK_CHANNEL_TOKEN": token,
            },
            timeout_sec=20,
        )
        lines = (result.stdout or "").splitlines()
        if not lines or not lines[-1].strip().isdigit():
            raise RuntimeError("Terminal-Bench loopback proxy did not start.")
        self._proxy_pid = lines[-1].strip()
        await self.exec_as_agent(
            environment,
            "for attempt in $(seq 1 50); do "
            f"python3 -c 'import socket; s=socket.create_connection((\"127.0.0.1\", {PROXY_PORT}), 1); s.close()' "
            ">/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1",
            timeout_sec=20,
        )

    async def _stop_container_proxy(self, environment: BaseEnvironment) -> None:
        proxy_pid = getattr(self, "_proxy_pid", None)
        if proxy_pid is None:
            return
        await environment.exec(
            command=f"kill {shlex.quote(proxy_pid)} >/dev/null 2>&1 || true"
        )
        self._proxy_pid = None

    def _write_audit(self, events: list[dict[str, Any]]) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        audit_path = self.logs_dir / "deep-integration.jsonl"
        audit_path.write_text(
            "".join(json.dumps(event, sort_keys=True) + "\n" for event in events),
            encoding="utf-8",
        )
        self._write_summary(events)

    def _write_failure_diagnostic(self, output: str, channel_token: str) -> None:
        lines = []
        for raw_line in output.replace(channel_token, "[redacted]").splitlines():
            line = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", raw_line).strip()
            if line:
                lines.append(line[:500])
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "dsh-error.txt").write_text(
            "\n".join(lines[-64:]) + ("\n" if lines else ""),
            encoding="utf-8",
        )

    def _write_summary(self, events: list[dict[str, Any]]) -> None:
        event_types = {event.get("type") for event in events}
        observed = {
            "harness.started",
            "provider.turn.started",
            "child.tool_result",
            "harness.settled",
            "dsh.parent.completed",
        }.issubset(event_types)
        summary = {
            "protocol": CHANNEL_PROTOCOL,
            "auditProtocol": AUDIT_PROTOCOL,
            "dshRevision": DSH_REVISION,
            "provider": self.provider,
            "model": f"tokenless/{self.provider}",
            "taskScopedBridge": True,
            "containerReceivesHostAdminToken": False,
            "subagentInvocation": "observed" if observed else "not_observed",
            "childHarness": "in_process" if observed else "not_claimed",
        }
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "dsh-tokenless-summary.json").write_text(
            json.dumps(summary, sort_keys=True) + "\n",
            encoding="utf-8",
        )
