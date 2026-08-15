# Shared Structured Control — ChatGPT — 2026-08-15

This report records redacted M6 evidence through the packaged daemon, packaged Standalone Harness, and real ChatGPT website. It retains no bearer token, provider session, prompt body, model output, DOM, or screenshot.

## Boundary

| Surface | Public boundary | Model/provider | Execution |
| --- | --- | --- | --- |
| Universal API | `POST /v1/chat/completions` | `tokenless/chatgpt` | Browser mode through the configured persistent production profile and its ChatGPT production binding |
| Standalone Harness | Packaged local HTTP/bootstrap boundary | ChatGPT, using the same production binding and configured persistent production profile | Browser mode |

Both runs used the real ChatGPT website and provider network. Neither used provider fixtures, response interception, or a local provider replica.

## Shared boundary

At this historical M6 run, the protocol package owned strict JSON parsing, AJV 2020 compile/validate setup, and the Harness's exactly-one marker extraction. The current Universal API shares only the strict parser and AJV setup; it uses strict whole-response JSON instead of marker extraction. The Universal API retains its OpenAI tool choice, correction, and structured-output subset; the Harness retains its `action_batch`, Skill/need, and local execution semantics.

The public CLI bundles only `openai-tool-protocol.js`. An offline tarball install imported that module successfully without installing or resolving the private protocol workspace package.

## Real provider runs

| Surface | Result | Provider job |
| --- | --- | --- |
| Standalone Harness | Packaged `startHarnessLocalHttpBootstrap` staged the required System Prompt, the real ChatGPT route delivered the attachment, the turn succeeded, and packaged completion parsed a correlated `final` envelope. | `1aee137c-cb05-4972-9ba8-4275d9b8c263` |
| Universal API, first attempt | The real ChatGPT route failed during prompt input and returned `upstream_error`; it was recorded rather than hidden. | `9cd976f7-8135-4c9e-9ce7-65969e574ba0` |
| Universal API, final fresh manual attempt | The same packaged route returned HTTP 200 with `finish_reason: tool_calls`, exactly one declared `read_local_file` call, and strict schema-valid arguments. | `749af166-fe95-4297-9e16-73a728a665d7` |
| DeepSeek diagnostic | A strict named function request returned HTTP 200 with one declared call and `finish_reason: tool_calls`; DeepSeek cannot close same-provider parity because its production binding lacks `conversation.chat` for Harness V0. | `6fc4a74e-1f52-4659-ac93-d35acd341115` |

No provider fixture, response interception, synthetic provider output, local provider replica, automated login, or internal retry was used. Each fresh ChatGPT API request was a separate manual attempt.
