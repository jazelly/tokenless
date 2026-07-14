# Tokenless Account Pool and Project Routing

Status: Implemented and independently verified

Date: 2026-07-13

Related design: [Tokenless Direct Mode and Gateway Broker](./direct-gateway-rfc.md)

## Decision

Tokenless direct mode will provide one authenticated, loopback-only API over a local pool of provider accounts. Routing is keyed by the exact pair `(project, provider)`. The first request may atomically assign an eligible account and persist that binding; operators may also create the binding explicitly. Every later request for that pair prefers the same account while it remains healthy.

This is stronger than a time-limited sticky-session cache. Adding an account, restarting Tokenless, changing process order, or receiving concurrent requests must not move an existing project. However, availability is the first priority: when Tokenless can prove that the preferred account is unavailable, it selects a healthy fallback and persistently migrates the project binding. The recovered old account does not automatically take the project back, so failover does not become per-request oscillation.

The first subscription-backed account driver is ChatGPT through the provider-owned Codex executable. Each ChatGPT account has an isolated, Tokenless-managed `CODEX_HOME`; Codex owns login, refresh, credential storage, and upstream transport inside that home. Tokenless records the account identifier and routing metadata but never opens, parses, copies, exports, or proxies the credential file.

Tokenless remains a local, single-operator tool. This design does not turn consumer subscriptions into a hosted resale service, a multi-user remote gateway, or a private-provider API implementation.

## Product contract

### Account identity

An account is selected administratively by `(provider, accountId)`. `accountId` is a normalized lowercase user-chosen slug, not an email address discovered by Tokenless. Every record also has a Tokenless-generated, immutable opaque UUID used for all filesystem paths, locks, references, and compare-and-swap operations. A label may be stored for operator convenience. The slug and label can never influence a profile path.

Account records have these routing fields:

- `provider`: the Tokenless provider id;
- `accountId`: an operator-selected, lowercase URL-safe slug unique within the provider;
- `internalId`: an immutable Tokenless-generated UUID never accepted from inference callers;
- `driver`: the supported provider-owned client or public API driver;
- `enabled`: whether new work may use the account;
- `health`: a durable `usable` or `unavailable` state with a monotonically increasing generation for compare-and-swap updates;
- `routingDomain`: an operator-declared failover boundary; legacy and explicitly isolated Codex accounts use `null`;
- `maxConcurrency`: the account-local execution limit;
- optional operator label and non-secret driver configuration; and
- a provider-owned identity fingerprint where the admitted client exposes non-secret account metadata; and
- creation and update timestamps.

Secrets are not fields in this record. Public API accounts may name an environment variable that supplies their key to the server process. Provider-owned-client accounts refer only to their managed profile id. For Codex, Tokenless asks the official app-server `account/read` method for account metadata without requesting token refresh, computes a keyed local fingerprint from the returned identity, immediately discards the raw identity, and persists only the fingerprint. Onboarding rejects a null identity or a second profile that resolves to the same fingerprint. A later identity mismatch fails closed until an operator explicitly relinks the profile.

### Project identity and binding

API callers send one exact `x-tokenless-project` header. Project ids are case-sensitive, URL-safe identifiers and are never inferred from prompt text, model names, working directories, IP addresses, or bearer keys.

Bindings are provider-specific:

```text
(project-a, chatgpt) -> (chatgpt, personal-one)
(project-b, chatgpt) -> (chatgpt, personal-two)
(project-a, claude)  -> (claude, team-api)
```

A project can therefore use different accounts for different providers. Two projects may share an account, and an operator may pin projects to accounts explicitly.

For an unbound public API pair, the default `auto-pin` policy selects one enabled, route-compatible account inside an operator-declared, provider-authorized routing domain using deterministic rendezvous hashing, then persists the choice before dispatching inference. The state write is serialized across processes, so simultaneous first requests cannot create two answers from different accounts. Existing healthy bindings are never rebalanced. ChatGPT subscription profiles never participate in automatic first-use assignment: the local operator must explicitly pin each `(project, chatgpt)` pair before inference.

Each binding has a monotonically increasing generation, one preferred account, and a failover policy. The default policy is `availability-first`; an optional `strict` policy is available when an operator explicitly values account identity above availability. Manual pinning changes the preferred account but does not silently imply `strict`.

### Failure and failover

Project affinity is a strong preference beneath the higher-level availability guarantee. Tokenless keeps a project on its preferred account while that account is healthy. Failover eligibility is driver-specific and must satisfy both delivery safety and provider policy; availability-first never means bypassing a restriction.

Failover depends on whether Tokenless can prove that replay is safe:

- A proven pre-dispatch, profile-local failure such as an operator-disabled account, a successful structured identity check returning no ChatGPT account, a non-ChatGPT account, an explicitly unverifiable identity, or a different account fingerprint, or an invalid managed home may select a fallback before any prompt is sent. Malformed or unavailable app-server output remains a driver-global failure and does not change account health.
- A missing or locally invalid public API credential environment value is proven before dispatch, receives its own stable API-only health reason, and may select a fallback before any prompt byte is sent.
- A public API driver may use an explicit, documented rejection that proves account unavailability, such as revoked authentication, to update health and migrate the next request. The initial implementation does not replay the current request after any body byte was sent. Health classification uses structured protocol status, never provider error-message matching.
- A timeout, connection loss, process crash, or server error after dispatch is ambiguous because the provider may have accepted the prompt. Tokenless does not blindly replay that request or change the binding from that failure alone. The current caller receives an explicit ambiguous-delivery error unless a provider-documented idempotency contract proves replay safe.
- A request-validation, unsupported-feature, or caller-cancellation error does not make the account unhealthy and does not trigger failover.

The Codex CLI currently exposes execution failures as free-form machine events without a versioned rejection code or a guarantee that the prompt was not accepted. For the ChatGPT subscription driver, every failure after Codex is spawned and receives the prompt is therefore ambiguous. Only proven pre-dispatch profile failures may trigger automatic account failover. Failure to start or communicate with Codex app-server, malformed identity output, capability failure, timeout, or executable failure is driver-global and never changes a binding. Post-dispatch failures do not replay the current prompt and are not used as an automatic migration signal because Tokenless cannot distinguish an operational failure from a provider quota or rate restriction. Tokenless will relax this rule only if the official client later exposes a structured no-acceptance reason and OpenAI explicitly admits that reason for account failover.

This policy boundary is intentional. OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/) prohibit circumventing rate limits or restrictions, and its [account sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy) treats an account as belonging to the individual who created it. ChatGPT subscription scheduling therefore never treats quota exhaustion, rate limiting, slot pressure, or generic execution failure as a failover signal and never combines accounts to expand effective limits or concurrency. Every personal ChatGPT profile must be an account created and used by the same local operator; an organization profile must be a provider-supported seat assigned to that same operator under the organization's terms. Tokenless does not let one operator pool, administer, or use another person's account or shared credentials. Public API drivers must follow the applicable provider and organization terms and likewise do not rotate credentials to evade limits.

The first successful fallback for a confirmed account-health failure becomes the project's persisted preferred account. Migration is generation-checked and serialized per project so concurrent failures cannot make the binding flap between accounts. Automatic selection excludes accounts already attempted for the request and has a finite attempt and time budget. API errors expose only attempt count, delivery state, and stable machine-readable reasons; account ids are available solely in the local administrative audit view.

Account-health rejection is itself generation-checked. A structured, stable reason marks only the exact account generation observed by the failing request; provider response bodies, prompts, requests, and credential material are never persisted. Operator recovery clears health by advancing the generation, so a late response from before that recovery is a no-op and cannot re-block the account. Clearing or re-enabling an old account never switches an already migrated project back.

Automatic migration is deterministic rendezvous selection over enabled, ready, usable accounts with the same provider, driver, and non-null routing domain. It is allowed only after the current preferred account is disabled or durably unavailable. A `strict` binding, an isolated `null` domain, or a cross-domain candidate never migrates automatically. These rules apply to Codex profiles as well as public API accounts; ChatGPT profiles still require an explicit initial project pin.

An operator may deliberately rebind a project at any time. Rebinding and automatic migration are auditable state mutations and affect new dispatches; already accepted work stays attached to the account that received it.

### Concurrency

Every account has a bounded FIFO queue within one broker process and an execution limit. The advisory lock guarantees cross-process mutual exclusion, not global FIFO ordering. The Codex driver hard-codes each profile limit to one because provider-owned credential refresh is not cross-process safe; configuration cannot raise it. All managed ChatGPT subscription profiles additionally share one global inference lock, so Tokenless never aggregates subscription concurrency across accounts. A detached one-shot Tokenless helper owns the sorted SQLite write transactions, writes durable mode-`0600` lease tombstones before launching Codex, and remains the process-group leader for the complete managed operation. Codex children stay in that helper's process group and do not inherit its private control channel. If the client or helper crashes, a later contender holds the same SQLite locks and reclaims a tombstone only after proving a different boot, the exact helper process-group id reuse case, or that the old process group no longer exists. A live or unprobeable group remains fenced; Tokenless never clears or kills it speculatively. Browser-based account login holds a separate global lock because the provider-owned login flow uses shared loopback ports. Managed homes are reserved for Tokenless and must not be shared with an IDE or manually launched Codex process that would bypass these locks.

This supervisor contract assumes supported Codex descendants do not call `setsid` or otherwise escape the helper process group. A live orphan can therefore conservatively fence an account indefinitely. Recovery is an explicit local-operator action: terminate the identified old managed process group, or reboot, then retry. Tokenless does not use elapsed time, a client PID, or a guessed stale age as authority to clear a live tombstone.

Waiting for an account slot is abortable and bounded. A busy project binding returns an account-busy availability error after that budget for every driver; capacity pressure never changes the selected account or spills the request to another account. Different projects may still execute concurrently on the accounts to which they are already bound. A per-project single-flight guard coordinates confirmed account-health migration, while requests already dispatched against the previous binding are allowed to finish there.

## Local state

All routing state lives below `TOKENLESS_HOME` (default `~/.tokenless`):

```text
direct/
  account-pool.json
  account-pool.lock
  identity-hmac.key          # Tokenless-generated 32-byte key, mode 0600
  provider-profiles/
    chatgpt/
      <internal-account-uuid>/
        codex/               # owned and interpreted only by Codex
  account-locks/
    <provider>/
      <internal-account-uuid>.lock
      <internal-account-uuid>.lock.codex-lease.json
  global-locks/
    chatgpt-login.lock
    chatgpt-login.lock.codex-lease.json
    chatgpt-subscription-inference.lock
    chatgpt-subscription-inference.lock.codex-lease.json
```

`account-pool.json` is one versioned document containing accounts and project bindings. Keeping both in one document makes add, remove, bind, and automatic first-use assignment atomic. Updates use a caller-owned SQLite write transaction as the cross-process advisory lock, validate the complete next document, write a mode-`0600` temporary file, fsync it, rename it on the same filesystem, and fsync the containing directory. Logical lock databases are private coordination files, never routing or credential stores. The Tokenless direct-state root and managed profile directories use mode `0700` on POSIX systems. Direct account mode requires Node.js 24.15 or later so `node:sqlite` has its release-candidate stability and does not emit experimental-runtime warnings.

The same atomic document contains a bounded local administrative audit log for binding assignment, pinning, migration, and unpinning; health mark and clear; and account enable and disable. Audit events have monotonic sequence numbers and explicit retention-gap metadata. They contain only validated routing identifiers and stable reasons, never prompts, raw provider errors, request bodies, environment values, credentials, or provider identity. The state API and local CLI expose bounded paginated reads with optional provider and account filters applied before the page limit while retaining global sequence cursors.

`identity-hmac.key` is a Tokenless-generated 32-byte non-provider secret, created atomically with mode `0600` when the first managed identity is registered and never exposed through HTTP or logs. Fingerprint v1 is HMAC-SHA256 over a length-prefixed tuple of provider, account type, and canonical provider identity; mutable plan type is excluded. A missing identity rejects multi-account onboarding. If a registry with fingerprints loses its key, Tokenless fails closed rather than silently generating another one. Key rotation or recovery is an explicit local operation that rechecks and relinks every managed profile before inference resumes.

The registry rejects duplicate or non-canonical account slugs, duplicate internal UUIDs, dangling bindings, unknown fields that alter security behavior, path traversal, symlinked managed-profile roots, case-normalization collisions, and unsupported protocol versions. Current `tokenless.account-pool.v2` documents require both audit metadata and health on every account, so deleting either cannot downgrade a blocked account to usable. Only an exact, coherent pre-health `tokenless.account-pool.v1` document without audit, health, or other v2-only account markers defaults health to generation-zero usable; its next mutation atomically writes v2. Filesystem paths and locks are derived only from validated internal UUIDs, so renaming a slug or running on a case-insensitive filesystem cannot alias two profiles. Removing an account with bindings is rejected until those projects are explicitly rebound or unbound.

### Codex profile boundary

Tokenless creates a distinct canonical managed profile directory for each ChatGPT subscription account and launches the official login command with that directory as `CODEX_HOME`. Every login, status, identity, and inference invocation explicitly selects Codex's `file` credential-store mode. Codex alone reads and writes its mode-`0600` authentication file below that profile, while Tokenless never opens, parses, copies, or exports it. Pinning the store mode avoids undocumented keyring scoping behavior from collapsing otherwise separate profiles.

Before login or inference, Tokenless rejects provider instruction/configuration files in the managed profile that could alter routing or model behavior. It verifies that the canonical home remains under the current-user-owned mode-`0700` managed root and is not a symlink. Inference continues to use the existing strict configuration, disabled-feature list, empty working directory, permission canaries, environment allowlist, and machine-readable output checks. The capability probe uses a separate empty `CODEX_HOME`; authentication status and inference use only the selected account home. Raw profile paths and executable paths are never accepted from an inference request or repository configuration.

The account server resolves the Codex executable once at startup to a canonical absolute regular file owned by the current user or a trusted system owner and rejects group/world-writable binaries or containing directories. `TOKENLESS_CODEX_BIN` remains an explicit local-operator trust override, never an API field. Provider capability canaries reduce accidental incompatibility; they cannot make a malicious executable safe after that executable receives access to a managed `CODEX_HOME`.

Account onboarding is intentionally sequential and explicit:

1. create an account record and managed profile;
2. launch the provider-owned `codex login` for that profile;
3. complete ChatGPT sign-in in the provider flow;
4. query the allowlisted official app-server `account/read` method for that exact profile before and after login as needed;
5. verify and fingerprint the returned non-secret ChatGPT identity, rejecting a missing or duplicate account; and
6. explicitly pin each ChatGPT project that may use the profile.

Logging in a second account never overwrites the first account's profile. The operator-supplied label remains the only displayed human identity; raw identity returned by the official account-info method is never persisted, logged, or returned.

## Unified API

The existing bearer-authenticated loopback broker remains the API entry point. `x-tokenless-project` opts a request into project routing. Requests without that header keep the legacy environment-configured public API behavior during the compatibility period.

The project header is a routing key, not authorization. The broker accepts exactly one bounded project header only after validating its bearer token, rejects duplicate authorization or project headers, rejects browser `Origin` requests, and validates `Host` against its actual loopback listener to resist local DNS rebinding. It never accepts an account/profile override header. A deployment with local clients in different trust domains must issue project-scoped bearer credentials rather than sharing the server-wide operator key.

The initial subscription surface is:

| Route | Provider | Subscription driver | Contract |
| --- | --- | --- | --- |
| `POST /v1/responses` | `chatgpt` | official Codex | bounded OpenAI Responses text subset |

For a Codex-backed request, Tokenless accepts stateless text input and an optional model. It rejects tools, files, images, previous-response continuation, remote connectors, arbitrary instructions that imply separate privilege, and unsupported sampling controls. Rejecting provider-side continuation is important: there is then no hidden conversation object that becomes inaccessible after account failover. Each execution is ephemeral and starts in an empty workspace, so projects do not share Codex threads even when they share an account. The adapter returns an OpenAI Responses-shaped object with a Tokenless-generated response id and normalized text. Streaming requests use a deterministic Responses event sequence over SSE; they do not expose Codex's internal event stream.

Public API account drivers remain protocol-preserving: after project resolution they inject only the selected account's environment-supplied credential and proxy the already allowlisted provider route. They retain the existing redirect, TLS, credential-header, body-size, and route protections. The initial implementation does not spool request bodies, so once any request byte is sent upstream it never retries that request through another account. A structured response proving account unavailability may migrate only the next request's binding. Same-request replay remains disabled unless a later design adds a private bounded spool, secure cleanup, and a provider-documented no-acceptance contract.

Broker metadata reports the project-routing protocol, routing policy, admitted account drivers, and supported route capabilities. It never lists account labels, profile paths, environment variable values, login output, or binding state to API callers.

## CLI administration

Administration is local CLI state mutation, not an HTTP administration surface:

```text
tokenless accounts add --provider chatgpt --account personal-one
tokenless accounts login --provider chatgpt --account personal-one
tokenless accounts status --provider chatgpt --account personal-one
tokenless accounts list
tokenless accounts enable|disable --provider <provider> --account <id>
tokenless accounts set-domain --provider <provider> --account <id> --routing-domain <domain>
tokenless accounts set-domain --provider <provider> --account <id> --isolated
tokenless accounts clear-health --provider <provider> --account <id>
tokenless accounts audit [--after-sequence <n>] [--limit <n>] [--provider <provider>] [--account <id>]
tokenless accounts remove --provider <provider> --account <id>

tokenless projects pin --project project-a --provider chatgpt --account personal-one
tokenless projects resolve --project project-a --provider chatgpt
tokenless projects list
tokenless projects unpin --project project-a --provider chatgpt
```

Commands have JSON output for automation. Credential values are never accepted as flags. Registry removal refuses active bindings and never deletes a provider-managed profile; any later manual profile cleanup is separate and outside the current CLI contract.

## Provider admission

Subscription account support is driver-by-driver, not simulated browser traffic hidden behind a common interface.

| Provider | Multi-account public API | Multi-account subscription | Current admission |
| --- | --- | --- | --- |
| ChatGPT | environment-referenced API accounts | isolated official Codex profiles | implemented |
| Claude | environment-referenced API accounts | none | subscription driver blocked until Anthropic documents a suitable isolated client boundary |
| Gemini | environment-referenced API accounts | none | subscription OAuth reuse is explicitly outside this design |
| Grok | environment-referenced API accounts | none | no admitted provider-owned subscription client |
| Antigravity | compatible-gateway API accounts | none | gateway API only |

Tokenless will add another subscription driver only when the provider documents a programmatic client, credential isolation, machine-readable output, and third-party orchestration boundary comparable to the Codex contract. It will not reach parity by copying OAuth clients, reading tokens, replaying browser headers, or calling private web backends.

## Implementation milestones

Each milestone ends in focused verification, a reviewer who did not implement the slice, and one dedicated conventional commit.

### M4: Account registry and identity

- Add the strict atomic account/project snapshot and local administrative API.
- Add managed Codex homes, trusted executable resolution, file-store login/status, and duplicate identity fingerprinting.
- Add explicit ChatGPT project pinning and public-API auto-pin semantics without changing inference transport.

Acceptance: two fake profiles cannot alias one home or identity, concurrent mutations do not lose updates, credentials and raw identity never enter Tokenless state, and all prior direct/visible tests remain green.

### M5: Project-routed ChatGPT API

- Route the bounded `POST /v1/responses` subset through the selected official Codex profile.
- Add caller-owned SQLite advisory locking, account-local queuing, non-stream and SSE response contracts, and exact project-header handling.
- Preserve legacy environment-backed public API behavior when no account registry exists.

Acceptance: real loopback tests prove stable project affinity, distinct profile homes, at most one managed ChatGPT subscription process globally, stateless project isolation, and no prompt or project header leakage.

### M6: Availability and provider expansion

- Add proven pre-dispatch ChatGPT profile-health failover and persistent binding migration.
- Add multi-account public API targets for ChatGPT, Claude, Gemini, Grok, and Antigravity using environment references only.
- Add operator-authorized failover-domain policy, health/audit views, and full provider contract coverage.

Acceptance: healthy bindings do not move; confirmed disabled/logged-out profiles migrate without prompt delivery; quota, rate, slot, and ambiguous failures do not pool ChatGPT subscriptions; all public API account credentials remain isolated.

## Verification gates

Each implementation milestone must include focused tests and a separate reviewer. Release is blocked unless these proofs pass:

- registry corruption, permission, symlink, traversal, and lost-update tests;
- deterministic public-API auto-pin and explicit ChatGPT pin tests across restarts and concurrent first requests;
- no-rebalance-while-healthy, ChatGPT slot-pressure no-spillover, bounded profile-health failover, migration persistence, and no-flapping tests;
- safe pre-dispatch rejection replay and ambiguous-post-dispatch no-replay tests, including Codex nonzero/timeout cases that do not change the binding;
- per-account concurrency, global ChatGPT subscription serialization, bounded queue, abort, crash-lock release, and authorized public-API cross-account parallelism tests;
- fake-Codex process proofs showing distinct `CODEX_HOME` values and no secret/environment leakage;
- real loopback `/v1/responses` non-stream and stream contract tests;
- broker authentication, header stripping, request limits, shutdown, and error-shape regression tests;
- duplicate project/auth headers, hostile Host/Origin, bearer scope, and account-metadata non-disclosure tests;
- a local live proof using a logged-in Codex profile and the fixed `gpt-5.3-codex-spark` model, opt-in because it consumes subscription quota; and
- a two-account live proof documented as operator-run because two independently authenticated ChatGPT accounts cannot be manufactured in CI.

The two-account proof must demonstrate distinct provider-owned identity fingerprints, projects A and B resolving to different account ids, project A remaining on its account after restart and after account B is added, disabling A's account migrating project A to B before sending the next prompt, and re-enabling A not moving the project back automatically. Quota and rate-limit responses must not trigger this migration.
