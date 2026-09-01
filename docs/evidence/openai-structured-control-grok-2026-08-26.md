# OpenAI Structured Control — Grok — 2026-08-26

This report records redacted real-provider evidence through the packaged Tokenless API and the configured persistent browser profile. It retains no bearer token, provider session, prompt body, model output, DOM, or screenshot.

## Boundary

| Surface | Public boundary | Model/provider | Execution |
| --- | --- | --- | --- |
| Universal API | `POST /v1/openai/chat/completions` | `tokenless/grok` | Browser mode through the configured persistent production profile and Grok production binding |

No provider fixture, response interception, or local provider replica was used.

## Proven properties

| Probe | Result | Redacted job |
| --- | --- | --- |
| Strict named tool request | HTTP 200, `finish_reason: tool_calls`, exactly one requested echo call | `ebddf917-3d7b-4370-a9d1-22cf621fa0ba` |
| Tool history continuation with `tool_choice: none` | HTTP 200, `finish_reason: stop`, non-empty content | `2e793f74-14ea-410a-a810-fc81029bbe30` |

The Universal API structured-control declaration is intentionally limited to `tools`, one call at a time, strict tool arguments, and assistant-tool history. `json_object`, `json_schema`, and multiple tool calls remain unadvertised because this run did not prove them.
