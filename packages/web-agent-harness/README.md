# Tokenless Web Agent Harness

This private workspace package owns Tokenless agent adapters, Harness context persistence, and the V1 Skill preparation slice. It remains independent of provider DOM, Playwright, profiles, and provider database internals.

Its public interface includes two groups of operations.

Codex integration and context:

- `installCodexIntegration`, `inspectCodexIntegration`, and `uninstallCodexIntegration` manage a reversible inline guidance block and Tokenless-owned native hook groups while preserving unrelated Codex files.
- `handleCodexHook` preserves Hook session-tree, turn, and tool-call provenance and injects opaque Tokenless context into an actual CLI or MCP invocation.
- `resolveCodexInvocationContext` resolves per-command `CODEX_THREAD_ID` to the concrete CLI chat, optionally confirms it through a bounded App Server `thread/read`, and atomically rebinds the invocation without losing Hook provenance.
- `completeBoundAgentInvocation` lets the bound Tokenless CLI persist its exact provider result before rendering output; `PostToolUse` provides an idempotent fallback and covers native MCP result envelopes.
- `inspectCodexContext` reads the Harness-owned project, conversation, turn, invocation, and provider binding ledger for one exact Codex chat.
- `readCodexThreadFromAppServer` is a bounded independent App Server client. It does not start, resume, wrap, or proxy a Codex TUI.

Skill preparation and visible response control:

- `prepareHarnessBootstrapTurn` stages ordered first-turn attachment candidates and persists their pending acceptance state without producing a prompt.
- `finalizeHarnessBootstrapTurn` validates exact provider acceptance outcomes, soft-omits rejected Skills, and then returns the first correlated provider prompt.
- `prepareHarnessSkillRun` is the legacy file-staging API; it does not represent provider acceptance and is not the acceptance-aware bootstrap flow.
- `parseHarnessModelResponse` validates one framed visible-provider response and returns a correlated `action_batch` or `final` result.
- `prepareHarnessSkillTurn` resolves caller additions plus the model's complete `skillLoads` list and stages every successful `SKILL.md` file for the next provider prompt.

The package reads only `SKILL.md`. It never reads or executes `references/`, `assets/`, or `scripts/`. The System Prompt is a required attachment; individual Skill attachments use soft omission results.

Provider transport stays outside this package: the selected adapter must support both `conversation.chat` and `file.upload`. User-owned Skills are context inputs, never provider capabilities. The adapter must visibly accept the context before it calls `finalizeHarnessBootstrapTurn`; a rejected Skill becomes a soft `provider_upload_failed` omission, while a rejected System Prompt produces no prompt and no task submission. A run is single-writer; callers must not prepare the same turn concurrently.

### Sequential mission admission

`openSequentialHarnessMissionQueue` is a durable local admission ledger only: it freezes a bounded private mission specification in `harness.sqlite3`, exposes a redacted task projection, and atomically admits at most one `preparing` task. It does not start a daemon, contact a provider, prepare a bootstrap, or finalize output.

### Local HTTP V0 bootstrap

`startHarnessLocalHttpBootstrap` is the intentionally narrow local-control-plane seam. It binds the configured provider/profile, compiles the required System Prompt, resolves caller-selected Skills, and stages their exact names, SHA-256 identities, and Markdown contents in one bounded context bundle. It then starts one canonical V0 new-conversation request. It returns the protocol `TurnState`; `readHarnessLocalHttpTurn` and `cancelHarnessLocalHttpTurn` operate on its opaque `turnRef`.

`completeHarnessLocalHttpBootstrap` reads a succeeded turn, rebuilds and validates the delivered context-bundle digest, validates the strict correlated Harness envelope, then finalizes the pending bootstrap with its selected Skills. It strips only bounded single-line provider chrome around one exact envelope; invalid output never finalizes the Harness state, and repeated completion is idempotent.

The start operation accepts `selectedSkills` but still accepts no tools or MCP, and it does not finalize the bootstrap. The context bundle is a transport detail: every logical document retains its own name and digest in the Harness state and prompt manifest. A queued V0 state proves only local staging and durable scheduling, not visible-provider acceptance. If staging or start fails after preparation, the existing Harness state remains pending and is not accepted or finalized; only successful completion may backfill that receipt.

Agent context is stored separately in `<TOKENLESS_HOME>/harness.sqlite3`. The ledger stores bounded IDs, canonical project identity, hashes, timestamps, provider mapping references, and job IDs. It does not store raw Codex prompts, transcripts, assistant messages, tool results, browser state, or credentials. The Web Provider API owns real provider Projects, conversations, and jobs; this package binds their returned opaque IDs to Harness conversations.

```ts
import {
  finalizeHarnessBootstrapTurn,
  parseHarnessModelResponse,
  prepareHarnessBootstrapTurn,
  prepareHarnessSkillTurn,
} from 'tokenless-web-agent-harness'

const preparation = await prepareHarnessBootstrapTurn({
  runId: 'run-123',
  stagingRoot: '/private/tokenless/harness',
  selectedSkills: [{ name: 'legal-writing', selectedBy: 'explicit_user' }],
  taskPrompt: 'Review this contract for material risks.',
  nonce: 'first-turn-nonce',
})

// Upload preparation.attachments in order through a Provider route that supports
// conversation.chat and file.upload, then collect one exact acceptance outcome
// for every attachment by its name and SHA-256.
const bootstrap = await finalizeHarnessBootstrapTurn({
  runId: 'run-123',
  stagingRoot: '/private/tokenless/harness',
  nonce: 'first-turn-nonce',
  attachmentAcceptances: visibleUploadOutcomes,
})

// Send bootstrap.prompt only after finalization succeeds. A rejected Skill is
// omitted from the manifest; a rejected System Prompt prevents this result.
// bootstrap.acceptedAttachments is audit-only: do not upload it again.

const response = await parseHarnessModelResponse({
  runId: 'run-123',
  stagingRoot: '/private/tokenless/harness',
  turn: 1,
  nonce: 'first-turn-nonce',
  responseText: visibleProviderText,
})

if (response.kind === 'action_batch' && response.skillLoads.length > 0) {
  const next = await prepareHarnessSkillTurn({
    runId: 'run-123',
    stagingRoot: '/private/tokenless/harness',
    turn: 1,
    skillLoads: response.skillLoads,
  })
  // Upload next.delivery.attachments together before the next prompt.
}
```
