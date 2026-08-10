# Tokenless API Proxy Integration

How to call the Tokenless local API proxy from an existing project. Written for an implementer who already has OpenAI- or Anthropic-shaped code and wants that traffic served by a visible provider website instead of a paid API.

## What this is

The Tokenless daemon exposes OpenAI- and Anthropic-compatible HTTP routes. A request becomes a durable job, a Playwright worker types the prompt into a real provider page in a signed-in browser profile, and the visible reply is returned in the wire shape your client already expects.

**This is a task-level bridge, not a drop-in API replacement.** Read [Hard limits](#hard-limits) before designing around it. The proxy trades throughput, latency, streaming, and tool use for cost.

## Prerequisites

Three things must be true before any request succeeds. None of them can be established by the proxy itself.

1. **The daemon is running.** Any `tokenless` command starts it on demand; `tokenless dashboard --no-open --json` is the explicit way. A stopped daemon means connection refused, not an HTTP error.
2. **The proxy is enabled.** It ships off.
   ```bash
   tokenless api-proxy enable --conversation-mode new-conversation --json
   ```
3. **A managed profile is signed in to the target provider.** Run `tokenless setup`, then sign in through the visible browser window. Without this, requests fail on a provider sign-in blocker.

Verify all three at once:

```bash
tokenless api-proxy status --json
```

## Base URL

Default `http://127.0.0.1:7331`. It is loopback-only and never binds a public interface.

Do not hardcode it. Read `apiProxy.endpoints` from `tokenless api-proxy status --json`, which already accounts for a custom `daemonUrl` in the config.

| Client style | Base URL |
| --- | --- |
| OpenAI-compatible | `http://127.0.0.1:7331/v1/openai` |
| Anthropic-compatible | `http://127.0.0.1:7331/v1/anthropic` |

## Authentication

Send the daemon control token as a bearer token. Standard SDKs already do this when you set their API key.

```
Authorization: Bearer <token>
```

Read the token from `<TOKENLESS_HOME>/daemon.token` — by default `~/.tokenless/daemon.token`, mode `0600`. Trim trailing whitespace.

Treat it as a local credential: it authorizes every daemon control route, not just the proxy. Do not log it, commit it, or send it anywhere but loopback.

| Condition | Status | Code |
| --- | --- | --- |
| No `Authorization` header | 401 | `control_auth_missing` |
| Wrong token | 403 | `control_auth_rejected` |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/openai/chat/completions` | OpenAI chat completion |
| GET | `/v1/openai/models` | List accepted model names |
| POST | `/v1/anthropic/messages` | Anthropic message |

## Model naming

`model` is the only place a provider can be named, so it must name one explicitly:

```
tokenless/<provider>
```

Valid providers are those enabled for the installation: `chatgpt`, `claude`, `gemini`, `grok`, `qwen`, `deepseek`, `perplexity`, `zai`, `doubao`, `kimi`, `dola`. Only the first four are supported; the rest are experimental and fail closed on unverified routes.

Call `GET /v1/openai/models` for the live list rather than hardcoding one.

A bare model name such as `gpt-4o` is **rejected**, not remapped. This is deliberate: silently redirecting to a provider the caller did not choose would hide which account and which subscription answered the request.

```jsonc
// 400
{"error":{"message":"invalid input: model must be named tokenless/<provider>, for example tokenless/chatgpt","type":"invalid_request_error","param":null,"code":"invalid_input"}}
```

## Request bodies

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

Roles: `system`, `user`, `assistant`, `developer` (`developer` is normalized to `system`).

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

Roles in `messages`: `user`, `assistant` only. The system prompt goes in the top-level `system` field, as in the real API.

### Content blocks

`content` accepts a string, or an array of text parts:

```json
{"role": "user", "content": [{"type": "text", "text": "hello"}]}
```

Any other part type — `image_url`, `image`, `input_audio`, `document`, `tool_result` — is rejected. Multiple text parts are joined with a newline.

### Field handling

| Field | Behavior |
| --- | --- |
| `model`, `messages` | Required |
| `system` (Anthropic) | Honored as a system message |
| `stream` | Honored — see [Streaming](#streaming) |
| `tools`, `tool_choice`, `functions`, `function_call`, `response_format` | **Rejected with 400** |
| `temperature`, `top_p`, `max_tokens`, `seed`, `stop`, everything else | **Silently ignored** |

The rejected group fails closed because visible pages expose no equivalent control — returning prose where the caller expects a tool call would be worse than an error.

The ignored group is the sharper trap: **sampling parameters have no effect.** `temperature: 0` does not make the provider deterministic, and `max_tokens` does not bound the reply. If your code depends on either, the proxy is the wrong transport for that call path. `max_tokens` is ignored rather than rejected only because the Anthropic API requires it.

### Size limits

| Limit | Value |
| --- | --- |
| HTTP body | 2 MiB |
| `messages` entries | 256 |
| Flattened prompt text | 1 MiB |

## Response bodies

Standard vendor shapes plus one `tokenless` object.

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

`finish_reason` is always `stop` and `stop_reason` always `end_turn`. There is no visible signal for truncation or a refusal, so do not branch on them.

### usage is always zero

Not a bug and not a placeholder to be filled in later. Tokenless does not meter provider tokens — the reply is billed by your web subscription, so there is no count to report. Reporting a fabricated estimate would be worse than reporting none.

If you need a savings figure, use `tokenless savings status --json`, which measures visible output separately with a pinned tokenizer. Do not derive spend from `usage`.

### The tokenless object

| Field | Use |
| --- | --- |
| `provider` | Which provider actually answered |
| `job_id` | Durable job id — pass to `tokenless state --job-id <id> --json` to inspect what happened |
| `conversation_mode` | Which mapping served this request |
| `citations` | Visible source links, when the provider rendered any |

Log `job_id`. It is the only handle that ties a client-side failure to a durable local record.

## Streaming

`stream: true` returns `text/event-stream` with the correct event sequence for the dialect.

**There is no incremental text.** A visible provider reply is only readable once it has finished rendering, so the whole response arrives as one terminal chunk after the full latency. The event sequence is preserved so that otherwise-compatible clients keep working; refusing `stream` would break them for no benefit.

OpenAI frames:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","content":"<full text>"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Anthropic frames, in order: `message_start`, `content_block_start`, `content_block_delta` (carries the full text), `content_block_stop`, `message_delta`, `message_stop`.

Do not build a progress indicator off these. If your UI needs perceived streaming, drive it from a spinner, not from the transport.

## Conversation modes

Set once, installation-wide, during `tokenless setup` or with `tokenless api-proxy enable --conversation-mode <mode>`. It is not per-request. Read the active mode from `tokenless api-proxy status --json`, and note that responses echo it in `tokenless.conversation_mode`.

### new-conversation (default)

Every request flattens the entire transcript into one prompt and starts a fresh provider conversation:

```
[System]
Answer in one sentence.

[User]
What is 2+2?
```

Stateless and predictable. Identical requests never depend on prior local state. The cost is that a long chat resends its whole history every turn, and the provider sees no continuity between turns.

**Client implication:** send full history on every call, exactly as you would to a real API. Nothing else to do.

### continue-conversation

Tokenless fingerprints every message *except the final user turn* (SHA-256 over role/text pairs), uses that as a durable thread identity, and reuses one provider conversation for it. On a hit, only the final user message is typed into the existing conversation. On a miss, it starts a new conversation with the full flattened transcript.

Cheaper and closer to how a person uses the site. But the fingerprint is exact:

**Client implication — this is the part to get right.** Any change to prior history starts a new conversation. That includes trimming old turns to fit a context budget, editing a system prompt, renumbering, reformatting whitespace, or normalizing your own assistant text before resending. All of these silently fork a new provider conversation rather than continuing.

If your client rewrites history at all, prefer `new-conversation` — you get the same result without paying for surprise forks. Use `continue-conversation` only when you append and never mutate.

## Errors

Every failure returns the dialect's own error envelope.

OpenAI:

```json
{"error":{"message":"...","type":"invalid_request_error","param":null,"code":"invalid_input"}}
```

Anthropic:

```json
{"type":"error","error":{"type":"invalid_request_error","message":"..."}}
```

### Status codes

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `control_auth_missing` | No bearer token |
| 403 | `control_auth_rejected` | Wrong bearer token |
| 400 | `invalid_input` | Everything else |

### Known weakness: all operational failures share one code

Every non-auth failure is `400` / `invalid_input`, whatever the cause. The only distinguishing information is the human-readable `message`:

| Cause | Message contains |
| --- | --- |
| Proxy not enabled | `api proxy is disabled` |
| Bad model name | `model must be named tokenless/<provider>` |
| Unsupported field | `does not support <field>` |
| Unknown provider | `provider is not supported` |
| Provider not enabled here | `provider is not enabled for this installation` |
| Profile not ready | `managed profile is not ready` |
| Provider needs sign-in / CAPTCHA | `did not produce a visible response` |
| 10-minute timeout | `api proxy timed out after 600s` |
| Client disconnected | `aborted by the client` |

**Do not build retry logic on string matching.** A malformed request (never retry) and a transient provider blocker (retry after the user signs in) are indistinguishable by status and code today. Until that is fixed, the safe client behavior is: surface the message to the user and do not auto-retry. See [Open issue](#open-issue).

## Hard limits

Design around these, not against them.

| Property | Reality |
| --- | --- |
| Latency | Seconds to minutes. Real browser navigation, page settle, typing, submit, and render. |
| Timeout | 10 minutes, then 400. The underlying job may still be running — check `job_id`. |
| Concurrency | Effectively serial per profile. One browser, one provider tab. |
| Tool use | Unsupported, rejected. |
| Structured output | Unsupported, rejected. |
| Sampling control | Silently ignored. |
| Token accounting | None. |
| Multimodal input | Text only. |

Route only human-paced, one-shot Q&A through this: analysis, summarization, review, research questions. Keep anything that needs tool calls, schema-valid output, low latency, or parallelism on the real API.

### Account risk

Serving programmatic traffic from a web account may violate provider terms. Tokenless keeps behavior close to a real person — visible controls only, no profile copying, no credential extraction — but it cannot remove the risk that an account is flagged. Low-frequency delegation and batch traffic are different risk classes. Volume is the caller's decision.

## Worked examples

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

### OpenAI SDK (Python)

```python
import pathlib
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:7331/v1/openai",
    api_key=pathlib.Path.home().joinpath(".tokenless/daemon.token").read_text().strip(),
    timeout=660.0,  # must exceed the 10-minute server timeout
    max_retries=0,  # see the errors section: do not auto-retry
)

response = client.chat.completions.create(
    model="tokenless/chatgpt",
    messages=[{"role": "user", "content": "What is 2+2?"}],
)
print(response.choices[0].message.content)
```

### Anthropic SDK (TypeScript)

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
  max_tokens: 1024, // required by the SDK, ignored by the proxy
  messages: [{ role: 'user', content: 'What is 2+2?' }],
})
console.log(message.content)
```

Note both SDKs need their default timeout raised and their retry count zeroed. Default retries on a 10-minute request will queue duplicate browser jobs.

## Implementation checklist

- [ ] Read base URL from `tokenless api-proxy status --json`, not a constant.
- [ ] Read the token from `~/.tokenless/daemon.token`; never log it.
- [ ] Name models `tokenless/<provider>`; validate against `GET /v1/openai/models`.
- [ ] Strip `tools`, `tool_choice`, `functions`, `function_call`, `response_format` before sending, or keep those call paths on the real API.
- [ ] Do not depend on `temperature`, `max_tokens`, or any sampling field.
- [ ] Do not read `usage` for cost.
- [ ] Raise client timeout above 10 minutes; set retries to 0.
- [ ] Surface error `message` to the user; do not auto-retry.
- [ ] Log `tokenless.job_id` on every call.
- [ ] Expect serial execution; do not fan out concurrent requests.
- [ ] Confirm the active conversation mode, and if the client rewrites history, use `new-conversation`.

## Open issue

Operational failures are not distinguishable from client mistakes: everything non-auth is `400` / `invalid_input`. A client cannot correctly decide whether to retry.

A fix would map the existing internal distinctions onto the transport — 401/403 for a provider sign-in blocker, 408 or 504 for the timeout, 409 for a busy profile, 429 for provider rate limits, 400 only for genuinely malformed requests — and add a stable machine-readable code inside the error envelope. That work is not done. Until it is, keep client behavior conservative.

## Reference

- [CLI commands](../COMMANDS.md#tokenless-api-proxy) — `tokenless api-proxy`
- [OpenAPI contract](../api/tokenless-daemon-api.openapi.json) — request and response schemas
- [Architecture](architecture.md) — execution path and trust boundaries
- [Privacy boundaries](../PRIVACY.md) — what stays local
