# Tokenless CLI

`tokenless` is the daemon-only, agent-facing entrypoint for using a visible ChatGPT, Claude, or Gemini session without exporting provider credentials or calling hidden provider APIs.

## Install

```bash
npx tokenless setup
```

First install and enable the Tokenless extension in the Chromium browser that will hold your provider session. Then `npx tokenless setup` installs the local runtime, registers the Native Messaging host for one detected browser, opens the selected provider page when needed, and succeeds only after the extension bridge is live. Sign in to the provider in that visible page if prompted. Install globally with `npm install -g tokenless` only if you prefer the shorter `tokenless` command. `tokenless install` remains available when you only want to provision the local runtime without activating the browser bridge.

The universal package contains JavaScript only and declares exact-version optional native packages for darwin/linux on arm64/x64 and win32 on arm64/x64. npm installs only the matching package, which contains `tokenless-daemon` and `tokenless-native-host`; publisher-side prepack verification requires each executable to report the exact role, package version, and normalized target tuple before packing. No install hook or normal command downloads or verifies an executable, and users do not need Rust. The published extension id is bundled; pass `--extension-id <id>` only for an unpacked or alternate extension build.

Configure defaults:

```bash
tokenless config --preferred-providers chatgpt,claude,gemini --browser chrome --json
```

## Agent Workflow

```bash
npx tokenless run \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --json
```

`run` requires no extension id after setup. It starts the Rust daemon when needed. If the extension bridge is live, the CLI does not pre-open a wake tab; otherwise it opens only the selected provider's validated HTTPS UI in the configured Chromium browser. The extension reuses an approved provider tab when possible or opens one provider tab when necessary. ChatGPT is the provider default. Tokenless never opens a task page, extension page, local file, runner, settings, or history page.

## ChatGPT visible controls

ChatGPT runs enforce the visible `Chat` surface before submission. Use the visible control inventory to discover what the signed-in account currently exposes:

```bash
npx tokenless chatgpt-controls --json
```

Configure a new ChatGPT turn or attach the same controls to `run`:

```bash
npx tokenless chatgpt-configure \
  --model "GPT-5.6 Sol" \
  --model-fallback "GPT-5.5,o3" \
  --effort pro \
  --json

npx tokenless run \
  --provider chatgpt \
  --model "GPT-5.6 Sol" \
  --model-fallback "GPT-5.5,o3" \
  --effort extra_high \
  --prompt "Review this design." \
  --json
```

`--effort` accepts `instant`, `medium`, `high`, `extra_high`, or `pro`. Tokenless uses visible DOM roles and selected state, not provider APIs or browser storage. When a requested model is absent it tries `--model-fallback` in order, then preserves the visible current model. When a complete five-level Intelligence menu is visible it selects the strongest available level at or below the requested level; incomplete or unlabelled menus preserve the current setting rather than guessing. In all non-safety control fallbacks, the prompt is still submitted.

For a visible provider task expected to take longer than three minutes, add `--long-running`. It extends the visible-response wait to 35 minutes and the daemon job wait to 36 minutes. Progress heartbeats are written to stderr so `--json` keeps stdout machine-readable. Do not use `--no-wait` for this mode.

Use returned task ids to inspect daemon-backed state:

```bash
npx tokenless state --task-id "project:Website redesign:chat:Navbar review" --json
```

Cancel a job only through daemon-confirmed cancellation:

```bash
npx tokenless cancel --job-id "<job-id>" --json
```

If explicit cancellation or SIGINT/SIGTERM cannot be confirmed before the bounded cancel-request deadline, the CLI exits nonzero with `job_cancel_failed` and warns that the job may continue. `--cancel-timeout-ms` can shorten that deadline for automation.

Capture a sanitized visible-page DOM snapshot through the same path:

```bash
npx tokenless snapshot-dom --provider chatgpt --json
```

`--no-open` requires an already-live bridge and fails before queueing otherwise. `--no-daemon` and local task-page fallback do not exist.

## Boundary

Tokenless uses only visible provider DOM after user-granted extension permission. It does not read provider cookies, localStorage/sessionStorage tokens, hidden auth headers, or private backend APIs. Daemon access is loopback-only. Before every bearer-authenticated job call, the CLI verifies a fresh challenge-bound `/ready` HMAC proof covering both protocols and canonical home; an unproved listener never receives the token. `doctor` refreshes installed binaries before reading config or running checks and exits nonzero when any reported check fails.
