[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

Use the AI web subscriptions you already have from any agent through one local CLI or API. Tokenless handles ChatGPT, Claude, Gemini, and Grok behind one provider-neutral interface.

## Why Tokenless

- **Save tokens first.** Reuse web subscriptions for research, drafting, review, explanation, and transformations instead of paying for another model API call.
- **Safe, visible browser automation.** Playwright operates the normal provider website, keeps sign-in state inside a managed local Chrome profile, and verifies visible outcomes.
- **Free, MIT-licensed, and local.** Tokenless runs on your machine. Browser profiles and sessions remain local; only prompts and files you select go to the chosen provider.
- **One interface across providers.** Agents use the same actions for ChatGPT, Claude, Gemini, and Grok while Tokenless handles their different pages and controls.
- **Built for complete workflows.** The unified contract covers models, effort controls, files, prompts, responses, citations, projects, tools, and multimodal work.

## Install

Requires Node.js 24.15+ and Google Chrome.

### npm (recommended)

```bash
npm install --global tokenless@latest
tokenless setup --json
tokenless doctor --json
```

### Agent skill (required for agent use)

Install the maintenance skill so your agent can set up, upgrade, repair, and verify Tokenless:

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless-install --yes
```

Then tell your agent:

```text
Use $tokenless-install to install or upgrade Tokenless, install its main skill, and run doctor.
```

### Other installation options

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

## Quick Start

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --attach-file ./brief.pdf \
  --prompt "Review this brief and return the key risks." \
  --json
```

The same workflow is being unified across ChatGPT, Claude, Gemini, and Grok. Tokenless is actively completing four-provider parity, end-to-end Playwright file upload, and the public local API.

## Roadmap

- Complete one Playwright action contract across ChatGPT, Claude, Gemini, and Grok.
- Make file upload, model selection, effort controls, citations, and long-running responses seamless across providers.
- Expose provider projects, workspaces, files, plugins, connectors, and tools.
- Support image generation, image input, and broader multimodal workflows.
- Stabilize the local API so agents can use AI websites as a programmable execution surface.

Roadmap items are not yet compatibility guarantees.

## How Tokenless Works

`Agent → CLI or local API → tokenless-daemon → Playwright worker → managed Chrome profile → visible provider website`

`tokenless setup` creates a persistent local Chrome profile and opens a provider when sign-in is needed. Later runs reuse that profile. Tokenless translates provider-neutral actions into the correct visible controls and returns a consistent result.

### Managed profiles

A managed profile is one reusable local browser identity. Use one profile for sessions across several providers, or separate profiles for multiple accounts.

```bash
tokenless profiles discover --json
tokenless profiles add --profile work --import-chrome-profile "Profile 1" --consent-local-profile-copy --set-default
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
```

`profiles discover` is read-only: it lists local Chrome roots and exact profile directory keys without copying data or creating Tokenless profiles. Importing an existing Chrome profile is a one-time user setup operation that requires explicit consent; use `tokenless profiles add --profile work --set-default` for a clean managed profile. Jobs and live tests reuse the already-managed profile until you explicitly remove it.

### Interfaces and modes

| Interface or mode | Execution path | Status |
| --- | --- | --- |
| CLI | Playwright web jobs through `tokenless-daemon` | Primary interface |
| Local API | The same provider-neutral Playwright jobs | Active development |
| Direct mode (`--mode direct`) | Official client, public provider API, or explicit compatible gateway | Experimental |

The CLI and local API are two interfaces to the same Playwright automation. Direct mode is a separate path for explicit client or provider API access.

## Privacy and Safety

- Playwright runs locally with visible, persistent Google Chrome profiles.
- Authentication state remains opaque inside the selected managed profile.
- Automation uses visible page controls and checks the visible result of each action.
- CAPTCHA, sign-in, plan limits, consent, and confirmations remain under user control.
- Selected files are staged locally, integrity-checked, and uploaded through the provider's visible file control.
- Web and direct requests follow only the mode explicitly selected by the caller.

## Experimental Direct Mode

Direct mode may incur provider API charges:

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "Review this design." --json
```

Public API backends require an explicit model and an environment-supplied credential. See [Direct mode](docs/direct-mode.md) for supported providers, the authenticated local broker, account routing, and security boundaries.

## Development

Requires Node.js 24.15+, npm, Rust, and Google Chrome.

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

Nothing is published by these commands. Implementation and acceptance details live in the [Playwright architecture handoff](docs/handoff-visible-provider-web-automation.md); release procedures live in [npm publishing](docs/npm-publishing.md).

## License

[MIT](LICENSE)
