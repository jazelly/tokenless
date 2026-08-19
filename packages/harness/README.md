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

`startHarnessLocalHttpBootstrap` is the intentionally narrow local-control-plane seam. It binds the configured provider/profile, compiles the required System Prompt and frozen tool catalog, resolves caller-selected Skills, and stages the context as bounded named Markdown files. `continueHarnessLocalHttpTurn` keeps the proved provider conversation, while read, resume, and cancel operate on opaque turn references.

`completeHarnessLocalHttpBootstrap` reads a succeeded turn, validates the delivered atomic attachment batch against the required System Prompt digest, validates the strict correlated Harness envelope, then finalizes the pending bootstrap with its selected Skills. It strips only bounded single-line provider chrome around one exact envelope; invalid output never finalizes the Harness state, and repeated completion is idempotent.

The durable `WebAgentHarness` owns MCP catalog discovery, approval-bound calls, action batches, provider continuation, and restart recovery in `<TOKENLESS_HOME>/harness.sqlite3`. MCP servers are explicit local stdio processes; environment values remain in the invoking process and every MCP call requires digest-bound approval.

### AI sidecars

Front Door and Exit Door are sidecars around the durable Harness loop. They do not add phases to provider execution: Front Door prepares metadata and a concrete provider route before `WebAgentHarness.start`, while Exit Door reviews the terminal result after the Harness run completes.

The sidecars depend on the small `HarnessAiEngine` contract. The first adapter is the browser-side Chrome Prompt API implementation backed by Gemini Nano; local and remote engines can implement the same contract later without changing Front Door or Exit Door.

```ts
import {
  createHarnessExitDoorSidecar,
  createHarnessFrontDoorSidecar,
} from 'tokenless-web-agent-harness'

const frontDoor = createHarnessFrontDoorSidecar(geminiNanoEngine)
const exitDoor = createHarnessExitDoorSidecar(geminiNanoEngine)
const prepared = await frontDoor.prepare({ taskPrompt, providers, browserBinding })
const run = await harness.start({ ...spec, provider: prepared.route.providerId })
// Read the durable run through the normal Harness interface.
const postprocessed = run.final
  ? await exitDoor.finalize({ taskPrompt, output: run.final.output, artifacts: run.final.artifacts, browserBinding })
  : undefined
```

The normal CLI reaches this same module through authenticated daemon HTTP:

```text
tokenless agent run --provider chatgpt --prompt "Do the task" --json
tokenless agent read --run-id <run-id> --json
tokenless agent resume --run-id <run-id> --approve <call-id:digest> --json
tokenless agent cancel --run-id <run-id> --json
```

A queued provider turn proves local staging and durable scheduling, not visible-provider acceptance. Provider authentication and verification stay external; resume continues the same durable turn after the user completes the handoff.

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
