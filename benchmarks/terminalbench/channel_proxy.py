#!/usr/bin/env python3
"""Loopback-only forwarder inside a Terminal-Bench task container."""

from __future__ import annotations

import hmac
import http.client
import http.server
import os
from urllib.parse import urlsplit


MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_BASH_OUTCOME_BODY_BYTES = 1024
MAX_SUBAGENT_BASH_BODY_BYTES = 32 * 1024
MAX_CHILD_HARNESS_FAILURE_BODY_BYTES = 1024
MAX_HARNESS_CORRECTIVE_BODY_BYTES = 1024
MAX_WORKSPACE_EXEC_BODY_BYTES = 2 * 1024
ALLOWED_COMPLETION_PATHS = {
    "/v1/chat/completions",
    "/v1/openai/chat/completions",
}
ALLOWED_BASH_OUTCOME_PATH = "/v1/private/benchmark/bash-outcome"
ALLOWED_SUBAGENT_BASH_PATH = "/v1/private/benchmark/subagent-bash"
ALLOWED_CHILD_HARNESS_FAILURE_PATH = "/v1/private/benchmark/child-harness-failure"
ALLOWED_HARNESS_CORRECTIVE_PATH = "/v1/private/benchmark/harness-corrective"
ALLOWED_WORKSPACE_EXEC_PATH = "/v1/private/benchmark/workspace-exec"
ALLOWED_PROVIDER_TURN_PREFIX = "/v1/private/provider-turn/"


class ProxyServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self) -> None:
        target = required_environment("TOKENLESS_BENCHMARK_PROXY_TARGET")
        token = required_environment("TOKENLESS_BENCHMARK_CHANNEL_TOKEN")
        try:
            port = int(required_environment("TOKENLESS_BENCHMARK_PROXY_PORT"))
        except ValueError as error:
            raise ValueError("benchmark proxy port must be an integer") from error
        parsed = urlsplit(target)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "host.docker.internal"
            or parsed.port is None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
        ):
            raise ValueError("benchmark proxy target is invalid")
        if not 1 <= port <= 65535:
            raise ValueError("benchmark proxy port is out of range")
        if (
            not 32 <= len(token) <= 256
            or not all(character.isalnum() or character in "_-" for character in token)
        ):
            raise ValueError("benchmark channel token is invalid")
        super().__init__(("127.0.0.1", port), ProxyHandler)
        self.target_host = parsed.hostname
        self.target_port = parsed.port
        self.channel_token = token


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        self._forward()

    def do_POST(self) -> None:  # noqa: N802
        self._forward()

    def _forward(self) -> None:
        parsed_path = urlsplit(self.path)
        path = parsed_path.path
        if (
            path not in ALLOWED_COMPLETION_PATHS
            and path != ALLOWED_BASH_OUTCOME_PATH
            and path != ALLOWED_SUBAGENT_BASH_PATH
            and path != ALLOWED_CHILD_HARNESS_FAILURE_PATH
            and path != ALLOWED_HARNESS_CORRECTIVE_PATH
            and path != ALLOWED_WORKSPACE_EXEC_PATH
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
        if length < 0 or length > MAX_BODY_BYTES:
            self.send_error(413)
            return
        if path == ALLOWED_BASH_OUTCOME_PATH:
            if self.command != "POST" or parsed_path.query or parsed_path.fragment:
                self.send_error(405 if self.command != "POST" else 404)
                return
            if length > MAX_BASH_OUTCOME_BODY_BYTES:
                self.send_error(413)
                return
        if path == ALLOWED_SUBAGENT_BASH_PATH:
            if self.command != "POST" or parsed_path.query or parsed_path.fragment:
                self.send_error(405 if self.command != "POST" else 404)
                return
            if length > MAX_SUBAGENT_BASH_BODY_BYTES:
                self.send_error(413)
                return
        if path == ALLOWED_CHILD_HARNESS_FAILURE_PATH:
            if self.command != "POST" or parsed_path.query or parsed_path.fragment:
                self.send_error(405 if self.command != "POST" else 404)
                return
            if length > MAX_CHILD_HARNESS_FAILURE_BODY_BYTES:
                self.send_error(413)
                return
        if path == ALLOWED_HARNESS_CORRECTIVE_PATH:
            if self.command != "POST" or parsed_path.query or parsed_path.fragment:
                self.send_error(405 if self.command != "POST" else 404)
                return
            if length > MAX_HARNESS_CORRECTIVE_BODY_BYTES:
                self.send_error(413)
                return
        if path == ALLOWED_WORKSPACE_EXEC_PATH:
            if self.command != "POST" or parsed_path.query or parsed_path.fragment:
                self.send_error(405 if self.command != "POST" else 404)
                return
            if length > MAX_WORKSPACE_EXEC_BODY_BYTES:
                self.send_error(413)
                return
        body = self.rfile.read(length) if length else None
        headers = {
            "Authorization": f"Bearer {self.server.channel_token}",  # type: ignore[attr-defined]
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
        if self.command == "POST" and path in ALLOWED_COMPLETION_PATHS:
            headers["X-Tokenless-Payload-Lifetime"] = "ephemeral"
        connection = http.client.HTTPConnection(
            self.server.target_host,  # type: ignore[attr-defined]
            self.server.target_port,  # type: ignore[attr-defined]
            timeout=1_900,
        )
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            upstream = connection.getresponse()
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


def required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value or any(character in value for character in "\r\n\0"):
        raise ValueError(f"{name} is required")
    return value


if __name__ == "__main__":
    ProxyServer().serve_forever(poll_interval=0.2)
