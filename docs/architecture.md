# Tokenless Architecture

Tokenless exposes visible AI websites through a provider-neutral local CLI today. Managed Playwright through the authenticated local daemon is the only execution path; a public local API is planned but is not a compatibility surface yet.

## Components

1. The `tokenless` CLI handles setup, profile management, job submission, state, cancellation, and diagnostics.
2. The local TypeScript daemon stores jobs in SQLite and exposes an authenticated loopback control plane.
3. The Playwright worker claims managed-web jobs and runs them in persistent managed browser profiles.
4. The provider registry declares access, account-plan, selector, and capability policy for ChatGPT, Claude, Gemini, Grok, and Qwen.
5. The provider-session state machine turns visible page observations and catalog policy into ready, guest-continuation, handoff, wait, or terminal decisions.
6. Provider adapters translate shared actions into visible provider page operations after the session decision allows them.
7. A public local API is planned as a second interface to the same application and job contracts.

## Execution path

`tokenless run` submits a managed Playwright job through the local daemon. Tokenless never resends a failed request through another provider or runtime path.

| Interface | Execution path | Authentication | Status |
| --- | --- | --- | --- |
| CLI | CLI → daemon → Playwright worker → managed profile → visible provider page | Provider sign-in stored inside the managed profile | Primary interface |
| Local API | Local API → daemon → Playwright worker → managed profile → visible provider page | Provider sign-in stored inside the managed profile | Planned; schemas and client authentication are not public yet |

## Managed Playwright flow

```text
request
  → resolve provider and managed profile
  → validate target, actions, files, and limits
  → create an authenticated daemon job
  → Playwright worker claims the job for that profile
  → provider adapter operates visible page controls
  → verify visible postconditions
  → complete the daemon job
  → return normalized result and citations
```

Jobs use explicit provider and profile identity. Unsupported controls, ambiguous pages, unexpected navigation, authentication blockers, and selector drift fail closed.

## Setup and profiles

`tokenless setup` is the interactive onboarding flow. It invokes the shared maintenance reconciler to upsert both global agent skills and align the daemon with the installed `tokenless` package version, then discovers supported browsers, selects providers, and offers two profile paths:

- Import one existing Chrome or Brave profile with explicit consent. Only selected provider sign-in state is copied into a separate managed directory; the source remains unchanged.
- Create a clean managed profile without requiring provider sign-in during setup.

`tokenless setup --fresh` is the clean-profile path. Add `--json` for non-interactive setup. On a new installation it creates `default`, selects the first supported browser and ChatGPT, checks the installed CLI against the latest npm release, runs the same skills-and-daemon maintenance reconciler used by the verified new CLI during `tokenless upgrade`, checks each provider's visible sign-in status once, and reports the observed results without opening a sign-in handoff or retrying the check. Ordinary daemon startup uses the Tokenless Daemon API v1 OpenAPI contract: readiness comes from the same-home proof and exact package version on `/ready`, with API version recorded only in OpenAPI `info.version`. Job, action, and local recovery payloads keep internal schema IDs where persisted validation needs them; they are not negotiated across the CLI-daemon boundary. Setup may replace a daemon only when a verified same-home daemon reports a different package version. Foreign, different-home, and unverified listeners remain untouched. Shutdown verifies `/ready` for the same home immediately before sending the bearer token to `/control/shutdown`; Tokenless never kills a process merely because it occupies the configured loopback port. An unavailable npm registry is reported as an advisory check failure rather than making an otherwise runnable local setup fail.

Managed profiles live under the Tokenless home and use unique directories. Jobs reuse them but never import, reset, clear, or replace them automatically. Import, reset, and deletion require explicit commands and consent.

Authentication status is a single visible observation, not an enforced login workflow. A provider-specific account control is authenticated evidence; it does not have to be clicked to prove the state. A visible login surface is unauthenticated evidence. For guest-capable providers, an unauthenticated visible composer produces `access: guest`; for providers that require an account it produces `access: sign_in_required`. A page that has not stabilized may be reported honestly as `unknown`. Setup does not retry after login or open a handoff.

Successful account observations retain only the visible account display name, subscription evidence, and the normalized tier class `signed_in_free`, `signed_in_paid`, or `signed_in_unknown`. Plan labels remain diagnostic: they never authorize a capability. Grok derives plan evidence from visible model entitlements: all of `Auto`, `Expert`, and `Heavy` unavailable means `Free`, while any available entitlement means `SuperGrok`.

`profiles status` runs this provider-page inspection and persists the observation. `profiles list` is a registry read: it reports the last saved observation and never refreshes a provider page implicitly.

Normal provider actions do not run the setup authentication report. Before a gated action, the provider-session state machine waits up to 15 seconds for the page to expose a stable account, guest composer, sign-in surface, challenge, or terminal blocker. ChatGPT and Gemini may proceed in guest mode. Claude and Grok hand off before the adapter enters or submits task content when no authenticated session is established. A visible exact guest-continuation control may be accepted once, followed by a fresh observation.

## Provider architecture and session state machine

`packages/cli/src/providers/registry.ts` is the single production registration point for providers. Each entry is a concrete `BaseProvider` subclass with one provider-owned definition. Shared CLI, daemon, setup, profile, and Playwright code resolves providers through that registry instead of maintaining provider allowlists or branching on concrete provider IDs.

`BaseProvider` owns the public execution template and the invariant ordering for navigation validation, authentication, blocker checks, prompt operations, response observation, and normalized failures. Its protected TypeScript hooks provide the shared DOM implementation and use normal dynamic dispatch, so a provider subclass overrides only behavior that differs. The runner calls the stable public provider contract and does not select child-class methods itself.

Optional behavior is composed through typed structural capability slots. File upload, model and effort selection, workspace handling, diagnostics, conversation continuation, and image generation can be replaced independently without widening the mandatory base-class contract. Provider-specific extensions can register their own typed capability and actions without promoting a provider-only concept into the shared slots; Qwen's `qwen.mode` capability is the first such extension. A capability object must satisfy the relevant TypeScript interface; it does not need to inherit from a framework class.

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

The provider-session machine is intentionally separate from the daemon job state machine:

- The provider-session machine handles one page observation cycle: `wait`, `continue_guest`, `ready(guest|account|unknown)`, `handoff`, or `terminal`.
- The daemon state machine owns durable execution: `queued`, `claimed`, `running`, `waiting_for_user`, `succeeded`, `failed`, `canceled`, and `timed_out`.
- A provider `handoff` becomes the daemon's durable `waiting_for_user` state. It does not create a replacement job.
- A plan, quota, or rate-limit blocker remains terminal and is not collapsed into authentication.

## Local control plane

The daemon binds to loopback, stores its bearer token beside its SQLite database, and protects job and control endpoints with that token. The daemon home and token use restrictive filesystem permissions on supported systems. User configuration stores a preferred loopback origin. The daemon may scan upward from that port when it is occupied, while a single SQLite runtime-state row records the current actual origin, startup generation, and owner. CLI processes probe that row and coordinate startup through a compare-and-swap lease; no operating-system service actively restarts the daemon.

These HTTP endpoints are an internal runtime control plane, not the planned browser-facing API. A future web client must keep the daemon bearer token inside a trusted local backend rather than exposing it to browser JavaScript.

Job creation, claim, lease renewal, completion, cancellation, state queries, and agent replay are daemon-backed. Before readiness is activated, startup reconciles expired claims and durable Playwright checkpoints, then starts the runner. Claims are correlated to one worker and expire safely. CLI cancellation is reported as complete only after the authenticated control endpoint confirms `canceled`.

Jobs may be addressed to an explicit `agent_kind` and `agent_session_id`. SQLite assigns a monotonic outcome revision whenever an externally visible waiting or terminal outcome changes. `POST /replay/drain` selects only unreported actionable revisions for that recipient, marks them reported in the same immediate transaction, and then returns allowlisted metadata. This is intentional at-most-once reporting, not a reliable message queue: no agent acknowledgement is required, and a lost drain response is not proactively repeated. Full job state remains durable and repeatably queryable. Attached CLI commands write the same idempotent receipt before returning an addressed outcome.

Stable task identifiers come from explicit task or idempotency keys, or from agent project and chat names. State output omits capability tokens and does not expose raw authentication data.

## Browser boundary

- Playwright launches the configured supported Chromium browser with a persistent non-default user-data directory.
- Automation uses approved provider origins, visible page controls, and visible postconditions.
- Provider credentials and browser sign-in data stay opaque inside the managed profile; only visible account display and subscription labels cross the boundary.
- Sign-in, CAPTCHA, account limits, payment, consent, and confirmation remain user actions.
- Every provider adapter has an explicit action and capability contract. Unverified behavior is unavailable rather than guessed.
- Navigation and target URLs are canonicalized and checked before and after actions.

## Capability and Workspace strategy

The current visible-action schema includes `capability.inspect`, `workspace.ensure`, and the Qwen-only `qwen.mode.inspect/select` actions. Capability inspection reports `available`, `unavailable`, or `unknown` with visible proof, native resource information, fallback information, and experimental stability for every supported provider.

Subscription labels are diagnostic evidence, not authorization. Runtime decisions prefer an enabled visible control, then an explicit disabled, upgrade, or plan-limit state, and otherwise report `unknown`. Missing selectors never prove that a subscription lacks a capability.

Native Project creation remains unavailable until a complete fixture sequence proves its list, form, final mutation, and success postcondition. `workspace.ensure` therefore supports explicit conversation-scoped fallback. `auto` reports that fallback, `conversation` requires it, and `native` fails before prompt or file mutation. `--project-name` remains metadata unless the caller opts in with `--workspace-mode`.

Conversation fallback is scoped to one provider, managed profile, and task identifier. Before reusing a previous provider URL, the CLI queries the authenticated daemon and accepts only a successful same-scope job result that passes provider URL validation.

## Browser visibility policy

Tokenless stores browser visibility in config and defaults omitted values to `auto`. The same policy can be overridden per job, but the runner resolves it into the same managed-browser contract every time.

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

The managed profile lifecycle, local daemon, Playwright worker, CLI setup flow, readiness reporting, and job APIs are implemented. Provider parity, file-upload acceptance across all supported providers, and the public local API remain under active development. The roadmap is a delivery plan, not a compatibility guarantee.
