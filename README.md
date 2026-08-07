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

For an existing global installation, `tokenless upgrade --json` is the canonical maintenance command; `tokenless install` is a lower-level runtime provisioning command and is not part of the normal user flow.

Then follow the interactive setup:

```bash
tokenless setup
```

Interactive setup first asks whether to use Anti-Detect mode. Declining selects the verified, platform-pinned Tokenless-managed Chrome for Testing—major 145 on Apple Silicon macOS and major 146 on Windows x64. Accepting Anti-Detect states that setup will install the platform-pinned CloakBrowser when needed. A clean profile remains the default for both targets. On Apple Silicon macOS only, setup also offers experimental opaque import from Google Chrome major 145 or Brave Chromium major 143/145 into managed Chrome for Testing 145 or CloakBrowser 145. The source browser must be selected explicitly, and setup scans only safe profile-directory and `Last Version` metadata. Edge, Chromium, Chrome for Testing, Arc, other source versions, and every Windows import combination are ineligible. Selecting a profile authorizes its opaque local copy without Tokenless inspecting authentication values; a successful open does not guarantee sign-in transfer. In non-interactive setup, Brave additionally requires `--import-browser brave`, every import requires `--consent-local-profile-copy`, explicit `--anti-detect` or `--browser cloak` authorizes Cloak installation, and a saved Cloak preference alone cannot start a download. Setup then lists all supported providers, keeps them all enabled by default, and lets you remove providers by replying with their numbers; press Enter to keep them all. It checks only the remaining providers, leaves one headed provider page open per provider in a concurrent background batch for visible sign-in review, and opens the local Tokenless dashboard in a reserved foreground tab. Reopen the dashboard at any time with:

```bash
tokenless dashboard
```

The dashboard is served only by the loopback daemon. It manages browser identities, profile-scoped provider routing, visible readiness and controls, capabilities, durable jobs, user handoffs, and redacted diagnostics. New setup offers only managed Chrome for Testing or CloakBrowser. System settings still inspect and accept explicit system-browser paths for existing or advanced configurations. Eligible macOS Google Chrome/Brave import is available when creating either managed target profile; an existing imported profile may be re-imported from its recorded source after consent. Browser JavaScript never receives the daemon bearer token, source filesystem paths, or provider credentials; `tokenless dashboard` uses a one-time bootstrap ticket to establish a short-lived local UI session.

Installing the package is only the first step. Complete `tokenless setup` before using Tokenless; it selects and verifies an exact browser runtime, creates or reuses a runtime-bound browser profile, prepares the local runtime, checks every enabled provider, and opens one review tab per provider. Normal setup always resolves to Tokenless-managed Chrome for Testing `145.0.7632.6` on Apple Silicon macOS or `146.0.7680.165` on Windows x64. Tokenless downloads the official checksum-pinned artifact during setup when it is not already cached; the browser binary is not embedded in the npm package. Anti-Detect mode explicitly selects CloakBrowser and is also available non-interactively as `--anti-detect`. Cloak is downloaded from its official release into the private Tokenless cache; its separately licensed binary is not included in the Tokenless npm package or release artifacts.

Every managed profile is bound to the browser runtime that created it. Tokenless does not silently open a managed profile with a different runtime family. A runtime-family change creates a clean profile. Experimental import accepts only the documented macOS Google Chrome 145 and Brave Chromium 143/145 sources for opaque filesystem copy into a new managed Chrome for Testing 145 or CloakBrowser 145 profile; Tokenless does not inspect or expose individual cookies, tokens, browser storage, or authentication values. Import may fail, and a successful open does not guarantee sign-in-state transfer. The managed browser then preserves any session it can use across jobs. Visible-History parity is recorded for the admitted Brave anchors and both targets, but authenticated Brave portability, Brave 144, and all Windows import combinations remain unverified.

On first setup, Tokenless selects English or Simplified Chinese from the system locale and saves the choice as `language` in `~/.tokenless/config.json`. English is the fallback. The preference controls the CLI, dashboard, and default provider response language; an explicit language request in the prompt still wins. Change it later in the dashboard or with `tokenless config --language en` or `tokenless config --language zh-CN`.

The config uses `providerWhitelist` for the provider routing boundary. Its default contains every non-disabled provider, including Gemini; setup lets you remove providers by number, and you can also change the list with `tokenless config --provider-whitelist ...` or in the dashboard.

For new and unconfigured homes, `auto` resolves to `managed-chromium`; setup caches the verified absolute path as `browserExecutablePath` in `$TOKENLESS_HOME/config.json`. Existing explicit system-browser selections remain supported and validate their cached path before scanning standard installation paths. Advanced users can set one with `tokenless config --browser chrome --browser-executable-path "/absolute/path/to/browser"`; managed Chrome for Testing and Cloak paths remain catalog-controlled under `$TOKENLESS_HOME/browser/runtimes`.

For browser capability evaluation, the config file accepts experimental `browserConnectionMode: "playwright" | "cdp"`; it defaults to `playwright`, has no CLI flag, and takes effect after the daemon restarts.

Requires Node.js 22.13+. The first browser-runtime targets are Apple Silicon macOS and x64 Windows; Windows x64 covers Intel and AMD processors. Windows remains prerelease until its real-hardware gates pass.

## Output Savings Measurement

Output savings measurement is enabled by default, but tokenizer installation is not part of setup. Setup, status checks, and opening the dashboard do not download or run the tokenizer. Tokenless lazily installs it only when the first visible assistant response needs measurement. You can also preinstall it, or turn measurement back on after opting out, from the dashboard's System page or with:

```bash
tokenless savings enable --json
```

The first measurement or explicit install downloads a checksum-pinned `tiktoken` 1.0.22 archive (10,611,708 bytes, about 10.1 MiB) and installs only the `o200k_base` WASM runtime and vocabulary (3,413,323 bytes, about 3.3 MiB) under `TOKENLESS_HOME`. This is a deterministic tokenizer, not a local AI model. It needs no GPU. Provider job completion durably queues the visible text and returns without awaiting installation or measurement; the existing daemon then runs each measurement at single concurrency in a short-lived Node.js subprocess. A local benchmark observed roughly 100 MB of transient memory; exact CPU time and peak memory vary by response and machine.

Tokenless measures only normalized visible assistant output. It does not estimate input tokens, intercept private provider APIs, inspect hidden reasoning, or claim provider billing accuracy. `o200k_base` provides one stable cross-provider estimate, so totals are labeled estimates and can differ from a provider's model-specific tokenizer. Measurements are attributed idempotently to the triggering durable job and response.

```bash
tokenless savings status --json
tokenless savings disable --json
tokenless savings clear --confirm-delete --json
tokenless savings uninstall --confirm-delete --json
```

Disabling discards queued text, prevents in-flight results from being saved, and keeps the verified runtime and history; the dashboard control also cancels daemon-local active work. The main dashboard keeps the savings section visible and grays it out until measurement is turned back on. Clearing discards pre-clear work and deletes measurement history without changing the toggle. Uninstalling disables the feature, discards work, and removes its local runtime. The tokenizer is not included in the Tokenless npm package; only a first enabled measurement or an explicit dashboard/CLI install downloads it.

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

### Why can macOS ask for access to Chrome or Chromium Safe Storage?

On macOS, Chromium-family browsers can encrypt cookies and other browser-managed sign-in state using material stored in Keychain. Tokenless lets a managed browser use its normal Keychain integration so a copied or subsequently signed-in profile can decrypt and preserve compatible state. Tokenless does not directly read, export, or log the Keychain item, cookies, passwords, or tokens, and does not send them to an agent or separate Tokenless service. The expected browser process requests local access directly and uses session cookies only in its ordinary requests to provider websites.

If you intentionally started Tokenless and the prompt names the browser runtime you selected during setup, approving access is expected. `Always Allow` can avoid repeat prompts, but it grants that browser persistent access to the named Keychain item; use it only when you recognize and trust the browser. Denying access can make an imported profile appear signed out. Do not approve an unexpected application or browser. Keychain approval also cannot make browser state portable across incompatible browser products, Safe Storage identities, or profile versions, so use a source profile compatible with the selected runtime.

### Does Tokenless send my entire project to a provider?

No. It sends the prompt, selected files, and task context needed for the delegated work. It does not automatically expose unrelated project files.

### Does every provider support every feature?

No. Tokenless enables only workflows verified against each provider's visible website. Unsupported or unverified capabilities stop with a clear error.

See the [Capability Matrix](docs/capability-matrix.md) for the current provider mappings and evidence rules.

### Why does Qwen sometimes report `provider_dns_unavailable`?

This error means Chromium could not resolve `chat.qwen.ai` before making an HTTP request. Tokenless records this Qwen-specific condition as a retryable suspected rate limit because intermittent provider-edge throttling is one possible cause, but marks it unconfirmed: a DNS failure alone is not proof of an HTTP rate limit.

Wait and retry the command manually, then check whether the hostname resolves on the current network. Do not count the failure as a passing or skipped provider E2E case, and do not use a test-only DNS override as acceptance evidence. A confirmed rate limit requires provider-visible evidence or an HTTP response such as `429` or `Retry-After`.
