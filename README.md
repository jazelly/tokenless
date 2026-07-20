[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

Run AI websites from any agent through one local CLI or API. Tokenless gives ChatGPT, Claude, Gemini, and Grok one provider-neutral interface.

## Why Tokenless

- **Save tokens.** Use web subscriptions you already pay for instead of another model API call.
- **Stay safe and visible.** Playwright operates the normal provider website and verifies visible results.
- **Keep control local.** Tokenless is free and MIT-licensed; the runtime, managed profiles, and sign-in state stay on your machine.
- **Use one interface.** The CLI targets all four providers, with files, projects, tools, images, and multimodal work converging on the same contract.

## Install

Requires Node.js 22.13+ and a supported Chromium browser such as Google Chrome or Brave.

```bash
npm install --global tokenless@latest
```

Setup installs and verifies the required `tokenless` and `tokenless-install` agent skills. To delegate installation or upgrades, tell your agent:

```text
Use $tokenless-install to install or upgrade Tokenless and run doctor.
```

Other deployment options:

```bash
# Run without a global install
npx tokenless@latest setup

# Install system-wide; review the script before running it
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

## Start

Choose one managed-profile path during setup.

### 1. Use an existing browser profile (recommended)

```bash
tokenless setup
```

Follow the interactive CLI to choose a browser, providers, and an existing Chrome or Brave profile. With your approval, Tokenless copies only supported sign-in state for the selected providers into a separate managed profile; the source profile is unchanged.

### 2. Start with a fresh profile

```bash
tokenless setup --fresh
```

On a new installation, this creates a clean `default` profile, starts the local runtime, and opens ChatGPT when sign-in is needed. It never imports a browser profile implicitly.

Verify either path with:

```bash
tokenless doctor --json
```

## First Request

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --attach-file ./brief.pdf \
  --prompt "Review this brief and return the key risks." \
  --json
```

ChatGPT, Claude, Gemini, and Grok are being unified behind the same workflow. Four-provider parity, end-to-end file upload, and the public local API are under active development.

## Roadmap

- Complete one Playwright action contract across ChatGPT, Claude, Gemini, and Grok.
- Make files, model controls, citations, and long-running responses seamless across providers.
- Expose provider projects, workspaces, files, plugins, connectors, and tools.
- Support image generation, image input, and broader multimodal workflows.
- Stabilize the local API so agents can use AI websites as a programmable execution surface.

Roadmap items are not yet compatibility guarantees.

## How Tokenless Works

`Agent → CLI or local API → local daemon → Playwright worker → managed browser profile → provider website`

The CLI and local API submit provider-neutral actions. The local daemon schedules them, Playwright operates the selected managed profile, and provider adapters verify visible outcomes. Later jobs reuse the same profile.

### Managed profiles

A managed profile is one reusable local browser identity. One profile can hold sessions for several providers; use separate profiles for multiple accounts of the same provider.

```bash
tokenless profiles discover --browser chrome --json
tokenless profiles discover --browser brave --json
tokenless profiles add --profile work --browser chrome --import-browser-profile "Profile 1" --preferred-providers chatgpt,claude --consent-local-profile-copy --set-default
tokenless profiles add --profile clean --set-default
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
tokenless profiles reset --profile work
tokenless profiles clear --profile work
```

`profiles discover` is read-only. Import, reset, and clear are explicit operations; jobs never change profile lifecycle automatically.

### Interfaces and modes

| Interface or mode | Execution path | Status |
| --- | --- | --- |
| CLI | Playwright web jobs through the local daemon | Primary interface |
| Local API | The same provider-neutral Playwright jobs | Active development |
| Direct mode (`--mode direct`) | Official client, public provider API, or explicit compatible gateway | Experimental |

Direct mode is separate from managed web automation and may incur provider API charges.

## Privacy and Safety

- Playwright runs locally with visible, persistent managed browser profiles.
- Consented import copies only selected provider sign-in state; passwords, history, bookmarks, payments, sync data, and caches are excluded.
- Automation uses visible page controls and checks visible results.
- CAPTCHA, sign-in, plan limits, consent, and confirmations remain under user control.
- Selected files are staged locally, integrity-checked, and uploaded through the provider's visible file control.
- Each request follows only the mode selected by the caller.

See the full [privacy policy](PRIVACY.md).

## Experimental Direct Mode

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "Review this design." --json
```

Public API backends require an explicit model and an environment-supplied credential. See [Direct mode](docs/direct-mode.md) for supported providers, account routing, and security boundaries.

## Development

Requires Node.js 22.13+, npm, Rust, and Google Chrome.

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

These commands do not publish anything. See [Architecture](docs/architecture.md) for the managed Playwright runtime and [npm publishing](docs/npm-publishing.md) for release procedures.

## License

[MIT](LICENSE)
