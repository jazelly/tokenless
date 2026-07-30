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

## What Tokenless Does

Tokenless lets AI agents send work to ChatGPT, Claude, Gemini, Grok, and Qwen directly through their websites—reducing agent-side token use without provider API keys.

It goes beyond sending prompts. Tokenless adapts each provider's real web workflows into one local interface for agents:

- send prompts and read responses or citations;
- upload files through the provider's own controls;
- use visible models, reasoning levels, and provider-specific modes;
- create or reuse Projects and keep each task scoped to the right profile, Project, and conversation; and
- deliver selected project files and turn context without exposing unrelated files.

Capabilities are enabled only where Tokenless has verified the visible provider workflow. Unsupported or unproven behavior stops with a clear error instead of being guessed. Provider credentials, browser state, and job data stay on the user's machine.

| Provider | Status | Login |
| --- | --- | --- |
| ChatGPT | Available | Not required |
| Claude | Available | Required |
| Gemini | Available | Not required |
| Grok | Available | Required |
| Qwen / 千问 | Beta | Not required |

## Install and Setup

```bash
npm install --global tokenless@latest
tokenless setup
```

Requires Node.js 22.13+ and Chrome, Brave, Edge, Arc, or Chromium. `tokenless setup` prepares the local runtime, creates or imports a browser profile, and checks every enabled provider.

## Run

After setup, ask your agent to use Tokenless, or run a quick check yourself:

```bash
tokenless run \
  --provider chatgpt \
  --prompt "Review this proposal."
```

Without `--provider`, Tokenless chooses an available configured provider. If you name one, Tokenless uses that exact provider.

Inspect provider-specific availability with `tokenless provider-action --action capability.inspect --provider <provider> --json`.

See [CLI Commands](COMMANDS.md), [Privacy](PRIVACY.md), and [Architecture](docs/architecture.md) for advanced options and implementation details.

## Current Status

Tokenless is currently in private beta. We plan to publish detailed benchmarks of its token savings in the future.

## Known Issues

### Codex sandbox policies can prevent Tokenless from running

In Codex, the sandbox policy applied to an agent may block Tokenless from launching a browser or performing required local operations. In a trusted environment, either enable Full Access or approve the operation when Codex asks for permission and choose to allow the same operation in the future.
