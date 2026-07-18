# Tokenless CLI

`tokenless` exposes provider-neutral CLI and local API access to visible ChatGPT, Claude, Gemini, and Grok sessions. It uses a local `tokenless-daemon`, a Playwright worker, and persistent managed Chromium profiles.

## Install

Requires Node.js 24.15+ and a supported Chromium browser such as Google Chrome or Brave.

### npm (recommended)

```bash
npm install --global tokenless@latest
tokenless setup
tokenless setup --defaults --json
tokenless doctor --json
```

`setup` is the canonical interactive onboarding command. It installs and checks the GitHub-backed agent skills, detects installed browsers, configures one persistent profile, asks which providers to use, starts the runtime, and keeps provider pages open for visible sign-in or challenge handoff. `doctor` verifies the resulting configuration.

`setup --defaults --json` is the canonical non-interactive entrypoint for agents and installers. It reuses the existing managed default profile, or creates a clean `default` profile with the first supported browser and ChatGPT. It never imports or re-imports a local browser profile implicitly.

### npx

```bash
npx tokenless@latest setup
npx tokenless@latest doctor --json
```

### System-wide installer

```bash
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

Because this executes with `sudo`, [review the installer source](https://github.com/jazelly/tokenless/blob/main/deploy/install.sh) first. Run `tokenless setup` and `tokenless doctor --json` afterward as the normal desktop user.

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

A profile is one persistent local browser identity. One profile can hold sessions for all supported providers; use separate profiles for multiple accounts of the same provider.

```bash
tokenless profiles discover --browser chrome --json
tokenless profiles discover --browser brave --json
tokenless profiles add --profile work --label "Work" --set-default
tokenless profiles list
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
tokenless profiles set-default --profile work
tokenless profiles remove --profile work --confirm-delete
```

`profiles discover` is a read-only helper for setup. It reports local Chrome or Brave roots and exact profile directory keys without copying data or creating a managed profile. Import with `profiles add --browser <chrome|brave> --import-browser-profile <directory-key> --consent-local-profile-copy` only when the user explicitly chooses that setup path.

Every visible command accepts `--profile <slug>` and otherwise uses the configured default. Jobs and live tests reuse the managed profile already registered in Tokenless; they never refresh it from the source browser. Use `setup --defaults --json` for non-interactive onboarding, or pass explicit import and consent flags when a local profile copy is intended.

Imported authentication state remains local and opaque. Tokenless does not parse, print, log, export, or transmit cookie, storage, password, or authentication values.

## Local API

The local API will expose the same daemon jobs and provider-neutral action contract as the CLI. This lets agents and applications use provider websites without embedding provider selectors or Playwright logic. Authentication, request schemas, and compatibility guarantees are part of the active cutover and are not yet stable.

## Experimental Direct Mode

Direct mode uses provider-owned clients, documented public APIs, or explicitly configured compatible gateways. Each request follows the mode selected by the caller.

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

- Playwright uses the configured supported Chromium browser with visible, persistent, non-default user-data directories.
- Web automation operates only through visible provider DOM and visible postconditions.
- Authentication state stays opaque inside the selected managed profile, and automation uses visible provider controls.
- CAPTCHA, sign-in, rate limits, upgrade prompts, and confirmations remain visible and under user control.
- Selected regular files are staged privately and sent through Playwright `setInputFiles`; raw caller paths do not enter daemon job JSON.
- Web and direct requests follow only the mode explicitly selected by the caller.

## Roadmap

- Complete Playwright parity for ChatGPT, Claude, Gemini, and Grok.
- Finish seamless files, models, effort controls, citations, and long-running work.
- Add provider projects, workspaces, files, plugins, connectors, and tools.
- Add image and broader multimodal workflows.
- Stabilize the local API as a public compatibility surface.

See the [Playwright architecture handoff](../../docs/handoff-visible-provider-web-automation.md) for the implementation and acceptance plan.
