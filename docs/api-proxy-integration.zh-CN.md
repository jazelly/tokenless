# Tokenless API Proxy 接入指南

如何从既有项目调用 Tokenless 本地 API proxy。面向已经写好 OpenAI 或 Anthropic 形态代码、希望把这部分流量改由可见 provider 网站承担而非付费 API 的实现者。

## 这是什么

Tokenless daemon 暴露了 OpenAI 与 Anthropic 兼容的 HTTP 路由。一个请求会变成 durable job，由 Playwright worker 在已登录的浏览器 profile 中把 prompt 输入真实 provider 页面，再把可见回复按你客户端已经预期的 wire shape 返回。

**这是任务级桥接，不是 API 的即插即用替代品。** 在围绕它做设计之前，请先读 [硬性限制](#硬性限制)。此方案是用吞吐、延迟和增量 streaming 换成本。

## 前置条件

以下三件事必须成立，任何请求才会成功。它们都无法由 proxy 自己建立。

1. **daemon 正在运行。** 任何 `tokenless` 命令都会按需启动它；`tokenless dashboard --no-open --json` 是显式做法。daemon 未启动时得到的是 connection refused，不是 HTTP 错误。
2. **proxy 已开启。** 默认关闭。
   ```bash
   tokenless api-proxy enable --conversation-mode new-conversation --json
   ```
3. **managed profile 已登录目标 provider。** 先运行 `tokenless setup`，再在可见浏览器窗口里完成登录。否则请求会因 provider 登录 blocker 而失败。

一次性确认这三项：

```bash
tokenless api-proxy status --json
```

## Base URL

默认 `http://127.0.0.1:7331`。仅监听 loopback，绝不绑定公网接口。

不要硬编码。请从 `tokenless api-proxy status --json` 读取 `apiProxy.endpoints`（键为 `openai`、`openaiDefault`、`anthropic`），它已经考虑了配置中自定义的 `daemonUrl`。

| 客户端形态 | Base URL |
| --- | --- |
| OpenAI 兼容 | `http://127.0.0.1:7331/v1/openai` |
| OpenAI 兼容，默认路径 | `http://127.0.0.1:7331/v1` |
| Anthropic 兼容 | `http://127.0.0.1:7331/v1/anthropic` |

裸 `/v1` base 的存在，是为了让使用 `/v1/chat/completions` 或 `/v1/responses` 的客户端无需改动即可工作。它们只是 alias：dialect 与行为完全一致。Anthropic 没有裸 alias，因为两种 dialect 会在同一路径上冲突。

## 认证

把 daemon control token 作为 bearer token 发送。标准 SDK 在你设置 API key 后就已经这么做了。

```
Authorization: Bearer <token>
```

Token 位于 `<TOKENLESS_HOME>/daemon.token`，默认 `~/.tokenless/daemon.token`，权限 `0600`。请去掉尾部空白。

请把它当作本地凭据：它授权的是全部 daemon control 路由，不只是 proxy。不要记录到日志、不要提交进版本库、不要发往 loopback 之外的任何地方。

| 情况 | 状态码 | Code |
| --- | --- | --- |
| 没有 `Authorization` header | 401 | `control_auth_missing` |
| token 错误 | 403 | `control_auth_rejected` |

## 端点

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/openai/chat/completions` | OpenAI chat completion |
| POST | `/v1/chat/completions` | 上一条的 alias |
| POST | `/v1/openai/responses` | OpenAI Responses |
| POST | `/v1/responses` | 上一条的 alias |
| GET | `/v1/openai/models` | 列出可用 model 名称 |
| GET | `/v1/models` | 上一条的 alias |
| POST | `/v1/anthropic/messages` | Anthropic message |

## Model 命名

`model` 是唯一能指明 provider 的位置，因此必须显式指明：

```
tokenless/<provider>
```

可用 provider 即该安装已启用的那些：`chatgpt`、`claude`、`gemini`、`grok`、`qwen`、`deepseek`、`perplexity`、`zai`、`doubao`、`kimi`、`dola`。其中只有前四个是 supported，其余为 experimental，在未验证路由上会 fail closed。

请调用 `GET /v1/openai/models` 获取实时列表，不要硬编码。

像 `gpt-4o` 这样的裸 model 名会被**拒绝**，而不是重映射。这是刻意设计：静默改写到调用方没有选择的 provider，会掩盖究竟是哪个账号、哪份订阅回答了这次请求。

```jsonc
// 400
{"error":{"message":"model must be named tokenless/<provider>, for example tokenless/chatgpt","type":"invalid_request_error","param":"model","code":"invalid_request_error"}}
```

若名称格式正确但该 provider 不存在或未内置，则返回 `404` / `model_not_found`，与真实 API 遇到未知 model 的行为一致。

## 请求体

### OpenAI

```json
{
  "model": "tokenless/chatgpt",
  "messages": [
    {"role": "system", "content": "Answer in one sentence."},
    {"role": "user", "content": "What is 2+2?"}
  ]
}
```

支持的 role：`system`、`user`、`assistant`、`developer`（`developer` 会归一化为 `system`）。

非流式和流式请求都支持现代 OpenAI function tools。`parallel_tool_calls` 默认为 `true`；若当前 assistant outcome 最多只能包含一个调用，则设为 `false`：

```json
{
  "model": "tokenless/chatgpt",
  "messages": [{"role": "user", "content": "Read package.json"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Read one UTF-8 file.",
      "parameters": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path"],
        "properties": {"path": {"type": "string"}}
      },
      "strict": true
    }
  }],
  "tool_choice": "auto",
  "parallel_tool_calls": false
}
```

`tool_choice` 与 `parallel_tool_calls` 的组合语义如下：

- 省略或 `"auto"`：返回最终文本或一个及以上已声明调用；`parallel_tool_calls: false` 会把调用数限制为一个。
- `"none"`：只能返回最终文本。
- `"required"`：必须返回至少一个已声明调用；`parallel_tool_calls: false` 会把调用数限制为一个。
- `{"type":"function","function":{"name":"read_file"}}`：无论 parallel 设置为何，都必须且只能返回该已声明 function 的一个调用。

使用 `strict: true` 时，parameters 根节点必须是 object。每个 object schema（包括可空的嵌套 object）都必须设置 `additionalProperties: false`，并在 `required` 中列出所有 property key；可选字段用 nullable type 表示。Tokenless 会在提交 provider 前拒绝不合规的 strict schema，并按声明 schema 校验返回 arguments。

调用方负责执行返回的 tool。下一次请求应重发同一 catalog、保持原顺序的 assistant call array，以及每个调用各一个连续的结果。当 id 能无歧义配对时，result 可以采用不同顺序：

```json
[
  {"role":"assistant","content":"I will inspect both.","tool_calls":[
    {"id":"call_read","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"package.json\"}"}},
    {"id":"call_search","type":"function","function":{"name":"search_files","arguments":"{\"path\":\"packages\"}"}}
  ]},
  {"role":"tool","tool_call_id":"call_search","content":"packages/cli"},
  {"role":"tool","tool_call_id":"call_read","content":"{\"name\":\"tokenless\"}"}
]
```

Tokenless 会在提交 provider 前校验 call id 唯一性、已声明名称、严格 arguments JSON、参数 schema，以及每个调用恰有一个 result。它不会执行调用方 tool，也不会保存 catalog。

#### 结构化最终输出

`response_format` 只约束 assistant 的最终结果。中间 outcome 仍可包含 `tool_calls`；请把这些调用、调用方实际执行所得的 tool result、同一 tool catalog 与同一 response format 一起重发，以请求结构化 final。

```json
{
  "type": "json_schema",
  "json_schema": {
    "name": "repository_result",
    "description": "A repository summary.",
    "strict": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["summary", "files"],
      "properties": {
        "summary": {"type": "string", "minLength": 1},
        "files": {"type": "array", "items": {"type": "string"}, "maxItems": 10}
      }
    }
  }
}
```

- 省略或 `{"type":"text"}` 时保持普通 final text。
- `{"type":"json_object"}` 会在 `message.content` 中返回且仅返回一个 strict JSON object。
- `json_schema` 只有在原始 JSON 文本通过 accepted schema 后才原样返回。`name` 遵循 function name 规则（1–64 个字母、数字、`_` 或 `-`）；`description` 必须是 string，`strict` 若存在则必须是 boolean。

Accepted schema 的根节点必须恰好是 `{"type":"object"}`。每个 object（包括 nullable nested object）都必须设置 `additionalProperties: false`，并在 `required` 中列出所有 property；无论 `json_schema.strict` 是 true 还是 false，这条规则都生效。

| 支持的 schema keyword | 范围 |
| --- | --- |
| `type`、`properties`、`required`、`additionalProperties` | 支持 string type 与 nullable type array；每个 object 都必须 closed |
| `items`、`minItems`、`maxItems` | Array |
| `enum`、`const`、nested `anyOf` | 根节点不接受 `anyOf` |
| `title`、`description` | Annotation |
| `minLength`、`maxLength`、`pattern`、`format` | String；`format` 必须为内置 AJV formats validator 已知格式 |
| `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf` | Number |

所有未列出的 keyword 都会在创建 job 前被拒绝。尤其是 `$defs`、`$ref`、`oneOf`、`allOf`、`not`、conditional 与 `patternProperties` 均不属于此 V1 subset。

Structured JSON number 必须为 finite，并使用 `JSON.stringify(Number(token))` 返回的唯一 spelling；整数必须位于 JavaScript safe integer range 内。当 canonical form 是 `1` 或 `1000` 时，`1.0`、`1e3` 等 noncanonical spelling 会以 `provider_output_protocol_error` 失败。Schema 中 `enum`、`const`、bound、length/item limit 与 `multipleOf` 的数值也采用相同的 finite/safe-integer admission rule，包括 `enum` 或 `const` data 内递归嵌套的 number。

### OpenAI Responses

`POST /v1/responses` 与 `/v1/openai/responses` 把当前官方 [function calling](https://developers.openai.com/api/docs/guides/function-calling) 和 [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create) shape 映射到与 Chat Completions 相同的 Tokenless validation 与 provider turn。

- `input` 接受非空 string 或最多 256 个 text item：user/system/developer/assistant message、Tokenless output `message` item、`function_call` 与 string `function_call_output`。
- Function tool 为 flat shape：`{type, name, description?, parameters, strict?}`。`tool_choice` 支持 `auto`、`none`、`required` 或 `{type:"function",name}`。
- `text.format` 支持 `text`、`json_object` 或 flat `json_schema`，schema subset 与上文相同。
- Tokenless 在 provider submission 前校验所有 declared name、strict argument、唯一 `call_id` 与完整 call/output 配对。它不会执行调用方 tool。

Non-stream output 包含 assistant `message` 或按 model 顺序排列的 `function_call` item。Function item 的 item `id` 与 stable public `call_id` 不同；调用方用 `{type:"function_call_output",call_id,output}` 回复。

Streaming 是 terminal 但 typed。它依次发出 `response.created`、`response.in_progress`、item/content event、可完整重建的 argument 或 text delta、done event 与 `response.completed`。它不发 Chat 的 `[DONE]`，不伪造 token pacing 或 usage；`usage` 为 `null`。

可采用任一种官方 continuation 形式：

1. Full-input replay：把先前 `response.output` 与 caller-owned result 追加到原 input，并重新发送同一份当前 `tools` catalog。
2. Ledger continuation：把 result 作为 `input`，传入 `previous_response_id`，并重新发送同一份当前 `tools` catalog。

Ledger 不持久化 tool definition。两种形式都会根据当前请求中的 `tools` catalog 校验 history。

本地 ledger 保留 canonical public transcript item 24 小时，最多 1,000 个 response。下次写入会清除全部过期 row；查询某个确切的过期 id 时只删除该 row，并为触发请求返回 `response_expired`。它不保存 credential、browser session、hidden reasoning，也不伪造 opaque item。因容量淘汰、未知或已删除而再次请求的 id 返回 `response_not_found`；更换 provider、exact model 或 execution mode 会在提交前返回 `response_route_mismatch`。当前 prompt-emulated route 不产生 provider opaque/reasoning item，因此 unknown reasoning 或 opaque replay 返回 `unverifiable_replay_item`。

Responses V1 明确不包括 Conversations、background、WebSocket、hosted tools、retrieve/delete、非文本 input 与 array-valued function output。

### Anthropic

```json
{
  "model": "tokenless/claude",
  "max_tokens": 1024,
  "system": "Answer in one sentence.",
  "messages": [
    {"role": "user", "content": "What is 2+2?"}
  ]
}
```

`messages` 中的 role 只支持 `user` 与 `assistant`。system prompt 放在顶层 `system` 字段，与真实 API 一致。

### Content blocks

`content` 接受字符串，或由 text part 组成的数组：

```json
{"role": "user", "content": [{"type": "text", "text": "hello"}]}
```

其他 part 类型——`image_url`、`image`、`input_audio`、`document`、`tool_result`——都会被拒绝。多个 text part 会用换行拼接。

### 字段处理

| 字段 | 行为 |
| --- | --- |
| `model`、`messages` | 必填 |
| `system`（Anthropic） | 作为 system message 生效 |
| `stream` | 文本与 function tool calls 均生效 |
| `stream_options` | 接受但忽略；不会伪造 streaming usage |
| `tools` | 支持一个或多个现代 OpenAI function calls |
| `tools[].function.strict` | Boolean；`true` 要求递归 closed object 且每个 property 都是 required |
| `tool_choice` | 省略/`auto`、`none`、`required` 或一个精确的已声明 function |
| `parallel_tool_calls` | Boolean；省略/`true` 允许当前 turn 返回多个调用，`false` 最多允许一个 |
| `response_format` | 省略/text、`json_object` 或本文记录的 `json_schema` subset |
| `functions`、`function_call` | **返回 400 拒绝** |
| `temperature`、`top_p`、`max_tokens`、`seed`、`stop` 及其他全部字段 | **静默忽略** |

旧版 function 字段仍会 fail closed。结构化最终输出只支持上文列出的精确 format 与 schema subset；不支持的 shape 绝不会被静默忽略。

被忽略的那组才是更隐蔽的坑：**采样参数完全无效。** `temperature: 0` 不会让 provider 变得确定，`max_tokens` 也不会约束回复长度。如果你的代码依赖其中任何一个，那条调用路径就不该走这个 proxy。`max_tokens` 之所以只被忽略而非拒绝，仅仅因为 Anthropic API 强制要求它。

### 大小限制

| 限制项 | 数值 |
| --- | --- |
| HTTP body | 2 MiB |
| `messages` 条数 | 256 |
| 打平后的 prompt 文本 | 1 MiB |
| Function tools | 128 |
| 单个 assistant outcome 的调用数 | 128 |
| 单个 function parameter schema | 64 KiB |
| 单个 structured final schema | 64 KiB |
| Structured JSON 嵌套 / property 数 | 48 层 / 10,000 个 property |

## 响应体

标准厂商格式，外加一个 `tokenless` 对象。

### OpenAI

```json
{
  "id": "chatcmpl-20aa1107-6cd5-4981-bfe6-853640420dd4",
  "object": "chat.completion",
  "created": 1786280000,
  "model": "tokenless/chatgpt",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "2+2 equals 4."},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
  "tokenless": {
    "provider": "chatgpt",
    "job_id": "20aa1107-6cd5-4981-bfe6-853640420dd4",
    "conversation_mode": "new-conversation",
    "citations": [{"url": "https://example.com", "title": "Example"}]
  }
}
```

通过校验的调用组按 model order 使用标准 OpenAI 形状。Tokenless 只在完整 provider output 通过校验后分配唯一 public id；随调用返回的 assistant content 会被保留：

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "I will inspect both.",
      "tool_calls": [
        {"id":"call_read","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"package.json\"}"}},
        {"id":"call_search","type":"function","function":{"name":"search_files","arguments":"{\"path\":\"packages\"}"}}
      ]
    },
    "finish_reason": "tool_calls"
  }]
}
```

### Anthropic

```json
{
  "id": "msg_20aa1107-6cd5-4981-bfe6-853640420dd4",
  "type": "message",
  "role": "assistant",
  "model": "tokenless/claude",
  "content": [{"type": "text", "text": "2+2 equals 4."}],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {"input_tokens": 0, "output_tokens": 0},
  "tokenless": {"provider": "claude", "job_id": "...", "conversation_mode": "new-conversation", "citations": []}
}
```

OpenAI 文本使用 `finish_reason: stop`；通过校验的 function call 使用 `finish_reason: tool_calls`。Anthropic `stop_reason` 仍为 `end_turn`。

### usage 恒为 0

这不是 bug，也不是留待日后填充的占位值。Tokenless 不计量 provider token——回复由你的网页版订阅承担，因此没有可上报的计数。编造一个估算值比返回 0 更糟。

如果你需要节省数据，请用 `tokenless savings status --json`，它用固定版本 tokenizer 单独计量可见输出。不要从 `usage` 推导花费。

### tokenless 对象

| 字段 | 用途 |
| --- | --- |
| `provider` | 实际回答的 provider |
| `job_id` | 持久 job id——可传给 `tokenless state --job-id <id> --json` 查看具体发生了什么 |
| `conversation_mode` | 本次请求使用的映射模式 |
| `citations` | provider 渲染出的可见来源链接（如果有） |

请记录 `job_id`。它是把客户端侧失败关联到本地持久记录的唯一句柄。

## Streaming

`stream: true` 会返回 `text/event-stream`，并按该方言的正确事件序列下发。

**但没有增量文本。** 可见 provider 回复只有渲染完成后才可读，因此整段响应会在完整延迟之后作为一个终态 chunk 一次性到达。保留事件序列是为了让本来兼容的客户端继续可用；直接拒绝 `stream` 只会白白让它们崩掉。

OpenAI 帧：

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","content":"<完整文本>"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

通过校验的 tool-call group 使用同样的终态下发方式。第一帧包含全部调用，每个调用都有稳定的 `0..n-1` index、唯一 id、name 与完整 arguments string；伴随 content 位于同一 delta。第二帧携带 `finish_reason: "tool_calls"`，随后是 `[DONE]`：

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","content":"I will inspect both.","tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"package.json\"}"}},{"index":1,"id":"call_...","type":"function","function":{"name":"search_files","arguments":"{\"path\":\"packages\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

为兼容客户端，`stream_options` 会被接受但忽略。Tokenless 无法计量 provider token，因此不会发出 usage 帧。

Structured final 使用同样的 full-content delta、`finish_reason: "stop"` 与 `[DONE]`。其中 `content` 是完整且已校验的 JSON 文本；不会附加 usage frame。

Anthropic 帧，按顺序：`message_start`、`content_block_start`、`content_block_delta`（携带完整文本）、`content_block_stop`、`message_delta`、`message_stop`。

不要基于这些帧做进度指示。如果 UI 需要"正在输出"的观感，请用 spinner 驱动，而不是靠传输层。

## Conversation 模式

在 `tokenless setup` 中或用 `tokenless api-proxy enable --conversation-mode <mode>` 设置一次，作用于整个安装，**不是按请求指定**。可从 `tokenless api-proxy status --json` 读取当前模式，响应也会在 `tokenless.conversation_mode` 中回显。

### new-conversation（默认）

每个请求都把整段对话打平成一条 prompt，并新建一个 provider 会话：

```
[System]
Answer in one sentence.

[User]
What is 2+2?
```

无状态、可预测。相同请求不依赖任何本地既有状态。代价是长对话每轮都要重发全部历史，且 provider 看不到轮次之间的连续性。

无论配置了哪种 conversation mode，tool 请求都会使用这种 request-scoped 完整历史行为。Catalog、nonce 与不可信 canonical history 会被编译为严格的单轮 protocol envelope。

**客户端要做的：** 每次调用都发送完整历史，和面对真实 API 时完全一样。除此之外无需处理。

### continue-conversation

Tokenless 会对**除最后一条 user message 之外**的全部消息做指纹（对 role/text 对做 SHA-256），以此作为持久线程标识，并为其复用同一个 provider 会话。命中时只把最后一条 user message 输入既有会话；未命中则用完整打平文本新建会话。

更省、也更接近真人使用网站的方式。但指纹是精确匹配：

**客户端要注意的重点。** 对既有历史的任何改动都会开启新会话。包括为控制 context 预算而裁剪旧轮次、修改 system prompt、重新编号、调整格式空白，或在重发前归一化自己的 assistant 文本。这些都会静默分叉出新的 provider 会话，而不是接着聊。

如果你的客户端会重写历史，请直接用 `new-conversation`——结果相同，且不必为意外分叉付出代价。只有在你只追加、从不修改的情况下才使用 `continue-conversation`。

## 错误

所有失败都会按对应方言的错误信封返回。

对于 framed tool 或 structured-final 请求，一种狭窄 failure 可在同一 provider 与 execution strategy 上获得 bounded correction：安全 marker/chrome framing 必须已按精确顺序识别本请求的 protocol、nonce 与当前允许的 `kind: final`，而 strict JSON parsing 失败于 outer final-content escaping。Correction 后的 inner structured content 仍必须成功解析并满足 accepted schema。Framing、correlation、duplicate-key、tool-choice、tool-call、arguments/schema、inner JSON 与 valid-envelope shape failure 会立即返回 `provider_output_protocol_error`。Transport failure、timeout、ambiguous submission、已暴露 call 与调用方 tool execution 都不会重试。

OpenAI，其中 `param` 会在可定位时指出出错字段：

```json
{"error":{"message":"...","type":"invalid_request_error","param":"messages","code":"invalid_request_error"}}
```

Anthropic：

```json
{"type":"error","error":{"type":"invalid_request_error","message":"..."}}
```

### 状态码

状态码就是判断依据。`code` 给出具体根因，`message` 仅供人类阅读。

| 状态码 | Code | 根因 | 可否重试 |
| --- | --- | --- | --- |
| 400 | `invalid_request_error` | 请求体、tool catalog、tool choice、response format/schema、arguments 或历史配对错误 | 否 —— 修正请求 |
| 400 | `invalid_json` | 请求体为空或不是 JSON | 否 |
| 400 | `unsupported_parameter` | 旧版 `functions` / `function_call`，或 Anthropic tools/structured output | 否 |
| 401 | `control_auth_missing` | 缺少 bearer token | 否 |
| 403 | `control_auth_rejected` | bearer token 错误 | 否 |
| 404 | `model_not_found` | `model` 指向不存在或未内置的 provider | 否 |
| 413 | `request_too_large` | 请求体超过 2 MiB | 否 |
| 499 | `client_closed_request` | 客户端先断开了连接 | 否 —— 已无接收方 |
| 500 | — | 本地 daemon 故障，message 刻意保持通用 | 可重试一次 |
| 502 | `upstream_error` | provider 页面没有产生可见回复：登录 blocker、CAPTCHA 或 job 失败 | 用户清除 blocker 后可重试 |
| 502 | `provider_output_protocol_error` | Tool 或 structured-final 校验失败；只有 correlated outer `kind: final` string-escaping failure 会获得一次 bounded correction | 不再重试 |
| 503 | `api_proxy_disabled` | proxy 未开启 | 否 —— 请先开启 |
| 503 | `profile_not_ready` | managed profile 需要先执行 `tokenless setup` | 否 —— 请先完成 setup |
| 503 | `model_not_available` | 该 provider 未在解析出的 profile 上启用 | 否 —— 请先启用 |
| 504 | `completion_timeout` | provider 在 10 分钟内没有回复 | 可重试，但原 job 可能仍在运行 |

除 499 之外的 `4xx` 表示调用方必须做出修改。`502`、`504`、`500` 属于运行期问题：同一请求稍后可能成功。这张表的全部意义就在于这一区分 —— 不要匹配 message 字符串。

发生 `502` 与 `504` 时，底层浏览器 job **不会**被取消，仍可能继续完成。重试前请用 `tokenless state --job-id <id> --json` 检查，否则可能重复排入同一份 provider 工作。

## 硬性限制

请围绕这些设计，而不是与之对抗。

| 属性 | 实际情况 |
| --- | --- |
| 延迟 | 秒到分钟级。真实浏览器导航、页面稳定、输入、提交、渲染。 |
| 超时 | 10 分钟，随后返回 504。底层 job 可能仍在运行——请用 `job_id` 查询。 |
| 并发 | 单 profile 基本串行。一个浏览器、一个 provider 标签页。 |
| Tool use | 支持一个或多个现代 function calls，可使用非流式或终态 SSE；由调用方执行。 |
| 结构化输出 | 支持 OpenAI `json_object` 与本文记录的 closed-object `json_schema` subset；返回 valid final JSON 或明确错误。 |
| 共享校验边界 | Universal API 与 Standalone Web Agent Harness 使用同一 strict JSON parser、JSON Schema validator setup 和 exactly-one marker extraction；两者的 envelope 与执行权仍保持分离。 |
| 采样控制 | 静默忽略。 |
| Token 计量 | 无。 |
| 多模态输入 | 仅文本。 |

可把人类节奏的一问一答、外部 tool turn 与 bounded structured final 放到这条通道上。低延迟增量 streaming 仍应走其他 route。

### 账号风险

用网页版账号承接程序化流量，可能违反 provider 服务条款。Tokenless 已尽量贴近真人行为——只操作可见控件、不复制 profile、不提取凭据——但它无法消除账号被判定为自动化的风险。低频委派和批量流量是两个不同的风险等级。用量由调用方自行决定。

## 完整示例

### curl

```bash
TOKEN=$(cat ~/.tokenless/daemon.token)

curl -sS http://127.0.0.1:7331/v1/openai/chat/completions \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "model": "tokenless/chatgpt",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

### OpenAI SDK（Python）

```python
import pathlib
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:7331/v1/openai",
    api_key=pathlib.Path.home().joinpath(".tokenless/daemon.token").read_text().strip(),
    timeout=660.0,  # 必须大于服务端 10 分钟超时
    max_retries=0,  # 只在 500/502/504 上主动重试，见错误一节
)

response = client.chat.completions.create(
    model="tokenless/chatgpt",
    messages=[{"role": "user", "content": "What is 2+2?"}],
)
print(response.choices[0].message.content)
```

### Anthropic SDK（TypeScript）

```ts
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  baseURL: 'http://127.0.0.1:7331/v1/anthropic',
  apiKey: readFileSync(path.join(os.homedir(), '.tokenless/daemon.token'), 'utf8').trim(),
  timeout: 660_000,
  maxRetries: 0,
})

const message = await client.messages.create({
  model: 'tokenless/claude',
  max_tokens: 1024, // SDK 要求，proxy 会忽略
  messages: [{ role: 'user', content: 'What is 2+2?' }],
})
console.log(message.content)
```

注意两个 SDK 都需要把默认超时调高、并把重试次数设为 0。在一个 10 分钟请求上使用默认重试，会排队出重复的浏览器 job。

## 实现清单

- [ ] 从 `tokenless api-proxy status --json` 读取 base URL，不要用常量。
- [ ] 从 `~/.tokenless/daemon.token` 读取 token；绝不写入日志。
- [ ] model 命名为 `tokenless/<provider>`；用 `GET /v1/openai/models` 校验。
- [ ] Tool 请求使用现代 `tools`，选择所需 `tool_choice` 与 parallel 设置，在 Tokenless 外执行每个调用，并重发完整配对历史。
- [ ] 使用 `strict: true` 时，根节点使用 object，每个 object 都设置 `additionalProperties: false`，要求所有 property，并用 nullable type 表示可选值。
- [ ] `functions`、`function_call` 与 `response_format` 继续走其他 route。
- [ ] 把 `stream_options` 视为已忽略，且不要期待 usage 帧。
- [ ] 不要依赖 `temperature`、`max_tokens` 或任何采样字段。
- [ ] 不要用 `usage` 计算成本。
- [ ] 把客户端超时提到 10 分钟以上；重试设为 0，改由自己控制重试。
- [ ] 依据 HTTP 状态码而不是 `message` 分支：只重试 `500`、`502`、`504`。
- [ ] 重试 `502` 或 `504` 前先检查 `job_id` —— 原 job 可能仍在运行。
- [ ] 每次调用都记录 `tokenless.job_id`。
- [ ] 按串行执行预期设计；不要并发扇出请求。
- [ ] 确认当前 conversation 模式；若客户端会重写历史，使用 `new-conversation`。

## 已验证的 DeepSeek tool loop

Packaged daemon 已通过真实 DeepSeek browser route 完成一次非流式单 tool loop：

- Job `8a709343-5fd4-46b4-801c-434c5b4a8da0` 返回标准 assistant `tool_calls`，调用 `read_file` 读取 `package.json`。
- 调用方执行本地 tool，并将实际结果作为配对的 `role: tool` 历史返回。
- Job `8a3d2c42-e05c-478f-8518-22acb5a39467` 返回基于该 package metadata 的最终回答，`finish_reason: stop`。

随后一次[未修改 DSH 的真实 streaming run](evidence/dsh-streaming-tool-loop-2026-08-15.md)通过 packaged daemon 与真实 DeepSeek browser route，完成了两个连续的单 tool turn 和 grounded final answer。DSH 重建了稳定 id、name、index 0、完整 arguments、终态 `tool_calls` 与 `[DONE]`；两个 tool 都由 DSH 而非 Tokenless 执行。

随后一次[未修改 DSH 的 multiple-call run](evidence/openai-multiple-tool-calls-deepseek-2026-08-15.md)在一个 assistant outcome 中重建了稳定的 index 0 与 1，执行两个真实读取、重放两项结果并获得 grounded final。另一个真实非流式请求保留了与两个 model-ordered calls 同时返回的简短 assistant content。

## 已知不足

仍有两点不应依赖：

- **`502` 不会说明页面失败的原因。** 登录 blocker、CAPTCHA 与真正失败的 job 都报 `upstream_error`，需要用 `job_id` 进一步定位。
- **超时或断开不会终止浏览器 job。** 系统不会代为取消 provider 侧的工作，因此草率重试可能为同一 prompt 排入第二个 job。

## 参考

- [CLI 命令](../COMMANDS.zh-CN.md#tokenless-api-proxy) — `tokenless api-proxy`
- [OpenAPI 契约](../api/tokenless-daemon-api.openapi.json) — 请求与响应 schema
- [架构](architecture.md) — 执行路径与信任边界
- [隐私边界](../PRIVACY.md) — 哪些数据留在本地
