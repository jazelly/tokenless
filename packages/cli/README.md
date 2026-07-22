# Tokenless CLI

`tokenless` gives agents provider-neutral CLI and local API access to visible ChatGPT, Claude, Gemini, and Grok sessions. A local daemon, Playwright worker, and persistent managed browser profiles handle execution.

## Install

Requires Node.js 22.13+ and a supported Chromium browser such as Google Chrome or Brave.

```bash
npm install --global tokenless@latest
```

Setup installs and verifies both required agent skills.

## Start

### Use an existing browser profile (recommended)

```bash
tokenless setup
```

The interactive flow chooses a browser and providers, discovers existing Chrome or Brave profiles, asks for explicit copy consent, creates a separate managed profile, starts the local runtime, and checks provider sign-in.

### Start clean

```bash
tokenless setup --fresh
```

This non-interactive path creates a clean managed `default` profile on a new installation or reuses the registered default, selects the first supported browser and ChatGPT when needed, starts the runtime, and opens the provider when user action is required. It does not import a local browser profile.

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
  --project-root /path/to/project \
  --attach-file ./brief.pdf \
  --prompt "Review the navigation against this brief." \
  --json
```

The shared Playwright action contract covers:

- visible authentication and blocker checks;
- exact-label model and effort inspection and selection;
- integrity-checked file upload through the visible page control;
- prompt submission, correlated response reading, and visible citations;
- fail-closed navigation checks and sanitized structural snapshots.

Four-provider parity and end-to-end upload acceptance are still being completed. Unsupported or unverified actions fail explicitly.

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

`profiles discover` is read-only. Import with `profiles add --browser <chrome|brave> --import-browser-profile <directory-key> --preferred-providers <list> --consent-local-profile-copy` only after explicit user choice. Imported provider sign-in state remains local and opaque to agents. Jobs reuse registered profiles without refreshing them from the source.

## Local API

The local API will expose the same daemon jobs and provider-neutral action contract as the CLI. Authentication, request schemas, and compatibility guarantees are under active development.

## Browser Boundary

- Playwright uses a visible, persistent, non-default user-data directory.
- Web automation operates through visible provider pages and visible postconditions.
- Authentication state stays opaque inside the selected managed profile.
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
