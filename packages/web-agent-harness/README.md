# Tokenless Web Agent Harness

This private workspace package owns Tokenless agent adapters, Harness context persistence, and the V1 Skill preparation slice. It remains independent of provider DOM, Playwright, profiles, and provider database internals.

Its public interface includes two groups of operations.

Codex integration and context:

- `installCodexIntegration`, `inspectCodexIntegration`, and `uninstallCodexIntegration` manage a reversible inline guidance block and Tokenless-owned native hook groups while preserving unrelated Codex files.
- `handleCodexHook` binds exact hook chat, turn, and tool-call IDs, optionally enriches the chat with a bounded App Server `thread/read`, and injects opaque Tokenless context into an actual CLI or MCP invocation.
- `completeBoundAgentInvocation` lets the bound Tokenless CLI persist its exact provider result before rendering output; `PostToolUse` provides an idempotent fallback and covers native MCP result envelopes.
- `inspectCodexContext` reads the Harness-owned project, conversation, turn, invocation, and provider binding ledger for one exact Codex chat.
- `readCodexThreadFromAppServer` is a bounded independent App Server client. It does not start, resume, wrap, or proxy a Codex TUI.

Skill preparation and visible response control:

- `prepareHarnessSkillRun` discovers the global Agent Skills registry, compiles the required System Prompt Markdown file, and stages caller-preselected `SKILL.md` files.
- `parseHarnessModelResponse` validates one framed visible-provider response and returns a correlated `action_batch` or `final` result.
- `prepareHarnessSkillTurn` resolves caller additions plus the model's complete `skillLoads` list and stages every successful `SKILL.md` file for the next provider prompt.

The package reads only `SKILL.md`. It never reads or executes `references/`, `assets/`, or `scripts/`. The System Prompt is a required attachment; individual Skill attachments use soft omission results.

Provider transport stays outside this package: the selected adapter must support both `conversation.chat` and `file.upload`, upload the returned attachment paths, and include the returned manifest in the related prompt. A run is single-writer; callers must not prepare the same turn concurrently.

Agent context is stored separately in `<TOKENLESS_HOME>/harness.sqlite3`. The ledger stores bounded IDs, canonical project identity, hashes, timestamps, provider mapping references, and job IDs. It does not store raw Codex prompts, transcripts, assistant messages, tool results, browser state, or credentials. The Web Provider API owns real provider Projects, conversations, and jobs; this package binds their returned opaque IDs to Harness conversations.

```ts
import {
  parseHarnessModelResponse,
  prepareHarnessSkillRun,
  prepareHarnessSkillTurn,
} from 'tokenless-web-agent-harness'

const prepared = await prepareHarnessSkillRun({
  runId: 'run-123',
  stagingRoot: '/private/tokenless/harness',
  selectedSkills: [{ name: 'legal-writing', selectedBy: 'explicit_user' }],
})

// Upload prepared.systemPrompt and prepared.delivery.attachments, then send
// the task prompt plus prepared.promptManifest through a Provider route that
// supports conversation.chat and file.upload.

const response = await parseHarnessModelResponse({
  runId: 'run-123',
  stagingRoot: '/private/tokenless/harness',
  turn: 1,
  nonce: 'current-turn-nonce',
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
