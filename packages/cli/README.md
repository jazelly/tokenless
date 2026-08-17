# Tokenless CLI

`tokenless` currently gives agents local CLI access to visible AI websites by attaching Playwright to the user's running Google Chrome or Brave Browser. In this visible-browser mode, provider credentials and browser state stay in the selected browser on the user's machine.

[中文](README.zh-CN.md) · [Commands](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) · [Capability Matrix](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.md) · [Capability Matrix 中文](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.zh-CN.md) · [中文命令参考](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md) · [Privacy](https://github.com/jazelly/tokenless/blob/main/PRIVACY.md)

## Install

Browser features require Node.js 22.13+ and a current Google Chrome or Brave Browser release that exposes its browser-managed remote debugging endpoint. Apple Silicon macOS is the current target; Windows x64 remains prerelease.

Chrome and Brave are user-supplied browsers: Tokenless does not bundle or download either one. If setup cannot find the selected browser, it still saves configuration, skips provider checks, and ends with instructions for adding an executable path. The first browser action validates that path or retries standard discovery. During setup, CloakBrowser is the only browser runtime Tokenless downloads and prepares.

```bash
npm install --global tokenless@latest
tokenless setup
tokenless doctor --json
```

Before browser use, open `chrome://inspect/#remote-debugging` in the Google Chrome instance you already use or `brave://inspect/#remote-debugging` in Brave, enable remote debugging, and approve the browser's connection prompt. Setup asks about Anti-Detect mode, then lets native-mode users choose Chrome or Brave. If browser discovery fails, setup still completes and tells the user how to add an executable path; provider checks wait until browser access is available.

For a clean non-interactive profile:

```bash
tokenless setup --defaults --json
```

Setup creates or reuses the named logical profile and uses its persisted `profiles[slug].enabledProviders`. Interactive setup lets you remove providers by number. Setup reports visible sign-in state without automating sign-in.

## Optional Codex Integration

```bash
tokenless agents install codex
```

Restart Codex and trust the Tokenless definition in `/hooks`, then continue launching Codex normally. Tokenless does not provide a Codex wrapper, relay, or custom model provider. It adds reversible global guidance plus native hooks that bind an actual Tokenless invocation to the exact Codex chat, turn, tool call, local project, Harness conversation, and observed provider Project/conversation.

Use `tokenless agents status codex --json`, `tokenless agents inspect codex --chat-id <codex-thread-id> --json`, and `tokenless agents uninstall codex` for inspection and removal. The separate Harness ledger stores bounded IDs and hashes, not raw Codex prompts, transcripts, credentials, or browser state.

## Run

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --prompt "Review this proposal." \
  --json
```

Use the setup-managed GPT4Free backend for a direct ChatGPT text chat:

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --execution-mode direct \
  --provider-backend g4f \
  --prompt "Review this proposal." \
  --json
```

Use `--provider-backend native` to keep the existing Tokenless ChatGPT or Perplexity implementation for A/B testing and rollback.

Setup installs one pinned private `g4f[all]` Python service. Tokenless keeps browser control and profile ownership; G4F handles direct provider HTTP, impersonation, Sentinel/PoW, streaming, HAR/Cookie auth, and media behind the authenticated daemon API. Omitting `--execution-mode direct` keeps visible-browser behavior.

See [GPT4Free direct provider service](../../docs/g4f-direct-provider-service.md) for backend flags, standard API routes, provider mappings, pins, and isolation boundaries.

If no provider is explicit, Tokenless uses the first configured provider with a cached guest or signed-in observation. If none is usable, it fails before creating a job and reports how to refresh access.

List canonical task outcomes and their evidence-backed provider routes:

```bash
tokenless capabilities list --json
```

The public [Capability Matrix](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.md) explains the outcome vocabulary, current provider mappings, evidence ladder, and extension process.

`--capability` is repeatable. Tokenless also infers `conversation.chat` for a normal run, `file.upload` plus the media-specific input capability from attachments, and `workspace.native` from native Workspace intent. One provider must satisfy the entire merged requirement set:

```bash
tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review the attached proposal." \
  --json
```

The catalog also contains future candidate outcomes so agents can inspect a stable vocabulary. A candidate is not routeable until its provider strategy and complete real-provider lifecycle are implemented and E2E-closed.

Implicit normal runs persist compatible provider alternatives. Before prompt submission, a provider-scoped auth, CAPTCHA, capacity, or plan blocker can atomically requeue the same durable job on the next provider whose real-E2E-closed route satisfies the run's complete requirements. Explicit providers, exact continuation, provider-specific controls, completed non-reconstructable mutations, and ambiguous submissions fail closed instead. Inspect `providerAttempts` and `fallback` through JSON state output.

## Providers

| Provider | Stage | Signed-out use |
| --- | --- | --- |
| ChatGPT | Supported | Guest supported |
| Claude | Supported | Sign-in required |
| Gemini | Supported | Guest supported |
| Grok | Supported | Sign-in required |
| Qwen / 千问 | Experimental | Guest supported |
| DeepSeek | Experimental | Sign-in required |
| Perplexity | Experimental | Guest supported |
| Z.ai / GLM | Experimental | Guest supported |
| Doubao / 豆包 | Experimental | Sign-in required |
| Kimi | Experimental | Sign-in required |
| Dola | Experimental | Sign-in required |
| Arena | Supported | Sign-in required |
| Meta AI | Experimental | Sign-in required |

Prompt submission and response reading are the shared baseline. Files, citations, model or effort controls, conversation continuation, and Workspaces depend on the visible provider, profile, and account state. Meta AI chat and file upload are experimentally routeable from a selected signed-in profile; Instant/Thinking selection is available, while image generation remains unadvertised until the CLI exposes its artifact lifecycle.

Inspect the current runtime capability state:

```bash
tokenless provider-action \
  --profile default \
  --provider chatgpt \
  --action capability.inspect \
  --json
```

Unsupported, ambiguous, or unproven behavior fails closed.

## Qwen Modes

Qwen exposes provider-specific modes through `qwen.mode.inspect` and `qwen.mode.select`:

```bash
tokenless run \
  --provider qwen \
  --qwen-mode "Deep Research" \
  --qwen-mode-variant "Advanced" \
  --prompt "Proceed with a standalone report on this topic; use official sources." \
  --json
```

The experimental capability proves exact mode selection and the first correlated visible response. It does not yet claim Qwen's complete multi-turn final-report lifecycle. Auto, Thinking, and Fast remain effort choices selected with `--effort`.

## Doubao Modes and Skills

Doubao exposes exact provider controls through `doubao.mode.inspect/select` and `doubao.skill.inspect/select`. Stable English action payloads select the Chinese visible UI labels, and every selection requires a visible selected-state postcondition. Work Task Pro reports `upgrade_required`; Audio Transcription reports `desktop_app_required` because the Web entry offers a desktop-app download instead of a Web workflow. Translation is intentionally outside the coding-oriented skill inventory. Canonical mappings remain candidates until their complete generation, research, reasoning, transcription, or task lifecycle passes a separate real-provider gate.

## Workspaces

`--project-name` is task metadata unless `--workspace-mode` is present.

- `auto` prefers a proven native Project and falls back only after stable visible evidence that native Projects are unavailable.
- `native` requires exact native creation or reuse.
- `conversation` requires the conversation strategy.

Native Project behavior is implemented experimentally for the explicit Claude and Grok real-provider gate, but `workspace.native` is not advertised as a router route until that complete gate passes. All Workspace behavior remains capability-gated.

## Managed Profiles

One managed profile can hold sessions for all enabled providers. Use separate profiles for multiple accounts of the same provider.

The managed runtime keeps different providers and stable task identities in separate tabs. Re-entering the same project or conversation task returns to its tab; a job can overwrite an existing tab only by explicitly setting `pagePolicy` to `replace` through the local job API.

```bash
tokenless profiles list --json
tokenless profiles open --profile work
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude --json
```

Tokenless profiles organize provider tabs and configuration; they do not create separate browser identities. The currently shipped visible-browser mode does not inspect individual cookies, tokens, browser storage, Keychain data, or authentication values, and no mode exposes those values to agents.

## Browser and Local Runtime

Native mode is headed-only because it controls the Chrome or Brave instance the user already opened. Stopping or restarting the daemon disconnects Playwright without closing the browser.

Every visible-browser request uses the authenticated loopback daemon and Tokenless-owned tabs in the user's selected browser. Provider credentials are never exposed to agents. Sign-in, CAPTCHA, payment, plan, and ambiguous or external confirmations remain under user control; a provider adapter may accept an exact, known onboarding Terms/Privacy dialog for a provider the user selected.

See the [command reference](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) for all commands and options, and [Architecture](https://github.com/jazelly/tokenless/blob/main/docs/architecture.md) for runtime details.
