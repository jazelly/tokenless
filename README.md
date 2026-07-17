[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

Tokenless gives agents one local CLI and API for operating AI websites through Playwright. It reuses the web sessions you already pay for and hides provider-specific browser details behind one contract.

> **Status:** Tokenless is migrating its web runtime to Playwright. The browser-extension architecture is being removed, ChatGPT, Claude, Gemini, and Grok are being unified, and file upload plus richer web workflows are under active development. The new architecture requires no browser extension.

## Why Tokenless

- **Save tokens first.** Use an existing web subscription for research, drafting, review, explanation, and transformations instead of paying for another model API call.
- **Operate the visible web safely.** Tokenless uses Playwright against normal provider pages. It does not extract cookies or browser-storage credentials, intercept hidden authorization headers, or call private provider APIs.
- **Free, MIT-licensed, and local.** There is no hosted Tokenless relay. Browser profiles and sessions stay on your machine; only prompts and selected files go to the provider you choose.
- **One interface across providers.** Agents use the same actions for ChatGPT, Claude, Gemini, and Grok while Tokenless handles their different pages, controls, and workflows.

## How It Works

`Agent → CLI or local API → tokenless-daemon → Playwright worker → managed Chrome profile → visible provider website`

`tokenless setup` creates a persistent local Chrome profile and opens the provider when sign-in is needed. Later runs reuse that profile. The user-facing flow stays the same even when provider DOM and file-upload controls differ.

| Mode | Execution path | Authentication | Status |
| --- | --- | --- | --- |
| Web (`visible`, default) | Playwright operating the visible website | Managed local Chrome profile | **Recommended; migration in progress** |
| Direct (`direct`) | Official client, public API, or explicit compatible gateway | Client login or environment API key | **Experimental** |

The modes are isolated: web automation never silently falls back to a paid API, and direct requests never silently open a browser. Tokenless is standalone from Noop.

The **local API** is another interface to the same Playwright web jobs. **Direct mode** bypasses Playwright and calls an official client or public provider API instead.

## Install

Requires Node.js 24.15+ and Google Chrome. No extension is required.

### npm (recommended)

```bash
npm install --global tokenless@latest
tokenless setup --json
tokenless doctor --json
```

Without a global install:

```bash
npx tokenless@latest setup --json
npx tokenless@latest doctor --json
```

System-wide installer:

```bash
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

This executes with `sudo`; [review the script first](https://github.com/jazelly/tokenless/blob/main/deploy/install.sh). Run `tokenless setup --json` and `tokenless doctor --json` afterward as your normal desktop user.

### Agent skill (required for agent use)

If an agent will use Tokenless, install this maintenance skill so it can set up, upgrade, repair, and verify the runtime for you:

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless-install --yes
```

Then tell your agent:

```text
Use $tokenless-install to install or upgrade Tokenless, install its main skill, and run doctor.
```

## Use Tokenless

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --attach-file ./brief.pdf \
  --prompt "Review this brief and return the key risks." \
  --json
```

The unified Playwright action contract covers visible authentication, exact model and effort controls, file upload, prompt input and submission, response reading, citations, blocker detection, and sanitized page snapshots. Four-provider parity and end-to-end file upload are still being completed.

Managed profiles keep provider sessions separate and reusable:

```bash
tokenless profiles add --profile work --set-default
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
```

The CLI is the primary interface. A local API will expose the same provider-neutral jobs and actions so other agents and applications do not need browser-specific logic. That API is part of the active Playwright work and is not yet a stable compatibility contract.

## Browser and Privacy Boundary

- Playwright runs locally with visible, persistent Google Chrome profiles.
- Importing an existing Chrome profile requires explicit consent; a clean profile is always available instead.
- Tokenless may copy authentication state locally but never parses, prints, logs, exports, or transmits credential values.
- Automation uses visible DOM controls and verifies visible outcomes. CAPTCHA, login, plan limits, and confirmations remain under user control.
- Selected files are staged locally, integrity-checked, uploaded through the visible file control, and never exposed as raw local paths in job results.

## Experimental Direct Mode

Direct mode remains separate from Playwright and may incur provider API charges:

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "Review this design." --json
```

Public API backends require an explicit model and an environment-only credential. Tokenless does not accept API keys as CLI arguments or store them in its state. See [Direct mode](docs/direct-mode.md) for supported providers, the authenticated local broker, account routing, and security boundaries.

## Roadmap

- Complete one Playwright action contract across ChatGPT, Claude, Gemini, and Grok.
- Make file upload, model selection, effort controls, citations, and long-running responses seamless across providers.
- Expose projects, workspaces, provider files, plugins, connectors, and tools.
- Support image generation, image input, and broader multimodal workflows.
- Stabilize the local API so agents can use the web as a programmable execution surface.

Roadmap items are not yet compatibility guarantees. See the [Playwright architecture handoff](docs/handoff-visible-provider-web-automation.md) for the implementation boundary and acceptance plan.

## Development

Requires Node.js 24.15+, npm, Rust, and Google Chrome.

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

Nothing is published by these commands. Release procedures live in [npm publishing](docs/npm-publishing.md).

## License

[MIT](LICENSE)
