"""Tokenless scaffold adapter for the pinned FeatureBench inference runner."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile

from featurebench.infer.agents.base import BaseAgent


class TokenlessAgent(BaseAgent):
    """Run the built Tokenless agent runtime inside the official task container."""

    NODE_VERSION = "22"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._instance_id: str | None = None

    @property
    def name(self) -> str:
        return "tokenless"

    @property
    def install_script(self) -> str:
        return f"""#!/bin/bash
set -euo pipefail

PACKAGE="${{TOKENLESS_FEATUREBENCH_PACKAGE:-}}"
if [ -z "$PACKAGE" ] || [ ! -f "$PACKAGE" ]; then
  echo "TOKENLESS_FEATUREBENCH_PACKAGE must name the built Tokenless package mounted under /download" >&2
  exit 1
fi

apt-get update
apt-get install -y curl ca-certificates tar xz-utils

export NVM_DIR="/opt/featurebench/tokenless-nvm"
mkdir -p "$NVM_DIR" "$NVM_DIR/.cache"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | env NVM_DIR="$NVM_DIR" bash
fi
. "$NVM_DIR/nvm.sh"
nvm install "{self.NODE_VERSION}"
nvm use "{self.NODE_VERSION}"

npm install -g "$PACKAGE"
tokenless --version
"""

    def pre_run_setup(self, container, instance, log_file) -> bool:
        self._instance_id = instance.instance_id
        channel = self._issue_channel(instance.instance_id)
        channel_host = os.environ.get(
            "TOKENLESS_FEATUREBENCH_CHANNEL_HOST",
            "host.docker.internal",
        ).strip()
        if not channel_host or any(char in channel_host for char in "/?#"):
            raise RuntimeError("TOKENLESS_FEATUREBENCH_CHANNEL_HOST is invalid")
        channel["endpoint"] = (
            f"http://{channel_host}:{int(channel['bridgePort'])}"
            "/v1/private/featurebench/turn"
        )
        channel.pop("bridgePort", None)
        channel.pop("daemonUrl", None)
        channel.pop("ok", None)

        self.cm.exec_command(
            container,
            "mkdir -p /agent-logs /tmp/tokenless-featurebench-tools && "
            "chown -R 65534:65534 /testbed /tmp/tokenless-featurebench-tools",
            log_file=log_file,
        )
        self._copy_json(container, channel, "/installed-agent/featurebench-channel.json")
        self.cm.exec_command(
            container,
            "chmod 600 /installed-agent/featurebench-channel.json",
            log_file=log_file,
        )
        return True

    def prepare_run(self, container, instruction: str, log_file: Path) -> bool:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".md",
            delete=False,
        ) as handle:
            handle.write(instruction)
            source = Path(handle.name)
        try:
            self.cm.copy_to_container(
                container,
                source,
                "/installed-agent/featurebench-instruction.md",
            )
            return True
        finally:
            source.unlink(missing_ok=True)

    def get_run_command(self, instruction: str) -> str:
        max_steps = self._integer_env("TOKENLESS_FEATUREBENCH_MAX_STEPS", 40, 1, 200)
        tool_timeout_ms = self._integer_env(
            "TOKENLESS_FEATUREBENCH_TOOL_TIMEOUT_MS",
            120000,
            1000,
            1800000,
        )
        return (
            "export NVM_DIR=/opt/featurebench/tokenless-nvm; "
            ". \"$NVM_DIR/nvm.sh\"; "
            "tokenless featurebench run "
            "--channel-file /installed-agent/featurebench-channel.json "
            "--instruction-file /installed-agent/featurebench-instruction.md "
            "--workspace /testbed "
            "--events-file /agent-logs/tokenless-events.jsonl "
            f"--max-steps {max_steps} "
            f"--tool-timeout-ms {tool_timeout_ms} "
            "--json"
        )

    def post_run_hook(self, container, log_file: Path) -> bool:
        destination = Path(log_file).parent / "tokenless-events.jsonl"
        try:
            self.cm.copy_from_container(
                container,
                "/agent-logs/tokenless-events.jsonl",
                destination,
            )
        except Exception as error:
            self.logger.error("Tokenless events were not collected: %s", error)
            return False
        try:
            last = next(
                line.strip()
                for line in reversed(destination.read_text(encoding="utf-8").splitlines())
                if line.strip()
            )
            event = json.loads(last)
            return event.get("type") == "run.completed"
        except Exception as error:
            self.logger.error("Tokenless completion event is invalid: %s", error)
            return False

    def failure_hook(self, container, log_file: Path) -> None:
        try:
            self.cm.copy_from_container(
                container,
                "/agent-logs/tokenless-events.jsonl",
                Path(log_file).parent / "tokenless-events.jsonl",
            )
        except Exception:
            pass

    def _issue_channel(self, instance_id: str) -> dict:
        node = self._required_host_env("TOKENLESS_FEATUREBENCH_HOST_NODE", "node")
        cli = self._required_host_env("TOKENLESS_FEATUREBENCH_HOST_CLI")
        home = self._required_host_env("TOKENLESS_FEATUREBENCH_HOST_HOME")
        host_cwd = os.environ.get(
            "TOKENLESS_FEATUREBENCH_HOST_CWD",
            str(Path(cli).resolve().parent),
        ).strip()
        run_id = self._required_host_env("TOKENLESS_FEATUREBENCH_RUN_ID")
        provider = self._required_agent_env("TOKENLESS_FEATUREBENCH_PROVIDER")
        execution_mode = self.env_vars.get(
            "TOKENLESS_FEATUREBENCH_EXECUTION_MODE",
            "browser",
        ).strip()
        model = str(self._kwargs.get("model") or "provider-default").strip()
        max_steps = self._integer_env("TOKENLESS_FEATUREBENCH_MAX_STEPS", 40, 1, 200)
        provider_turn_timeout_ms = self._integer_env(
            "TOKENLESS_FEATUREBENCH_PROVIDER_TURN_TIMEOUT_MS",
            600000,
            30000,
            1800000,
        )
        channel_lifetime_ms = self._integer_env(
            "TOKENLESS_FEATUREBENCH_CHANNEL_LIFETIME_MS",
            14400000,
            60000,
            86400000,
        )
        command = [
            node,
            cli,
            "featurebench",
            "issue-channel",
            "--home",
            home,
            "--instance-id",
            instance_id,
            "--benchmark-run-id",
            run_id,
            "--provider",
            provider,
            "--execution-mode",
            execution_mode,
            "--model",
            model,
            "--max-steps",
            str(max_steps),
            "--provider-turn-timeout-ms",
            str(provider_turn_timeout_ms),
            "--expires-in-ms",
            str(channel_lifetime_ms),
            "--json",
        ]
        optional_flags = [
            ("TOKENLESS_FEATUREBENCH_HOST_PROFILE", "--profile"),
            ("TOKENLESS_FEATUREBENCH_HOST_DAEMON_URL", "--daemon-url"),
        ]
        for environment_name, flag in optional_flags:
            value = os.environ.get(environment_name, "").strip()
            if value:
                command.extend([flag, value])
        effort = self.env_vars.get("TOKENLESS_FEATUREBENCH_EFFORT", "").strip()
        if effort:
            command.extend(["--effort", effort])

        completed = subprocess.run(
            command,
            cwd=host_cwd,
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )
        if completed.returncode != 0:
            detail = completed.stderr.strip().splitlines()[-1:] or ["unknown error"]
            raise RuntimeError(f"Tokenless channel issue failed: {detail[0][:500]}")
        try:
            channel = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("Tokenless channel issue returned invalid JSON") from error
        required = {
            "protocol",
            "channelId",
            "token",
            "bridgePort",
            "instanceId",
            "benchmarkCommit",
            "datasetRevision",
            "provider",
            "model",
            "executionMode",
            "maxTurns",
            "providerTurnTimeoutMs",
            "expiresAt",
        }
        if not isinstance(channel, dict) or not required.issubset(channel):
            raise RuntimeError("Tokenless channel issue returned an incomplete contract")
        return channel

    def _copy_json(self, container, value: dict, destination: str) -> None:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".json",
            delete=False,
        ) as handle:
            json.dump(value, handle, ensure_ascii=False)
            source = Path(handle.name)
        try:
            self.cm.copy_to_container(container, source, destination)
        finally:
            source.unlink(missing_ok=True)

    def _required_agent_env(self, name: str) -> str:
        value = self.env_vars.get(name, "").strip()
        if not value:
            raise RuntimeError(f"{name} is required")
        return value

    @staticmethod
    def _required_host_env(name: str, default: str | None = None) -> str:
        value = os.environ.get(name, default or "").strip()
        if not value:
            raise RuntimeError(f"{name} is required on the FeatureBench host")
        return value

    def _integer_env(self, name: str, default: int, minimum: int, maximum: int) -> int:
        raw = self.env_vars.get(name, str(default)).strip()
        try:
            value = int(raw)
        except ValueError as error:
            raise RuntimeError(f"{name} must be an integer") from error
        if value < minimum or value > maximum:
            raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
        return value
