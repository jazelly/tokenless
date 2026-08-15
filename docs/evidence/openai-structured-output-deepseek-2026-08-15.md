# OpenAI Structured Output — DeepSeek — 2026-08-15

This report records redacted real-provider M5 evidence through the packaged daemon and real DeepSeek website. It retains no credential, provider session, full prompt, full tool output, DOM, or screenshot.

## Boundary

| Item | Value |
| --- | --- |
| Public route | `POST /v1/chat/completions` |
| Model | `tokenless/deepseek` |
| Execution | Real DeepSeek website, browser mode |
| Provider fixtures/interception | None |
| Correction | None; four acceptance requests created exactly four successful provider jobs |

## Results

| Case | Public result | Job |
| --- | --- | --- |
| Non-stream `json_object` | HTTP 200, `finish_reason: stop`; strict parsing produced `{kind: m5_json_object, values: [3, 5]}` | `7be4a680-a2d1-4856-acaf-056066c762b7` |
| Terminal SSE nested `json_schema` | Two JSON frames then `[DONE]`, no usage; `finish_reason: stop`; schema validation preserved total `7`, active `true`, nullable note, and ordered enum-constrained tags `alpha`, `beta` | `98064280-b8b7-4234-a9f8-707289fffa3b` |
| Tool call | HTTP 200, `finish_reason: tool_calls`; one declared strict `read_local_file` call selected `package.json` | `c522ff1f-16c4-467b-81f2-6c06ce571cfb` |
| Tool-result structured continuation | The caller read the real local file, returned the actual result under the public call id, and resent the same `response_format`; terminal SSE returned schema-valid kind, source, package name `tokenless`, and version `0.1.0`, followed by `stop` and `[DONE]` without usage | `aa6f155f-c0f2-4741-8696-11b56b906e72` |
| Unsafe-integer diagnostic | A separate `json_object` request asked for exact numeric literal `9007199254740993`; the real provider job succeeded, but the public boundary returned HTTP 502 `provider_output_protocol_error` because the integer is unsafe | `2aa7a48c-dd56-4746-aac1-d28ecd4ff850` |

The nested schema used a closed root and closed nested object, `const`, an enum-constrained array, numeric bounds, a boolean, and a nullable type array. The tool continuation schema was also recursively closed. Both passed the public validator before their content was exposed.

The unsafe-integer diagnostic created exactly one additional provider job, so no correction ran. It was a natural real-provider output, not a fixture or simulated invalid response.

## Request-boundary evidence

The packaged TypeScript daemon integration accepted text, `json_object`, and the published `json_schema` subset both without tools and after complete assistant-call/tool-result history. It rejected malformed response-format shapes, invalid names/descriptions/strict flags, non-object roots, open root or nested objects, root `anyOf`, `oneOf`, `$ref`, unsafe numeric bounds, and unsafe integers nested inside `const` before profile resolution and before creating a job.

## Boundary statement

DeepSeek produced all model outcomes through the configured persistent browser profile and packaged Tokenless daemon. Tokenless validated but did not execute the caller-owned tool; the caller performed the local read and supplied its result. No provider fixture, response interception, simulated response, synthetic SSE, local provider replica, retry framework, or new correction path was used.
