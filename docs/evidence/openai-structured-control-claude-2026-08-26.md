# OpenAI Structured Control — Claude — 2026-08-26

This report records redacted real-provider evidence through the packaged Tokenless API and the configured persistent browser profile. It retains no bearer token, provider session, prompt body, model output, DOM, or screenshot.

## Boundary

| Surface | Public boundary | Model/provider | Execution |
| --- | --- | --- | --- |
| Universal API | `POST /v1/openai/chat/completions` | `tokenless/claude` | Browser mode through the configured persistent production profile and Claude production binding |

No provider fixture, response interception, or local provider replica was used.

## Reproduced repair

A real completed Claude JSON code-block response did not contain `.font-claude-response-body`, so the previous answer selector left two submitted jobs unsettled until their exact jobs were canceled. Targeted live-page inspection showed the completed assistant markdown under `[data-is-streaming="false"]`; the provider answer selector was widened only to that real terminal scope.

A later auto-routed parent request filled the real Claude composer but Playwright could not establish click actionability for the visible send control before the 15-second deadline. Live-page probes showed that a 62,025-character composer still exposed an enabled `chat-input-send` control and that pressing Enter submitted a short probe and produced the exact expected response. The repair therefore adds only a Claude-specific Enter activation when the visible composer is non-empty and no click-actionable send control is available.

## Proven properties

| Probe | Result | Redacted job |
| --- | --- | --- |
| Strict named tool request after the selector repair | HTTP 200, `finish_reason: tool_calls`, exactly one requested `read` call with schema-valid arguments | `5093e215-88e0-4d10-8d03-81186fd2f455` |
| Tool history continuation with `tool_choice: none` | HTTP 200, `finish_reason: stop`, non-empty content and no tool call | `952febf7-3b47-4346-8e85-c26495355a6a` |
| Native Enter submission on the real Claude composer | Submission completed, composer cleared, and the exact requested probe response appeared | Browser-only redacted probe; no Tokenless API job |

The Universal API structured-control declaration is intentionally limited to `tools`, one call at a time, strict tool arguments, and assistant-tool history. `json_object`, `json_schema`, and multiple tool calls remain unadvertised because this run did not prove them.
