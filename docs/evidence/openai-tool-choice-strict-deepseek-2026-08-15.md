# OpenAI Tool Choice and Strict Arguments — DeepSeek — 2026-08-15

This report records redacted real-provider M3 evidence through the packaged daemon and the configured persistent browser profile. No credential, provider session, full prompt, tool output, DOM, or screenshot was retained.

## Boundary

| Item | Value |
| --- | --- |
| Public route | `POST /v1/chat/completions` |
| Model | `tokenless/deepseek` |
| Execution | Real DeepSeek website, browser mode |
| Call limit | `parallel_tool_calls: false`; one call maximum |
| Provider fixtures/interception | None |

## Results

| Case | Public result | Job |
| --- | --- | --- |
| `tool_choice: none` | HTTP 200, `finish_reason: stop`, no tool call, requested marker present in final text | `0abd56d3-95f8-44bc-ba2f-54101648081a` |
| `tool_choice: required` | HTTP 200, `finish_reason: tool_calls`, one declared `record_marker` call, schema-valid arguments | `384b7cd8-7a0e-4be7-a534-fc0834e56d69` |
| Named function | HTTP 200, `finish_reason: tool_calls`, one exact `selected_recorder` call from a two-tool catalog, schema-valid arguments | `c5760b30-4af3-44ee-aca9-507f3b0a51f5` |
| `strict: true` | HTTP 200, `finish_reason: tool_calls`, one exact `record_strict_marker` call; closed root and nested objects plus a nullable leaf passed schema validation | `9545ecfa-5d5b-445c-be2e-0280e8e6d5d4` |

One earlier diagnostic allowed the entire nested `metadata` value to be null but checked specifically for `metadata.note: null`. Job `b748993b-a8d7-4586-9196-689bd4a7c5ee` returned the schema-permitted null object value and succeeded at the public boundary. The evidence schema was then narrowed to require the nested object, and the final strict run above passed; this was an observer-assertion correction, not a provider protocol failure or retry.

## Request-boundary evidence

The packaged TypeScript daemon integration accepts omitted/`auto`, `none`, `required`, named choice, and recursively compliant `strict: true` schemas before profile readiness. It rejects non-boolean strict values, non-object strict roots, open strict objects, missing required property keys, malformed named choices, and undeclared named functions before creating a job.
