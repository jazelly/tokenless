# Terminal-Bench 2.0

[English](README.md)

这条 lane 评测 `DeepSeek Harness + Tokenless API + Tokenless Harness adapter` 集成。DeepSeek Harness 保留原生 Agent Loop、terminal tools、session 和 compaction；Tokenless API 通过 `tokenless/auto` 提供 model turns，原生 DSH `subagent` 调用可以把 child task 委派给 Tokenless Harness。

## 固定基线

| 项目 | 固定值 |
| --- | --- |
| Harbor | `0.22.0` |
| Dataset | `revision.json` 中 digest 固定的 `terminal-bench/terminal-bench-2` |
| Tasks | 89 |
| 正式尝试次数 | 每题 `k=5`，共 445 trials |
| Harbor trial retries | 0 |

runner 不修改官方 task instruction、timeout、resources、environment 或 verifier。task container 只获得一个随机、仅允许 OpenAI completions 与 private Harness provider turns 的 task-scoped bearer；host daemon admin bearer 和 provider browser session 始终留在 host。

对于这条组合 lane，bridge 会把 DSH parent 的第一次 decision 约束为一个结构性只读的 `read` inspection，再把下一次符合条件的 decision 约束为 DSH 原生 named `subagent` tool。child Tokenless Harness run 会先在官方 task filesystem 内执行且只执行一次只读 workspace search probe，然后执行一次综合只读 inspection batch，并在下一 turn 返回当前最佳的 task-relevant result。DSH parent 必须在最终验证前合并执行彼此独立且合规的改动。benchmark child registry 只暴露 `workspace.read` 与 `workspace.search`，且不提供 MCP server 或可写 tool binding，因此 DSH parent 继续负责 task mutation 与最终验证。这些约束只属于 benchmark adapter；官方 task text 与普通 Tokenless Harness 行为都不改变。

只有 host 观察到同一 run 内严格有序的 HTTP/process chain 才能证明 deep integration：最初的 parent 只读 inspection completion 与 routing 完成；随后一个 parent completion request 被强制使用原生 named `subagent` tool 并成功完成；child bootstrap turn 及其 terminal provider routing 完成；同一 provider conversation 上可以执行一个或多个 child continuation turn，并分别记录 terminal routing；随后出现更晚的 parent completion/routing，最后 DSH process 返回。continuation boundary 证明 child result 确实回到了 parent flow，但不声称拥有直接 child-tool execution trace。DSH transport boundary 只对 provider response Markdown 做必要规范化，以便严格校验 OpenAI-compatible JSON envelope。

## 命令

```sh
npm run benchmark:terminalbench -- inspect
npm run benchmark:terminalbench -- oracle --jobs-dir <path>
npm run benchmark:terminalbench -- wiring \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest <external-semantic-manifest.json> \
  --jobs-dir <path>
npm run benchmark:terminalbench -- full \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest <external-semantic-manifest.json> \
  --jobs-dir <path>
```

`wiring` 以 `k=1` 运行一道未改写的官方 task。`full` 固定运行全部 89 tasks、`k=5`、单并发、零 Harbor retry。仓库提交的 task manifest 会把每个官方 task name 同时绑定到 Harbor task ref 和完整 instruction digest。两个命令还要求一个 external semantic manifest：必须有 89 个按顺序排列、与这些 instruction digest 完全匹配的 entry；每个 entry 只能包含完整 instruction digest、`preferredProvider`、有界 `taskType`、`complexity`（`low`/`medium`/`high`）和 `truncated`，并带确定性的 whole-manifest digest。DSH adapter identity 保持固定，但 parent 和 child 的每次 model turn 都请求 `tokenless/auto`；manifest preference 只是 advisory，只能在 operation router 当前最高 eligibility tier 内重排 provider。benchmark profile 禁用 DSH model-request retry，并让 Tokenless API deadline 先完成终态处理，因此 submitted turn 的 exact local job 仍在运行时绝不会被 replay。每个 job 都写入不含 secret 的 `tokenless-run.json` 并记录 semantic manifest digest；正式报告把各 provider routing counts 与官方 verifier rewards 分开，并公开 `deepIntegration.trialsWithCompleteChain`。正式报告还要求全部 445 个 verifier rewards 齐全，Harbor trial error、cancellation 与 retry 均为零；DSH command failure 属于 agent outcome，会进入官方 verifier，而不会被误归类为 infrastructure exception。

`deepIntegration` 报告 host 观察到的 parent completion request、child bootstrap/continuation start、terminal provider routing 与完整有序 chain。只有完整 response body 已成功 relay 后，route 才会成为 terminal evidence。`providerRouting.scopes.parent.providers` 和 `providerRouting.scopes.child.providers` 将 parent 与 child request 分开计数：`routed`、`attempted`、`rateLimited`、`fallbackOut`、`completed`、`failed`、`preferenceRequested`、`preferenceHonored`。`fallbackOut` 表示某个 source provider 在 pre-submit 尝试后被放弃并转向 fallback；这次 fallback-out 同时计为 `failed=1`，其中 `rate_limit` attempt 的 `rateLimited` 只计入该 source provider。最终 provider 的 `rateLimited` 只描述它自身的 terminal failure；成功完成的 final provider 必须是 `rateLimited=false`。最终 provider 的 `completed` 与 `failed` 只描述它自己的终态。Browser provider turn 没有暴露可靠的 token usage，因此 `providerRouting.tokenUsage` 会明确报告 `unavailable`，不会伪造 token counts。Observer 不包含 prompt、response、task text、credentials、browser session、DOM。

每个 non-oracle trial 都必须有合法的 `deep-integration.jsonl` 和一条完整的 host-observed chain；缺失或非法 evidence 会让 report 失败，不会被跳过。可选的 DSH failure diagnostic 只写入受限 JSON classification 和 exception class name；不会保留原始 DSH stdout、stderr、exception message 或 provider output。
