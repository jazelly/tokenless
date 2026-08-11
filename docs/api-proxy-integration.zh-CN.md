# Tokenless API Proxy 接入指南

如何从既有项目调用 Tokenless 本地 API proxy。面向已经写好 OpenAI 或 Anthropic 形态代码、希望把这部分流量改由可见 provider 网站承担而非付费 API 的实现者。

## 这是什么

Tokenless daemon 暴露了 OpenAI 与 Anthropic 兼容的 HTTP 路由。一个请求会变成 durable job，由 Playwright worker 在已登录的浏览器 profile 中把 prompt 输入真实 provider 页面，再把可见回复按你客户端已经预期的 wire shape 返回。

**这是任务级桥接，不是 API 的即插即用替代品。** 在围绕它做设计之前，请先读 [硬性限制](#硬性限制)。此方案是用吞吐、延迟、streaming 和 tool use 换成本。

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

裸 `/v1` base 的存在，是为了让硬编码 `/v1/chat/completions` 的客户端无需改动即可使用。它只是 alias：dialect 与行为完全一致。Anthropic 没有裸 alias，因为两种 dialect 会在同一路径上冲突。

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
| `stream` | 生效——见 [Streaming](#streaming) |
| `tools`、`tool_choice`、`functions`、`function_call`、`response_format` | **返回 400 拒绝** |
| `temperature`、`top_p`、`max_tokens`、`seed`、`stop` 及其他全部字段 | **静默忽略** |

被拒绝的那组是 fail closed：可见页面没有对应控件，在调用方期待 tool call 时返回散文，比直接报错更糟。

被忽略的那组才是更隐蔽的坑：**采样参数完全无效。** `temperature: 0` 不会让 provider 变得确定，`max_tokens` 也不会约束回复长度。如果你的代码依赖其中任何一个，那条调用路径就不该走这个 proxy。`max_tokens` 之所以只被忽略而非拒绝，仅仅因为 Anthropic API 强制要求它。

### 大小限制

| 限制项 | 数值 |
| --- | --- |
| HTTP body | 2 MiB |
| `messages` 条数 | 256 |
| 打平后的 prompt 文本 | 1 MiB |

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

`finish_reason` 恒为 `stop`，`stop_reason` 恒为 `end_turn`。可见页面没有截断或拒答的信号，所以不要基于这两个字段做分支。

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

**客户端要做的：** 每次调用都发送完整历史，和面对真实 API 时完全一样。除此之外无需处理。

### continue-conversation

Tokenless 会对**除最后一条 user message 之外**的全部消息做指纹（对 role/text 对做 SHA-256），以此作为持久线程标识，并为其复用同一个 provider 会话。命中时只把最后一条 user message 输入既有会话；未命中则用完整打平文本新建会话。

更省、也更接近真人使用网站的方式。但指纹是精确匹配：

**客户端要注意的重点。** 对既有历史的任何改动都会开启新会话。包括为控制 context 预算而裁剪旧轮次、修改 system prompt、重新编号、调整格式空白，或在重发前归一化自己的 assistant 文本。这些都会静默分叉出新的 provider 会话，而不是接着聊。

如果你的客户端会重写历史，请直接用 `new-conversation`——结果相同，且不必为意外分叉付出代价。只有在你只追加、从不修改的情况下才使用 `continue-conversation`。

## 错误

所有失败都会按对应方言的错误信封返回。

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
| 400 | `invalid_request_error` | 请求体格式错误、model 名语法错误、role 或 content part 不受支持 | 否 —— 修正请求 |
| 400 | `invalid_json` | 请求体为空或不是 JSON | 否 |
| 400 | `unsupported_parameter` | 传入了 `tools`、`tool_choice`、`functions`、`function_call` 或 `response_format` | 否 |
| 401 | `control_auth_missing` | 缺少 bearer token | 否 |
| 403 | `control_auth_rejected` | bearer token 错误 | 否 |
| 404 | `model_not_found` | `model` 指向不存在或未内置的 provider | 否 |
| 413 | `request_too_large` | 请求体超过 2 MiB | 否 |
| 499 | `client_closed_request` | 客户端先断开了连接 | 否 —— 已无接收方 |
| 500 | — | 本地 daemon 故障，message 刻意保持通用 | 可重试一次 |
| 502 | `upstream_error` | provider 页面没有产生可见回复：登录 blocker、CAPTCHA 或 job 失败 | 用户清除 blocker 后可重试 |
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
| Tool use | 不支持，直接拒绝。 |
| 结构化输出 | 不支持，直接拒绝。 |
| 采样控制 | 静默忽略。 |
| Token 计量 | 无。 |
| 多模态输入 | 仅文本。 |

只把人类节奏的一问一答放到这条通道上：分析、总结、评审、研究性问题。凡是需要 tool call、schema 合法输出、低延迟或并行的调用，继续走真实 API。

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
- [ ] 发送前剥离 `tools`、`tool_choice`、`functions`、`function_call`、`response_format`，或把这些调用路径留在真实 API。
- [ ] 不要依赖 `temperature`、`max_tokens` 或任何采样字段。
- [ ] 不要用 `usage` 计算成本。
- [ ] 把客户端超时提到 10 分钟以上；重试设为 0，改由自己控制重试。
- [ ] 依据 HTTP 状态码而不是 `message` 分支：只重试 `500`、`502`、`504`。
- [ ] 重试 `502` 或 `504` 前先检查 `job_id` —— 原 job 可能仍在运行。
- [ ] 每次调用都记录 `tokenless.job_id`。
- [ ] 按串行执行预期设计；不要并发扇出请求。
- [ ] 确认当前 conversation 模式；若客户端会重写历史，使用 `new-conversation`。

## 已知不足

仍有两点不应依赖：

- **`502` 不会说明页面失败的原因。** 登录 blocker、CAPTCHA 与真正失败的 job 都报 `upstream_error`，需要用 `job_id` 进一步定位。
- **超时或断开不会终止浏览器 job。** 系统不会代为取消 provider 侧的工作，因此草率重试可能为同一 prompt 排入第二个 job。

## 参考

- [CLI 命令](../COMMANDS.zh-CN.md#tokenless-api-proxy) — `tokenless api-proxy`
- [OpenAPI 契约](../api/tokenless-daemon-api.openapi.json) — 请求与响应 schema
- [架构](architecture.md) — 执行路径与信任边界
- [隐私边界](../PRIVACY.md) — 哪些数据留在本地
