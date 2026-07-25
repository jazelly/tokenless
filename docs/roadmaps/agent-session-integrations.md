# Agent Session Integrations

Status: proposed | Priority: P1 | First integration: Codex

Depends on: stable local job identity and the Context Envelope contract

## Outcome

Tokenless binds work to the exact conversation and filesystem scope of the local agent that requested it. Provider routing no longer guesses a project from names or the process's incidental current directory.

The product surface is an agent-neutral integration protocol. A Codex plugin is the first distribution and lifecycle integration, not a Codex-only architecture.

## Stable Agent Session Binding

Introduce a versioned `AgentSessionBinding`:

| Field | Purpose |
| --- | --- |
| `agentKind` | Identifies the producer, initially `codex` |
| `sessionId` | Stable conversation or thread identity supplied by the agent |
| `turnId` | Optional turn identity for request/result correlation |
| `cwd` | Exact working directory reported by the agent |
| `projectRoot` | Canonical project root resolved from `cwd` |
| `worktreeId` | Canonical realpath plus repository/worktree identity |
| `repository` | Optional VCS remote identity with credentials removed |
| `branch` and `head` | Optional source-state evidence, not project identity |
| `transcriptRef` | Optional local reference with explicit access policy |
| `startedAt` and `observedAt` | Freshness and lifecycle evidence |
| `producerVersion` | Adapter and schema compatibility |

The durable lookup key is `agentKind + sessionId`. Project, worktree, and provider-workspace bindings are associated records and can change over a session's lifetime.

## Why Codex First

Current Codex lifecycle hooks provide the fields needed for exact first-party binding:

- `session_id`;
- `cwd`;
- an optional `transcript_path`;
- lifecycle events such as `SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd`; and
- plugin-local writable data through `PLUGIN_DATA`.

Codex also defines `CODEX_HOME` as its state root, with `~/.codex` as the default. Directly scanning that directory is not the primary integration path. Hook metadata is narrower, more explicit, and better aligned with the active conversation.

The transcript path is a convenience reference, but its format is not a stable hook interface. Transcript reading must therefore be optional, consented, version-detected, and replaceable.

Official references:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex configuration and state locations](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations)
- [Codex plugins](https://developers.openai.com/plugins)

## Codex Integration Shape

The installable Codex plugin should bundle:

- a Tokenless routing skill for explicit user or agent invocation;
- trusted lifecycle hooks that register and refresh session binding;
- a narrow local command or MCP surface backed by the Tokenless CLI/daemon;
- schemas for context export and Tokenless result import; and
- clear permission, privacy, and uninstall behavior.

The primary flow is:

1. `SessionStart` sends `session_id`, `cwd`, and adapter version to the local Tokenless control plane.
2. Tokenless canonicalizes the working directory, resolves the project root and worktree, and persists the binding.
3. An explicit Tokenless invocation includes the same session id and optional turn id.
4. Tokenless resolves the provider workspace from the exact session/project binding.
5. The web result returns to the requesting session with job id, context revision, provider conversation identity, and artifacts.
6. `SessionEnd` marks the binding inactive without deleting retained user-approved history.

Hooks register identity; they do not submit prompts or upload files implicitly.

## Delivery Phases

### Phase 0: Agent Integration Protocol

- Define `AgentSessionBinding`, lifecycle events, capability negotiation, and schema versioning.
- Separate agent identity, filesystem identity, provider workspace identity, and task identity.
- Define collision, resume, fork, worktree-change, and stale-session behavior.
- Add local inspect and revoke commands.

Exit: a test client can register two concurrent sessions in one repository without identity collisions.

### Phase 1: Explicit Codex Binding

- Add a Tokenless command that accepts Codex `session_id` and `cwd`.
- Resolve realpath, repository root, worktree, branch, and current revision.
- Persist the binding in the local daemon.
- Route jobs by exact binding and expose the resolved identity in state output without leaking raw private paths.

Exit: two Codex sessions in different worktrees or directories resolve to different bindings even when project names are identical.

### Phase 2: Codex Plugin and Lifecycle Hooks

- Package the routing skill and minimal hook definitions as a plugin.
- Register on `SessionStart` and refresh only on meaningful lifecycle changes.
- Require the user to review and trust plugin hooks.
- Keep prompt submission explicit and observable.

Exit: starting or resuming a Codex session creates or refreshes the exact binding with no project-name guess.

### Phase 3: Authorized Context Export

- Add an explicit action that exports the current goal, user prompt, plan, relevant repository guidance, and selected files into a Context Envelope.
- Treat `transcript_path` as optional and unstable.
- When transcript import is enabled, use versioned readers, bounded selection, and a preview or manifest before sharing.
- Never import authentication state, hidden prompts, private reasoning, or unrelated sessions.

Exit: the user can inspect what session context will be sent, and Tokenless works correctly when no transcript is available.

### Phase 4: Additional Agent Adapters

- Publish the protocol and adapter conformance suite.
- Add other mainstream coding agents through their stable lifecycle, extension, or invocation surfaces.
- Keep product-specific logic in adapters while preserving shared identity and context contracts.

Exit: a second agent can complete the same exact-binding and context-handoff workflow without Codex-specific fields leaking into core contracts.

## Acceptance Criteria

- Session matching uses an agent-supplied stable id, never chat title or project display name.
- Working directory and project root are canonicalized and checked for changes.
- Worktrees and concurrent sessions are distinct.
- Session resume preserves identity; session fork creates a distinct identity with explicit lineage when available.
- A missing or stale binding fails with a repair instruction instead of falling back to name guessing.
- Hook registration is local, bounded, reviewable, and idempotent.
- Transcript access is off by default and the core workflow does not depend on its file format.
- Plugin removal or binding revocation stops future integration without deleting unrelated Tokenless state.
- Integration tests exercise the built CLI/daemon and a real Codex hook payload or supported Codex process boundary; no fake agent implementation is treated as product proof.

## Risks and Responses

| Risk | Response |
| --- | --- |
| Codex internal storage format changes | Prefer stable hook fields; isolate optional transcript readers by detected version |
| Session id is accidentally exposed to providers | Keep it local and use a separate opaque provider-facing correlation id |
| Hooks become surprising background automation | Limit hooks to identity registration and require explicit task submission |
| Same repository has multiple worktrees or subdirectory sessions | Bind canonical `cwd`, project root, and worktree identity separately |
| Agent lacks lifecycle hooks | Use explicit invocation metadata and report reduced lifecycle capability |
| Plugin surface changes | Keep the agent-neutral local protocol independently usable |

## Non-Goals

- Parsing all files under `CODEX_HOME` as a stable public database
- Reading Codex authentication material, logs, or unrelated sessions
- Uploading a Codex transcript by default
- Making provider project names the source of identity
- Requiring every supported agent to install the same plugin format
