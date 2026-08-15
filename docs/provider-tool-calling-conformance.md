# Provider Tool-Calling Conformance Reference

This is the compact provider-side reference for Tokenless's Universal API. It records current official contracts, the smallest canonical mapping, and the evidence boundary for Tokenless claims. It is not a claim that a browser provider page exposes its own API endpoint.

Version context: checked 2026-08-15 against the current official documentation pages and official SDK type/source references linked below. Documentation is normative external evidence; SDK links corroborate public type names and serialization. No proprietary server implementation is assumed.

## Contract at a glance

| Provider | Model-side tool shape | Tool-result/history shape | Streaming identity | Schema/tool-choice guarantee |
| --- | --- | --- | --- | --- |
| OpenAI Responses / Chat Completions | Responses emits `function_call` output items with `id`, `call_id`, `name`, and JSON-encoded `arguments`; Chat Completions uses assistant `tool_calls`. | Responses accepts `function_call_output` input items keyed by `call_id`; the caller appends the returned output items before continuing. | `response.output_item.added` identifies the output item; argument fragments use `response_id`, `item_id`, and `output_index`; `...arguments.done` and `response.output_item.done` close the call. | `strict: true` constrains function arguments; `tool_choice` supports auto/required/named/none (and allowed tools in Responses); `parallel_tool_calls: false` limits the turn to zero or one call. |
| Anthropic Messages | Assistant `content` contains ordered `tool_use` blocks (`id`, `name`, `input`) and ends with `stop_reason: tool_use`. | The caller sends one next `user` message containing one `tool_result` for every client call, keyed by `tool_use_id`; results must precede any text in that message and may carry `is_error`. | SSE uses `content_block_start`, `content_block_delta`, `content_block_stop`, then `message_delta` with `stop_reason: tool_use`, followed by `message_stop`. Tool input fragments are `delta.partial_json` where `delta.type` is `input_json_delta`. | `strict: true` uses grammar-constrained sampling for schema-valid input. Multiple blocks are allowed by default; `disable_parallel_tool_use` lives inside `tool_choice`. |
| Gemini Interactions / Generate Content | Current Interactions docs expose `function_call` steps (`id`, `name`, `arguments`); the Generate Content dialect exposes `functionCall`/`functionResponse` parts. | Interactions returns `function_result` with `call_id`, normally using `previous_interaction_id`; stateless callers replay the exact user input, all model steps, and result. Generate Content replays model parts and function responses. | Interactions streams typed `step.delta` events. Generate Content streams candidates/parts; thinking models may attach `thoughtSignature` to a function-call part. | Interactions `tool_choice` supports `auto`, `any`, `none`, and `validated`, with allowed-tool restriction. Structured final output uses `response_format` with JSON MIME type and schema. |
| DeepSeek Chat Completions | OpenAI-shaped assistant `tool_calls`; function `arguments` is a JSON string and the API can return `finish_reason: tool_calls`. | The caller appends the assistant message and `role: tool` messages keyed by `tool_call_id`. | OpenAI-shaped SSE chunks terminate with `data: [DONE]`; partial deltas must be assembled before validation. | `tool_choice` supports none/auto/required/named. `strict` is a Beta feature on the Beta base URL; without strict, Tokenless still parses and validates returned arguments before exposing a call. |
| vLLM OpenAI-compatible server | The server translates model-specific output through a selected tool parser and chat template. | The chat template must render `tool` messages and assistant messages containing prior calls; this is model/template-specific. | The OpenAI-compatible response is assembled from the parser's model-specific extraction. | Auto choice requires `--enable-auto-tool-choice`, a parser, and a compatible chat template. Named/required choice uses structured outputs; auto only gets schema-constrained arguments when a tool opts into `strict: true`. |

The same word “tool call” therefore hides different wire contracts. Tokenless canonical history keeps public call identity, tool name, raw argument JSON, result pairing, and ordering; each provider adapter owns its local item/block/part IDs and opaque continuation state.

## Provider details and implementation consequences

### OpenAI

The official function-calling guide separates three objects: the tool definition supplied by the application, a model-generated call, and the caller-produced result. Responses returns one or more `function_call` output items; the result is a `function_call_output` item keyed by `call_id`. The official streaming example uses `response.output_item.added`, argument deltas keyed by `item_id`/`output_index`, and final `response.output_item.done`.

`strict: true` is not merely a post-hoc validator: the guide says it guarantees adherence and requires `additionalProperties: false` plus every property listed in `required`; optional values are represented as nullable. Responses may normalize an omitted strict flag when possible, while Chat Completions remains non-strict by default, so Tokenless must preserve the caller's explicit strictness instead of inferring it from provider defaults.

The OpenAI SDK's generated Responses types separately expose `ResponseFunctionToolCall`, `ResponseFunctionCallArgumentsDeltaEvent`, `ResponseFunctionCallArgumentsDoneEvent`, `ResponseOutputItemAddedEvent`, and `ResponseOutputItemDoneEvent`. The separate `id` and `call_id` fields are a useful provider-side precedent: Tokenless must not collapse response-item identity into the caller-visible call ID.

Sources: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [official openai-node Responses types](https://github.com/openai/openai-node/blob/main/src/resources/responses/api.md).

### Anthropic

Anthropic puts tool use inside the message content block array rather than introducing an OpenAI-style `tool` role. An assistant response can contain text and one or more `tool_use` blocks; the caller executes client tools and sends a single following user message containing all matching `tool_result` blocks before any text. Each result is paired by `tool_use_id`; `is_error: true` is the documented way to report a failed or skipped client call.

The streaming contract is block-oriented: start a block, append `content_block_delta` events whose `delta.type` is `input_json_delta` and whose fragment is in `delta.partial_json`, stop the block, then read the message-level `stop_reason`. Parallel execution order is the caller's decision, but every call in the assistant block group still needs one result in the next user message. `strict: true` applies grammar-constrained sampling to the declared JSON Schema subset; it does not transfer execution authority to Anthropic's model.

Sources: [Anthropic handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Anthropic streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming), [Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use), [Anthropic strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use), [official Anthropic SDK type index](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/api.md).

### Gemini

Google currently documents both an Interactions surface and the Generate Content surface. They are not interchangeable spellings: Interactions uses `function_call`/`function_result` steps and `previous_interaction_id`; Generate Content uses `functionCall`/`functionResponse` parts in `contents`. A portability layer must choose one dialect per request and must not serialize an Interactions step as if it were a Generate Content part.

The provider supports `auto`, `any`, `none`, and `validated` tool-choice modes, allowed-tool restrictions, parallel function calls, and compositional multi-step calls. Its structured final output is a separate contract: JSON MIME type plus schema. Gemini's documentation still requires application-side semantic validation even when the generated value is syntactically valid JSON.

Thinking models add provider-local state through different dialect-specific shapes. Generate Content with Gemini 3 function calling requires the returned `thoughtSignature` to be passed back in its original part; the official documentation warns that omitting it yields a 400. Stateless Interactions instead replays the exact model-generated steps, including relevant thought and function-call steps; it is not the same signature-bearing part model. These signatures, parts, and steps belong in a same-provider opaque replay collection, never in portable cross-provider canonical history.

Sources: [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling), [Generate Content function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling), [Generate Content thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures), [Interactions thinking](https://ai.google.dev/gemini-api/docs/thinking), [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [official Google Gen AI JavaScript SDK](https://github.com/googleapis/js-genai).

### DeepSeek

DeepSeek's Chat Completions contract is intentionally OpenAI-shaped: `tools` currently contains function tools, `tool_choice` can be none/auto/required/named, assistant calls carry an ID and JSON-string arguments, and the next request uses `role: tool` plus `tool_call_id`. The API reference documents `finish_reason: tool_calls`, stream termination with `data: [DONE]`, and a maximum of 128 functions.

Regardless of provider strictness, Tokenless parses and validates returned JSON arguments before exposing a call. DeepSeek strict mode is Beta, requires the Beta base URL and `strict: true` on every function, and causes the server to validate the submitted schema; this provider contract is not a reason to skip Tokenless's own boundary validation.

Sources: [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/), [DeepSeek Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/).

### vLLM as a public server-side reference

vLLM is an open-source serving implementation, not evidence about a proprietary provider. Its current documentation makes the server-side decomposition explicit: auto tool choice requires an enable flag, a model-specific parser, and a compatible chat template; the template handles tool definitions, `tool` messages, and assistant messages with previous calls. Named/required calls use the structured-output backend, while auto parsing without strict opt-in may extract calls from unconstrained text.

This is the closest public implementation reference for Tokenless's layer split: request compiler/chat template, model-dialect parser, constrained generation, stream assembler, canonical validator, and public serializer. A parser that recognizes a marker is only one layer and cannot by itself establish an OpenAI-compatible endpoint guarantee.

Sources: [vLLM Tool Calling](https://docs.vllm.ai/en/stable/features/tool_calling/), [vLLM tool-call parser plugin reference](https://docs.vllm.ai/en/stable/features/tool_calling/#how-to-write-a-tool-parser-plugin).

## Tokenless capability boundary

| Claim | Current state |
| --- | --- |
| Universal API executes caller tools | Never. The caller owns execution and sends the result on the next request. |
| Browser provider pages expose native OpenAI/Anthropic tool control | Not claimed. The current browser routes use `prompt_json_envelope` and Tokenless validates the whole result. |
| DeepSeek and ChatGPT browser routes | Real prompt-emulated evidence exists for the current structured-control paths; see [auto-routing evidence](evidence/openai-auto-provider-routing-2026-08-15.md). |
| Gemini browser prompt tool route | Not advertised: the real diagnostic produced prose before JSON and failed the strict public boundary; see [prompt-framing evidence](evidence/openai-tool-prompt-framing-2026-08-15.md). |
| Native provider route | Requires an exact endpoint/model live probe in addition to the official contract. Documentation alone never promotes a Tokenless route to `native_*`. |

For auto routing, a candidate must satisfy the entire request requirement set: tool choice, strict arguments, multiple-call semantics, history replay, and structured final output. A provider's public documentation can define a capability, but only a redacted exact live probe can make that capability eligible for Tokenless routing.

## Reusable checklist

Before advertising a provider route, record:

- the exact provider dialect and model;
- declaration, choice, call identity, result pairing, and stream event shapes;
- whether argument and final-output guarantees are native, prompt-emulated, or validator-only;
- full-history and same-provider opaque replay requirements;
- a redacted exact endpoint/model live probe and its evidence revision;
- the failure boundary for malformed, truncated, unknown, or mismatched calls.

This checklist is intentionally small. It prevents a provider contract, a Tokenless browser strategy, and a caller-owned Tool Registry from being conflated.
