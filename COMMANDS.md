[中文](COMMANDS.zh-CN.md) | [English](COMMANDS.md)

# Tokenless CLI Command Reference

This document is the public inventory of the `tokenless` command-line interface. It separates everyday workflows from lower-level controls and calls out commands that open provider pages, update local state, or only read cached data.

## Command Map

| Command | Purpose | Provider access |
| --- | --- | --- |
| `tokenless help` | Show the built-in command summary. | None |
| `tokenless --version` | Print the installed CLI version. | None |
| `tokenless install` | Low-level local runtime provisioning; use `tokenless upgrade` for normal maintenance. | None |
| `tokenless setup` | Configure skills, browser, profiles, daemon, and one-time provider sign-in checks. | Yes |
| `tokenless dashboard` | Open or mint a one-time URL for the authenticated local web control plane. | None |
| `tokenless doctor` | Read local configuration and runtime health without refreshing providers. | None |
| `tokenless config` | Read or update persistent Tokenless configuration. | None |
| `tokenless upgrade` | Upgrade the global CLI, skills, local runtime, and run doctor. | None |
| `tokenless profiles discover` | Read safe directory/version metadata for known Chromium profiles and classify alignment with the platform Cloak pin. | None |
| `tokenless profiles add` | Create a clean managed browser profile. | None |
| `tokenless profiles list` | List profiles and their last saved provider observations. | None |
| `tokenless profiles status` | Check one provider live and save the observation to the profile registry. | Yes |
| `tokenless profiles open` | Open a managed profile headed, optionally navigating to one provider. | Optional |
| `tokenless profiles set-default` | Select the default managed profile. | None |
| `tokenless profiles reset` | Legacy compatibility command; profile copying is disabled. | None |
| `tokenless profiles clear` | Delete one or all managed profiles as a human maintenance action. | None |
| `tokenless profiles remove` | Delete one managed profile with explicit confirmation. | None |
| `tokenless capabilities list` | List canonical task capabilities and evidence-backed provider routes. | None |
| `tokenless limits inspect` | Inspect the next-prompt provider/profile capacity estimate from the packaged catalog and local job history. | None |
| `tokenless savings <status\|enable\|disable\|clear\|uninstall>` | Manage optional local output savings measurement and its lazily downloaded tokenizer. | None |
| `tokenless run` | Send a prompt and optional files through a visible provider session. | Yes |
| `tokenless replay` | Report previously unseen daemon outcome summaries for one agent recipient. | None |
| `tokenless state` | Inspect durable daemon job state. | None |
| `tokenless resume` | Resume a job waiting for user action in a headed browser. | Yes |
| `tokenless cancel` | Cancel a daemon job and confirm its canceled state. | None |
| `tokenless provider-status` | Perform a live provider authentication check. | Yes |
| `tokenless provider-controls` | Inspect visible model and effort controls. | Yes |
| `tokenless provider-configure` | Select exact visible model or effort labels. | Yes |
| `tokenless provider-action` | Execute one low-level visible provider action. | Yes |
| `tokenless chatgpt-controls` | Inspect ChatGPT model and effort controls. | Yes |
| `tokenless chatgpt-configure` | Configure ChatGPT-specific visible controls. | Yes |
| `tokenless snapshot-dom` | Capture and persist a sanitized provider DOM snapshot. | Yes |
| `tokenless daemon stop` | Gracefully stop a compatible local daemon. | None |
| `tokenless prompt` | Build a shareable Tokenless prompt without submitting it. | None |

## Conventions

### Provider values

Provider values are:

```text
chatgpt
claude
gemini
grok
qwen
deepseek
perplexity
zai
doubao
```

ChatGPT, Claude, Gemini, and Grok are supported providers. Qwen / 千问, DeepSeek, Perplexity, Z.ai / GLM, and Doubao / 豆包 are experimental: only their evidence-backed routes and controls are advertised, while unproven continuation and optional capabilities remain unavailable or unknown.

Runtime browser values are `auto`, `chrome`, `chrome-for-testing`, `chromium`, `edge`, `arc`, `brave`, `managed-chromium`, and `cloak`. `auto` prefers an installed system browser and uses the locked managed fallback only when none exists. `cloak` is explicit opt-in. New Tokenless profiles are clean by default and runtime-bound. An explicitly selected local Chromium profile can instead be copied after `--consent-local-profile-copy`; Tokenless treats its contents as an opaque local filesystem tree.

### Short options

Short options are case-sensitive:

- `-P <slug>` is short for `--profile <slug>`.
- `-p <provider>` is short for `--provider <provider>`.
- `-f` is short for `--fresh` during setup.
- `-v` is short for `--verbose`.
- `-V` is short for `--version`.

### Common execution options

These options are available where the command needs the corresponding runtime behavior:

| Option | Meaning |
| --- | --- |
| `-h`, `--help` | Show usage for the selected command or subcommand. |
| `--json` | Write the final result as structured JSON to stdout. Live status events remain on stderr unless `--quiet` is used. |
| `-v`, `--verbose` | Keep the final human result concise, but show live status events and a structured diagnostic details block on stderr. JSON stdout is unchanged. |
| `--quiet` | Suppress live status events. |
| `--color` | Force ANSI colors for human-readable output. It has no effect on JSON stdout. |
| `--no-color` | Disable ANSI colors, including when output is attached to a terminal. |
| `--home <path>` | Use a non-default Tokenless state directory. |
| `--daemon-url <url>` | Set the preferred loopback daemon URL. If its port is occupied, Tokenless may bind the next free port and records the actual endpoint in SQLite. |
| `--agent-kind <kind>` | Address a job or replay drain to an explicit agent kind; use with `--agent-session-id`. |
| `--agent-session-id <id>` | Address a job or replay drain to an explicit agent session; use with `--agent-kind`. |
| `--browser-visibility <auto\|headed\|headless>` | Choose the browser visibility policy. |
| `--timeout-ms <ms>` | Override the command or job wait timeout. |
| `--daemon-start-timeout-ms <ms>` | Override daemon startup waiting. |
| `--runner-heartbeat-timeout-ms <ms>` | Accepted for compatibility; the embedded Playwright runtime ignores it. |
| `--cancel-timeout-ms <ms>` | Override cancellation confirmation waiting. |
| `--target-url <url>` | Start from a provider-approved URL on the selected provider domain. |

Human output is succinct by default: command results use a one-line summary when possible, while prompt text and provider responses retain their content. Routine status events are shown only with `--verbose` (or when JSON output is requested); `--quiet` suppresses them. Color is automatic only for a color-capable TTY, and is disabled for pipes, redirects, `NO_COLOR`, `TERM=dumb`, and JSON. Node's terminal detection covers macOS terminals and modern Windows Terminal/Console hosts; use `--no-color` for legacy terminals or strict log capture.

Not every common option is accepted by every command. The command sections below list the meaningful options for each workflow.

## Installation, Setup, and Maintenance

### `tokenless help`

Prints the concise built-in usage guide and the link to this reference.

```bash
tokenless help
tokenless run --help
tokenless profiles status --help
```

Use `-h` or `--help` after any command or subcommand to print its accepted options before doing work.

### `tokenless --version`

Prints the installed package version.

```bash
tokenless --version
tokenless -V
```

### `tokenless install` (low-level compatibility)

Resolves or installs the selected exact browser runtime, saves the runtime preference, upserts the required global Tokenless agent skills, verifies the packaged TypeScript daemon runtime, and ensures that the local daemon matches the installed CLI version and control API revision. Use `tokenless upgrade` for the normal user-facing maintenance workflow; this command remains available for low-level runtime provisioning and compatibility automation. A proof-verified daemon for the same Tokenless home is gracefully restarted from the current CLI package when either value is stale; foreign or unverified listeners are never stopped.

```bash
tokenless install --browser auto --json
tokenless install --browser cloak --json
tokenless install --browsers chrome,brave --json
```

Main options:

- `--browser <browser>` selects one browser preference. Managed selections download only during install or setup.
- `--browsers <list>` verifies a comma-separated browser list.
- `--repair-browser` replaces the explicitly selected managed-Chromium or Cloak cache only after a newly downloaded replacement passes every verification step; a failed repair restores the previous cache.
- `--daemon-url`, `--daemon-start-timeout-ms`, `--home`, and `--json` control the local runtime.

This command does not update the global npm CLI, configure a managed profile, or check provider sign-in. Run `tokenless setup` afterward when using it directly.

### `tokenless setup`

Runs the complete onboarding flow: discovers system and cached runtimes, resolves or installs the exact selected browser, creates or selects a runtime-compatible managed profile, saves the verified selection, upserts the global Tokenless agent skills, reconciles the daemon to the installed CLI version, and performs one live sign-in check for every enabled provider. No browser is downloaded by npm postinstall, daemon startup, or ordinary job execution. If no language preference exists, setup detects the system locale, selects `zh-CN` for Chinese locales or `en` otherwise, and persists it in config.

Interactive setup:

```bash
tokenless setup
```

Create or reuse a clean profile non-interactively:

```bash
tokenless setup --profile default --fresh --json
tokenless setup --anti-detect --profile cloak-default --fresh --json
tokenless setup --browser managed-chromium --profile managed-default --fresh --json
```

Main options:

- `--profile <slug>` selects or names the managed profile.
- `--anti-detect` explicitly selects the catalog-pinned CloakBrowser runtime and confirms a clean Cloak-bound profile in non-interactive setup. Explicit `--browser cloak` carries the same confirmation; a stored Cloak preference alone fails before download.
- `--provider-whitelist <list>` selects provider membership for that profile during non-interactive setup.
- `--no-open` completes setup without opening the dashboard.
- `--browser <browser>` selects `auto`, one exact system browser, `managed-chromium`, or `cloak`.
- `--no-browser-download` fails instead of downloading a missing managed runtime.
- `--repair-browser` explicitly reinstalls a selected `managed-chromium` or `cloak` runtime. It cannot be combined with `--no-browser-download`.
- `--fresh` or `-f` creates a clean managed profile.
- `--import-browser-profile <key> --consent-local-profile-copy` copies one explicitly selected local Chromium profile into the managed profile without parsing authentication values.
- `--defaults` selects non-interactive defaults.
- `--label <name>` sets the profile display label.
- `--set-default` makes the selected profile the default.

`auto` is the first-run default and prefers an installed Chrome, Brave, Edge, Arc, Chromium, or Chrome for Testing executable. Interactive setup asks whether to use Anti-Detect; declining does not open a separate browser-runtime picker. Normal mode follows an explicit `--browser`, then the saved concrete preference, then deterministic automatic discovery. Setup resolves the result to a concrete `browser` plus a verified `browserExecutablePath` in `config.json`. Later launches verify that cached executable first and scan standard installation paths only when the cache is missing or no longer runnable; a successful fallback refreshes the cache. If no supported system browser exists, setup downloads the locked Chrome for Testing 145 artifact into `$TOKENLESS_HOME/browser/runtimes`. An explicit missing system-browser choice fails with the exact config command and dashboard field needed to supply a path. Cloak is downloaded only after explicit selection, uses the official platform-specific release pin, and is never bundled with Tokenless. The first runtime targets are Apple Silicon macOS and Windows x64 (Intel and AMD); Windows remains prerelease until its real-hardware gates pass.

`browserExecutablePath` may point outside `TOKENLESS_HOME` only for an explicitly selected system browser. Paths for `managed-chromium` and `cloak` are derived from the catalog-pinned runtime under `$TOKENLESS_HOME/browser/runtimes`; an arbitrary config value cannot replace or bypass that managed runtime.

The Anti-Detect question states that accepting it will download and install the verified, platform-pinned CloakBrowser under `TOKENLESS_HOME` when needed; there is no later installation confirmation. After Anti-Detect is selected, setup does not run system-browser executable discovery for runtime selection. It links to the official CloakBrowser project, shows the exact platform artifact and Chromium version, and scans known Chrome, Brave, Edge, Arc, Chromium, and Chrome for Testing profile directories. Discovery reads only the directory key and `Last Version` and classifies an exact four-component match. When compatible profiles exist, setup presents one choice containing `Start clean` and the compatible profile sources. Selecting a profile explicitly authorizes its opaque local copy; there are no separate import or copy-consent questions. When none align, setup skips the source choice and uses a clean profile. An explicitly requested incompatible or unknown-version import fails before download instead of being silently ignored. The installer then downloads, verifies, extracts, version-checks, and smoke-launches Cloak; setup immediately persists `browser: "cloak"` and its managed `browserExecutablePath`. Copying remains opaque: Tokenless does not parse `Local State`, cookies, browser storage, or authentication values. Non-interactive import still requires `--consent-local-profile-copy` because no visible profile-source selection occurred.

Managed profiles record a runtime binding. Setup will not open a profile with a different runtime family or with an older browser than the version that created it. Changing runtime family normally creates a clean profile; an explicit import can populate the new runtime-bound profile from a selected local Chromium profile. The managed profile then preserves its browser-managed session across jobs.

Interactive `setup` asks which providers belong to the selected profile. Non-interactive setup uses `--provider-whitelist`, the existing profile scope, or the persisted default whitelist. Guest access, signed-out pages, unknown state, and sign-in-required pages are recorded observations rather than setup failures; only technical check failures make setup fail. After every setup, Tokenless leaves one headed review tab open for each enabled provider so the user can inspect sign-in state directly. Unless `--json`, `--defaults`, or `--no-open` suppresses an interactive handoff, setup also opens the local dashboard.

The default `providerWhitelist` contains every non-disabled provider except Gemini. Gemini remains available and can be added explicitly with `--provider-whitelist` or through the dashboard.

### `tokenless dashboard`

Starts or discovers the same-home daemon, mints a single-use 60-second bootstrap ticket, and opens one reserved dashboard tab in the selected managed profile:

```bash
tokenless dashboard
tokenless dashboard --profile work
tokenless dashboard --profile work --no-open --json
```

`--no-open` returns the one-time loopback bootstrap URL without launching a browser. The URL redirects immediately to `/ui/` after use and cannot be reused. The resulting browser session is short-lived, stored in an `HttpOnly` `SameSite=Strict` cookie, and uses exact-Origin plus CSRF checks for mutations. The dashboard never receives the daemon bearer token, provider cookies, browser storage, Keychain data, raw DOM, claim tokens, checkpoints, or private filesystem paths.

The dashboard provides Overview, Profiles, Providers, Capabilities, Jobs, and System/Diagnostics areas. Provider membership, visibility, role label, and an optional credential-free HTTP/HTTPS/SOCKS5 proxy are profile scoped. CLI recovery equivalents remain available:

```bash
tokenless config --profile work --provider-whitelist chatgpt,claude --browser-visibility headed --json
tokenless config --profile work --proxy-server socks5://127.0.0.1:1080 --proxy-bypass localhost --json
tokenless profiles open --profile work --json
tokenless state --profile work --json
```

### `tokenless doctor`

Performs a read-only health report over Node.js, installed skills, packaged runtime, daemon identity and version, embedded Playwright runtime, browser preference, resolved runtime family and exact executable version, checksum state, default profile/runtime compatibility, configuration, and cached provider readiness.

```bash
tokenless doctor --json
```

`doctor` does not open provider pages, refresh authentication, start the daemon, or repair state. `checks.managedProfile.ok` reports registry/profile health, while `checks.profileRuntime.ok` independently reports whether that profile has a compatible resolvable browser binding. Provider readiness comes from the last saved profile observation. `checks.providerReadiness.ok` reports whether configured providers have recorded observations; `usableProviders` lists the cached providers eligible for implicit routing. Because the daemon is on demand, a normally stopped daemon and embedded browser runtime are reported as healthy stopped state rather than installation damage.

Main options: `--browser`, `--daemon-url`, `--home`, and `--json`.

### `tokenless config`

Reads persistent configuration when called without configuration options:

```bash
tokenless config --json
```

Updates one or more persistent values when options are supplied:

```bash
tokenless config \
  --language zh-CN \
  --provider-whitelist chatgpt,claude,gemini,grok,qwen \
  --browser chrome \
  --browser-executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --browser-visibility auto \
  --json
```

Configurable values:

- `--language <en|zh-CN>`
- `--provider-whitelist <list>`
- `--browser <browser>`
- `--browser-executable-path <absolute-path>` for an explicit system browser
- `--clear-browser-executable-path` to force discovery on the next resolution
- `--browser-visibility <auto|headed|headless>`
- `--proxy-server <http|https|socks5-url>` with optional `--proxy-bypass <comma-separated-list>`
- `--clear-proxy`
- `--daemon-url <loopback-url>`
- `--home <path>`

Add `--profile <slug>` to scope `--provider-whitelist`, `--browser-visibility`, and credential-free proxy settings to one managed profile. Proxy options require `--profile`; `--clear-proxy` removes that profile's endpoint. Global `providerWhitelist` remains a compatibility union for older callers, while routing reads the selected profile's membership.

The persisted JSON key is `providerWhitelist`. Tokenless still reads the legacy `preferredProviders` key and rewrites it as `providerWhitelist` on the next config update. The undocumented legacy `--preferred-providers` flag remains accepted as an alias during migration.

The config shape is:

```json
{
  "protocol": "tokenless.config.v1",
  "updatedAt": "2026-08-02T02:09:40.254Z",
  "providerWhitelist": [
    "chatgpt",
    "claude",
    "grok",
    "qwen",
    "deepseek",
    "perplexity",
    "zai",
    "doubao"
  ],
  "profilePreferences": {},
  "browser": "chrome",
  "browserExecutablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "browserConnectionMode": "playwright",
  "browserVisibility": "auto",
  "daemonUrl": null,
  "language": "en"
}
```

`browserExecutablePath` is a verified cache, not an immutable override: Tokenless executes the browser's version command to validate it, falls back to standard-path discovery if validation fails, and rewrites the cache after a successful fallback. If both checks fail, use the CLI flag above or paste an absolute path into **System → Browser executable path** in the dashboard. The dashboard exposes only whether a path is configured; it does not send the private path back to browser JavaScript.

Human-readable command output and the default provider response language follow `language`; an explicit language request in the prompt takes precedence. Command names, flags, JSON keys, error codes, status values, and other integration terms remain stable. `daemonUrl` is the preferred start endpoint, not mutable runtime status. Tokenless never rewrites it when that port is busy; the daemon records its actual bound endpoint in the SQLite runtime-state row.

The config file also accepts the experimental `browserConnectionMode` value `playwright` or `cdp`; omitted values default to `playwright`. It intentionally has no CLI flag. Edit the JSON value only for capability evaluation, then restart the daemon. CDP does not change the selected profile, browser runtime, visibility policy, or provider mappings.

### `tokenless upgrade`

Runs the canonical user-facing maintenance pipeline. It updates the global npm CLI, resolves and verifies the installed CLI, invokes that new CLI's shared maintenance module to upsert global agent skills and reconcile the matching daemon, then runs doctor. Use this instead of `tokenless install` for normal installation maintenance and upgrades.

```bash
tokenless upgrade
tokenless upgrade --json
```

Accepted options are `--json`, `--home`, `--daemon-url`, `--browser`, `--browsers`, and `--daemon-start-timeout-ms`.

### `tokenless daemon stop`

Gracefully stops a compatible daemon after verifying its identity.

```bash
tokenless daemon stop --json
```

Options: `--home`, `--daemon-url`, `--timeout-ms`, and `--json`.

The command discovers the actual endpoint from SQLite and does not kill an unverified or incompatible process merely because it occupies the preferred port.

## Managed Profiles

A managed profile is one persistent local browser identity. One profile may hold sessions for all enabled providers.

### `tokenless profiles discover`

Reads safe profile directory/version metadata for Chrome, Brave, Edge, Arc, Chromium, or Chrome for Testing without copying or modifying browser data. Each profile reports `aligned`, `not_aligned`, or `unknown` against the current platform Cloak pin. Discovery does not make a profile importable and does not parse `Local State`.

```bash
tokenless profiles discover --browser all --json
tokenless profiles discover --browser edge --browser-user-data-dir /path/to/user-data --json
```

### `tokenless profiles add`

Creates a clean managed profile or, after explicit consent, copies a selected local Chromium profile:

```bash
tokenless profiles add -P work --label "Work" --set-default --json
tokenless profiles add -P cloak-work --browser cloak --import-browser-profile Default --consent-local-profile-copy --set-default --json
```

The copy remains local and opaque. Tokenless copies filesystem entries but does not inspect or report cookies, storage, passwords, tokens, or Keychain data.

### `tokenless profiles list`

Reads the profile registry and returns every managed profile.

```bash
tokenless profiles list
tokenless profiles list --json
```

This command is fast, read-only, and has no browser side effects. Provider fields are cached observations; use each provider's `checkedAt` to judge freshness.

### `tokenless profiles status`

Performs a live authentication check against one provider, then writes `auth`, visible username, visible subscription, and a new `checkedAt` value to the selected profile.

```bash
tokenless profiles status -P work -p chatgpt --json
```

If omitted, the profile resolves to the configured default and the provider falls back to the environment or ChatGPT.

### `tokenless profiles open`

Opens the selected managed profile with a headed browser. Without `--provider`, Tokenless does not resolve `TOKENLESS_PROVIDER`, does not select ChatGPT or any other provider, and does not navigate; Chromium shows the profile's natural initial, default, or restored page. With `--provider`, Tokenless opens that provider and verifies navigation.

This command is an explicit user handoff, so it may foreground the selected profile or provider tab. Automated jobs, status checks, and navigation diagnostics create and operate tabs in the background; they foreground a page only when visible user action is required.

```bash
tokenless profiles open -P work --json
tokenless profiles open -P work -p claude --json
```

Use the provider-less form for user-controlled browser maintenance, account switching, or inspecting the managed profile. Use the provider form for sign-in, CAPTCHA, MFA, consent, or provider-specific account switching. It does not replace `profiles status`; run the status command afterward to save a fresh observation.

### `tokenless profiles set-default`

Makes one registered profile the default.

```bash
tokenless profiles set-default -P work --json
```

### `tokenless profiles reset`

Replaces an imported managed profile with a fresh opaque copy from its recorded local source. Explicit consent is required again.

```bash
tokenless profiles reset -P work --consent-local-profile-copy --json
```

### `tokenless profiles clear`

Quiesces the embedded Playwright runtime and deletes either one managed profile or every managed profile:

```bash
tokenless profiles clear -P work
tokenless profiles clear --all
```

Exactly one of `--profile` and `--all` is required. This human maintenance command does not accept `--json`.

### `tokenless profiles remove`

Deletes one managed profile through the structured, explicitly confirmed form:

```bash
tokenless profiles remove -P work --confirm-delete --json
```

`--confirm-delete` is mandatory. Removing or clearing a managed profile deletes only its Tokenless-managed browser data; it does not modify any system-browser profile.

## Running Work and Managing Jobs

### `tokenless capabilities list`

Returns the versioned canonical task-capability catalog without opening a browser:

See the [Capability Matrix](docs/capability-matrix.md) for capability semantics, provider mappings, support states, and the extension process.

```bash
tokenless capabilities list --json
```

Each entry describes the caller outcome, parameter schema, lifecycle, side effects, required evidence, output kinds, stability, and declared provider routes. `routeable: true` means at least one checked-in provider strategy has complete implementation and real-provider E2E evidence. Candidate entries remain discoverable with `routeable: false`; they cannot be selected for a run.

Provider controls such as `model.choice`, `effort.choice`, `qwen.mode`, `doubao.mode`, and `doubao.skill` are intentionally absent. They remain provider adapter details rather than canonical caller outcomes.

### `tokenless limits inspect`

Inspect the next prompt against the observed profile subscription, packaged provider knowledge, and immutable local submission history:

```sh
tokenless limits inspect --profile default --provider chatgpt --json
```

The projection reports the matched catalog plan and rules, local usage, published and effective allowance, estimated remaining units, cadence, burst allowance, decision, and `eligibleAt`. `unknown` means Tokenless has no enforceable official number and will allow execution; it does not mean unlimited provider capacity. This command is local and read-only and does not open or submit to a provider website.

### `tokenless savings`

Manage the optional output-only savings estimate. It is disabled by default and setup never enables or downloads it.

```bash
tokenless savings status --json
tokenless savings enable --json
tokenless savings disable --json
tokenless savings clear --confirm-delete --json
tokenless savings uninstall --confirm-delete --json
```

`enable` lazily downloads and verifies the pinned `o200k_base` WASM tokenizer before setting `outputSavings.enabled` to `true`. `disable` stops future measurements while retaining history and the runtime. `clear` removes the durable measurement history, and `uninstall` disables measurement and removes the runtime; both destructive operations require `--confirm-delete`. `status` is read-only with respect to configuration and tokenizer installation. None of these commands opens a provider page.

Measurements cover only normalized visible assistant output and are attributed to the triggering durable job and response. They are stable cross-provider estimates, not provider billing values; input tokens, hidden reasoning, and private backend traffic are excluded.

### `tokenless run`

Builds a managed Playwright job, sends a prompt through the selected visible provider session, and normally waits for the correlated response.

```bash
tokenless run \
  -P default \
  -p chatgpt \
  --prompt "Review this proposal." \
  --json
```

Provider selection:

- Explicit `--provider <provider>` or `TOKENLESS_PROVIDER` is exact and is not replaced based on cached usability.
- `--capability <capability>` is repeatable and requests canonical caller outcomes rather than provider-specific controls.
- Tokenless merges explicit capabilities with structural inference: a normal `submit_and_read` run requires `conversation.chat`, `--attach-file` requires `file.upload` plus `image.input`, `audio.input`, or `video.input` when applicable, and `--workspace-mode native` requires `workspace.native`.
- When no provider is explicit, the configured provider list filters membership. Tokenless then filters for providers that satisfy the full implication-expanded requirement set and ranks routes by fresh cached eligibility and evidence maturity (`supported` before `experimental`); configured list position is the final tie-breaker and cannot override those stronger signals. Stale usable observations remain `unchecked` until the runner performs its live read-only preflight.
- An explicit provider that cannot satisfy the full requirement set fails before daemon submission instead of silently switching.
- Unknown and sign-in-required observations are not usable for implicit routing. If no cached provider is usable, the CLI returns `provider_unavailable` with provider observation context before creating a daemon job.
- A known capability with no complete route returns `task_capability_route_unavailable` before browser mutation. `--capability` currently requires the normal `submit_and_read` action.
- Successful submissions return and durably store `capabilityRoute`, including normalized requirements, selected strategies, support level, evidence identifiers, and runtime eligibility; `tokenless state` returns the same route.
- Implicit `submit_and_read` runs may persist an automatic fallback plan. Before mutation, every attempt rechecks known local provider capacity, the visible session, and capability-specific UI without a probe prompt. Classified safe pre-submit capacity, auth, CAPTCHA, rate/plan, maintenance, region, navigation, stable-surface, and capability-availability failures requeue the same job on the next ranked provider only when it satisfies the identical complete requirements and all completed mutations are reconstructable. Exact or mapped continuation, explicit providers, provider-specific controls, non-reconstructable mutations, ambiguous external state, and post-submission failures never switch automatically. JSON state includes ranked `fallback.routes`, structured stop reasons, and `providerAttempts`.
- The job validator independently derives capabilities from actions, attachment MIME types, and native workspace intent, so internal or agent callers cannot under-declare a fallback requirement. Routed jobs carry `tokenless.context-envelope.v1`; its instructions, references, output/constraint contract, optional upstream state, and delivery hashes are replayed unchanged on every attempt. JSON state exposes only a redacted envelope summary.

Prompt input:

- Use exactly one of `--prompt <text>` or `--prompt-file <path>`.
- `--project-root <path>` defines the safe root for shareable file context.
- Repeat `--file <path>` to embed text from files inside the project root into the generated prompt.
- Use `--context <text>` or `--context-file <path>` for additional shareable turn context.
- Repeat `--attach-file <path>` to upload real files through the provider page. `--file` and `--attach-file` are different operations.

Provider controls:

- `--model <exact-visible-label>` selects a visible model before submission.
- `--effort <exact-visible-label>` selects visible reasoning or effort.
- `--thinking-effort <label>` is an alternative effort option.
- `--qwen-mode <exact-visible-label>` selects a Qwen-specific composer mode.
- `--qwen-mode-variant <exact-visible-label>` selects a visible variant of that Qwen mode and requires `--qwen-mode`.
- `--deepseek-mode <Instant|Expert|Vision>` selects an exact DeepSeek mode.
- `--deepseek-deepthink <on|off>` controls DeepThink in the active DeepSeek mode.
- `--deepseek-search <on|off>` controls Search; the control is available only in DeepSeek Instant mode.
- DeepSeek canonical requirements prepare their required controls before mutation: `search.web` selects Instant and enables Search, `reasoning.extended` enables DeepThink, and `image.input` selects Vision. Explicit incompatible combinations fail before changing the page.
- `--kimi-search <auto|off>` selects Kimi Web search behavior.
- `--kimi-plugin <exact-visible-label>` selects one exact Kimi Plugin.
- `--kimi-skill <exact-visible-label>` selects one exact Kimi Skill.
- `--browser-visibility <auto|headed|headless>` overrides the configured visibility policy.

Identity and continuity:

- `--task-id <id>` supplies durable task identity.
- `--idempotency-key <id>` supplies the same identity when no task ID is used.
- `--project-name <name>` and `--chat-name <name>` contribute to derived task identity.
- `--workspace-mode <auto|native|conversation>` explicitly requests Workspace handling and requires `--project-name`.
- `--project-instructions <text>` or `--project-instructions-file <path>` supplies optional Workspace instructions.
- `--agent-kind <kind>` and `--agent-session-id <id>` address the job to one agent recipient. Both are required together; the same values may come from `TOKENLESS_AGENT_KIND` and `TOKENLESS_AGENT_SESSION_ID`.

Execution:

- `--no-wait` submits and returns without waiting for the result.
- `--long-running` uses the long-running wait budget and cannot be combined with `--no-wait`.
- `--timeout-ms`, `--cancel-timeout-ms`, and `--daemon-start-timeout-ms` override execution timing. `--runner-heartbeat-timeout-ms` remains accepted for compatibility but no longer controls a standalone runner.
- `--target-url <url>` selects an approved starting URL on the provider domain.

Workspace modes:

- Routed `run` requests using `auto` or `native` require the canonical `workspace.native` capability. No provider route is currently advertised, so these requests fail before browser mutation until the native Project release gate is complete.
- The lower-level Claude and Grok adapters implement experimental visible native Project create/reuse behavior for their explicit real-provider acceptance suite; implementation alone is not a router support claim.
- After `workspace.native` becomes routeable, `native` will require exact native Project creation or reuse and will never degrade to conversation scope. Duplicate exact visible names fail closed.
- `conversation` requires the conversation-scoped strategy; cross-process restoration is supported only where the real-provider capability matrix proves it.
- Native results report `created` or `reused`, canonical provider resource identity, provider/profile scope, and the instruction outcome. Conversation results report `fallback`.
- Project and task conversation targets are persisted as exact SQLite mappings rather than recovered by scanning historical job results.

### `tokenless replay`

Atomically reports outcome summaries that have not yet been delivered to one explicit agent recipient:

```bash
tokenless replay \
  --agent-kind codex \
  --agent-session-id "<stable-session-id>" \
  --json
```

The command probes or starts the local daemon on demand. SQLite marks each actionable outcome revision as reported before the response is returned, so the same revision is never proactively reported again—even if the CLI response is lost. A later parked or terminal revision of the same job is a new outcome and may be reported once.

Replay contains only allowlisted metadata and `has_result`, `has_error`, and `has_blocker` flags. It does not include raw result, error, or blocker content. Use `tokenless state --job-id "<jobId>" --json` to retrieve the durable full job whenever needed. Do not submit a replacement job solely because a replay response was missed.

Main options: `--agent-kind`, `--agent-session-id`, `--limit`, `--daemon-url`, `--daemon-start-timeout-ms`, `--home`, and `--json`. The two identity flags may instead be supplied by `TOKENLESS_AGENT_KIND` and `TOKENLESS_AGENT_SESSION_ID`.

### `tokenless state`

Reads durable daemon job state without visiting the provider.

```bash
tokenless state --task-id task-123 -P default --json
tokenless state --job-id tlp_... --json
tokenless state -P default -p chatgpt --limit 10 --json
```

Provide a task ID, job ID, or profile. Results are filtered to the managed Playwright backend, selected profile, and provider. `--limit` controls the number of returned jobs.

### `tokenless resume`

Resumes the same daemon job after it entered `waiting_for_user`.

```bash
tokenless resume \
  --job-id tlp_... \
  --browser-visibility headed \
  --json
```

`--job-id` and `--browser-visibility headed` are required. Resume preserves the original job and task identity.

When provider sign-in, hCaptcha, MFA, or another visible human verification is required, Tokenless reports `waiting_for_user` and explicitly says that your help is needed. Complete the visible step, then query or resume the same job; do not submit a replacement job.

### `tokenless cancel`

Requests cancellation and succeeds only after the daemon confirms the `canceled` state.

```bash
tokenless cancel --job-id tlp_... --json
```

Main options: `--job-id`, `--cancel-timeout-ms`, `--daemon-url`, `--home`, and `--json`.

## Provider Inspection and Control

These commands perform live visible-page operations. They do not make `profiles list` fresh unless the command is specifically `profiles status`.

### `tokenless provider-status`

Performs a live provider authentication action and returns the result.

```bash
tokenless provider-status -P default -p chatgpt --json
```

For a live check that also updates the profile registry, use `tokenless profiles status`.

### `tokenless provider-controls`

Inspects the provider's visible model and effort choices.

```bash
tokenless provider-controls -P default -p claude --json
```

### `tokenless provider-configure`

Selects an exact visible model, effort label, or both.

```bash
tokenless provider-configure \
  -P default \
  -p chatgpt \
  --model "GPT-5" \
  --effort "High" \
  --json
```

At least one control is required. Labels must match visible UI labels; model fallback lists are not supported by managed visible jobs.

### `tokenless chatgpt-controls`

ChatGPT-specific alias for inspecting model and effort controls.

```bash
tokenless chatgpt-controls -P default --json
```

### `tokenless chatgpt-configure`

Selects ChatGPT-specific model or effort controls. It also accepts `--chat-surface chat` as an explicit surface constraint; other ChatGPT surfaces are rejected.

```bash
tokenless chatgpt-configure \
  -P default \
  --model "GPT-5" \
  --effort "High" \
  --json
```

If `--provider` is supplied, it must be `chatgpt`.

### `tokenless provider-action`

Executes exactly one low-level visible action.

```bash
tokenless provider-action \
  -P default \
  -p chatgpt \
  --action capability.inspect \
  --json
```

| Action | Purpose | Required or relevant payload options |
| --- | --- | --- |
| `capability.inspect` | Inspect visible, subscription-dependent capabilities. | None |
| `auth.status` | Inspect visible authentication and account state. | None |
| `model.inspect` | List visible model controls. | None |
| `model.select` | Select one exact visible model. | `--model` |
| `effort.inspect` | List visible effort controls. | None |
| `effort.select` | Select one exact visible effort. | `--effort` or `--thinking-effort` |
| `qwen.mode.inspect` | List Qwen-specific visible composer modes. | None; Qwen only |
| `qwen.mode.select` | Select one Qwen-specific mode and optional visible variant. | `--qwen-mode`; optional `--qwen-mode-variant` |
| `deepseek.mode.inspect` | Inspect DeepSeek Instant, Expert, and Vision plus their mode-dependent controls. | None; DeepSeek only |
| `deepseek.mode.select` | Select one exact DeepSeek mode. | `--deepseek-mode` |
| `deepseek.deepthink.inspect` | Inspect DeepThink in the active DeepSeek mode. | None; DeepSeek only |
| `deepseek.deepthink.select` | Enable or disable DeepThink. | `--deepseek-deepthink on|off` |
| `deepseek.search.inspect` | Inspect Search in the active DeepSeek mode. | None; DeepSeek only |
| `deepseek.search.select` | Enable or disable Search in Instant mode. | `--deepseek-search on|off` |
| `doubao.mode.inspect` | Inspect Fast, Expert, Work Task Turbo, and visibly restricted Work Task Pro. | None; Doubao only |
| `doubao.mode.select` | Select one exact Doubao mode. | `--doubao-mode fast|expert|work-task-turbo|work-task-pro` |
| `doubao.skill.inspect` | Inspect Doubao Web skills and their canonical candidate mappings. | None; Doubao only |
| `doubao.skill.select` | Select a Doubao skill or restore ordinary chat. | `--doubao-skill <skill>` |
| `kimi.search.inspect` | Inspect Kimi Web search choices. | None; Kimi only |
| `kimi.search.select` | Select Kimi Web search Auto or Off. | `--kimi-search auto|off` |
| `kimi.plugin.inspect` | List enabled Kimi Plugins by exact visible name. | None; Kimi only |
| `kimi.plugin.select` | Select one exact Kimi Plugin. | `--kimi-plugin <exact-visible-label>` |
| `kimi.skill.inspect` | List enabled Kimi Skills by exact visible name. | None; Kimi only |
| `kimi.skill.select` | Select one exact Kimi Skill. | `--kimi-skill <exact-visible-label>` |
| `file.upload` | Upload files through visible file controls. | One or more `--attach-file` |
| `workspace.ensure` | Ensure a native or conversation-scoped Workspace. | `--project-name`; optional `--workspace-mode` and instructions |
| `prompt.clear` | Clear the visible composer. | None |
| `prompt.input` | Put text into the visible composer without submitting it. | `--prompt` or `--prompt-file` |
| `prompt.submit` | Submit the current visible composer. | None |
| `response.read` | Read the visible correlated response. | None |
| `snapshot.sanitized` | Return a sanitized structural snapshot. | None |
| `navigation.check` | Verify that the page is on an approved provider origin. | None |
| `blocker.check` | Inspect visible blockers such as sign-in or CAPTCHA. | None |

Action payloads are strict: options that do not apply to the selected action are rejected.

Doubao skill ids are `chat`, `document-writing`, `presentation-generation`, `image-generation`, `video-generation`, `deep-research`, `audio-podcast`, `music-generation`, `problem-solving`, `spreadsheet-generation`, and `audio-transcription`. The last value is inspectable but selection returns unavailable when the visible Web UI requires the desktop app. Translation is intentionally excluded from this coding-oriented control surface.

`workspace.ensure` defaults to `--workspace-mode auto` when the mode is omitted.

### `tokenless snapshot-dom`

Captures a sanitized structural provider snapshot through the daemon and persists its metadata and snapshot files under the Tokenless home directory.

```bash
tokenless snapshot-dom -P default -p chatgpt --json
```

Use `provider-action --action snapshot.sanitized` when persistence is not needed.

## Prompt Construction

### `tokenless prompt`

Builds the shareable `# Tokenless Request` document without opening a browser or submitting a provider job.

```bash
tokenless prompt \
  --project-root /path/to/project \
  --file src/example.ts \
  --context "Only the selected files are shareable." \
  --prompt "Review this implementation." \
  --output /tmp/tokenless-request.md
```

Options:

- `--prompt` or `--prompt-file` supplies the user request.
- `--project-root` defines the allowed file boundary.
- Repeat `--file` to include file text.
- `--context` or `--context-file` supplies shareable turn context.
- `--output` writes the compiled prompt to a file; otherwise it prints to stdout.

The command can also be invoked without the word `prompt` when the first argument is an option, but the explicit form is clearer in documentation and scripts.

## Compatibility Aliases

The following aliases are accepted for compatibility. Prefer the canonical form in new scripts.

| Alias | Canonical form |
| --- | --- |
| `tokenless status` | `tokenless state` |
| `tokenless provider-auth-status` | `tokenless provider-status` |
| `tokenless inspect-provider-controls` | `tokenless provider-controls` |
| `tokenless inspect-chatgpt-controls` | `tokenless chatgpt-controls` |
| `--import-chrome-profile` | `--import-browser-profile` |
| `--chrome-user-data-dir` | `--browser-user-data-dir` |
| `--turn-context` | `--context` |
| `--turn-context-file` | `--context-file` |
| `--conversation-key` | `--idempotency-key` |
| `--clean-profile` | `--fresh` |

## Status and Side-Effect Summary

The three similarly named status workflows have different persistence behavior:

```text
profiles list
    reads only the saved profile registry

profiles status
    visits one provider, checks auth/account controls,
    and saves auth, username, subscription, and checkedAt

provider-status
    visits one provider and returns a live auth result,
    but is not the profile-registry refresh workflow
```

Commands that may open or operate a provider page are `setup`, `profiles status`, `profiles open`, `run`, `resume`, every provider inspection/configuration/action command, and `snapshot-dom`.

## Manual Real-Browser Acceptance

The authenticated provider capability harness keeps a separate persistent profile for every explicitly selected production browser. It derives a test-only home at `<TOKENLESS_HOME>/e2e/live-provider` by default, or uses `TOKENLESS_LIVE_PROVIDER_TEST_HOME` or `--home` when explicitly supplied. The test home must differ from the ordinary Tokenless home and remain outside every repository/worktree. Browser selection `cloak`, for example, resolves stable slug `live-provider-cloak`; the production registry at `<test-home>/browser/profiles.json` maps that slug to the opaque directory `<test-home>/browser/profiles/<uuid>`. The harness validates that directory, its private permissions, lifecycle, executable, and runtime binding before any provider automation. It rejects `auto` because automatic discovery could resolve a different executable across runs, and it never reuses one profile across browser runtimes.

Prepare and manually authenticate one browser-specific profile before running its provider gates:

```bash
npm run test:e2e:prepare -- --browser cloak
# Sign in manually in each provider tab, then run the printed daemon-stop command.
npm run test:e2e -- --browser cloak
npm run test:e2e:connection-matrix -- --browser cloak
```

Supported authenticated-profile selections are `chrome`, `brave`, `edge`, `arc`, `chromium`, `chrome-for-testing`, `managed-chromium`, and `cloak`. `prepare` installs or resolves the exact browser, keeps its maintenance skill output inside the test-only home, and creates or reuses only its deterministic profile slug. Its login-page list is the profile's effective provider whitelist: `profilePreferences[slug].enabledProviders` when present, otherwise the top-level `providerWhitelist`. Fresh configs include every registered non-disabled provider, including Gemini; regional or network reachability is evidence reported by E2E rather than a reason to remove a provider from preparation. Preparation preserves the configured order and never rewrites either list. It requests every listed provider-entry tab in one concurrent Chromium background-tab batch, then exits without waiting for page load, login, or Playwright target observation. If a proof-verified daemon for the same dedicated home predates the provider-tab endpoint, preparation gracefully replaces it with the current built daemon and retries the handoff once. The detached daemon remains the browser owner while Chromium persists the dedicated profile normally. The browser may take focus on its initial launch but does not foreground every provider tab in sequence. Preparation does not read the capability matrix, run provider jobs, call `setup` or `profiles status`, automate login, or inspect authentication data. Use `--no-open` for preparation validation without provider navigation or the manual browser handoff. The `run` command uses the live capability matrix to execute declared provider journeys once in Playwright mode; `connection-matrix` runs the same selected profile sequentially in Playwright and CDP modes. Each invocation writes a private JSON report under `test-results/live-provider-e2e/`, grouped first by provider and then by capability. Readiness failures are classified separately from capability assertions; `network_or_navigation` records observable reachability failure without claiming a particular firewall or regional cause. Both run modes perform real provider mutations and may incur usage cost.

Browser-runtime and provider-surface acceptance tests are explicit local gates and do not run in CI:

```bash
npm run test:e2e:browser-runtime
npm run test:e2e:browser-surfaces
npm run test:e2e:system-surfaces
npm run test:e2e:managed-surfaces
npm run test:e2e:cloak-surfaces
```

On a machine intentionally prepared without a supported system browser, run `npm run test:e2e:browser-runtime -- --expected-auto managed-chromium` to require proof of the lazy managed fallback. The default command requires `auto` to resolve a system browser. Run both commands on each targeted Windows x64 CPU class; npm forwards these arguments identically from `cmd.exe`, PowerShell, and POSIX shells.

The browser surface gate runs the same real headed, keychain-neutral test profile against system auto-selection, managed Chrome for Testing, and Cloak. Each case always visits every registered provider plus Google Search over the real network before aggregating failures, fails on a detected anti-bot challenge, and reports only public location, title, response status, and structured challenge outcomes. It does not authenticate, submit prompts, read browser storage, capture screenshots, or replace the authenticated built-CLI provider release gate. The three selection-specific commands run only system, managed, or Cloak respectively.
