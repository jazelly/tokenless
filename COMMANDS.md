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
| `tokenless agents <install\|status\|inspect\|uninstall> codex` | Manage the optional Codex guidance, native hooks, and exact Harness context binding. | None |
| `tokenless dashboard` | Open the local web control plane, or print its direct loopback URL. | None |
| `tokenless menubar status` | Print the same-home menu bar snapshot for a native macOS client. | None |
| `tokenless doctor` | Read local configuration and runtime health without refreshing providers. | None |
| `tokenless config` | Read or update persistent Tokenless configuration. | None |
| `tokenless upgrade` | Upgrade the global CLI, skills, local runtime, and run doctor. | None |
| `tokenless profiles add` | Create a logical Tokenless profile for tabs and provider configuration. | None |
| `tokenless profiles list` | List profiles and the current process's provider observations. | None |
| `tokenless profiles status` | Check one provider live and keep the observation in current process memory. | Yes |
| `tokenless profiles open` | Open a managed profile headed, optionally navigating to one provider. | Optional |
| `tokenless profiles set-default` | Select the default managed profile. | None |
| `tokenless profiles clear` | Delete one or all managed profiles as a human maintenance action. | None |
| `tokenless profiles remove` | Delete one managed profile with explicit confirmation. | None |
| `tokenless capabilities list` | List canonical task capabilities and evidence-backed provider routes. | None |
| `tokenless limits inspect` | Inspect the next-prompt provider/profile capacity estimate from the packaged catalog and local job history. | None |
| `tokenless savings <status\|enable\|disable\|clear\|uninstall>` | Manage optional local output savings measurement and its tokenizer, downloaded on the first successful visible response. | None |
| `tokenless api-proxy <status\|enable\|disable>` | Manage the OpenAI/Anthropic-compatible local API proxy and its compatibility conversation-mode setting. | None |
| `tokenless run` | Send a prompt and optional files through a visible provider session. | Yes |
| `tokenless state` | Inspect current daemon job state. | None |
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
kimi
dola
```

ChatGPT, Claude, Gemini, and Grok are supported providers. Qwen / 千问, DeepSeek, Perplexity, Z.ai / GLM, Doubao / 豆包, Kimi, and Dola are experimental: only their evidence-backed routes and controls are advertised, while unproven continuation and optional capabilities remain unavailable or unknown.

Tokenless uses native mode: Playwright attaches to the user's already-running Google Chrome or Brave Browser. Enable remote debugging at `chrome://inspect/#remote-debugging` or `brave://inspect/#remote-debugging` and approve the browser's connection prompt. The browser manages the underlying CDP endpoint and Tokenless discovers it automatically, so native mode does not require `--remote-debugging-port` or a configured fixed port. Connection success is the capability check; there is no profile version compatibility matrix. Native mode is headed-only and never copies a browser profile.

### Short options

Short options are case-sensitive:

- `-P <slug>` is short for `--profile <slug>`.
- `-p <provider>` is short for `--provider <provider>`.
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
| `--daemon-url <url>` | Set the loopback daemon URL. If its port is occupied, daemon startup fails clearly. |
| `--agent-kind <kind>` | Supply the Codex Harness agent kind for the current invocation; use with `--agent-session-id`. |
| `--agent-session-id <id>` | Supply the Codex Harness session identity for the current invocation; use with `--agent-kind`. |
| `--browser-visibility <headed>` | Native Chrome is headed-only. |
| `--timeout-ms <ms>` | Override the command or job wait timeout. |
| `--daemon-start-timeout-ms <ms>` | Override daemon startup waiting. |
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

Resolves or installs the selected exact browser runtime, saves the runtime preference, upserts the required global Tokenless agent skills, verifies the packaged TypeScript daemon runtime, and ensures that the local daemon matches the installed CLI version and control API revision. The canonical skill copy is kept in `~/.agents/skills`; when common agent roots already exist, maintenance also refreshes direct copies for Codex, Claude Code, Cursor, Copilot, Gemini CLI, OpenCode, Pi, Hermes, and Windsurf, plus the legacy `~/.agent/skills` location. Use `tokenless upgrade` for the normal user-facing maintenance workflow; this command remains available for low-level runtime provisioning and compatibility automation. A proof-verified daemon for the same Tokenless home is gracefully restarted from the current CLI package when either value is stale; foreign or unverified listeners are never stopped.

```bash
tokenless install --browser auto --json
tokenless install --browser cloak --json
tokenless install --browsers chrome,edge --json
```

Main options:

- `--browser <browser>` selects one browser preference. Managed selections download only during install or setup.
- `--browsers <list>` verifies a comma-separated browser list.
- `--repair-browser` replaces the explicitly selected managed-Chromium or Cloak cache only after a newly downloaded replacement passes every verification step; a failed repair restores the previous cache.
- `--daemon-url`, `--daemon-start-timeout-ms`, `--home`, and `--json` control the local runtime.

This command does not update the global npm CLI, configure a managed profile, or check provider sign-in. Run `tokenless setup` afterward when using it directly.

### `tokenless setup`

Runs the complete onboarding flow: asks about Anti-Detect, selects a user-supplied Chrome or Brave for native mode or prepares CloakBrowser, creates or selects a logical Tokenless profile, saves configuration, upserts the global Tokenless agent skills, reconciles the daemon to the installed CLI version, and checks enabled providers when browser access is available. With `--install-codex`, setup explicitly installs Tokenless guidance and hooks after preferences are saved and before skill maintenance; setup without the flag never installs them, including non-interactive runs. Manual trust in Codex `/hooks` remains required. Skill maintenance keeps `~/.agents/skills` canonical and refreshes direct copies for already-present common agent roots, including `~/.codex/skills` and `~/.claude/skills`; it also repairs the legacy `~/.agent/skills` location. No browser is downloaded by npm postinstall, daemon startup, or ordinary job execution. If no language preference exists, setup detects the system locale, selects `zh-CN` for Chinese locales or `en` otherwise, and persists it in config.

Interactive setup:

```bash
tokenless setup
```

Create or reuse a logical profile non-interactively:

```bash
tokenless setup --profile default --defaults --json
tokenless setup --install-codex --codex-home <dir> --profile default --defaults --json
```

Main options:

- `--profile <slug>` selects or names the logical Tokenless profile.
- `--install-codex` explicitly installs the optional Codex guidance, native hooks, and skills during setup.
- `--codex-home <dir>` selects a custom Codex state root and requires `--install-codex`.
- `--provider-whitelist <list>` selects provider membership for that profile during non-interactive setup.
- `--no-open` completes setup without opening the dashboard.
- `--defaults` selects non-interactive defaults.
- `--set-default` makes the selected profile the default.
- `--browser-executable-path <absolute-path>` supplies a user-installed Chrome or Brave executable when automatic discovery cannot find it.

Setup first asks whether to use Anti-Detect mode. If declined, the user chooses user-supplied Google Chrome or Brave Browser; Tokenless does not bundle or download either browser. Setup then tries the configured executable path and standard installation locations. If neither resolves, setup still saves configuration and finishes with an `action_required` warning, skips provider browser checks, and tells the user how to add an absolute executable path. Before the first browser action, Tokenless validates that path or retries standard discovery; the action fails clearly if neither works. During setup, CloakBrowser is the only browser runtime Tokenless downloads and prepares. Enable remote debugging at `chrome://inspect/#remote-debugging` or `brave://inspect/#remote-debugging` before browser use.

Interactive `setup` lists every supported provider, enables all of them by default, and lets the user remove providers by replying with their displayed numbers; pressing Enter keeps them all. Non-interactive setup uses `--provider-whitelist`, the existing profile's `enabledProviders`, or all supported providers for a new profile. When a browser resolves, setup checks provider state and leaves headed review tabs open. When it does not, setup skips those browser checks and opens the dashboard so the user can add the executable path.

Every new profile starts with all non-disabled providers, including Gemini. Its membership can be changed with `--profile <slug> --provider-whitelist <list>` or through the dashboard.

### `tokenless agents <install|status|inspect|uninstall> codex`

Manages the optional Codex integration without launching, wrapping, or replacing Codex:

```bash
tokenless agents install codex
tokenless agents status codex --json
tokenless agents inspect codex --chat-id <codex-thread-id> --json
tokenless agents uninstall codex
```

`install` writes one versioned inline guidance block into the effective global Codex instruction file and merges Tokenless-owned groups into `$CODEX_HOME/hooks.json`. A non-empty `AGENTS.override.md` is the effective same-directory source, so Tokenless patches it instead of `AGENTS.md`; the command never creates an override. Existing instructions and non-Tokenless hooks are preserved. Restart Codex, open `/hooks`, and explicitly trust the Tokenless hook definition before relying on automatic binding.

Users continue launching Codex normally. The hooks observe lifecycle events and react only when an actual Tokenless Bash or MCP call occurs. Hook `session_id` is immutable session-tree provenance; `turn_id` and `tool_use_id` identify the Hook lifecycle records. For CLI/shell execution, Codex supplies the concrete task as `CODEX_THREAD_ID`, and Tokenless resolves it before provider access so descendants do not collapse into the root conversation. A bounded best-effort App Server `thread/read` confirms the concrete task, canonical cwd, session tree, and available lineage; it does not start, resume, relay, or proxy a Codex TUI.

`status` reports the exact instruction and hook paths and verifies the current guidance body and hook command without creating Harness state; stale or edited definitions report as not installed and `install` repairs them. `inspect` reads one exact chat from the separate Harness database, including local project, turns, invocations, stable provider task identity, and provider Project/conversation bindings. The ledger stores hashes rather than raw prompts and does not store transcripts, assistant messages, credentials, or browser state. `uninstall` removes Tokenless-owned guidance from both global instruction filenames and removes only Tokenless hook groups; retained Harness history is not deleted.

Main options:

- `--codex-home <dir>` selects an explicit Codex state root instead of `CODEX_HOME` or `~/.codex`.
- `--home <dir>` selects the Tokenless state root.
- `--chat-id <id>` is required by `inspect` and must be the exact Codex thread ID.
- `--json` returns the structured status or context contract.

### `tokenless agents <install|status|uninstall> dsh`

Installs a reversible DeepSeek Harness `SubagentProvider` that delegates the ordinary one-shot `subagent` tool to Tokenless Harness:

```bash
tokenless agents install dsh --provider chatgpt --profile default --dsh-profile headless --json
tokenless agents status dsh --dsh-profile headless --json
tokenless agents uninstall dsh --dsh-profile headless --json
```

`install` adds one marked block to the selected profile's `cordis.patch.yml`. It preserves unrelated rows, registers `tokenless-harness`, and switches only the ordinary `subagent` tool to that provider. It does not modify or remove DeepSeek Harness's `llm-pi-ai` package.

Use `--dsh-home <dir>` to override `DSH_HOME` or `~/.dsh`; `--dsh-profile <name>` defaults to `headless`. Installation requires the Tokenless `--provider` and `--profile` used by delegated children.

### `tokenless agent delegate`

Runs one Tokenless Harness-owned child task synchronously and returns its terminal result:

```bash
tokenless agent delegate --provider chatgpt --profile default --workspace-root "$PWD" --prompt "Inspect this repository." --json
```

The delegated run receives bounded `workspace.read` and `workspace.search` tools rooted at `--workspace-root`. `--prompt-file` and `--prompt-stdin` are alternatives to `--prompt`. This explicit command is the truthful integration for hosts such as Codex whose current hooks cannot replace native subagent execution.

### `tokenless dashboard`

Starts or discovers the same-home daemon and opens the Dashboard URL in your operating system's default browser. `--profile` only selects the initial Dashboard profile; it does not select the browser used to display the Dashboard. You can also open the daemon loopback URL directly in any browser:

```bash
tokenless dashboard
tokenless dashboard --profile work
tokenless dashboard --profile work --no-open --json
tokenless dashboard --job-id <job-id>
```

`--no-open` prints the direct loopback Dashboard URL without launching a browser. Opening `/` redirects to `/dashboard/overview/` and establishes a short-lived `HttpOnly`, `SameSite=Strict` session cookie. Dashboard mutations continue to require exact-Origin and CSRF checks. The Dashboard can run in any browser; provider actions still execute in the selected profile's bound browser runtime. The dashboard never receives the daemon bearer token, provider cookies, browser storage, Keychain data, raw DOM, or private filesystem paths.

`--job-id` opens the Jobs view and loads that job's detail automatically. `tokenless menubar status --json` starts or discovers the same-home daemon, then returns the daemon/runtime status, dashboard URL, active job count, and up to ten conversation summaries ordered by `updatedAt` descending. Conversation summaries contain only safe titles and public identifiers; they do not include prompts, transcripts, credentials, or private paths.

The dashboard provides Overview, Profiles, Providers, Capabilities, Jobs, and System/Diagnostics areas. Provider membership, visibility, role label, and an optional credential-free HTTP/HTTPS/SOCKS5 proxy are profile scoped. CLI state and cancellation commands remain available:

Provider readiness refreshes run serially per profile. Tokenless starts a resident headless browser when the profile is idle, or reuses an already-running headed profile without replacing its browser, closing its existing tabs, or bringing the check to the foreground. Each check owns one temporary background tab and closes it on every completion, failure, blocker, timeout, or cancellation path; user-owned tabs remain untouched. A readiness check that encounters sign-in or verification records the required action; visible browser interaction starts only from an explicit provider, browser, or job action.

```bash
tokenless config --profile work --provider-whitelist chatgpt,claude --browser-visibility headed --json
tokenless config --profile work --proxy-server socks5://127.0.0.1:1080 --proxy-bypass localhost --json
tokenless profiles open --profile work --json
tokenless state --profile work --json
```

### `tokenless doctor`

Performs a read-only health report over Node.js, installed skills, packaged runtime, daemon identity and version, embedded Playwright runtime, browser preference, resolved runtime family and exact executable version, checksum state, configuration completeness, default profile/runtime health, and cached provider readiness. `checks.config` reports whether `config.json` parses; `checks.configuration` reports whether the saved browser selection and executable path, daemon URL, and default profile are complete enough for browser use. A stale custom browser path remains unhealthy even when standard browser discovery succeeds.

```bash
tokenless doctor --json
```

`doctor` does not open provider pages, refresh authentication, start the daemon, or repair state. Each `checks.configuration.issues` entry includes a code, localized message, and next action. `checks.managedProfile.ok` reports profile/config health, while `checks.profileRuntime.ok` independently reports whether that profile has a resolvable browser binding. Provider readiness comes from the current process's profile observation. `checks.providerReadiness.ok` reports whether configured providers have current observations; `usableProviders` lists the providers eligible for implicit routing. Because the daemon is on demand, a normally stopped daemon and embedded browser runtime are reported as healthy stopped state rather than installation damage.

Main options: `--browser`, `--daemon-url`, `--home`, and `--json`.

### `tokenless config`

Reads persistent configuration when called without configuration options:

```bash
tokenless config --json
```

Updates global values without `--profile`:

```bash
tokenless config \
  --language zh-CN \
  --browser chrome \
  --daemon-url http://127.0.0.1:7331 \
  --json
```

Updates provider membership and visibility for one profile with `--profile`:

```bash
tokenless config \
  --profile work \
  --provider-whitelist chatgpt,claude,gemini,grok,qwen \
  --browser-visibility headed \
  --json
```

Configurable values:

- `--language <en|zh-CN>`
- `--profile <slug> --provider-whitelist <list>`
- `--profile <slug> --browser-visibility headed`
- `--browser chrome`
- `--browser-executable-path <absolute-path>`
- `--clear-browser-executable-path`
- `--daemon-url <loopback-url>`
- `--home <path>`

Provider membership belongs only to the selected entry in `profiles`. Routing requires that entry and never falls back to a global provider list.

`config.json` is the only profile source. A profile slug is its identity, its browser directory is derived as `<TOKENLESS_HOME>/browser/profiles/<slug>`, and runtime binding plus creation/update timestamps live beside the profile's provider settings. Provider authentication observations are process-local and are not persisted.

The config shape is:

```json
{
  "protocol": "tokenless.config.v1",
  "updatedAt": "2026-08-02T02:09:40.254Z",
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "roleLabel": "Personal",
      "enabledProviders": ["chatgpt", "claude"],
      "browserVisibility": "headed",
      "proxy": null
    }
  },
  "browser": "chrome",
  "browserExecutablePath": null,
  "browserVisibility": "headed",
  "daemonUrl": null,
  "language": "en",
  "outputSavings": { "enabled": true }
}
```

`browserExecutablePath` is a verified cache, not an immutable override: Tokenless executes the browser's version command to validate it, falls back to standard-path discovery if validation fails, and rewrites the cache after a successful fallback. If both checks fail, use the CLI flag above or paste an absolute path into **System → Browser executable path** in the dashboard. The dashboard exposes only whether a path is configured; it does not send the private path back to browser JavaScript.

Human-readable command output and the default provider response language follow `language`; an explicit language request in the prompt takes precedence. Command names, flags, JSON keys, error codes, status values, and other integration terms remain stable. `daemonUrl` is the configured start and stop endpoint, not mutable runtime status. Tokenless never rewrites it when that port is busy; clients verify the configured endpoint through `/ready` and stop it through authenticated `/shutdown`.

Tokenless always controls managed Chromium through CDP while exposing Playwright's browser, page, and locator APIs internally. The resident browser can therefore outlive one daemon connection and be reattached by a later daemon without a user-selectable connection mode.

### `tokenless upgrade`

Runs the canonical user-facing maintenance pipeline. It updates the global npm CLI, resolves and verifies the installed CLI, invokes that new CLI's shared maintenance module to upsert global agent skills across the canonical and detected direct agent roots and reconcile the matching daemon, then runs doctor. Use this instead of `tokenless install` for normal installation maintenance and upgrades.

```bash
tokenless upgrade
tokenless upgrade --json
tokenless upgrade --check --json
```

Accepted options are `--check`, `--json`, `--home`, `--daemon-url`, `--browser`, `--browsers`, and `--daemon-start-timeout-ms`. `--check` only queries npm for the latest published version and does not mutate the CLI, runtime, or daemon.

### `tokenless daemon stop`

Gracefully stops a compatible daemon after verifying its identity. Managed browsers remain running; a later daemon reconnects to them through their profile-scoped CDP endpoint.

```bash
tokenless daemon stop --json
```

Options: `--home`, `--daemon-url`, `--timeout-ms`, and `--json`.

The command verifies the configured endpoint and does not kill an unverified or incompatible process merely because it occupies the preferred port.

## Tokenless Profiles

A Tokenless profile groups provider tabs and configuration inside the connected Chrome or Brave identity. It does not create or copy a separate browser identity.

### `tokenless profiles add`

Creates a logical Tokenless profile:

```bash
tokenless profiles add -P work --set-default --json
```

### `tokenless profiles list`

Reads profiles from `config.json` and returns every managed profile.

The Tokenless API database `<TOKENLESS_HOME>/tokenless.sqlite3` stores jobs only; provider submission history is derived from those jobs, and profile records remain in `config.json`.

```bash
tokenless profiles list
tokenless profiles list --json
```

This command is fast, read-only, and has no browser side effects. Provider fields are cached observations; use each provider's `checkedAt` to judge freshness.

### `tokenless profiles status`

Performs a live authentication check against one provider, then updates `auth`, visible username, visible subscription, and a new `checkedAt` value in the current process. The observation is not persisted.

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

Use the provider-less form for user-controlled browser maintenance, account switching, or inspecting the managed profile. Use the provider form for sign-in, CAPTCHA, MFA, ambiguous or external consent, or provider-specific account switching. Exact provider-owned onboarding Terms/Privacy dialogs may instead be handled by the selected provider adapter. It does not replace `profiles status`; run the status command afterward to save a fresh observation.

### `tokenless profiles set-default`

Makes one registered profile the default.

```bash
tokenless profiles set-default -P work --json
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

The projection reports the matched catalog plan and rules, local usage, published and effective allowance, estimated remaining units, cadence, burst allowance, and decision. `unknown` means Tokenless has no enforceable official number and will allow execution; it does not mean unlimited provider capacity. This command is local and read-only and does not open or submit to a provider website.

### `tokenless savings`

Manage the output-only savings estimate. It is enabled by default, while setup and dashboard reads never download the tokenizer.

```bash
tokenless savings status --json
tokenless savings enable --json
tokenless savings disable --json
tokenless savings clear --confirm-delete --json
tokenless savings uninstall --confirm-delete --json
```

`enable` downloads and verifies the pinned `o200k_base` WASM tokenizer before setting `outputSavings.enabled` to `true`. Normal default-on use installs and measures it during the first successful visible response in the current execution. `disable` prevents later results from being saved while retaining history and the runtime. `clear` removes the measurement history, and `uninstall` disables measurement, clears history, and removes the runtime; both destructive operations require `--confirm-delete`. `status` is read-only with respect to configuration and tokenizer installation. None of these commands opens a provider page.

Measurements cover only normalized visible assistant output and are attributed to the triggering job and response. They are stable cross-provider estimates, not provider billing values; input tokens, hidden reasoning, and private backend traffic are excluded.

### `tokenless api-proxy`

Manages the local API proxy: an OpenAI- and Anthropic-compatible surface on the daemon that turns ordinary API calls into visible provider work. It is disabled until you turn it on.

```bash
tokenless api-proxy status --json
tokenless api-proxy enable --conversation-mode new-conversation --json
tokenless api-proxy enable --conversation-mode continue-conversation --json
tokenless api-proxy disable --json
```

Point a client at the daemon and use the daemon control token as the API key:

| Client | Base URL | Route |
| --- | --- | --- |
| OpenAI-compatible | `http://127.0.0.1:7331/v1/openai` | `POST /chat/completions`, `GET /models` |
| Anthropic-compatible | `http://127.0.0.1:7331/v1/anthropic` | `POST /messages` |

`model` must name the provider explicitly as `tokenless/<provider>`, for example `tokenless/chatgpt`. An unmapped model is rejected rather than redirected to a provider the caller did not choose. `GET /v1/openai/models` lists every accepted name.

The `--conversation-mode` option is retained for config/status compatibility, but it does not override the API contract. Chat Completions and Anthropic always start a fresh provider conversation and send the full request history. Responses starts fresh when `previous_response_id` is omitted, and continues a mapped provider conversation only when a valid `previous_response_id` is supplied; a missing mapping falls back to a fresh chat with the reconstructed transcript. See [API proxy integration](docs/api-proxy-integration.md#conversation-state) for the exact continuation rules.

`tools`, `tool_choice`, `functions`, `function_call`, and `response_format` are rejected because visible provider pages expose no equivalent control. `stream: true` returns the documented event sequence for that dialect, delivered as one terminal chunk, because a visible response is only readable once it has finished rendering. Reported `usage` counts are always zero: Tokenless does not meter provider tokens, and the response is billed by your own web subscription.

Responses carry a `tokenless` object with the provider, current `job_id`, conversation mode, and any visible citations.

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
- Tokenless merges explicit capabilities with structural inference: a normal `submit_and_read` run requires `conversation.chat`, `--attach-file` requires `file.upload` plus `image.input`, `audio.input`, or `video.input` when applicable, and `--workspace-mode auto` or `native` requires `workspace.native`.
- When no provider is explicit, the configured provider list filters membership. Tokenless then filters for providers that satisfy the full implication-expanded requirement set and ranks routes by fresh cached eligibility and evidence maturity (`supported` before `experimental`); configured list position is the final tie-breaker and cannot override those stronger signals. Stale usable observations remain `unchecked` until the runner performs its live read-only preflight.
- An explicit provider that cannot satisfy the full requirement set fails before daemon submission instead of silently switching.
- Unknown and sign-in-required observations are not usable for implicit routing. If no cached provider is usable, the CLI returns `provider_unavailable` with provider observation context before creating a daemon job.
- A known capability with no complete route returns `task_capability_route_unavailable` before browser mutation. `--capability` currently requires the normal `submit_and_read` action.
- Successful submissions return and durably store `capabilityRoute`, including normalized requirements, selected strategies, support level, evidence identifiers, and runtime eligibility; `tokenless state` returns the same route.
- Implicit `submit_and_read` runs may keep an automatic fallback plan in the current execution. Before mutation, every attempt rechecks known local provider capacity, the visible session, and capability-specific UI without a probe prompt. Classified safe pre-submit capacity, auth, CAPTCHA, rate/plan, maintenance, region, navigation, stable-surface, and capability-availability failures immediately try the next ranked provider only when it satisfies the identical complete requirements and no external mutation has completed. Exact or mapped continuation, explicit providers, provider-specific controls, ambiguous external state, and post-submission failures never switch automatically. JSON state includes ranked `fallback.routes` and structured stop reasons.
- The job validator independently derives capabilities from actions, attachment MIME types, and native workspace intent, so internal or agent callers cannot under-declare a fallback requirement. Routed jobs carry `tokenless.context-envelope.v1`; its instructions, references, output/constraint contract, optional upstream state, and delivery hashes are reused unchanged on each fallback attempt. JSON state exposes only a redacted envelope summary.

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
- `--kimi-skill <exact-visible-label>` selects one exact provider-native Kimi workflow. It is unrelated to a user-owned Harness `SKILL.md`.
- `--browser-visibility <auto|headed|headless>` overrides the configured visibility policy.

Identity and continuity:

- `--task-id <id>` supplies task identity for the current daemon execution.
- `--page-ref <ref>` supplies caller-controlled provider-tab identity. Reuse one Ref only for work that must continue in the same tab; independent work should use distinct Refs. Omit it to generate an independent Ref.
- `--project-name <name>` and `--chat-name <name>` contribute to derived task identity without requesting Workspace handling.
- `--workspace-mode <auto|native|conversation>` explicitly requests Workspace handling and requires `--project-name`.
- `--project-instructions <text>` or `--project-instructions-file <path>` supplies optional Workspace instructions.
- `--agent-kind <kind>` and `--agent-session-id <id>` supply Codex Harness context identity. Both are required together; the same values may come from `TOKENLESS_AGENT_KIND` and `TOKENLESS_AGENT_SESSION_ID`.

Execution:

- `--no-wait` submits and returns without waiting for the result.
- `--long-running` uses the long-running wait budget and cannot be combined with `--no-wait`.
- `--timeout-ms`, `--cancel-timeout-ms`, and `--daemon-start-timeout-ms` override execution timing.
- `--target-url <url>` selects an approved starting URL on the provider domain.

Workspace modes:

- Routed `run` requests using `auto` or `native` require the canonical `workspace.native` capability. No provider route is currently advertised, so these requests fail before browser mutation until the native Project release gate is complete.
- The lower-level Claude and Grok adapters implement experimental visible native Project create/reuse behavior for their explicit real-provider acceptance suite; implementation alone is not a router support claim.
- After `workspace.native` becomes routeable, `native` will require exact native Project creation or reuse and will never degrade to conversation scope. Duplicate exact visible names fail closed.
- `conversation` requires the conversation-scoped strategy and reuses mappings only within the current daemon process.
- Native results report `created` or `reused`, canonical provider resource identity, provider/profile scope, and the instruction outcome. Conversation results report `fallback`.
- Project and task conversation targets are exact process-local mappings. Restarting the daemon forgets them.

### `tokenless state`

Reads current daemon job state without visiting the provider. Jobs left unfinished when the daemon restarts are reported as failed with `job_interrupted`; they are not resumed.

```bash
tokenless state --task-id task-123 -P default --json
tokenless state --job-id tlp_... --json
tokenless state -P default -p chatgpt --limit 10 --json
```

Provide a task ID, job ID, or profile. Results are filtered to the managed Playwright backend, selected profile, and provider. `--limit` controls the number of returned jobs.

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

For a live check that also updates the current process's profile observation, use `tokenless profiles status`.

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
| `kimi.skill.select` | Select one exact provider-native Kimi workflow; this is not a user-owned Harness Skill. | `--kimi-skill <exact-visible-label>` |
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
| `--turn-context` | `--context` |
| `--turn-context-file` | `--context-file` |

## Status and Side-Effect Summary

The three similarly named status workflows have different persistence behavior:

```text
profiles list
    reads only saved profiles from config.json

profiles status
    visits one provider, checks auth/account controls,
    and keeps auth, username, subscription, and checkedAt in current process memory

provider-status
    visits one provider and returns a live auth result,
    but is not the profile-observation refresh workflow
```

Commands that may open or operate a provider page are `setup`, `profiles status`, `profiles open`, `run`, every provider inspection/configuration/action command, and `snapshot-dom`.

## Manual Real-Browser Acceptance

The authenticated provider capability harness reads the complete home named by `TOKENLESS_TEST_HOME`, derives its root `config.json`, and uses only its `defaultProfile`. Profile slugs remain developer-owned because each developer chooses that default outside the harness. The home must remain outside every repository/worktree; before browser automation, the harness validates the derived profile directory, private permissions, executable, and exact runtime binding.

Create a repository-local `.env`, then manually authenticate the config's default profile:

```dotenv
TOKENLESS_TEST_HOME=/absolute/path/to/tokenless-home
```

```bash
npm run test:e2e
```

The default profile's existing production runtime binding selects the browser; test commands do not accept browser, home, or profile overrides. Sign in manually using normal Tokenless workflows before running a live suite. The `run` command uses the live capability matrix through the CDP-controlled browser and writes a private JSON report under `test-results/live-provider-e2e/`, grouped first by provider and then by capability. Readiness failures are classified separately from capability assertions; `network_or_navigation` records observable reachability failure without claiming a particular firewall or regional cause. Provider runs perform real mutations and may incur usage cost.

Provider-surface acceptance is an explicit local gate and does not run in CI:

```bash
npm run test:e2e:browser-surfaces
```

The browser surface gate reuses the config's default persistent profile with its existing visibility and controls it through Tokenless's production CDP path. It never creates, closes, switches, or deletes a browser profile or resident browser. Each run visits every registered provider plus Google Search over the real network, fails on a detected anti-bot challenge, and reports only public location, title, response status, and structured challenge outcomes. It does not submit prompts, read browser storage, capture screenshots, or replace the authenticated built-CLI provider release gate.
