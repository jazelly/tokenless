# Tokenless CLI

`tokenless` gives agents local CLI access to visible AI websites through managed Playwright browser profiles. Provider credentials and browser state stay on the user's machine.

[Commands](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) · [中文命令参考](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md) · [Privacy](https://github.com/jazelly/tokenless/blob/main/PRIVACY.md)

## Install

Requires Node.js 22.13+ and Chrome, Brave, Edge, Arc, or Chromium.

```bash
npm install --global tokenless@latest
tokenless setup
tokenless doctor --json
```

`setup` installs the required agent skills, prepares the local daemon, creates or imports a managed browser profile, and checks every enabled provider once. On first setup it also detects `en` or `zh-CN` from the system locale; use `tokenless config --language <en|zh-CN>` to override the saved preference.

For a clean non-interactive profile:

```bash
tokenless setup --fresh --json
```

Fresh setup creates or reuses `default`, selects an installed browser, and selects every provider whose registry stage is not `disabled`. This includes experimental Qwen and DeepSeek. It reports sign-in state without opening a sign-in handoff.

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

`--capability` is repeatable. Tokenless also infers `conversation.chat` for a normal run, `file.upload` plus the media-specific input capability from attachments, and `workspace.native` from native Workspace intent. One provider must satisfy the entire merged requirement set:

```bash
tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review the attached proposal." \
  --json
```

The catalog also contains future candidate outcomes so agents can inspect a stable vocabulary. A candidate is not routeable until its provider strategy and complete real-provider lifecycle are implemented and E2E-closed.

## Providers

| Provider | Stage | Signed-out use |
| --- | --- | --- |
| ChatGPT | Supported | Guest supported |
| Claude | Supported | Sign-in required |
| Gemini | Supported | Guest supported |
| Grok | Supported | Sign-in required |
| Qwen / 千问 | Experimental | Guest supported |
| DeepSeek | Experimental | Sign-in required |

Prompt submission and response reading are the shared baseline. Files, citations, model or effort controls, conversation continuation, and Workspaces depend on the visible provider, profile, and account state.

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

## Workspaces

`--project-name` is task metadata unless `--workspace-mode` is present.

- `auto` prefers a proven native Project and falls back only after stable visible evidence that native Projects are unavailable.
- `native` requires exact native creation or reuse.
- `conversation` requires the conversation strategy.

Native Project support is currently implemented for Claude and Grok. All Workspace behavior remains capability-gated and experimental.

## Managed Profiles

One managed profile can hold sessions for all enabled providers. Use separate profiles for multiple accounts of the same provider.

The managed runtime keeps different providers and stable task identities in separate tabs. Re-entering the same project or conversation task returns to its tab; a job can overwrite an existing tab only by explicitly setting `pagePolicy` to `replace` through the local job API.

```bash
tokenless profiles list --json
tokenless profiles open --profile work
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude --json
```

Chrome and Brave profiles can be imported only with explicit copy consent. Gemini and shared Google sign-in data are not imported.

## Browser and Local Runtime

Browser visibility defaults to `auto`: jobs start headless and open a visible window only for user-resolvable blockers. Use `headed` or `headless` for an explicit policy. A waiting headless job must be resumed, not resubmitted:

```bash
tokenless resume --job-id <job-id> --browser-visibility headed --json
```

Every request uses the authenticated loopback daemon and a persistent non-default browser profile. Credentials remain opaque to agents. Sign-in, CAPTCHA, consent, payment, plan, and confirmation steps remain under user control.

See the [command reference](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) for all commands and options, and [Architecture](https://github.com/jazelly/tokenless/blob/main/docs/architecture.md) for runtime details.
