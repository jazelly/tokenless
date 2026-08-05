# Tokenless CLI

`tokenless` gives agents local CLI access to visible AI websites through managed Playwright browser profiles. Provider credentials and browser state stay on the user's machine.

[Commands](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) · [Capability Matrix](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.md) · [Capability Matrix 中文](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.zh-CN.md) · [中文命令参考](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md) · [Privacy](https://github.com/jazelly/tokenless/blob/main/PRIVACY.md)

## Install

Requires Node.js 22.13+. The first browser-runtime targets are Apple Silicon macOS and x64 Windows. Windows remains prerelease until its real-hardware gates pass.

```bash
npm install --global tokenless@latest
tokenless setup
tokenless doctor --json
```

`setup` first resolves an exact browser runtime, creates or selects a runtime-bound managed profile, then installs the required agent skills, prepares the local daemon, checks every enabled provider once, and leaves one headed provider review tab open for each enabled provider. Normal mode uses an explicit browser, then the saved preference, then automatic discovery; `auto` prefers an installed system browser and lazily downloads Tokenless-managed Chrome for Testing 145 only when none exists. Interactive setup asks whether to use Anti-Detect mode and states that accepting will install the verified platform-pinned CloakBrowser when needed. Declining does not open a separate runtime picker. Before download, the Cloak flow links to the official project, shows the platform pin, scans only safe directory/version metadata for known local Chromium profiles, and classifies exact version alignment. If compatible profiles exist, one source choice offers `Start clean` and those profiles; selecting a profile explicitly authorizes its opaque local copy without a separate import, copy-consent, or installation confirmation. For non-interactive setup, explicit `--anti-detect` or `--browser cloak` authorizes installation; a stored Cloak preference alone fails before download, and import still requires `--consent-local-profile-copy`. Tokenless downloads Cloak from its official release and does not redistribute it. On first setup it also detects `en` or `zh-CN` from the system locale; use `tokenless config --language <en|zh-CN>` to override the saved preference.

For a clean non-interactive profile:

```bash
tokenless setup --fresh --json
```

Fresh setup creates or reuses a profile only when its runtime binding is compatible, resolves the selected browser, and uses the persisted `providerWhitelist`. Its default contains every provider whose registry stage is not `disabled`, including Gemini; interactive setup lets you remove providers by number. A runtime-family change creates a clean profile instead of opening existing data with another browser. The default includes experimental Qwen, DeepSeek, Perplexity, Z.ai, and Doubao. Setup reports sign-in state without opening a sign-in handoff.

## Run

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --prompt "Review this proposal." \
  --json
```

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

Prompt submission and response reading are the shared baseline. Files, citations, model or effort controls, conversation continuation, and Workspaces depend on the visible provider, profile, and account state. Doubao text-file selection is experimentally routeable; its advanced modes and Web skills are exposed as provider controls without advertising their still-unclosed outcome lifecycles.

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

New profiles are bound to the exact runtime that created them. They start clean unless the user explicitly selects a version-compatible local Chromium profile for opaque filesystem copy. Tokenless does not inspect or expose individual cookies, tokens, browser storage, or authentication values. The managed browser then keeps that profile's session across jobs.

On macOS, the managed browser uses its normal Keychain integration to decrypt browser-managed sign-in state. A Chrome or Chromium Safe Storage prompt is expected when you intentionally launch Tokenless with that selected browser; Tokenless does not export the Keychain item or decrypted credentials to an agent or separate service. Approve only the browser you recognize. Denying access can make an imported profile appear signed out, and approval cannot make profiles compatible across different browser products or Safe Storage identities. See the full [English FAQ](https://github.com/jazelly/tokenless#why-can-macos-ask-for-access-to-chrome-or-chromium-safe-storage) or [中文常见问题](https://github.com/jazelly/tokenless/blob/main/README.zh-CN.md#为什么-macos-可能请求访问-chrome-或-chromium-safe-storage).

## Browser and Local Runtime

Browser visibility defaults to `auto`: jobs start headless and open a visible window only for user-resolvable blockers. Use `headed` or `headless` for an explicit policy. A waiting headless job must be resumed, not resubmitted:

```bash
tokenless resume --job-id <job-id> --browser-visibility headed --json
```

Every request uses the authenticated loopback daemon and a persistent non-default browser profile. Credentials remain opaque to agents. Sign-in, CAPTCHA, consent, payment, plan, and confirmation steps remain under user control.

See the [command reference](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) for all commands and options, and [Architecture](https://github.com/jazelly/tokenless/blob/main/docs/architecture.md) for runtime details.
