# Tokenless CLI

`tokenless` gives agents provider-neutral CLI access to visible ChatGPT, Claude, Gemini, and Grok sessions. Qwen / 千问 is also available as an experimental guest-session provider. A local daemon, Playwright worker, and persistent managed browser profiles handle execution. A public local API is planned but is not a compatibility surface yet.

Complete command inventory: [English](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) | [中文](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md)

## Install

Requires Node.js 22.13+ and a supported Chromium browser such as Google Chrome or Brave.

```bash
npm install --global tokenless@latest
```

Tokenless must be installed globally before setup or agent use. Setup always
upserts and verifies both required global agent skills, checks the installed CLI
against the latest npm release, and leaves the matching local daemon running.

## Start

### Use an existing browser profile (recommended)

```bash
tokenless setup
```

The interactive flow chooses a browser and providers, discovers existing Chrome
or Brave profiles, asks for explicit copy consent, creates a separate managed
profile, reconciles and verifies the local daemon, and checks provider sign-in.
Ordinary daemon compatibility is based on authenticated same-home readiness and
the exact package version expected by the CLI. Setup also reconciles the verified
same-home installed daemon runtime back to the exact packaged runtime when needed.

### Start clean

```bash
tokenless setup --fresh
```

This non-interactive path creates a clean managed `default` profile on a new
installation or reuses the registered default, selects the first supported
browser and ChatGPT when needed, verifies the local runtime, and reports the
provider sign-in state once without opening a sign-in handoff. It does not
import a local browser profile.

Verify either path:

```bash
tokenless doctor --json
```

System-wide installer:

```bash
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

Because this executes with `sudo`, [review the installer source](https://github.com/jazelly/tokenless/blob/main/deploy/install.sh) first. Run setup afterward as the normal desktop user so the managed profile has the correct ownership.

## Managed Playwright Automation

`tokenless run` always submits a managed Playwright job through the authenticated local daemon.

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --workspace-mode auto \
  --project-root /path/to/project \
  --attach-file ./brief.pdf \
  --prompt "Review the navigation against this brief." \
  --json
```

The shared Playwright action contract covers:

- visible authentication and blocker checks;
- experimental subscription-aware capability inspection;
- exact-label model and effort inspection and selection;
- integrity-checked file upload with separate `selected` and visibly proven `accepted` outcomes;
- experimental Workspace ensure with explicit native-only or conversation fallback policy;
- prompt submission, correlated response reading, and visible citations;
- fail-closed navigation checks and sanitized structural snapshots.

Four-provider parity and end-to-end upload acceptance are still being completed. Qwen's experimental baseline covers guest prompt submission, response reading, and same-task conversation continuation; its unproven optional capabilities fail explicitly as unavailable or unknown.

`--project-name` continues to provide task identity only unless `--workspace-mode` is present. `auto` prefers a fixture-proven native Project and otherwise reports a conversation fallback, `native` fails when native creation is unverified or unavailable, and `conversation` requires the conversation strategy. Repeated `auto` or `conversation` runs with the same provider, profile, and task identity reuse only a trusted successful conversation URL.

Inspect all current provider capabilities with:

```bash
tokenless provider-action \
  --profile default \
  --provider chatgpt \
  --action capability.inspect \
  --json
```

Use the low-level Workspace action with `--action workspace.ensure --project-name <name> --workspace-mode <auto|native|conversation>`. Optional instructions can be supplied with `--project-instructions` or `--project-instructions-file`.

## Browser Visibility Policy

Tokenless stores browser visibility in config and defaults omitted values to `auto`.

```bash
tokenless config --browser-visibility auto --json
tokenless run --browser-visibility headed --json
tokenless run --browser-visibility headless --json
```

- Use `tokenless config --browser-visibility ...` to set the persistent default. Pass the same flag to `tokenless run` only when a single job needs an explicit visibility intent.
- `auto` starts headless and escalates to headed only for user-resolvable blockers such as sign-in, CAPTCHA, MFA, consent, or confirmation. Terminal errors do not open a visible window.
- `headless` never opens a visible window. If the job parks waiting for user action, resume the same daemon job with `tokenless resume --job-id <job-id> --browser-visibility headed --json`; do not resubmit, replace, or change the job/task identity.
- `profiles open` is always headed. `doctor` is read-only. Chromium sandbox stays enabled in both modes.
- Auto-escalated windows close after 30 seconds of idle time after the job completes. Explicit headed and `profiles open` windows remain open.

## Daemon Lifecycle

Outside setup, the CLI reuses a running daemon after `/ready` proves the requested Tokenless home and reports the exact package version expected by the CLI. If no verified daemon is reachable, the CLI starts one on demand through a SQLite startup election. `config.json` stores only the preferred loopback URL; if its port is occupied, the daemon scans upward for a free port and records the actual runtime endpoint in SQLite without rewriting user configuration. The CLI-daemon contract is the Tokenless Daemon API v1 OpenAPI document in `api/tokenless-daemon-api.openapi.json`; API version is recorded in OpenAPI `info.version`. Job, action, and local recovery payloads keep their own internal schema IDs only where persisted validation needs them. During `tokenless setup`, Tokenless may replace a same-home daemon only when the ready proof is valid and the running package version differs. Foreign, different-home, and unverified listeners are left running.

Stop a compatible daemon through its authenticated graceful-shutdown endpoint:

```bash
tokenless daemon stop --json
```

The command discovers the actual endpoint from SQLite, verifies `/ready` for the same Tokenless home immediately before sending the local control token to the bearer-authenticated shutdown endpoint, and never kills a process merely because it occupies the preferred loopback port. If the listener is foreign, cannot be verified, or predates graceful shutdown support, Tokenless reports that manual action is required.

Address detached work to an agent session and drain unseen outcome summaries after that agent restarts:

```bash
tokenless run --agent-kind codex --agent-session-id <stable-session-id> --no-wait ...
tokenless replay --agent-kind codex --agent-session-id <stable-session-id> --json
```

Replay marks each SQLite outcome revision as reported before returning it. The summary is not retried and contains no raw result, error, or blocker content; complete job state remains available with `tokenless state --job-id <job-id> --json`.

## Managed Profiles

A profile is one persistent local browser identity. One profile can hold sessions for all supported providers; use separate profiles for multiple accounts of the same provider.

```bash
tokenless profiles discover --browser chrome --json
tokenless profiles discover --browser brave --json
tokenless profiles add --profile work --label "Work" --set-default
tokenless profiles list
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
tokenless profiles set-default --profile work
tokenless profiles reset --profile work
tokenless profiles clear --profile work
```

`--profile` has the case-sensitive short option `-P`, while `--provider` uses `-p`. For example, `tokenless profiles status -P work -p claude --json` checks Claude for the `work` profile.

`profiles discover` is read-only. Import with `profiles add --browser <chrome|brave> --import-browser-profile <directory-key> --preferred-providers <list> --consent-local-profile-copy` only after explicit user choice. Imported provider sign-in state remains local and opaque to agents. Jobs reuse registered profiles without refreshing them from the source.

`profiles status` performs one live provider-page observation and does not enforce login, open a handoff, or retry after the user signs in. It reports both authentication and normalized access (`guest`, `sign_in_required`, `signed_in_free`, `signed_in_paid`, `signed_in_unknown`, or `unknown`) and saves the observation in the managed profile registry. `profiles list` reads that saved observation and does not open provider pages or refresh status ad hoc. Authenticated observations may also report the visible provider username, subscription label, and normalized tier. Ambiguous plan evidence remains `null`/`signed_in_unknown`.

ChatGPT and Gemini can execute prompt jobs through a visible guest composer, as can the experimental Qwen integration. Claude and Grok require an authenticated account; a signed-out task job enters durable `waiting_for_user` before Tokenless writes or submits the prompt. Plan labels are diagnostic only—visible enabled or disabled controls remain the capability authority.

For Grok, the model menu is the subscription evidence: when `Auto`, `Expert`, and `Heavy` are all visibly unavailable, the saved subscription is `Free`; otherwise it is `SuperGrok`. Tokenless intentionally does not distinguish paid SuperGrok tiers.

## Local API

The authenticated loopback daemon API exposes durable jobs, replay receipts, runtime controls, and the provider-neutral action contract used by the CLI. Its OpenAPI 3.1 contract is `api/tokenless-daemon-api.openapi.json`. The bearer token remains a trusted-local-backend secret and must never be exposed to browser JavaScript.

## Browser Boundary

- Playwright uses a visible, persistent, non-default user-data directory.
- Web automation operates through visible provider pages and visible postconditions.
- Credentials and browser authentication data stay opaque inside the selected managed profile; only visible account display and subscription labels are reported.
- CAPTCHA, sign-in, rate limits, upgrade prompts, and confirmations remain under user control.
- Selected regular files are staged privately and sent through Playwright file inputs; raw caller paths do not enter daemon job JSON.
- Every request follows the authenticated local daemon and managed Playwright path.

## Roadmap

- Complete Playwright parity for ChatGPT, Claude, Gemini, and Grok.
- Promote Qwen from experimental only after the complete live account-state and capability matrix is proven.
- Finish seamless files, model controls, citations, and long-running work.
- Add provider workspaces, files, plugins, connectors, and tools when they are available through visible pages.
- Add image and broader multimodal workflows.
- Stabilize the local API as a public compatibility surface.

See [Architecture](../../docs/architecture.md) for the managed runtime design.
