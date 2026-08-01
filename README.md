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

Tokenless lets AI agents send work to ChatGPT, Claude, Gemini, Grok, Qwen, and experimental DeepSeek directly through their websites—reducing agent-side token use without provider API keys.

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

## Install and Setup

Install the CLI:

```bash
npm install --global tokenless@latest
```

Then follow the interactive setup:

```bash
tokenless setup
```

Interactive setup first asks whether to use Anti-Detect mode. When selected, it identifies and links to CloakBrowser, shows the exact platform pin, scans safe directory/version metadata for known Chrome, Brave, Edge, Arc, Chromium, and Chrome for Testing profiles, and marks exact version alignment before asking whether to continue with a clean Cloak-bound profile. It never imports the listed profiles. In non-interactive setup, explicit `--anti-detect` or `--browser cloak` is the equivalent clean-profile confirmation; a saved Cloak preference alone cannot start a download. Setup then asks which providers belong to the selected managed profile, checks only those providers, leaves one headed provider page open per provider for visible sign-in review, and opens the local Tokenless dashboard in a reserved tab. Reopen the dashboard at any time with:

```bash
tokenless dashboard
```

The dashboard is served only by the loopback daemon. It manages browser identities, profile-scoped provider routing, visible readiness and controls, capabilities, durable jobs, user handoffs, and redacted diagnostics. Browser JavaScript never receives the daemon bearer token or provider credentials; `tokenless dashboard` uses a one-time bootstrap ticket to establish a short-lived local UI session.

Installing the package is only the first step. Complete `tokenless setup` before using Tokenless; it selects and verifies an exact browser runtime, creates or reuses a clean runtime-bound browser profile, prepares the local runtime, checks every enabled provider, and opens one review tab per provider. The default `auto` choice uses an installed Chrome-family browser first. If none is available, setup lazily downloads Tokenless-managed Chrome for Testing 145. Anti-Detect mode selects CloakBrowser and is also available non-interactively as `--anti-detect`. Cloak is downloaded from its official release into the private Tokenless cache; its separately licensed binary is not included in the Tokenless npm package or release artifacts.

Every managed profile is bound to the browser runtime that created it. Tokenless does not silently open a system-browser profile with Cloak or the managed fallback. A runtime-family change creates a clean profile. Tokenless never copies an existing Chrome, Brave, or Cloak profile—or its cookies and authentication state—into a managed profile. Open the clean managed profile and sign in there; its browser-managed session then persists across jobs.

On first setup, Tokenless selects English or Simplified Chinese from the system locale and saves the choice as `language` in `~/.tokenless/config.json`. English is the fallback. The preference controls the CLI, dashboard, and default provider response language; an explicit language request in the prompt still wins. Change it later in the dashboard or with `tokenless config --language en` or `tokenless config --language zh-CN`.

For browser capability evaluation, the config file accepts experimental `browserConnectionMode: "playwright" | "cdp"`; it defaults to `playwright`, has no CLI flag, and takes effect after the daemon restarts.

Requires Node.js 22.13+. The first browser-runtime targets are Apple Silicon macOS and x64 Windows; Windows x64 covers Intel and AMD processors. Windows remains prerelease until its real-hardware gates pass.

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

tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review the attached proposal."
```

Tokenless combines explicit capabilities with requirements inferred from structured inputs. A normal run requires `conversation.chat`, attachments require `file.upload` plus their media-specific input capability, and `--workspace-mode native` requires `workspace.native`. The router selects one provider that satisfies the complete requirement set inside the configured provider scope. Candidate capabilities such as `research.deep` remain listed but fail before browser mutation until their full provider lifecycle has real E2E closure.

For an implicit provider run, Tokenless records evidence-backed alternatives and automatically tries the next eligible provider before requesting human help when a provider-scoped sign-in, CAPTCHA, rate-limit, or plan blocker occurs. Every alternative must satisfy the complete capability set for that run. Explicit `--provider`, exact-conversation continuation, provider-specific controls, and ambiguous post-submission state never switch providers automatically. `tokenless state --json` reports the remaining fallback plan and durable provider-attempt history.

Inspect provider-specific availability with `tokenless provider-action --action capability.inspect --provider <provider> --json`.

See [CLI Commands](COMMANDS.md), [Privacy](PRIVACY.md), and [Architecture](docs/architecture.md) for advanced options and implementation details.

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

### Why does Qwen sometimes report `provider_dns_unavailable`?

This error means Chromium could not resolve `chat.qwen.ai` before making an HTTP request. Tokenless records this Qwen-specific condition as a retryable suspected rate limit because intermittent provider-edge throttling is one possible cause, but marks it unconfirmed: a DNS failure alone is not proof of an HTTP rate limit.

Wait and retry the command manually, then check whether the hostname resolves on the current network. Do not count the failure as a passing or skipped provider E2E case, and do not use a test-only DNS override as acceptance evidence. A confirmed rate limit requires provider-visible evidence or an HTTP response such as `429` or `Retry-After`.
