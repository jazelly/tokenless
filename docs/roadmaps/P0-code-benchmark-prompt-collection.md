# 代码 Benchmark Prompt Collection

Status: proposed | Priority: P0 | Scope: code-only provider testing

## 目标

建立一个只包含编程任务的 provider 测试 prompt collection。开发、local test、integration 和 real-provider E2E 都从同一 collection 取题，不再使用 `reply with exactly <marker>`、token 回显或没有实际编程内容的 prompt。

这份 roadmap 只确定候选集、选题规则和后续实施顺序。本阶段不下载数据集、不实现 runner、不改现有测试。

## 非目标

- 不收录通识、数学、写作、事实问答或通用 instruction-following benchmark。
- 不把 Terminal-Bench 等混合 terminal 任务整体纳入 collection。
- 不建立 leaderboard、模型评分服务、调度器或结果数据库。
- 不把需要完整 repository snapshot 的任务降格成一段孤立 prompt。
- 不使用 LLM-as-a-judge 作为首个判分边界。

## 候选集

| 优先级 | Benchmark | 适用测试 | 任务形态 | Benchmark repository license | 采用建议 |
| --- | --- | --- | --- | --- | --- |
| P0 | [LiveCodeBench](https://github.com/LiveCodeBench/LiveCodeBench) | real-provider coding、debugging、reasoning | code generation、self-repair、code execution、test-output prediction；持续按 release 更新 | MIT | 主 collection。优先选公开 release 中可独立运行、判分确定的 code generation 题；self-repair 必须同时锁定 prior candidate 与 evaluator feedback。竞赛题面的内容权利另行核验。 |
| P0 | [BigCodeBench-Instruct](https://github.com/bigcode-project/bigcodebench) | chat/provider code generation | 面向 chat model 的自然语言编程任务，覆盖多 library 与多 function call | Apache-2.0 | 主 collection。它比 HumanEval 更接近实际 library/API 使用，适合作为 provider integration 的代表题。 |
| P0 | [EvalPlus](https://github.com/evalplus/evalplus) 的 HumanEval+ / MBPP+ | 快速 smoke、local regression | 小型 Python function synthesis，使用扩展测试提高判分强度 | Apache-2.0；上游题目 license 仍需随 manifest 记录 | 只作低成本 smoke，不作为“真实软件工程水平”的主要证据。 |
| P0 | [CRUXEval](https://github.com/facebookresearch/cruxeval) | response read、code reasoning | Python input prediction 与 output prediction，共 800 个短程序 | MIT | 用于不需要执行模型生成代码的快速真实 provider 测试；仓库已 archived，必须 pin commit。 |
| P1 | [SWE-bench Verified](https://github.com/SWE-bench/SWE-bench) | agent/harness repository editing | 500 个经工程师确认可解的真实 GitHub issue，需要 repository snapshot 与 test harness | MIT | 仅在 Tokenless 能交付 repository context、执行工具并回收 patch 后启用；不能只抽取 issue 文本冒充完整任务。每个 source repository、issue 与 snapshot 的内容权利独立核验。 |
| P1 | [SWE-bench Multilingual](https://www.swebench.com/multilingual.html) | 多语言 repository editing | 300 个真实 issue，覆盖 42 个 repository 与 9 种语言 | 随 dataset release 核验并记录 | 在 Python 路径跑通后加入 TypeScript、JavaScript、Rust、Go 等代表题。 |
| P1 | [SWE-bench-Live MultiLang](https://github.com/microsoft/SWE-bench-Live) | 新鲜度与 contamination 检查 | 持续更新的多语言、多 OS repository task | MIT | 作为 rolling collection；每次使用固定 dataset revision，不能让同一测试名随远端静默变化。 |

## 明确排除

- 原始 HumanEval / MBPP 全量：题目短、已有明显 saturation；仅使用 EvalPlus 增强版本做 smoke。
- Aider Polyglot：任务本身有价值，但下载前必须先确认 benchmark dataset 的独立 license 与可再分发边界。
- 通用 LiveBench：它混合 coding 与非 coding category；本项目直接采用纯代码的 LiveCodeBench。
- MMLU、GPQA、IFEval、SimpleQA、MGSM：不属于本 collection 的代码范围。
- `write Fibonacci`、`hello world`、marker echo 等自行编写的廉价 prompt：不能替代公开 benchmark 题。

## Collection 分层

第一版只建立三个显式集合，不按 provider 单独复制题目：

| Collection | 建议规模 | 来源 | 用途 |
| --- | ---: | --- | --- |
| `code-smoke` | 6 | EvalPlus 2、CRUXEval 2、BigCodeBench-Instruct 2 | 快速确认 prompt submit、response read 与基本代码能力。 |
| `code-core` | 20 | LiveCodeBench code generation 8、self-repair 4（含固定 prior candidate 与 feedback）、BigCodeBench-Instruct 4、CRUXEval 4 | local test、provider integration 与 release 前代表性真实测试。 |
| `code-agent` | 10 | SWE-bench Verified；之后补 SWE-bench Multilingual | repository context、tool loop、patch 与真实 tests 的完整 agent 验收。 |

`code-smoke` 与 `code-core` 可以先实施。`code-agent` 必须等 repository 边界真实可运行后再启用。

## 选题规则

每个入选任务必须同时满足：

1. prompt 的主要工作是读、写、修复、解释或执行代码。
2. 来自官方公开 benchmark release，并记录 upstream task ID、source URL、commit/dataset revision 和 retrieval date。
3. 有确定性 ground truth、official tests 或可直接比较的 execution result。
4. prompt 本身包含完成任务所需的上下文，或 manifest 明确声明所需 repository/artifact；不得偷偷删减依赖。
5. 不要求回显随机 marker。Job correlation 使用 `taskId`、`jobId` 和 `requestId`，不污染 provider prompt。
6. 不为了让某个 provider 通过而改写语义。必要的包装文字必须保存为显式 variant，并保留原 prompt。
7. 同一任务不得同时进入 train/few-shot context 与被测 collection。

Benchmark repository license 不能自动覆盖 dataset、竞赛题面、GitHub issue、source snapshot 或 hidden tests。Manifest 必须分别记录 benchmark repository license、dataset release license、upstream content/repository license，以及 `vendored`、`reference_only` 或 `excluded` 的保存与再分发结论；无法核验的内容不得复制进仓库。

## 计划中的 Manifest

下载实现时，每题至少保存以下字段：

```json
{
  "id": "livecodebench:<release>:<task-id>",
  "benchmark": "LiveCodeBench",
  "upstreamTaskId": "<task-id>",
  "taskType": "code_generation",
  "language": "python",
  "prompt": "<verbatim upstream prompt>",
  "source": {
    "url": "<official dataset URL>",
    "revision": "<immutable commit or dataset revision>",
    "repositoryLicense": "MIT",
    "datasetLicense": "<verified SPDX identifier or unknown>",
    "contentLicense": "<verified SPDX identifier or per-task reference>",
    "redistribution": "vendored | reference_only | excluded",
    "retrievedAt": "YYYY-MM-DD"
  },
  "inputs": ["<required prior candidate, feedback, repository, or attachment reference>"],
  "evaluation": {
    "kind": "official_tests",
    "artifact": "<local test reference>"
  },
  "collections": ["code-core"]
}
```

Prompt 与 official tests 分开保存。Provider 只收到任务允许公开的 prompt/context；gold solution、hidden tests 和答案不得进入模型上下文。

## 实施顺序

### Phase 1：下载与锁定

- 建立 `test/provider-prompts/code/`，保存 manifest、README 和各 benchmark attribution。
- 从官方 release 下载候选任务，记录 immutable revision 与文件 hash；先核验 dataset 与 task content 的保存、执行和再分发边界。
- 按固定 task ID 清单选题，不在 test runtime 联网随机抽题。
- LiveCodeBench self-repair 同时固定 prior candidate code 与 evaluator feedback，并作为显式 task input 保存；缺少任一输入就不入选。
- 先完成 `code-smoke` 与 `code-core`；不下载 SWE-bench container image。

Exit：26 个 standalone code task 可以离线列出，且每题 provenance、各层 license 状态与 redistribution 决策完整。

### Phase 2：本地确定性验证

- 校验 manifest schema、ID 唯一性、source revision、hash 与 collection membership。
- 使用 upstream evaluator 或 official tests 验证 gold artifact。
- 对生成代码的执行使用 benchmark 官方隔离边界；不在开发机主环境直接执行未审查代码。
- CRUXEval-O 比较规范化 output；CRUXEval-I 通过官方 evaluator 在隔离环境执行候选 input/function call 并确认目标 output，允许多个等价输入；不引入 model judge。

Exit：每个 standalone task 都有一个可重复的 deterministic verdict。

### Phase 3：接入 provider 测试

- 将所有会真实提交到 AI provider 的 development、manual/local、integration 与 E2E prompt 改为按 task ID 读取 collection。
- transport smoke 使用 `code-smoke`，能力与 release evidence 使用 `code-core`。
- 删除 `reply/respond with exactly <marker>` 及等价 prompt；correlation 保留在本地 job metadata。
- 第一条真实路径只跑一个 BigCodeBench-Instruct task，从 built CLI 提交并用 official tests 判分。

Exit：当前 provider 测试中不存在 marker-only submission，且至少一个真实 provider 完成一次 benchmark prompt → response → deterministic evaluation。

### Phase 4：Repository-level agent tasks

- 在 repository context、filesystem tool 与 patch 回收路径可用后，接入固定的 SWE-bench Verified subset。
- 跑通一个 task 的真实 repository checkout、provider turn、patch application 与 official tests，再扩到 10 题。
- 多语言从 TypeScript/JavaScript 与 Rust 代表题开始；rolling dataset 始终 pin revision。

Exit：`code-agent` 的每个成功结果都由真实 repository tests 证明，而不是由回复文本或 LLM judge 证明。

## 验收标准

- Collection 100% 为代码相关任务，没有通识、写作或 marker echo prompt。
- 每题都有官方来源、不可变 revision、分层 license/redistribution 决策、upstream task ID 和 deterministic evaluator。
- `code-smoke` 不被宣传为完整 coding quality benchmark。
- Standalone prompt 与 repository-level task 不混淆；缺少 repository snapshot 时直接不可用。
- 所有真实 provider 测试从 collection 取题，本地测试使用相同 task ID 与相同判分逻辑。
- 不下载或持久化不明 license 的 dataset，也不把 hidden tests 或 gold answer 发给 provider。

## 第一批推荐

第一批只做 26 个 standalone task：LiveCodeBench 12、BigCodeBench-Instruct 6、CRUXEval 4、EvalPlus 4。这个组合同时覆盖代码生成、debugging、library/API 使用、代码执行推理与低成本 smoke，又不要求先建设 repository agent infrastructure。
