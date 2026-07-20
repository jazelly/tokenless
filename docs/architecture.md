# Tokenless Architecture

Tokenless exposes visible AI websites through provider-neutral local interfaces. Managed web mode is the primary path; direct mode is explicit and experimental.

## Components

1. The `tokenless` CLI handles setup, profile management, job submission, state, cancellation, and diagnostics.
2. The local Rust daemon stores jobs in SQLite and exposes an authenticated loopback control plane.
3. The Playwright worker claims managed-web jobs and runs them in persistent managed browser profiles.
4. Provider adapters translate shared actions into visible ChatGPT, Claude, Gemini, and Grok page operations.
5. The local API is being stabilized as a second interface to the same job and action contracts.

## Mode selection

`tokenless run` uses managed web mode by default. `--mode direct` must be selected explicitly. Mode selection happens before runtime initialization, and Tokenless never resends a failed request through another mode.

| Mode | Execution path | Authentication |
| --- | --- | --- |
| Managed web | CLI or local API → daemon → Playwright worker → managed profile → visible provider page | Provider sign-in stored inside the managed profile |
| Direct | CLI or authenticated direct broker → official client, public provider API, or configured gateway | Provider-owned login or environment-supplied API credential |

## Managed web flow

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

## Local control plane

The daemon binds to loopback, stores its bearer token beside its SQLite database, and protects job and control endpoints with that token. The daemon home and token use restrictive filesystem permissions on supported systems.

Job creation, claim, lease renewal, completion, cancellation, and state queries are daemon-backed. Claims are correlated to one worker and expire safely. CLI cancellation is reported as complete only after the authenticated control endpoint confirms `canceled`.

Stable task identifiers come from explicit task or idempotency keys, or from agent project and chat names. State output omits capability tokens and does not expose raw authentication data.

## Browser boundary

- Playwright launches the configured supported Chromium browser with a persistent non-default user-data directory.
- Automation uses approved provider origins, visible page controls, and visible postconditions.
- Provider sign-in state stays opaque inside the managed profile.
- Sign-in, CAPTCHA, account limits, payment, consent, and confirmation remain user actions.
- Every provider adapter has an explicit action and capability contract. Unverified behavior is unavailable rather than guessed.
- Navigation and target URLs are canonicalized and checked before and after actions.

## File handling

The CLI accepts only intentionally selected regular files. It stages them under the Tokenless home, records bounded metadata and integrity hashes, and passes private staged paths only to the local worker. Provider adapters upload through visible file inputs and verify the resulting filename or other visible postcondition. Daemon results do not expose raw caller paths.

## Long-running and user-handoff states

Managed jobs transition through daemon states such as `queued`, `claimed`, `running`, `waiting_for_user`, `succeeded`, `failed`, `canceled`, and `timed_out`. When a provider requires visible user action, the existing job and browser profile remain authoritative. Callers must resume or query that job rather than submitting a replacement.

`--long-running` extends the attached wait for provider work that exceeds the normal timeout while keeping machine-readable stdout clean. `--no-wait` is a detached submission option and is not used for flows that require immediate user handoff.

## Direct mode boundary

Direct mode does not start the daemon or managed browser runtime. Credentials come from the current process environment or remain owned by the selected official client. Remote upstreams require HTTPS, except explicit loopback development. Redirects, implicit retries, and cross-provider fallback are disabled.

The direct broker binds to loopback and requires its own bearer key. It forwards reviewed public inference routes, strips inbound credentials and cookies, enforces bounded bodies and deadlines, and closes outstanding work during graceful shutdown. See [Direct mode](direct-mode.md) for the current route contract.

## Current delivery status

The managed profile lifecycle, local daemon, Playwright worker, CLI setup flow, readiness handoff, and job APIs are implemented. Provider parity, file-upload acceptance across all four providers, and the public local API remain under active development. The roadmap is a delivery plan, not a compatibility guarantee.
