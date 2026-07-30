# Real Provider Browser E2E and Native Projects

Status: in progress | Priority: P0

Depends on: the completed [Provider Architecture and Registry](archived/provider-architecture-and-registry.md), the managed Playwright runtime, durable daemon jobs, managed profile lifecycle, attachment staging, and conversation continuation

Supports: [Provider Expansion and Parity](provider-expansion.md) and [Context Delivery and Workspace Alignment](context-delivery-and-workspace-alignment.md)

## Outcome

Tokenless proves every advertised visible-provider capability through the built CLI, packaged daemon, real managed Chromium, and the real provider website. Tests verify the CLI result, an independent visible DOM observation, and durable daemon state for the same run.

Claude and Grok additionally support native Project creation, exact reuse, Project-scoped chat, instructions on creation, attachment submission, and conversation continuation. Native Project support remains unavailable for other providers until each provider closes the same real-session evidence bar.

## Evidence Policy

All browser E2E and visible-provider capability acceptance tests use real provider sessions:

- no provider DOM fixture routes;
- no provider network interception;
- no simulated provider responses;
- no fake pages, locators, browser contexts, daemons, or provider state;
- no runtime skip for a temporary page, network, selector, or account failure; and
- no capability claim based only on a selector, menu, static DOM state, or CLI result.

The only runtime skip exception is the checked-in Claude Cloudflare known issue declared in `test/live-provider-capability-matrix.json`. It may apply only to provider `claude`, only when the durable job payload is `waiting_for_user`, and only when the structured blocker code is `visible_cloudflare_turnstile` or `visible_cloudflare_interstitial`. Sign-in-required states, authentication unavailability, timeouts, selector or UI drift, other challenge families, other blocker codes, and every other provider remain hard failures.

Redacted, provenance-bound provider DOM captures remain development aids for selectors, parsers, and already-observed DOM variants. They are not E2E, do not close provider transitions, and do not count toward capability acceptance.

Provider E2E runs manually on this machine with the explicitly selected managed profile already provisioned through Tokenless setup. It does not create a separate test account, automate login, or silently select another profile. Provider-side mutations, retained test artifacts, and usage cost are acceptable. Every artifact uses a recognizable Tokenless E2E prefix, run ID, and timestamp.

On macOS, the live E2E helper preserves the operator's working focus around each headed browser launch. It records the frontmost application before starting the built CLI and restores that application only when a known Chromium browser became frontmost; if the operator moved to another non-browser application during startup, the helper leaves that newer choice untouched. The managed browser remains headed and visible for independent CDP observation.

## Current Closure

As of 2026-07-29, the implementation, capability matrix, CDP observer boundary, durable mappings, native Project strategies, public contracts, and manual gate commands are in place. Real runs additionally established these capability boundaries:

- the selected Gemini guest profile does not restore prior-turn context when a second CLI process opens the mapped conversation URL;
- the selected Qwen guest profile uses the shared `/c/guest` route, which does not restore the prior visible response after navigation or reopen; and
- both combinations are therefore explicitly unavailable in the checked-in matrix rather than being counted as continuation support.

The latest complete manual gate attempts produced:

- non-submission: 16 invoked cases, 3 passed and 13 failed;
- mutation: 20 invoked cases, 5 passed and 15 failed; and
- Project: 2 invoked cases, 0 passed and 2 failed.

All three gates ran with zero skipped cases and no internal retry. This predates the narrow Claude Cloudflare known-issue skip classification now declared in the matrix; the release bar remains zero skips except for that exact durable blocker condition. Gemini and Qwen currently provide real mutation closure for every capability required by their matrix entries. The latest mutation run passed Gemini submit/read, citations, and conversation workspace plus Qwen submit/read and conversation workspace. It failed all ChatGPT, Claude, and Grok cases with `e2e_provider_auth_unavailable` because the selected setup-managed profile was not authenticated for those providers.

On 2026-07-31, the mutation cases were consolidated around provider submissions rather than capability-by-capability messages. ChatGPT, Claude, and Grok now prove attachment acceptance, response reading, citations, conversation fallback, durable mapping, and cross-process continuation in one two-turn workflow. Gemini proves response reading, citations, conversation fallback, and durable mapping in one submission. Qwen proves Deep Research mode selection, response reading, conversation fallback, and durable mapping in one submission. The matrix records and the harness enforces an exact per-case submission budget. The full manual gate budget is now 12 submissions: 8 in the mutation gate and 4 in the two native Project cases, down from 28. This structural reduction is not provider acceptance evidence; the consolidated cases still require a fresh manual real-provider run.

Qwen closure now starts from its canonical `https://chat.qwen.ai/` chat surface. A real built-CLI run proved that the provider accepts the prompt, navigates the same visible page to `/c/guest`, and returns the exact marker. Qwen Studio exposes its textarea before the guest backend is ready, so the adapter waits only until the initial page lifecycle is three seconds old before first input; an already hydrated conversation incurs no additional delay. The real mutation gate then passed both required Qwen cases through independent CDP observation and durable state.

The subsequent non-submission gate encountered intermittent system DNS failure for `chat.qwen.ai` after the same hostname had resolved for the successful mutation gate. Navigation now reports this explicitly as retryable `provider_dns_unavailable`; no test-only DNS override is used or counted as acceptance evidence.

On 2026-07-30, Qwen-specific mode work added `qwen.mode.inspect/select`, runtime enabled/disabled mode discovery, exact Deep Research Normal/Advanced selection, Auto/Thinking/Fast effort controls, and a required real mutation case that selects Deep Research Advanced before prompt submission and response reading. A built-CLI action produced the visible `qwen-mode-and-variant-visible` postcondition for Deep Research Advanced. A separate development capture recorded the selected Deep Research Advanced state through a read-only CDP observer and added the redacted reduction to the fixture manifest; its one-off public-DNS host resolution is recorded in provenance and the fixture does not count as acceptance. After system DNS recovered, built-CLI plus read-only-CDP runs proved Auto/Thinking/Fast inspection, exact Thinking selection, visible selection, durable success, and Auto restoration. A real Deep Research Advanced run then proved exact mode and variant selection through the observer while the product submitted the unique prompt, read a correlated visible clarification response, and persisted durable SQLite success. The checked-in case was strengthened to require the observer to see the unique submitted prompt as well. A subsequent fresh run failed clearly with `provider_plan_limited` before that stronger assertion could be rerun; it was not retried inside the suite or converted into fixture evidence. The implementation therefore closes the product mode-selection and first-response behavior but still requires the next manual gate run for full matrix acceptance. It does not claim Qwen's complete multi-turn final-report lifecycle.

The roadmap remains in progress. Before release, the operator must restore the required selected-profile authentication for ChatGPT, Claude, and Grok, ensure stable system DNS resolution for `chat.qwen.ai`, manually rerun every applicable gate, and obtain a complete pass. Claude and Grok native Project implementation also remains provisional until real authenticated sessions supply the required DOM development captures and close creation, exact reuse, instructions, Project chat, and continuation.

## Actor and Oracle Boundary

The product remains the only actor:

- the built CLI submits every job;
- the packaged daemon owns job state and the managed browser;
- production provider actions perform all navigation, input, clicking, selection, upload, submission, Project operations, and response reading; and
- no test observer calls production action implementations.

A second Playwright client connects to the product-launched Chromium through CDP only as a test observer. It may:

- locate the target page;
- read accessible roles and visible marker content;
- inspect visible attachment, Project, conversation, response, and citation outcomes; and
- report bounded semantic observations needed for the core flow.

It must not intercept network traffic, install routes, modify page state, or perform product actions. Observer assertions must not import production provider selectors or action implementations.

E2E evidence must not include screenshots, full DOM dumps, cookies, local storage, session storage, credentials, or unrelated account content.

## Milestone 1: Real-Provider Browser E2E Foundation

### Phase 1: Checked-In Capability Matrix

Add one machine-readable capability matrix as the source of truth for live coverage. Each entry records:

- provider;
- provider stage;
- required account class or subscription condition;
- capability and visible action;
- non-submission, mutation, or Project gate;
- required observable CLI, DOM, and durable-state closure;
- supported, unavailable, or unknown expectation; and
- a checked-in reason for every unavailable combination.

The test loader validates that:

- every registered provider and declared visible capability has a matrix entry;
- every supported entry maps to a real E2E case;
- unavailable entries have an explicit reason;
- every case declares an exact provider-submission budget of zero, one, or two;
- the only known-issue skip is declared with a recognized provider, machine-readable reason, and safe structured blocker codes;
- response reading and citation extraction remain separate capabilities; and
- runtime conditions cannot silently convert a required case into a skip outside the declared Claude Cloudflare durable blocker exception.

When the suite is invoked, every required case runs exactly once. The suite has no internal retry and no skip path for missing activation, unavailable authentication, provider failure, blocker state, or another unmet prerequisite. The sole exception is a runtime skip for Claude when the completed job payload is durably `waiting_for_user` with structured blocker code `visible_cloudflare_turnstile` or `visible_cloudflare_interstitial`. Each other condition fails with a clear machine-readable reason. Retry happens only when the operator manually runs the suite again.

Exit: capability declarations and live acceptance coverage cannot drift independently.

### Phase 2: Test-Only CDP Inspection

Under explicit `TOKENLESS_E2E_BROWSER_INSPECTION=1` activation:

- launch the managed Chromium profile with an ephemeral remote debugging port and an explicit loopback address;
- preserve the managed profile as a non-default user data directory;
- discover the current endpoint from the profile's `DevToolsActivePort`;
- reject stale endpoint files by validating the current browser lifecycle;
- require the daemon and target browser context to start in inspection mode rather than reusing a context launched without it; and
- disconnect the observer without closing the product browser.

Normal product runs never expose a debugging port.

Before the first provider action, the job waits at a test-only barrier identified by run ID, job ID, and a random nonce:

1. the product navigates to the real provider target;
2. the observer connects and confirms the expected page and origin;
3. the observer releases the matching barrier;
4. the product executes the first action; and
5. an unreleased barrier fails explicitly after 30 seconds.

Barrier state is bounded to the current run and removed during cleanup. A stale release cannot unblock another job.

Exit: the observer deterministically sees the real page before product actions begin, without changing product behavior outside the gated test run.

### Phase 3: Built CLI Harness

Run the built CLI as an asynchronous child process against:

- the explicitly selected local `TOKENLESS_HOME`;
- the real SQLite job store;
- the packaged TypeScript daemon;
- the existing managed browser profile provisioned through Tokenless setup;
- the real Chromium installation; and
- the real provider website and current authenticated account state in that profile.

Every core case correlates one unique task and marker across:

1. built CLI JSON and exit status;
2. independent visible DOM observation; and
3. daemon API and SQLite durable job state.

The harness records bounded structured CLI, observer, daemon API, and SQLite evidence on both success and failure. It does not capture screenshots or full DOM. An authentication or provider failure fails the required case with a clear reason; it does not become a skip.

Exit: a test can prove one product-owned provider workflow through all real system boundaries without a fixture or simulated response.

### Phase 4: Existing Capability Closure

The initial required matrix is:

| Capability | Required real-provider closure |
| --- | --- |
| Auth, capability inspection, navigation, blocker inspection, sanitized snapshot | Every provider that declares the action |
| Prompt input and clear | Every provider that declares composer support; observer sees the unique draft and its removal |
| Model and effort inspection and selection | Inspect the current choice, select a real alternate, verify the visible selection, and restore the original choice |
| Provider-specific Qwen mode | Inspect enabled and disabled modes, select Deep Research Advanced, verify the visible mode and variant, submit a real prompt, read the correlated response, and restore Chat |
| File upload | Verify a visible attachment and submit it with a correlated prompt |
| Prompt submission and response reading | Submit a unique marker and read a real provider response correlated to that marker |
| Citation extraction | For providers that declare it, use a source-seeking prompt and verify real visible citation controls and normalized results |
| Conversation continuation | A second CLI process uses the same task ID; DOM and durable state prove both turns share the exact conversation |
| Conversation workspace fallback | Project metadata and task identity resolve to the same real conversation without being reported as native |

The live suite has explicit gates:

- **Non-submission gate:** auth, capability inspection, navigation, blocker state, model and effort change with restoration, draft input and clear, and attachment selection with draft cleanup.
- **Mutation gate:** prompt submission, attachment submission, real response reading, citations, conversation continuation, and Qwen Deep Research mode closure.
- **Project gate:** native Project creation, reuse, instructions, Project chat, and Project-scoped continuation.

These gates select which manually invoked command performs provider-side mutations; they do not skip cases inside an invoked suite.

Exit: every currently advertised visible capability has real-provider acceptance evidence through the capability matrix.

## Milestone 2: Claude and Grok Native Projects

### Phase 1: Development Evidence

Capture complete, redacted, provenance-bound Claude and Grok DOM states for:

- Project list empty and populated;
- create form;
- successful creation;
- exact Project open;
- Project instructions;
- new Project chat;
- existing Project conversation; and
- ambiguous or unavailable states observed during real testing.

These captures guide provider-owned selectors and parsers. They never replace the real Project E2E closure.

Exit: implementation is grounded in genuine observed provider states without claiming that static captures prove a transition.

### Phase 2: Native Workspace Semantics

Extend the existing `workspace.ensure` action rather than adding a parallel command:

- `native`: find an exact visible name, create when absent, reuse when exactly one match exists, fail on ambiguity, and never fall back;
- `auto`: prefer native for Claude and Grok, fall back only after stable evidence that native Projects are unavailable, and return a retryable failure for transient UI, navigation, network, blocker, or selector errors; and
- `conversation`: preserve the current conversation-scoped behavior.

Define explicit error codes and retryability for stable unavailability, ambiguous identity, visible UI drift, navigation failure, network failure, account gating, and blocker states. `auto` must never hide a regression as a conversation fallback.

On creation, apply `--project-instructions` and verify the visible result. On reuse, do not silently overwrite existing instructions. Report whether instructions were:

- not requested;
- applied on creation;
- already equivalent;
- skipped on reuse; or
- unavailable.

For a combined run, action ordering is:

1. `workspace.ensure`;
2. verify canonical Project URL, exact Project identity, and Project composer;
3. model selection;
4. effort selection;
5. file upload;
6. prompt input;
7. prompt submission; and
8. response reading.

Exit: every later action executes on the verified Project surface rather than provider home.

### Phase 3: Result Contract

Make `WorkspaceEnsureResult` a discriminated union:

- `mode: "native" | "conversation"`;
- `resource.kind: "project" | "conversation"`;
- `resource.native: boolean`;
- `resource.disposition: "created" | "reused" | "fallback"`;
- exact provider and profile scope;
- stable provider resource identity when available;
- canonical Project or conversation URL;
- visible proof;
- requested and resolved mode; and
- instruction outcome.

Preserve the existing conversation result semantics. Update JSON contract coverage, API examples, paired English and Chinese CLI documentation, and any success-response fixtures that describe the public result.

Exit: callers can distinguish native creation, native reuse, and explicit conversation fallback without interpreting prose.

### Phase 4: Durable Project and Conversation Identity

Persist native Project identity independently from human-readable names:

- Project key: provider, managed profile ID, and provider Project resource ID derived from a validated canonical URL;
- Project metadata: visible name, canonical URL, creation or observation timestamps, and last visible proof;
- Conversation key: provider, managed profile ID, Project resource ID, and task ID; and
- Conversation value: validated canonical conversation URL and the job that visibly proved it.

An exact-name lookup with multiple visible matches fails closed. Display names never become primary keys.

Persist a visibly proven Project mapping immediately after the successful `workspace.ensure` action checkpoint, even if a later upload or prompt action fails. Persist a conversation mapping only after visible submission yields a validated conversation URL.

Subsequent CLI processes resolve:

1. an explicit trusted target URL;
2. the exact Project-scoped task conversation mapping;
3. the exact Project mapping; or
4. provider home when no authorized mapping exists.

Exit: retries and later CLI invocations recover the exact Project and conversation without scanning arbitrary historical result payloads or crossing provider, profile, Project, or task scope.

### Phase 5: Native Project Live Acceptance

For both Claude and Grok, using the explicitly selected local setup-managed profile:

1. generate a run-scoped unique Project identity;
2. run `workspace.ensure --workspace-mode native` and require `created`;
3. run the same ensure again and require `reused`;
4. verify the canonical URL, exact visible Project name, and instruction outcome through the observer;
5. in that Project, select and verify model and effort when supported, upload a marker file, submit the first marker prompt, and read the real response;
6. start a second CLI process with the same Project identity and task ID and submit a follow-up;
7. verify both turns in the same Project conversation; and
8. verify Project mapping, conversation mapping, job results, task ID, marker, and canonical URLs through the daemon API and SQLite.

Real Projects, conversations, messages, attachments, and provider usage are expected test artifacts. Cleanup is optional and must occur only after acceptance evidence is durable; inability to clean up does not weaken or skip the test.

Exit: Claude and Grok native Project support is proven through a fresh real creation, exact reuse, Project-scoped work, and cross-process continuation.

## Release and Documentation

- Milestone 1 is internal test infrastructure and does not require a changeset by itself.
- Milestone 2 changes user-visible CLI behavior and JSON results, so it requires a changeset.
- Update paired English and Chinese user documentation together.
- Provider browser E2E does not run in CI. Pull requests carry a non-enforced reminder for the author to run the applicable local E2E.
- Every applicable provider E2E must pass manually before release. The release process relies on this checklist rather than an automated CI enforcement.
- E2E suites do not retry internally. An operator may manually rerun the complete applicable suite after investigating a clear failure.
- Do not manually publish packages or releases; repository automation owns changeset-driven publication.

## Acceptance Criteria

- No fixture-based test is named or counted as browser E2E.
- Every advertised visible capability has a required real-provider matrix entry.
- Every required real-provider case proves CLI, visible DOM, and durable state for the same task and marker.
- An invoked E2E suite has no skipped cases and no internal retry, except for the checked-in Claude Cloudflare durable blocker known issue.
- Authentication or setup-profile problems fail with a clear reason.
- All applicable E2E suites pass manually before release, without requiring CI enforcement.
- CDP inspection is test-only, loopback-only, read-only, and absent from normal runs.
- Runtime provider failures fail required tests rather than silently skipping them unless they match the declared Claude Cloudflare durable blocker known issue.
- Claude and Grok native Project creation and reuse are both exercised against fresh real Project identities.
- Model, effort, upload, prompt, submit, and read actions execute after native Project alignment.
- Project and conversation mappings use exact provider resource scope rather than display names.
- `auto` fallback cannot convert transient or ambiguous native failures into conversation success.
- Public native and conversation result shapes remain explicit and documented.

## Risks and Responses

| Risk | Response |
| --- | --- |
| Provider UI drift | Fail the required live case, retain bounded diagnostics, capture the new real DOM variant for development, and update the provider-owned adapter |
| Account or subscription variation | Inspect the selected setup-managed profile, run applicable declared capabilities, and fail clearly when authentication or account state cannot satisfy a required case |
| CDP endpoint is stale or unavailable | Start the daemon and browser context in inspection mode, validate lifecycle identity, and fail explicitly |
| Observer changes product behavior | Keep it read-only, prohibit routes and actions, and assert through independent accessible roles and markers |
| Provider rate limits or usage cost | Fail clearly, investigate, and manually rerun the suite when appropriate; use explicit gates, bounded concurrency, and real artifacts rather than fixtures |
| Duplicate Project names | Resolve a stable provider resource identity or fail closed |
| Project creation succeeds but a later action fails | Persist the Project mapping at the successful workspace action checkpoint |
| Native UI is temporarily broken | Return a retryable failure and do not fall back under `auto` |

## Non-Goals

- Fixture-based provider E2E
- Provider network interception or simulated provider responses
- Private provider APIs
- CAPTCHA or authentication bypass
- Automatic login
- Automatic account or profile provisioning for E2E
- Provider browser E2E in CI
- Internal E2E retry or runtime skip outside the declared Claude Cloudflare durable blocker known issue
- Native Project support for ChatGPT, Gemini, or Qwen without the same real-session closure
- Making crash/restart, abrupt process death, port competition, replay, or acknowledgement edge cases part of the default browser E2E acceptance bar
