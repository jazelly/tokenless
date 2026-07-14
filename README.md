[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

Tokenless lets agents use AI through either the provider website you already use or an explicit direct connection. The default and recommended path is the browser extension: it operates the visible web UI, keeps browser credentials in the browser, and avoids an extra paid model API call.

## Modes

| Mode | Transport | Authentication | Status |
| --- | --- | --- | --- |
| Extension (`visible`, default) | Visible ChatGPT, Claude, or Gemini web UI | Your browser session | **Recommended** |
| Direct/API (`direct`) | Official Codex client, documented public APIs, or an explicit compatible gateway | Provider client login or environment API key | **Experimental; active development** |

The modes are isolated. Tokenless never falls back from the extension to a paid API, or from a direct request to the browser.

## Why Tokenless

- **Save tokens first.** Reuse a web subscription for research, drafting, review, explanation, and transformations instead of spending another model API request.
- **Browser-native safety.** Extension mode uses normal, visible DOM interactions. It does not read cookies, passwords, browser-storage tokens, hidden authorization headers, or private provider APIs.
- **No hosted Tokenless fee; source available.** Tokenless has no hosted relay for your browser session. Only the prompt, explicitly shared context, and intentionally selected files reach the chosen provider.
- **Built to expand.** Visible adapters support ChatGPT, Claude, and Gemini today and can extend to other providers with compatible web interfaces.

## Install

Requires Node.js 24.15+. Extension mode also requires the Tokenless extension in Chrome, Brave, Edge, Arc, or Chromium.

### npm (recommended)

```bash
npm install --global tokenless@latest
tokenless setup --json
tokenless doctor --json
```

Complete any visible provider login or permission prompt opened by `setup`. `doctor` succeeds only when the local runtime and extension bridge are ready.

Without a global install:

```bash
npx tokenless@latest setup --json
npx tokenless@latest doctor --json
```

System-wide installer:

```bash
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

This executes with `sudo`; [review the script first](https://github.com/jazelly/tokenless/blob/main/deploy/install.sh). It installs the CLI only. Run `tokenless setup --json` and `tokenless doctor --json` afterward as your normal desktop user.

### Agent skills (required for agent use)

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless-install --yes
```

Then tell your agent:

```text
Use $tokenless-install to install Tokenless, install its main skill, and verify that it is ready.
```

The install skill handles installation, upgrades, repair, `doctor`, and any browser action that still requires you.

## Recommended: Extension Mode

Extension mode is the default; `--mode visible` is optional.

```bash
tokenless run \
  --provider chatgpt \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --prompt "Review the navigation." \
  --json
```

- ChatGPT is the default provider; Claude and Gemini are also supported.
- Reuse the returned `taskId` with `--task-id` for later turns.
- Add `--long-running` for visible work that may exceed three minutes.
- Research results include visible citations in `result.read.sources` when the provider renders them.

The extension uses only user-visible controls after host permission is granted. Login, CAPTCHA, rate limits, and confirmations remain under your control. It never navigates automatically to a task page, local-file page, or `chrome-extension://` workflow.

## Experimental: Direct/API Mode

Direct mode is under active development. Use extension mode unless you specifically need an official provider client, public API, compatible gateway, local API broker, or multi-account project routing.

ChatGPT defaults to the provider-owned Codex executable on macOS and Linux:

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "Review this design." --json
```

Public API backends require an explicit model and an environment-only credential:

```bash
TOKENLESS_DIRECT_CLAUDE_API_KEY=... \
tokenless run \
  --mode direct \
  --provider claude \
  --model <api-model> \
  --prompt "Review this design." \
  --json
```

Direct mode supports ChatGPT, Claude, Gemini, Grok, and explicit Antigravity-compatible gateways. Public API traffic may be billed separately from web subscriptions. API keys are never accepted as CLI arguments or stored in Tokenless state. See [Direct mode](docs/direct-mode.md) for providers, the local broker, account routing, route allowlists, and security details.

## Roadmap

The extension roadmap is to expose more provider-native web capabilities through the same visible, permissioned UI path:

- projects and workspaces;
- files and attachments;
- plugins, connectors, and tools;
- image and multimodal workflows.

The goal is for an agent to use the provider website as fully as a person can, without relying on private web APIs. Roadmap items are not yet a compatibility guarantee.

## Useful Commands

```bash
tokenless config --preferred-providers chatgpt,claude,gemini --browser chrome --json
tokenless state --task-id "<task-id>" --json
tokenless cancel --job-id "<job-id>" --json
tokenless snapshot-dom --provider chatgpt --json
```

For an unpacked extension, pass its real ID once to `tokenless setup --extension-id <id> --json`. See the [CLI reference](packages/cli/README.md), [architecture](docs/architecture.md), and [privacy policy](PRIVACY.md) for details.

## Development

Requires Node.js 24.15+, npm, and Rust.

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

The extension build is written to `packages/extension/dist/extension`. Load that directory from `chrome://extensions` in developer mode. Release procedures live in [npm publishing](docs/npm-publishing.md) and [Chrome Web Store release](docs/chrome-web-store-release.md); nothing is published by the commands above.
