# Tokenless CLI

`tokenless` gives agents provider-neutral CLI access to visible ChatGPT, Claude, Gemini, and Grok sessions. A local daemon, Playwright worker, and persistent managed browser profiles handle execution. A public local API is planned but is not a compatibility surface yet.

Complete command inventory: [English](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) | [中文](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md)

## Install

Requires Node.js 22.13+ and a supported Chromium browser such as Google Chrome or Brave.

```bash
npm install --global tokenless@latest
```

Setup installs and verifies both required agent skills, checks the installed CLI
against the latest npm release, and leaves a compatible local daemon running.

## Start

### Use an existing browser profile (recommended)

```bash
tokenless setup
```

The interactive flow chooses a browser and providers, discovers existing Chrome
or Brave profiles, asks for explicit copy consent, creates a separate managed
profile, reconciles and verifies the local daemon, and checks provider sign-in.
Daemon compatibility is based on the CLI and daemon semantic-version major.

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

Without a global install:

```bash
npx tokenless@latest setup
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

Four-provider parity and end-to-end upload acceptance are still being completed. Unsupported or unverified actions fail explicitly.

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

Outside setup, the CLI reuses an authenticated running daemon when its semantic-version major matches the CLI, even when their minor or patch versions differ. An invalid or different-major daemon is left running and reported as incompatible. During `tokenless setup`, a verified same-home daemon with an unparseable or semantic-major incompatible version is automatically stopped through authenticated shutdown and replaced.

Stop a compatible daemon through its authenticated graceful-shutdown endpoint:

```bash
tokenless daemon stop --json
```

The command verifies the daemon identity before sending the local control token and never kills a process merely because it occupies the configured loopback port. If the listener is foreign, cannot be verified, or predates graceful shutdown support, Tokenless reports that manual action is required. The daemon binds the exact configured port and does not choose a fallback when that port is occupied.

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

`profiles status` performs a live provider-page check and authenticates only when the provider-specific account control is visible and clickable; a composer alone is not sufficient. It saves the resulting observation in the managed profile registry. `profiles list` reads that saved observation and does not open provider pages or refresh status ad hoc. After a successful check, `profiles list --json` reports the visible provider username and subscription label under `profiles[].providers`. A subscription is `null` when the visible UI does not establish a reliable tier.

For Grok, the model menu is the subscription evidence: when `Auto`, `Expert`, and `Heavy` are all visibly unavailable, the saved subscription is `Free`; otherwise it is `SuperGrok`. Tokenless intentionally does not distinguish paid SuperGrok tiers.

## Local API

The planned local API will expose the same daemon jobs and provider-neutral action contract as the CLI. Authentication, request schemas, and compatibility guarantees are under active development; the daemon's HTTP endpoints remain an internal control plane.

## Browser Boundary

- Playwright uses a visible, persistent, non-default user-data directory.
- Web automation operates through visible provider pages and visible postconditions.
- Credentials and browser authentication data stay opaque inside the selected managed profile; only visible account display and subscription labels are reported.
- CAPTCHA, sign-in, rate limits, upgrade prompts, and confirmations remain under user control.
- Selected regular files are staged privately and sent through Playwright file inputs; raw caller paths do not enter daemon job JSON.
- Every request follows the authenticated local daemon and managed Playwright path.

## Roadmap

- Complete Playwright parity for ChatGPT, Claude, Gemini, and Grok.
- Finish seamless files, model controls, citations, and long-running work.
- Add provider workspaces, files, plugins, connectors, and tools when they are available through visible pages.
- Add image and broader multimodal workflows.
- Stabilize the local API as a public compatibility surface.

See [Architecture](../../docs/architecture.md) for the managed runtime design.
