# Provider Tool-Calling Conformance 参考

这是 Tokenless Universal API 使用的精简 provider-side 参考。它记录当前官方 contract、最小 canonical mapping 与 Tokenless capability claim 的证据边界；它不表示浏览器里的 provider 页面暴露了自己的 API endpoint。

版本上下文：截至 2026-08-15，核对了下方链接的当前官方文档与官方 SDK type/source reference。文档是外部 normative evidence；SDK 链接用于佐证公开 type 名称与 serialization。本文不假定或声称看过 proprietary server implementation。

## Contract 速览

| Provider | Model-side tool shape | Tool-result/history shape | Streaming identity | Schema/tool-choice 保证 |
| --- | --- | --- | --- | --- |
| OpenAI Responses / Chat Completions | Responses 返回带 `id`、`call_id`、`name` 与 JSON-encoded `arguments` 的 `function_call` output item；Chat Completions 使用 assistant `tool_calls`。 | Responses 接收以 `call_id` 关联的 `function_call_output` input item；caller 追加之前返回的 output items 后继续。 | `response.output_item.added` 标识 output item；arguments fragments 使用 `response_id`、`item_id`、`output_index`；由 `...arguments.done` 与 `response.output_item.done` 收尾。 | `strict: true` 约束 function arguments；`tool_choice` 支持 auto/required/named/none（Responses 还支持 allowed tools）；`parallel_tool_calls: false` 将本轮限制为 0 或 1 个调用。 |
| Anthropic Messages | assistant `content` 中包含有序 `tool_use` blocks（`id`、`name`、`input`），并以 `stop_reason: tool_use` 结束。 | caller 发送一个后续 `user` message，包含每个 client call 一个 `tool_result`，以 `tool_use_id` 关联；结果必须在该 message 的 text 之前，可带 `is_error`。 | SSE 依次使用 `content_block_start`、`content_block_delta`、`content_block_stop`、带 `stop_reason: tool_use` 的 `message_delta`，再以 `message_stop` 结束。Tool input fragment 位于 `delta.partial_json`，此时 `delta.type` 为 `input_json_delta`。 | `strict: true` 通过 grammar-constrained sampling 生成 schema-valid input。默认可有多个 blocks；`disable_parallel_tool_use` 位于 `tool_choice` 内。 |
| Gemini Interactions / Generate Content | 当前 Interactions 文档使用 `function_call` steps（`id`、`name`、`arguments`）；Generate Content dialect 使用 `functionCall`/`functionResponse` parts。 | Interactions 使用带 `call_id` 的 `function_result`，通常配合 `previous_interaction_id`；stateless caller 重放原始 user input、全部 model steps 与 result。Generate Content 重放 model parts 与 function responses。 | Interactions 通过 typed `step.delta` events stream；Generate Content 通过 candidates/parts stream，thinking model 可能在 function-call part 附加 `thoughtSignature`。 | Interactions 的 `tool_choice` 支持 `auto`、`any`、`none`、`validated` 与 allowed-tool 限制。结构化 final 使用 JSON MIME type 与 schema 的 `response_format`。 |
| DeepSeek Chat Completions | OpenAI-shaped assistant `tool_calls`；function `arguments` 是 JSON string，API 可以返回 `finish_reason: tool_calls`。 | caller 追加 assistant message 与通过 `tool_call_id` 关联的 `role: tool` messages。 | OpenAI-shaped SSE chunks 以 `data: [DONE]` 结束；partial deltas 必须在验证前组装。 | `tool_choice` 支持 none/auto/required/named。`strict` 是 Beta 功能，需要 Beta base URL；非 strict 时 Tokenless 仍会在暴露 call 前 parse 并验证返回的 arguments。 |
| vLLM OpenAI-compatible server | server 通过选定的 tool parser 与 chat template，将 model-specific output 转换为 OpenAI shape。 | chat template 必须渲染 `tool` messages 与包含历史 calls 的 assistant messages；这依赖具体 model/template。 | OpenAI-compatible response 由 parser 的 model-specific extraction 组装。 | Auto choice 需要 `--enable-auto-tool-choice`、parser 与兼容 chat template。Named/required 使用 structured outputs；auto 只有在 tool 设置 `strict: true` 时才有 schema-constrained arguments。 |

同一个 “tool call” 名称实际覆盖不同 wire contract。因此 Tokenless canonical history 只保存 public call identity、tool name、原始 argument JSON、result pairing 与顺序；每个 provider adapter 自己拥有 item/block/part id 与 opaque continuation state。

## Provider 细节与实现影响

### OpenAI

官方 function-calling guide 把三类对象分开：应用提供的 tool definition、模型生成的 call，以及 caller 产生的 result。Responses 返回一个或多个 `function_call` output items；结果是通过 `call_id` 关联的 `function_call_output` item。官方 streaming 示例使用 `response.output_item.added`、以 `item_id`/`output_index` 关联的 argument deltas，以及最终的 `response.output_item.done`。

`strict: true` 不只是事后 validator：文档称它保证 schema adherence，并要求 `additionalProperties: false` 与所有 property 都列入 `required`；可选值用 nullable 表示。Responses 在未写 strict 时可能尝试标准化，Chat Completions 默认仍是 non-strict，因此 Tokenless 必须保留 caller 显式 strictness，而不是猜测 provider default。

Responses 的官方 SDK generated types 分别暴露 `ResponseFunctionToolCall`、`ResponseFunctionCallArgumentsDeltaEvent`、`ResponseFunctionCallArgumentsDoneEvent`、`ResponseOutputItemAddedEvent` 与 `ResponseOutputItemDoneEvent`。`id` 与 `call_id` 的分离是重要的 provider-side precedent：Tokenless 不应把 response-item identity 和 caller-visible call ID 合并。

来源：[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[官方 openai-node Responses types](https://github.com/openai/openai-node/blob/main/src/resources/responses/api.md)。

### Anthropic

Anthropic 把 tool use 放进 message content block array，而不是引入 OpenAI 风格的 `tool` role。assistant response 可以包含 text 与一个或多个 `tool_use` blocks；caller 执行 client tools，并发送一个紧邻的后续 user message，其中所有匹配的 `tool_result` blocks 必须排在 text 之前。每个 result 以 `tool_use_id` 配对；`is_error: true` 是报告 client call 失败或跳过的公开方式。

Streaming 是 block-oriented：开始 block、追加 `content_block_delta` events，其中 `delta.type` 为 `input_json_delta`、fragment 位于 `delta.partial_json`，然后结束 block，再读取 message-level `stop_reason`。并行执行顺序由 caller 决定，但 assistant block group 中每个 call 仍需要在下一条 user message 中得到一个 result。`strict: true` 对声明的 JSON Schema subset 使用 grammar-constrained sampling；它不会把 execution authority 转移给模型。

来源：[Anthropic handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)、[Anthropic streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)、[Anthropic strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)、[官方 Anthropic SDK type index](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/api.md)。

### Gemini

Google 当前同时记录 Interactions surface 与 Generate Content surface。它们不是可以互换的 spelling：Interactions 使用 `function_call`/`function_result` steps 与 `previous_interaction_id`；Generate Content 使用 `contents` 里的 `functionCall`/`functionResponse` parts。Portability layer 必须为每个 request 选择一个 dialect，不能把 Interactions step 当作 Generate Content part 序列化。

Provider 支持 `auto`、`any`、`none`、`validated` tool-choice modes、allowed-tool 限制、parallel function calls 与 compositional multi-step calls。Structured final 是另一份 contract：JSON MIME type 加 schema。Gemini 文档仍要求应用在 syntactically valid JSON 之后继续验证语义值。

Thinking model 通过不同 dialect-specific shape 携带 provider-local state。Generate Content 的 Gemini 3 function calling 必须把返回的 `thoughtSignature` 原样放回对应的原始 part；官方文档警告缺失会得到 400。Stateless Interactions 则精确重放相关 model-generated steps，包括 thought 与 function-call steps；它不是同一套 signature-bearing part model。这些 signature、parts 与 steps 只能放入同 provider 的 opaque replay collection，不能进入 portable cross-provider canonical history。

来源：[Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)、[Generate Content function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling)、[Generate Content thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)、[Interactions thinking](https://ai.google.dev/gemini-api/docs/thinking)、[Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)、[官方 Google Gen AI JavaScript SDK](https://github.com/googleapis/js-genai)。

### DeepSeek

DeepSeek 的 Chat Completions contract 刻意采用 OpenAI shape：`tools` 当前包含 function tools，`tool_choice` 可选 none/auto/required/named，assistant call 带 id 与 JSON-string arguments，下一次 request 使用 `role: tool` 与 `tool_call_id`。API reference 记录 `finish_reason: tool_calls`、`data: [DONE]` stream termination 与最多 128 个 functions。

无论 provider 是否启用 strict，Tokenless 都会在暴露 call 前 parse 并验证返回的 JSON arguments。DeepSeek strict mode 是 Beta，需要 Beta base URL 与每个 function 的 `strict: true`，server 会校验提交的 schema；这属于 provider contract，不能成为跳过 Tokenless boundary validation 的理由。

来源：[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)、[DeepSeek Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/)。

### vLLM：公开的 server-side 参考

vLLM 是开源 serving implementation，而不是 proprietary provider 的证据。其当前文档清楚拆出了 server-side layers：auto tool choice 需要 enable flag、model-specific parser 与兼容 chat template；template 负责 tool definitions、`tool` messages 与历史 calls 的 assistant messages。Named/required calls 使用 structured-output backend；auto 未启用 strict 时可能从 unconstrained text 中提取 calls。

这是 Tokenless 最接近的公开实现参考：request compiler/chat template、model-dialect parser、constrained generation、stream assembler、canonical validator、public serializer 必须分层。能识别 marker 的 parser 只是其中一层，不能单独证明 OpenAI-compatible endpoint guarantee。

来源：[vLLM Tool Calling](https://docs.vllm.ai/en/stable/features/tool_calling/)、[vLLM tool-call parser plugin reference](https://docs.vllm.ai/en/stable/features/tool_calling/#how-to-write-a-tool-parser-plugin)。

## Tokenless capability 边界

当前真实 provider rate sample 单独记录在 [Structured-Control Observed Rate](evidence/openai-structured-control-rate-2026-08-15.md)。其中比率只适用于所记录的固定请求、账号、persistent profile与时间窗口；它不会把 prompt-emulated route升级为 native tool calling，也不构成 SLA。

| Claim | 当前状态 |
| --- | --- |
| Universal API 执行 caller tools | 永不执行。Caller 自己执行，并在下一次 request 发送 result。 |
| Browser provider pages 暴露 native OpenAI/Anthropic tool control | 不作声明。当前 browser routes 使用 `prompt_json_envelope`，由 Tokenless 验证整个 result。 |
| DeepSeek 与 ChatGPT browser routes | 当前 structured-control paths 有真实 prompt-emulated evidence；见 [auto-routing evidence](evidence/openai-auto-provider-routing-2026-08-15.md)。 |
| Gemini browser prompt tool route | 不公开：真实 diagnostic 在 JSON 前输出 prose，未通过 strict public boundary；见 [prompt-framing evidence](evidence/openai-tool-prompt-framing-2026-08-15.md)。 |
| Native provider route | 除官方 contract 外，还需要 exact endpoint/model live probe。仅文档不能把 Tokenless route 提升为 `native_*`。 |

对于 auto routing，candidate 必须满足完整 request requirement set：tool choice、strict arguments、multiple-call semantics、history replay 与 structured final output。Provider public documentation 可以定义 capability，但只有脱敏的 exact live probe 才能让该 capability 进入 Tokenless routing。

## 可复用 checklist

在公开一个 provider route 之前记录：

- exact provider dialect 与 model；
- declaration、choice、call identity、result pairing 与 stream event shape；
- arguments 与 final-output guarantee 是 native、prompt-emulated，还是仅 validator 保证；
- full-history 与 same-provider opaque replay 要求；
- 脱敏的 exact endpoint/model live probe 与 evidence revision；
- malformed、truncated、unknown、mismatched call 的 failure boundary。

这份 checklist 有意保持很小，避免把 provider contract、Tokenless browser strategy 与 caller-owned Tool Registry 混为一谈。
