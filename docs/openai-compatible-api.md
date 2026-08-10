# OpenAI-Compatible Arena Chat

[简体中文](openai-compatible-api.zh-CN.md)

Tokenless exposes a small OpenAI-compatible boundary for ordinary Arena Direct text chat. It reuses the authenticated browser profile selected during setup; it is not a provider API-key bridge.

## Start and authenticate

Start the packaged daemon with `tokenless dashboard --no-open`. The default base URL is `http://127.0.0.1:7331/v1`.

Every request needs the local daemon control token as a bearer token. Tokenless stores it at `daemon.token` under the configured Tokenless home (`~/.tokenless/daemon.token` by default); keep it local and never log or share it.

```bash
curl http://127.0.0.1:7331/v1/models \
  -H "Authorization: Bearer $(< ~/.tokenless/daemon.token)"
```

## Model and completion contract

`GET /v1/models` lists one exact model ID: `arena:max`. It selects Arena Direct and the visible **Max** router.

`POST /v1/chat/completions` supports one non-streaming text completion:

- `messages` accepts `system`, `developer`, `user`, and `assistant` roles.
- `content` accepts a string or OpenAI `{ "type": "text", "text": "..." }` parts.
- One user message is submitted verbatim. Multiple messages are normalized into one strict JSON transcript document; message content remains data and cannot introduce new transcript roles.
- Every HTTP request creates a new conversation. OpenAI-compatible continuation is not exposed because this request shape carries no Tokenless conversation mapping.
- Requests require `Content-Type: application/json` and a body no larger than 2 MiB. `stream`, tools, images, audio, and unknown request fields fail before browser submission.
- Disconnecting the HTTP client or reaching the completion deadline cancels any still-active local job. Upstream job details are never returned; failures use a fixed sanitized error. Token usage is omitted because Arena does not expose reliable token accounting here.

```bash
curl http://127.0.0.1:7331/v1/chat/completions \
  -H "Authorization: Bearer $(< ~/.tokenless/daemon.token)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "arena:max",
    "messages": [
      {"role": "user", "content": "Explain the JavaScript event loop in two sentences."}
    ]
  }'
```

The response uses the standard non-streaming `chat.completion` shape and adds `x_tokenless` with the local job ID, visible model, and transcript-replay state. Arena comparison, Search, Image, Code, Agent, and Video results stay on the Tokenless task API so alternatives, citations, artifacts, and agent-run details are not silently discarded.

See the complete machine-readable contract in [`api/tokenless-daemon-api.openapi.json`](../api/tokenless-daemon-api.openapi.json).
