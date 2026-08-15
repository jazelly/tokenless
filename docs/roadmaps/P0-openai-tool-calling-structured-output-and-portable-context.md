# OpenAI Tool Calling、Structured Output 与可移植 Provider Context

Status: proposed, highest active delivery priority | Priority: P0

Related: [Web Agent Harness](P0-web-agent-harness.md)、[Web AI Interaction Protocol](P0-web-ai-interaction-protocol.md)、[Context Delivery and Workspace Alignment](P0-context-delivery-and-workspace-alignment.md)、[Web AI → API: Provider Direct Protocol](P0-direct-provider-protocol.md)、[FeatureBench Agent Runtime Evaluation](P0-featurebench-agent-runtime-evaluation.md)、[Concurrency and Session Scheduling](P0-concurrency-and-session-scheduling.md)

Depends on: 现有 authenticated local API、OpenAI-compatible Chat Completions 路由、provider registry、真实 provider turn、`tokenless.context-envelope.v1` 与已实现的 Web Agent Harness strict envelope/parser 基础

## Outcome

Tokenless 同时提供两个完整而不混淆的产品面：

1. **Standalone Web Agent Harness**：Tokenless 自己拥有 Tool Registry、授权、执行、结果与 Agent Loop。
2. **Universal OpenAI-compatible API**：外部 Harness 提供本轮 `tools`，Tokenless 只负责把 provider model turn 可靠地翻译成标准 tool call 或 structured JSON；工具执行与下一轮仍由外部 Harness 拥有。

Universal API 的完成态不是“接受 `tools` 字段”，也不是只证明一次 `read` happy path。它必须完整保证现代 OpenAI tool-calling 与 structured-output 语义，统一 native structured provider 与纯语言网页模型，支持 non-streaming、SSE、完整 tool history、`tool_choice`、多个调用、strict arguments、JSON mode、JSON Schema final output，并为未来显式 `auto` provider routing 提供可跨 provider 重放的 canonical conversation history。

第一条 DSH → Tokenless → real web provider → DSH tool execution → Tokenless final answer 是最先交付的真实结果，但不是本 roadmap 的完成条件。协议完成后，还必须让本机真实 DSH 在隔离的真实 repository 中完成代码定位、连续工具调用和当前 SWE benchmark task，并用 DSH session log、Tokenless canonical trace、repository diff 与官方 evaluator 共同证明；单次 `read` demo 不能替代这条证据。

## 当前状态与缺口

| Surface | 当前状态 | 本 roadmap 的目标 |
| --- | --- | --- |
| `GET /v1/models`、Bearer auth、普通文本 Chat Completions | 已实现 | 保持兼容 |
| `stream: true` | 已实现 terminal SSE text chunk | 扩展到标准 `delta.tool_calls` 与 `finish_reason: tool_calls` |
| Incoming `tools`、`tool_choice`、`response_format` | 明确返回 `400 unsupported_parameter` | 按声明的现代 contract 解析、执行约束与验证 |
| Assistant `tool_calls` history | 未表示 | 保留 call id、name、raw arguments 与顺序 |
| `role: tool` / `tool_call_id` | 未支持 | 作为 canonical history 的一等消息 |
| Visible-provider structured control | Web Agent Harness 已有 `action_batch` strict envelope | 抽出可复用的低层 framing/schema primitives，但不把 API 请求送入 mission/Skill loop |
| Standalone Harness Tool Registry/Loop | 部分实现 | 继续由 Web Agent Harness roadmap 拥有 |
| Cross-provider context | Context Envelope 支持同一 job 的 pre-submission fallback | 扩展 canonical model history，使已经完成的 tool call/result 可安全重放到另一 compatible provider |
| OpenAI Responses tool items | direct G4F surface 可透明代理，统一 API 未拥有 canonical mapping | 在 Chat Completions contract 稳定后纳入同一语义模型 |
| 本机 DSH interoperability | 本机已有 clean DSH checkout 和完整 Tool Registry/Agent Loop，但 Tokenless 仍拒绝 `tools` | 固定 DSH revision，通过 built DSH、packaged Tokenless、真实 provider 与真实 local tools 证明完整兼容 |
| 真实 SWE task evidence | 独立 FeatureBench roadmap 评测 Tokenless 自有 scaffold | 增加小型 DSH interoperability cohort，使用当前可执行 SWE-rebench task 观察长链 tool-call 能力，不另立或混排 benchmark 分数 |

## Provider Endpoint Reference Baseline

Tokenless 不应凭记忆发明“OpenAI-compatible”。实现前先固定当前官方 wire contract，并把 provider 的可观察行为映射到 canonical model。闭源 provider 的 server implementation 不可见，因此这里的“参考 provider 端实现”只包含三类可核验资料：官方 API 文档、官方 SDK types/serialization、经过脱敏的真实 endpoint request/stream/response；不得声称看过 proprietary sampling 或 server source。

| Reference | 必须研究和记录的 provider-side behavior | Tokenless 应吸收的设计约束 |
| --- | --- | --- |
| [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) 与 [Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming) | function/custom tools、`strict` schema subset、`tool_choice`、parallel calls、`function_call`/`function_call_output`、`call_id`、argument delta/done events | 分离 response item id 与 public call id；保留完整 output items；strict schema 在生成与返回边界都成立 |
| [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) | assistant `tool_use` blocks、`stop_reason: tool_use`、紧邻的 user `tool_result` blocks、`tool_use_id`、parallel blocks、`is_error` 与 content ordering | canonical history 不能假设所有 provider 都有 `role: tool`；adapter 必须保留 block 顺序和错误语义 |
| [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling) 与 [thinking/signatures](https://ai.google.dev/gemini-api/docs/thinking) | function declarations、`functionCall`/`functionResponse`、`auto`/`any`/`none`/`validated`、parallel/compositional calls、thinking-model signatures | provider-required opaque continuation metadata可在同 provider adapter 内重放，但不得伪装成 portable canonical history |
| [DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls/) | OpenAI-shaped assistant `tool_calls`、`role: tool`、`tool_call_id`、Beta strict schema subset | 作为 DSH 原生 adapter 的直接对照；Tokenless 输出必须让 DSH 无 special case 消化 |
| [vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/) | model-specific chat template/parser 负责 `auto` extraction；forced/named calls 可进入 structured-output constrained decoding | 将 prompt compiler、model-dialect parser、schema constraint/validation、stream assembler 与 public serializer 分层，不把一个 marker parser当成完整 endpoint |

在实现或宣称每个 provider route 前维护一张小型 conformance table，字段只包含 contract revision、request shape、stream events、history replay、schema subset、tool-choice semantics 与已验证差异。首个 DSH run只需完成其使用的 OpenAI/DeepSeek-shaped contract和selected Tokenless route，不等待其他provider研究。官方文档是设计依据；任何 Tokenless `native_*` capability claim 还必须有该 exact endpoint/model 的 live probe。没有显式配置相应 credential 时保持 `unsupported/unverified`，不为完成研究而读取或复制 browser session secret。

由这些 reference 得出的实现边界是：

1. **Request compiler** 把 canonical messages、caller 本轮 tools 和 constraints编译成 exact provider dialect。
2. **Generation strategy** 明确是 provider-native constrained output，还是纯语言模型的 prompt-emulated envelope。
3. **Stream assembler/parser** 按 provider event identity组装 text、call name 和 arguments，不在 partial JSON 上执行工具。
4. **Canonical validator** 验证本轮 tool catalog membership、JSON Schema、call/result关联与完成状态。
5. **Public serializer** 最后才生成 Chat Completions 或 Responses wire objects/events。

这里的工具名校验不是 Tokenless 维护一张永久“知名工具白名单”。白名单就是 caller 在**本次请求**发来的 `tools` capability catalog；模型只能请求这轮明确暴露的 name。否则 prompt injection 或模型幻觉可以制造一个 Harness 从未授权、也无法执行的工具调用。

## 完整保证的定义

“协议保证”不表示网页模型永远成功生成正确 JSON。它表示 Tokenless public boundary 只有两种结果：

```text
schema-valid tool call / schema-valid structured final output
or
explicit machine-readable protocol failure
```

Tokenless 不得：

- 把 prose、Markdown fence 或部分 JSON 包装成成功 tool call；
- 返回本轮 `tools` 未声明的工具名；
- 在 `strict: true` 时返回不符合 schema 的 arguments；
- 返回重复、空、错配或无法关联的 call id；
- 在 arguments 被截断时仍返回 `finish_reason: tool_calls`；
- 在 `response_format` 要求 JSON 时返回 `finish_reason: stop` 加无效 JSON；
- 把 provider-specific continuation id、reasoning state 或 conversation URL 冒充 portable model history；
- 为了自动切 provider 静默删除 tool history、改变 instruction precedence 或降低请求语义。

Native provider 的 typed tool/JSON response 也必须在 Tokenless boundary 重新验证。Provider-native framing 减少了 prompt-emulation 风险，但不免除 public contract validation。

## Ownership Boundary

### Universal API

Universal API 每个请求接收 caller-owned `ToolSchema[]`，并将其视为当前 turn 的临时 capability catalog：

```text
external Harness
  -> messages + tools + tool_choice + response_format
  -> Tokenless protocol adapter
  -> selected provider model turn
  -> Tokenless validated text/tool/JSON response
  -> external Harness executes tools and sends the next request
```

Universal API 不注册或执行 caller tools，也不继承 Standalone Harness 的授权、MCP session、filesystem root 或 ToolDefinition implementation。它只验证 model request 是否属于本轮 caller 明确提供的 catalog。

### Standalone Web Agent Harness

Standalone Harness 继续拥有：

- internal `ToolDefinition` 与 Tool Registry；
- 每 turn 暴露的 `ToolSchema` 投影；
- authorization、approval、timeout、cancellation 与 execution；
- `ToolResult`、durable run history、loop continuation 与 final result；
- Skill、filesystem、MCP、user input 与 UI presentation。

两个产品面共享 canonical message/tool block types、schema validation、prompt framing 与 provider response parsing时，必须保持 dependency direction：API adapter 不得调用 Standalone Harness mission queue，Standalone Harness 也不得通过 public API 反向执行自己的 local tools。

## Canonical Semantic Model

Tokenless 需要一个 provider-neutral、OpenAI 可无损映射的 model-turn history。它是 auto routing 与跨 provider continuation 的真相源；provider-local conversation 只是可选 transport optimization。

```ts
type CanonicalMessage =
  | { role: 'system' | 'developer' | 'user'; content: CanonicalContent[] }
  | {
      role: 'assistant'
      content: CanonicalContent[]
      toolCalls: CanonicalToolCall[]
    }
  | {
      role: 'tool'
      toolCallId: string
      content: CanonicalContent[]
      isError?: boolean
    }

type CanonicalToolCall = {
  id: string
  name: string
  argumentsJson: string
  origin?: {
    provider: string
    executionMode: 'browser' | 'direct'
    providerCallId?: string
  }
}
```

这是语义草图，不预先要求一个新的 public package或 generalized message framework。实现应先在 API proxy 与 Web Agent Harness 已有 types 附近收敛最小共享类型；只有两个真实 consumer 都需要时才提取模块。

Canonical history 必须满足：

- public call id 在 caller boundary 稳定，provider-local id 只属于 adapter mapping；
- 同一 assistant message 中多个 call id 唯一，顺序稳定；
- tool result 只能引用此前尚未完成的 call id；
- 下一次 model turn 前，每个需要结果的 call 都有且只有一个 result；
- assistant text 与 tool calls 可同时存在，不丢弃任一部分；
- arguments 保留原始 JSON string 以支持精确 replay，同时只在验证边界解析；
- provider reasoning、opaque response id 与 hidden state 不进入 portable transcript；
- public API 请求已经携带完整 history 时，Tokenless 不需要为 Chat Completions另建 conversation database。

## Public Compatibility Scope

### Modern Chat Completions — required

| Contract | Required behavior |
| --- | --- |
| `tools[].type = function` | name、description、parameters 与 optional `strict` |
| `tool_choice` | omitted/`auto`、`none`、`required`、named function |
| `parallel_tool_calls` | transport multiple calls when enabled；does not authorize Tokenless-side execution |
| Assistant history | `content`, `tool_calls[]`, stable ids, raw arguments |
| Tool history | `role: tool`, `tool_call_id`, text/declared supported content |
| Non-stream response | `message.tool_calls`, `content`, `finish_reason: tool_calls` |
| SSE response | stable `index`/`id`, ordered argument fragments or one complete fragment, terminal `tool_calls`, `[DONE]` |
| Tool result continuation | complete history re-enters the selected provider and may produce another call or final answer |
| `response_format: json_object` | final assistant content is valid JSON object |
| `response_format: json_schema` | final assistant content validates against the accepted schema subset |
| Combined tools + structured final | tool turns remain calls；only final content must satisfy the requested response format |

Tokenless 必须发布自己实际支持的 JSON Schema subset，并在 request boundary 拒绝 unsupported keywords；不得接受任意 schema 后声称 strict guarantee。

### Responses API — required after Chat Completions completion

Canonical tool semantics还要映射：

- function tool definitions；
- `function_call` output items；
- `function_call_output` input items；
- stable `call_id`；
- text and structured final output；
- stream events sufficient for caller reconstruction；
- full-input replay and `previous_response_id` behavior。

`previous_response_id` 是本 roadmap 的明确 Responses acceptance criterion，因此允许加入一个最小 local response ledger。它只保存调用者稍后引用一个 Tokenless response id 时重建下一次 request 所必需的 canonical public items，以及 exact provider明确要求回传但不可跨provider解释的opaque output items。后者必须绑定原 provider、model和execution mode，只能在同一 provider-affine continuation中使用；auto/cross-provider route遇到required opaque replay state时fail closed。Ledger不得保存未由provider API返回的hidden reasoning、credential、browser session或unrelated conversation data，也不得扩展为general memory、checkpoint或conversation platform。

Responses full-input replay不依赖ledger：caller显式回传的function calls/results直接进入canonical history；caller原样回传、且由Tokenless先前公开response产生的required opaque/reasoning items进入一个separate provider-affine replay collection，而不是portable canonical history。Tokenless必须验证这些items的已知shape、origin response、provider、model和execution mode，原样交回同一route；required item缺失、来源未知或跨route时fail closed。`previous_response_id` replay则由ledger恢复同样的portable items与provider-affine replay state；public response id、retention limit、missing/expired error和provider-mismatch error都必须文档化并由真实SDK continuation验证。

### Explicit exclusions

- Deprecated `functions` / `function_call` 不因“OpenAI-compatible”名称自动进入范围；只有一个当前真实 client 无法使用 modern `tools` 时才单独纳入。
- Provider-hosted built-in web search、file search、computer use、code interpreter 与 MCP 不是 caller-executed function tools；它们继续属于各自 capability roadmap。
- Multimodal parity 不由本 roadmap 单独声明；canonical content 只保留已经由 API 与 provider capability matrix 证明的类型。

## Provider Execution Strategies

每个 `provider × execution mode × model` 必须声明 structured-control strategy：

| Strategy | Input | Output | Guarantee owner |
| --- | --- | --- | --- |
| `native_tool_call` | provider-native tool schema | typed provider call blocks/events | Provider framing + Tokenless validation |
| `native_json_schema` | provider-native schema mode | typed/guaranteed JSON content | Provider framing + Tokenless validation |
| `prompt_tool_envelope` | compiled catalog + protocol prompt | marked strict JSON envelope | Tokenless compiler/parser/validator |
| `prompt_json_envelope` | compiled response schema + protocol prompt | marked strict JSON final envelope | Tokenless compiler/parser/validator |
| `unsupported` | request rejected before submission | machine-readable capability error | Tokenless router |

Capability metadata还必须说明：

- tool-call history replay 是否可用；
- multiple calls 是否可表示；
- strict arguments 是否可保证；
- structured final output 是否可保证；
- provider conversation continuation 是否可以与 full-history replay 并存；
- provider context window 是否容纳当前 canonical request；
- 当前 real-provider evidence revision。

Router 必须按本次 request 推导完整 requirement set，再选择 strategy。不得先提交 prompt 再尝试猜测 provider 是否能满足结构化 contract。

## Prompt-Emulated Structured Control

纯语言网页模型的 compiler 必须把以下内容作为一个高优先级 protocol frame 交付：

1. protocol version、turn nonce 与唯一 markers；
2. 本次 caller 提供的 exact tool catalog；
3. `tool_choice`、multiple-call 与 final-output constraints；
4. canonical history，其中 user/tool content 明确标记为 untrusted data；
5. 两个互斥输出分支：`tool_calls` 或 `final`；
6. exact JSON shapes 与禁止额外 executable envelope 的规则。

Parser 必须：

- 限制 response bytes、JSON depth、property count 与 call count；
- 要求 exactly one marker pair 和 exactly one envelope；
- 验证 protocol、turn 与 nonce；
- 拒绝 duplicate keys、unknown required-shape fields 与 trailing executable content；
- 按本次 catalog 验证 tool name；
- 验证 arguments 是 JSON object，并在 strict contract 下执行 schema validation；
- 由 Tokenless 分配 public call ids，不信任模型选择 public identity；
- 将 final envelope 解包为 caller 要求的 plain text 或 exact JSON content，不泄漏内部 framing。

Web Agent Harness 现有 strict parser、JSON Schema validator 与 framing 规则是实现起点。API-specific envelope 不携带 `skillLoads`、`needs`、mission persistence 或 tool execution dependencies。

## Validation、Failure 与 Bounded Correction

### Input validation

在任何 provider submission 前验证：

- tools 和 names 唯一、bounded 且 schema 合法；
- `tool_choice` 引用本轮 catalog；
- assistant/tool history call ids 完整且一一对应；
- `response_format` schema 属于 supported subset；
- request content、history 与 schema 在 byte/context limits 内；
- selected/auto candidate strategy 能满足完整 requirement set。

### Output validation

在任何成功 response 暴露给 caller 前验证：

- response framing 与 finish reason 一致；
- call indexes、ids、names 与 arguments 完整；
- strict arguments / final JSON schema通过；
- native provider 没有返回 undeclared tool；
- stream termination完整；
- tool-call response 与 final response 不被错误合并。

### Correction policy

默认行为是 clear failure，不预建通用 retry framework。只有同一 provider strategy 在真实 DSH/API运行中重复出现同一种 pre-exposure protocol failure，且一次 correction turn 能直接满足当前 acceptance criterion 时，才加入一个针对该错误类的 bounded correction：

```text
invalid provider output
  -> one exact correction prompt naming schema violations
  -> validate once more
  -> success or terminal protocol error
```

Correction 只能发生在 tool call/structured final 尚未暴露给 caller 之前。已经返回给外部 Harness 的 call、已经执行的 tool result、可能已提交的 provider mutation 与 ambiguous provider outcome不得内部重放。每个 admitted correction mechanism 必须在 roadmap lifecycle note 中记录触发它的真实重复失败。

Lifecycle note（2026-08-15）：同一 DeepSeek prompt-emulated strategy 在两个真实 continuation run 中，都返回了 markers、nonce 与 `kind: final` 正确、但把 tool result 的 raw JSON 双引号未转义地复制进 `final.content` 的无效 strict JSON；第二次发生在明确加强 JSON escaping prompt 后。两次都在任何 response 暴露前以 `provider_output_protocol_error` 终止，直接阻塞 TC-002，因此只为安全 framing 已通过、protocol/nonce/`kind: final` prefix 顺序精确匹配、且 strict JSON 因 final string escaping 失败的同类输出，准入一次 same-provider/same-strategy bounded correction。Correction 只请求同一 final outcome，携带本轮 protocol/nonce、validation error 与受大小限制的 invalid output，校验一次后成功或终止；framing、correlation、duplicate-key、tool-call、arguments/schema、valid-envelope shape、transport error、ambiguous submission、已暴露 call 与 tool execution 均不重试。

## 本机 DSH Interoperability 与真实 SWE Task 证据

### 固定真实边界

本 roadmap 的 external Harness acceptance target 是本机 checkout：

| Item | Planning baseline | Run rule |
| --- | --- | --- |
| DSH checkout | `/Users/jazelly/Desktop/github/deepseek-harness` | 不复制、不 fork、不修改 DSH source；只允许 profile/provider 配置 |
| 当前 observed revision | `47f943859bef60e4160492346772ded9b24f765a` on `master`，planning 时 clean | 每次 evidence run 重新记录 exact HEAD 与 dirty state；revision 变化视为新的 interop run |
| DSH runtime | repository build、`dsh --profile headless` 与 checked-in Python SDK `jsonrpc-agent/minimal.py` | 使用 built artifacts；不以手写 HTTP client冒充 DSH |
| Tokenless boundary | packaged CLI/daemon、`apiProxy.endpoints.openaiDefault`、`GET /v1/models` 返回的 exact model id | 不硬编码 daemon URL、model list 或 bearer value；credential只在本机 process memory/受限配置中使用且不进入 evidence |
| Provider boundary | selected real visible-browser 或 explicit direct-protocol route | 不使用 provider fixture、response interception、synthetic SSE 或本地 provider replica |

DSH 的两个现成 surface承担不同证据：

- `headless` profile证明普通用户配置一个 `openai-completions` custom provider 后，标准 DSH Tool Registry、stream assembler 与 Agent Loop无需 Tokenless-specific adapter 即可工作。
- checked-in Python SDK minimal composition以固定的 persistent `bash` 和 `str_replace_editor` tool surface运行 benchmark task，并用 uncompressed session JSONL 提供可审计的 `tool/call`、`tool/result`、assistant message 与 request header。

“unmodified DSH”表示不改 DSH source或为 Tokenless加入 parser special case；配置 base URL、credential reference、provider/model和隔离 workspace属于正常 OpenAI-compatible client setup。

Lifecycle note（2026-08-15）：固定 revision 的 unmodified DSH 已通过 packaged daemon 与真实 DeepSeek browser route 完成两个连续 single-call streaming tool turn 和 grounded final answer；[脱敏证据](../evidence/dsh-streaming-tool-loop-2026-08-15.md)记录 session identity、JSONL digest、stable call ids、terminal finish reasons 与 job state。首次运行在 provider submission 前暴露非契约性的 1,024 字符 tool-description 上限；删除该重复限制并继续依赖现有 1 MiB compiled-prompt bound 后，真实运行通过。

Lifecycle note（2026-08-15）：packaged daemon 与真实 DeepSeek browser route 已分别证明 single-call `tool_choice` 的 `none`、`required` 与 exact named function，以及递归 closed `strict: true` object schema 的 schema-valid arguments；[脱敏证据](../evidence/openai-tool-choice-strict-deepseek-2026-08-15.md)记录 public finish reason、call count/name、validation outcome 与 job id。Choice/schema violation 在 public parser boundary fail closed，且 valid-but-choice-violating output 不进入已有 bounded final correction。该 milestone 完成时，multiple calls 与 `parallel_tool_calls: true` 尚未实现或公开。

Lifecycle note（2026-08-15）：固定 revision 的 unmodified DSH 已通过 packaged daemon 与真实 DeepSeek browser route，在一个 assistant turn 内从终态 SSE 的稳定 `index: 0/1` 重建两个调用、执行两个真实 local `read`、回传一对一结果并获得 grounded final；另一次真实非流式 API case 保留了与两个调用同时返回的 assistant content。[脱敏证据](../evidence/openai-multiple-tool-calls-deepseek-2026-08-15.md)记录 DSH revision/build/session JSONL digest、event counts、public call ids、job ids 与 protocol counters。该 slice 未加入 tool execution、scheduler、retry framework 或旧 envelope compatibility branch。

Lifecycle note（2026-08-15）：packaged daemon 与真实 DeepSeek browser route 已证明 non-stream `json_object`、终态 SSE nested `json_schema`，以及 tool call → caller 实际读取 local `package.json` → 携带同一 `response_format` 的 schema-valid structured final continuation；[脱敏证据](../evidence/openai-structured-output-deepseek-2026-08-15.md)只记录 job id、SSE/validation outcome 与选定解析值。四次 acceptance request 恰好产生四个成功 provider job；该 acceptance run 没有 invalid inner JSON 或 correction，因此没有加入新的 correction path。M5 subset 明确拒绝 `$defs`/`$ref`，避免为递归 closed-object admission 引入 resolver。

Lifecycle note（2026-08-15）：fresh review 发现 JS number rounding 可让原始 unsafe integer text 与 AJV 看见的舍入值不一致，因此 structured inner JSON 现只接受 canonical finite number spelling，且 integral schema/output value 必须是 safe integer；ordinary tool JSON behavior 未扩张。独立真实 DeepSeek diagnostic 按要求输出 numeric literal `9007199254740993`，provider job `2aa7a48c-dd56-4746-aac1-d28ecd4ff850` 成功，但 public boundary 明确返回 `provider_output_protocol_error`；该 request 只创建一个 job，没有 correction。

### Evidence lane A：Tokenless repository grounding

先在 Tokenless repository 的 disposable worktree 或明确 read-only run中提出一个只有读取本地 source 才能正确回答的问题，例如定位 API proxy 当前如何拒绝 `tools`、列出 request normalization 到 provider dispatch 的实际 call path，并引用真实 file/symbol。成功必须同时满足：

- prompt不附带答案、source excerpt或预生成 repository summary；
- DSH 至少完成一次 discovery/search 和一次 targeted read，随后根据 tool result继续；
- final answer中的 file、symbol 与行为能直接在该 exact checkout核验；
- read-only case没有 repository diff；
- DSH session log 与 Tokenless trace 中 public call id、tool name、arguments、result和下一轮 history能一一对应。

这条 lane证明 model通过 DSH tools获得本地事实，而不是只会输出合法 JSON。

### Evidence lane B：当前 SWE-rebench task cohort

DSH 长链能力使用 [SWE-rebench v2](https://arxiv.org/abs/2602.23866) 的当前公开可执行数据面；目前可从 [Harbor `swe-rebench/swe-rebench-leaderboard`](https://hub.harborframework.com/datasets/swe-rebench/swe-rebench-leaderboard/latest) 获得持续更新、带预构建 image 的真实 GitHub issue/PR task。`latest` 是发现入口，不是可重复版本：开始 acceptance run 时必须解析并冻结 immutable dataset/artifact revision、container digest、monthly split 与 instance ids，整轮不得漂移。

首轮只选三个可在目标机器运行的 task，目标是观察 tool protocol而非建立第二个 leaderboard：

1. 从冻结 snapshot 中按预先记录的确定性规则选择三个不同 repository 的 task，不按已知答案或预计成功率挑题；
2. 原样交付 upstream issue/task instruction，不复制 gold patch、future commit或 hidden tests进 model context；
3. 每题 fresh DSH session、fresh disposable checkout/container、同一 Tokenless/provider/model/limits，单次 attempt且无 agent-level automatic retry；
4. 每题都必须真实使用 repository search/read、至少一次 edit、bash/test，并出现 call → result → later call 的 sequential chain；
5. 使用上游 execution-based evaluator判定 patch，并把 protocol failure、agent failure、tool failure、test failure与 pass分开；
6. 记录每题 exact task id、dataset revision、image digest、DSH/Tokenless commits、provider/model、execution mode、turn/tool counts和官方 verdict。

这三题的 pass rate不得称为 SWE-rebench score，也不得与官方 leaderboard混排。Tokenless 自有 agent runtime 的唯一正式 full benchmark仍由 [FeatureBench roadmap](P0-featurebench-agent-runtime-evaluation.md) 拥有；这里的 cohort只回答“真实 DSH 能否通过 Tokenless 的通用 API 在长链 SWE 工作中可靠调用本地工具”。

### 需要保存的非敏感 evidence

每个 DSH run至少关联以下证据，不新增通用 telemetry、queue或result database：

- exact revisions、configuration fingerprint和任务 identity；
- DSH session JSONL中的 request header、assistant tool-call blocks、`tool/call`、`tool/result` 与 final message；
- Tokenless boundary上的 canonical call id、provider-local id映射、strategy、finish reason和validation outcome；
- repository before/after diff、执行过的真实 test command与官方 evaluator verdict；
- 一份按 task汇总的 observed protocol counters：总 model turns、calls、schema-invalid calls、undeclared names、unmatched ids、truncated streams、premature finals和terminal protocol errors。

Evidence不得保存 daemon bearer token、provider credential/cookie、hidden reasoning、full DOM、screenshot或与任务无关的账号内容。Tool output只保留解释 call/result与verdict所需的 bounded片段；完整 repository和官方 evaluator artifact仍由各自隔离 workspace拥有。

## Auto Mode 与跨 Provider Tool Context

### Explicit auto selection

Auto mode 必须由 caller 显式选择，例如 reserved model route `tokenless/auto` 或等价 typed option；不得把一个 exact `tokenless/<provider>` request 静默改成其他 provider。

Auto route candidates只能来自 selected profile 的 enabled providers，并在 submission 前按完整 requirements 排序：

- tool/JSON strategy compatibility；
- canonical history replay capability；
- input modalities 与 context capacity；
- authentication/readiness；
- evidence maturity 与 current health；
- rate/capacity policy；
- configured provider preference。

### Portable history rule

跨 provider continuation使用 canonical history，不使用 provider A 的 conversation URL 作为 provider B 的上下文：

```text
provider A assistant tool_call(call_1)
external Harness tool result(call_1)
canonical closed call/result pair
  -> serialize into provider B dialect
  -> start a new provider B conversation
  -> continue the same logical API conversation
```

Adapter 可以把 canonical call id 转为 provider-local wire-safe id，但同一 outgoing request 内 assistant call 与 tool result 必须引用同一映射；public boundary 始终保留 canonical id。

以下状态禁止自动切 provider：

- provider submission 已发生但 outcome ambiguous；
- assistant tool calls 缺少 required tool results；
- exact native conversation/Project mutation 是请求语义的一部分；
- history 包含 target provider 无法无损表示的 required content；
- caller 只提供 provider-specific opaque continuation id，Tokenless 无法重建 canonical history；
- target context window 无法容纳完整 canonical request。

Tokenless 不为切换静默压缩、截断或总结 tool history。Target provider 不够大时从 candidate set 排除并返回可解释 route failure。未来若加入 canonical compaction，必须由 Context Delivery roadmap 单独定义 provenance、active revision 与 caller-visible information loss。

### Fallback timing

Auto fallback沿用现有 invariant：只有 provider mutation 前的 classified blocker 才能换 candidate，并从同一 canonical request 重新开始。Provider 已提交后的 failure不在另一 provider 重放。一个成功 model turn 完成后，下一次 caller request 可以重新运行 auto selection；默认保持 provider affinity，在 readiness/capability变化或 caller policy要求时才选择另一 compatible provider。

## Delivery Phases

### Phase 0: Provider Reference、Canonical Contract and Capability Claims

- 固定首个 DSH run 所需的 OpenAI/DeepSeek-shaped tool contract 和 selected Tokenless provider strategy；其他 provider mapping 按各 route 首次实现/advertise 时增量完成，不阻塞第一条真实链路。
- 对 selected route 记录官方 contract revision；若它准备声明 `native_*`，运行 exact endpoint/model 最小 live probe，否则明确为 prompt-emulated。
- 对照 vLLM 的 template/parser 与 constrained structured-output 边界，先明确 selected prompt-emulated route 在哪些位置只能 validate-or-error，不能声称 native constrained decoding。
- 定义最小 canonical message、tool call、tool result 与 structured-output types。
- 定义 modern Chat Completions request/response/SSE invariants和 supported JSON Schema subset。
- 为 selected provider strategy 与 history replay 增加 capability claim；其他未验证 route 保持 `unsupported/unverified`。
- 更新 OpenAPI 和英文/简体中文 API integration contract，明确 valid-or-error guarantee。

Exit: 首个 DSH request 可确定性推导 requirements；selected route 能在 submission 前回答 native 或 prompt-emulated 并有对应证据；其他 route 不会被误标为 supported。随后立即进入 Phase 1 真实 run。

### Phase 1: First Real DSH Tool Loop and Repository Grounding

- API proxy 接受 function `tools`，不再将其归入通用 unsupported field 列表。
- Normalized history 支持 assistant `tool_calls`、`role: tool`、`tool_call_id` 与 tool-only `content: null | ""`。
- 实现最小 API-specific prompt envelope、strict parser、per-request tool-name validation与 Tokenless-owned call id。
- Non-stream 与 terminal SSE 都能返回一个完整 tool call；SSE 使用 stable `index = 0`、`finish_reason: tool_calls` 与 `[DONE]`。
- 固定并构建本机 DSH revision，配置正常 custom `openai-completions` provider 指向 packaged Tokenless daemon；不修改 DSH source 或 parser。
- 通过真实 provider 网站、built DSH、实际 `read/search`、实际 `tool/result` 与第二次 provider request 返回 final answer。
- 完成 Evidence lane A：让 DSH 从 Tokenless checkout 读取并解释一个无法靠 prompt 本身回答的真实 implementation fact，验证引用且保持 repository 无 diff。

Exit: DSH session evidence 包含真实 `tool/call`、真实 `tool/result` 与 grounded final assistant text；DSH source 未修改，Tokenless 没有执行 DSH tool，也没有 provider fixture 或 simulated response。

### Phase 2: Complete Modern Chat Completions Tool Contract

- 支持 omitted/`auto`、`none`、`required` 与 named-function `tool_choice`。
- 支持 multiple tool calls、stable indexes、`parallel_tool_calls` transport semantics与 mixed assistant text/tool calls。
- 支持 strict tool schemas、invalid schema rejection、argument truncation detection与 provider-native undeclared-call rejection。
- 支持完整 assistant/tool history replay、tool error content与连续多轮 tool calls。
- Non-stream 与 SSE 对同一 canonical result保持语义等价；terminal browser chunk允许携带完整 arguments，不伪装 token-level latency。
- 用真实 DSH cases 覆盖 single、sequential 与 multiple calls；只有 external Harness 决定是否并行执行。

Exit: modern function-tool Chat Completions contract 全部通过 public daemon boundary 和至少一个真实 external Harness。

### Phase 3: Real DSH SWE-rebench Capability Cohort

- 在 run start 解析 SWE-rebench/Harbor `latest` 为 immutable dataset revision、monthly split、image digests 和三个确定选择的 instance ids。
- 使用 checked-in DSH Python SDK minimal composition，通过 Tokenless universal API 和一个真实 provider 逐题运行原始 task instruction。
- 每题使用 fresh isolated workspace/session、单次 attempt 和相同 limits；不修改 DSH、不提示 gold patch、不执行 automatic agent retry。
- 检查 search/read/edit/bash/test 的连续 call/result history、arguments schema、call ids、finish reasons 和 tool-result grounding。
- 用上游 evaluator 判定真实 diff，并发布 protocol outcome 与 task verdict 分离的三题 evidence report。
- 若任何题暴露可复现的 protocol 缺陷，修复该缺陷并重新从 fresh session 运行该题；原失败记录保留，修复重跑不伪装成同一次 attempt。

Exit: 三个冻结的真实 SWE task 都有完整 DSH/Tokenless/tool/repository/evaluator 证据，且每题都走完要求的 search/read/edit/bash/test sequential tool path。Official evaluator 可以判 fail，但缺少 required tool path 的 attempt 不能关闭此 phase。三题结果明确标为 interoperability cohort，不称为 benchmark score。

### Phase 4: JSON Object and JSON Schema Guarantees

- 支持 `response_format: json_object` 与 accepted `json_schema`/`strict` shape。
- Prompt-emulated provider使用 final envelope；native provider结果仍经过同一 validator。
- Tools 与 structured final可共存：中间 turn返回 calls，最终 turn content满足 response schema。
- 无效 JSON 只产生明确 protocol error；按真实重复失败证据决定是否 admitted one-shot correction。
- 验证 JSON string、number precision、duplicate keys、Unicode、nesting/size limits与 schema subset behavior。

Exit: 任何 successful structured response都能由标准 JSON parser解析并满足声明 schema；无效 provider输出不会以成功 Chat Completion泄漏。

### Phase 5: Standalone Harness Contract Convergence

- 让 Web Agent Harness 与 API adapter共享最低层 canonical blocks、strict JSON/framing/schema primitives。
- 保留不同 high-level envelopes：Standalone Harness继续使用 action batch/Skill/need语义，Universal API继续使用 OpenAI tool/final语义。
- 从 Standalone Harness ToolDefinition只投影 model-visible schema；API caller tools保持 ephemeral，永远不进入 internal registry。
- 同一 provider strategy在两个产品面通过真实 provider evidence，不维护两套互相漂移的 prompt tool grammar。

Exit: API 与 Standalone Harness对 tool name、arguments、framing、nonce和invalid-output的定义一致，同时 execution ownership保持隔离。

### Phase 6: Responses API Mapping

- 将 canonical calls/results映射到 Responses function call items与 outputs。
- 支持 non-stream/stream、stable `call_id`、structured final与 full-input replay。
- Full-input replay接受并验证Tokenless先前返回的required opaque/reasoning items，将它们绑定原provider/model/execution mode后原样回传；它们不进入portable canonical transcript。
- 加入最小 local response ledger 以支持 `previous_response_id`；只保存重建 canonical public items 与同 provider 必须回传的 opaque output items，实行 documented bounded retention。
- Provider-affine opaque replay state 只可在相同 provider/model/execution mode 使用；跨 provider 或 missing/expired state 明确失败，不降级成不完整 full-history replay。
- 用 current OpenAI-compatible SDK client与一个真实 Harness path验证，不把 G4F透明 passthrough当作 Tokenless contract proof。

Exit: Chat Completions 与 Responses clients观察到同一 tool/JSON语义；current official SDK 能通过 `previous_response_id` 完成一次真实 tool-result continuation，provider-affine/nonportable state 与 retention failure 显式可见。

### Phase 7: Explicit Auto Provider Routing with Portable Tool History

- 增加显式 auto route和完整 capability filtering。
- 默认保持 provider affinity；只在下一 model turn或 pre-submission classified fallback边界重新选择。
- 证明 provider A产生 call、external Harness返回 result、provider B读取完整 canonical pair并继续最终回答。
- 证明同一 structured JSON schema可在两种不同 strategies之间切换仍满足 public contract。
- 记录 public canonical ids、provider attempt history、selected strategy与route failure；不记录 provider credentials或hidden reasoning。
- 在 target history不兼容、context不足、outcome ambiguous或exact continuation必需时 fail closed。

Exit: 两个真实 provider在一个 external Harness逻辑会话中完成可审计、无 silent degradation的跨 provider tool continuation；post-submission replay仍被禁止。

## Real-Boundary Verification Matrix

| Case | Required boundary and evidence |
| --- | --- |
| Plain final text | OpenAI client → packaged daemon → real provider → valid Chat Completion |
| Single tool call | DSH → Tokenless → real provider → DSH real tool execution |
| Local repository grounding | built DSH searches/reads exact Tokenless checkout and returns source-verifiable file/symbol facts without a diff |
| Sequential calls | call → result → second call → result → final，全部经过 built API |
| Multiple calls | one assistant turn returns stable indexed calls；external Harness owns scheduling |
| `tool_choice` | auto/none/required/named each changes real provider outcome or fails clearly |
| Strict arguments | real provider produces schema-valid args；invalid output never crosses success boundary |
| JSON object/schema | real provider final output parses and validates at public boundary |
| Malformed/truncated output | natural real-provider failure or bounded diagnostic run produces protocol error，不使用 fixture |
| Cross-provider continuation | provider A call + real result replayed to provider B，final answer uses the result |
| Auto pre-submit fallback | one durable request switches only before provider mutation and preserves exact canonical requirements |
| Post-submit ambiguity | no second provider receives replay；caller gets explicit terminal/ambiguous failure |
| Standalone/API parity | same real provider strategy satisfies both product surfaces without sharing execution authority |
| Real SWE task chain | frozen SWE-rebench task → DSH tools → repository diff/tests → upstream evaluator，protocol outcome 与 task verdict 分列 |
| Provider-native reference | official contract + redacted live endpoint probe → canonical mapping；docs-only route 不得标记 verified native |

Local daemon、OpenAPI、filesystem与message validation可通过各自真实 local boundaries验证。Provider tool/JSON behavior不得使用 DOM fixture、response fixture、provider replica、interception或 synthetic provider response。Real provider E2E使用 repository-configured persistent profile、built CLI/packaged daemon与真实 network，并遵守现有 Keychain和profile-preservation policy。

## Acceptance Criteria

- DSH 可作为 unmodified OpenAI-compatible Harness使用 Tokenless完成真实 tool loop。
- 本机 pinned DSH checkout 可通过 packaged Tokenless 对真实 repository 完成 grounded read/search，并在三个冻结的 SWE-rebench tasks 中留下完整 long-horizon tool traces 与 upstream evaluator verdict。
- DSH interoperability cohort 不修改 DSH source、不使用玩具 prompt、不复制 gold patch，也不把三题结果宣传为 benchmark score。
- Modern Chat Completions function tools、`tool_choice`、multiple calls、history、non-stream和SSE contract完整实现并文档化。
- `json_object` 与 supported `json_schema`只返回 valid output或明确 error。
- 每个 provider route声明 native、prompt-emulated或unsupported strategy，并有 mode-specific真实证据。
- OpenAI、Anthropic、Gemini、DeepSeek 的当前官方 tool contracts 都有 canonical conformance mapping；每个 advertised native route 另有 exact endpoint/model live evidence。
- Universal API永不执行 caller-owned tools；Standalone Harness仍完整拥有自己的 tools和loop。
- Canonical history无损保留 assistant tool calls与tool results，public call ids跨provider稳定。
- Explicit auto mode只选择满足完整 requirement set的provider，不 silent downgrade，不 post-submission replay。
- Provider switch使用full canonical replay和new provider conversation；provider-local URL/opaque state不被冒充portable context。
- Target context不足时route fail closed，不静默截断tool history。
- OpenAPI、英文/简体中文integration docs、capability matrix与error catalog同步。
- User-visible CLI/API behavior包含changeset；不手动publish package或artifact。
- 所有provider claims均由real-boundary tests证明，不使用mock、fake、stub或provider fixture。

## Risks and Responses

| Risk | Response |
| --- | --- |
| 网页模型输出看似JSON但混入prose或重复marker | exactly-one framing、strict parser、nonce与valid-or-error public boundary |
| Prompt injection诱导未声明tool | per-request catalog membership、tool choice validation与outer Harness再次授权 |
| Native provider返回非strict arguments | Tokenless boundary schema validation；不能保证的model/route标记unsupported |
| Internal Harness与public API形成两套grammar | 只共享两个真实consumer都需要的low-level primitives，保留不同high-level ownership |
| Provider A history在provider B语义丢失 | canonical blocks、capability-filtered replay；任何required loss阻止routing |
| Auto mode重放已经提交的任务 | 复用provider-submission invariant；post-submission永不fallback |
| Context window差异导致silent truncation | request-size/capacity preflight并排除不兼容candidate |
| Correction变成通用retry platform | 只有真实重复的pre-exposure格式失败允许一个error-specific correction |
| “OpenAI-compatible”被误解为所有历史/内置surface | 发布精确compatibility profile；deprecated和hosted tools单独声明 |
| Provider drift破坏prompt envelope | real-provider release gate；失败即关闭该strategy claim，不用fixture补证据 |
| 本机 DSH 更新导致 compatibility 结论漂移 | 每轮固定并报告 DSH HEAD、dirty state与build artifacts；新 revision单独运行，不覆盖旧 evidence |
| `latest` benchmark tag移动导致结果不可复算 | run start解析并冻结 dataset revision、split、instance ids与image digests；报告不引用floating tag作为版本 |
| 把 SWE task失败误判成tool protocol失败 | protocol validation、Harness execution、agent behavior、tests与official verdict分层归因 |
| 闭源provider内部实现不可检查 | 只声明可观察wire contract；用official docs/SDK + live probe验证，另以vLLM作为公开server-side parser/constrained-decoding参考 |

## Non-Goals

- 在Universal API中执行external Harness的tools
- 为tool calling建立第二套queue、scheduler、approval或MCP host
- 让provider-native Agent、search、computer use或connectors伪装成caller function tools
- 为auto mode自动登录、切profile、扩大enabled provider set或使用未授权auth source
- 在provider已提交后自动重试到另一provider
- 静默总结、裁剪或改写tool history以适配更小context window
- 将所有deprecated OpenAI字段、provider-specific extras或unknown JSON Schema keywords宣称为支持
- 使用provider fixture、模拟response或本地replica证明structured behavior
- 为 DSH interoperability cohort fork、patch或加入Tokenless-specific DSH adapter
- 把三题 SWE-rebench cohort扩成第二套正式benchmark、leaderboard或批量调度系统；正式full评测继续由FeatureBench roadmap拥有
- 声称已经检查OpenAI、Anthropic、Google或DeepSeek未公开的server source、sampling implementation或hidden reasoning

## Completion Definition

本 roadmap 只有在 Phases 0–7 的 acceptance criteria 全部关闭后才可 archived as completed。Phase 1 的单工具 DSH 闭环只是第一条真实产品结果；它不能单独支持“完整 OpenAI tool calling”“真实 DSH SWE compatibility”“structured output guarantee”或“portable auto provider context”的发布声明。
