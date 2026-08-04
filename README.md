<p align="center">
  <img src="assets/tokenless-wordmark.png" alt="Tokenless" width="560">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/v/tokenless?logo=npm&amp;label=version" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/dm/tokenless?logo=npm&amp;label=downloads" alt="npm monthly downloads"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="COMMANDS.md">CLI commands</a> · <a href="#install-and-setup">Quick start</a>
</p>

## What Tokenless Does

Tokenless gives AI agents one local browser interface for ChatGPT, Claude, Gemini, Grok, Qwen, and experimental DeepSeek, Perplexity, Z.ai, and Doubao adapters—reducing agent-side token use without provider API keys.

It goes beyond sending prompts. Tokenless adapts each provider's real web workflows into one local interface for agents:

- send prompts and read responses or citations;
- upload files through the provider's own controls;
- use visible models, reasoning levels, and provider-specific modes;
- create or reuse Projects and keep each task scoped to the right profile, Project, and conversation; and
- deliver selected project files and turn context without exposing unrelated files.

Capabilities are enabled only where Tokenless has verified the visible provider workflow. Unsupported or unproven behavior stops with a clear error instead of being guessed. Provider credentials, browser state, and job data stay on the user's machine.

Within one managed profile, Tokenless preserves separate browser tabs for different providers and stable tasks. Project and conversation task identities return to their own tab instead of navigating over another provider or conversation. The local job API defaults to `pagePolicy: "preserve"`; an integration must explicitly request `pagePolicy: "replace"` before Tokenless may reuse an existing tab for a different task.

Each active managed profile owns its own browser instance. Tokenless reuses that instance across the profile's tabs and jobs, and never closes another active profile to make room; up to four profiles may remain active at once.

| Provider | Status | Login |
| --- | --- | --- |
| ChatGPT | Available | Not required |
| Claude | Available | Required |
| Gemini | Available | Not required |
| Grok | Available | Required |
| Qwen / 千问 | Beta | Not required |
| DeepSeek | Experimental | Required |
| Perplexity | Experimental | Not required |
| Z.ai / GLM | Experimental | Not required |
| Doubao / 豆包 | Experimental | Required |
| Kimi | Experimental | Required |

## Install and Setup

Install the CLI:

```bash
npm install --global tokenless@latest
```

Then follow the interactive setup:

```bash
tokenless setup
```

Interactive setup first asks whether to use Anti-Detect mode and states that accepting will install the verified platform-pinned CloakBrowser under `TOKENLESS_HOME` when needed. Declining uses the saved normal-browser preference or automatic discovery without a separate runtime picker. When Anti-Detect is selected, setup links to CloakBrowser, shows the exact platform pin, scans only safe directory/version metadata for known Chrome, Brave, Edge, Arc, Chromium, and Chrome for Testing profiles, and marks exact version alignment. If compatible profiles exist, one source choice offers `Start clean` and the compatible profiles; selecting a profile explicitly authorizes its opaque local copy without Tokenless inspecting authentication values. There are no additional import, copy-consent, or installation confirmations. In non-interactive setup, explicit `--anti-detect` or `--browser cloak` authorizes installation; a saved Cloak preference alone cannot start a download, and import still requires `--consent-local-profile-copy`. Setup then asks which providers belong to the selected managed profile, checks only those providers, leaves one headed provider page open per provider in a concurrent background batch for visible sign-in review, and opens the local Tokenless dashboard in a reserved foreground tab. Reopen the dashboard at any time with:

```bash
tokenless dashboard
```

The dashboard is served only by the loopback daemon. It manages browser identities, profile-scoped provider routing, visible readiness and controls, capabilities, durable jobs, user handoffs, and redacted diagnostics. Setup and System settings discover installed runtimes, accept and verify an explicit system-browser executable path, and can explicitly copy or re-import one selected local Chromium profile as an opaque tree after consent. Browser JavaScript never receives the daemon bearer token, source filesystem paths, or provider credentials; `tokenless dashboard` uses a one-time bootstrap ticket to establish a short-lived local UI session.

Installing the package is only the first step. Complete `tokenless setup` before using Tokenless; it selects and verifies an exact browser runtime, creates or reuses a runtime-bound browser profile, prepares the local runtime, checks every enabled provider, and opens one review tab per provider. Normal mode follows an explicit browser, then the saved preference, then automatic discovery; the default `auto` uses an installed Chrome-family browser first and lazily downloads Tokenless-managed Chrome for Testing 145 only when none exists. Anti-Detect mode selects CloakBrowser and is also available non-interactively as `--anti-detect`. Cloak is downloaded from its official release into the private Tokenless cache; its separately licensed binary is not included in the Tokenless npm package or release artifacts.

Every managed profile is bound to the browser runtime that created it. Tokenless does not silently open a managed profile with a different runtime family. A runtime-family change normally creates a clean profile. With explicit user selection, setup may copy one version-compatible local Chromium profile as an opaque filesystem tree into a new managed profile; Tokenless does not inspect or expose individual cookies, tokens, browser storage, or authentication values. The managed browser then preserves that profile's session across jobs.

On first setup, Tokenless selects English or Simplified Chinese from the system locale and saves the choice as `language` in `~/.tokenless/config.json`. English is the fallback. The preference controls the CLI, dashboard, and default provider response language; an explicit language request in the prompt still wins. Change it later in the dashboard or with `tokenless config --language en` or `tokenless config --language zh-CN`.

The config uses `providerWhitelist` for the provider routing boundary. Its default contains every non-disabled provider except Gemini; Gemini can be enabled explicitly during setup, with `tokenless config --provider-whitelist ...`, or in the dashboard.

Setup resolves `auto` to a concrete `browser` and caches its verified absolute path as `browserExecutablePath` in `$TOKENLESS_HOME/config.json`. Runtime resolution validates that cache first, scans standard installation paths only after a cache miss, and refreshes the field after a successful fallback. Set a custom system-browser path with `tokenless config --browser chrome --browser-executable-path "/absolute/path/to/browser"`; managed Chromium and Cloak paths remain catalog-controlled under `$TOKENLESS_HOME/browser/runtimes`.

For browser capability evaluation, the config file accepts experimental `browserConnectionMode: "playwright" | "cdp"`; it defaults to `playwright`, has no CLI flag, and takes effect after the daemon restarts.

Requires Node.js 22.13+. The first browser-runtime targets are Apple Silicon macOS and x64 Windows; Windows x64 covers Intel and AMD processors. Windows remains prerelease until its real-hardware gates pass.

## Optional Output Savings Measurement

Output savings measurement is disabled by default and is not part of setup. While disabled, Tokenless does not download, load, or run a tokenizer. Enable it explicitly from the dashboard's System page or with:

```bash
tokenless savings enable --json
```

The first enable downloads a checksum-pinned `tiktoken` 1.0.22 archive (10,611,708 bytes, about 10.1 MiB) and installs only the `o200k_base` WASM runtime and vocabulary (3,413,323 bytes, about 3.3 MiB) under `TOKENLESS_HOME`. This is a deterministic tokenizer, not a local AI model. It needs no GPU and runs in a short-lived, single-concurrency Node.js subprocess only when Tokenless finishes reading a visible assistant response. A local benchmark observed roughly 100 MB of transient memory; exact CPU time and peak memory vary by response and machine.

Tokenless measures only normalized visible assistant output. It does not estimate input tokens, intercept private provider APIs, inspect hidden reasoning, or claim provider billing accuracy. `o200k_base` provides one stable cross-provider estimate, so totals are labeled estimates and can differ from a provider's model-specific tokenizer. Measurements are attributed idempotently to the triggering durable job and response.

```bash
tokenless savings status --json
tokenless savings disable --json
tokenless savings clear --confirm-delete --json
tokenless savings uninstall --confirm-delete --json
```

Disabling stops future measurement but keeps the verified runtime and history. Clearing deletes measurement history without changing the toggle. Uninstalling disables the feature and removes its local runtime. The tokenizer is not included in the Tokenless npm package; enabling it later is the only download path.

## Run

After setup, ask your agent to use Tokenless, or run a quick check yourself:

```bash
tokenless run \
  --provider chatgpt \
  --prompt "Review this proposal."
```

Without `--provider`, Tokenless chooses an available configured provider. If you name one, Tokenless uses that exact provider.

Agents can discover the canonical outcome catalog and request one or more evidence-backed capabilities:

```bash
tokenless capabilities list --json
tokenless limits inspect --profile default --provider chatgpt --json

tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review the attached proposal."
```

Tokenless combines explicit capabilities with requirements inferred from structured inputs. A normal run requires `conversation.chat`, attachments require `file.upload` plus their media-specific input capability, and `--workspace-mode native` requires `workspace.native`. The configured provider list restricts candidate membership. Inside that set, the router removes every provider that cannot satisfy the complete implication-expanded requirement set, then ranks the remaining routes by fresh runtime eligibility and evidence maturity; configured list order is only the final tie-breaker and can never override capability compatibility, runtime eligibility, or evidence maturity. `conversation.chat` and text-file `file.upload` are currently routeable; `workspace.native`, `research.deep`, and other candidate outcomes fail before browser mutation until their complete lifecycle has real-provider E2E closure.

For an implicit provider run, Tokenless records the ranked evidence-backed alternatives and rechecks the selected route against current local capacity plus the live provider page before mutation. A classified safe pre-submit provider failure—such as a known capacity window, sign-in, CAPTCHA, rate or plan limits, maintenance, regional unavailability, navigation failure, a missing stable surface, or visibly unavailable capability UI—can atomically move the same job to the next route. Every alternative must satisfy the identical complete capability set. Explicit `--provider`, exact or mapped continuation, provider-specific controls, non-reconstructable mutations, ambiguous state, and any post-submission failure never switch automatically. `tokenless state --json` reports ranked fallback routes, structured stop reasons, and the durable provider-attempt history.

Each routed job also stores a versioned provider-neutral context envelope with task identity, normalized requirements, role-bearing instructions, attachment provenance, output constraints, optional upstream agent state, and delivery hashes. The same validated envelope is replayed unchanged across provider attempts; `tokenless state --json` exposes a redacted envelope summary without instruction text or upstream state contents.

Inspect provider-specific availability with `tokenless provider-action --action capability.inspect --provider <provider> --json`.

DeepSeek exposes provider-specific `Instant`, `Expert`, and `Vision` modes plus independent `DeepThink` and `Search` controls. Inspect them with `deepseek.mode.inspect`, `deepseek.deepthink.inspect`, and `deepseek.search.inspect`; Search and file availability are mode-dependent and are never inferred from the mode label alone.

Doubao exposes provider-specific modes and coding-relevant Web skills through `doubao.mode.inspect/select` and `doubao.skill.inspect/select`. The runtime reports visible upgrade and desktop-only restrictions instead of clicking through them. Text-file `file.upload` is experimentally routeable; skill selection is control evidence only until each generated or long-running outcome completes its own real-provider release gate.

Kimi requires a signed-in managed profile. Its experimental routes cover `conversation.chat`, text-file `file.upload`, `search.web`, and search-backed `response.citations`; the real Cloak gates also close model selection (`Instant`, `K3`, and `K3 Swarm`), Standard/High thinking effort, exact Web search Auto/Off control, visible citations, attachment-aware responses, same-conversation continuation, and exact Plugin/Skill inspection and selection. Plugin- and Skill-backed outcomes, Projects, Deep Research, agent workflows, and generated or long-running artifacts remain unadvertised until their complete lifecycles close.

For explicit DeepSeek runs, `search.web` prepares Instant with Search enabled, `reasoning.extended` enables DeepThink, and `image.input` prepares Vision before browser mutation. These canonical routes remain fail-closed until their declared real-provider release gates pass.

## Documentation

- [Documentation index](docs/README.md)
- [Capability Matrix](docs/capability-matrix.md)
- [CLI Commands](COMMANDS.md)
- [Privacy](PRIVACY.md)
- [Architecture](docs/architecture.md)

## Current Status

Tokenless is currently in private beta. We plan to publish detailed benchmarks of its token savings in the future.

## Known Issues

### Codex sandbox policies can prevent Tokenless from running

In Codex, the sandbox policy applied to an agent may block Tokenless from launching a browser or performing required local operations. In a trusted environment, either enable Full Access or approve the operation when Codex asks for permission and choose to allow the same operation in the future.

## FAQ

### Does Tokenless eliminate all token usage?

No. It reduces agent-side token usage by routing suitable work to AI providers' websites. Your agent still needs some tokens to decide what to delegate and use the result.

### Is installing the npm package enough?

No. Run `tokenless setup` after installation and follow the setup flow. Tokenless needs a configured browser profile and at least one available provider before it can run tasks.

### Does Tokenless require provider API keys?

No. Tokenless uses providers' visible websites rather than their APIs. Some providers still require you to sign in, and the capabilities available depend on what your account can access on the website.

### Does Tokenless send my entire project to a provider?

No. It sends the prompt, selected files, and task context needed for the delegated work. It does not automatically expose unrelated project files.

### Does every provider support every feature?

No. Tokenless enables only workflows verified against each provider's visible website. Unsupported or unverified capabilities stop with a clear error.

See the [Capability Matrix](docs/capability-matrix.md) for the current provider mappings and evidence rules.

### Why does Qwen sometimes report `provider_dns_unavailable`?

This error means Chromium could not resolve `chat.qwen.ai` before making an HTTP request. Tokenless records this Qwen-specific condition as a retryable suspected rate limit because intermittent provider-edge throttling is one possible cause, but marks it unconfirmed: a DNS failure alone is not proof of an HTTP rate limit.

Wait and retry the command manually, then check whether the hostname resolves on the current network. Do not count the failure as a passing or skipped provider E2E case, and do not use a test-only DNS override as acceptance evidence. A confirmed rate limit requires provider-visible evidence or an HTTP response such as `429` or `Retry-After`.
