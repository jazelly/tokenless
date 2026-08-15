# OpenAI Tool Prompt Framing — 2026-08-15

This report records redacted real-provider checks of the prompt-injection framing repair. It retains no prompt body, provider response, tool arguments, tool output, credential, session value, DOM, or screenshot.

## Boundary

| Item | Value |
| --- | --- |
| Public route | Packaged daemon `POST /v1/chat/completions` |
| Profile | Configured persistent production profile `web-ai` |
| Execution | Real provider websites in browser mode |
| Tool contract | Named strict `read_local_file`; caller alone performed the local read when a call was returned |
| Provider fixtures/interception | None |

The repaired compiler asks for one constrained whole-response JSON decision object. The parser accepts bare JSON or exactly one complete `json`/`text` fence, and rejects prose, marker wrappers, multiple fences, and malformed JSON.

## Gemini: no refusal observed in three submissions; tool selection unadvertised

| Fresh submission | Provider job | Provider outcome | Public outcome |
| --- | --- | --- | --- |
| 1 | `153fc873-2b7d-4948-b362-4eb1fa83a071` | Submitted and succeeded | HTTP 502 `provider_output_protocol_error` |
| 2 | `d81ac27e-d7c0-46ef-aaf1-615ade68ff02` | Submitted and succeeded | HTTP 502 `provider_output_protocol_error` |
| 3 | `5a0aac14-0345-42ce-adf9-abe10bf51347` | Submitted and succeeded | HTTP 502 `provider_output_protocol_error` |

For each run, the in-memory redacted classifier found no prompt-injection or authority refusal and no capability disclaimer. Each response instead had a prose lead-in before JSON-like content, without a complete supported fence; strict parsing failed with `JSON contains an invalid value`.

The second repeated prose failure admitted one minimal prompt clarification: the first non-whitespace character must be `{`, unless the response begins with its one complete supported fence. The third fresh run repeated the same natural failure. The parser was not relaxed, and Gemini prompt-emulated tool selection remains unadvertised.

## Regression providers

| Provider and case | Public result | Provider job |
| --- | --- | --- |
| DeepSeek named strict call | HTTP 200, `finish_reason: tool_calls`, exactly one declared `read_local_file` call with schema-valid arguments | `cf73ecd8-fec4-4346-99ad-9f2fe8562610` |
| DeepSeek caller-owned local-read continuation | HTTP 502 `provider_output_protocol_error`; the provider job succeeded but its raw JSON candidate was malformed (`JSON object entries must be separated by commas`) | `c18f0f91-e0d0-4bbf-8c67-6ee0753f6907` |
| ChatGPT named strict-call attempt | HTTP 502 `upstream_error` before a public protocol result; no retry | No public job id |

The DeepSeek continuation used the returned public call id and the caller's actual local `package.json` read, but this report intentionally records neither the id's arguments nor the tool result. No fallback, retry framework, prose extraction, balanced-object extraction, synthetic output, provider fixture, or interception was used.
