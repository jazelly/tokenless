"""Harbor agent for the pinned DeepSeek Harness Terminal-Bench 4.0 lane."""

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
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, override
from urllib.parse import quote, unquote, urlsplit

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.constants import PACKAGE_CACHE_DIR
from harbor.models.agent.context import AgentContext
from harbor.models.task.task import strip_canary


DSH_REVISION = "47f943859bef60e4160492346772ded9b24f765a"
DATASET = "terminal-bench/terminal-bench"
DATASET_REF = "sha256:39d9f44b40420cde8fdcc087579c0d72a7e14fa3656d603c3f0d22fb35e27732"
TASK_COUNT = 66
TASK_MANIFEST_SCHEMA = "tokenless.terminalbench-task-manifest.v1"
SEMANTIC_MANIFEST_SCHEMA = "tokenless.terminalbench-semantic-manifest.v1"
INSTRUCTION_DIGEST = "sha256:f21c077ed1a0250613280843bedbc33bfd8bcee2907a60cfa68456f7384908b1"
TASK_REF_DIGEST = "sha256:5ed4031d63f2690291b91c613eb46f0879f0218a9a87a398bd3ae7164037d078"
CHANNEL_PROTOCOL = "tokenless.terminalbench-channel.v1"
AUDIT_PROTOCOL = "tokenless.terminalbench-deep-audit.v4"
PROXY_PORT = 18765
MAX_BRIDGE_BODY_BYTES = 8 * 1024 * 1024
FINAL_ONLY_AFTER_SECONDS = 600
PROVIDER_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
SEMANTIC_TASK_TYPE_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
SEMANTIC_COMPLEXITIES = {"low", "medium", "high"}
PROVIDER_REF_PATTERN = re.compile(r"^provider:[a-f0-9]{32}$")
PROVIDER_BINDING_REF_PATTERN = re.compile(r"^binding:[a-f0-9]{32}$")
PROVIDER_ATTACHMENT_REF_PATTERN = re.compile(r"^attachment:[a-f0-9]{32}$")
PROVIDER_TURN_REF_PATTERN = re.compile(r"^turn:[a-f0-9]{32}$")
PROVIDER_CONVERSATION_REF_PATTERN = re.compile(r"^conversation:[a-f0-9]{32}$")
PROVIDER_REQUEST_REF_PATTERN = re.compile(r"^request:[a-f0-9]{32}$")
TOOL_CALL_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,256}$")
SAFE_METADATA_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._:/+\-]{0,159}$")
SAFE_REASON_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,95}$")
PROVIDER_JOB_IDS_HEADER = "X-Tokenless-Route-Job-Ids"
PROVIDER_JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PROVIDER_MODEL_SLUG_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
AUDIT_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)
PROVIDER_SUBMISSION_OBSERVATION_PROTOCOL = (
    "tokenless.provider-submission-observation.v1"
)
WEB_AI_INTERACTION_PROTOCOL = "tokenless.internal.web-ai-interaction-protocol/v0"
REQUIRED_CAPABILITIES = ("conversation.chat", "file.upload", "document.input")
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
        provider: str = "auto",
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
        self.expected_provider = provider
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
        # The bridge handler holds this for every provider-state request and response.
        self.provider_control_lock = threading.Lock()
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
        self._parent_interactions: dict[str, dict[str, Any]] = {}
        self._parent_interaction_events: dict[str, int] = {}
        self._child_interactions: dict[str, dict[str, Any]] = {}
        self._tool_calls: dict[tuple[str, str | None, str], dict[str, Any]] = {}
        self._child_result_interaction_id: str | None = None
        self._attachment_evidence: dict[str, dict[str, Any]] = {}
        self._provider_attachment_jobs: set[str] = set()
        self._subagent_dispatch_lock = threading.Lock()
        self._subagent_dispatch_state = "available"
        self._subagent_dispatch_completed_monotonic: float | None = None

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
            self._subagent_dispatch_completed_monotonic = (
                time.monotonic() if succeeded else None
            )

    def final_only_parent_completion_due(self) -> bool:
        with self._subagent_dispatch_lock:
            completed_at = self._subagent_dispatch_completed_monotonic
            return (
                self._subagent_dispatch_state == "dispatched"
                and completed_at is not None
                and time.monotonic() - completed_at >= FINAL_ONLY_AFTER_SECONDS
            )

    def record_event(self, value: dict[str, Any]) -> int:
        with self._audit_lock:
            sequence = len(self._audit_events) + 1
            self._audit_events.append(
                {
                    "protocol": AUDIT_PROTOCOL,
                    "sequence": sequence,
                    **value,
                }
            )
            return sequence

    def audit_events(self) -> list[dict[str, Any]]:
        with self._audit_lock:
            return [dict(event) for event in self._audit_events]

    @staticmethod
    def _observed_at() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )

    @staticmethod
    def _interaction_id(scope: str) -> str:
        if scope not in {"parent", "child"}:
            raise ValueError("interaction scope is invalid")
        return f"{scope}:{secrets.token_hex(16)}"

    @staticmethod
    def _duration_ms(started_monotonic: float, finished_monotonic: float) -> int:
        return max(0, round((finished_monotonic - started_monotonic) * 1000))

    @staticmethod
    def _digest_summary(value: Any) -> dict[str, Any]:
        """Describe a value without retaining its prompt, arguments, or result text."""
        if isinstance(value, bytes):
            payload = value
            characters = None
        elif isinstance(value, str):
            payload = value.encode("utf-8")
            characters = len(value)
        else:
            payload = json.dumps(
                value, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")
            characters = None
        result: dict[str, Any] = {
            "availability": "observed",
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
        }
        if characters is not None:
            result["characters"] = characters
        return result

    @staticmethod
    def _unknown(reason: str) -> dict[str, Any]:
        return {"availability": "unknown", "reason": reason}

    @staticmethod
    def _safe_metadata(value: Any) -> str | None:
        return (
            value.strip()
            if isinstance(value, str)
            and value.strip()
            and SAFE_METADATA_PATTERN.fullmatch(value.strip())
            else None
        )

    @staticmethod
    def _safe_reason(value: Any) -> str | None:
        return (
            value.strip()
            if isinstance(value, str)
            and value.strip()
            and SAFE_REASON_PATTERN.fullmatch(value.strip())
            else None
        )

    @classmethod
    def _safe_origin(cls, value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        parsed = urlsplit(value.strip())
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            return None
        return cls._safe_metadata(
            f"{parsed.scheme}://{parsed.netloc}"
        )

    @classmethod
    def _provider_metadata_choice(
        cls,
        value: Any,
        *,
        requested_key: str,
        observed_key: str,
        unknown_reason: str,
    ) -> dict[str, Any]:
        requested = cls._safe_metadata(value.get(requested_key)) if isinstance(value, dict) else None
        observed = (
            cls._safe_metadata(value.get(observed_key))
            if isinstance(value, dict) and value.get("status") == "observed"
            else None
        )
        reason = cls._safe_reason(value.get("reason")) if isinstance(value, dict) else None
        return {
            "requested": (
                {"availability": "observed", "value": requested}
                if requested is not None
                else cls._unknown(f"{unknown_reason}_requested")
            ),
            "observed": (
                {"availability": "observed", "value": observed}
                if observed is not None
                else cls._unknown(reason or f"{unknown_reason}_observed")
            ),
        }

    @classmethod
    def _provider_raw_choice_observation(
        cls, value: Any, *, model: bool = False
    ) -> dict[str, Any]:
        value = value if isinstance(value, dict) else {}
        status = value.get("status") if value.get("status") in {"observed", "unknown"} else "unknown"
        source = value.get("source") if value.get("source") in {
            "visible-provider-choice-inspect",
            "not-observed",
        } else "not-observed"
        requested = cls._safe_metadata(value.get("requestedLabel"))
        observed = cls._safe_metadata(value.get("observedLabel")) if status == "observed" else None
        result: dict[str, Any] = {
            "requestedLabel": requested,
            "observedLabel": observed,
            "status": status,
            "source": source,
            "reason": cls._safe_reason(value.get("reason")),
        }
        if model:
            identity_status = (
                value.get("identityStatus")
                if value.get("identityStatus") in {"not-exposed", "unknown"}
                else "unknown"
            )
            result["providerModelId"] = cls._safe_metadata(value.get("providerModelId"))
            result["identityStatus"] = identity_status
        return result

    @classmethod
    def _provider_response_model_observation(
        cls, value: Any
    ) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        status = value.get("status")
        source = value.get("source")
        observed_at = value.get("observedAt")
        provider_model_id = value.get("providerModelId")
        reason = value.get("reason")
        if (
            source != "assistant-message-dom"
            or not isinstance(observed_at, str)
            or AUDIT_TIMESTAMP_PATTERN.fullmatch(observed_at) is None
            or reason not in {None, "assistant_message_model_not_exposed"}
        ):
            return None
        if (
            status == "observed"
            and isinstance(provider_model_id, str)
            and PROVIDER_MODEL_SLUG_PATTERN.fullmatch(provider_model_id) is not None
            and source == "assistant-message-dom"
            and observed_at is not None
        ):
            return {
                "providerModelId": provider_model_id,
                "status": "observed",
                "source": source,
                "observedAt": observed_at,
                "reason": None,
            }
        if status != "unknown" or provider_model_id is not None:
            return None
        return {
            "providerModelId": None,
            "status": "unknown",
            "source": source,
            "observedAt": observed_at,
            "reason": reason,
        }

    @classmethod
    def _empty_provider_execution_metadata(cls, reason: str) -> dict[str, Any]:
        return {
            "model": {
                "requested": cls._unknown(f"{reason}_model_requested"),
                "observed": cls._unknown(f"{reason}_model_observed"),
            },
            "reasoningEffort": {
                "requested": cls._unknown(f"{reason}_effort_requested"),
                "observed": cls._unknown(f"{reason}_effort_observed"),
            },
            "surface": {
                "requested": cls._unknown(f"{reason}_surface_requested"),
                "observed": cls._unknown(f"{reason}_surface_observed"),
            },
            "jobs": [],
            "submissions": [],
        }

    @classmethod
    def _submission_observation_metadata(
        cls, observation: Any
    ) -> dict[str, Any] | None:
        if not isinstance(observation, dict):
            return None
        model = observation.get("model")
        effort = observation.get("effort")
        page = observation.get("page")
        metadata = {
            "model": cls._provider_metadata_choice(
                model,
                requested_key="requestedLabel",
                observed_key="observedLabel",
                unknown_reason="provider_model_observation",
            ),
            "reasoningEffort": cls._provider_metadata_choice(
                effort,
                requested_key="requestedLabel",
                observed_key="observedLabel",
                unknown_reason="provider_effort_observation",
            ),
            "surface": {
                "requested": cls._unknown("provider_surface_request_not_applicable"),
                "observed": (
                    {"availability": "observed", "value": page.get("surface")}
                    if isinstance(page, dict)
                    and page.get("surface") in {"chat", "work", "unknown"}
                    else cls._unknown("provider_surface_observation")
                ),
            },
        }
        observed_at = observation.get("observedAt")
        if isinstance(observed_at, str) and AUDIT_TIMESTAMP_PATTERN.fullmatch(observed_at):
            metadata["observedAt"] = observed_at
        metadata["submissionObservation"] = {
            "protocol": (
                PROVIDER_SUBMISSION_OBSERVATION_PROTOCOL
                if observation.get("protocol") == PROVIDER_SUBMISSION_OBSERVATION_PROTOCOL
                else None
            ),
            "observedAt": observed_at if isinstance(observed_at, str) and AUDIT_TIMESTAMP_PATTERN.fullmatch(observed_at) else None,
            "source": (
                observation.get("source")
                if observation.get("source") in {
                    "visible-provider-controls-before-submit",
                    "direct-protocol-no-visible-controls",
                }
                else None
            ),
            "page": {
                "surface": (
                    page.get("surface")
                    if isinstance(page, dict) and page.get("surface") in {"chat", "work", "unknown"}
                    else "unknown"
                ),
                "origin": cls._safe_origin(page.get("origin") if isinstance(page, dict) else None),
            },
            "model": cls._provider_raw_choice_observation(model, model=True),
            "effort": cls._provider_raw_choice_observation(effort),
        }
        return metadata

    @classmethod
    def _provider_action_metadata(cls, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        metadata: dict[str, Any] = {}
        provider = cls._safe_metadata(value.get("provider"))
        if provider is not None:
            metadata["provider"] = provider
        action_index = value.get("actionIndex")
        if isinstance(action_index, int) and not isinstance(action_index, bool) and 0 <= action_index <= 256:
            metadata["actionIndex"] = action_index
        for source_key, target_key in (
            ("startedAt", "startedAt"),
            ("completedAt", "completedAt"),
        ):
            timestamp = value.get(source_key)
            if isinstance(timestamp, str) and AUDIT_TIMESTAMP_PATTERN.fullmatch(timestamp):
                metadata[target_key] = timestamp
        duration = value.get("durationMs")
        if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0:
            metadata["durationMs"] = duration
        execution_mode = value.get("executionMode")
        if execution_mode in {"browser", "direct"}:
            metadata["executionMode"] = execution_mode
        return metadata

    @classmethod
    def _submission_observations_from_job(
        cls, job_id: str, job: Any
    ) -> list[dict[str, Any]]:
        if not isinstance(job, dict):
            return []
        result_json = job.get("result_json")
        if not isinstance(result_json, dict):
            return []
        responses = result_json.get("responses")
        if not isinstance(responses, list):
            return []
        job_provider = cls._safe_metadata(result_json.get("provider"))
        observations: list[dict[str, Any]] = []
        pending_submission: dict[str, Any] | None = None
        for response in responses[:64]:
            if not isinstance(response, dict):
                continue
            action = response.get("action")
            if action == "response.read":
                if pending_submission is None:
                    continue
                current_submission = pending_submission
                pending_submission = None
                result = response.get("result")
                current_submission["responseModel"] = (
                    cls._provider_response_model_observation(
                        result.get("modelObservation")
                        if isinstance(result, dict)
                        else None
                    )
                )
                continue
            if action != "prompt.submit":
                continue
            pending_submission = None
            result = response.get("result")
            if not isinstance(result, dict):
                continue
            candidate = cls._submission_observation_metadata(result.get("submissionObservation"))
            if candidate is None:
                continue
            action_metadata = cls._provider_action_metadata(response.get("metadata"))
            provider = (
                cls._safe_metadata(response.get("provider"))
                or cls._safe_metadata(action_metadata.get("provider"))
                or job_provider
            )
            observations.append(
                {
                    "jobId": job_id,
                    "provider": provider,
                    "action": "prompt.submit",
                    "metadata": action_metadata,
                    "submissionObservation": candidate["submissionObservation"],
                    "responseModel": None,
                }
            )
            pending_submission = observations[-1]
        return observations

    def _read_provider_job(self, job_id: str) -> dict[str, Any] | None:
        """Read the local terminal job while retaining only an in-memory JSON value."""
        connection = http.client.HTTPConnection(
            self.daemon_host,
            self.daemon_port,
            timeout=30,
        )
        try:
            path = f"/v1/private/jobs/{quote(job_id, safe='')}"
            connection.request(
                "GET",
                path,
                headers={
                    "Authorization": f"Bearer {self.control_token}",
                    "Accept": "application/json",
                },
            )
            response = connection.getresponse()
            content_length = response.getheader("Content-Length")
            if content_length is not None:
                try:
                    declared_length = int(content_length)
                except ValueError:
                    return None
                if declared_length < 0 or declared_length > MAX_BRIDGE_BODY_BYTES:
                    return None
            body = response.read(MAX_BRIDGE_BODY_BYTES + 1)
            if response.status != 200 or len(body) > MAX_BRIDGE_BODY_BYTES:
                return None
            value = json.loads(body)
            return value if isinstance(value, dict) else None
        except (OSError, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError):
            return None
        finally:
            connection.close()

    @classmethod
    def _provider_job_record(
        cls,
        job_id: str,
        job: dict[str, Any] | None,
        observations: list[dict[str, Any]],
        reason: str | None = None,
    ) -> dict[str, Any]:
        if job is None:
            return {
                "jobId": job_id,
                "availability": "unknown",
                "status": None,
                "provider": None,
                "providerSubmitted": None,
                "submissionCount": 0,
                "reason": reason or "provider_job_metadata_unavailable",
                "errorCode": None,
                "errorClassification": None,
                "capabilityRequirements": None,
                "profileId": None,
            }
        error = job.get("error_json")
        error = error if isinstance(error, dict) else {}
        details = error.get("details")
        details = details if isinstance(details, dict) else {}
        status = job.get("status")
        if status not in {"queued", "running", "waiting_for_user", "succeeded", "failed", "canceled", "cancelled"}:
            status = None
        error_code = cls._safe_reason(error.get("code"))
        classification = details.get("classification")
        if classification not in {
            "safe_pre_submit_provider_failure", "ambiguous_external_state",
            "post_submission_failure", "user_resolvable_local_failure",
        }:
            classification = None
        if status == "failed" and (error_code is None or classification is None):
            reason = "provider_job_error_metadata_unavailable"
        provider = cls._safe_metadata(job.get("provider"))
        request = job.get("request_json")
        route = request.get("capabilityRoute") if isinstance(request, dict) else None
        requirements = route.get("requirements") if isinstance(route, dict) else None
        if not (
            isinstance(requirements, list)
            and all(isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_.-]{0,95}", value) for value in requirements)
        ):
            requirements = None
        submitted_at = job.get("provider_submitted_at")
        provider_submitted = (
            bool(submitted_at)
            if submitted_at is None or isinstance(submitted_at, str)
            else None
        )
        if not observations and reason is None:
            reason = (
                "prompt_submit_observation_missing"
                if provider_submitted is True
                else "provider_submission_observation_unavailable"
            )
        return {
            "jobId": job_id,
            "availability": "observed",
            "status": status,
            "provider": provider,
            "providerSubmitted": provider_submitted,
            "submissionCount": len(observations),
            "reason": reason,
            "errorCode": error_code,
            "errorClassification": classification,
            "capabilityRequirements": requirements,
            "profileId": cls._safe_metadata(job.get("profile_id")),
        }

    def _provider_execution_metadata(
        self, upstream: http.client.HTTPResponse
    ) -> dict[str, Any]:
        """Resolve provider-visible model/effort/surface from the exact job contract."""
        header = upstream.getheader(PROVIDER_JOB_IDS_HEADER)
        if not isinstance(header, str) or not header.strip():
            return self._empty_provider_execution_metadata("provider_job_ids_unavailable")
        job_ids = [value.strip() for value in header.split(",")]
        if (
            not 1 <= len(job_ids) <= 2
            or any(PROVIDER_JOB_ID_PATTERN.fullmatch(value) is None for value in job_ids)
            or len(set(job_ids)) != len(job_ids)
        ):
            return self._empty_provider_execution_metadata("provider_job_ids_invalid")
        observations: list[dict[str, Any]] = []
        jobs: list[dict[str, Any]] = []
        for job_id in job_ids:
            job = self._read_provider_job(job_id)
            if job is None:
                jobs.append(self._provider_job_record(job_id, None, []))
                continue
            self._record_provider_job_uploads(job_id, job)
            job_observations = self._submission_observations_from_job(job_id, job)
            observations.extend(job_observations)
            jobs.append(self._provider_job_record(job_id, job, job_observations))
        if not observations:
            metadata = self._empty_provider_execution_metadata(
                "provider_submission_observation_unavailable"
            )
        else:
            selected = observations[-1]["submissionObservation"]
            metadata = {
                "model": self._provider_metadata_choice(
                    selected.get("model"),
                    requested_key="requestedLabel",
                    observed_key="observedLabel",
                    unknown_reason="provider_model_observation",
                ),
                "reasoningEffort": self._provider_metadata_choice(
                    selected.get("effort"),
                    requested_key="requestedLabel",
                    observed_key="observedLabel",
                    unknown_reason="provider_effort_observation",
                ),
                "surface": {
                    "requested": self._unknown("provider_surface_request_not_applicable"),
                    "observed": (
                        {"availability": "observed", "value": selected["page"]["surface"]}
                        if selected.get("page", {}).get("surface") in {"chat", "work", "unknown"}
                        else self._unknown("provider_surface_observation")
                    ),
                },
            }
            observed_at = selected.get("observedAt")
            if isinstance(observed_at, str) and AUDIT_TIMESTAMP_PATTERN.fullmatch(observed_at):
                metadata["observedAt"] = observed_at
        metadata["jobIds"] = job_ids
        metadata["jobs"] = jobs
        metadata["submissions"] = observations
        return metadata

    @staticmethod
    def _tool_name(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value if 1 <= len(value) <= 160 and SAFE_METADATA_PATTERN.fullmatch(value) else None

    @staticmethod
    def _tool_call_id(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        return value if TOOL_CALL_ID_PATTERN.fullmatch(value) else None

    @classmethod
    def _explicit_tool_choice(cls, value: Any) -> tuple[str | None, bool | None]:
        """Return (named tool, requested flag); null means the provider chose."""
        if value == "none":
            return None, False
        if value == "auto" or value == "required" or value is None:
            return None, None
        if not isinstance(value, dict) or value.get("type") != "function":
            return None, None
        function = value.get("function")
        name = cls._tool_name(function.get("name") if isinstance(function, dict) else None)
        return name, name is not None

    def _tool_record(
        self,
        scope: str,
        call_id: str,
        tool_name: str | None = None,
        interaction_id: str | None = None,
    ) -> dict[str, Any]:
        if scope not in {"parent", "child"}:
            raise ValueError("tool interaction scope is invalid")
        # Child call IDs are unique within one action batch, not the whole run.
        key = (scope, interaction_id if scope == "child" else None, call_id)
        current = self._tool_calls.get(key)
        if current is None:
            current = {
                "scope": scope,
                "callId": call_id,
                "toolName": tool_name,
                "interactionId": interaction_id,
                "requested": None,
                "returned": False,
                "executed": False,
                "outcome": "unknown",
                "exitCode": None,
                "arguments": self._unknown("tool_arguments_not_observed"),
                "result": self._unknown("tool_result_not_observed"),
            }
            self._tool_calls[key] = current
        if tool_name is not None and current.get("toolName") is None:
            current["toolName"] = tool_name
        if interaction_id is not None and current.get("interactionId") is None:
            current["interactionId"] = interaction_id
        return current

    @classmethod
    def _tool_record_view(cls, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "callId": record["callId"],
            "toolName": record.get("toolName"),
            "interactionId": record.get("interactionId"),
            "requested": record.get("requested"),
            "returned": bool(record.get("returned")),
            "executed": bool(record.get("executed")),
            "outcome": record.get("outcome", "unknown"),
            "exitCode": record.get("exitCode"),
            "arguments": record.get("arguments", cls._unknown("tool_arguments_not_observed")),
            "result": record.get("result", cls._unknown("tool_result_not_observed")),
            **{
                key: record[key]
                for key in ("returnedAt", "resultObservedAt")
                if key in record
            },
        }

    def _observe_tool_result(
        self,
        scope: str,
        call_id: str,
        result: Any,
        observed_at: str,
        interaction_id: str | None = None,
    ) -> None:
        safe_call_id = self._tool_call_id(call_id)
        if safe_call_id is None:
            return
        record = self._tool_record(scope, safe_call_id, interaction_id=interaction_id)
        if not record["executed"]:
            record["executed"] = True
            # This timestamp is when the bridge observed the provider result;
            # it is not a claim about the tool process's own execution time.
            record["resultObservedAt"] = observed_at
            record["result"] = self._digest_summary(result)
        if isinstance(result, dict):
            status = result.get("status")
            if status in {"succeeded", "failed"}:
                record["outcome"] = status
            elif result.get("error") is not None or result.get("code") in {
                "harness_tool_execution_failed",
                "harness_tool_arguments_invalid",
            }:
                record["outcome"] = "failed"
            content = result.get("content")
            exit_source = content if isinstance(content, dict) else result
            for key in ("exitCode", "exit_code"):
                exit_code = exit_source.get(key)
                if isinstance(exit_code, int) and not isinstance(exit_code, bool):
                    record["exitCode"] = exit_code
                    break
        elif isinstance(result, str):
            # Plain provider tool results do not expose a trustworthy process exit code.
            record["outcome"] = "unknown"
        self._refresh_tool_evidence_events(record)

    def _refresh_tool_evidence_events(self, record: dict[str, Any]) -> None:
        interaction_id = record.get("interactionId")
        if not isinstance(interaction_id, str):
            return
        tools = [
            self._tool_record_view(candidate)
            for candidate in self._tool_calls.values()
            if candidate.get("interactionId") == interaction_id
        ]
        with self._audit_lock:
            for event in self._audit_events:
                if event.get("interactionId") == interaction_id and "tools" in event:
                    event["tools"] = tools

    def _observe_parent_request_messages(
        self,
        value: dict[str, Any],
        interaction_id: str,
        observed_at: str,
        requested_tool: str | None,
        requested_flag: bool | None,
    ) -> None:
        messages = value.get("messages")
        if not isinstance(messages, list):
            return
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "tool":
                call_id = self._tool_call_id(message.get("tool_call_id"))
                if call_id is None:
                    continue
                self._observe_tool_result(
                    "parent",
                    call_id,
                    message.get("content"),
                    observed_at,
                    interaction_id=interaction_id,
                )
                continue
            if role != "assistant" or not isinstance(message.get("tool_calls"), list):
                continue
            for call in message["tool_calls"]:
                if not isinstance(call, dict):
                    continue
                call_id = self._tool_call_id(call.get("id"))
                function = call.get("function")
                if call_id is None or not isinstance(function, dict):
                    continue
                tool_name = self._tool_name(function.get("name"))
                record = self._tool_record("parent", call_id, tool_name, interaction_id)
                if not record["returned"]:
                    record["returned"] = True
                    record.setdefault("returnedAt", observed_at)
                    record["requested"] = (
                        requested_flag
                        if requested_tool is None or tool_name == requested_tool
                        else False
                    )
                    arguments = function.get("arguments")
                    if isinstance(arguments, str):
                        record["arguments"] = self._digest_summary(arguments)

    def _record_parent_response_tools(
        self,
        interaction_id: str,
        body: bytes,
        requested_tool: str | None,
        requested_flag: bool | None,
        observed_at: str,
    ) -> list[dict[str, Any]]:
        calls = self._completion_tool_calls(body)
        for call in calls:
            record = self._tool_record(
                "parent", call["callId"], call["toolName"], interaction_id
            )
            record["returned"] = True
            record.setdefault("returnedAt", observed_at)
            record["requested"] = (
                requested_flag
                if requested_tool is None or call["toolName"] == requested_tool
                else False
            )
            record["arguments"] = call["arguments"]
        return [
            self._tool_record_view(record)
            for record in self._tool_calls.values()
            if record.get("interactionId") == interaction_id
        ]

    def _record_child_response_tools(
        self, turn_ref: str, body: bytes, observed_at: str
    ) -> list[dict[str, Any]]:
        interaction_id = f"child:{turn_ref.removeprefix('turn:')}"
        output_text = self._provider_turn_output_text(body)
        value: dict[str, Any] = {"status": "unavailable", "normalizationApplied": None}
        if output_text:
            try:
                completed = subprocess.run(
                    [self.token_estimator_node, str(Path(self.token_estimator_script).with_name("provider_response_metadata.mjs"))],
                    input=output_text, text=True, capture_output=True, timeout=20, check=False,
                )
                parsed = json.loads(completed.stdout) if completed.returncode == 0 else None
                if isinstance(parsed, dict):
                    value = parsed
            except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
                pass
        status = value.get("status", "unavailable")
        interaction = self._child_interactions.get(turn_ref)
        if interaction is not None:
            interaction["toolResponseStatus"] = status
            interaction["toolResponseNormalizationApplied"] = value.get("normalizationApplied")
        if status != "action_batch":
            return []
        self._child_result_interaction_id = interaction_id
        calls = value.get("calls")
        if isinstance(calls, list):
            for call in calls:
                if not isinstance(call, dict):
                    continue
                call_id = self._tool_call_id(call.get("id"))
                tool_name = self._tool_name(call.get("tool"))
                if call_id is None:
                    continue
                record = self._tool_record("child", call_id, tool_name, interaction_id)
                record["returned"] = True
                record.setdefault("returnedAt", observed_at)
                record["arguments"] = call["arguments"]
                record["requested"] = None
        return [
            self._tool_record_view(record)
            for record in self._tool_calls.values()
            if record.get("interactionId") == interaction_id
        ]

    def _record_child_result_attachment(self, body: str, observed_at: str) -> None:
        try:
            value = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if not isinstance(value, dict) or value.get("kind") != "action_batch_result":
            return
        results = value.get("callResults")
        if not isinstance(results, list):
            return
        # The continuation carries results for the previous child action batch.
        # This bridge permits one serial child chain; IDs belong to its preceding batch.
        for result in results:
            if not isinstance(result, dict):
                continue
            call_id = self._tool_call_id(result.get("id"))
            if call_id is None:
                continue
            self._observe_tool_result(
                "child", call_id, result, observed_at,
                interaction_id=self._child_result_interaction_id,
            )

    def record_parent_completion_request(self, body: bytes | None) -> tuple[int, int]:
        interaction_id = self._interaction_id("parent")
        started_at = self._observed_at()
        started_monotonic = time.monotonic()
        request_value: dict[str, Any] = {}
        try:
            parsed = self._json_object(body)
            request_value = parsed
        except ValueError:
            # The normal request validator will report the malformed request. Keep
            # the audit event metadata-only and explicit rather than retaining it.
            request_value = {}
        requested_tool, requested_flag = self._explicit_tool_choice(
            request_value.get("tool_choice")
        )
        with self._audit_lock:
            self._parent_completion_ordinal += 1
            ordinal = self._parent_completion_ordinal
            event = {
                    "protocol": AUDIT_PROTOCOL,
                    "sequence": len(self._audit_events) + 1,
                    "type": "api.completion.request",
                    "ordinal": ordinal,
                    "forcedSubagent": False,
                    "interactionId": interaction_id,
                    "startedAt": started_at,
                    "requestedModel": self._safe_metadata(request_value.get("model")),
                    "requestedReasoningEffort": self._safe_metadata(request_value.get("reasoning_effort")),
                    "requestedTool": requested_tool,
                    "requestedToolStatus": requested_flag,
                    "tools": [],
                }
            self._audit_events.append(event)
            sequence = len(self._audit_events)
            self._parent_interactions[interaction_id] = {
                "interactionId": interaction_id,
                "ordinal": ordinal,
                "startedAt": started_at,
                "startedMonotonic": started_monotonic,
                "requestedTool": requested_tool,
                "requestedToolStatus": requested_flag,
                "eventSequence": sequence,
            }
            self._parent_interaction_events[interaction_id] = sequence
        self._observe_parent_request_messages(
            request_value,
            interaction_id,
            started_at,
            requested_tool,
            requested_flag,
        )
        return sequence, ordinal

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

    def refresh_parent_completion_request(
        self, sequence: int, body: bytes | None
    ) -> None:
        with self._audit_lock:
            if sequence < 1 or sequence > len(self._audit_events):
                raise ValueError("parent completion audit reference is invalid")
            event = self._audit_events[sequence - 1]
            interaction_id = event.get("interactionId")
            if (
                event.get("type") != "api.completion.request"
                or not isinstance(interaction_id, str)
            ):
                raise ValueError("parent completion audit reference is invalid")
        request_value = self._json_object(body)
        requested_tool, requested_flag = self._explicit_tool_choice(
            request_value.get("tool_choice")
        )
        with self._audit_lock:
            event = self._audit_events[sequence - 1]
            event["requestedModel"] = self._safe_metadata(request_value.get("model"))
            event["requestedReasoningEffort"] = self._safe_metadata(
                request_value.get("reasoning_effort")
            )
            event["requestedTool"] = requested_tool
            event["requestedToolStatus"] = requested_flag
            interaction = self._parent_interactions.get(interaction_id)
            if interaction is not None:
                interaction["requestedTool"] = requested_tool
                interaction["requestedToolStatus"] = requested_flag
        self._observe_parent_request_messages(
            request_value,
            interaction_id,
            self._observed_at(),
            requested_tool,
            requested_flag,
        )

    def parent_interaction_id(self, sequence: int | None) -> str | None:
        if sequence is None:
            return None
        with self._audit_lock:
            if sequence < 1 or sequence > len(self._audit_events):
                return None
            value = self._audit_events[sequence - 1].get("interactionId")
            return value if isinstance(value, str) else None

    def record_parent_transport_failure(
        self, sequence: int | None, reason: str
    ) -> None:
        if sequence is None:
            return
        interaction_id = self.parent_interaction_id(sequence)
        if interaction_id is None:
            return
        finished_at = self._observed_at()
        interaction = self._parent_interactions.get(interaction_id)
        if interaction is None:
            return
        finished_monotonic = time.monotonic()
        interaction["finishedAt"] = finished_at
        interaction["durationMs"] = self._duration_ms(
            interaction["startedMonotonic"], finished_monotonic
        )
        interaction["outcome"] = "failed"
        interaction["failureReason"] = reason
        with self._audit_lock:
            event = self._audit_events[sequence - 1]
            if event.get("interactionId") != interaction_id:
                return
            event["finishedAt"] = finished_at
            event["durationMs"] = interaction["durationMs"]
            event["outcome"] = "failed"
            event["failureReason"] = reason

    def mark_parent_completion_final_only(self, sequence: int) -> None:
        with self._audit_lock:
            event = self._audit_events[sequence - 1]
            if (
                event.get("sequence") != sequence
                or event.get("type") != "api.completion.request"
            ):
                raise RuntimeError("parent completion audit reference is invalid")
            event["finalOnly"] = True

    def _complete_parent_interaction(
        self,
        interaction_id: str | None,
        body: bytes,
        outcome: str,
        finished_at: str,
        finished_monotonic: float,
    ) -> list[dict[str, Any]]:
        outcome = "succeeded" if outcome == "completed" else "failed"
        if interaction_id is None:
            return []
        interaction = self._parent_interactions.get(interaction_id)
        if interaction is None:
            return []
        tools = self._record_parent_response_tools(
            interaction_id,
            body,
            interaction.get("requestedTool"),
            interaction.get("requestedToolStatus"),
            finished_at,
        )
        interaction["finishedAt"] = finished_at
        interaction["durationMs"] = self._duration_ms(
            interaction["startedMonotonic"], finished_monotonic
        )
        interaction["outcome"] = outcome
        sequence = self._parent_interaction_events.get(interaction_id)
        if sequence is not None:
            with self._audit_lock:
                event = self._audit_events[sequence - 1]
                if event.get("interactionId") == interaction_id:
                    event["finishedAt"] = finished_at
                    event["durationMs"] = interaction["durationMs"]
                    event["outcome"] = outcome
                    event["tools"] = tools
        return tools

    def record_child_turn_started(
        self, operation: dict[str, Any], turn: dict[str, str], body: bytes
    ) -> None:
        turn_ref = turn["turnRef"]
        interaction_id = f"child:{turn_ref.removeprefix('turn:')}"
        finished_at = self._observed_at()
        finished_monotonic = time.monotonic()
        started_at = operation.get("startedAt", finished_at)
        started_monotonic = operation.get("startedMonotonic", finished_monotonic)
        self._child_interactions[turn_ref] = {
            "interactionId": interaction_id,
            "turnRef": turn_ref,
            "requestRef": operation["requestRef"],
            "mode": operation["mode"],
            "startedAt": started_at,
            "startedMonotonic": started_monotonic,
        }
        self.record_event(
            {
                "type": "child.turn.started",
                "interactionId": interaction_id,
                "requestRef": operation["requestRef"],
                "turnRef": turn_ref,
                "conversationRef": turn["conversationRef"],
                "mode": operation["mode"],
                "startedAt": started_at,
                "finishedAt": finished_at,
                "durationMs": self._duration_ms(started_monotonic, finished_monotonic),
                "outcome": "succeeded",
                "attachments": [
                    self._attachment_evidence[ref]
                    for ref in operation.get("attachmentRefs", [])
                    if ref in self._attachment_evidence
                ],
            }
        )
        # A provider turn may already return an action batch in its start response.
        self._child_result_interaction_id = None
        self._record_child_response_tools(turn_ref, body, finished_at)

    def record_child_turn_failed(
        self, operation: dict[str, Any], status: int
    ) -> None:
        finished_at = self._observed_at()
        finished_monotonic = time.monotonic()
        request_ref = operation.get("requestRef")
        interaction_id = (
            f"child:{request_ref.removeprefix('request:')}"
            if isinstance(request_ref, str)
            else self._interaction_id("child")
        )
        self.record_event(
            {
                "type": "child.turn.started",
                "interactionId": interaction_id,
                "requestRef": request_ref,
                "turnRef": None,
                "conversationRef": operation.get("conversationRef"),
                "mode": operation.get("mode"),
                "startedAt": operation.get("startedAt", finished_at),
                "finishedAt": finished_at,
                "durationMs": self._duration_ms(
                    operation.get("startedMonotonic", finished_monotonic),
                    finished_monotonic,
                ),
                "outcome": "failed",
                "httpStatus": status,
                "attachments": [
                    self._attachment_evidence[ref]
                    for ref in operation.get("attachmentRefs", [])
                    if ref in self._attachment_evidence
                ],
            }
        )

    def record_attachment_text(
        self,
        attachment_ref: str,
        body: bytes,
        *,
        name: str | None = None,
        media_type: str | None = None,
        returned: dict[str, Any] | None = None,
        started_at: str | None = None,
        started_monotonic: float | None = None,
    ) -> None:
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("provider text attachment is not UTF-8") from error
        self._attachment_text[attachment_ref] = text
        finished_at = self._observed_at()
        finished_monotonic = time.monotonic()
        returned = returned or {}
        returned_length = returned.get("byteLength")
        returned_sha256 = returned.get("sha256")
        body_sha256 = hashlib.sha256(body).hexdigest()
        self._attachment_evidence[attachment_ref] = {
            "stage": "host_attachment_store",
            "stored": bool(returned),
            "attachmentRef": attachment_ref,
            "name": name,
            "mediaType": media_type,
            "byteLength": len(body),
            "sha256": body_sha256,
            "declaredByteLength": returned_length,
            "declaredSha256": returned_sha256,
            "upload": {
                "requested": True,
                "returned": bool(returned),
                "retained": False,
            },
            "providerUpload": {
                "observed": False,
                "accepted": None,
                "jobId": None,
                "provider": None,
                "actionIndex": None,
                "visibleProof": None,
            },
            "outcome": "unknown",
            "unknownReason": "provider_upload_observation_unavailable",
            "startedAt": started_at or finished_at,
            "finishedAt": finished_at,
            "durationMs": (
                self._duration_ms(started_monotonic, finished_monotonic)
                if started_monotonic is not None
                else None
            ),
        }
        self.record_event({"type": "provider.attachment", **self._attachment_evidence[attachment_ref]})
        self._record_child_result_attachment(text, finished_at)

    def _refresh_attachment_event(self, attachment_ref: str) -> None:
        evidence = self._attachment_evidence.get(attachment_ref)
        if evidence is None:
            return
        with self._audit_lock:
            for event in self._audit_events:
                if event.get("type") == "provider.attachment" and event.get("attachmentRef") == attachment_ref:
                    event.update(evidence)

    def _record_provider_job_uploads(self, job_id: str, job: dict[str, Any]) -> None:
        if job_id in self._provider_attachment_jobs:
            return
        self._provider_attachment_jobs.add(job_id)
        result_json = job.get("result_json")
        if not isinstance(result_json, dict) or not isinstance(result_json.get("responses"), list):
            return
        job_provider = self._safe_metadata(job.get("provider")) or self._safe_metadata(result_json.get("provider"))
        for response in result_json["responses"][:64]:
            if not isinstance(response, dict) or response.get("action") != "file.upload":
                continue
            result = response.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("attachments"), list):
                continue
            action_metadata = self._provider_action_metadata(response.get("metadata"))
            provider = self._safe_metadata(response.get("provider")) or self._safe_metadata(action_metadata.get("provider")) or job_provider
            acceptance = result.get("acceptance") == "accepted"
            visible_proof = self._safe_metadata(result.get("visibleProof"))
            for uploaded in result["attachments"][:100]:
                if not isinstance(uploaded, dict) or uploaded.get("visible") is not True:
                    continue
                digest = uploaded.get("sha256")
                if isinstance(digest, str) and digest.startswith("sha256:"):
                    digest = digest.removeprefix("sha256:")
                if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
                    continue
                size = uploaded.get("size")
                for attachment_ref, evidence in self._attachment_evidence.items():
                    if evidence.get("sha256") != digest or evidence.get("byteLength") != size:
                        continue
                    upload = evidence.get("providerUpload")
                    if not isinstance(upload, dict) or upload.get("observed") is True:
                        continue
                    accepted = acceptance and visible_proof is not None
                    evidence["providerUpload"] = {
                        "observed": True,
                        "accepted": accepted,
                        "jobId": job_id,
                        "provider": provider,
                        "actionIndex": action_metadata.get("actionIndex"),
                        "visibleProof": visible_proof,
                    }
                    evidence["upload"]["retained"] = accepted
                    evidence["outcome"] = "succeeded" if accepted else "unknown"
                    evidence["unknownReason"] = None if accepted else "provider_upload_acceptance_not_observed"
                    self._refresh_attachment_event(attachment_ref)
                    break

    def record_attachment_failure(
        self,
        body: bytes | None,
        *,
        name: str | None,
        media_type: str | None,
        operation: dict[str, Any],
        reason: str,
    ) -> None:
        finished_at = self._observed_at()
        finished_monotonic = time.monotonic()
        payload = body or b""
        evidence = {
            "stage": "host_attachment_store",
            "stored": False,
            "attachmentRef": None,
            "name": name,
            "mediaType": media_type,
            "byteLength": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "declaredByteLength": None,
            "declaredSha256": None,
            "upload": {"requested": True, "returned": False, "retained": False},
            "providerUpload": {
                "observed": False,
                "accepted": None,
                "jobId": None,
                "provider": None,
                "actionIndex": None,
                "visibleProof": None,
            },
            "outcome": "failed",
            "unknownReason": reason,
            "startedAt": operation.get("startedAt", finished_at),
            "finishedAt": finished_at,
            "durationMs": self._duration_ms(
                operation.get("startedMonotonic", finished_monotonic),
                finished_monotonic,
            ),
        }
        self.record_event({"type": "provider.attachment", **evidence})

    def record_child_turn_input(
        self,
        turn_ref: str,
        prompt_text: str,
        attachment_refs: list[str],
    ) -> None:
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
                or value.get("provider") != self.expected_provider
                or value.get("profileId") != self.expected_profile
            ):
                raise ValueError("provider binding does not match the selected provider and profile")
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
            stage = self._provider_request_stages.get(request_ref)
            if stage is None:
                raise ValueError("provider request reference is unknown")
            if stage == "bootstrap" and self._continuation_turn_ref is not None:
                raise ValueError("provider request cancellation is out of sequence")
            turn_ref = self._provider_request_turn_refs.get(request_ref)
            if turn_ref is None or turn_ref != self._turn_ref_for_stage(stage):
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
            if self._provider_binding_ref is not None:
                raise ValueError("provider binding response was duplicated")
            self._provider_binding_ref = binding_ref
            self._provider_ref = provider_ref
            return
        if kind == "capabilities":
            self._parse_binding_response(body, expected_binding_ref=operation["bindingRef"], expected_provider_ref=self._provider_ref)
            return
        if kind == "attachment":
            return self._parse_attachment_response(body)
        if kind == "start":
            turn = self._parse_turn_response(
                body,
                expected_request_ref=operation["requestRef"],
                expected_provider_ref=operation["providerRef"],
                expected_binding_ref=operation["providerBindingRef"],
                expected_conversation_ref=operation.get("conversationRef"),
            )
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
            self._apply_turn_lifecycle(mode, turn["lifecycle"])
            return {
                "turnRef": turn["turnRef"],
                "requestRef": turn["requestRef"],
                "conversationRef": turn["conversationRef"],
                "lifecycle": turn["lifecycle"],
            }
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
            if self._provider_turn_refs.get(operation["turnRef"]) != stage:
                raise ValueError("provider turn response reference changed")
            self._apply_turn_lifecycle(stage, turn["lifecycle"])
            return {"turnRef": turn["turnRef"]}
        if kind == "request_cancel":
            turn = self._parse_request_cancellation_response(body)
            if turn["turnRef"] != operation["turnRef"] or turn["conversationRef"] != self._conversation_ref_for_stage(operation["stage"]):
                raise ValueError("provider request cancellation identity changed")
            if self._provider_request_stages.get(operation["requestRef"]) != operation["stage"]:
                raise ValueError("provider request cancellation reference changed")
            self._apply_turn_lifecycle(operation["stage"], "cancelled")
            return
        raise ValueError("provider turn operation is invalid")

    def _tracked_turn_operation(self, kind: str, turn_ref: str) -> dict[str, Any]:
        if not PROVIDER_TURN_REF_PATTERN.fullmatch(turn_ref):
            raise ValueError("provider turn reference is invalid")
        stage = self._provider_turn_refs.get(turn_ref)
        if stage is None:
            raise ValueError("provider turn reference is unknown")
        if kind == "turn_cancel" and stage == "bootstrap" and self._continuation_turn_ref is not None:
            raise ValueError("provider turn cancellation is out of sequence")
        if turn_ref != self._turn_ref_for_stage(stage):
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

    def decorate_parent_completion_body(
        self, body: bytes | None, audit_sequence: int | None = None
    ) -> bytes:
        value = self._json_object(body)
        if value.get("model") != f"tokenless/{self.expected_provider}":
            raise ValueError("DSH parent completion must use the selected Tokenless API model")
        tokenless = value.get("tokenless")
        if tokenless is None:
            tokenless = {}
        if not isinstance(tokenless, dict):
            raise ValueError("DSH parent tokenless options are invalid")
        tokenless = dict(tokenless)
        tokenless["profile"] = self.expected_profile
        if self.expected_provider == "auto":
            tokenless["semantic_preference"] = self.semantic_preference
        tokenless["submission_evidence"] = "benchmark"
        value["tokenless"] = tokenless
        if self.final_only_parent_completion_due():
            value["tool_choice"] = "none"
            if audit_sequence is not None:
                self.mark_parent_completion_final_only(audit_sequence)
        return json.dumps(value, separators=(",", ":")).encode("utf-8")

    def decorate_bootstrap_body(self, body: bytes | None) -> bytes:
        value = self._json_object(body)
        if self.expected_provider == "auto":
            value["semanticPreference"] = self.semantic_preference
        value["submissionEvidence"] = "benchmark"
        return json.dumps(value, separators=(",", ":")).encode("utf-8")

    def decorate_provider_turn_body(self, body: bytes | None) -> bytes:
        value = self._json_object(body)
        value["submissionEvidence"] = "benchmark"
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
        optional_keys = {"submissionEvidence"}
        if mode == "new":
            optional_keys.add("semanticPreference")
        if (
            not expected_keys.issubset(value)
            or not set(value).issubset(expected_keys | optional_keys)
        ):
            raise ValueError("provider turn start shape is invalid")
        if "submissionEvidence" in value and value["submissionEvidence"] != "benchmark":
            raise ValueError("provider turn submission evidence is invalid")
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
    def _parse_attachment_response(cls, body: bytes) -> dict[str, Any]:
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
        return {
            "attachmentRef": attachment["attachmentRef"],
            "mediaType": attachment["mediaType"],
            "byteLength": attachment["byteLength"],
            "sha256": attachment["sha256"],
        }

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

    def _apply_turn_lifecycle(self, stage: str, lifecycle: str) -> None:
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

    def _turn_ref_for_stage(self, stage: str) -> str:
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
        exclusions_header = upstream.getheader("X-Tokenless-Route-Exclusions")
        if exclusions_header is None:
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
            exclusions_value = json.loads(exclusions_header)
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
            or not isinstance(exclusions_value, list)
            or len(exclusions_value) > 64
            or any(
                not isinstance(exclusion, dict)
                or set(exclusion) != {"provider", "category", "reason"}
                or not isinstance(exclusion.get("provider"), str)
                or PROVIDER_ID_PATTERN.fullmatch(exclusion["provider"]) is None
                or not isinstance(exclusion.get("category"), str)
                or exclusion.get("category") not in {"access", "runtime", "capability"}
                or not isinstance(exclusion.get("reason"), str)
                or exclusion.get("reason") not in {
                    "provider_not_supported",
                    "provider_mode_disabled",
                    "provider_not_evaluated",
                    "provider_access_unknown",
                    "provider_access_sign_in_required",
                    "provider_access_account_blocked",
                    "provider_access_unavailable",
                    "missing_conversation_capability",
                    "missing_structured_control_capability",
                    "capability_route_unavailable",
                }
                for exclusion in exclusions_value
            )
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
                    "captcha",
                    "unreachable",
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
                    "visibleProof" in attempt
                    and attempt.get("reason") not in {"rate_limit", "capacity", "auth", "captcha", "unreachable"}
                )
                or (
                    any(key in attempt for key in {"limitWindow", "retryAfterSeconds"})
                    and attempt.get("reason") not in {"rate_limit", "capacity", "captcha", "unreachable"}
                )
                or attempt.get("reason") == "captcha"
                and "visibleProof" not in attempt
            ):
                return None
            attempts.append(dict(attempt))
        return {
            "mode": mode,
            "provider": provider,
            "fallbackProviders": fallback_providers,
            "exclusions": exclusions_value,
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
        *,
        interaction_id: str | None = None,
        started_at: str | None = None,
        started_monotonic: float | None = None,
        response_body: bytes | None = None,
    ) -> None:
        route = self._parse_route_headers(upstream)
        if route is None:
            observed_at = self._observed_at()
            finished_monotonic = time.monotonic()
            interaction = (
                self._parent_interactions.get(interaction_id)
                if interaction_id is not None and scope == "parent"
                else None
            )
            resolved_started_at = started_at or (
                interaction.get("startedAt") if interaction else observed_at
            )
            resolved_started_monotonic = started_monotonic or (
                interaction.get("startedMonotonic")
                if interaction
                else finished_monotonic
            )
            if scope == "parent" and interaction_id is not None:
                self._complete_parent_interaction(
                    interaction_id,
                    response_body or b"",
                    "failed",
                    observed_at,
                    finished_monotonic,
                )
            self.record_event(
                {
                    "type": "provider.routing.invalid",
                    "reason": f"{scope}_route_metadata",
                    "interactionId": interaction_id,
                    "scope": scope,
                    "startedAt": resolved_started_at,
                    "finishedAt": observed_at,
                    "durationMs": self._duration_ms(
                        resolved_started_monotonic, finished_monotonic
                    ),
                    "outcome": "failed",
                    "executionMetadata": self._provider_execution_metadata(upstream),
                }
            )
            return
        outcome = "completed" if upstream.status < 400 else "failed"
        if outcome == "completed" and route["rateLimited"]:
            if scope == "parent" and interaction_id is not None:
                self._complete_parent_interaction(
                    interaction_id,
                    response_body or b"",
                    "failed",
                    self._observed_at(),
                    time.monotonic(),
                )
            self.record_event(
                {
                    "type": "provider.routing.invalid",
                    "reason": "rate_limit_attribution",
                    "interactionId": interaction_id,
                    "scope": scope,
                    "outcome": "failed",
                }
            )
            return
        observed_at = self._observed_at()
        finished_monotonic = time.monotonic()
        interaction = (
            self._parent_interactions.get(interaction_id)
            if interaction_id is not None and scope == "parent"
            else None
        )
        resolved_started_at = started_at or (
            interaction.get("startedAt") if interaction else observed_at
        )
        resolved_started_monotonic = started_monotonic or (
            interaction.get("startedMonotonic")
            if interaction
            else finished_monotonic
        )
        tools = []
        if scope == "parent" and interaction_id is not None and response_body is not None:
            tools = self._complete_parent_interaction(
                interaction_id,
                response_body,
                outcome,
                observed_at,
                finished_monotonic,
            )
        self.record_event(
            {
                "type": "provider.routing",
                "observedAt": observed_at,
                "scope": scope,
                "interactionId": interaction_id,
                "startedAt": resolved_started_at,
                "finishedAt": observed_at,
                "durationMs": self._duration_ms(
                    resolved_started_monotonic, finished_monotonic
                ),
                **route,
                "outcome": outcome,
                "executionMetadata": self._provider_execution_metadata(upstream),
                "tools": tools,
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
        self,
        path: str,
        upstream: http.client.HTTPResponse,
        body: bytes,
        *,
        operation: dict[str, Any],
    ) -> None:
        outcome = upstream.getheader("X-Tokenless-Route-Outcome")
        route = self._parse_route_headers(upstream)
        turn_ref = unquote(path.rsplit("/", 1)[-1])
        interaction = self._child_interactions.get(turn_ref)
        interaction_id = (
            interaction.get("interactionId")
            if interaction is not None
            else f"child:{turn_ref.removeprefix('turn:')}"
        )
        if outcome not in {"pending", "completed", "failed"} or route is None:
            with self._audit_lock:
                if path in self._provider_turn_route_refs:
                    return
                self._provider_turn_route_refs.add(path)
            self.record_event(
                {
                    "type": "provider.routing.invalid",
                    "reason": "route_outcome" if outcome not in {"pending", "completed", "failed"} else "route_metadata",
                    "interactionId": interaction_id,
                    "scope": "child",
                    "turnRef": turn_ref,
                    "requestRef": self._provider_turn_request_refs.get(turn_ref),
                    "outcome": "failed",
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
        input_text = self._child_turn_input_text.pop(turn_ref, None)
        if input_text is None:
            self.record_event(
                {"type": "provider.routing.invalid", "reason": "child_token_input"}
            )
            return
        output_text = self._provider_turn_output_text(body) if outcome == "completed" else ""
        observed_at = self._observed_at()
        finished_monotonic = time.monotonic()
        interaction = self._child_interactions.get(turn_ref)
        started_at = interaction.get("startedAt") if interaction else operation.get("startedAt", observed_at)
        started_monotonic = interaction.get("startedMonotonic") if interaction else operation.get("startedMonotonic", finished_monotonic)
        interaction_id = interaction.get("interactionId") if interaction else f"child:{turn_ref.removeprefix('turn:')}"
        tools = self._record_child_response_tools(turn_ref, body, observed_at)
        if interaction is not None:
            interaction["finishedAt"] = observed_at
            interaction["durationMs"] = self._duration_ms(started_monotonic, finished_monotonic)
            interaction["outcome"] = outcome
        self.record_event(
            {
                "type": "provider.routing",
                "observedAt": observed_at,
                "scope": "child",
                "interactionId": interaction_id,
                "requestRef": self._provider_turn_request_refs.get(turn_ref),
                "turnRef": turn_ref,
                "startedAt": started_at,
                "finishedAt": observed_at,
                "durationMs": self._duration_ms(started_monotonic, finished_monotonic),
                **route,
                "outcome": outcome,
                "executionMetadata": self._provider_execution_metadata(upstream),
                "tools": tools,
                "toolResponseStatus": interaction.get("toolResponseStatus", "unavailable") if interaction else "unavailable",
                "toolResponseNormalizationApplied": interaction.get("toolResponseNormalizationApplied") if interaction else None,
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

    @classmethod
    def _completion_tool_calls(cls, body: bytes) -> list[dict[str, Any]]:
        """Extract only metadata for tool calls from an OpenAI response."""
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            return []
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
                return []
            if isinstance(value, dict):
                payloads.append(value)
        calls: dict[str, dict[str, Any]] = {}
        stream_ids: dict[int, str] = {}
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
                tool_calls = message.get("tool_calls")
                if not isinstance(tool_calls, list):
                    continue
                for index, tool_call in enumerate(tool_calls):
                    if not isinstance(tool_call, dict):
                        continue
                    call_id = cls._tool_call_id(tool_call.get("id"))
                    if call_id is None:
                        raw_index = tool_call.get("index", index)
                        if not isinstance(raw_index, int) or isinstance(raw_index, bool):
                            continue
                        call_id = stream_ids.get(raw_index)
                        if call_id is None:
                            continue
                    else:
                        raw_index = tool_call.get("index", index)
                        if isinstance(raw_index, int) and not isinstance(raw_index, bool):
                            stream_ids[raw_index] = call_id
                    function = tool_call.get("function")
                    if not isinstance(function, dict):
                        continue
                    record = calls.setdefault(
                        call_id,
                        {
                            "callId": call_id,
                            "toolName": None,
                            "argumentsText": "",
                        },
                    )
                    name = cls._tool_name(function.get("name"))
                    if name is not None:
                        record["toolName"] = name
                    arguments = function.get("arguments")
                    if isinstance(arguments, str):
                        record["argumentsText"] += arguments
        result = []
        for call_id, record in calls.items():
            result.append(
                {
                    "callId": call_id,
                    "toolName": record["toolName"],
                    "arguments": cls._digest_summary(record["argumentsText"]),
                }
            )
        return result


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
                provider_operation["startedAt"] = self.server._observed_at()  # type: ignore[attr-defined]
                provider_operation["startedMonotonic"] = time.monotonic()
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
            elif provider_operation["kind"] == "start":
                try:
                    body = self.server.decorate_provider_turn_body(body)  # type: ignore[attr-defined]
                except ValueError:
                    provider_control_lock.release()
                    self.send_error(400)
                    return
        subagent_claimed = False
        subagent_claim_settled = False
        parent_event_sequence = None
        parent_ordinal = None
        if path in ALLOWED_COMPLETION_PATHS and self.command == "POST":
            parent_event_sequence, parent_ordinal = self.server.record_parent_completion_request(body)  # type: ignore[attr-defined]
            try:
                body = self.server.decorate_parent_completion_body(  # type: ignore[attr-defined]
                    body, parent_event_sequence
                )
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
                self.server.refresh_parent_completion_request(  # type: ignore[attr-defined]
                    parent_event_sequence, body
                )
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                self.server.record_parent_transport_failure(  # type: ignore[attr-defined]
                    parent_event_sequence, "request_decoration_validation"
                )
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
        provider_operation_failure_recorded = False
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            upstream = connection.getresponse()
            control_body = None
            parent_error_body = None
            parent_route_recorded = False
            committed_provider_turn = None
            if provider_operation is not None:
                control_body = self._read_bounded_response(upstream)
                committed_provider_turn = self.server.commit_provider_turn_response(  # type: ignore[attr-defined]
                    provider_operation, upstream.status, control_body
                )
                if (
                    provider_operation["kind"] == "attachment"
                    and upstream.status >= 400
                ):
                    self.server.record_attachment_failure(  # type: ignore[attr-defined]
                        body,
                        name=self.headers.get("X-Tokenless-Attachment-Name"),
                        media_type=self.headers.get("Content-Type"),
                        operation=provider_operation,
                        reason=f"provider_http_{upstream.status}",
                    )
                    provider_operation_failure_recorded = True
                if (
                    provider_operation["kind"] == "attachment"
                    and committed_provider_turn is not None
                    and body is not None
                ):
                    self.server.record_attachment_text(  # type: ignore[attr-defined]
                        committed_provider_turn["attachmentRef"],
                        body,
                        name=self.headers.get("X-Tokenless-Attachment-Name"),
                        media_type=self.headers.get("Content-Type"),
                        returned=committed_provider_turn,
                        started_at=provider_operation.get("startedAt"),
                        started_monotonic=provider_operation.get("startedMonotonic"),
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
                if provider_operation["kind"] == "start" and upstream.status >= 400:
                    self.server.record_child_turn_failed(  # type: ignore[attr-defined]
                        provider_operation, upstream.status
                    )
                    provider_operation_failure_recorded = True
            elif (
                path in ALLOWED_COMPLETION_PATHS
                and self.command == "POST"
                and upstream.status >= 400
            ):
                parent_error_body = self._read_bounded_response(upstream)
                self.server.record_upstream_route(  # type: ignore[attr-defined]
                    upstream,
                    "parent",
                    (body or b"").decode("utf-8"),
                    "",
                    interaction_id=self.server.parent_interaction_id(parent_event_sequence),  # type: ignore[attr-defined]
                    response_body=parent_error_body,
                )
                parent_route_recorded = True
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
            elif parent_error_body is not None:
                self.send_header("Content-Length", str(len(parent_error_body)))
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
                        path,
                        upstream,
                        control_body or b"",
                        operation=provider_operation,
                    )
                if provider_operation["kind"] == "start" and upstream.status < 400:
                    self.server.record_child_turn_started(  # type: ignore[attr-defined]
                        provider_operation,
                        committed_provider_turn,
                        control_body or b"",
                    )
            elif parent_error_body is not None:
                self.wfile.write(parent_error_body)
                self.wfile.flush()
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
                if (
                    path in ALLOWED_COMPLETION_PATHS
                    and self.command == "POST"
                    and not parent_route_recorded
                ):
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
                        interaction_id=self.server.parent_interaction_id(parent_event_sequence),  # type: ignore[attr-defined]
                        response_body=(
                            bytes(relayed_body) if relayed_body_complete else None
                        ),
                    )
        except ValueError:
            if provider_operation is not None and not provider_operation_failure_recorded:
                if provider_operation["kind"] == "attachment":
                    self.server.record_attachment_failure(  # type: ignore[attr-defined]
                        body,
                        name=self.headers.get("X-Tokenless-Attachment-Name"),
                        media_type=self.headers.get("Content-Type"),
                        operation=provider_operation,
                        reason="bridge_response_validation",
                    )
                elif provider_operation["kind"] == "start":
                    self.server.record_child_turn_failed(  # type: ignore[attr-defined]
                        provider_operation, 502
                    )
            if path in ALLOWED_COMPLETION_PATHS and self.command == "POST":
                self.server.record_parent_transport_failure(  # type: ignore[attr-defined]
                    parent_event_sequence, "bridge_response_validation"
                )
            self.close_connection = True
            self.send_error(502)
        except (OSError, http.client.HTTPException):
            if provider_operation is not None and not provider_operation_failure_recorded:
                if provider_operation["kind"] == "attachment":
                    self.server.record_attachment_failure(  # type: ignore[attr-defined]
                        body,
                        name=self.headers.get("X-Tokenless-Attachment-Name"),
                        media_type=self.headers.get("Content-Type"),
                        operation=provider_operation,
                        reason="upstream_transport_error",
                    )
                elif provider_operation["kind"] == "start":
                    self.server.record_child_turn_failed(  # type: ignore[attr-defined]
                        provider_operation, 502
                    )
            if path in ALLOWED_COMPLETION_PATHS and self.command == "POST":
                self.server.record_parent_transport_failure(  # type: ignore[attr-defined]
                    parent_event_sequence, "upstream_transport_error"
                )
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
            raise ValueError("Select the provider through the Harbor model_name, not a provider kwarg.")
        super().__init__(*args, **kwargs)
        model = self.model_name or "tokenless/auto"
        if not model.startswith("tokenless/") or PROVIDER_ID_PATTERN.fullmatch(model[10:]) is None:
            raise ValueError("Terminal-Bench model_name must be tokenless/auto or tokenless/<provider>.")
        self.provider = model[10:]

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
        task = json.loads((self.logs_dir.parent / "config.json").read_text())["task"]
        name = task["name"].removeprefix("terminal-bench/")
        task_refs = json.loads(self.task_manifest.read_text())["taskRefs"]
        if (
            name not in self._manifest
            or task["name"] != f"terminal-bench/{name}"
            or task.get("ref") != task_refs[name]
        ):
            raise ValueError("The Harbor task is not in the pinned Terminal-Bench 4.0 dataset.")
        instruction_path = (
            PACKAGE_CACHE_DIR / "terminal-bench" / name
            / task_refs[name].removeprefix("sha256:") / "instruction.md"
        )
        raw_instruction = instruction_path.read_text(encoding="utf-8")
        digest = "sha256:" + hashlib.sha256(raw_instruction.encode("utf-8")).hexdigest()
        if digest != self._manifest[name] or instruction != strip_canary(raw_instruction):
            raise ValueError("The Harbor instruction is not one of the pinned Terminal-Bench 4.0 task instructions.")
        semantic = self._semantic_manifest.get(digest)
        if semantic is None:
            raise ValueError("The Harbor instruction has no semantic preference in the pinned manifest.")
        if semantic["truncated"] != (len(raw_instruction) > 4_000):
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
            "/installed-agent/terminal-bench-4-manifest.json",
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
        model = f"tokenless/{self.provider}"
        patch = "\n".join(
            [
                "- id: system-prompt",
                "  config:",
                "    persona: >-",
                "      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}. Start each user task with exactly one read tool call to inspect the most relevant workspace file without changing it. Then call subagent exactly once with a self-contained request to inspect the current workspace with its tools and return concrete task-relevant analysis. Wait for that result and use it only as input. Then use your own tools to complete the requested workspace changes and verify the observable result. Batch independent permitted changes into one edit or terminal command and verify them together. When a task has a finite set of allowed changes and a local verifier, use one terminal script to search the allowed candidates, run the verifier, and keep a passing workspace state; do not alternate one candidate edit and one verifier call across model turns. Before the first candidate, the script itself must set one monotonic deadline and one total verifier counter. It must increment that counter for every verifier execution, including any final verification, stop cleanly at the deadline or at 64 total executions, track the best candidate using a numeric verifier-derived result, and preserve that best candidate. Never enumerate a power set, never use a loop whose upper bound is the full candidate count, and never launch a second search. If the bounded search does not pass, perform one final verification only when that same counter and deadline still permit it, then continue with the preserved best candidate. Keep any temporary search machinery outside protected workspace files and apply only task-permitted workspace changes. Never stop at analysis, instructions for the user, or a claim of success without executing the task. Do not delegate more than once.",
                "      For a Git recovery task, use .git/HEAD for the required first read instead of guessing a project manifest. If the subagent fails or its evidence is incomplete, continue with your own tools. A clean working tree, branch list, or stash list does not prove lost Git work is absent: inspect reflogs and candidate commits before concluding. Once a candidate commit is identified, your next response must be a tool call to bash, not a final response: use bash to merge or cherry-pick it into master and verify the resulting files and Git state. If the cherry-pick conflicts, the recovered candidate is the --theirs side and current master is --ours. The next response must call bash to run git checkout --theirs for every unmerged path, stage those paths, run GIT_EDITOR=true git cherry-pick --continue rather than git commit, and verify git status --short is empty. Never use --ours for a lost-change recovery conflict. Reading a conflicted file does not resolve it, and a final response before bash has completed these steps is invalid.",
                "      When task mutations are constrained by a machine-readable allowlist or mapping, first copy and preserve the original, parse that allowlist, construct every candidate exclusively from its permitted transformations, validate the entire candidate against the original and allowlist before any metric or verifier, and never use model-inferred equivalents. If every allowlist or mapping entry is a single whitespace token, validation must also preserve the original whitespace-token count and compare positions: unchanged tokens must be exactly identical, and each changed token must belong to the parsed family of the original token. Reject any violation before the metric or verifier and never retain that candidate as the best or final candidate. Use only validated task-permitted candidates as the best and final candidate.",
                "      The final verification must run the complete task-provided verifier or test suite within the same deadline and counter, not merely a proxy metric. If it exposes a constraint violation, restore or correct from a validated candidate within the remaining budget; never launch a second search.",
                "- id: bash-sandbox",
                "  config:",
                "    timeoutMs: 120000",
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
                f"        provider: {self.provider}",
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
            self.provider,
        )
        bridge_thread = threading.Thread(
            target=bridge.serve_forever,
            kwargs={"poll_interval": 0.2},
            daemon=True,
        )
        bridge_thread.start()
        bridge_port = int(bridge.server_address[1])
        dsh_outcome = "failed"
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
                dsh_outcome = "succeeded"
            except NonZeroAgentExitCodeError:
                self._write_dsh_classification(
                    "dsh_nonzero_exit", NonZeroAgentExitCodeError.__name__
                )
            except Exception as error:
                self._write_dsh_classification(
                    "dsh_execution_error", type(error).__name__
                )
                raise
        finally:
            try:
                bridge.record_event(
                    {"type": "dsh.parent.completed", "outcome": dsh_outcome}
                )
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
            "model": f"tokenless/{self.provider}",
            "routingMode": "auto" if self.provider == "auto" else "fixed",
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
