# Concurrency and Session Scheduling

Status: proposed | Priority: P0

Depends on: Local daemon job persistence, claim leases, managed profile lifecycle, embedded browser-runtime supervision, and exact workspace/conversation identity

## Outcome

Every Tokenless invocation is durably admitted through the local daemon and executed under an explicit concurrency contract. Concurrent callers cannot duplicate a logically idempotent submission, race on one conversation, navigate another job's page, overwrite shared Project context, or overload a provider profile without bounded backpressure.

The scheduler should allow useful concurrency:

- different managed profiles may run independently;
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
- The embedded browser runtime can execute multiple managed profiles under daemon-owned limits.
- The scheduler allows at most one in-flight job per profile, regardless of provider, project, or conversation.
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

Protects one persistent user-data directory and enforces the provider/account concurrency budget. A profile may own multiple live pages, but only through the scheduler.

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
- Never move a failed request to a different provider, profile, Project, or conversation automatically.

Initial safe defaults should remain conservative:

- one mutating job per conversation;
- one active job per provider profile until live evidence proves a higher safe value;
- up to four active managed profiles on the current runner; and
- one shared workspace mutation per provider Project.

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

Exit: state output can explain exactly why a job is queued, which page/conversation it targets, and whether it will create or continue a conversation.

### Phase 1: Transactional Idempotency and Bounded Admission

- Add scoped idempotency records and unique constraints in the daemon.
- Return an existing job for duplicate submissions.
- Add queue limits and pre-staging admission checks.
- Expose queue position and retryable backpressure results.

Exit: a concurrent invocation storm with the same idempotency key produces one provider submission and one durable result.

### Phase 2: Explicit Conversation Registry

- Persist provider workspace, conversation, canonical URL, profile, task, and agent-session bindings.
- Separate `new`, `continue`, and `exact` conversation policies.
- Capture the canonical URL after visible submission and validate it before persistence and reuse.
- Remove implicit first-page routing from job execution.

Exit: every job can state before execution whether it will allocate a new conversation or continue an exact one.

### Phase 3: Page Registry and Conversation Lanes

- Introduce per-conversation single-writer lanes.
- Allocate one page per active conversation rather than one implicit page per profile.
- Add page lease fencing, capacity, idle eviction, and restart recovery.
- Keep per-profile concurrency one until each provider has live parallel-page evidence.

Exit: jobs for two different conversations can retain distinct pages without cross-navigation, while two jobs for one conversation remain ordered.

### Phase 4: Workspace and Project Coordination

- Serialize native Project and mirror mutations.
- Pin prompt jobs to an accepted context revision.
- Allow independent chats in one Project to run concurrently after the revision barrier.
- Integrate exact agent session and worktree identity.

Exit: two chats in one project can execute concurrently on separate pages while sharing one consistent provider mirror revision.

### Phase 5: Adaptive Multi-Profile Scheduling

- Add evidence-backed provider/profile concurrency caps.
- Apply fair scheduling, dynamic rate-limit reduction, and capacity reservations.
- Support additional browser-runtime workers only after daemon leases and profile ownership prevent the same persistent profile from opening in two workers.
- Publish operational metrics without prompt, response, credential, or private path content.

Exit: concurrency scales across profiles and supported providers without weakening isolation or recovery.

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

## Risks and Responses

| Risk | Response |
| --- | --- |
| More pages trigger provider/account limits | Provider-specific caps, conservative defaults, and dynamic reduction from visible evidence |
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
