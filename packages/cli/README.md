# Tokenless CLI

`tokenless` exposes provider-neutral CLI and local API access to visible ChatGPT, Claude, Gemini, and Grok sessions. The recommended web path uses a local `tokenless-daemon`, a Playwright worker, and persistent managed Google Chrome profiles.

> **Status:** The visible runtime is being migrated from the retired extension architecture to Playwright. Four-provider parity, file upload, and the local API are under active development. No browser extension is installed or used by the new architecture.

## Install

Requires Node.js 24.15+ and Google Chrome.

### npm (recommended)

```bash
npm install --global tokenless@latest
tokenless setup --json
tokenless doctor --json
```

`setup` provisions the local runtime and a persistent `default` Chrome profile, then opens the preferred provider when visible sign-in is needed. `doctor` verifies the CLI, daemon, Playwright worker, managed profile, Chrome, and visible provider state.

### npx

```bash
npx tokenless@latest setup --json
npx tokenless@latest doctor --json
```

### System-wide installer

```bash
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

Because this executes with `sudo`, [review the installer source](https://github.com/jazelly/tokenless/blob/main/deploy/install.sh) first. Run `tokenless setup --json` and `tokenless doctor --json` afterward as the normal desktop user.

## Web Automation

Web mode is the default; `--mode visible` is optional.

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --attach-file ./brief.pdf \
  --prompt "Review the navigation against this brief." \
  --json
```

The Playwright action contract is shared across all four providers and includes:

- visible authentication and blocker checks;
- exact-label model and effort inspection and selection;
- integrity-checked file upload through the visible page control;
- prompt input, submission, correlated response reading, and visible citations;
- fail-closed navigation checks and sanitized structural snapshots.

Provider parity and end-to-end upload acceptance are still being completed. Unsupported or unverified actions fail explicitly instead of guessing or changing execution paths.

## Managed Profiles

A profile is one persistent local Chrome identity. One profile can hold sessions for all supported providers; use separate profiles for multiple accounts of the same provider.

```bash
tokenless profiles add --profile work --label "Work" --set-default
tokenless profiles list
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
tokenless profiles set-default --profile work
tokenless profiles remove --profile work --confirm-delete
```

Every visible command accepts `--profile <slug>` and otherwise uses the configured default. Interactive setup may offer to copy a closed local Chrome profile after explicit consent; noninteractive setup creates a clean profile unless import and consent flags are both supplied.

Imported authentication state remains local and opaque. Tokenless does not parse, print, log, export, or transmit cookie, storage, password, or authentication values.

## Local API

The local API will expose the same daemon jobs and provider-neutral action contract as the CLI. This lets agents and applications use provider websites without embedding provider selectors or Playwright logic. Authentication, request schemas, and compatibility guarantees are part of the active cutover and are not yet stable.

## Experimental Direct Mode

Direct mode is isolated from Playwright. It uses provider-owned clients, documented public APIs, or explicitly configured compatible gateways and never falls back to the browser.

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "Summarize this." --json

TOKENLESS_DIRECT_GEMINI_API_KEY=... \
tokenless run --mode direct --provider gemini --model <api-model> --prompt "Summarize this." --json
```

Start the authenticated loopback direct broker for compatible local clients:

```bash
TOKENLESS_DIRECT_SERVER_KEY=... \
TOKENLESS_DIRECT_CHATGPT_API_KEY=... \
tokenless serve --mode direct --host 127.0.0.1 --port 8788 --json
```

Every broker route requires `Authorization: Bearer <TOKENLESS_DIRECT_SERVER_KEY>`. Credentials come only from the broker environment; inbound credentials and cookies are stripped. Public API traffic may be billed separately from web subscriptions.

See [Direct mode](../../docs/direct-mode.md) and [multi-account routing](../../docs/multi-account-routing.md) for route allowlists, account binding, failover, and security details.

## Browser Boundary

- Playwright uses installed Google Chrome with visible, persistent, non-default user-data directories.
- Web automation operates only through visible provider DOM and visible postconditions.
- It does not export browser credentials, intercept hidden authorization headers, call private provider APIs, or expose a remote debugging endpoint.
- CAPTCHA, sign-in, rate limits, upgrade prompts, and confirmations remain visible and under user control.
- Selected regular files are staged privately and sent through Playwright `setInputFiles`; raw caller paths do not enter daemon job JSON.
- Web and direct modes remain isolated, with no paid or browser fallback between them.

## Roadmap

- Complete Playwright parity for ChatGPT, Claude, Gemini, and Grok.
- Finish seamless files, models, effort controls, citations, and long-running work.
- Add provider projects, workspaces, files, plugins, connectors, and tools.
- Add image and broader multimodal workflows.
- Stabilize the local API as a public compatibility surface.

See the [Playwright architecture handoff](../../docs/handoff-visible-provider-web-automation.md) for the implementation and acceptance plan.
