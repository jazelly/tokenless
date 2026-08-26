# Tokenless API Proxy Integration

How to call the Tokenless local API proxy from an existing project. Written for an implementer who already has OpenAI- or Anthropic-shaped code and wants that traffic served by a visible provider website instead of a paid API.

## What this is

The Tokenless daemon exposes OpenAI- and Anthropic-compatible HTTP routes. A request creates a local job record, an in-process Playwright worker types the prompt into a real provider page in a signed-in browser profile, and the visible reply is returned in the wire shape your client already expects.

**This is a task-level bridge, not a drop-in API replacement.** Read [Hard limits](#hard-limits) before designing around it. Browser-backed requests trade throughput and latency for cost; direct G4F plain-text requests can preserve upstream incremental streaming.

For the provider-side contract that the proxy maps onto, see [Provider Tool-Calling Conformance](provider-tool-calling-conformance.md). It separates official provider documentation from Tokenless's exact live evidence and does not claim native browser tool endpoints.

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

Do not hardcode it. Read `apiProxy.endpoints` from `tokenless api-proxy status --json` — keys `openai`, `openaiDefault`, `anthropic`, and `images` — which already accounts for a custom `daemonUrl` in the config.

| Client style | Base URL |
| --- | --- |
| OpenAI-compatible | `http://127.0.0.1:7331/v1/openai` |
| OpenAI-compatible, default paths | `http://127.0.0.1:7331/v1` |
| Anthropic-compatible | `http://127.0.0.1:7331/v1/anthropic` |

The bare `/v1` base exists so clients that use `/v1/chat/completions` or `/v1/responses` work without modification. These are aliases: same dialect, same behavior. Anthropic has no bare alias, because the two dialects would collide on one path.

### Default execution mode for mode-agnostic clients

The request field `tokenless.execution_mode` is optional. If a harness cannot send it, set the persisted `apiProxy.executionMode` in the selected Tokenless config instead:

```json
{
  "apiProxy": {
    "executionMode": "browser"
  }
}
```

Valid values are `browser` and `direct`. The config value applies only when the request omits a mode; an explicit request field still wins. This is the path used by the local DeepSeek Completion API demo.

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
| POST | `/v1/openai/responses` | OpenAI Responses |
| POST | `/v1/responses` | Alias of the above |
| GET | `/v1/openai/models` | List accepted model names |
| GET | `/v1/models` | Alias of the above |
| POST | `/v1/anthropic/messages` | Anthropic message |
| POST | `/v1/images/generations` | Unified browser or direct image generation |

## Image generation

`POST /v1/images/generations` is the canonical image-generation input for both execution modes. The request selects `browser` or `direct`; it never names an internal provider backend.

```json
{
  "model": "tokenless/auto",
  "prompt": "A flat green leaf icon on white.",
  "tokenless": {
    "execution_mode": "browser",
    "profile": "default",
    "task_id": "task-123"
  }
}
```

Browser `tokenless/auto` considers only enabled, currently usable providers with complete `image.generation` and `artifact.download` capability routes. Use `tokenless/<provider>` to select one exact browser provider.

Browser requests may include one `reference_image` as a PNG, JPEG, or WebP base64 data URL. The decoded image is limited to 8 MiB; remote image URLs and direct-mode reference images are rejected. Reference requests require the provider's complete `image.edit`, `image.input`, `file.upload`, and `artifact.download` route. Arena is the only currently advertised browser route with that real-provider closure.

```json
{
  "model": "tokenless/arena",
  "prompt": "Change the background to pale yellow.",
  "reference_image": "data:image/png;base64,iVBORw0KGgo...",
  "tokenless": {
    "execution_mode": "browser",
    "profile": "default",
    "task_id": "task-124"
  }
}
```

Direct V1 accepts `tokenless/auto`, `tokenless/pollinations`, or `tokenless/pollinations/sana`; `size` may be omitted or set to `768x768`. The private implementation is not part of the public schema or response.

Both modes return `data[].url` under the authenticated `/v1/private/assets/...` route and common `data[].asset` metadata. Browser auto selects the highest-ranked eligible route; cross-provider fallback remains unavailable because image surfaces require provider-specific actions.

## Model naming

Use a fixed provider model when the caller owns provider selection:

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

### Explicit auto routing

`tokenless/auto` is a reserved opt-in model on OpenAI Chat Completions and Responses. It is not an alias for ordinary chat and never changes the behavior of an exact `tokenless/<provider>` request.

The current scope is deliberately narrow:

- Browser execution without provider-local backend or auth options. Plain text uses enabled providers with currently usable observed access through an eligible `conversation.chat` route; function-tool and JSON requests additionally use the narrow structured-control evidence matrix.
- Candidates must be enabled on the selected profile and satisfy the route requirements for the request.
- Tool requirements distinguish calls, strict schemas, complete tool history, and multiple-call output. `parallel_tool_calls: true` requires multiple-call evidence only when the current `tool_choice` may return multiple calls; `none` and an exact named choice do not.
- DeepSeek is admitted for evidenced multiple/strict/history and JSON control. ChatGPT is admitted for evidenced single-call strict/history and JSON control. Gemini tool control is excluded because its real outputs failed the strict whole-response boundary. The current two-provider routing and schema runs are recorded in [redacted evidence](evidence/openai-auto-provider-routing-2026-08-15.md).
- Unsupported direct execution, provider backend/auth options, opaque replay, or an incomplete candidate set fails before a job is created.

Auto calls use versioned opaque public ids that encode only their provider origin. A later full-history turn prefers that provider after rechecking current eligibility; a caller-influenced id cannot bypass the filter. Responses `previous_response_id` uses its existing ledger provider the same way—as portable affinity, not a hard pin.

Provider switching always starts a new target-provider conversation with the exact canonical assistant call and caller result. Provider URLs and opaque state are never replayed. The existing Managed Playwright fallback plan may switch before `provider_submitted_at`; its sole post-submission exception is `tokenless/auto` reporting the provider-scoped terminal code `provider_rate_limited` before any visible response, which restarts from the target provider home and records one bounded `rate_limit` routing attempt. Every other malformed, failed, ambiguous, timed-out, canceled, or waiting-for-user post-submission outcome is terminal. The bounded final-escaping correction stays on the settled provider and strategy with no auto resolution or fallback.

For a private provider-turn continuation, `tokenless/auto` keeps the settled provider conversation and exact mapping as the primary target. Only the exact portable action sequence `file.upload` → `prompt.input` → `prompt.submit` → `response.read` may carry currently eligible auto alternatives from provider-home targets; `conversation.continue` routes and nonportable actions do not receive fallback alternatives. An exact provider binding remains pinned with no fallback.

An OpenAI `tokenless/auto` request may include an advisory `tokenless.semantic_preference` provider id:

```json
{
  "model": "tokenless/auto",
  "messages": [{"role": "user", "content": "Hello"}],
  "tokenless": {
    "execution_mode": "browser",
    "semantic_preference": "chatgpt"
  }
}
```

The preference only stably reorders a provider within the operation router's highest current eligibility tier after access, capability, and structured-control checks. It cannot move a stale `unchecked` provider ahead of a freshly observed `eligible` provider. An unknown, unavailable, or ineligible preference is ignored without enabling or pinning that provider; exact `tokenless/<provider>` requests and non-`auto` requests reject the field. The response `tokenless.routing` object and `X-Tokenless-Route-Preference-*` headers expose the bounded requested id and whether it was selected as the initial route (`1` or `0`); a later safe fallback may still change the final provider.

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

Modern OpenAI function tools are accepted for non-streaming and streaming requests. `parallel_tool_calls` defaults to `true`; set it to `false` when the current assistant outcome must contain at most one call:

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

`tool_choice` and `parallel_tool_calls` combine as follows:

- Omitted or `"auto"`: return final text or one or more declared calls; `parallel_tool_calls: false` limits calls to one.
- `"none"`: return final text only.
- `"required"`: return at least one declared call; `parallel_tool_calls: false` limits calls to one.
- `{"type":"function","function":{"name":"read_file"}}`: return exactly one call of that declared function, regardless of the parallel setting.

Prompt-emulated tool support is strategy-specific. Gemini prompt-emulated tool selection is not currently advertised: three real packaged-daemon submissions observed no prompt-injection refusal, but each prepended prose before an otherwise JSON-like answer and therefore failed the strict whole-response boundary. See the [redacted framing evidence](evidence/openai-tool-prompt-framing-2026-08-15.md).

For `strict: true`, the parameters root must be an object. Every object schema, including nullable nested objects, must set `additionalProperties: false` and list every property key in `required`; represent optional fields with a nullable type. Tokenless rejects malformed strict schemas before provider submission and validates returned arguments against the declared schema.

The caller executes returned tools. On the next request, resend the same catalog, the assistant call array in its original order, and one contiguous result for every call. Results may arrive in a different order when their ids make the pairing unambiguous:

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

Tokenless validates unique call ids, declared names, strict argument JSON, argument schemas, and exactly one result per call before provider submission. It never executes caller tools or stores their catalog.

#### Structured final output

`response_format` controls only a final assistant result. Intermediate outcomes may still contain `tool_calls`; resend those calls, the actual caller-owned tool results, the same tool catalog, and the same response format to request the structured final.

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

- Omitted or `{"type":"text"}` preserves ordinary final text.
- `{"type":"json_object"}` returns exactly one strict JSON object as `message.content`.
- `json_schema` returns the original valid JSON text only after it passes the accepted schema. `name` uses the function-name rule (1–64 letters, numbers, `_`, or `-`); `description` is a string and `strict` is a boolean when present.

The accepted schema root is exactly `{"type":"object"}`. Every object, including nested nullable objects, must use `additionalProperties: false` and list every property in `required`; this rule applies whether `json_schema.strict` is true or false.

| Supported schema keywords | Scope |
| --- | --- |
| `type`, `properties`, `required`, `additionalProperties` | String types and nullable type arrays are accepted; every object is closed |
| `items`, `minItems`, `maxItems` | Arrays |
| `enum`, `const`, nested `anyOf` | `anyOf` is not accepted at the root |
| `title`, `description` | Annotations |
| `minLength`, `maxLength`, `pattern`, `format` | Strings; `format` must be known to the bundled AJV formats validator |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | Numbers |

Every unlisted keyword is rejected before a job is created. In particular, `$defs`, `$ref`, `oneOf`, `allOf`, `not`, conditionals, and `patternProperties` are not part of this V1 subset.

Structured JSON numbers must be finite and use the unique spelling returned by `JSON.stringify(Number(token))`; integral values must be within JavaScript's safe integer range. Noncanonical spellings such as `1.0` or `1e3` fail with `provider_output_protocol_error` when their canonical forms are `1` or `1000`. Numeric schema values in `enum`, `const`, bounds, length/item limits, and `multipleOf` follow the same finite/safe-integer admission rule, including numbers nested inside `enum` or `const` data.

### OpenAI Responses

`POST /v1/responses` and `/v1/openai/responses` map the current official [function-calling](https://developers.openai.com/api/docs/guides/function-calling) and [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create) shapes onto the same Tokenless validation and provider turn as Chat Completions.

- `input` accepts a non-empty string or up to 256 text items: user/system/developer/assistant messages, Tokenless output `message` items, `function_call`, and string `function_call_output`.
- Function tools are flat: `{type, name, description?, parameters, strict?}`. `tool_choice` is `auto`, `none`, `required`, or `{type:"function",name}`.
- `text.format` accepts `text`, `json_object`, or flat `json_schema` with the same published schema subset above.
- Tokenless validates every declared name, strict argument, unique `call_id`, and complete call/output pairing before provider submission. It never executes caller tools.

Non-streaming output contains an assistant `message` or model-ordered `function_call` items. A function item has a distinct item `id` and stable public `call_id`; reply with `{type:"function_call_output",call_id,output}`.

Streaming is typed and terminal for browser/native and structured requests. It emits `response.created`, `response.in_progress`, item/content events, full reconstructable argument or text deltas, done events, and `response.completed`. A direct G4F plain-text request instead forwards the upstream SSE body unchanged; it does not emit Tokenless-generated Responses events, is not recorded in the Tokenless response ledger, and does not support `previous_response_id` continuation. Neither path fabricates usage.

Continue in either official form:

1. Full-input replay: append the prior `response.output` and caller-owned result to the original input, and resend the same current `tools` catalog.
2. Ledger continuation: send the result as `input` with `previous_response_id`, and resend the same current `tools` catalog.

The ledger does not persist tool definitions. Both forms validate history against the `tools` catalog in the current request.

The local ledger stores canonical public transcript items in `tokenless.sqlite3` without expiry or count eviction. Unknown ids return `response_not_found`; a daemon restart does not erase a known response. It stores no credentials, browser session, hidden reasoning, or fabricated opaque item. Changing provider, exact model, or execution mode returns `response_route_mismatch` before submission. This prompt-emulated route produces no provider opaque/reasoning items, so unknown reasoning or opaque replay fails with `unverifiable_replay_item`.

For `tokenless/auto`, a portable ledger continuation may select another eligible provider on the next caller turn. Exact provider models remain hard provider/model/execution affine.

Responses V1 intentionally excludes Conversations, background mode, WebSockets, hosted tools, retrieve/delete, non-text inputs, and array-valued function outputs.

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
| `stream` | Honored for text and function tool calls |
| `stream_options` | Accepted and ignored; no streaming usage is fabricated |
| `tools` | Modern OpenAI function tools honored for one or more calls |
| `tools[].function.strict` | Boolean; `true` requires recursive closed objects with every property required |
| `tool_choice` | Omitted/`auto`, `none`, `required`, or one exact declared function |
| `parallel_tool_calls` | Boolean; omitted/`true` permits multiple current-turn calls, `false` permits at most one |
| `response_format` | Omitted/text, `json_object`, or the documented `json_schema` subset |
| `functions`, `function_call` | **Rejected with 400** |
| `temperature`, `top_p`, `max_tokens`, `seed`, `stop`, everything else | **Silently ignored** |

Deprecated function fields remain fail-closed. Structured final output is available only through the exact formats and schema subset above; unsupported shapes are never silently ignored.

The ignored group is the sharper trap: **sampling parameters have no effect.** `temperature: 0` does not make the provider deterministic, and `max_tokens` does not bound the reply. If your code depends on either, the proxy is the wrong transport for that call path. `max_tokens` is ignored rather than rejected only because the Anthropic API requires it.

### Size limits

| Limit | Value |
| --- | --- |
| HTTP body | 2 MiB |
| `messages` entries | 256 |
| Flattened prompt text | 1 MiB |
| Function tools | 128 |
| Calls in one assistant outcome | 128 |
| One function parameter schema | 64 KiB |
| One structured final schema | 64 KiB |
| Structured JSON nesting / properties | 48 levels / 10,000 properties |

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
    "execution_mode": "browser",
    "provider_backend": "browser",
    "structured_control_strategy": null,
    "citations": [{"url": "https://example.com", "title": "Example"}]
  }
}
```

A validated call group uses the standard OpenAI shape in model order. Tokenless allocates unique public ids only after validating the complete provider output; accompanying assistant content is preserved:

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

OpenAI text uses `finish_reason: stop`; a validated function call uses `finish_reason: tool_calls`. Anthropic `stop_reason` remains `end_turn`.

### usage is always zero

Not a bug and not a placeholder to be filled in later. Tokenless does not meter provider tokens — the reply is billed by your web subscription, so there is no count to report. Reporting a fabricated estimate would be worse than reporting none.

If you need a savings figure, use `tokenless savings status --json`, which measures visible output separately with a pinned tokenizer. Do not derive spend from `usage`.

### The tokenless object

| Field | Use |
| --- | --- |
| `provider` | Which provider actually answered, including the settled fallback provider |
| `job_id` | Job id — pass to `tokenless state --job-id <id> --json` to inspect what happened |
| `conversation_mode` | Actual route: `new-conversation` for fresh/mapping-miss requests, or `continue-conversation` for a mapped Responses continuation |
| `execution_mode` / `provider_backend` | Actual execution route |
| `structured_control_strategy` | `prompt_tool_envelope`, `prompt_json_envelope`, or `null` for plain text |
| `citations` | Visible source links, when the provider rendered any |

Log `job_id`. It is the only handle that ties a client-side failure to the local job record.

## Streaming

`stream: true` returns `text/event-stream`. Browser/native and structured requests use the documented terminal event sequence; direct G4F plain-text requests forward each upstream body chunk in order as it arrives.

Direct G4F Chat Completions preserve the provider's original SSE frames, including `[DONE]`. Direct G4F Responses use the provider's upstream SSE body as well; these raw streams are not recorded for Tokenless `previous_response_id` continuation. Callers that require Tokenless's typed Responses event sequence or ledger continuation should use browser/native or a structured request.

OpenAI frames:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","content":"<full text>"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

A validated tool-call group uses the same terminal delivery model. Its first frame contains every call with stable indexes `0..n-1`, unique ids, names, and complete arguments strings; any accompanying content is in the same delta. A second frame carries `finish_reason: "tool_calls"`, followed by `[DONE]`:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","content":"I will inspect both.","tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"package.json\"}"}},{"index":1,"id":"call_...","type":"function","function":{"name":"search_files","arguments":"{\"path\":\"packages\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

`stream_options` is accepted for client compatibility but ignored. Tokenless emits no usage frame because it cannot measure provider tokens.

A structured final uses the same full-content delta, `finish_reason: "stop"`, and `[DONE]`. Its `content` is the complete validated JSON text; no usage frame is added.

Anthropic frames, in order: `message_start`, `content_block_start`, `content_block_delta` (carries the full text), `content_block_stop`, `message_delta`, `message_stop`.

For browser/native and structured requests, do not build a progress indicator off the terminal frames. Direct G4F plain-text streams can drive progress from each received upstream chunk.

## Conversation state

The persisted `conversationMode` option is retained for configuration and status compatibility, but it does not select the API protocol. API behavior follows the endpoint contract and the fields present in each request.

### Chat Completions and Anthropic

Every Chat Completions or Anthropic request starts a fresh provider conversation and sends the complete request history. The provider website owns the state of that new chat; Tokenless does not infer a thread by hashing caller messages. Configure the client exactly as you would for a stateless Chat Completions API: send the history you want the provider to see on every call.

### Responses

`POST /v1/responses` starts a fresh provider conversation and sends the complete reconstructed input when `previous_response_id` is omitted. The response id is also used as the managed provider-task identity, so a later successful browser turn can be resumed without adding a database schema or a CLI-specific chat id.

When `previous_response_id` is valid, route-compatible, and has a proved provider-task mapping, Tokenless opens the mapped canonical provider URL and sends only the current `input`. A missing mapping is safe: Tokenless starts a fresh provider conversation with the full reconstructed transcript and establishes a new response-task identity for that turn.

Structured/tool continuation follows the same rule. The mapped turn contains the current tool result or message delta and the current tool catalog; prior user and assistant content is not replayed into the existing provider chat. Full-input replay remains available when the caller intentionally wants a new provider conversation, such as after context compaction.

The response `tokenless.conversation_mode` value reports the actual route: `new-conversation` for fresh or mapping-miss turns, and `continue-conversation` only for a mapped Responses continuation. The CLI `--conversation-mode` value does not override these endpoint rules.

## Errors

Every failure returns the dialect's own error envelope.

For a tool or structured-final request, one narrow failure may receive a bounded correction on the same provider and execution strategy: bare raw JSON, or the unwrapped content of one permitted complete fence, must already start with this request's exact protocol, nonce, and a `kind: final` or `kind: tool_calls` field, but fail strict JSON parsing. Duplicate-key failures are excluded. The corrected response must retain the same kind and pass the original catalog, choice, call-count, argument/schema, and response-format validation; there is no second correction. Prose, multiple fences, correlation, parsed-envelope shape, tool-choice, call-count, argument/schema, and valid structured-content failures return `provider_output_protocol_error` immediately. Transport failures, timeouts, ambiguous submissions, exposed calls, and caller tool execution are never retried.

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
| 400 | `invalid_request_error` | Malformed body, tool catalog, tool choice, response format/schema, arguments, or unpaired history | No — fix the request |
| 400 | `invalid_json` | Body is empty or not JSON | No |
| 400 | `unsupported_parameter` | Legacy `functions` / `function_call`, or Anthropic tools/structured output | No |
| 400 | `auto_execution_mode_unsupported` / `auto_dialect_unsupported` | Auto was asked to use direct/provider-local/Anthropic state | No — use the documented OpenAI browser scope |
| 401 | `control_auth_missing` | No bearer token | No |
| 403 | `control_auth_rejected` | Wrong bearer token | No |
| 404 | `model_not_found` | `model` names a provider that does not exist or is not built in | No |
| 413 | `request_too_large` | Body exceeds 2 MiB | No |
| 499 | `client_closed_request` | The client disconnected first | No — nobody is listening |
| 500 | — | Local daemon fault, message deliberately generic | Yes, once |
| 502 | `upstream_error` | The provider page produced no visible reply: sign-in blocker, CAPTCHA, or a failed job | Yes, after the user clears the blocker |
| 502 | `provider_output_protocol_error` | Tool or structured-final validation failed; only a nonce-correlated strict JSON serialization failure for `final` or `tool_calls` receives one same-kind bounded correction | No further retry |
| 503 | `api_proxy_disabled` | The proxy is off | No — enable it |
| 503 | `model_not_available` | The provider is not enabled for the resolved profile | No — enable it |
| 503 | `auto_route_unavailable` | No enabled, currently usable provider satisfies the conversation or structured-control route | No — change scope or provider readiness |
| 504 | `completion_timeout` | The provider did not answer within 10 minutes; the exact local job was canceled | Check the response and job evidence before deciding |

A `4xx` other than 499 means the caller must change something. A `502`, `504`, or `500` is operational: the same request may succeed later. That distinction is the whole point of the table — do not match on message strings.

On a client disconnect (`499`), Tokenless cancels the exact local job when it is queued, running, or waiting for user input. A completion timeout (`504`) applies only to queued or running jobs and cancels that exact job; a `waiting_for_user` job instead returns an immediate `502` and remains intact for explicit user intervention. If a timeout races a terminal success or failure, that real terminal job is returned instead. Neither path replays the submitted prompt or switches providers after submission.

## Hard limits

Design around these, not against them.

| Property | Reality |
| --- | --- |
| Latency | Seconds to minutes. Real browser navigation, page settle, typing, submit, and render. |
| Timeout | 10 minutes; the exact local job is canceled before 504 unless it wins a race to a terminal success or failure. |
| Concurrency | Effectively serial per profile. One browser, one provider tab. |
| Tool use | One or more modern function calls, non-streaming or terminal SSE; caller executes them. |
| Structured output | OpenAI `json_object` and the documented closed-object `json_schema` subset; valid final JSON or explicit error. |
| Shared validation boundary | The Universal API and Standalone Web Agent Harness use the same strict JSON parser and JSON Schema validator setup. Their response grammars and execution ownership remain separate. |
| Sampling control | Silently ignored. |
| Token accounting | None. |
| Multimodal input | Text only. |

Route human-paced Q&A, external-tool turns, and bounded structured finals through this. Use `tokenless.execution_mode: direct` with the default `g4f` backend for low-latency plain-text incremental streaming.

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

Note both SDKs need their default timeout raised and their retry count zeroed. Default retries on a 10-minute request can start duplicate browser executions.

## Implementation checklist

- [ ] Read base URL from `tokenless api-proxy status --json`, not a constant.
- [ ] Read the token from `~/.tokenless/daemon.token`; never log it.
- [ ] Name models `tokenless/<provider>`; validate against `GET /v1/openai/models`.
- [ ] For tools, send modern `tools`, choose the required `tool_choice` and parallel setting, execute every call outside Tokenless, and resend complete paired history.
- [ ] For `strict: true`, use an object root, close every object with `additionalProperties: false`, require every property, and use nullable types for optional values.
- [ ] Keep `functions`, `function_call`, and `response_format` on another route.
- [ ] Treat `stream_options` as ignored and do not expect a usage frame.
- [ ] Do not depend on `temperature`, `max_tokens`, or any sampling field.
- [ ] Do not read `usage` for cost.
- [ ] Raise client timeout above 10 minutes; set retries to 0 and handle retries yourself.
- [ ] Branch on HTTP status, not on `message`: retry only `500`, `502`, and `504`.
- [ ] On `499` or `504`, expect the exact local job to be canceled; never replay or switch providers after submission.
- [ ] Log `tokenless.job_id` on every call.
- [ ] Expect serial execution; do not fan out concurrent requests.
- [ ] For Chat Completions/Anthropic, send full history on every request; for Responses, omit `previous_response_id` when starting a fresh provider chat and use it only for a mapped continuation.

## Verified DeepSeek tool loop

The packaged daemon completed a non-streaming single-tool loop through the real DeepSeek browser route:

- Job `8a709343-5fd4-46b4-801c-434c5b4a8da0` returned a standard assistant `tool_calls` response for `read_file` with `package.json`.
- The caller executed the local tool and returned its actual result as paired `role: tool` history.
- Job `8a3d2c42-e05c-478f-8518-22acb5a39467` returned a final `finish_reason: stop` answer grounded in that package metadata.

An [unmodified DSH streaming run](evidence/dsh-streaming-tool-loop-2026-08-15.md) then completed two sequential single tool turns and a grounded final answer through the packaged daemon and real DeepSeek browser route. DSH reconstructed stable ids, names, index 0, complete arguments, terminal `tool_calls`, and `[DONE]`; DSH—not Tokenless—executed both tools.

An [unmodified DSH multiple-call run](evidence/openai-multiple-tool-calls-deepseek-2026-08-15.md) later reconstructed stable indexes 0 and 1 in one assistant outcome, executed both real reads, replayed both results, and received a grounded final. A separate real non-streaming request preserved short assistant content beside two model-ordered calls.

## Known gaps

Two things a client should still not rely on:

- **A `502` does not say why the page failed.** A sign-in blocker, a CAPTCHA, and a genuinely failed job all report `upstream_error`. Use `job_id` to find out which.
- **A timeout or disconnect cancels the exact local job.** Provider-side work that was already submitted is not replayed or switched to another provider, so a caller must decide explicitly whether a new request is appropriate.

## Reference

- [CLI commands](../COMMANDS.md#tokenless-api-proxy) — `tokenless api-proxy`
- [Unified OpenAPI contract](../packages/contracts/tokenless.openapi.json) — compatibility, private machine, Dashboard, and readiness request/response schemas
- [Architecture](architecture.md) — execution path and trust boundaries
- [Privacy boundaries](../PRIVACY.md) — what stays local
