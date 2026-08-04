# tokenless

## 0.4.1

### Patch Changes

- b4556a9: Fix `tokenless upgrade --json` rejecting its default empty capability argument state before starting the upgrade workflow.

## 0.4.0

### Minor Changes

- f676cd6: Add experimental signed-in Kimi chat, text-file upload, Web search with citations, model and thinking-effort controls, and provider-native Plugin and Skill controls with real Cloak capability gates.
- 2986940: Add profile-bound browser runtime selection with system-first auto discovery, a locked managed Chrome for Testing fallback, explicit Anti-Detect CloakBrowser setup, safe known-Chromium profile/version inventory before Cloak download, exact four-component Cloak compatibility classification, interactive or explicit non-interactive clean-profile confirmation, clean runtime-isolated profiles, exact daemon runtime errors, transactional artifact security verification, per-provider setup review tabs, keychain-neutral E2E Cloak launches, separate doctor profile/runtime compatibility checks, and gated real-browser acceptance coverage.
- bf24d96: Cache the verified browser executable path in persistent config, resolve concrete browser selections during setup and install, retry standard-path discovery after stale cache entries, and add CLI and dashboard recovery controls for custom system-browser paths. Interactive setup no longer asks users to choose a normal browser runtime. Anti-Detect setup discloses Cloak installation in its initial question and uses one clean-or-compatible-profile source choice, without redundant import, copy-consent, or final installation prompts. Opaque import remains limited to profiles whose Chromium version exactly matches the supported CloakBrowser runtime, with a final compatibility check at the copy boundary.
- f6dd951: Add experimental four-provider capability inspection, explicit Workspace fallback modes, trusted conversation continuation, and visible file-upload acceptance evidence.
- 1d44047: Add a canonical task-capability catalog, expose evidence-backed provider routes through `tokenless capabilities list`, and route normal runs by explicit and inferred capability requirements before browser mutation.
- 3f21056: Rank automatic provider fallback by the run's complete capability requirements, recheck live eligibility before mutation, reject under-declared routes, preserve a versioned context envelope, expose structured durable fallback evidence, and fail closed when file selection lacks visible provider acceptance.
- ef33467: Unify and simplify the local CLI-daemon HTTP boundary under one Tokenless Daemon API v1 OpenAPI contract: keep only public job and browser-runtime routes, run Playwright coordination in-process, require proof before bearer use, and remove unreleased legacy payloads and extension compatibility.
- d099d88: Add experimental Qwen guest-session support through the shared provider registry and visible Playwright workflow.
- 09f5f07: Add the experimental DeepSeek visible-session provider with safe navigation, sign-in detection, baseline chat controls, and evidence-gated capability classification.
- 3f21056: Add experimental DeepSeek visible provider support with exact Instant, Expert, and Vision mode selection, independent DeepThink and Search controls, hCaptcha detection, mode-aware capability inspection, and provenance-bound real-session DOM fixtures.
- b9421d3: Add an experimental signed-in Doubao adapter with visible account and free-tier inspection, Cloak-tested file upload, exact mode and coding-oriented Web skill controls, visible unavailable-state handling, prompt and response handling, and provider challenge detection.
- 50a20b5: Add the secure bilingual local web control plane, verified browser discovery and executable-path recovery, explicit opaque local profile import and re-import, profile-scoped provider and browser preferences, reserved dashboard tabs, setup handoff, dashboard CLI command, and browser-facing administration API.
- d3d78ce: Add English and Simplified Chinese CLI output selected during setup or through the persistent language config.
- e3c1ca0: Add opt-in output savings measurement with a lazily downloaded checksum-pinned local tokenizer, durable per-job attribution and aggregates, explicit CLI and bilingual dashboard controls, doctor diagnostics, and a real cross-platform runtime verification workflow.
- 3f21056: Add experimental Perplexity guest chat routing with live prompt submission, completed responses, normalized citations, and visible citation-link closure through a managed Cloak profile.
- bd4b7c9: Route implicit provider jobs through cached setup observations, report pre-submission errors when no cached provider is usable, and make doctor report provider usability plus normally stopped on-demand runtime state without treating either as damage.
- 3f21056: Add a packaged subscription-aware provider rate-limit catalog, durable submission history, cadence-based admission and deferral, in-scope provider fallback, visible cooldown handling, and `tokenless limits inspect` diagnostics.
- 2986940: Automatically fallback implicit runs across capability-compatible providers before human handoff while preserving one durable job and provider-attempt history.
- b9421d3: Rename persistent preferred provider configuration to `providerWhitelist`, default it to every non-disabled provider except Gemini, and migrate existing config on the next write.
- bb7bf16: Ship Tokenless as a pure JavaScript package with the TypeScript daemon embedded in the CLI package, removing platform-specific native runtime packages and standalone Playwright runner artifacts.
- 09f5f07: Preserve independent browser tabs for different providers, projects, and conversations unless a local job explicitly requests replacement.
- 7df255f: Add concise human-readable CLI output by default, `--verbose` diagnostics, and cross-platform `--color`/`--no-color` controls without changing JSON output.
- 7652158: Add Qwen-specific mode discovery and selection, including Deep Research variants and Auto/Thinking/Fast effort controls.
- 2f0f90f: Add real Claude and Grok native Project creation, exact reuse, instruction outcomes, and durable Project-scoped conversation identity. Use the canonical Qwen Studio chat surface with hydration-safe guest submission.
- df5edf7: Fail provider authentication checks closed on visible account controls and include visible provider usernames and subscription labels in managed profile output.
- 3f21056: Add experimental Z.ai guest chat routing with Cloak-verified prompt submission, completed visible responses, conversation mapping, and durable state.

### Patch Changes

- f676cd6: Keep headed automation tabs and navigation in the background, foregrounding the browser only for explicit user handoffs.
- f6dd951: Add case-sensitive `-P` profile and `-p` provider CLI shortcuts.
- 107ee7e: Add an experimental config-only Playwright/CDP browser connection mode and a two-mode real-browser capability matrix while preserving the existing default.
- 28cfb6d: Reorganize CLI help into concise canonical and advanced command groups.
- bacffef: Classify Claude Cloudflare human checks as a narrow live E2E release-gate known issue when the durable blocker code is structured as `visible_cloudflare_turnstile` or `visible_cloudflare_interstitial`.
- 21844cc: Publish a complete bilingual CLI command reference and link it from built-in help and public READMEs.
- 350fba0: Start the local daemon on demand with SQLite-backed dynamic endpoint discovery, recover leased and checkpointed jobs after restart, and add agent-scoped one-time outcome replay with durable full-result lookup.
- 0d438ec: Accept non-empty visible composer content after prompt input instead of requiring an exact DOM text match.
- f6dd951: Report Grok profiles as Free or SuperGrok from visible model entitlements and inventory redacted provider DOM fixtures by page URL.
- 0dc3e49: Add provider access/tier reporting and a provider-session state machine that runs ChatGPT and Gemini guest sessions, hands unauthenticated Claude and Grok jobs to the user before task input, and persists redacted structural DOM snapshots.
- 2986940: Preserve limited Chromium compatibility state when importing a browser profile with explicit user consent.
- 7df255f: Include Gemini in new default provider profiles and write real-provider E2E results as provider-grouped capability reports.
- b9421d3: Keep every production Chromium launch keychain-neutral with `--password-store=basic` and `--use-mock-keychain`, regardless of the configured browser executable or connection mode.
- 0d438ec: Keep managed-profile initialization user-run instead of triggering it from agent skills.
- f676cd6: Reuse an already approved provider page instead of refreshing it before every action, preserving visible conversation and control state across CLI jobs for the same task.
- 378ed4c: Keep one stable browser instance per active managed profile while removing the macOS-specific inspection launcher.
- 0d438ec: Wait for visible prompt input and submit controls, distinguish availability timeouts from action failures, and allow free or anonymous prompt surfaces without an authentication precheck.
- 1d44047: Allow `tokenless profiles open` to launch a managed profile without selecting or navigating to a provider unless `--provider` is passed.
- abc58bb: Record intermittent Qwen DNS failures as retryable suspected rate limits without claiming confirmed provider throttling, and document the distinction and recovery steps.
- f676cd6: Wait for Qwen's visible Deep Research variant menu to settle and scroll the selected option into view before clicking it.
- bcabe9a: Gracefully restart a proof-verified stale local daemon from the current CLI package when its package version or control API revision no longer matches.
- 0dc3e49: Make ordinary daemon reuse depend on verified ready identity plus the exact package version, and let `tokenless setup` reconcile same-home version drift only after proof verification.
- df5edf7: Check each provider's setup sign-in status once and report it without opening a login handoff or retrying.
- 0d438ec: Make `tokenless setup` report the local CLI version against npm latest and reconcile installed-runtime drift after verified same-home ready identity.
- 0dc3e49: Simplify daemon readiness to the same-home proof plus exact package version, and keep shutdown on the bearer-authenticated control endpoint.
- 28cfb6d: Negotiate daemon reuse independently from package versions, and add `tokenless daemon stop` with same-home ready verification followed by bearer-authenticated graceful self-shutdown that waits for the daemon-managed browser to release its profile before returning.
- 4317e00: Reject unknown and command-incompatible CLI options before dispatch, include command usage in human and JSON errors, and add common per-command `-h`/`--help`.
- 77ebc9f: Unify setup and upgrade maintenance so the verified current CLI always upserts global Tokenless skills and reconciles its matching TypeScript daemon.
- bf24d96: Move provider entry points and known page URL patterns into one navigation catalog, and use `https://z.ai/chat` as the Z.ai entry while retaining its official chat runtime origin.

## 0.3.0

### Minor Changes

- 462123b: Add browser visibility policy support to Tokenless config and managed Playwright job requests, including durable resume after a headless job parks for user handoff.

### Patch Changes

- 6d52df5: Ship the current Tokenless reliability release as one patch:

  - Retire the browser extension and Native Messaging host, leaving the managed Playwright daemon as the active runtime.
  - Remove the experimental direct runtime, direct broker, account/project routing commands, direct public exports, and direct-only documentation so managed Playwright through the authenticated local daemon is the only execution path.
  - Provision and verify the local daemon before provider sign-in, restart only process-correlated stale daemons, and keep doctor diagnostics read-only.
  - Add prompt-free `tokenless upgrade` with concise human progress and structured `--json` output to update the global CLI, refresh Tokenless agent skills, reconcile the packaged daemon through the verified new CLI, and report its final doctor result.
  - Keep animated setup progress stable on one terminal line, including in narrow and hosted terminals.
  - Make setup check every supported visible provider, preserve ChatGPT as the default run provider, reject obsolete setup-only provider filters, and document the supported browser-profile import scope.

- 08000f1: Enable Chromium sandboxing for managed visible browser sessions so Chrome no longer launches with the unsupported `--no-sandbox` flag.

## 0.2.0

### Minor Changes

- 551561f: Add Grok as a visible browser-session provider across CLI setup, provider preferences, and extension routing.

## 0.1.2

### Patch Changes

- 3900934: Publish the platform-native daemon and Native Messaging runtime packages required by the universal CLI.
