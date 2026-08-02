# Tokenless Architecture

Tokenless exposes visible AI websites through a provider-neutral local CLI and a browser-based local control plane. Managed Playwright through the authenticated local daemon remains the only provider execution path. The machine bearer API and browser session API are separate trust boundaries.

## Components

1. The `tokenless` CLI handles setup, profile management, job submission, state, cancellation, and diagnostics.
2. The local TypeScript daemon stores jobs in SQLite and exposes an authenticated loopback control plane.
3. The Playwright worker claims managed-web jobs and runs them in persistent managed browser profiles.
4. The provider registry declares access, account-plan, selector, and capability policy for ChatGPT, Claude, Gemini, Grok, Qwen, DeepSeek, Perplexity, Z.ai, and Doubao.
5. The provider-session state machine turns visible page observations and catalog policy into ready, guest-continuation, handoff, wait, or terminal decisions.
6. Provider adapters translate shared actions into visible provider page operations after the session decision allows them.
7. Shared application services expose redacted config, profile, provider, capability, job, runtime, and diagnostic operations to the local control plane.
8. The bundled TypeScript SPA is served from `/ui/`; its authenticated `/ui-api/v1` surface never exposes the daemon control bearer token to browser JavaScript.

## Execution path

`tokenless run` submits a managed Playwright job through the local daemon. For an implicit, provider-neutral, pre-submit run, the same durable job may move to another provider only through its capability-ranked fallback plan. It never switches runtime paths, degrades a required capability, or replays after an ambiguous or confirmed submission.

| Interface | Execution path | Authentication | Status |
| --- | --- | --- | --- |
| CLI | CLI → daemon → Playwright worker → managed profile → visible provider page | Provider sign-in stored inside the managed profile | Primary interface |
| Local dashboard | Browser → `/ui-api/v1` → shared services/daemon → managed profile → visible provider page | One-time bootstrap ticket plus short-lived UI session; provider sign-in remains inside the managed profile | Local administration interface |
| Machine API | Trusted local caller → bearer API → daemon → Playwright worker | Daemon bearer token plus provider sign-in inside the managed profile | Local scripting interface |

## Managed Playwright flow

```text
request
  → derive the complete task capability set
  → rank compatible providers by live eligibility, evidence maturity, and configured preference
  → validate target, actions, context envelope, files, and limits
  → create an authenticated daemon job
  → Playwright worker claims the job for that profile
  → recheck visible session and task-capability eligibility before mutation
  → provider adapter operates visible page controls
  → verify visible postconditions
  → atomically requeue the same job on the next ranked provider only for a classified safe pre-submit failure
  → complete the daemon job
  → return normalized result and citations
```

Jobs use explicit provider and profile identity. Unsupported controls, ambiguous pages, unexpected navigation, authentication blockers, and selector drift fail closed.

The job contract derives requirements again from visible actions, attachment media types, and native workspace intent. A caller cannot under-declare `file.upload`, media input, chat, or native workspace requirements to manufacture an unsafe fallback route. Every alternative carries the identical implication-complete requirement set. Provider-specific conversation and Project URLs, provider controls, exact continuation, non-reconstructable mutations, and post-submission state suppress automatic fallback with a structured reason.

Before opening a provider page, each attempt also projects known profile-scoped provider capacity from the checked-in official-source catalog and durable submission history. A known exhausted window consumes the next full-capability route when one exists; otherwise the same job is durably deferred until its calculated eligibility time. Unknown or non-numeric limits remain explicit uncertainty and never become invented quotas.

Each routed job carries `tokenless.context-envelope.v1`. It records the task identity, normalized requirements, role-bearing instructions, attachment provenance, output and constraint contracts, upstream agent state, and hashes of the prompt actions that actually deliver the context. Provider changes replay the same validated envelope and action payloads from the start.

## Setup and profiles

`tokenless setup` is the interactive onboarding flow. It first crosses the `BrowserRuntimeManager` seam to discover, install when authorized, and verify one exact runtime. It then selects or creates a clean runtime-compatible profile, collects that profile's provider membership, commits the preference, aligns the global skills and daemon with the installed CLI, and checks only the selected providers. Tokenless never copies an existing Chrome, Brave, or Cloak profile or its authentication state; users sign in through the visible clean managed profile and the browser preserves that managed session across jobs.

`tokenless setup --fresh` is the clean-profile path. Add `--json` for non-interactive setup. On a new installation it creates `default`, selects the first supported browser, uses an explicit or existing provider scope (falling back to every non-disabled provider only when none exists), checks the installed CLI against the latest npm release, runs the same skills-and-daemon maintenance reconciler used by the verified new CLI during `tokenless upgrade`, and checks each enabled provider's visible sign-in status once. Interactive setup then opens the reserved dashboard tab; machine-oriented and `--no-open` runs return `tokenless dashboard` as the later handoff. Ordinary daemon startup uses the Tokenless Daemon API v1 OpenAPI contract: readiness comes from the same-home proof and exact package version on `/ready`, with API version recorded only in OpenAPI `info.version`. Job, action, and local recovery payloads keep internal schema IDs where persisted validation needs them; they are not negotiated across the CLI-daemon boundary. Setup may replace a daemon only when a verified same-home daemon reports a different package version. Foreign, different-home, and unverified listeners remain untouched. Shutdown verifies `/ready` for the same home immediately before sending the bearer token to `/control/shutdown`; Tokenless never kills a process merely because it occupies the configured loopback port. An unavailable npm registry is reported as an advisory check failure rather than making an otherwise runnable local setup fail.

Browser selection is system-first. `auto` uses an installed supported browser and lazily installs catalog-pinned Chrome for Testing 145 only when none exists. `managed-chromium` forces that cache-managed runtime; `cloak` explicitly opts into the platform-specific Cloak release. Managed downloads happen only during setup or install, pass fixed SHA-256, archive-path, executable-version, sandboxed smoke-launch, and atomic-cache checks, and are never performed by npm postinstall, daemon startup, or a job. Cloak binaries are downloaded from the official release and are not redistributed by Tokenless.

Each managed profile stores a runtime binding containing the exact runtime identity, family, browser ID, and creation version. The daemon resolves from this binding and always passes the resulting executable path to Playwright. It never reinterprets the global preference, silently falls back across runtime families, or opens a profile with an older browser. Existing unbound profiles can migrate only to a compatible system/test runtime; a family change provisions a clean profile.

Managed profiles live under the Tokenless home and use unique directories. Jobs reuse them but never import, reset, clear, or replace them automatically. New profiles always start clean; deletion requires an explicit command and confirmation.

Authentication status is a single visible observation, not an enforced login workflow. A provider-specific account control is authenticated evidence; it does not have to be clicked to prove the state. A visible login surface is unauthenticated evidence. For guest-capable providers, an unauthenticated visible composer produces `access: guest`; for providers that require an account it produces `access: sign_in_required`. A page that has not stabilized may be reported honestly as `unknown`. Setup does not retry after login or open a handoff.

Successful account observations retain only the visible account display name, subscription evidence, and the normalized tier class `signed_in_free`, `signed_in_paid`, or `signed_in_unknown`. Plan labels remain diagnostic: they never authorize a capability. Grok derives plan evidence from visible model entitlements: all of `Auto`, `Expert`, and `Heavy` unavailable means `Free`, while any available entitlement means `SuperGrok`.

`profiles status` runs this provider-page inspection and persists the observation. `profiles list` is a registry read: it reports the last saved observation and never refreshes a provider page implicitly.

Normal provider actions do not run the setup authentication report. Before a gated action, the provider-session state machine waits up to 15 seconds for the page to expose a stable account, guest composer, sign-in surface, challenge, or terminal blocker. ChatGPT, Gemini, experimental Qwen, experimental Perplexity, and experimental Z.ai may proceed in guest mode. Claude, Grok, DeepSeek, and experimental Doubao hand off before the adapter enters or submits task content when no authenticated session is established. A visible exact guest-continuation control may be accepted once, followed by a fresh observation.

## Provider architecture and session state machine

`packages/cli/src/providers/registry.ts` is the single production registration point for providers. Each entry is a concrete `BaseProvider` subclass with one provider-owned definition. Shared CLI, daemon, setup, profile, and Playwright code resolves providers through that registry instead of maintaining provider allowlists or branching on concrete provider IDs.

`BaseProvider` owns the public execution template and the invariant ordering for navigation validation, authentication, blocker checks, prompt operations, response observation, and normalized failures. Its protected TypeScript hooks provide the shared DOM implementation and use normal dynamic dispatch, so a provider subclass overrides only behavior that differs. The runner calls the stable public provider contract and does not select child-class methods itself.

Optional behavior is composed through typed structural capability slots. File upload, model and effort selection, workspace handling, diagnostics, conversation continuation, and image generation can be replaced independently without widening the mandatory base-class contract. Provider-specific extensions can register their own typed capability and actions without promoting a provider-only concept into the shared slots; current examples are Qwen's `qwen.mode` and Doubao's `doubao.mode` plus `doubao.skill`. A capability object must satisfy the relevant TypeScript interface; it does not need to inherit from a framework class.

Adding a provider therefore normally requires:

1. one provider definition backed by real visible-session evidence;
2. one `BaseProvider` subclass, with protected hook overrides only for genuine differences;
3. typed optional capability overrides only when the provider differs from the shared defaults; and
4. one registry entry.

Observation, account classification, decisions, and resolution live under `packages/cli/src/playwright/provider-session/`. The runner consumes normalized decisions; provider-owned code remains the only place for provider-specific visible-page behavior.

| Provider | Guest policy | Account-name strategy | Plan strategy |
| --- | --- | --- | --- |
| ChatGPT | Supported | Visible account control text | `Free`; paid `Go`, `Plus`, `Pro`, `Team`, `Business`, or `Enterprise` |
| Claude | Sign-in required | Visible account control text | `Free`; paid `Pro`, `Max`, `Team`, or `Enterprise` |
| Gemini | Supported | Google account ARIA label | Unknown until reliable visible plan evidence is available |
| Grok | Sign-in required | Visible account control text | Derived from visible model entitlements as `Free` or `SuperGrok` |
| Qwen | Supported | Visible account control text when signed in | Unknown until reliable visible plan evidence is available |
| DeepSeek | Sign-in required | Visible account control text | Unknown until reliable visible plan evidence is available |
| Perplexity | Supported | Visible menu or account control text when signed in | Unknown until reliable visible plan evidence is available |
| Z.ai | Supported | Visible menu or account control text when signed in | Unknown until reliable visible plan evidence is available |
| Doubao | Sign-in required | Visible account control image | Unknown until reliable visible plan evidence is available |

The provider-session machine is intentionally separate from the daemon job state machine:

- The provider-session machine handles one page observation cycle: `wait`, `continue_guest`, `ready(guest|account|unknown)`, `handoff`, or `terminal`.
- The daemon state machine owns durable execution: `queued`, `claimed`, `running`, `waiting_for_user`, `succeeded`, `failed`, `canceled`, and `timed_out`.
- A provider `handoff` becomes the daemon's durable `waiting_for_user` state. It does not create a replacement job.
- A plan, quota, rate-limit, maintenance, region, capability-UI, navigation, or surface-readiness failure remains structurally classified and is not collapsed into authentication. A safe pre-submit provider-scoped failure may consume the next capability-compatible fallback route; ambiguous external state and post-submission failures never do.

## Local control plane

The daemon binds to loopback, stores its bearer token beside its SQLite database, and protects job and control endpoints with that token. The daemon home and token use restrictive filesystem permissions on supported systems. User configuration stores a preferred loopback origin. The daemon may scan upward from that port when it is occupied, while a single SQLite runtime-state row records the current actual origin, startup generation, and owner. CLI processes probe that row and coordinate startup through a compare-and-swap lease; no operating-system service actively restarts the daemon.

The bearer-protected machine endpoints remain an internal runtime control plane. Browser administration uses a separate `/ui-api/v1` surface documented in `api/tokenless-ui-api.openapi.json`. An authenticated CLI call mints a random, 60-second, single-use ticket; `/ui/bootstrap` consumes it, sets an `HttpOnly`, `SameSite=Strict`, path-scoped session cookie, and redirects to `/ui/` so the ticket leaves browser history. UI mutations require the exact daemon Origin and a per-session CSRF header. Sessions live only in daemon memory and are invalidated on restart.

All UI routes enforce the daemon's exact loopback `Host`, a restrictive same-origin CSP, `frame-ancestors 'none'`, `nosniff`, and `Referrer-Policy: no-referrer`. The browser application lives under `packages/cli/src/daemon/ui`: `app.ts` is the single startup interface, the dashboard controller owns state and event orchestration, the HTTP client owns session/CSRF/ETag behavior, and page modules are pure renderers. A dedicated `tsconfig.ui.json` type-checks and emits browser-native ES modules separately from the Node daemon build. Static assets are still bundled in the same npm package, served by the daemon, and load no remote JavaScript, fonts, analytics, or CDN resources. Purpose-built responses redact control tokens, claims, checkpoints, browser storage, raw DOM, legacy source paths, and private file paths. Bounded polling uses revision ETags and defers rendering while a form has uncommitted edits; there is no SSE or WebSocket transport.

The dashboard's reserved page key is `tokenless:control-plane:<daemon-home-id>`. It has a separate registry from provider page leases, cannot be selected by provider `pagePolicy: replace`, is focused rather than duplicated, and is recreated if the user closes it. Closing the tab does not stop the daemon or managed context.

Job creation, claim, lease renewal, completion, cancellation, state queries, and agent replay are daemon-backed. Before readiness is activated, startup reconciles expired claims and durable Playwright checkpoints, then starts the runner. Claims are correlated to one worker and expire safely. CLI cancellation is reported as complete only after the authenticated control endpoint confirms `canceled`.

Jobs may be addressed to an explicit `agent_kind` and `agent_session_id`. SQLite assigns a monotonic outcome revision whenever an externally visible waiting or terminal outcome changes. `POST /replay/drain` selects only unreported actionable revisions for that recipient, marks them reported in the same immediate transaction, and then returns allowlisted metadata. This is intentional at-most-once reporting, not a reliable message queue: no agent acknowledgement is required, and a lost drain response is not proactively repeated. Full job state remains durable and repeatably queryable. Attached CLI commands write the same idempotent receipt before returning an addressed outcome.

Stable task identifiers come from explicit task or idempotency keys, or from agent project and chat names. State output omits capability tokens and does not expose raw authentication data.

## Browser boundary

- Each active managed profile owns one browser instance backed by that profile's persistent user-data directory. Providers and conversations use independently keyed tabs inside their profile's browser. The daemon may retain up to four profile-owned instances and never closes one profile to launch another; additional profiles wait for capacity or fail explicitly at a direct open boundary.
- Playwright launches the exact executable resolved from the profile's runtime binding with a persistent non-default user-data directory. The browser library and managed browser versions are independently pinned.
- Automation uses approved provider origins, visible page controls, and visible postconditions.
- Provider credentials and browser sign-in data stay opaque inside the managed profile; only visible account display and subscription labels cross the boundary.
- Sign-in, CAPTCHA, account limits, payment, consent, and confirmation remain user actions.
- Every provider adapter has an explicit action and capability contract. Unverified behavior is unavailable rather than guessed.
- Navigation and target URLs are canonicalized and checked before and after actions.
- Pages are owned by a logical key derived from provider plus stable task identity, or provider plus job identity when no task exists. The default preserve policy never navigates an unrelated owned page; replacement requires an explicit job policy.
- The control-plane page is separately reserved and can never be acquired, navigated, or replaced by a provider job.

## Capability and Workspace strategy

The public capability vocabulary, provider mapping rules, evidence ladder, and extension process are defined in the [Capability Matrix](capability-matrix.md). This section describes how that contract is executed by the runtime.

The current visible-action schema includes `capability.inspect`, `workspace.ensure`, Qwen-only `qwen.mode.inspect/select`, DeepSeek control actions, and Doubao-only `doubao.mode.inspect/select` plus `doubao.skill.inspect/select`. Capability inspection reports `available`, `unavailable`, or `unknown` with visible proof, native resource information, fallback information, and experimental stability for every enabled provider. Provider-control results may include canonical candidate mappings, but only independently E2E-closed outcome lifecycles enter the route table.

Subscription labels are diagnostic evidence, not authorization. Runtime decisions prefer an enabled visible control, then an explicit disabled, upgrade, or plan-limit state, and otherwise report `unknown`. Missing selectors never prove that a subscription lacks a capability.

Native Project creation and reuse are capability-gated runtime behavior. The implementation can use exact visible names, report `created` or `reused`, and persist provider resource identity, but `workspace.native` is not currently routeable because the complete real-provider Project gate has not passed. `auto` can report conversation fallback only after stable visible native unavailability, `conversation` requires that strategy, and `native` fails before prompt or file mutation. `--project-name` remains metadata unless the caller opts in with `--workspace-mode`.

Conversation fallback is scoped to one provider, managed profile, and task identifier. Before reusing a previous provider URL, the CLI queries the authenticated daemon and accepts only a successful same-scope job result that passes provider URL validation.

## Browser visibility policy

Tokenless stores a global browser visibility fallback and profile-scoped visibility preferences, defaulting omitted values to `auto`. The same policy can be overridden per job, but the runner resolves it into the same managed-browser contract every time. Profile preferences also contain provider routing membership, a human role label, and an optional credential-free HTTP/HTTPS/SOCKS5 proxy. Proxy changes require browser quiescence and cause the persistent context to be recreated.

The persistent config also stores `browserConnectionMode`, with `playwright` as the backward-compatible default and `cdp` as an experimental capability-evaluation mode. This is a daemon-runner setting rather than a job field or CLI flag. Native mode uses `launchPersistentContext`; CDP mode launches the exact profile-bound Chromium executable with an ephemeral loopback DevTools endpoint and then uses `connectOverCDP`. Both modes preserve the same profile, visibility, page-key, provider, and durable-mapping contracts. The daemon must be restarted after this config value changes.

- `auto` starts headless. If the provider page becomes blocked by user-resolvable sign-in, CAPTCHA, MFA, consent, or confirmation, the runner switches the same managed profile into headed mode and marks the job `waiting_for_user`.
- Terminal errors do not trigger a visible window.
- `headless` never opens a visible window. If that job parks, the same daemon job must later be resumed with headed visibility instead of submitting a replacement job.
- `profiles open` is always headed. `doctor` is read-only. Chromium sandbox stays enabled in both modes.
- The same `jobId`, `taskId`, and profile identity are preserved across a visible handoff. Callers query or resume the same daemon job instead of creating a new one.
- Auto-escalated windows close after 30 seconds of idle time after the job completes. Explicit headed and `profiles open` windows remain open until closed.

## File handling

The CLI accepts only intentionally selected regular files. It stages them under the Tokenless home, records bounded metadata and integrity hashes, and passes private staged paths only to the local worker. Provider adapters use provider-specific visible upload controls or generated file inputs. A hidden `FileList` proves only `selected`; only a visible filename, attachment chip, preview, or equivalent postcondition proves `accepted`. Daemon results do not expose raw caller paths.

## Long-running and user-handoff states

Managed jobs transition through daemon states such as `queued`, `claimed`, `running`, `waiting_for_user`, `succeeded`, `failed`, `canceled`, and `timed_out`. When a provider requires visible user action, the existing job and browser profile remain authoritative. Callers must resume or query that job rather than submitting a replacement.

`--long-running` extends the attached wait for provider work that exceeds the normal timeout while keeping machine-readable stdout clean. `--no-wait` is a detached submission option and is not used for flows that require immediate user handoff.

## Current delivery status

The managed profile lifecycle, local daemon, Playwright worker, CLI setup flow, readiness reporting, job APIs, and browser-based local control plane are implemented. The UI API is local and purpose-built for the bundled dashboard; it is not a remote administration contract. Provider parity and file-upload acceptance across enabled providers remain under active development. The roadmap is a delivery plan, not a compatibility guarantee.
