# Terminal-Bench 2.0

[English](README.md)

这条 lane 评测 `DeepSeek Harness + Tokenless API + Tokenless Harness adapter` 集成。DeepSeek Harness 保留原生 Agent Loop、terminal tools、session 和 compaction；Tokenless API 通过 `tokenless/auto` 提供 model turns，原生 DSH `subagent` 调用可以把 child task 委派给 Tokenless Harness。

## 固定基线

| 项目 | 固定值 |
| --- | --- |
| Harbor | `0.22.0` |
| Dataset | `revision.json` 中 digest 固定的 `terminal-bench/terminal-bench-2` |
| Tasks | 89 |
| Phase gate | `sweep`：每题 `k=1`，共 89 trials，要求每题 verifier reward 为 1 |
| 正式尝试次数 | `full`：每题 `k=5`，共 445 trials |
| Harbor trial retries | 0 |

runner 不修改官方 task instruction、timeout、resources、environment 或 verifier。task container 只获得一个随机、仅允许 OpenAI completions 与 private Harness provider turns 的 task-scoped bearer；host daemon admin bearer 和 provider browser session 始终留在 host。

对于这条组合 lane，bridge 会把 DSH parent 的第一次 decision 约束为一个结构性只读的 `read` inspection，再把下一次符合条件的 decision 约束为 DSH 原生 named `subagent` tool。child Tokenless Harness run 会先在官方 task filesystem 内执行且只执行一次只读 workspace search probe，然后执行一次综合只读 inspection batch，并在下一 turn 返回当前最佳的 task-relevant result。DSH parent 必须在最终验证前合并执行彼此独立且合规的改动；如果允许的改动集合有限且存在本地 verifier，则只使用一次 terminal search script，由脚本自身设置单调 deadline 和 verifier counter，将搜索与最终验证合计限制为最多 64 次 execution、最多 120 秒，依据 verifier 数值结果跟踪并保留最佳 candidate，不得枚举 power set 或启动第二次搜索。如果 task mutation 受机器可读的 allowlist 或 mapping 约束，脚本必须保留 original，只从解析出的允许 transformation 构造 candidate，在任何 metric 或 verifier 前针对该来源校验完整 candidate，不得替换为模型推断的等价物；如果每个 allowlist 或 mapping entry 都是单个 whitespace token，校验还必须保持 original 的 whitespace-token 数量并逐位置比较：未变化的 token 必须完全相同，变化的 token 必须属于 original token 的解析 family；任何违反都必须在 metric 或 verifier 前拒绝，且该 candidate 不得保留为最佳或最终 candidate。final verification 必须运行完整的 provided verifier 或 test suite，且只能保留已校验的 task-permitted candidate。benchmark child registry 只暴露 `workspace.read` 与 `workspace.search`，且不提供 MCP server 或可写 tool binding，因此 DSH parent 继续负责 task mutation 与最终验证。这些约束只属于 benchmark adapter；官方 task text 与普通 Tokenless Harness 行为都不改变。

只有 host 观察到同一 run 内严格有序的 HTTP/process chain 才能证明 deep integration：最初的 parent 只读 inspection completion 与 routing 完成；随后一个 parent completion request 被强制使用原生 named `subagent` tool 并成功完成；child bootstrap turn 及其 terminal provider routing 完成；同一 provider conversation 上可以执行一个或多个 child continuation turn，并分别记录 terminal routing；随后出现更晚的 parent completion/routing，最后 DSH process 返回。continuation boundary 证明 child result 确实回到了 parent flow，但不声称拥有直接 child-tool execution trace。DSH transport boundary 只对 provider response Markdown 做必要规范化，以便严格校验 OpenAI-compatible JSON envelope。

## 命令

```sh
npm run benchmark:terminalbench -- inspect
npm run benchmark:terminalbench -- observe \
  --job-dir benchmarks/terminalbench/results/<job-name>
npm run benchmark:terminalbench -- oracle \
  --jobs-dir benchmarks/terminalbench/results
npm run benchmark:terminalbench -- sweep \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-20260826-auto-v2.json \
  --jobs-dir benchmarks/terminalbench/results
npm run benchmark:terminalbench -- wiring \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-20260826-auto-v2.json \
  --jobs-dir benchmarks/terminalbench/results
npm run benchmark:terminalbench -- full \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-20260826-auto-v2.json \
  --jobs-dir benchmarks/terminalbench/results
```

仓库中受 Git 跟踪的 harness、adapter、固定 manifests 和双语文档都位于 `benchmarks/terminalbench`。Harbor job 默认写入 Git ignored 的 `benchmarks/terminalbench/results/`；显式 `--jobs-dir` 只能是该目录或其子目录。Git ignored 的 `benchmarks/terminalbench/observations/` 保存本地 semantic manifest 与有界 run observations，`cache/` 保存生成的 runtime artifacts；旧的 `runs/` 不再作为输出目录。

每个能够生成 `tokenless-run.json` 的 settled run，也会生成 `observations/<job-name>/run-observation.json`。Runner 会依据 `observation.schema.json` 构造并校验这个 Git ignored artifact；`observe` 会把同一个确定性 collector 用于已有的兼容 result job，并且绝不覆盖 evidence。

Observation 会把 official verifier outcome 与 routing outcome 分开。它记录实际 profile 与由 run 固定的 execution mode、Harbor run/trial/stage timing、每个有序 provider interaction 与 fallback reason、submission/failure rate、可见 limit evidence、估算 token usage、response 字符数与 hash，以及源 result/audit 文件的 SHA-256 对应关系。新的 DeepSeek Harness run 会把 `executionMode` 固定到 `tokenless-run.json`；旧 report 如果没有该字段，就会记录为 `unavailable`，而不会把今天的 configuration 错误归因给过去的 run。采集完全由代码完成且只保存 metadata：v4 不能证明逐 provider latency，token 数值只是估算而不是 provider billing usage，并且绝不保存 prompt 或 response body。

`wiring` 以 `k=1` 运行一道未改写的官方 task。`sweep` 会对全部 89 个未改写官方 task 各运行一次（`k=1`、单并发、零 Harbor retry），并作为 phase gate：只有 89 个 trial 全部 settle、没有 infrastructure error/cancellation/retry、每条 deep chain 完整且 verifier reward 全部为 `1` 时才算成功。`full` 固定运行全部 89 tasks、`k=5`、单并发、零 Harbor retry。仓库提交的 task manifest 会把每个官方 task name 同时绑定到 Harbor task ref 和完整 instruction digest。DeepSeek Harness 命令要求使用上面本地 `observations/` 路径中的 semantic manifest（或另一个显式选择的 manifest），且必须有 89 个按顺序排列、与这些 instruction digest 完全匹配的 entry；每个 entry 只能包含完整 instruction digest、`preferredProvider`、有界 `taskType`、`complexity`（`low`/`medium`/`high`）和 `truncated`，并带确定性的 whole-manifest digest。DSH adapter identity 保持固定，但 parent 和 child 的每次 model turn 都请求 `tokenless/auto`；manifest preference 只是 advisory，只能在 operation router 当前最高 eligibility tier 内重排 provider。benchmark profile 禁用 DSH model-request retry，并让 Tokenless API deadline 先完成终态处理，因此 submitted turn 的 exact local job 仍在运行时绝不会被 replay。每个 job 都写入不含 secret 的 `tokenless-run.json` 并记录 semantic manifest digest；正式报告把各 provider routing counts 与 official verifier rewards 分开，公开 `deepIntegration.trialsWithCompleteChain`，并在 `preRoutingExceptions` 中列出经确认发生在 provider routing 之前的异常。DSH command failure 属于 agent outcome，会进入 official verifier，而不会被误归类为 infrastructure exception；sweep 失败时保留 job evidence 且命令返回 nonzero。

`deepIntegration` 报告 host 观察到的 parent completion request、child bootstrap/continuation start、terminal provider routing、完整有序 chain，以及 `successfulDshParents`、`failedDshParents`、`unsettledParentCompletionRequests`。成功 route 会在完整 response body relay 后成为 terminal evidence；失败 upstream response 会在 relay 前记录，因此 client disconnect 不会抹掉它的 routing 与 token estimate。`providerRouting.scopes.parent.providers` 和 `providerRouting.scopes.child.providers` 将 parent 与 child 分开计数：`routed`、`attempted`、`submitted`、`rateLimited`、`fallbackOut`、`completed`、`failed`、`preferenceRequested`、`preferenceHonored`，以及估算 input/output/total tokens。`fallbackOut` 表示 source provider 被放弃并转向 fallback，同时计为 `failed=1`；`rate_limit` attempt 的 `rateLimited` 只计入该 source provider。最终 provider counters 只描述它自身的 terminal outcome。`sweep` gate 还要求每个 trial 都有一个成功的 DSH parent completion 和一个 terminal parent route；`wiring` 与 `full` 会保留这些 outcome 字段用于诊断，但不会把 verifier reward 为 `0` 误报成 Harbor infrastructure error。

每个 route attempt 和 final provider interaction 都记录 `observedAt`、`providerSubmitted`，以及对已序列化 benchmark input 与可见 assistant output 计算的 `o200k_base` 估算值。报告固定 estimator revision，并明确说明这些数字不是 provider billing usage；任何 interaction 缺少估算都会使 non-oracle report 失败。`accountPlans` 只保存本次 configured profile 对实际 provider 经过 catalog 解析的 plan ID、与 catalog 匹配的 observed label、tier class 与 `checkedAt`；不会保存账号名或未匹配的持久化 label。

每个可见 rate/plan limit 都记录有界 detector proof ID、`minute | hour | day | week | unknown`、页面可见的 retry-after，以及关联 interaction 的估算 token。通用 live-DOM detector 覆盖 rate limit、too many requests、temporary unavailable、hourly/daily/weekly cap/limit 与 plan/usage limit。正式 run 如果出现新的 provider surface，Operation Router 会继续使用仍可用 provider；随后对该 persistent provider tab 做定向核对，并依据真实页面更新对应 detector。Audit 不包含 prompt、response、task text、credential、browser session、完整 DOM、截图或页面原文。

每个 non-oracle trial 都必须贡献非空且合法的 `deep-integration.jsonl`，或由 Harbor 官方 result 证明的 pre-routing exception。pre-routing exception 不会产生 provider attempt；只要发生，`sweep` 仍然失败。`sweep` 还要求每个 trial 有完整的 host-observed chain、成功的 DSH parent outcome 和 terminal parent route；`wiring` 与 `full` 会保留合法但未完成的 audit outcome 用于报告。缺失或非法 evidence 会让 report 失败，不会被跳过。可选的 DSH failure diagnostic 只写入受限 JSON classification 和 exception class name；不会保留原始 DSH stdout、stderr、exception message 或 provider output。
