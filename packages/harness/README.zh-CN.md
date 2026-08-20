# Tokenless Web Agent Harness

这个 private workspace package 负责 Tokenless agent adapter、Harness context persistence 与 V1 Skill preparation slice。它独立于 provider DOM、Playwright、profile 和 provider database internals。

其 public interface 包含两组操作。

Codex integration 与 context：

- `installCodexIntegration`、`inspectCodexIntegration` 与 `uninstallCodexIntegration` 管理可逆的 inline guidance block 和 Tokenless 自有 native hook groups，同时保留无关的 Codex 文件。
- `handleCodexHook` 保留 Hook session-tree、turn 与 tool-call provenance，并向真实 CLI 或 MCP invocation 注入不透明 Tokenless context。
- `resolveCodexInvocationContext` 将每个 command 的 `CODEX_THREAD_ID` 解析到具体 CLI chat，可选择通过有界 App Server `thread/read` 确认，并在不丢失 Hook provenance 的情况下原子地重新绑定 invocation。
- `completeBoundAgentInvocation` 让绑定的 Tokenless CLI 在渲染输出前持久化准确的 provider result；`PostToolUse` 提供 idempotent fallback，并覆盖 native MCP result envelope。
- `inspectCodexContext` 读取一个准确 Codex chat 的 Harness-owned project、conversation、turn、invocation 与 provider binding ledger。
- `readCodexThreadFromAppServer` 是有界且独立的 App Server client。它不会启动、恢复、包装或代理 Codex TUI。

Skill preparation 与 visible response control：

- `prepareHarnessBootstrapTurn` 安排有序的首轮 attachment candidates，并持久化其 pending acceptance state，而不生成 prompt。
- `finalizeHarnessBootstrapTurn` 校验准确的 provider acceptance outcome，soft-omit 被拒绝的 Skill，然后返回首个可关联 provider prompt。
- `prepareHarnessSkillRun` 是 legacy file-staging API；它不表示 provider acceptance，也不是 acceptance-aware bootstrap flow。
- `parseHarnessModelResponse` 校验一个 framed visible-provider response，并返回可关联的 `action_batch` 或 `final` result。
- `prepareHarnessSkillTurn` 解析 caller addition 加上 model 的完整 `skillLoads` list，并为下一个 provider prompt 暂存每个成功的 `SKILL.md` 文件。

该 package 只读取 `SKILL.md`，绝不会读取或执行 `references/`、`assets/` 或 `scripts/`。System Prompt 是必需 attachment；单独的 Skill attachment 使用 soft omission result。

Provider transport 位于该 package 之外：所选 adapter 必须同时支持 `conversation.chat` 与 `file.upload`。用户自有 Skill 是 context input，不是 provider capability。Adapter 必须在调用 `finalizeHarnessBootstrapTurn` 前可见地接受 context；被拒绝的 Skill 会成为 soft `provider_upload_failed` omission，而被拒绝的 System Prompt 不会产生 prompt 或 task submission。一个 run 只有一个 writer；caller 不得并发 prepare 同一个 turn。

### Local HTTP V0 bootstrap

`startHarnessLocalHttpBootstrap` 是刻意收窄的 local-control-plane seam。它绑定配置好的 provider/profile，编译必需的 System Prompt 与冻结的 tool catalog，解析 caller 选择的 Skill，并将 context 暂存为有界的具名 Markdown 文件。`continueHarnessLocalHttpTurn` 保持已验证的 provider conversation，而 read、resume 与 cancel 操作不透明 turn reference。

`completeHarnessLocalHttpBootstrap` 读取成功的 turn，针对必需 System Prompt digest 校验已交付的 atomic attachment batch，校验严格且可关联的 Harness envelope，然后使用所选 Skill finalize pending bootstrap。它只移除一个准确 envelope 周围有界的单行 provider chrome；无效输出绝不 finalize Harness state，重复 completion 是 idempotent 的。

`WebAgentHarness` 在 daemon 进程内保存 run，并负责 MCP catalog discovery、approval-bound call、action batch 与 provider continuation。Daemon 退出时 run 直接丢失；MCP server 是显式本地 stdio process，environment value 保留在 invoking process 中，所有 mutating MCP call 都需要 digest-bound approval。

### AI sidecars

Front Door 与 Exit Door 是围绕 Harness loop 的 sidecar。它们不会向 provider execution 添加 phase：Front Door 在 `WebAgentHarness.start` 前准备 metadata 与具体 provider route，Exit Door 在 Harness run 完成后审查 terminal result。

Sidecar 依赖很小的 `HarnessAiEngine` contract。第一个 adapter 是由 Gemini Nano 支持的 browser-side Chrome Prompt API implementation；以后 local 与 remote engine 可以实现同一 contract，而无需改变 Front Door 或 Exit Door。

```ts
import {
  createHarnessExitDoorSidecar,
  createHarnessFrontDoorSidecar,
} from 'tokenless-web-agent-harness'

const frontDoor = createHarnessFrontDoorSidecar(geminiNanoEngine)
const exitDoor = createHarnessExitDoorSidecar(geminiNanoEngine)
const prepared = await frontDoor.prepare({ taskPrompt, providers, browserBinding })
const run = await harness.start({ ...spec, provider: prepared.route.providerId })
// Daemon 存活期间，通过正常 Harness interface 读取 run。
const postprocessed = run.final
  ? await exitDoor.finalize({ taskPrompt, output: run.final.output, artifacts: run.final.artifacts, browserBinding })
  : undefined
```

正常 CLI 通过 authenticated daemon HTTP 到达同一个 module：

```text
tokenless agent run --provider chatgpt --prompt "Do the task" --json
tokenless agent read --run-id <run-id> --json
tokenless agent resume --run-id <run-id> --approve <call-id:digest> --json
tokenless agent cancel --run-id <run-id> --json
```

Queued provider turn 只证明本地 staging，不证明 visible-provider acceptance。Provider authentication 与 verification 保持在外部；用户完成 handoff 后，resume 继续同一个进程内 run。

Agent context 单独存储在 `<TOKENLESS_HOME>/harness.sqlite3`。Ledger 存储有界 ID、canonical project identity、hash、timestamp、provider mapping reference 与 job ID。它不存储 raw Codex prompt、transcript、assistant message、tool result、browser state 或 credential。Web Provider API 负责真实 provider Project、conversation 与 job；该 package 将它们返回的不透明 ID 绑定到 Harness conversation。

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

// 通过支持 conversation.chat 与 file.upload 的 Provider route 按顺序上传
// preparation.attachments，然后按名称与 SHA-256 收集每个 attachment 的准确 acceptance outcome。
const bootstrap = await finalizeHarnessBootstrapTurn({
  runId: 'run-123',
  stagingRoot: '/private/tokenless/harness',
  nonce: 'first-turn-nonce',
  attachmentAcceptances: visibleUploadOutcomes,
})

// 只有 finalization 成功后才能发送 bootstrap.prompt。被拒绝的 Skill 会从 manifest
// 省略；被拒绝的 System Prompt 会阻止生成该 result。
// bootstrap.acceptedAttachments 仅供 audit：不要再次上传。

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
  // 在下一个 prompt 前一起上传 next.delivery.attachments。
}
```
