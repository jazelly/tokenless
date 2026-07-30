<p align="center">
  <img src="assets/tokenless-wordmark.png" alt="Tokenless" width="560">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/v/tokenless?logo=npm&amp;label=version" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/dm/tokenless?logo=npm&amp;label=downloads" alt="npm monthly downloads"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="COMMANDS.md">CLI commands</a> · <a href="docs/roadmaps/README.md">Roadmaps</a>
</p>

## Overview

Tokenless is a local CLI that lets agents use visible AI websites through managed Playwright browser profiles. It reduces agent-side token use by routing suitable work to web sessions while keeping provider credentials, browser state, daemon state, and job results on the user's machine.

| Provider | Stage | Signed-out use |
| --- | --- | --- |
| ChatGPT | Supported | Guest supported |
| Claude | Supported | Sign-in required |
| Gemini | Supported | Guest supported |
| Grok | Supported | Sign-in required |
| Qwen / 千问 | Experimental | Guest supported |

## Install and Setup

```bash
npm install --global tokenless@latest
tokenless setup
tokenless doctor --json
```

`tokenless setup` installs the required agent skills, reconciles the local daemon to the installed CLI version, chooses a supported Chromium browser, creates or imports a managed profile, and checks all enabled providers once. The clean path is:

```bash
tokenless setup --fresh --json
```

Fresh setup creates or reuses `default`, selects every provider whose registry stage is not `disabled`, including Qwen, and reports sign-in state once. It does not open a sign-in handoff.

## Run

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --prompt "Review this proposal." \
  --json
```

Without an explicit provider, Tokenless uses the first configured provider with a cached guest or signed-in observation. If none is usable, it fails before creating a job. An explicit provider is never silently replaced.

## Current Capabilities

- Tokenless runs locally through an authenticated loopback daemon and persistent managed browser profiles.
- Runtime actions use visible provider pages and visible postconditions. Unsupported or unproven behavior fails closed.
- ChatGPT and Gemini can run through visible guest sessions. Experimental Qwen can also run through its guest path. Claude and Grok require sign-in before task content is entered.
- File upload, citations, model or effort controls, Workspace handling, and conversation continuation are provider/profile-specific runtime capabilities, not blanket promises. Inspect them with `tokenless provider-action --action capability.inspect --provider <provider> --json`.
- `--project-name` is task metadata unless `--workspace-mode` is present. Workspace behavior is experimental and reports native `created`/`reused` or conversation `fallback` when proven.

## Experimental Qwen Modes

Qwen-specific composer modes use the optional `qwen.mode` capability. Inspect current visible modes with `qwen.mode.inspect`, or select one for a run:

```bash
tokenless run \
  --provider qwen \
  --qwen-mode "Deep Research" \
  --qwen-mode-variant "Advanced" \
  --prompt "Proceed with a standalone report on this topic; use official sources and do not compare competitors." \
  --json
```

This experimental capability proves exact mode selection and the first correlated visible response. It does not yet claim Qwen's complete multi-turn final-report lifecycle. Auto, Thinking, and Fast remain effort choices selected with `--effort`.

See [CLI Commands](COMMANDS.md), [Privacy](PRIVACY.md), and [Architecture](docs/architecture.md) for details.

## Current Status

Tokenless is currently in private beta. We plan to publish detailed benchmarks of its token savings in the future.

## Known Issues

### Codex sandbox policies can prevent Tokenless from running

In Codex, the sandbox policy applied to an agent may block Tokenless from launching a browser or performing required local operations. In a trusted environment, either enable Full Access or approve the operation when Codex asks for permission and choose to allow the same operation in the future.
