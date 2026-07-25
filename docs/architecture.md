# Tokenless Architecture

Tokenless exposes visible AI websites through a provider-neutral local CLI today. Managed Playwright through the authenticated local daemon is the only execution path; a public local API is planned but is not a compatibility surface yet.

## Components

1. The `tokenless` CLI handles setup, profile management, job submission, state, cancellation, and diagnostics.
2. The local Rust daemon stores jobs in SQLite and exposes an authenticated loopback control plane.
3. The Playwright worker claims managed-web jobs and runs them in persistent managed browser profiles.
4. Provider adapters translate shared actions into visible ChatGPT, Claude, Gemini, and Grok page operations.
5. A public local API is planned as a second interface to the same application and job contracts.

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

`tokenless setup` is the interactive onboarding flow. It installs both agent skills, discovers supported browsers, selects providers, and offers two profile paths:

- Import one existing Chrome or Brave profile with explicit consent. Only selected provider sign-in state is copied into a separate managed directory; the source remains unchanged.
- Create a clean managed profile and sign in through the visible provider page.

`tokenless setup --fresh` is the clean-profile path. Add `--json` for non-interactive setup. On a new installation it creates `default`, selects the first supported browser and ChatGPT, starts the runtime, and opens the provider when user action is required.

Managed profiles live under the Tokenless home and use unique directories. Jobs reuse them but never import, reset, clear, or replace them automatically. Import, reset, and deletion require explicit commands and consent.

Authentication checks fail closed: a provider-specific account control must be visible and successfully clicked. A composer or other generally available page control is not authentication evidence. Successful checks retain only the visible account display name and visible subscription evidence; absent or ambiguous plan evidence remains `null`. Grok derives that evidence from its visible model entitlements: all of `Auto`, `Expert`, and `Heavy` unavailable means `Free`, while any available entitlement means `SuperGrok`.

`profiles status` runs this provider-page inspection and persists the observation. `profiles list` is a registry read: it reports the last saved observation and never refreshes a provider page implicitly.

## Local control plane

The daemon binds to loopback, stores its bearer token beside its SQLite database, and protects job and control endpoints with that token. The daemon home and token use restrictive filesystem permissions on supported systems.

These HTTP endpoints are an internal runtime control plane, not the planned browser-facing API. A future web client must keep the daemon bearer token inside a trusted local backend rather than exposing it to browser JavaScript.

Job creation, claim, lease renewal, completion, cancellation, and state queries are daemon-backed. Claims are correlated to one worker and expire safely. CLI cancellation is reported as complete only after the authenticated control endpoint confirms `canceled`.

Stable task identifiers come from explicit task or idempotency keys, or from agent project and chat names. State output omits capability tokens and does not expose raw authentication data.

## Browser boundary

- Playwright launches the configured supported Chromium browser with a persistent non-default user-data directory.
- Automation uses approved provider origins, visible page controls, and visible postconditions.
- Provider credentials and browser sign-in data stay opaque inside the managed profile; only visible account display and subscription labels cross the boundary.
- Sign-in, CAPTCHA, account limits, payment, consent, and confirmation remain user actions.
- Every provider adapter has an explicit action and capability contract. Unverified behavior is unavailable rather than guessed.
- Navigation and target URLs are canonicalized and checked before and after actions.

## Capability and Workspace strategy

Visible action protocol v2 adds `capability.inspect` and `workspace.ensure`; the worker continues accepting stored v1 requests for legacy actions. Capability inspection reports `available`, `unavailable`, or `unknown` with visible proof, native resource information, fallback information, and experimental stability for every supported provider.

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

The managed profile lifecycle, local daemon, Playwright worker, CLI setup flow, readiness handoff, and job APIs are implemented. Provider parity, file-upload acceptance across all four providers, and the public local API remain under active development. The roadmap is a delivery plan, not a compatibility guarantee.
