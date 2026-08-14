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

Do not hardcode it. Read `apiProxy.endpoints` from `tokenless api-proxy status --json` — keys `openai`, `openaiDefault`, and `anthropic` — which already accounts for a custom `daemonUrl` in the config.

| Client style | Base URL |
| --- | --- |
| OpenAI-compatible | `http://127.0.0.1:7331/v1/openai` |
| OpenAI-compatible, default paths | `http://127.0.0.1:7331/v1` |
| Anthropic-compatible | `http://127.0.0.1:7331/v1/anthropic` |

The bare `/v1` base exists so a client that hardcodes `/v1/chat/completions` works without modification. It is an alias: same dialect, same behavior. Anthropic has no bare alias, because the two dialects would collide on one path.

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
| POST | `/v1/chat/completions` | Alias of the above |
| GET | `/v1/openai/models` | List accepted model names |
| GET | `/v1/models` | Alias of the above |
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
{"error":{"message":"model must be named tokenless/<provider>, for example tokenless/chatgpt","type":"invalid_request_error","param":"model","code":"invalid_request_error"}}
```

A well-formed name for a provider that does not exist or is not built in returns `404` / `model_not_found`, matching what a real API does with an unknown model.

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

Modern OpenAI function tools are accepted for non-streaming and streaming requests. The current V1 supports one declared call per turn, `tool_choice` omitted or `auto`, and `parallel_tool_calls` omitted or `false`:

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
      "strict": false
    }
  }],
  "tool_choice": "auto",
  "parallel_tool_calls": false
}
```

The caller executes returned tools. On the next request, resend the same catalog and the complete ordered pair:

```json
[
  {"role":"assistant","content":null,"tool_calls":[{"id":"call_abc","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"package.json\"}"}}]},
  {"role":"tool","tool_call_id":"call_abc","content":"{\"name\":\"tokenless\"}"}
]
```

Tokenless validates unique call ids, declared names, strict argument JSON, argument schemas, and call/result pairing before provider submission. It never executes caller tools or stores their catalog.

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
| `stream` | Honored for text and one function tool call |
| `stream_options` | Accepted and ignored; no streaming usage is fabricated |
| `tools` | Modern OpenAI function tools honored for one call |
| `tools[].function.strict` | Omitted or `false`; `true` is reserved for a later milestone |
| `tool_choice` | Omitted or `auto`; other forms rejected with 400 |
| `parallel_tool_calls` | Omitted or `false`; `true` and other forms rejected with 400 |
| `functions`, `function_call`, `response_format` | **Rejected with 400** |
| `temperature`, `top_p`, `max_tokens`, `seed`, `stop`, everything else | **Silently ignored** |

Deprecated function fields, structured final output, forced choices, and multiple calls remain fail-closed. They are later milestones, not silently ignored compatibility.

The ignored group is the sharper trap: **sampling parameters have no effect.** `temperature: 0` does not make the provider deterministic, and `max_tokens` does not bound the reply. If your code depends on either, the proxy is the wrong transport for that call path. `max_tokens` is ignored rather than rejected only because the Anthropic API requires it.

### Size limits

| Limit | Value |
| --- | --- |
| HTTP body | 2 MiB |
| `messages` entries | 256 |
| Flattened prompt text | 1 MiB |
| Function tools | 128 |
| One function parameter schema | 64 KiB |

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

A validated call uses the standard OpenAI shape. Tokenless allocates the public id only after validating provider output:

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{"id":"call_abc","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"package.json\"}"}}]
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

OpenAI text uses `finish_reason: stop`; a validated function call uses `finish_reason: tool_calls`. Anthropic `stop_reason` remains `end_turn`.

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

A validated tool call uses the same terminal delivery model. Its first frame contains `delta.tool_calls[0]` with stable `index: 0`, `id`, `name`, and the complete arguments string. A second frame carries `finish_reason: "tool_calls"`, followed by `[DONE]`:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"package.json\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

`stream_options` is accepted for client compatibility but ignored. Tokenless emits no usage frame because it cannot measure provider tokens.

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

Tool requests always use this request-scoped full-history behavior, regardless of the configured conversation mode. The catalog, nonce, and untrusted canonical history are compiled into a strict one-turn protocol envelope.

**Client implication:** send full history on every call, exactly as you would to a real API. Nothing else to do.

### continue-conversation

Tokenless fingerprints every message *except the final user turn* (SHA-256 over role/text pairs), uses that as a durable thread identity, and reuses one provider conversation for it. On a hit, only the final user message is typed into the existing conversation. On a miss, it starts a new conversation with the full flattened transcript.

Cheaper and closer to how a person uses the site. But the fingerprint is exact:

**Client implication — this is the part to get right.** Any change to prior history starts a new conversation. That includes trimming old turns to fit a context budget, editing a system prompt, renumbering, reformatting whitespace, or normalizing your own assistant text before resending. All of these silently fork a new provider conversation rather than continuing.

If your client rewrites history at all, prefer `new-conversation` — you get the same result without paying for surprise forks. Use `continue-conversation` only when you append and never mutate.

## Errors

Every failure returns the dialect's own error envelope.

For a tool request only, one narrow failure may receive a bounded correction on the same provider and execution strategy: safe marker/chrome framing must already identify this request's protocol, nonce, and `kind: final` in exact order, while strict JSON parsing fails on final-content escaping. Framing, correlation, duplicate-key, tool-call, argument/schema, and valid-envelope shape failures return `provider_output_protocol_error` immediately. The correction must return the same final outcome and is validated once; transport failures, timeouts, ambiguous submissions, exposed calls, and caller tool execution are never retried.

OpenAI, where `param` names the offending field when there is one:

```json
{"error":{"message":"...","type":"invalid_request_error","param":"messages","code":"invalid_request_error"}}
```

Anthropic:

```json
{"type":"error","error":{"type":"invalid_request_error","message":"..."}}
```

### Status codes

The status is the signal to branch on. Read `code` for the specific cause and treat `message` as human-readable only.

| Status | Code | Cause | Retry? |
| --- | --- | --- | --- |
| 400 | `invalid_request_error` | Malformed body, tool catalog, arguments, or unpaired history | No — fix the request |
| 400 | `invalid_json` | Body is empty or not JSON | No |
| 400 | `unsupported_parameter` | Legacy functions, structured output, non-`auto` choice, or parallel calls | No |
| 401 | `control_auth_missing` | No bearer token | No |
| 403 | `control_auth_rejected` | Wrong bearer token | No |
| 404 | `model_not_found` | `model` names a provider that does not exist or is not built in | No |
| 413 | `request_too_large` | Body exceeds 2 MiB | No |
| 499 | `client_closed_request` | The client disconnected first | No — nobody is listening |
| 500 | — | Local daemon fault, message deliberately generic | Yes, once |
| 502 | `upstream_error` | The provider page produced no visible reply: sign-in blocker, CAPTCHA, or a failed job | Yes, after the user clears the blocker |
| 502 | `provider_output_protocol_error` | Tool protocol validation failed; only a correlated `kind: final` string-escaping failure receives one bounded correction | No further retry |
| 503 | `api_proxy_disabled` | The proxy is off | No — enable it |
| 503 | `profile_not_ready` | The managed profile needs `tokenless setup` | No — finish setup |
| 503 | `model_not_available` | The provider is not enabled for the resolved profile | No — enable it |
| 504 | `completion_timeout` | The provider did not answer within 10 minutes | Yes, but the original job may still be running |

A `4xx` other than 499 means the caller must change something. A `502`, `504`, or `500` is operational: the same request may succeed later. That distinction is the whole point of the table — do not match on message strings.

On `502` and `504` the underlying browser job is **not** cancelled and may still complete. Inspect it with `tokenless state --job-id <id> --json` before retrying, or you may queue duplicate provider work.

## Hard limits

Design around these, not against them.

| Property | Reality |
| --- | --- |
| Latency | Seconds to minutes. Real browser navigation, page settle, typing, submit, and render. |
| Timeout | 10 minutes, then 504. The underlying job may still be running — check `job_id`. |
| Concurrency | Effectively serial per profile. One browser, one provider tab. |
| Tool use | One modern function call, non-streaming or terminal SSE; caller executes it. |
| Structured output | Unsupported, rejected. |
| Sampling control | Silently ignored. |
| Token accounting | None. |
| Multimodal input | Text only. |

Route human-paced Q&A and single external-tool turns through this. Keep structured final output, multiple calls, low latency, and parallelism on another route.

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
    max_retries=0,  # retry deliberately on 500/502/504 only; see the errors section
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
- [ ] For tools, send modern `tools`, use `tool_choice: auto`, set `parallel_tool_calls: false`, execute calls outside Tokenless, and resend complete paired history.
- [ ] Keep `strict: true`, `functions`, `function_call`, `response_format`, and multiple calls on another route.
- [ ] Treat `stream_options` as ignored and do not expect a usage frame.
- [ ] Do not depend on `temperature`, `max_tokens`, or any sampling field.
- [ ] Do not read `usage` for cost.
- [ ] Raise client timeout above 10 minutes; set retries to 0 and handle retries yourself.
- [ ] Branch on HTTP status, not on `message`: retry only `500`, `502`, and `504`.
- [ ] Before retrying a `502` or `504`, check `job_id` — the original job may still be running.
- [ ] Log `tokenless.job_id` on every call.
- [ ] Expect serial execution; do not fan out concurrent requests.
- [ ] Confirm the active conversation mode, and if the client rewrites history, use `new-conversation`.

## Verified DeepSeek tool loop

The packaged daemon completed a non-streaming single-tool loop through the real DeepSeek browser route:

- Job `8a709343-5fd4-46b4-801c-434c5b4a8da0` returned a standard assistant `tool_calls` response for `read_file` with `package.json`.
- The caller executed the local tool and returned its actual result as paired `role: tool` history.
- Job `8a3d2c42-e05c-478f-8518-22acb5a39467` returned a final `finish_reason: stop` answer grounded in that package metadata.

An [unmodified DSH streaming run](evidence/dsh-streaming-tool-loop-2026-08-15.md) then completed two sequential single tool turns and a grounded final answer through the packaged daemon and real DeepSeek browser route. DSH reconstructed stable ids, names, index 0, complete arguments, terminal `tool_calls`, and `[DONE]`; DSH—not Tokenless—executed both tools.

## Known gaps

Two things a client should still not rely on:

- **A `502` does not say why the page failed.** A sign-in blocker, a CAPTCHA, and a genuinely failed job all report `upstream_error`. Use `job_id` to find out which.
- **A timeout or disconnect leaves the browser job running.** Nothing cancels provider-side work on your behalf, so a naive retry can queue a second job for the same prompt.

## Reference

- [CLI commands](../COMMANDS.md#tokenless-api-proxy) — `tokenless api-proxy`
- [OpenAPI contract](../api/tokenless-daemon-api.openapi.json) — request and response schemas
- [Architecture](architecture.md) — execution path and trust boundaries
- [Privacy boundaries](../PRIVACY.md) — what stays local
