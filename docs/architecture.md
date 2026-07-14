# Tokenless Architecture

Tokenless is standalone. Noop and other agents may consume its packages or skill, but Tokenless does not import their internals.

## Surfaces

1. The `tokenless` npm CLI is the local agent entrypoint. It selects the visible or direct transport before initializing either one and collects only explicitly shared project context.
2. `tokenless-daemon` is the loopback Rust control plane and owns the SQLite job store.
3. `tokenless-native-host` is the Chrome Native Messaging process that bridges the extension to daemon jobs.
4. The browser extension owns provider-tab orchestration and visible DOM automation.
5. Direct clients call a documented public provider API or delegate ChatGPT-plan work to the provider-owned Codex executable.
6. The authenticated loopback direct broker streams an allowlisted public inference protocol to a configured public upstream without disclosing its outbound credential.

## Execution Mode Boundary

`tokenless run` defaults to `visible`. `--mode direct` is explicit. The decision occurs before daemon resolution, extension inspection, browser launch, Codex execution, or API configuration. Tokenless never falls back between modes: a failure in one transport is returned to the caller without resending the prompt through the other transport.

Visible mode supports ChatGPT, Claude, Gemini, and Grok through user-visible provider pages. Direct mode supports ChatGPT, Claude, Gemini, Grok, and an explicitly configured Antigravity-compatible gateway. Public API traffic may be billed separately from a provider web subscription.

## Visible Session Flow

```text
Agent / Tokenless skill
  -> npx tokenless run
  -> validate prompt size, loopback daemon URL, provider, and HTTPS target
  -> verify fresh /ready challenge HMAC + daemon/native protocols + canonical home
  -> start packaged tokenless-daemon under a per-home lock when needed
  -> read <home>/extension-bridge.json
      -> live marker: CLI does not pre-open a wake tab
      -> absent marker: open only selected provider HTTPS UI in selected Chromium browser
  -> wait for Rust Native Messaging bridge readiness
  -> authenticate with <home>/daemon.token and create job in daemon SQLite
  -> tokenless-native-host pushes job to extension
  -> extension reuses an approved provider tab or opens one provider tab
  -> extension uses the visible provider DOM
  -> tokenless-native-host completes the daemon job
  -> CLI returns the visible result
```

The CLI never opens a task, runner, settings, history, local-file, or `chrome-extension://` page. There is no local JSON job fallback and no Node native host. `--no-open` fails before job creation if the live bridge marker is absent.

## Direct Flow

```text
Agent / local caller
  -> tokenless run --mode direct
      -> ChatGPT official-client backend
          -> isolated provider-owned Codex executable owns authentication and transport
      -> API backend
          -> resolve API credential from the process environment
          -> validate HTTPS or loopback HTTP upstream and exact provider route
          -> send one bounded, redirect-free public API request
          -> return a normalized tokenless.direct.v1 result

Local API client
  -> Authorization: Bearer <TOKENLESS_DIRECT_SERVER_KEY>
  -> loopback tokenless serve --mode direct
      -> authenticate before route or provider configuration
      -> strip inbound credentials, cookies, and non-allowlisted headers
      -> inject the selected environment credential
      -> stream an allowlisted public inference route and raw upstream response
```

Direct mode does not resolve or start the Rust daemon, read the daemon token or database, inspect the extension bridge, or open a browser. API credentials are accepted only from environment variables and are not persisted in Tokenless configuration or job state. Remote upstreams require HTTPS; HTTP is allowed only for loopback development. Redirects, retries, and cross-provider fallback are disabled.

ChatGPT defaults to the official Codex backend on macOS and Linux. Tokenless passes the prompt on stdin with a positive environment allowlist, an isolated working directory, and a root-deny permission profile, and it certifies the installed client's tool schema and isolation before inference. Codex retains ownership of login state and transport. Tokenless does not read its credential store. Codex currently has no independent switch for suppressing `$CODEX_HOME/AGENTS.override.md` or `$CODEX_HOME/AGENTS.md`; those provider-owned global instructions can influence and accompany the prompt even though Tokenless does not read them. The official-client backend fails closed on Windows and is never exposed through the API broker.

Normalized API adapters support OpenAI Responses, Anthropic Messages, Gemini Content, xAI Responses, and dedicated Antigravity Anthropic/Gemini routes. Antigravity has no default or private upstream: it requires an explicit compatible-gateway base URL and an unambiguous lowercase `claude-*` or `gemini-*` model family.

The direct broker binds a loopback address and requires its separate local bearer key for every request, including health and capabilities. It forwards only reviewed inference paths, enforces bounded headers, bodies, and deadlines, and closes outstanding upstream work during bounded graceful shutdown. OpenAI-shaped model discovery defaults to ChatGPT; callers must use an exact provider selector for Claude or Grok. Grok video generation, editing, extension, and status routes always require explicit Grok selection. Exact versioned Gemini and Antigravity model-discovery routes are allowed. The broker does not expose generic `/v1/usage`, `/antigravity/models`, `/antigravity/v1/usage`, unversioned model aliases, or provider/gateway administration, account, OAuth, payment, quota, and usage APIs.

Unlike the normalized direct-run adapters, the broker treats request bodies as opaque streaming bytes. It does not parse prompts or inject a storage preference. The caller controls any documented `store` field, and the configured provider or gateway retains responsibility for its own logging and retention.

## Daemon Identity And Lifecycle

The daemon binds only to loopback HTTP. `/health` is an unauthenticated diagnostic and is never trusted as identity. For `/ready`, the CLI generates a fresh canonical base64url 32-byte challenge. The daemon returns daemon protocol `tokenless.daemon.v1` plus `tokenless.daemon-ready-proof.v1` HMAC-SHA256 over length-prefixed proof protocol, challenge, daemon protocol, native protocol, and canonical `home_dir`, keyed by the trimmed home token. The CLI verifies with `timingSafeEqual` before every token-bearing public client operation. A wrong, missing, tampered, or replayed proof stops the flow before any Authorization header or prompt is sent.

Every `/jobs` and `/control/jobs` operation then requires `Authorization: Bearer <daemon.token>`. The proof and job request are consecutive loopback operations with no reusable proof cache. The intended local boundary assumes another OS user cannot replace a still-bound legitimate listener; if the verified daemon exits in the narrow interval before the request, the operation fails rather than intentionally handing authority to a different service. New-home bootstrap starts only the packaged daemon, waits for it to create the token, and requires a valid proof; a pre-bound spoof port cannot receive the token.

Concurrent CLI calls coordinate through a per-home startup lock. The starter writes a PID record and appends daemon output to a home-local log, then all callers re-probe `/ready`. The universal CLI contains no executable. Exact-version optional packages named `tokenless-native-<platform>-<arch>` hold the two release binaries; the resolver maps only the six supported tuples and uses local Node package resolution. `install` atomically copies those binaries to `<home>/bin`. There is no runtime download or lifecycle install script, and runtime users do not need Cargo.

The only accepted bridge marker is `<home>/extension-bridge.json` with protocol `tokenless.extension-bridge-state.v1` and exactly five fields: `protocol`, `pid`, `sessionId`, `connectedAt`, and `heartbeatAt`. Both timestamps must be strict ISO strings, no more than five seconds in the future, and connection time cannot follow heartbeat time beyond that tolerance. A marker is live only when its heartbeat is fresh and its PID exists (`EPERM` means alive; a dead PID is rejected). The host removes it on a graceful disconnect.

## Browser And Native Host Binding

Normal install resolves one Chromium browser and installs one native-host binding, avoiding multiple profiles racing to claim the global daemon queue. The manifest points directly to `<home>/bin/tokenless-native-host` and contains exactly one `chrome-extension://<id>/` allowed origin. Chrome for Testing writes both its current and compatibility locations: macOS 146+ `Google/ChromeForTesting` plus pre-146 `Google/Chrome`, and Linux `google-chrome-for-testing` plus legacy `google-chrome`. Other Chromium browsers use their native directories; Windows writes a manifest and registers it under the selected browsers' HKCU NativeMessagingHosts keys.

If no browser is configured, selection is deterministic: Chrome, Brave, Edge, Arc, then Chromium. The CLI never uses the arbitrary system default. Explicit target URLs must be HTTPS and match the selected provider hostname allowlist before they reach the OS launcher.

## Jobs, State, And Snapshots

Jobs and task metadata are daemon-backed. `tokenless state` uses the daemon's exact indexed `provider`/`task_id` filters rather than a finite local scan. It omits prompt bodies and claim tokens but preserves full `error_json` from the authenticated HTTP job view for actionable CLI failures. The extension Settings `list_history` path is separate: it uses a bounded scalar-only query and never includes arbitrary error payloads. A stable task id comes from explicit `--task-id`/`--idempotency-key` or the agent project/chat names.

Chrome Native Messaging frames are limited to 1 MiB from host to extension, so the CLI rejects request JSON above 900 KiB before job creation. `tokenless cancel --job-id` and SIGINT/SIGTERM report cancellation only after the authenticated control endpoint returns `canceled`. Proof, cancel, and job HTTP calls have finite deadlines. Once a signal arrives, ordinary polling is aborted and cannot win the cancellation decision. A failed or hanging cancellation exits nonzero and explicitly warns that the job may still be running or may already have completed.

## Native Package Release Matrix

Release CI builds and packs `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, and `win32-x64` on trusted matching builders. Generated `bin/` directories are gitignored; each native package has a publisher-only prepack verifier that refuses the wrong builder tuple, missing binaries, scripts disguised as binaries, or non-executable Unix artifacts. It also executes each binary with a five-second deadline and requires exact build identity protocol, daemon/native-host role, npm-aligned version, and normalized platform/architecture, so swapped or stale artifacts cannot be packed. The package `.npmignore` explicitly includes only the verified `bin/*`; there is no install-time verifier or lifecycle dependency. All six `tokenless-native-*` packages must be published at the exact CLI version before the binary-free universal `tokenless` package. Resolver and pack tests cover every tuple and perform a real pack/install smoke for the current builder tuple.

`snapshot-dom` uses the same daemon/bridge flow. The extension produces a sanitized snapshot payload; the CLI rejects an unsanitized payload and materializes artifacts under `<home>/snapshots/<provider>/`.

`run --long-running` is the attached visible-session mode for provider work expected to exceed the normal three-minute CLI wait. It sets a 35-minute visible-response wait and a 36-minute daemon-job deadline. The daemon keeps the claim lease alive while the extension waits on the visible provider DOM; the CLI emits `daemon_waiting` heartbeats every 30 seconds to stderr so JSON stdout remains parseable. This mode never converts a pending web job into a local agent run and must not be combined with `--no-wait`.

ChatGPT controls travel in the same authenticated job `request_json` as the prompt: `chatSurface`, `model`, `modelFallbacks`, and `effort`. `inspect_chatgpt_controls` exposes the live visible menu inventory and `configure_chatgpt` applies those controls without a prompt. For normal ChatGPT `submit` and `submit_and_read` jobs, the extension first ensures the two-option new-chat surface is on its first, semantic Chat radio; it never intentionally selects Work. The current ChatGPT UI exposes a Radix menu whose outer `menuitemradio` sequence represents the complete five-level Intelligence order and whose submenu radios represent available models. No page text is used to identify the Chat surface or complete effort sequence. Model matching uses visible model identifiers because the page exposes no stable model value. A missing requested model tries caller-supplied fallbacks then preserves the current model. An incomplete or ambiguous Intelligence menu preserves the current visible choice rather than guessing; a complete menu degrades only downward to the strongest enabled level. These availability fallbacks are returned in the job result and never stop prompt submission. If Work is visibly selected but Chat cannot be restored, submission is blocked rather than spending Work-surface tokens.

When ChatGPT requires a trusted user gesture for those visible controls, the content script asks the same Tokenless extension for an internal trusted click. The background service worker accepts only a top-frame ChatGPT sender whose canonical tab URL matches the request, bounds coordinates to the reported viewport, serializes clicks per tab, attaches Chrome debugger, sends only pressed and released `Input.dispatchMouseEvent` commands, and detaches on success or failure. A rejected or unavailable debugger click falls back to a safe DOM click. No companion extension ID or second extension artifact is involved.

## Safety Boundary

Visible-session adapters operate only through selectors and text visible in user-visible ChatGPT, Claude, Gemini, or Grok pages after host permission is granted. They report login, CAPTCHA, selector drift, rate limits, and user confirmations rather than bypassing them.

Direct adapters use provider-owned clients or documented public APIs with environment-only credentials. Tokenless does not store or extract provider cookies, localStorage/sessionStorage tokens, hidden authentication headers, or private provider backend API calls in either mode. It never imports subscription OAuth credentials into its broker, and the broker is not an arbitrary-path proxy. Prompt construction redacts obvious secrets and includes only user-approved files and context.
