# Tokenless Roadmaps

Status: active product direction | Last reviewed: 2026-07-31

This directory contains long-horizon product and engineering roadmaps. It is separate from `plans/`, which contains bounded implementation plans for individual pieces of work.

Roadmaps describe intended outcomes, sequencing, evidence, and acceptance criteria. They are not release promises, fixed dates, or compatibility guarantees. A capability becomes supported only after the implementation and real-boundary verification required by the relevant roadmap are complete.

## Lifecycle and Directory Structure

The roadmap's directory is the source of truth for its lifecycle:

```text
docs/roadmaps/
├── README.md             # Index and lifecycle rules
├── *.md                  # Active roadmaps
├── backlog/
│   ├── README.md         # Backlog index
│   └── *.md              # Accepted but intentionally inactive roadmaps
└── archived/
    ├── README.md         # Archive index
    └── *.md              # Completed, superseded, cancelled, or retired roadmaps
```

There is intentionally no `active/` directory. Every root-level Markdown file other than this index is active. An active roadmap can still have an internal delivery status such as `proposed`; lifecycle placement describes whether the direction is currently active, while the document status describes its delivery maturity.

Move a roadmap to:

- [`backlog/`](backlog/README.md) when the direction is accepted but intentionally not being pursued;
- [`archived/`](archived/README.md) when it is completed, superseded, cancelled, or no longer planned; or
- this directory's root when it becomes active.

Every addition, rename, move, or lifecycle change must update this index, all repository links, and the roadmap's lifecycle or disposition note. A superseded roadmap must link to its replacement. Archived roadmaps retain their historical content.

## Active Roadmaps

| Roadmap | Outcome | Current priority |
| --- | --- | --- |
| [Real Provider Browser E2E and Native Projects](real-provider-browser-e2e-and-native-projects.md) | Prove every advertised visible capability against real provider websites and add real Claude and Grok native Project creation, reuse, and continuation. | P0 |
| [Provider Expansion and Parity](provider-expansion.md) | Add high-value AI web providers and maintain an evidence-backed capability catalog and routing matrix across them. | P0 |
| [Context Delivery and Workspace Alignment](context-delivery-and-workspace-alignment.md) | Carry authorized task, repository, instruction, and file context into the exact provider Project or conversation, including a new chat. | P0 |
| [Concurrency and Session Scheduling](concurrency-and-session-scheduling.md) | Persist every invocation through the local daemon and schedule exact project, workspace, conversation, profile, and page lanes safely under concurrent load. | P0 |
| [Agent Session Integrations](agent-session-integrations.md) | Route caller-requested task capabilities to evidence-backed provider strategies through a safe local MCP interface, then bind jobs to exact agent sessions with Codex as the first deep lifecycle integration. | P1 |
| [Project Knowledge Graph and Provider Mirroring](project-knowledge-graph-and-provider-mirroring.md) | Build a local project graph and maintain an approved, provider-ready project context mirror for web-based coding agents. | P1 |

Priority describes product importance, not a promise that all work proceeds serially.

## Backlog and Archive

- [Backlog](backlog/README.md): no roadmap is currently backlogged.
- [Archive](archived/README.md): Provider Architecture and Registry was completed and the Daemon Fastify HTTP API direction was cancelled on 2026-07-27.

## How the Roadmaps Fit Together

```mermaid
flowchart LR
  Caller["Trusted local caller<br/>HTTP create + polling"]
  API["Fastify daemon API<br/>auth + schemas + job reads"]
  Session["Agent session binding<br/>session id + working directory"]
  Scheduler["Durable scheduler<br/>identity + lanes + backpressure"]
  Context["Context envelope<br/>provenance + policy + limits"]
  Graph["Project knowledge graph<br/>rules + architecture + symbols"]
  Provider["Provider adapters<br/>visible capabilities"]
  Workspace["Provider workspace mirror<br/>Project or conversation"]
  Task["Web-agent task<br/>exact session and project context"]

  Caller --> API
  Session --> API
  API --> Scheduler
  Scheduler --> Context
  Graph --> Context
  Context --> Provider
  Provider --> Scheduler
  Scheduler --> Workspace
  Graph --> Workspace
  Workspace --> Task
```

The shared contracts should be built before provider-specific shortcuts:

1. Use the completed typed provider registry, `BaseProvider` execution skeleton, and provider-owned capability classes documented in the archived [Provider Architecture and Registry](archived/provider-architecture-and-registry.md) roadmap.
2. Establish the real-provider browser E2E evidence plane and close Claude and Grok native Project identity before depending on those capabilities for broader context delivery.
3. Define stable provider capability, context-envelope, agent-session, and mirror-manifest contracts.
4. Replace the daemon's manual HTTP dispatcher with a compatible Fastify API and make polling the explicit asynchronous caller contract.
5. Make the local daemon the durable authority for idempotency, admission, scheduling lanes, conversation identity, and recovery.
6. Expand provider coverage using the same visible-session and evidence requirements as the existing providers.
7. Add exact session binding, beginning with Codex lifecycle hooks and explicit invocation metadata.
8. Produce a local project graph and synchronize bounded, reviewable context artifacts into the bound provider workspace.

## Shared Product Principles

- **Visible provider boundary:** operate provider websites through visible controls and visible postconditions. Do not depend on private provider APIs.
- **Evidence before availability:** selectors or menu presence are not success. A capability is supported only when a real visible-session sequence proves the final outcome.
- **Fail closed:** ambiguous identity, navigation, attachment state, workspace selection, or context delivery must return an explicit unavailable or unknown result.
- **Exact identity over names:** use provider/profile/resource identifiers and agent/session/worktree identity. Human-readable project and chat names are metadata, not primary keys.
- **Daemon-owned concurrency:** every invocation is durably admitted, deduplicated, scheduled, leased, checkpointed, and completed through the local daemon.
- **Conversation single-writer:** one conversation accepts at most one mutating job at a time; unrelated conversations may run concurrently only within explicit profile and provider limits.
- **Local-first and consent-based:** indexing, session binding, and staging happen locally. Upload only the bounded artifacts a user or authorized agent has approved.
- **Provenance-preserving context:** every instruction and source must retain its origin, scope, freshness, and sharing policy.
- **No hidden-prompt extraction:** Tokenless may carry instructions explicitly supplied or exported by the caller. It must not scrape concealed platform, developer, or provider prompts.
- **Real-boundary testing:** provider and agent integrations require focused integration or browser E2E evidence through the built CLI, daemon, filesystem, lifecycle hook, and real visible provider session.
- **Honest degradation:** when a provider cannot represent a system instruction, Project, graph artifact, or other semantic layer natively, report the fallback instead of claiming parity.

## Roadmap Maintenance

Each roadmap should be updated when:

- a phase is implemented or intentionally parked;
- a capability contract changes;
- live provider evidence changes a priority or invalidates an assumption;
- a new privacy, policy, or provider constraint is discovered; or
- implementation work reveals that an acceptance criterion is incomplete.

Implementation issues and PRs should link to the relevant roadmap and identify the phase and acceptance criterion they advance.
