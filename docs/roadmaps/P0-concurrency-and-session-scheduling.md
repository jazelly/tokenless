# Concurrency and Session Scheduling

Status: proposed | Priority: P0

Depends on: Local daemon job persistence, claim leases, managed profile lifecycle, provider access and subscription observation, capability routing, embedded browser-runtime supervision, and exact workspace/conversation identity

## Outcome

Every Tokenless invocation is durably admitted through the local daemon and executed under an explicit concurrency contract. Concurrent callers cannot duplicate a logically idempotent submission, race on one conversation, navigate another job's page, overwrite shared Project context, or overload a provider profile without bounded backpressure.

Before provider mutation, Tokenless should also estimate each candidate provider/profile's current capacity from a maintained subscription-aware knowledge catalog and the existing durable job history. The estimate reduces avoidable rate-limit failures and provides useful cadence and eligibility information without claiming to reproduce private provider enforcement exactly.

The scheduler should allow useful concurrency:

- different managed profiles remain isolated and take turns on one daemon-owned browser instance;
- different conversations in the same provider profile may run concurrently when the provider capability and configured limit permit it;
- the same conversation remains single-writer;
- shared Project or workspace mutations are serialized; and
- repository indexing and provider-mirror revisions remain consistent with the task that consumes them.

## Current Behavior Audit

As of 2026-07-30, the current source implements several important foundations:

- `tokenless run` is daemon-only; each invocation creates a local-daemon job before visible provider work begins.
- Jobs, results, errors, blockers, checkpoints, timestamps, task metadata, backend, and profile scope are persisted in SQLite.
- `claim-next` uses an atomic FIFO `UPDATE ... RETURNING` transaction scoped to execution backend and profile.
- Claims have renewable leases; expired safe claims can be requeued, while ambiguous mutating outcomes fail closed.
- Embedded browser-runtime startup is owned by the daemon and guarded by profile/job identity.
- The embedded browser runtime owns one active managed profile and one browser instance at a time.
- The scheduler allows one global in-flight browser job. A later profile closes the idle browser before launching its own persistent user-data directory.
- Each profile owns one persistent browser context. Its operations are also serialized by a profile lane.

The current page and conversation behavior is more limited:

- A job does not receive a new page by default.
- `ManagedBrowserContext.page()` returns the first existing page in the profile context and creates a page only when no page exists.
- Each job navigates that reused page to its resolved target.
- Without an explicit target or a working conversation mapping, the target is the provider home URL, which normally starts a new provider conversation in the same browser tab.
- An explicit `--target-url` can target an existing conversation.
- Successful response-reading jobs with a task ID now persist validated provider/task conversation URLs, and native Workspace jobs can also persist project-scoped conversation mappings. `workspace-mode conversation` and native Workspace target resolution can reuse those exact same-provider, same-profile mappings when the provider capability is proven.
- Reusing a `taskId` or idempotency key does not deduplicate job creation. Multiple concurrent callers can create multiple jobs that later submit duplicate prompts.
- There is no project-, workspace-, conversation-, or page-scoped scheduler lane, no queue admission limit, and no user-visible queue position.
- The `jobs` table already preserves provider, profile, request, result, status, and job timestamps, but it does not preserve one immutable provider-submission timestamp. `updated_at` changes during claims, checkpoints, and completion, while the active submit checkpoint is cleared when a job completes.
- There is no packaged provider rate-limit catalog, subscription-aware capacity estimate, historical sliding-window projection, cadence admission, or reset-time parsing.

Therefore the current answer is:

> Concurrent calls are durably queued, and calls using the same profile run one at a time. They do not each open a new page. They reuse the first page. Exact conversation reuse is available only through proven provider/profile mappings and explicit Workspace or conversation targeting, while duplicate suppression remains incomplete.

## Concurrency Identity

Scheduling must not derive identity from display names. Introduce durable, versioned identifiers:

| Identity | Purpose |
| --- | --- |
| `jobId` | One physical execution attempt recorded by the daemon |
| `requestId` | One caller request and its observable response |
| `idempotencyKey` | Deduplicates logically identical caller intent within an explicit scope |
| `agentSessionId` | Connects the job to the exact originating agent conversation |
| `projectId` and `worktreeId` | Identify the local project and source-state scope |
| `providerProfileId` | Identifies the isolated authenticated browser profile |
| `providerWorkspaceId` | Identifies the exact native Project or conversation-scoped workspace |
| `conversationId` | Identifies one provider conversation independently of its display title |
| `pageLeaseId` | Identifies temporary ownership of one live browser page |
| `contextRevision` | Identifies the exact context or graph mirror consumed by the job |

Human-readable project and chat names remain metadata only.

## Scheduler Lanes

Jobs acquire the narrowest required lanes in a canonical order to prevent deadlocks.

### Profile Lane

Protects one persistent user-data directory and enforces the provider/profile concurrency budget. A profile may own multiple live pages, but only through the scheduler.

### Provider Workspace Lane

Serializes mutations shared by all conversations in a native Project:

- Project creation or selection;
- instruction updates;
- knowledge-graph mirror upload or revision activation; and
- provider resource deletion or replacement.

Once the required context revision is active, independent conversation jobs may proceed concurrently.

### Conversation Lane

Provides strict single-writer ordering for:

- prompt input and attachment preparation;
- prompt submission;
- response completion and reading; and
- conversation-scoped context updates.

Two jobs must never type into, submit to, or navigate the same conversation concurrently.

### Page Lease

Associates one in-memory Playwright `Page` with one conversation lane for the duration of an active job or explicitly retained session. Page handles are not durable identity. The daemon persists the canonical provider URL and conversation identity so a page can be recreated after runner or browser restart.

### Local Project Lane

Serializes source snapshot and graph/mirror revision publication while allowing immutable revision reads. A task consumes one fixed revision even if the repository changes during provider execution.

## Desired Page Model

Use one persistent browser context per managed profile and an explicit page registry inside the runner:

- allocate a fresh page when starting a new conversation;
- reuse the page already leased to the exact conversation when safe;
- recover an evicted or restarted page from the persisted canonical conversation URL;
- never select `pages()[0]` as an implicit job destination;
- isolate different conversations on different pages when concurrent execution is enabled;
- close idle pages by bounded LRU and time policies;
- preserve pages waiting for required user interaction when capacity allows; and
- expose page capacity and waiting state through daemon job status.

Provider capability determines whether parallel pages are enabled. A conservative provider or account can remain at concurrency one.

## Idempotency and Submission Safety

Idempotency must be enforced transactionally in SQLite, not by caller convention.

- The caller supplies or Tokenless derives an `idempotencyKey` with an explicit scope and expiry.
- Creating a duplicate active or completed request returns the existing job and result instead of inserting another job.
- A distinct new request always receives a new key and job.
- `taskId` groups related work but is not itself assumed to mean deduplication.
- The daemon records submission intent before browser mutation and persists the canonical provider conversation URL immediately after visible submission.
- A crash before proven submission may retry from a safe checkpoint.
- A crash during an ambiguous mutating action must not replay automatically.
- Exactly-once provider mutation cannot be promised without provider support; Tokenless provides durable deduplication before dispatch and at-most-once replay policy after ambiguous submission.

## Admission, Fairness, and Backpressure

The daemon owns bounded admission rather than allowing an unbounded queue.

- Configure global, per-profile, per-provider, per-project, and per-conversation limits.
- Reserve capacity for resumed or waiting-for-user jobs so fresh work cannot starve them.
- Use fair scheduling across projects and profiles while preserving FIFO order inside one conversation.
- Expose queue position, blocking lane, estimated eligibility, and active limits in machine-readable state.
- Reject or defer excess work with a retryable, actionable result before staging large attachments.
- Apply provider-visible rate-limit evidence to reduce concurrency dynamically.
- Before any provider mutation, an ineligible candidate may be deferred or replaced by another eligible provider/profile candidate inside the caller's routing scope.
- Never replay or move a request that may already have been submitted to a different provider, profile, Project, or conversation automatically.

Initial safe defaults should be cautious without trying to guarantee that Tokenless never reaches a real provider limit:

- one mutating job per conversation;
- one active job per provider profile until live evidence proves a higher safe value;
- one active managed profile and browser instance on the current runner; and
- one shared workspace mutation per provider Project.

Reaching a real provider rate limit is an expected recoverable condition, not a scheduler correctness failure. The scheduler should reduce avoidable limit hits and produce a useful next-eligible estimate, but it does not promise an exact replica of private provider enforcement.

## Provider Rate-Limit Knowledge Catalog

Maintain the best available provider knowledge as a checked-in, versioned JSON catalog at:

```text
packages/cli/catalog/provider-rate-limits.v1.json
```

The catalog is external product knowledge, not provider DOM configuration and not runtime usage state. Build validation must copy the validated catalog into the published `dist/src` package so the CLI, daemon, diagnostics, and generated documentation consume one source of truth.

The catalog records facts and uncertainty rather than inventing executable numbers for undocumented limits:

- `official_exact`: an official numeric allowance and window;
- `official_relative`: an official plan multiplier without a numeric base;
- `official_dynamic`: an official window or quota whose allowance varies;
- `official_qualitative`: an official statement such as "higher limits" without a schedulable number;
- `observed`: a redacted, provenance-bound visible provider observation; and
- `unknown`: no reliable current knowledge.

The initial schema should have this shape:

```json
{
  "schema": "tokenless.provider-rate-limit-catalog.v1",
  "revision": "2026-07-31",
  "reviewedAt": "2026-07-31",
  "defaults": {
    "unknownLimitStrategy": "observe_only"
  },
  "providers": {
    "chatgpt": {
      "plans": [
        {
          "id": "plus",
          "labels": ["Plus"]
        }
      ],
      "rules": [
        {
          "id": "chatgpt.instant.plus-go.messages",
          "scope": "provider_profile",
          "appliesTo": {
            "plans": ["go", "plus"],
            "modelFamilies": ["gpt-5.5-instant"],
            "actions": ["prompt.submit"]
          },
          "meter": {
            "kind": "count",
            "unit": "message"
          },
          "window": {
            "kind": "rolling",
            "seconds": 10800
          },
          "allowance": {
            "kind": "exact",
            "count": 160
          },
          "atLimit": {
            "kind": "provider_native_fallback",
            "targetModelFamily": "gpt-5.5-mini"
          },
          "evidence": [
            {
              "kind": "official_exact",
              "url": "https://help.openai.com/en/articles/11909943-gpt-5-3-and-gpt-55-in-chatgpt",
              "retrievedAt": "2026-07-31",
              "reviewAfter": "2026-08-31"
            }
          ]
        }
      ]
    }
  }
}
```

Every rule has a stable ID and independently matches:

- provider and provider profile;
- canonical subscription plan or plan family;
- access class when the exact plan is unknown;
- model family and effort or reasoning mode;
- metered action or feature, including prompt submission and file upload;
- count, compute, feature, or unknown meter;
- rolling, fixed, session, weekly, or dynamic window;
- exact, relative, dynamic, qualitative, or unknown allowance;
- provider-native fallback or overage behavior; and
- evidence URL, retrieval date, review date, validity, and replacement history.

The first catalog covers every currently supported visible provider:

| Provider | Initial schedulable knowledge | Knowledge retained without invented numbers | Official source |
| --- | --- | --- | --- |
| ChatGPT | Published message and upload windows where the plan/model rule is exact | Dynamic Free access, reasoning allowances, guardrails, native fallback, and plan-dependent behavior | `https://help.openai.com/en/articles/11909943-gpt-5-3-and-gpt-55-in-chatgpt` and `https://help.openai.com/en/articles/8555545-file-uploads-faq` |
| Claude | Published five-hour session reset shape | Dynamic usage, weekly limits, Max plan multipliers, conversation length, attachments, model, effort, features, and optional paid overage | `https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work` and `https://support.claude.com/en/articles/11049762-choose-a-claude-plan` |
| Gemini | Published compute-window and refresh behavior where current documentation states it | Compute-based dynamic allowance, weekly caps, plan multipliers, feature/model effects, and native fallback | `https://support.google.com/gemini/answer/16275805?hl=en` |
| Grok | None until an official numeric consumer Web rule is available | Qualitative paid-plan statements such as higher limits | `https://x.ai/pricing` |
| Qwen | None until an official numeric consumer Web rule is available | Unknown numeric Web limits and the prohibition on account creation to evade restrictions | `https://qwen.ai/usagepolicy` |

Catalog maintenance is explicit and reviewable:

- fail validation for duplicate rule IDs, invalid references, malformed windows, or an `official_exact` allowance without official evidence;
- warn when `reviewAfter` is stale rather than silently changing runtime behavior during a build;
- never fetch or rewrite catalog data automatically during installation or build;
- keep retired rules with validity or replacement metadata when history helps explain behavior;
- update the catalog and generated English/Chinese user-facing documentation together when practical; and
- include a changeset whenever a catalog or policy change materially changes CLI scheduling behavior.

## Historical Usage Projection

The SQLite `jobs` table remains the durable usage source. Do not introduce a separate rate-limit ledger table in V1.

Add only the minimum missing submission fact to the existing table:

- persist an immutable nullable `provider_submitted_at` when `prompt.submit` is visibly accepted;
- never derive submission time from mutable `updated_at`;
- retain `provider`, `profile_id`, and the structured request so the capacity module can derive model, effort, feature, message count, and attachment count;
- add an index such as `(provider, profile_id, provider_submitted_at)` for bounded window queries; and
- retain job history for at least the longest active catalog window used by scheduling.

The V1 projection key is:

```text
(provider, profileId, modelFamily, action)
```

Tokenless does not correlate one provider account across multiple browser profiles. Each profile is an independent scheduling scope, even if a user manually signs the same external account into two profiles.

For a candidate provider/profile, the capacity module queries submitted jobs inside every matching catalog window and derives metered usage from those jobs. One normal managed job is treated as one message submission; attachment and feature meters are derived from its structured actions and inputs. Ambiguous or externally initiated provider usage cannot be reconstructed and remains outside the local estimate.

The resulting projection is diagnostic as well as schedulable:

```ts
type ProviderCapacityProjection = {
  provider: ProviderId
  profileId: string
  planId: string
  planConfidence: "exact_label" | "plan_family" | "paid_unknown" | "unknown"
  matchedRuleIds: string[]
  used: number | null
  allowance: number | null
  estimatedRemaining: number | null
  windowStartedAt: string | null
  estimatedEligibleAt: string | null
  confidence: "exact_local_history" | "best_effort" | "unknown"
}
```

`estimatedRemaining` is explicitly a local estimate. Manual provider use, another Tokenless home, undocumented provider meters, failed uploads that still consume quota, and provider-side policy changes can make it differ from the provider UI.

## Capacity Policy Module

Place one deep module at the scheduler seam. Callers learn one small interface while catalog matching, subscription aliases, SQLite projection, window arithmetic, cadence, visible reset overrides, and explanation generation remain inside its implementation:

```ts
interface ProviderCapacityPolicy {
  evaluate(input: CapacityInput): CapacityDecision
}

type CapacityDecision = {
  decision: "admit" | "defer" | "unknown"
  estimatedEligibleAt: string | null
  projection: ProviderCapacityProjection
  reasons: string[]
}
```

The policy follows these rules:

1. Resolve the most specific catalog rule supported by the currently observed subscription, model, effort, and action.
2. For an exact numeric rule, calculate a true sliding-window count from `jobs.provider_submitted_at`.
3. Spread admitted requests with a GCRA or equivalent cadence derived from the window and allowance instead of allowing the entire known quota as an immediate burst.
4. Use only modest configurable headroom for exact limits; an initial target near 90% is reasonable, but it is Tokenless scheduling policy rather than provider fact.
5. For relative, dynamic, qualitative, or unknown limits, avoid fabricated counts. Use lightweight configurable cadence plus provider-visible evidence.
6. Let a freshly observed provider reset time or cooldown override the static estimate for that provider/profile.
7. Return explanations and estimates; do not claim that admission guarantees provider acceptance.

When the provider visibly reports a rate limit:

- before proven submission, defer the candidate until the visible reset time when available, otherwise apply bounded exponential backoff with jitter;
- before proven submission, the router may choose another eligible candidate inside the caller's filtered scope;
- after submission becomes ambiguous or proven, never replay the request elsewhere;
- record the blocker and observed reset evidence in the existing job result/blocker history rather than a new ledger table; and
- distinguish a provider-native fallback such as a smaller model from Tokenless routing to another provider.

## Subscription-Aware Matching

Subscription state is crucial matching evidence but never authorization. Normalize visible labels into stable catalog plan IDs while preserving the original label and confidence.

- An exact visible label may select an exact plan rule.
- A plan-family observation may select only a rule valid for that family.
- `signed_in_paid` or `paid_unknown` must not be treated as the provider's highest plan.
- `signed_in_unknown` matches only access-level or unknown-plan rules.
- A stale plan observation lowers confidence and may trigger fresh read-only inspection before mutation.
- Plan variants that Tokenless cannot distinguish remain grouped until real visible evidence supports a finer distinction.

## Candidate Routing and Provider Preferences

Rate-limit awareness participates in the existing capability router rather than creating a second router.

Candidate construction and selection proceed in this order:

1. An explicit caller provider or profile remains a hard constraint.
2. Otherwise, construct eligible `(provider, profileId)` candidates from configured profiles and current access observations.
3. If `preferredProviders` is non-empty, filter out providers not present in that list.
4. Apply the same capability support, subscription, blocker, capacity, fairness, and recovery algorithms to the filtered set.
5. Select an admitted candidate, or return the earliest useful deferral when every remaining candidate is temporarily ineligible.

`preferredProviders` is only a provider filter. List position does not override capability eligibility, rate-limit capacity, fairness, profile health, or the rest of the selection algorithm. Tokenless never escapes a non-empty preferred set silently, but providers inside that set receive no special rate-limit allowance.

## Recovery and Ownership

The daemon is the source of truth; browser processes and pages are recoverable executors.

- Every lane and page lease uses a fencing token tied to the claimed job lease.
- A stale runner cannot checkpoint or complete after ownership transfers.
- Runner restart reconstructs schedulable state from durable jobs, exact target URLs, context revisions, and safe checkpoints.
- A `waiting_for_user` job retains explicit ownership requirements. The scheduler either reserves its page/profile capacity or records that the page must be reconstructed before resume.
- Cancellation releases queued lanes immediately and active lanes only after daemon-confirmed termination.
- Shutdown drains or checkpoints active jobs; it does not silently abandon provider mutations.

## Delivery Phases

### Phase 0: Document and Measure Current Semantics

- Add machine-readable scheduler diagnostics for runner, profile, job, context, page, and queue state.
- Expose persisted final provider URLs and mapping status in scheduler diagnostics.
- Close the automatic conversation-continuation contract for explicit default/new/continue policies and prove it through a real visible session.
- Document that `taskId` is grouping while `idempotencyKey` is deduplication.
- Document that `updated_at` is not a provider-submission timestamp and audit the structured job inputs needed to derive every catalog meter.

Exit: state output can explain exactly why a job is queued, which page/conversation it targets, and whether it will create or continue a conversation.

### Phase 1: Rate-Limit Catalog and Read-Only Capacity Projection

- Maintain and package the seeded `provider-rate-limits.v1.json` with source, uncertainty, plan, model, feature, window, and review metadata for every supported provider.
- Add build-time schema validation and stale-review warnings without build-time network fetching.
- Add immutable `provider_submitted_at` to the existing `jobs` table and write it at proven visible submission.
- Add the provider/profile/window query and capacity policy module without introducing a usage ledger table.
- Expose a read-only built CLI diagnostic such as `tokenless limits inspect --provider <id> --profile <id> --json`.

Exit: the built and packed CLI can explain the matched subscription rule, locally observed usage, estimated remaining capacity, confidence, and next eligible time for every supported provider/profile without changing scheduling.

### Phase 2: Transactional Idempotency and Capacity-Aware Admission

- Add scoped idempotency records and unique constraints in the daemon.
- Return an existing job for duplicate submissions.
- Add queue limits and pre-staging admission checks.
- Expose queue position and retryable backpressure results.
- Apply exact sliding-window projection, modest cadence smoothing, and visible reset overrides before provider mutation.
- Treat real provider rate-limit responses as recoverable evidence rather than proof that the scheduler is incorrect.

Exit: a concurrent invocation storm with the same idempotency key produces one provider submission and one durable result, while distinct jobs are admitted or deferred with an explainable provider/profile capacity estimate.

### Phase 3: Explicit Conversation Registry

- Persist provider workspace, conversation, canonical URL, profile, task, and agent-session bindings.
- Separate `new`, `continue`, and `exact` conversation policies.
- Capture the canonical URL after visible submission and validate it before persistence and reuse.
- Remove implicit first-page routing from job execution.

Exit: every job can state before execution whether it will allocate a new conversation or continue an exact one.

### Phase 4: Page Registry and Conversation Lanes

- Introduce per-conversation single-writer lanes.
- Allocate one page per active conversation rather than one implicit page per profile.
- Add page lease fencing, capacity, idle eviction, and restart recovery.
- Keep per-profile concurrency one until each provider has live parallel-page evidence.

Exit: jobs for two different conversations can retain distinct pages without cross-navigation, while two jobs for one conversation remain ordered.

### Phase 5: Workspace and Project Coordination

- Serialize native Project and mirror mutations.
- Pin prompt jobs to an accepted context revision.
- Allow independent chats in one Project to run concurrently after the revision barrier.
- Integrate exact agent session and worktree identity.

Exit: two chats in one project can execute concurrently on separate pages while sharing one consistent provider mirror revision.

### Phase 6: Adaptive Serialized Profile Scheduling

- Add evidence-backed provider/profile concurrency caps.
- Apply fair scheduling, dynamic rate-limit reduction, and capacity reservations.
- Filter candidates through `preferredProviders` when configured, then apply the same capacity and fairness algorithm inside that scope.
- Route an unsubmitted request to another eligible provider/profile candidate only when the caller's constraints and filtered routing scope allow it.
- Preserve one browser instance while applying fair profile switching only at idle boundaries; never open two persistent profile directories concurrently.
- Publish operational metrics without prompt, response, credential, or private path content.

Exit: queued work remains fair across profiles and supported providers without weakening the single-browser, profile-isolation, or recovery invariants.

## Acceptance Criteria

- Every visible provider job is created, persisted, claimed, checkpointed, and completed through the local daemon.
- Concurrent runtime startup results in one verified daemon-owned browser runtime for one Tokenless home.
- Duplicate concurrent requests with one idempotency key result in one durable job and at most one visible submission.
- Jobs for the same conversation are strictly serialized.
- Jobs for different conversations never share an implicit page or navigate each other's page.
- Different conversations in one Project can run concurrently only after the required workspace/context revision is active.
- Each successful submission persists a validated canonical provider conversation URL.
- Browser-runtime restart can recover an exact conversation without relying on a page handle.
- Queue growth is bounded and backpressure is visible before large attachment staging.
- The packaged JSON catalog covers every supported provider, distinguishes exact from uncertain knowledge, and preserves official evidence and review dates.
- Capacity projection uses the existing jobs table plus immutable provider submission time; no separate rate-limit ledger table exists.
- A provider/profile diagnostic reports the matched subscription rule, local sliding-window usage, estimated remaining capacity, estimated eligibility, and confidence.
- `preferredProviders` filters the provider candidate set without overriding capability, capacity, fairness, or recovery policy.
- Reaching a real provider limit produces a retryable deferral or visible blocker and never causes an ambiguous submission to be replayed elsewhere.
- Lease fencing prevents stale workers from mutating durable state.
- Cancellation, timeout, waiting-for-user, and shutdown release or retain lanes according to documented state transitions.
- Focused integration and browser E2E tests launch concurrent built CLI processes against the real local daemon, real filesystem, real local Chromium, and gated real provider sessions. They assert durable jobs, exact page/conversation outcomes, and visible submissions without mocks or invented provider DOM.

## Required Concurrency Proofs

| Scenario | Observable proof |
| --- | --- |
| Many callers, same idempotency key | One daemon job and one visible provider submission |
| Many callers, distinct keys, one conversation | FIFO submissions with no interleaved composer state |
| Two conversations, one supported profile | Two explicit page leases and no cross-navigation |
| Two Projects, one profile at capacity | Fair queueing with a visible blocking reason |
| Two profiles | Independent execution up to the configured global limit |
| Runner crash before submit | Safe retry from durable checkpoint |
| Runner crash during submit | Ambiguous outcome fails closed without automatic replay |
| Browser restart after success | Exact conversation recovery from persisted URL |
| Waiting-for-user plus fresh work | Documented reservation or reconstruction with no lost job state |
| Queue limit exceeded | Retryable admission response before attachment staging |
| Exact published rolling limit | Job-history projection returns the expected local count, remaining estimate, and earliest eligibility |
| Dynamic or undocumented provider limit | Projection reports unknown or best-effort capacity without inventing an official number |
| Preferred provider filter | Every evaluated route stays inside the configured set while capacity selection remains otherwise unchanged |
| Visible limit before submission | Same job is deferred or another in-scope candidate is selected without duplicate mutation |
| Visible limit after ambiguous submission | Job fails closed or waits without cross-provider/profile replay |

## Risks and Responses

| Risk | Response |
| --- | --- |
| More pages trigger provider limits | Provider/profile caps, modest cadence smoothing, and dynamic reduction from visible evidence |
| Published rate-limit knowledge becomes stale | Versioned evidence, retrieval and review dates, stale warnings, and visible runtime evidence overriding estimates |
| Local history misses manual or external usage | Label remaining capacity as a local estimate and treat visible reset/blocker evidence as authoritative for the current provider/profile |
| Mutable job timestamps distort window counts | Persist one immutable `provider_submitted_at` on the existing job row and never use `updated_at` as submission time |
| Dynamic limits create false precision | Preserve dynamic, qualitative, and unknown allowance kinds instead of manufacturing numeric quotas |
| Cross-page UI state is shared inside one profile | Treat profile and workspace mutations as separate scheduler lanes |
| Durable locks deadlock | Canonical acquisition order, short leases, fencing, and diagnostics |
| Idempotency suppresses intentional repeated work | Explicit scope/expiry and distinct keys for distinct requests |
| Browser URL does not uniquely identify a conversation | Require provider-specific validated conversation identity or report exact continuation unavailable |
| Waiting-for-user jobs exhaust all capacity | Reserved capacity, bounded wait policy, and explicit page reconstruction |
| Queue becomes a disk or memory sink | Admission limits, quotas, TTLs, and attachment staging after admission |
| Multi-runner support opens one profile twice | Exclusive durable profile ownership before adding runner processes |

## Non-Goals

- Opening a new browser process for every invocation
- Assuming every provider safely supports multiple parallel pages
- Using project or chat display names as lock keys
- Promising exactly-once mutation when the provider cannot prove it
- Retrying a failed job in a different provider, profile, Project, or conversation
- Allowing browser pages to become the source of durable job identity
- Guaranteeing that Tokenless's estimate exactly matches private provider enforcement
- Correlating one external provider account across multiple managed browser profiles
- Adding a separate usage or rate-limit ledger table in V1
- Treating `preferredProviders` ordering as a rate-limit or scheduling priority
- Rotating profiles or providers to evade provider restrictions
