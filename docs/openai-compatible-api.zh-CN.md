# OpenAI-compatible Arena Chat

[English](openai-compatible-api.md)

Tokenless 为普通 Arena Direct 文本聊天提供一个小型 OpenAI-compatible boundary。它复用 setup 时选定且已登录的浏览器 profile，不是 provider API Key bridge。

## 启动与鉴权

使用 `tokenless dashboard --no-open` 启动 packaged daemon。默认 base URL 是 `http://127.0.0.1:7331/v1`。

每个请求都要把本地 daemon control token 作为 bearer token。Tokenless 将它保存在配置目录下的 `daemon.token`（默认为 `~/.tokenless/daemon.token`）；请只在本机使用，不要记录或分享。

```bash
curl http://127.0.0.1:7331/v1/models \
  -H "Authorization: Bearer $(< ~/.tokenless/daemon.token)"
```

## Model 与 completion 契约

`GET /v1/models` 只列出一个精确 model ID：`arena:max`。它会选择 Arena Direct 与可见的 **Max** router。

`POST /v1/chat/completions` 支持一次 non-streaming 文本 completion：

- `messages` 接受 `system`、`developer`、`user` 与 `assistant` role。
- `content` 接受字符串或 OpenAI `{ "type": "text", "text": "..." }` parts。
- 单条 user message 会原样提交。多条 message 会规范化为一个严格 JSON transcript document；message content 始终是 data，不能注入新的 transcript role。
- 每个 HTTP 请求都会创建新 conversation。由于该 request shape 不携带 Tokenless conversation mapping，所以不公开 OpenAI-compatible continuation。
- Request 必须使用 `Content-Type: application/json`，body 不得超过 2 MiB。`stream`、tools、images、audio 与未知 request field 会在 browser submission 前失败。
- HTTP client 断开或 completion deadline 到期时，仍活跃的本地 job 会被取消。Upstream job detail 永不返回；失败只使用固定的 sanitized error。Arena 在此 boundary 不提供可靠 token accounting，因此 response 不包含 usage。

```bash
curl http://127.0.0.1:7331/v1/chat/completions \
  -H "Authorization: Bearer $(< ~/.tokenless/daemon.token)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "arena:max",
    "messages": [
      {"role": "user", "content": "用两句话解释 JavaScript event loop。"}
    ]
  }'
```

Response 使用标准 non-streaming `chat.completion` shape，并通过 `x_tokenless` 提供本地 job ID、可见 model 与 transcript-replay 状态。Arena comparison、Search、Image、Code、Agent 和 Video 结果继续使用 Tokenless task API，避免静默丢失 alternatives、citations、artifacts 或 agent-run 细节。

完整 machine-readable contract 见 [`api/tokenless-daemon-api.openapi.json`](../api/tokenless-daemon-api.openapi.json)。
