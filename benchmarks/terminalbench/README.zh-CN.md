# Terminal-Bench 4.0

[English](README.md)

这条 lane 评测 `DeepSeek Harness + Tokenless API + Tokenless Harness adapter` 集成。DeepSeek Harness 保留原生 Agent Loop、terminal tools、session 和 compaction；Tokenless API 通过 `tokenless/auto` 提供 model turns，原生 DSH `subagent` 调用可以把 child task 委派给 Tokenless Harness。

当前数据集为 `terminal-bench/terminal-bench@4.0.0`，通过内容摘要固定。每次只运行一道题，结束后停下来汇报，再由用户决定下一题；不创建定时任务。

首题为 `terminal-bench/session-window-debug`（2 CPU、4 GiB 内存、无需 GPU）。官方 agent 时限为 28,800 秒，verifier 在独立官方环境中执行。通过标准仍要求官方 reward `1` 和原有深度集成证据；基础设施失败或不完整调用链不算通过。

## 固定基线

| 项目 | 固定值 |
| --- | --- |
| Harbor | `0.22.0` |
| Dataset | `revision.json` 中 digest 固定的 `terminal-bench/terminal-bench` |
| Tasks | 66 |
| Phase gate | `sweep`：每题 `k=1`，共 66 trials，要求每题 verifier reward 为 1 |
| 正式尝试次数 | `full`：每题 `k=5`，共 330 trials |
| Harbor trial retries | 0 |

runner 不修改官方 task instruction、timeout、resources、environment 或 verifier。task container 只获得一个随机、仅允许 OpenAI completions 与 private Harness provider turns 的 task-scoped bearer；host daemon admin bearer 和 provider browser session 始终留在 host。

对于这条组合 lane，bridge 会把 DSH parent 的第一次 decision 约束为一个结构性只读的 `read` inspection，再把下一次符合条件的 decision 约束为 DSH 原生 named `subagent` tool。child Tokenless Harness run 会先在官方 task filesystem 内执行且只执行一次只读 workspace search probe，然后执行一次综合只读 inspection batch，并在下一 turn 返回当前最佳的 task-relevant result。DSH parent 必须在最终验证前合并执行彼此独立且合规的改动；如果允许的改动集合有限且存在本地 verifier，则只使用一次 terminal search script，由脚本自身设置单调 deadline 和 verifier counter，将搜索与最终验证合计限制为最多 64 次 execution、最多 120 秒，依据 verifier 数值结果跟踪并保留最佳 candidate，不得枚举 power set 或启动第二次搜索。如果 task mutation 受机器可读的 allowlist 或 mapping 约束，脚本必须保留 original，只从解析出的允许 transformation 构造 candidate，在任何 metric 或 verifier 前针对该来源校验完整 candidate，不得替换为模型推断的等价物；如果每个 allowlist 或 mapping entry 都是单个 whitespace token，校验还必须保持 original 的 whitespace-token 数量并逐位置比较：未变化的 token 必须完全相同，变化的 token 必须属于 original token 的解析 family；任何违反都必须在 metric 或 verifier 前拒绝，且该 candidate 不得保留为最佳或最终 candidate。final verification 必须运行完整的 provided verifier 或 test suite，且只能保留已校验的 task-permitted candidate。benchmark child registry 只暴露 `workspace.read` 与 `workspace.search`，且不提供 MCP server 或可写 tool binding，因此 DSH parent 继续负责 task mutation 与最终验证。这些约束只属于 benchmark adapter；官方 task text 与普通 Tokenless Harness 行为都不改变。

只有 host 观察到同一 run 内严格有序的 HTTP/process chain 才能证明 deep integration：最初的 parent 只读 inspection completion 与 routing 完成；随后一个 parent completion request 被强制使用原生 named `subagent` tool 并成功完成；child bootstrap turn 及其 terminal provider routing 完成；同一 provider conversation 上可以执行一个或多个 child continuation turn，并分别记录 terminal routing；随后出现更晚的 parent completion/routing，最后 DSH process 返回。continuation boundary 证明 child result 确实回到了 parent flow。工具记录另行区分提出调用与在 parent request 或 child continuation 中观察到结果；观察间隔不会被表述为工具的实际执行耗时。DSH transport boundary 只对 provider response Markdown 做必要规范化，以便严格校验 OpenAI-compatible JSON envelope。

## 记录要求

每次运行分别报告三个结论：官方 verifier 成绩、记录完整性、是否适合比较一个已知模型配置。元数据缺失不会改变官方 reward，也不会被补成猜测的观察值。

| 证据 | 必须区分的事实 |
| --- | --- |
| Provider 提交 | 请求的模型/effort 与提交页面实际观察到的标签、观察时间、页面类型、未知原因 |
| 模型身份 | `Latest` 等可见别名与 provider 实际公开的具体模型身份 |
| 工具执行 | 模型提出调用与实际观察到的执行结果；调用关联、状态、结果摘要、真正测量的耗时边界，以及明确的子任务响应解析状态 |
| 失败 | 对应的本地 job ID、终态、是否已提交、有界错误代码和分类 |
| 附件 | 声明的文件元数据与上传成功证据；记录哈希和长度，不记录文档正文 |
| 复现信息 | 启动时源码/配置身份、实际运行包哈希，与写报告时的工作区状态 |
| 用量 | 本地 token 估算与 provider 报告的 token、费用；不可获取时明确说明 |
| 结果 | 官方逐测试输出、收集的任务文件、证据哈希清单 |

子任务工具元数据复用执行 Harness 的生产响应规范化逻辑。规范化后的响应无效或不可获取时，工具关联完整性标记为 partial。

`toolResponseStatus` 描述已解析的模型提议，不代表 Harness 已接受其执行协议。`returned` 记录提议；`executed` 必须有实际观察到的工具结果。子任务调用 ID 按响应 interaction 区分，后续批次复用 ID 仍保留为独立记录。

报告只包含有界元数据，不保存 provider 提示词、回答、cookies、session values、截图或完整 DOM。历史结果保持原样，不能用后来观察到的网页状态填补旧运行的记录缺口。

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
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-4.0.0.json \
  --jobs-dir benchmarks/terminalbench/results
npm run benchmark:terminalbench -- wiring \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-4.0.0.json \
  --jobs-dir benchmarks/terminalbench/results
npm run benchmark:terminalbench -- full \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-4.0.0.json \
  --jobs-dir benchmarks/terminalbench/results
```

仓库中受 Git 跟踪的 harness、adapter、固定 manifests 和双语文档都位于 `benchmarks/terminalbench`。Harbor job 默认写入 Git ignored 的 `benchmarks/terminalbench/results/`；显式 `--jobs-dir` 只能是该目录或其子目录。Git ignored 的 `benchmarks/terminalbench/observations/` 保存本地 semantic manifest 与有界 run observations，`cache/` 保存生成的 runtime artifacts；旧的 `runs/` 不再作为输出目录。

成功 child dispatch settle 后，bridge 允许 10 分钟的 tool 阶段；下一次 parent completion 保留现有 tool catalog、将 `tool_choice` 设为 `none`，并审计为 final-only，以便在不变的官方 timeout 内返回 final response。

每个能够生成 `tokenless-run.json` 的 settled run，也会生成 `observations/<job-name>/run-observation.json`。Runner 会依据 `observation.schema.json` 构造并校验这个 Git ignored artifact；`observe` 会把同一个确定性 collector 用于已有的兼容 result job，并且绝不覆盖 evidence。

Observation 分别记录官方 verifier 成绩、routing outcome 和记录完整性。它包含 profile 与 execution mode、阶段耗时、有序 provider 交互、回退与限流证据、本地 token 估算、有界提交控制状态、工具与附件元数据，以及证据哈希。缺失事实必须带可用状态和原因；collector 不会读取今天的网页状态来填补历史缺口。观察记录不包含请求和回答正文。

`wiring` 以 `k=1` 运行一道未改写的官方 task。`sweep` 会对全部 66 个未改写官方 task 各运行一次（`k=1`、单并发、零 Harbor retry），并作为 phase gate：只有 66 个 trial 全部 settle、没有 infrastructure error/cancellation/retry、每条 deep chain 完整且 verifier reward 全部为 `1` 时才算成功。`full` 固定运行全部 66 tasks、`k=5`、单并发、零 Harbor retry。仓库提交的 task manifest 会把每个官方 task name 同时绑定到 Harbor task ref 和完整 instruction digest。DeepSeek Harness 命令要求使用上面本地 `observations/` 路径中的 semantic manifest（或另一个显式选择的 manifest），且必须有 66 个按顺序排列、与这些 instruction digest 完全匹配的 entry；每个 entry 只能包含完整 instruction digest、`preferredProvider`、有界 `taskType`、`complexity`（`low`/`medium`/`high`）和 `truncated`，并带确定性的 whole-manifest digest。默认 DSH adapter configuration 中，parent 和 child 的每次 model turn 都请求 `tokenless/auto`；manifest preference 只是 advisory，只能在 operation router 当前最高 eligibility tier 内重排 provider。benchmark profile 禁用 DSH model-request retry，并让 Tokenless API deadline 先完成终态处理，因此 submitted turn 的 exact local job 仍在运行时绝不会被 replay。每个 job 都写入不含 secret 的 `tokenless-run.json` 并记录 semantic manifest digest；正式报告把各 provider routing counts 与 official verifier rewards 分开，公开 `deepIntegration.trialsWithCompleteChain`，并在 `preRoutingExceptions` 中列出经确认发生在 provider routing 之前的异常。DSH command failure 属于 agent outcome，会进入 official verifier，而不会被误归类为 infrastructure exception；sweep 失败时保留 job evidence 且命令返回 nonzero。

明确要求单 provider 测评时，可以在直接运行 Harbor 的 config 中把 `agents[0].model_name` 设为 `tokenless/<provider>`（例如 `tokenless/chatgpt`）。Adapter 会将 parent 和 child 都绑定到该 provider，并记录 `routingMode: fixed`；semantic preference 只用于 auto run。运行前须在选定的持久化 profile 中选择并验证网页模型、thinking effort 和 Chat/Work 入口。这类直接运行保留原始 Harbor results 与 adapter audits；canonical `wiring`/`sweep`/`full` reports 仍用于 auto-route 测评。

明确配置 ChatGPT CLI run 时，`--chat-surface chat`、`--model <visible-label>` 和 `--effort <visible-label>` 用于选择请求的控制状态。这些只是配置输入，不能证明 benchmark 提交时实际使用的状态。报告记录实际观察到的选择，并保留 `Latest` 等别名，不会将别名推断成某个 GPT 版本。

`deepIntegration` 报告 host 观察到的 parent completion request、child bootstrap/continuation start、terminal provider routing、完整有序 chain，以及 `successfulDshParents`、`failedDshParents`、`unsettledParentCompletionRequests`。成功 route 会在完整 response body relay 后成为 terminal evidence；失败 upstream response 会在 relay 前记录，因此 client disconnect 不会抹掉它的 routing 与 token estimate。`providerRouting.scopes.parent.providers` 和 `providerRouting.scopes.child.providers` 将 parent 与 child 分开计数：`routed`、`attempted`、`submitted`、`rateLimited`、`fallbackOut`、`completed`、`failed`、`preferenceRequested`、`preferenceHonored`，以及估算 input/output/total tokens。`fallbackOut` 表示 source provider 被放弃并转向 fallback，同时计为 `failed=1`；`rate_limit` attempt 的 `rateLimited` 只计入该 source provider。最终 provider counters 只描述它自身的 terminal outcome。`sweep` gate 还要求每个 trial 都有一个成功的 DSH parent completion 和一个 terminal parent route；`wiring` 与 `full` 会保留这些 outcome 字段用于诊断，但不会把 verifier reward 为 `0` 误报成 Harbor infrastructure error。

每个 route attempt 和 final provider interaction 都记录 `observedAt`、`providerSubmitted`，以及对已序列化 benchmark input 与可见 assistant output 计算的 `o200k_base` 估算值。报告固定 estimator revision，并明确说明这些数字不是 provider billing usage；任何 interaction 缺少估算都会使 non-oracle report 失败。`accountPlans` 只保存本次 configured profile 对实际 provider 经过 catalog 解析的 plan ID、与 catalog 匹配的 observed label、tier class 与 `checkedAt`；不会保存账号名或未匹配的持久化 label。

每个可见 rate/plan limit 都记录有界 detector proof ID、`minute | hour | day | week | unknown`、页面可见的 retry-after，以及关联 interaction 的估算 token。通用 live-DOM detector 覆盖 rate limit、too many requests、temporary unavailable、hourly/daily/weekly cap/limit 与 plan/usage limit。正式 run 如果出现新的 provider surface，Operation Router 会继续使用仍可用 provider；随后对该 persistent provider tab 做定向核对，并依据真实页面更新对应 detector。Audit 不包含 prompt、response、task text、credential、browser session、完整 DOM、截图或页面原文。

每个 non-oracle trial 都必须贡献非空且合法的 `deep-integration.jsonl`，或由 Harbor 官方 result 证明的 pre-routing exception。pre-routing exception 不会产生 provider attempt；只要发生，`sweep` 仍然失败。`sweep` 还要求每个 trial 有完整的 host-observed chain、成功的 DSH parent outcome 和 terminal parent route；`wiring` 与 `full` 会保留合法但未完成的 audit outcome 用于报告。缺失或非法 evidence 会让 report 失败，不会被跳过。可选的 DSH failure diagnostic 只写入受限 JSON classification 和 exception class name；不会保留原始 DSH stdout、stderr、exception message 或 provider output。
