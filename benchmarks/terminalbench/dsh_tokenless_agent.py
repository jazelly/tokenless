"""Harbor agent for the pinned DeepSeek Harness Terminal-Bench 2.0 lane."""

from __future__ import annotations

import hmac
import hashlib
import http.client
import http.server
import json
import re
import secrets
import shlex
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, override
from urllib.parse import unquote, urlsplit

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


DSH_REVISION = "47f943859bef60e4160492346772ded9b24f765a"
DATASET = "terminal-bench/terminal-bench-2"
DATASET_REF = "sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b"
TASK_COUNT = 89
TASK_MANIFEST_SCHEMA = "tokenless.terminalbench-task-manifest.v1"
SEMANTIC_MANIFEST_SCHEMA = "tokenless.terminalbench-semantic-manifest.v1"
INSTRUCTION_DIGEST = "sha256:5b6a2e01c29b8f215daa2e430f75d2a12c3c4ffc627d8cf4ebc1b38cd0d353ea"
TASK_REF_DIGEST = "sha256:82cddb9ea94d792455d3e32b3c8a60ed73003714ed01785ec3b1ec5c580bccba"
CHANNEL_PROTOCOL = "tokenless.terminalbench-channel.v1"
AUDIT_PROTOCOL = "tokenless.terminalbench-deep-audit.v3"
PROXY_PORT = 18765
MAX_BRIDGE_BODY_BYTES = 8 * 1024 * 1024
PROVIDER_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
SEMANTIC_TASK_TYPE_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
SEMANTIC_COMPLEXITIES = {"low", "medium", "high"}
PROVIDER_REF_PATTERN = re.compile(r"^provider:[a-f0-9]{32}$")
PROVIDER_BINDING_REF_PATTERN = re.compile(r"^binding:[a-f0-9]{32}$")
PROVIDER_ATTACHMENT_REF_PATTERN = re.compile(r"^attachment:[a-f0-9]{32}$")
PROVIDER_TURN_REF_PATTERN = re.compile(r"^turn:[a-f0-9]{32}$")
PROVIDER_CONVERSATION_REF_PATTERN = re.compile(r"^conversation:[a-f0-9]{32}$")
PROVIDER_REQUEST_REF_PATTERN = re.compile(r"^request:[a-f0-9]{32}$")
WEB_AI_INTERACTION_PROTOCOL = "tokenless.internal.web-ai-interaction-protocol/v0"
REQUIRED_CAPABILITIES = ("conversation.chat", "file.upload")
TURN_LIFECYCLES = {
    "queued",
    "running",
    "waiting_for_user",
    "succeeded",
    "failed",
    "cancelled",
}
ALLOWED_COMPLETION_PATHS = {
    "/v1/chat/completions",
    "/v1/openai/chat/completions",
}
ALLOWED_PROVIDER_TURN_PREFIX = "/v1/private/provider-turn/"
PROVIDER_BINDINGS_PATH = "/v1/private/provider-turn/bindings"
PROVIDER_BINDING_ROUTE = re.compile(
    r"^/v1/private/provider-turn/bindings/([^/]+)(?:/(capabilities|attachments|turns))?$"
)
PROVIDER_TURN_READ_PATH = re.compile(
    r"^/v1/private/provider-turn/turns/[^/]+$"
)
PROVIDER_TURN_CANCEL_PATH = re.compile(
    r"^/v1/private/provider-turn/turns/([^/]+)/cancel$"
)
PROVIDER_REQUEST_CANCEL_PATH = re.compile(
    r"^/v1/private/provider-turn/requests/([^/]+)/cancel$"
)


class _ScopedBridgeServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        daemon_url: str,
        control_token: str,
        channel_token: str,
        profile: str,
        semantic_preference: str,
        token_estimator_node: str,
        token_estimator_script: str,
        tokenless_home: str,
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
        self.expected_profile = profile
        if PROVIDER_ID_PATTERN.fullmatch(semantic_preference) is None:
            raise ValueError("Terminal-Bench semantic preference is invalid.")
        self.semantic_preference = semantic_preference
        self.token_estimator_node = token_estimator_node
        self.token_estimator_script = token_estimator_script
        self.tokenless_home = tokenless_home
        self._audit_lock = threading.Lock()
        self._audit_events: list[dict[str, Any]] = []
        self._parent_completion_ordinal = 0
        self._provider_turn_route_refs: set[str] = set()
        self.provider_control_lock = threading.Lock()
        self._provider_state_lock = threading.Lock()
        self._provider_binding_ref: str | None = None
        self._provider_ref: str | None = None
        self._bootstrap_turn_ref: str | None = None
        self._bootstrap_conversation_ref: str | None = None
        self._bootstrap_succeeded = False
        self._continuation_turn_ref: str | None = None
        self._continuation_succeeded = False
        self._provider_request_refs: set[str] = set()
        self._provider_request_stages: dict[str, str] = {}
        self._provider_request_turn_refs: dict[str, str] = {}
        self._provider_turn_refs: dict[str, str] = {}
        self._provider_turn_request_refs: dict[str, str] = {}
        self._attachment_text: dict[str, str] = {}
        self._child_turn_input_text: dict[str, str] = {}
        self._subagent_dispatch_lock = threading.Lock()
        self._subagent_dispatch_state = "available"

    def claim_subagent_dispatch(self) -> bool:
        with self._subagent_dispatch_lock:
            if self._subagent_dispatch_state != "available":
                return False
            self._subagent_dispatch_state = "claimed"
            return True

    def settle_subagent_dispatch(self, succeeded: bool) -> None:
        with self._subagent_dispatch_lock:
            if self._subagent_dispatch_state != "claimed":
                raise RuntimeError("subagent dispatch claim is unavailable")
            self._subagent_dispatch_state = "dispatched" if succeeded else "available"

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

    def record_parent_completion_request(self) -> tuple[int, int]:
        with self._audit_lock:
            self._parent_completion_ordinal += 1
            ordinal = self._parent_completion_ordinal
            self._audit_events.append(
                {
                    "protocol": AUDIT_PROTOCOL,
                    "sequence": len(self._audit_events) + 1,
                    "type": "api.completion.request",
                    "ordinal": ordinal,
                    "forcedSubagent": False,
                }
            )
            return len(self._audit_events), ordinal

    def mark_parent_completion_forced(self, sequence: int) -> None:
        with self._audit_lock:
            event = self._audit_events[sequence - 1]
            if (
                event.get("sequence") != sequence
                or event.get("type") != "api.completion.request"
                or event.get("forcedSubagent") is not False
            ):
                raise RuntimeError("parent completion audit reference is invalid")
            event["forcedSubagent"] = True

    def record_child_turn_started(self, mode: str) -> None:
        self.record_event({"type": "child.turn.started", "mode": mode})

    def record_attachment_text(self, attachment_ref: str, body: bytes) -> None:
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("provider text attachment is not UTF-8") from error
        with self._provider_state_lock:
            self._attachment_text[attachment_ref] = text

    def record_child_turn_input(
        self,
        turn_ref: str,
        prompt_text: str,
        attachment_refs: list[str],
    ) -> None:
        with self._provider_state_lock:
            attachments = []
            for attachment_ref in attachment_refs:
                text = self._attachment_text.pop(attachment_ref, None)
                if text is None:
                    raise ValueError("provider turn attachment text is unavailable")
                attachments.append(text)
            self._child_turn_input_text[turn_ref] = "\n\n".join(
                [prompt_text, *attachments]
            )

    def _token_estimate(
        self,
        input_text: str,
        output_text: str | None,
        route: dict[str, Any],
        outcome: str,
        basis: str,
        observed_at: str,
    ) -> dict[str, Any]:
        if output_text is None:
            return {
                "availability": "unavailable",
                "reason": "response_too_large",
            }
        input_estimate = self._estimate_text(input_text)
        output_estimate = self._estimate_text(output_text)
        if (
            input_estimate.get("availability") != "estimated"
            or output_estimate.get("availability") != "estimated"
            or input_estimate.get("estimator") != output_estimate.get("estimator")
            or input_estimate.get("estimatorRevision")
            != output_estimate.get("estimatorRevision")
        ):
            return {
                "availability": "unavailable",
                "reason": "token_estimator_unavailable",
            }
        input_tokens = input_estimate["tokens"]
        output_tokens = output_estimate["tokens"]
        interactions = []
        for attempt in route["attempts"]:
            submitted = attempt["providerSubmitted"]
            interaction = {
                "provider": attempt["provider"],
                "outcome": "fallback",
                "observedAt": attempt["observedAt"],
                "providerSubmitted": submitted,
                "inputTokens": input_tokens if submitted else 0,
                "outputTokens": 0,
                "totalTokens": input_tokens if submitted else 0,
            }
            interactions.append(interaction)
        final_submitted = route["providerSubmitted"]
        final_input_tokens = input_tokens if final_submitted else 0
        final_output_tokens = output_tokens if final_submitted else 0
        interactions.append(
            {
                "provider": route["provider"],
                "outcome": outcome,
                "observedAt": observed_at,
                "providerSubmitted": final_submitted,
                "inputTokens": final_input_tokens,
                "outputTokens": final_output_tokens,
                "totalTokens": final_input_tokens + final_output_tokens,
            }
        )
        return {
            "availability": "estimated",
            "basis": basis,
            "estimator": input_estimate["estimator"],
            "estimatorRevision": input_estimate["estimatorRevision"],
            "inputCharacters": input_estimate["characters"],
            "inputTextSha256": input_estimate["sourceTextSha256"],
            "outputCharacters": output_estimate["characters"],
            "outputTextSha256": output_estimate["sourceTextSha256"],
            "interactions": interactions,
            "totalTokens": sum(item["totalTokens"] for item in interactions),
        }

    def _estimate_text(self, text: str) -> dict[str, Any]:
        try:
            completed = subprocess.run(
                [
                    self.token_estimator_node,
                    self.token_estimator_script,
                    self.tokenless_home,
                ],
                input=text,
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
            )
            value = json.loads(completed.stdout)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return {"availability": "unavailable"}
        if completed.returncode != 0 or not isinstance(value, dict):
            return {"availability": "unavailable"}
        if value.get("availability") == "unavailable":
            return value
        if (
            set(value)
            != {
                "availability",
                "estimator",
                "estimatorRevision",
                "tokens",
                "characters",
                "sourceTextSha256",
            }
            or value.get("availability") != "estimated"
            or value.get("estimator") != "o200k_base"
            or not isinstance(value.get("estimatorRevision"), str)
            or not value["estimatorRevision"]
            or not isinstance(value.get("tokens"), int)
            or isinstance(value.get("tokens"), bool)
            or value["tokens"] < 0
            or not isinstance(value.get("characters"), int)
            or isinstance(value.get("characters"), bool)
            or value["characters"] < 0
            or not isinstance(value.get("sourceTextSha256"), str)
            or re.fullmatch(r"[a-f0-9]{64}", value["sourceTextSha256"]) is None
        ):
            return {"availability": "unavailable"}
        return value

    def validate_provider_turn_request(
        self, method: str, path: str, body: bytes | None
    ) -> dict[str, Any]:
        if path == PROVIDER_BINDINGS_PATH:
            if method != "POST":
                raise ValueError("provider binding method is invalid")
            value = self._json_object(body)
            if (
                set(value) != {"provider", "profileId"}
                or value.get("provider") != "auto"
                or value.get("profileId") != self.expected_profile
            ):
                raise ValueError("provider binding is not the expected auto profile")
            with self._provider_state_lock:
                if self._provider_binding_ref is not None:
                    raise ValueError("provider binding was already accepted")
            return {"kind": "bind"}

        request_cancel = PROVIDER_REQUEST_CANCEL_PATH.fullmatch(path)
        if request_cancel is not None:
            if method != "POST":
                raise ValueError("provider request cancellation method is invalid")
            self._require_empty_json(body)
            request_ref = unquote(request_cancel.group(1) or "")
            if not PROVIDER_REQUEST_REF_PATTERN.fullmatch(request_ref):
                raise ValueError("provider request reference is invalid")
            with self._provider_state_lock:
                stage = self._provider_request_stages.get(request_ref)
                if stage is None:
                    raise ValueError("provider request reference is unknown")
                if stage == "bootstrap" and self._continuation_turn_ref is not None:
                    raise ValueError("provider request cancellation is out of sequence")
                turn_ref = self._provider_request_turn_refs.get(request_ref)
                if turn_ref is None or turn_ref != self._turn_ref_for_stage_locked(stage):
                    raise ValueError("provider request cancellation is out of sequence")
            return {
                "kind": "request_cancel",
                "requestRef": request_ref,
                "stage": stage,
                "turnRef": turn_ref,
            }

        turn_cancel = PROVIDER_TURN_CANCEL_PATH.fullmatch(path)
        if turn_cancel is not None:
            if method != "POST":
                raise ValueError("provider turn cancellation method is invalid")
            self._require_empty_json(body)
            turn_ref = unquote(turn_cancel.group(1) or "")
            return self._tracked_turn_operation("turn_cancel", turn_ref)

        turn_read = PROVIDER_TURN_READ_PATH.fullmatch(path)
        if turn_read is not None:
            if method != "GET" or body not in {None, b""}:
                raise ValueError("provider turn read request is invalid")
            turn_ref = unquote(path.rsplit("/", 1)[-1])
            return self._tracked_turn_operation("turn_read", turn_ref)

        binding_route = PROVIDER_BINDING_ROUTE.fullmatch(path)
        if binding_route is None:
            raise ValueError("provider turn route is invalid")
        binding_ref = unquote(binding_route.group(1) or "")
        action = binding_route.group(2)
        if not PROVIDER_BINDING_REF_PATTERN.fullmatch(binding_ref):
            raise ValueError("provider binding reference is invalid")
        with self._provider_state_lock:
            if self._provider_binding_ref is None or binding_ref != self._provider_binding_ref:
                raise ValueError("provider binding reference is unknown")
            provider_ref = self._provider_ref
            if provider_ref is None:
                raise ValueError("provider binding provider reference is unavailable")

            if action == "capabilities":
                if method != "GET" or body not in {None, b""}:
                    raise ValueError("provider capabilities request is invalid")
                if self._bootstrap_turn_ref is not None:
                    raise ValueError("provider capabilities request is out of sequence")
                return {"kind": "capabilities", "bindingRef": binding_ref}

            if action == "attachments":
                if method != "POST" or body in {None, b""}:
                    raise ValueError("provider attachment request is invalid")
                if self._bootstrap_turn_ref is None:
                    stage = "bootstrap"
                elif self._bootstrap_succeeded and (
                    self._continuation_turn_ref is None
                    or self._continuation_succeeded
                ):
                    stage = "continuation"
                else:
                    raise ValueError("provider attachment is out of sequence")
                return {"kind": "attachment", "bindingRef": binding_ref, "stage": stage}

            if action == "turns":
                if method != "POST":
                    raise ValueError("provider turn start method is invalid")
                start = self._parse_start_request(body)
                if start["providerRef"] != provider_ref or start["providerBindingRef"] != binding_ref:
                    raise ValueError("provider turn start identity does not match the binding")
                request_ref = start["requestRef"]
                if request_ref in self._provider_request_refs:
                    raise ValueError("provider turn request reference was already used")
                mode = start["mode"]
                if mode == "bootstrap":
                    if self._bootstrap_turn_ref is not None:
                        raise ValueError("provider bootstrap turn was already started")
                    if start["semanticPreference"] not in {None, self.semantic_preference}:
                        raise ValueError("provider bootstrap semantic preference does not match the task")
                elif (
                    not self._bootstrap_succeeded
                    or (
                        self._continuation_turn_ref is not None
                        and not self._continuation_succeeded
                    )
                    or start["conversationRef"] != self._bootstrap_conversation_ref
                ):
                    raise ValueError("provider continuation turn is out of sequence")
                return {"kind": "start", **start}

        raise ValueError("provider turn action is invalid")

    def commit_provider_turn_response(
        self, operation: dict[str, Any], status: int, body: bytes
    ) -> dict[str, str] | None:
        if status >= 400:
            return
        kind = operation["kind"]
        if kind == "bind":
            binding_ref, provider_ref = self._parse_binding_response(body)
            with self._provider_state_lock:
                if self._provider_binding_ref is not None:
                    raise ValueError("provider binding response was duplicated")
                self._provider_binding_ref = binding_ref
                self._provider_ref = provider_ref
            return
        if kind == "capabilities":
            self._parse_binding_response(body, expected_binding_ref=operation["bindingRef"], expected_provider_ref=self._provider_ref)
            return
        if kind == "attachment":
            return {"attachmentRef": self._parse_attachment_response(body)}
        if kind == "start":
            turn = self._parse_turn_response(
                body,
                expected_request_ref=operation["requestRef"],
                expected_provider_ref=operation["providerRef"],
                expected_binding_ref=operation["providerBindingRef"],
                expected_conversation_ref=operation.get("conversationRef"),
            )
            with self._provider_state_lock:
                if operation["requestRef"] in self._provider_request_refs:
                    raise ValueError("provider turn request reference was duplicated")
                turn_ref = turn["turnRef"]
                if turn_ref in self._provider_turn_refs:
                    raise ValueError("provider turn reference was duplicated")
                mode = operation["mode"]
                if mode == "bootstrap":
                    if self._bootstrap_turn_ref is not None:
                        raise ValueError("provider bootstrap response was duplicated")
                    self._bootstrap_turn_ref = turn_ref
                    self._bootstrap_conversation_ref = turn["conversationRef"]
                else:
                    if (
                        not self._bootstrap_succeeded
                        or (
                            self._continuation_turn_ref is not None
                            and not self._continuation_succeeded
                        )
                        or turn["conversationRef"] != self._bootstrap_conversation_ref
                    ):
                        raise ValueError("provider continuation response is out of sequence")
                    self._continuation_turn_ref = turn_ref
                    self._continuation_succeeded = False
                self._provider_request_refs.add(operation["requestRef"])
                self._provider_request_stages[operation["requestRef"]] = mode
                self._provider_request_turn_refs[operation["requestRef"]] = turn_ref
                self._provider_turn_refs[turn_ref] = mode
                self._provider_turn_request_refs[turn_ref] = operation["requestRef"]
                self._apply_turn_lifecycle_locked(mode, turn["lifecycle"])
            return {"turnRef": turn["turnRef"]}
        if kind in {"turn_read", "turn_cancel"}:
            stage = operation["stage"]
            expected_conversation_ref = self._conversation_ref_for_stage(stage)
            turn = self._parse_turn_response(
                body,
                expected_request_ref=operation["requestRef"],
                expected_provider_ref=self._provider_ref,
                expected_binding_ref=self._provider_binding_ref,
                expected_turn_ref=operation["turnRef"],
                expected_conversation_ref=expected_conversation_ref,
            )
            with self._provider_state_lock:
                if self._provider_turn_refs.get(operation["turnRef"]) != stage:
                    raise ValueError("provider turn response reference changed")
                self._apply_turn_lifecycle_locked(stage, turn["lifecycle"])
            return {"turnRef": turn["turnRef"]}
        if kind == "request_cancel":
            turn = self._parse_request_cancellation_response(body)
            if turn["turnRef"] != operation["turnRef"] or turn["conversationRef"] != self._conversation_ref_for_stage(operation["stage"]):
                raise ValueError("provider request cancellation identity changed")
            with self._provider_state_lock:
                if self._provider_request_stages.get(operation["requestRef"]) != operation["stage"]:
                    raise ValueError("provider request cancellation reference changed")
                self._apply_turn_lifecycle_locked(operation["stage"], "cancelled")
            return
        raise ValueError("provider turn operation is invalid")

    def _tracked_turn_operation(self, kind: str, turn_ref: str) -> dict[str, Any]:
        if not PROVIDER_TURN_REF_PATTERN.fullmatch(turn_ref):
            raise ValueError("provider turn reference is invalid")
        with self._provider_state_lock:
            stage = self._provider_turn_refs.get(turn_ref)
            if stage is None:
                raise ValueError("provider turn reference is unknown")
            if kind == "turn_cancel" and stage == "bootstrap" and self._continuation_turn_ref is not None:
                raise ValueError("provider turn cancellation is out of sequence")
            if turn_ref != self._turn_ref_for_stage_locked(stage):
                raise ValueError("provider turn operation is out of sequence")
            request_ref = self._provider_turn_request_refs.get(turn_ref)
            if request_ref is None:
                raise ValueError("provider turn request reference is unavailable")
        return {
            "kind": kind,
            "stage": stage,
            "turnRef": turn_ref,
            "requestRef": request_ref,
        }

    @staticmethod
    def _json_object(body: bytes | None) -> dict[str, Any]:
        try:
            value = json.loads(body or b"")
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("provider control JSON is invalid") from error
        if not isinstance(value, dict):
            raise ValueError("provider control JSON must be an object")
        return value

    @classmethod
    def _require_empty_json(cls, body: bytes | None) -> None:
        if body in {None, b""}:
            return
        if cls._json_object(body):
            raise ValueError("provider cancellation body must be empty")

    def decorate_parent_completion_body(self, body: bytes | None) -> bytes:
        value = self._json_object(body)
        if value.get("model") != "tokenless/auto":
            raise ValueError("DSH parent completion must use tokenless/auto")
        tokenless = value.get("tokenless")
        if tokenless is None:
            tokenless = {}
        if not isinstance(tokenless, dict):
            raise ValueError("DSH parent tokenless options are invalid")
        tokenless = dict(tokenless)
        tokenless["semantic_preference"] = self.semantic_preference
        value["tokenless"] = tokenless
        return json.dumps(value, separators=(",", ":")).encode("utf-8")

    def decorate_bootstrap_body(self, body: bytes | None) -> bytes:
        value = self._json_object(body)
        value["semanticPreference"] = self.semantic_preference
        return json.dumps(value, separators=(",", ":")).encode("utf-8")

    @staticmethod
    def _parse_start_request(body: bytes | None) -> dict[str, Any]:
        value = _ScopedBridgeServer._json_object(body)
        if not isinstance(value.get("conversation"), dict):
            raise ValueError("provider turn conversation is invalid")
        mode = value["conversation"].get("mode")
        expected_keys = {
            "protocol",
            "requestRef",
            "providerRef",
            "providerBindingRef",
            "requiredCapabilities",
            "conversation",
            "bootstrap" if mode == "new" else "continuation",
        }
        if mode == "new":
            if set(value) != expected_keys and set(value) != (expected_keys | {"semanticPreference"}):
                raise ValueError("provider turn start shape is invalid")
        elif set(value) != expected_keys:
            raise ValueError("provider turn start shape is invalid")
        if (
            value.get("protocol") != WEB_AI_INTERACTION_PROTOCOL
            or not isinstance(value.get("requestRef"), str)
            or not PROVIDER_REQUEST_REF_PATTERN.fullmatch(value["requestRef"])
            or not isinstance(value.get("providerRef"), str)
            or not PROVIDER_REF_PATTERN.fullmatch(value["providerRef"])
            or not isinstance(value.get("providerBindingRef"), str)
            or not PROVIDER_BINDING_REF_PATTERN.fullmatch(value["providerBindingRef"])
            or value.get("requiredCapabilities") != list(REQUIRED_CAPABILITIES)
        ):
            raise ValueError("provider turn start identity is invalid")
        conversation = value["conversation"]
        if mode == "new":
            if set(conversation) != {"mode"} or not isinstance(value.get("bootstrap"), dict):
                raise ValueError("provider bootstrap shape is invalid")
            semantic_preference = value.get("semanticPreference")
            if semantic_preference is not None and PROVIDER_ID_PATTERN.fullmatch(str(semantic_preference)) is None:
                raise ValueError("provider bootstrap semantic preference is invalid")
            return {
                "mode": "bootstrap",
                "requestRef": value["requestRef"],
                "providerRef": value["providerRef"],
                "providerBindingRef": value["providerBindingRef"],
                "conversationRef": None,
                "semanticPreference": semantic_preference,
                "inputText": value["bootstrap"]["text"],
                "attachmentRefs": [
                    attachment["attachmentRef"]
                    for attachment in value["bootstrap"]["attachments"]
                ],
            }
        if mode != "continue" or set(conversation) != {"mode", "conversationRef"}:
            raise ValueError("provider continuation shape is invalid")
        conversation_ref = conversation.get("conversationRef")
        if not isinstance(conversation_ref, str) or not PROVIDER_CONVERSATION_REF_PATTERN.fullmatch(conversation_ref) or not isinstance(value.get("continuation"), dict):
            raise ValueError("provider continuation identity is invalid")
        return {
            "mode": "continuation",
            "requestRef": value["requestRef"],
            "providerRef": value["providerRef"],
            "providerBindingRef": value["providerBindingRef"],
            "conversationRef": conversation_ref,
            "semanticPreference": None,
            "inputText": value["continuation"]["text"],
            "attachmentRefs": [
                attachment["attachmentRef"]
                for attachment in value["continuation"]["attachments"]
            ],
        }

    @classmethod
    def _parse_binding_response(
        cls,
        body: bytes,
        expected_binding_ref: str | None = None,
        expected_provider_ref: str | None = None,
    ) -> tuple[str, str]:
        value = cls._json_object(body)
        capabilities = value.get("capabilities")
        if set(value) != {"providerBindingRef", "capabilities"} or not isinstance(capabilities, dict):
            raise ValueError("provider binding response shape is invalid")
        if set(capabilities) != {"protocol", "providerRef", "supportedCapabilities"}:
            raise ValueError("provider capabilities response shape is invalid")
        binding_ref = value.get("providerBindingRef")
        provider_ref = capabilities.get("providerRef")
        if (
            not isinstance(binding_ref, str)
            or not PROVIDER_BINDING_REF_PATTERN.fullmatch(binding_ref)
            or not isinstance(provider_ref, str)
            or not PROVIDER_REF_PATTERN.fullmatch(provider_ref)
            or capabilities.get("protocol") != WEB_AI_INTERACTION_PROTOCOL
            or capabilities.get("supportedCapabilities") != list(REQUIRED_CAPABILITIES)
            or (expected_binding_ref is not None and binding_ref != expected_binding_ref)
            or (expected_provider_ref is not None and provider_ref != expected_provider_ref)
        ):
            raise ValueError("provider binding response identity is invalid")
        return binding_ref, provider_ref

    @classmethod
    def _parse_attachment_response(cls, body: bytes) -> str:
        value = cls._json_object(body)
        attachment = value.get("attachment")
        if set(value) != {"attachment"} or not isinstance(attachment, dict) or set(attachment) != {"attachmentRef", "mediaType", "byteLength", "sha256"}:
            raise ValueError("provider attachment response shape is invalid")
        if (
            not isinstance(attachment.get("attachmentRef"), str)
            or not PROVIDER_ATTACHMENT_REF_PATTERN.fullmatch(attachment["attachmentRef"])
            or attachment.get("mediaType") != "text/markdown"
            or not isinstance(attachment.get("byteLength"), int)
            or isinstance(attachment.get("byteLength"), bool)
            or not 1 <= attachment["byteLength"] <= 1024 * 1024
            or not isinstance(attachment.get("sha256"), str)
            or re.fullmatch(r"[a-f0-9]{64}", attachment["sha256"]) is None
        ):
            raise ValueError("provider attachment response identity is invalid")
        return attachment["attachmentRef"]

    @classmethod
    def _parse_turn_response(
        cls,
        body: bytes,
        *,
        expected_request_ref: str | None,
        expected_provider_ref: str | None,
        expected_binding_ref: str | None,
        expected_turn_ref: str | None = None,
        expected_conversation_ref: str | None = None,
    ) -> dict[str, str]:
        value = cls._json_object(body)
        turn = value.get("turn")
        if set(value) != {"turn"} or not isinstance(turn, dict):
            raise ValueError("provider turn response shape is invalid")
        required = {"protocol", "requestRef", "turnRef", "providerRef", "providerBindingRef", "conversationRef", "lifecycle"}
        if not required.issubset(turn):
            raise ValueError("provider turn response identity is incomplete")
        if (
            turn.get("protocol") != WEB_AI_INTERACTION_PROTOCOL
            or not isinstance(turn.get("requestRef"), str)
            or not PROVIDER_REQUEST_REF_PATTERN.fullmatch(turn["requestRef"])
            or not isinstance(turn.get("turnRef"), str)
            or not PROVIDER_TURN_REF_PATTERN.fullmatch(turn["turnRef"])
            or not isinstance(turn.get("providerRef"), str)
            or not PROVIDER_REF_PATTERN.fullmatch(turn["providerRef"])
            or not isinstance(turn.get("providerBindingRef"), str)
            or not PROVIDER_BINDING_REF_PATTERN.fullmatch(turn["providerBindingRef"])
            or not isinstance(turn.get("conversationRef"), str)
            or not PROVIDER_CONVERSATION_REF_PATTERN.fullmatch(turn["conversationRef"])
            or turn.get("lifecycle") not in TURN_LIFECYCLES
            or (expected_request_ref is not None and turn["requestRef"] != expected_request_ref)
            or (expected_provider_ref is not None and turn["providerRef"] != expected_provider_ref)
            or (expected_binding_ref is not None and turn["providerBindingRef"] != expected_binding_ref)
            or (expected_turn_ref is not None and turn["turnRef"] != expected_turn_ref)
            or (expected_conversation_ref is not None and turn["conversationRef"] != expected_conversation_ref)
        ):
            raise ValueError("provider turn response identity is invalid")
        return {
            "requestRef": turn["requestRef"],
            "turnRef": turn["turnRef"],
            "providerRef": turn["providerRef"],
            "providerBindingRef": turn["providerBindingRef"],
            "conversationRef": turn["conversationRef"],
            "lifecycle": turn["lifecycle"],
        }

    @classmethod
    def _parse_request_cancellation_response(cls, body: bytes) -> dict[str, str]:
        value = cls._json_object(body)
        turn = value.get("turn")
        if set(value) != {"kind", "turn"} or value.get("kind") != "turn" or not isinstance(turn, dict) or set(turn) != {"turnRef", "conversationRef", "lifecycle"}:
            raise ValueError("provider request cancellation response shape is invalid")
        if (
            not isinstance(turn.get("turnRef"), str)
            or not PROVIDER_TURN_REF_PATTERN.fullmatch(turn["turnRef"])
            or not isinstance(turn.get("conversationRef"), str)
            or not PROVIDER_CONVERSATION_REF_PATTERN.fullmatch(turn["conversationRef"])
            or turn.get("lifecycle") != "cancelled"
        ):
            raise ValueError("provider request cancellation response identity is invalid")
        return {
            "turnRef": turn["turnRef"],
            "conversationRef": turn["conversationRef"],
        }

    def _apply_turn_lifecycle_locked(self, stage: str, lifecycle: str) -> None:
        if lifecycle not in TURN_LIFECYCLES:
            raise ValueError("provider turn lifecycle is invalid")
        if lifecycle not in {"succeeded", "failed", "cancelled"}:
            return
        if stage == "bootstrap":
            self._bootstrap_succeeded = lifecycle == "succeeded"
        elif stage == "continuation":
            self._continuation_succeeded = lifecycle == "succeeded"
        else:
            raise ValueError("provider turn stage is invalid")

    def _turn_ref_for_stage_locked(self, stage: str) -> str:
        if stage == "bootstrap":
            turn_ref = self._bootstrap_turn_ref
        elif stage == "continuation":
            turn_ref = self._continuation_turn_ref
        else:
            raise ValueError("provider turn stage is invalid")
        if turn_ref is None:
            raise ValueError("provider turn reference is unavailable")
        return turn_ref

    def _conversation_ref_for_stage(self, stage: str) -> str:
        with self._provider_state_lock:
            conversation_ref = self._bootstrap_conversation_ref
        if conversation_ref is None:
            raise ValueError("provider conversation reference is unavailable")
        return conversation_ref

    @staticmethod
    def _parse_route_headers(upstream: http.client.HTTPResponse) -> dict[str, Any] | None:
        provider = upstream.getheader("X-Tokenless-Route-Provider")
        if provider is None or PROVIDER_ID_PATTERN.fullmatch(provider) is None:
            return None
        mode = upstream.getheader("X-Tokenless-Route-Mode")
        if mode not in {"auto", "explicit"}:
            return None
        fallback_header = upstream.getheader("X-Tokenless-Route-Fallback-Providers")
        if fallback_header is None:
            return None
        fallback_providers = [] if fallback_header == "" else fallback_header.split(",")
        if (
            len(fallback_providers) > 5
            or any(PROVIDER_ID_PATTERN.fullmatch(value) is None for value in fallback_providers)
        ):
            return None
        fallback_used = upstream.getheader("X-Tokenless-Route-Fallback-Used")
        rate_limited = upstream.getheader("X-Tokenless-Route-Rate-Limited")
        preference_requested_header = upstream.getheader(
            "X-Tokenless-Route-Preference-Requested"
        )
        preference_honored = upstream.getheader(
            "X-Tokenless-Route-Preference-Honored"
        )
        provider_submitted = upstream.getheader(
            "X-Tokenless-Route-Provider-Submitted"
        )
        visible_proof_header = upstream.getheader(
            "X-Tokenless-Route-Visible-Proof"
        )
        limit_window_header = upstream.getheader(
            "X-Tokenless-Route-Limit-Window"
        )
        retry_after_header = upstream.getheader(
            "X-Tokenless-Route-Retry-After-Seconds"
        )
        attempts_header = upstream.getheader("X-Tokenless-Route-Attempts")
        if attempts_header is None or preference_requested_header is None:
            return None
        preference_requested = (
            None
            if preference_requested_header == ""
            else preference_requested_header
        )
        try:
            attempts_value = json.loads(attempts_header)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if (
            fallback_used not in {"0", "1"}
            or rate_limited not in {"0", "1"}
            or preference_honored not in {"0", "1"}
            or provider_submitted not in {"0", "1"}
            or visible_proof_header is None
            or limit_window_header is None
            or retry_after_header is None
            or (
                visible_proof_header != ""
                and re.fullmatch(r"[a-z0-9:_-]{1,160}", visible_proof_header)
                is None
            )
            or limit_window_header
            not in {"", "minute", "hour", "day", "week", "unknown"}
            or (
                retry_after_header != ""
                and (
                    not retry_after_header.isdigit()
                    or not 1 <= int(retry_after_header) <= 604_800
                )
            )
            or (
                preference_requested is not None
                and PROVIDER_ID_PATTERN.fullmatch(preference_requested) is None
            )
            or (preference_honored == "1" and preference_requested is None)
            or not isinstance(attempts_value, list)
            or len(attempts_value) > 5
            or (fallback_used == "1") != bool(attempts_value)
        ):
            return None
        attempts = []
        for attempt in attempts_value:
            if (
                not isinstance(attempt, dict)
                or any(
                    key
                    not in {
                        "provider",
                        "outcome",
                        "reason",
                        "observedAt",
                        "providerSubmitted",
                        "visibleProof",
                        "limitWindow",
                        "retryAfterSeconds",
                    }
                    for key in attempt
                )
                or not {
                    "provider",
                    "outcome",
                    "reason",
                    "observedAt",
                    "providerSubmitted",
                }.issubset(attempt)
                or not isinstance(attempt.get("provider"), str)
                or PROVIDER_ID_PATTERN.fullmatch(attempt["provider"]) is None
                or attempt.get("outcome") != "fallback"
                or not isinstance(attempt.get("observedAt"), str)
                or re.fullmatch(
                    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",
                    attempt["observedAt"],
                )
                is None
                or not isinstance(attempt.get("providerSubmitted"), bool)
                or attempt.get("reason") not in {
                    "rate_limit",
                    "capacity",
                    "auth",
                    "unavailable",
                }
                or (
                    "visibleProof" in attempt
                    and (
                        not isinstance(attempt["visibleProof"], str)
                        or re.fullmatch(r"[a-z0-9:_-]{1,160}", attempt["visibleProof"])
                        is None
                    )
                )
                or (
                    "limitWindow" in attempt
                    and attempt["limitWindow"]
                    not in {"minute", "hour", "day", "week", "unknown"}
                )
                or (
                    "retryAfterSeconds" in attempt
                    and (
                        not isinstance(attempt["retryAfterSeconds"], int)
                        or isinstance(attempt["retryAfterSeconds"], bool)
                        or not 1 <= attempt["retryAfterSeconds"] <= 604_800
                    )
                )
                or (
                    any(
                        key in attempt
                        for key in {
                            "visibleProof",
                            "limitWindow",
                            "retryAfterSeconds",
                        }
                    )
                    and attempt.get("reason") not in {"rate_limit", "capacity"}
                )
            ):
                return None
            attempts.append(dict(attempt))
        return {
            "mode": mode,
            "provider": provider,
            "fallbackProviders": fallback_providers,
            "fallbackUsed": fallback_used == "1",
            "rateLimited": rate_limited == "1",
            "preferenceRequested": preference_requested,
            "preferenceHonored": preference_honored == "1",
            "providerSubmitted": provider_submitted == "1",
            "visibleProof": visible_proof_header or None,
            "limitWindow": limit_window_header or None,
            "retryAfterSeconds": (
                int(retry_after_header) if retry_after_header else None
            ),
            "attempts": attempts,
        }

    def record_upstream_route(
        self,
        upstream: http.client.HTTPResponse,
        scope: str,
        input_text: str,
        output_text: str | None,
    ) -> None:
        route = self._parse_route_headers(upstream)
        if route is None:
            self.record_event(
                {"type": "provider.routing.invalid", "reason": f"{scope}_route_metadata"}
            )
            return
        outcome = "completed" if upstream.status < 400 else "failed"
        if outcome == "completed" and route["rateLimited"]:
            self.record_event(
                {"type": "provider.routing.invalid", "reason": "rate_limit_attribution"}
            )
            return
        observed_at = datetime.now(timezone.utc).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        self.record_event(
            {
                "type": "provider.routing",
                "observedAt": observed_at,
                "scope": scope,
                **route,
                "outcome": outcome,
                "tokenEstimate": self._token_estimate(
                    input_text,
                    output_text if outcome == "completed" else "",
                    route,
                    outcome,
                    "normalized_openai_request_and_visible_assistant_text",
                    observed_at,
                ),
            }
        )

    def record_provider_turn_read(
        self, path: str, upstream: http.client.HTTPResponse, body: bytes
    ) -> None:
        outcome = upstream.getheader("X-Tokenless-Route-Outcome")
        route = self._parse_route_headers(upstream)
        if outcome not in {"pending", "completed", "failed"} or route is None:
            with self._audit_lock:
                if path in self._provider_turn_route_refs:
                    return
                self._provider_turn_route_refs.add(path)
            self.record_event(
                {
                    "type": "provider.routing.invalid",
                    "reason": "route_outcome" if outcome not in {"pending", "completed", "failed"} else "route_metadata",
                }
            )
            return
        if outcome == "pending":
            return
        with self._audit_lock:
            if path in self._provider_turn_route_refs:
                return
            self._provider_turn_route_refs.add(path)
        if outcome == "completed" and route["rateLimited"]:
            self.record_event(
                {"type": "provider.routing.invalid", "reason": "rate_limit_attribution"}
            )
            return
        turn_ref = unquote(path.rsplit("/", 1)[-1])
        with self._provider_state_lock:
            input_text = self._child_turn_input_text.pop(turn_ref, None)
        if input_text is None:
            self.record_event(
                {"type": "provider.routing.invalid", "reason": "child_token_input"}
            )
            return
        output_text = self._provider_turn_output_text(body) if outcome == "completed" else ""
        observed_at = datetime.now(timezone.utc).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        self.record_event(
            {
                "type": "provider.routing",
                "observedAt": observed_at,
                "scope": "child",
                **route,
                "outcome": outcome,
                "tokenEstimate": self._token_estimate(
                    input_text,
                    output_text,
                    route,
                    outcome,
                    "provider_turn_prompt_attachments_and_visible_assistant_text",
                    observed_at,
                ),
            }
        )

    @classmethod
    def _provider_turn_output_text(cls, body: bytes) -> str:
        value = cls._json_object(body)
        turn = value.get("turn")
        result = turn.get("result") if isinstance(turn, dict) else None
        text = result.get("text") if isinstance(result, dict) else None
        return text if isinstance(text, str) else ""

    @staticmethod
    def _completion_output_text(body: bytes) -> str:
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            return ""
        payloads: list[dict[str, Any]] = []
        if "data:" in text:
            for line in text.splitlines():
                if not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    value = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    payloads.append(value)
        else:
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                return ""
            if isinstance(value, dict):
                payloads.append(value)
        parts: list[str] = []
        for payload in payloads:
            choices = payload.get("choices")
            if not isinstance(choices, list):
                continue
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                message = choice.get("delta", choice.get("message"))
                if not isinstance(message, dict):
                    continue
                content = message.get("content")
                if isinstance(content, str):
                    parts.append(content)
                tool_calls = message.get("tool_calls")
                if not isinstance(tool_calls, list):
                    continue
                for tool_call in tool_calls:
                    function = (
                        tool_call.get("function")
                        if isinstance(tool_call, dict)
                        else None
                    )
                    if not isinstance(function, dict):
                        continue
                    for key in ("name", "arguments"):
                        value = function.get(key)
                        if isinstance(value, str):
                            parts.append(value)
        return "".join(parts)


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
        provider_operation = None
        provider_control_lock = None
        if path.startswith(ALLOWED_PROVIDER_TURN_PREFIX):
            provider_control_lock = self.server.provider_control_lock  # type: ignore[attr-defined]
            provider_control_lock.acquire()
            try:
                provider_operation = self.server.validate_provider_turn_request(  # type: ignore[attr-defined]
                    self.command, path, body
                )
            except ValueError:
                provider_control_lock.release()
                self.send_error(400)
                return
            if provider_operation["kind"] == "start" and provider_operation["mode"] == "bootstrap":
                try:
                    body = self.server.decorate_bootstrap_body(body)  # type: ignore[attr-defined]
                except ValueError:
                    provider_control_lock.release()
                    self.send_error(400)
                    return
        subagent_claimed = False
        subagent_claim_settled = False
        parent_event_sequence = None
        parent_ordinal = None
        if path in ALLOWED_COMPLETION_PATHS and self.command == "POST":
            parent_event_sequence, parent_ordinal = self.server.record_parent_completion_request()  # type: ignore[attr-defined]
            try:
                body = self.server.decorate_parent_completion_body(body)  # type: ignore[attr-defined]
                request_value = json.loads(body)
                tools = request_value.get("tools") if isinstance(request_value, dict) else None
                has_subagent = isinstance(tools, list) and any(
                    isinstance(tool, dict)
                    and isinstance(tool.get("function"), dict)
                    and tool["function"].get("name") == "subagent"
                    for tool in tools
                )
                has_read = isinstance(tools, list) and any(
                    isinstance(tool, dict)
                    and isinstance(tool.get("function"), dict)
                    and tool["function"].get("name") == "read"
                    for tool in tools
                )
                if isinstance(request_value, dict) and has_subagent:
                    request_value["parallel_tool_calls"] = False
                    if parent_ordinal == 1:
                        if not has_read:
                            raise ValueError("DSH parent read-only inspection tool is unavailable")
                        request_value["tools"] = [
                            tool
                            for tool in tools
                            if not (
                                isinstance(tool, dict)
                                and isinstance(tool.get("function"), dict)
                                and tool["function"].get("name") == "subagent"
                            )
                        ]
                        request_value["tool_choice"] = {
                            "type": "function",
                            "function": {"name": "read"},
                        }
                    else:
                        subagent_claimed = self.server.claim_subagent_dispatch()  # type: ignore[attr-defined]
                        if subagent_claimed:
                            request_value["tool_choice"] = {
                                "type": "function",
                                "function": {"name": "subagent"},
                            }
                    body = json.dumps(
                        request_value, separators=(",", ":")
                    ).encode("utf-8")
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                self.send_error(400)
                if provider_control_lock is not None:
                    provider_control_lock.release()
                return
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
            control_body = None
            committed_provider_turn = None
            if provider_operation is not None:
                control_body = self._read_bounded_response(upstream)
                committed_provider_turn = self.server.commit_provider_turn_response(  # type: ignore[attr-defined]
                    provider_operation, upstream.status, control_body
                )
                if (
                    provider_operation["kind"] == "attachment"
                    and committed_provider_turn is not None
                    and body is not None
                ):
                    self.server.record_attachment_text(  # type: ignore[attr-defined]
                        committed_provider_turn["attachmentRef"], body
                    )
                if (
                    provider_operation["kind"] == "start"
                    and committed_provider_turn is not None
                ):
                    self.server.record_child_turn_input(  # type: ignore[attr-defined]
                        committed_provider_turn["turnRef"],
                        provider_operation["inputText"],
                        provider_operation["attachmentRefs"],
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
            if provider_operation is not None:
                self.send_header("Content-Length", str(len(control_body or b"")))
            else:
                content_length = upstream.getheader("Content-Length")
                if content_length is not None:
                    self.send_header("Content-Length", content_length)
                else:
                    self.send_header("Connection", "close")
                    self.close_connection = True
            self.end_headers()
            if provider_operation is not None:
                self.wfile.write(control_body or b"")
                self.wfile.flush()
                if provider_operation["kind"] == "turn_read":
                    self.server.record_provider_turn_read(  # type: ignore[attr-defined]
                        path, upstream, control_body or b""
                    )
                if provider_operation["kind"] == "start" and upstream.status < 400:
                    self.server.record_child_turn_started(  # type: ignore[attr-defined]
                        provider_operation["mode"]
                    )
            else:
                relayed_body = bytearray()
                relayed_body_complete = True
                while chunk := upstream.read(64 * 1024):
                    if len(relayed_body) + len(chunk) <= MAX_BRIDGE_BODY_BYTES:
                        relayed_body.extend(chunk)
                    else:
                        relayed_body_complete = False
                    self.wfile.write(chunk)
                    self.wfile.flush()
                if path in ALLOWED_COMPLETION_PATHS and self.command == "POST":
                    if subagent_claimed:
                        subagent_succeeded = upstream.status < 400
                        if subagent_succeeded:
                            self.server.mark_parent_completion_forced(  # type: ignore[attr-defined]
                                parent_event_sequence
                            )
                        self.server.settle_subagent_dispatch(  # type: ignore[attr-defined]
                            subagent_succeeded
                        )
                        subagent_claim_settled = True
                    self.server.record_upstream_route(  # type: ignore[attr-defined]
                        upstream,
                        "parent",
                        (body or b"").decode("utf-8"),
                        (
                            self.server._completion_output_text(bytes(relayed_body))  # type: ignore[attr-defined]
                            if relayed_body_complete
                            else None
                        ),
                    )
        except ValueError:
            self.close_connection = True
            self.send_error(502)
        except (OSError, http.client.HTTPException):
            self.close_connection = True
        finally:
            if subagent_claimed and not subagent_claim_settled:
                self.server.settle_subagent_dispatch(False)  # type: ignore[attr-defined]
            connection.close()
            if provider_control_lock is not None:
                provider_control_lock.release()

    @staticmethod
    def _read_bounded_response(upstream: http.client.HTTPResponse) -> bytes:
        content_length = upstream.getheader("Content-Length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
                if declared_length < 0 or declared_length > MAX_BRIDGE_BODY_BYTES:
                    raise ValueError("provider control response is too large")
            except ValueError as error:
                raise ValueError("provider control response length is invalid") from error
        body = upstream.read(MAX_BRIDGE_BODY_BYTES + 1)
        if len(body) > MAX_BRIDGE_BODY_BYTES:
            raise ValueError("provider control response is too large")
        return body

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
        self.token_estimator_script = Path(
            self._required_kwarg(kwargs, "token_estimator_script")
        )
        self.token_estimator_node = Path(
            self._required_kwarg(kwargs, "token_estimator_node")
        )
        self.tokenless_home = self._required_kwarg(kwargs, "tokenless_home")
        self.daemon_url = self._required_kwarg(kwargs, "daemon_url")
        self.profile = self._required_kwarg(kwargs, "profile")
        self.task_manifest = Path(self._required_kwarg(kwargs, "task_manifest"))
        self.semantic_manifest = Path(self._required_kwarg(kwargs, "semantic_manifest"))
        self._manifest = self._load_task_manifest(self.task_manifest)
        self._semantic_manifest, self.semantic_manifest_digest = self._load_semantic_manifest(
            self.semantic_manifest, self._manifest
        )
        if "provider" in kwargs:
            raise ValueError("Terminal-Bench DeepSeek Harness agent does not accept a fixed provider; use tokenless/auto.")
        super().__init__(*args, **kwargs)

        for label, file_path in (
            ("runtime_archive", self.runtime_archive),
            ("proxy_script", self.proxy_script),
            ("token_estimator_script", self.token_estimator_script),
            ("token_estimator_node", self.token_estimator_node),
            ("task_manifest", self.task_manifest),
            ("semantic_manifest", self.semantic_manifest),
        ):
            if not file_path.is_file():
                raise ValueError(f"Terminal-Bench {label} does not exist: {file_path}")
        for label, value in (
            ("tokenless_home", self.tokenless_home),
            ("daemon_url", self.daemon_url),
            ("profile", self.profile),
        ):
            if (
                not isinstance(value, str)
                or not value.strip()
                or any(character in value for character in "\r\n\0")
            ):
                raise ValueError(f"Terminal-Bench {label} must be non-empty.")

    @staticmethod
    def _load_task_manifest(file_path: Path) -> dict[str, str]:
        try:
            manifest = json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("Terminal-Bench task manifest is unreadable.") from error
        if (
            not isinstance(manifest, dict)
            or manifest.get("schema") != TASK_MANIFEST_SCHEMA
            or manifest.get("dataset") != DATASET
            or manifest.get("datasetRef") != DATASET_REF
            or manifest.get("instructionFile") != "instruction.md"
            or manifest.get("taskCount") != TASK_COUNT
            or manifest.get("instructionDigest") != INSTRUCTION_DIGEST
            or manifest.get("taskRefDigest") != TASK_REF_DIGEST
            or not isinstance(manifest.get("tasks"), dict)
            or not isinstance(manifest.get("taskRefs"), dict)
        ):
            raise ValueError("Terminal-Bench task manifest does not match the pinned official dataset.")
        tasks = manifest["tasks"]
        task_refs = manifest["taskRefs"]
        names = list(tasks)
        if (
            len(names) != TASK_COUNT
            or names != sorted(names)
            or list(task_refs) != names
            or any(
                not isinstance(name, str)
                or re.fullmatch(r"[-a-z0-9]+", name) is None
                or not isinstance(digest, str)
                or re.fullmatch(r"sha256:[a-f0-9]{64}", digest) is None
                for name, digest in tasks.items()
            )
            or any(
                not isinstance(task_ref, str)
                or re.fullmatch(r"sha256:[a-f0-9]{64}", task_ref) is None
                for task_ref in task_refs.values()
            )
        ):
            raise ValueError(f"Terminal-Bench task manifest must contain exactly {TASK_COUNT} sorted instruction digests.")
        digest = "sha256:" + hashlib.sha256(
            json.dumps(tasks, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        if manifest.get("instructionDigest") != digest:
            raise ValueError("Terminal-Bench task manifest instruction digest is invalid.")
        task_ref_digest = "sha256:" + hashlib.sha256(
            json.dumps(task_refs, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        if manifest.get("taskRefDigest") != task_ref_digest:
            raise ValueError("Terminal-Bench task manifest task ref digest is invalid.")
        return {name: digest for name, digest in tasks.items()}

    @staticmethod
    def _load_semantic_manifest(
        file_path: Path, task_manifest: dict[str, str]
    ) -> tuple[dict[str, dict[str, Any]], str]:
        try:
            manifest = json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("Terminal-Bench semantic manifest is unreadable.") from error
        if (
            not isinstance(manifest, dict)
            or set(manifest) != {
                "schema",
                "dataset",
                "datasetRef",
                "officialInstructionDigest",
                "entries",
                "manifestDigest",
            }
            or manifest.get("schema") != SEMANTIC_MANIFEST_SCHEMA
            or manifest.get("dataset") != DATASET
            or manifest.get("datasetRef") != DATASET_REF
            or manifest.get("officialInstructionDigest") != INSTRUCTION_DIGEST
            or not isinstance(manifest.get("entries"), list)
            or len(manifest["entries"]) != TASK_COUNT
            or not isinstance(manifest.get("manifestDigest"), str)
            or re.fullmatch(r"sha256:[a-f0-9]{64}", manifest["manifestDigest"]) is None
        ):
            raise ValueError("Terminal-Bench semantic manifest does not match the pinned official task hash manifest.")
        official_digests = list(task_manifest.values())
        entries = manifest["entries"]
        sorted_entries = sorted(entries, key=lambda entry: str(entry.get("instructionDigest")) if isinstance(entry, dict) else "")
        if entries != sorted_entries:
            raise ValueError("Terminal-Bench semantic manifest entries must be sorted by full instruction digest.")
        seen: set[str] = set()
        result: dict[str, dict[str, Any]] = {}
        for entry in entries:
            if (
                not isinstance(entry, dict)
                or set(entry) != {
                    "instructionDigest",
                    "preferredProvider",
                    "taskType",
                    "complexity",
                    "truncated",
                }
                or not isinstance(entry.get("instructionDigest"), str)
                or re.fullmatch(r"sha256:[a-f0-9]{64}", entry["instructionDigest"]) is None
                or entry["instructionDigest"] not in official_digests
                or entry["instructionDigest"] in seen
                or not isinstance(entry.get("preferredProvider"), str)
                or PROVIDER_ID_PATTERN.fullmatch(entry["preferredProvider"]) is None
                or not isinstance(entry.get("taskType"), str)
                or SEMANTIC_TASK_TYPE_PATTERN.fullmatch(entry["taskType"]) is None
                or entry.get("complexity") not in SEMANTIC_COMPLEXITIES
                or not isinstance(entry.get("truncated"), bool)
            ):
                raise ValueError("Terminal-Bench semantic manifest entry is invalid or not an official instruction digest.")
            digest = entry["instructionDigest"]
            seen.add(digest)
            result[digest] = {
                "preferredProvider": entry["preferredProvider"],
                "taskType": entry["taskType"],
                "complexity": entry["complexity"],
                "truncated": entry["truncated"],
            }
        if len(seen) != len(official_digests) or any(digest not in seen for digest in official_digests):
            raise ValueError("Terminal-Bench semantic manifest must cover every official task instruction exactly once.")
        canonical = {
            "schema": manifest["schema"],
            "dataset": manifest["dataset"],
            "datasetRef": manifest["datasetRef"],
            "officialInstructionDigest": manifest["officialInstructionDigest"],
            "entries": entries,
        }
        manifest_digest = "sha256:" + hashlib.sha256(
            json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        if manifest["manifestDigest"] != manifest_digest:
            raise ValueError("Terminal-Bench semantic manifest digest is invalid.")
        return result, manifest_digest

    def _validate_instruction(self, instruction: str) -> dict[str, Any]:
        digest = "sha256:" + hashlib.sha256(instruction.encode("utf-8")).hexdigest()
        if digest not in self._manifest.values():
            raise ValueError("The Harbor instruction is not one of the pinned Terminal-Bench 2.0 task instructions.")
        semantic = self._semantic_manifest.get(digest)
        if semantic is None:
            raise ValueError("The Harbor instruction has no semantic preference in the pinned manifest.")
        if semantic["truncated"] != (len(instruction) > 4_000):
            raise ValueError("The semantic manifest truncation observation does not match the official instruction.")
        return semantic

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
        await self._upload_agent_owned_file(
            environment,
            self.task_manifest,
            "/installed-agent/terminal-bench-2-manifest.json",
        )
        await self._upload_agent_owned_file(
            environment,
            self.semantic_manifest,
            "/installed-agent/terminalbench-semantic-manifest.json",
        )

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
        model = "tokenless/auto"
        patch = "\n".join(
            [
                "- id: system-prompt",
                "  config:",
                "    persona: >-",
                "      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}. Start each user task with exactly one read tool call to inspect the most relevant workspace file without changing it. Then call subagent exactly once with a self-contained request to inspect the current workspace with its tools and return concrete task-relevant analysis. Wait for that result and use it only as input. Then use your own tools to complete the requested workspace changes and verify the observable result. Batch independent permitted changes into one edit or terminal command and verify them together. When a task has a finite set of allowed changes and a local verifier, use one terminal script to search the allowed candidates, run the verifier, and keep a passing workspace state; do not alternate one candidate edit and one verifier call across model turns. Before running that script, calculate its maximum candidate and verifier counts. Never enumerate a power set, never use a loop whose upper bound is the full candidate count, and never run more than 64 total verifier executions, including any final verification, or 120 seconds total across search and final verification. If that bounded search does not pass, preserve the best measured task-permitted candidate, perform one final verification within that same budget, and continue without launching another search. Keep any temporary search machinery outside protected workspace files and apply only task-permitted workspace changes. Never stop at analysis, instructions for the user, or a claim of success without executing the task. Do not delegate more than once.",
                "- id: llm-deepseek",
                "  config:",
                "    apiKeyEnv: DEEPSEEK_API_KEY",
                f"    baseURL: http://127.0.0.1:{PROXY_PORT}/v1/openai",
                "    streamIdleTimeoutMs: 660000",
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
                "- id: session-title-llm",
                "  disabled: true",
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
                "        provider: auto",
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
        semantic = self._validate_instruction(instruction)
        semantic_preference = semantic["preferredProvider"]
        self.current_semantic_preference = semantic_preference
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
            self.profile,
            semantic_preference,
            str(self.token_estimator_node),
            str(self.token_estimator_script),
            self.tokenless_home,
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
                    ">/dev/null 2>&1",
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
            except NonZeroAgentExitCodeError:
                self._write_dsh_classification(
                    "dsh_nonzero_exit", NonZeroAgentExitCodeError.__name__
                )
            except Exception as error:
                self._write_dsh_classification(
                    "dsh_execution_error", type(error).__name__
                )
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

    def _write_dsh_classification(
        self, classification: str, exception_class: str
    ) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "dsh-classification.json").write_text(
            json.dumps(
                {
                    "schema": "tokenless.terminalbench-dsh-diagnostic.v1",
                    "classification": classification,
                    "exceptionClass": exception_class,
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

    def _write_summary(self, events: list[dict[str, Any]]) -> None:
        parent_requests = [
            event for event in events if event.get("type") == "api.completion.request"
        ]
        child_turns = [
            event for event in events if event.get("type") == "child.turn.started"
        ]
        routing_events = [
            event for event in events if event.get("type") == "provider.routing"
        ]
        summary = {
            "protocol": CHANNEL_PROTOCOL,
            "auditProtocol": AUDIT_PROTOCOL,
            "dshRevision": DSH_REVISION,
            "model": "tokenless/auto",
            "routingMode": "auto",
            "semanticManifestDigest": self.semantic_manifest_digest,
            "semanticPreference": getattr(self, "current_semantic_preference", None),
            "taskScopedBridge": True,
            "containerReceivesHostAdminToken": False,
            "hostObservedBoundaries": {
                "parentCompletionRequests": len(parent_requests),
                "forcedParentCompletionRequests": sum(
                    event.get("forcedSubagent") is True for event in parent_requests
                ),
                "childBootstrapTurns": sum(
                    event.get("mode") == "bootstrap" for event in child_turns
                ),
                "childContinuationTurns": sum(
                    event.get("mode") == "continuation" for event in child_turns
                ),
                "providerRoutingEvents": len(routing_events),
            },
        }
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "dsh-tokenless-summary.json").write_text(
            json.dumps(summary, sort_keys=True) + "\n",
            encoding="utf-8",
        )
