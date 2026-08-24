# Terminal-Bench 2.0

[English](README.md)

这条 lane 评测固定组合 `DeepSeek Harness + Tokenless API + Tokenless Harness adapter`。DeepSeek Harness 保留原生 Agent Loop、terminal tools、session 和 compaction；Tokenless API 提供 model turns，原生 DSH `subagent` 调用可以把 child task 委派给 Tokenless Harness。

## 固定基线

| 项目 | 固定值 |
| --- | --- |
| Harbor | `0.22.0` |
| Dataset | `revision.json` 中 digest 固定的 `terminal-bench/terminal-bench-2` |
| Tasks | 89 |
| 正式尝试次数 | 每题 `k=5`，共 445 trials |
| Harbor 与 DSH model retries | 0 |

runner 不修改官方 task instruction、timeout、resources、environment 或 verifier。task container 只获得一个随机、仅允许 OpenAI completions、private Harness provider turns 与 benchmark audit events 的 task-scoped bearer；host daemon admin bearer 和 provider browser session 始终留在 host。

对于这条组合 lane，bridge 会把 DSH parent 第一次符合条件的 decision 约束为 DSH 原生 named `subagent` tool。child Tokenless Harness run 会在官方 task filesystem 内执行且只执行一次只读 workspace search probe，再把固定的 integration acknowledgement 交回 DSH parent；DSH parent 仍须使用自己的 terminal tools 完成并验证 task。这些约束只属于 benchmark adapter；官方 task text 与普通 Tokenless Harness 行为都不改变。

只有同一 run 内存在有序 audit chain 才能证明 deep integration：Tokenless Harness 启动、发生真实 provider turn、child workspace tool 成功、child 成功 settled，随后 DSH parent 完成。DeepSeek transport boundary 只对 provider response Markdown 做必要规范化，以便严格校验 OpenAI-compatible JSON envelope。

## 命令

```sh
npm run benchmark:terminalbench -- inspect
npm run benchmark:terminalbench -- oracle --jobs-dir <path>
npm run benchmark:terminalbench -- wiring \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --provider deepseek \
  --profile web-ai \
  --jobs-dir <path>
npm run benchmark:terminalbench -- full \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --provider deepseek \
  --profile web-ai \
  --jobs-dir <path>
```

`wiring` 以 `k=1` 运行一道未改写的官方 task。`full` 固定运行全部 89 tasks、`k=5`、单并发、零 Harbor retry，并设置 DSH provider `maxRetries: 0`。每个 job 都写入不含 secret 的 `tokenless-run.json`，公开 `deepIntegration.trialsWithCompleteChain`；至少存在一条 complete chain 才能证明 deep adapter。正式报告还要求全部 445 个 verifier rewards 齐全，Harbor trial error、cancellation 与 retry 均为零；DSH command failure 属于 agent outcome，会进入官方 verifier，而不会被误归类为 infrastructure exception。
