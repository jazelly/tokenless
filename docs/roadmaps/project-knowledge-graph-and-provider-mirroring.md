# Project Knowledge Graph and Provider Mirroring

Status: proposed | Priority: P1

Depends on: Context Envelope, exact agent session binding, provider file acceptance, and workspace alignment

## Outcome

Tokenless builds a local, source-attributable graph of a software project and maintains a bounded, user-approved context mirror inside the exact provider Project or conversation used by a web coding agent.

The web agent should receive enough durable project knowledge to plan and implement work without repeatedly rediscovering repository rules, architecture, symbols, tests, and workflows. The local repository remains authoritative.

## Local Knowledge Graph

The graph uses stable, content-addressed nodes and typed edges.

### Initial Node Types

- repository, worktree, directory, and file;
- symbol, module, package, command, configuration key, and environment variable;
- architecture decision, rule, instruction, and documentation section;
- test, fixture, generated artifact, and provider adapter; and
- task, decision, and context revision.

### Initial Edge Types

- `contains`, `defines`, `imports`, `references`, and `depends_on`;
- `governed_by`, `configures`, and `generated_from`;
- `tested_by`, `documents`, and `implements`;
- `changed_in`, `relevant_to`, and `supersedes`; and
- `mirrored_as` and `accepted_by`.

Every derived node or edge records source paths, digests, extractor version, confidence, and freshness. Low-confidence relationships remain distinguishable from parser-proven relationships.

## Two Representations

The local graph and provider mirror serve different purposes:

1. **Local graph:** structured, queryable, incremental, and optimized for exact retrieval.
2. **Provider context bundle:** bounded, human-readable artifacts optimized for provider file limits and model comprehension.

The first provider bundle should contain:

- `PROJECT_CONTEXT.md`: project purpose, stack, entry points, and current revision;
- `PROJECT_RULES.md`: applicable repository and directory instructions with scope;
- `ARCHITECTURE_MAP.md`: components, boundaries, execution flows, and key dependencies;
- `SYMBOL_INDEX.md`: high-value modules, symbols, commands, and ownership;
- `TEST_AND_WORKFLOW_GUIDE.md`: real build, test, lint, and release workflows;
- `TASK_CONTEXT.md`: current goal, relevant subgraph, selected files, decisions, and done conditions; and
- `TOKENLESS_MANIFEST.json`: schema version, project/worktree identity, source digests, shard hashes, exclusions, and active revision.

Large artifacts are deterministically sharded. The manifest identifies the active bundle and makes stale copies detectable even when the provider cannot delete or replace earlier uploads safely.

## Indexing and Sharing Policy

Indexing is local-first and respects:

- repository boundaries and canonical paths;
- `.gitignore` plus Tokenless-specific include and exclude rules;
- maximum file size, binary detection, generated-file policy, and symlink containment;
- secret and credential scanning before artifact generation;
- explicit handling for untracked and ignored files;
- source licenses and user-defined sharing restrictions; and
- per-artifact provenance and redaction notices.

Local indexing permission does not imply provider upload permission. Before first mirror creation or a material scope expansion, Tokenless must show a manifest-level preview and obtain explicit approval.

## Provider Mirror Identity

A mirror is keyed by:

- local project and worktree identity;
- agent session binding or an explicit standalone project binding;
- provider and managed profile;
- exact provider workspace resource or conversation identity; and
- graph and bundle revision.

Display names are descriptive only. If exact provider workspace identity is unavailable, Tokenless uses an explicit conversation-scoped mirror or fails according to the requested workspace mode.

## Delivery Phases

### Phase 0: Graph Schema and Repository Inventory

- Define versioned node, edge, provenance, exclusion, and extractor schemas.
- Inventory languages, package managers, build systems, documentation, instructions, and repository boundaries.
- Define stable ids and incremental invalidation rules.
- Add an inspect command that explains why a file or relationship is included or excluded.

Exit: an inventory is deterministic, reviewable, and never crosses the canonical project root.

### Phase 1: Local Structural Graph

- Parse repository layout, manifests, imports, symbols, commands, tests, instructions, and documentation.
- Prefer parser- or tool-backed relationships; use labeled heuristics only as fallback.
- Cache by content digest and re-index only affected nodes and reverse dependencies.
- Support exact and relevance-ranked graph queries for downstream context selection.

Exit: a local query can explain the source and confidence of every returned node and edge.

### Phase 2: Provider Context Bundle

- Render deterministic Markdown artifacts and the machine-readable manifest.
- Select a task-relevant subgraph under explicit byte, file-count, and context budgets.
- Record omitted or summarized material.
- Run secret, path, and policy checks before staging.

Exit: rebuilding an unchanged project produces the same artifact hashes, and a reviewer can trace every statement to local sources.

### Phase 3: Visible Provider Mirroring

- Resolve the exact native Project or conversation from the session/workspace binding.
- Upload the bundle through provider-visible controls.
- Require visible attachment acceptance, not only file selection.
- Store a receipt linking provider artifacts to local bundle hashes.
- Upload only changed shards when safe; otherwise publish a new complete revision with an active manifest.

Exit: Tokenless can prove which bundle revision the exact provider workspace visibly accepted.

### Phase 4: Web Coding Task Bootstrap

- Generate `TASK_CONTEXT.md` from the agent session, current goal, selected subgraph, and source state.
- Start or continue the exact provider conversation after the project bundle is ready.
- Ask the web agent to confirm the active manifest revision before substantial work.
- Return generated code, patches, files, decisions, and citations as explicit artifacts for local review.

Exit: a real web-agent task can use the mirrored repository rules and architecture, produce a reviewable artifact, and return it to the originating local session.

### Phase 5: Incremental and Multi-Provider Operation

- Refresh mirrors from file and graph changes.
- Keep provider-specific file limits and replacement behavior in capability contracts.
- Maintain independent receipts per provider/profile/workspace.
- Measure retrieval quality, stale-context failures, upload volume, and task success using real tasks.

Exit: one local graph can safely feed multiple independent provider mirrors without sharing identity or receipts across scopes.

## Acceptance Criteria

- The local graph is deterministic, incremental, and source-attributable.
- Repository rules retain directory scope and precedence.
- Ignored, excluded, secret-bearing, oversized, and out-of-root content cannot enter the provider bundle silently.
- Provider artifacts are bounded, versioned, and tied to exact source digests.
- A visible provider receipt proves attachment acceptance and workspace identity.
- A new web-agent conversation can identify the active project revision, applicable rules, key architecture, and task completion criteria from the mirror.
- Stale or ambiguous mirrors are detected before task submission.
- Provider results return as reviewable artifacts and are never applied to the local repository implicitly.
- Focused integration or browser E2E tests use the real filesystem, built CLI/daemon, and visible provider session without mocks or invented provider DOM.

## Risks and Responses

| Risk | Response |
| --- | --- |
| Graph is large but not useful | Optimize for task-relevant retrieval and measure answer/task quality, not node count |
| Generated summary invents architecture | Require source citations, confidence, and deterministic structural extraction for factual claims |
| Provider retains stale files | Active manifest, immutable revisions, expiry, and pre-task revision confirmation |
| Secrets enter generated artifacts | Layered ignore rules, detection, reviewable manifest, and fail-closed staging |
| Source changes during indexing or upload | Snapshot digests before extraction and revalidate before receipt |
| Provider file limits differ | Capability-aware sharding and explicit omissions |
| Web agent output is treated as trusted code | Return artifacts for local diff, tests, and review; never auto-apply |

## Non-Goals

- Replacing source control, language servers, or local build tools
- Uploading the full repository automatically
- Treating embeddings alone as a knowledge graph
- Letting provider copies become the source of truth
- Using hidden provider storage or upload APIs
- Applying provider-generated changes without local verification
