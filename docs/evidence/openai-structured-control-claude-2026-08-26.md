# OpenAI Structured Control — Claude — 2026-08-26

This report records redacted real-provider evidence through the packaged Tokenless API and the configured persistent browser profile. It retains no bearer token, provider session, prompt body, model output, DOM, or screenshot.

## Boundary

| Surface | Public boundary | Model/provider | Execution |
| --- | --- | --- | --- |
| Universal API | `POST /v1/openai/chat/completions` | `tokenless/claude` | Browser mode through the configured persistent production profile and Claude production binding |

No provider fixture, response interception, or local provider replica was used.

## Reproduced repair

A real completed Claude JSON code-block response did not contain `.font-claude-response-body`, so the previous answer selector left two submitted jobs unsettled until their exact jobs were canceled. Targeted live-page inspection showed the completed assistant markdown under `[data-is-streaming="false"]`; the provider answer selector was widened only to that real terminal scope.

A later auto-routed parent request filled the real Claude composer but Playwright could not establish click actionability for the visible send control before the 15-second deadline. Live-page probes showed that a 62,025-character composer still exposed an enabled `chat-input-send` control and that pressing Enter on the focused composer submitted a short probe and produced the exact expected response. A packaged CLI probe then showed that page-level Enter without restoring composer focus produced no visible submission transition. After six successful large Claude parent submissions, one locator-level Enter also produced no transition; replaying that exact 77,572-character prompt on the real site showed an enabled send control, no limit or length warning, and immediate submission when the composer was explicitly focused before page-level Enter.

The next clean-revision run exposed the remaining boundary: its exact 68,728-character prompt left the real Claude composer unchanged when focused Enter was pressed, even though `chat-input-send` was visible and enabled. Clicking that same real button immediately changed the conversation URL, cleared the composer, created the user message, and entered the streaming state. Claude therefore uses the visible enabled send control even when Playwright's non-mutating trial click times out; the existing focused-Enter path remains only for a genuinely absent or disabled control.

Revision `6eadc42` then reached Claude for an attachment-bearing child turn after ChatGPT exposed a visible minute limit. The configured `web-ai` page retained a visible transient `Not now` prompt, hid the composer, and kept `chat-input-send` disabled; a sanitized snapshot showed no response, busy state, authentication blocker, rate limit, or submitted provider turn. Replacing the draft with a short diagnostic left Send disabled, proving the prompt length was not the cause. The repair dismisses that exact live control before input and treats a still-visible disabled Claude send control as the existing safe pre-submit actionability failure, so the router may continue to its next provider without an ambiguous duplicate submission. The failed Terminal-Bench run recorded 16,525 estimated tokens across its three submitted interactions; the draft-only diagnostics submitted no provider requests.

Revision `8594971` completed eight submitted `tokenless/auto` interactions before a visible ChatGPT minute limit routed the next parent turn through Grok capacity fallback to Claude. The Claude attempt targeted `/new`, submitted nothing, and ended with `prompt_submit_actionability_timeout`; the whole trial recorded 257,274 estimated tokens. An isolated ego-browser diagnostic page retained an unrelated 434-character draft and attachment on `/new`; after removing the attachment, filling the failed job's 64,144-character prompt left 64,563 characters in the composer while Send remained visible and enabled with no visible limit notice. This proves that a preserved provider-home page can retain unrelated draft state and that prompt length alone did not disable Send. Universal API new conversations now request a replacement managed page, while continuation requests preserve their mapped page.

Revision `20a7f14` proved the replacement-page policy at the queued browser boundary but still reached the same Claude pre-submit timeout after a ChatGPT minute limit and Grok capacity fallback; this trial recorded 172,868 estimated tokens across six submitted interactions. A stricter ego-browser replay selected the existing editor contents and inserted that exact failed job's 50,027-character prompt through native input events. The composer then held the prompt, Send remained visible and enabled, and no rate, weekly-limit, or length notice appeared. Claude prompt input therefore uses the existing focus, Select All, and keyboard insertion path instead of accepting DOM text presence after `fill()` as proof that the provider editor state is ready.

Revision `170d550` ran one clean `make-mips-interpreter` Terminal-Bench 2.0 trial and received official reward `0`. The run recorded 16,648 estimated tokens over eleven interactions, including three provider-submitted interactions. Its child route observed a visible ChatGPT minute limit before submission; later parent and child routes exhausted ChatGPT and Grok capacity before Claude again ended at `prompt_submit_actionability_timeout` without submission. The new sanitized Claude actionability fields were collected at the provider capability but absent from the persisted job error. Source inspection traced that loss to the existing visible-action response boundary retaining only code, message, and retryability; the repair preserves the already-sanitized details through that boundary so the next real run can distinguish page focus, submit-control state, and composer character count without retaining DOM, prompt text, selectors, or account content.

The next real Terminal-Bench parent reached Claude after ChatGPT exposed a minute limit and Grok remained capacity-deferred. Claude returned a nonce-correlated `tool_calls` envelope selecting the declared `edit` function, but used `new_str` where the live catalog required `new_string`; the API rejected the missing required property and DSH exited non-zero. The existing one-shot bounded correction is therefore admitted for a structurally valid tool-call envelope whose arguments alone fail the declared JSON Schema. It remains bound to the same provider, response kind, selected function order, and argument values.

## Proven properties

| Probe | Result | Redacted job |
| --- | --- | --- |
| Strict named tool request after the selector repair | HTTP 200, `finish_reason: tool_calls`, exactly one requested `read` call with schema-valid arguments | `5093e215-88e0-4d10-8d03-81186fd2f455` |
| Tool history continuation with `tool_choice: none` | HTTP 200, `finish_reason: stop`, non-empty content and no tool call | `952febf7-3b47-4346-8e85-c26495355a6a` |
| Native Enter submission on the real Claude composer | Submission completed, composer cleared, and the exact requested probe response appeared | Browser-only redacted probe; no Tokenless API job |
| Exact 68,728-character benchmark prompt: focused Enter | No submission transition; composer and URL remained unchanged; no visible limit or length warning | Browser-only replay of failed job `066b78c9-f166-4b8e-aad9-fa90f1861ff8`; no provider submission |
| Exact 68,728-character benchmark prompt: enabled send control click | Conversation URL changed, composer cleared, user message appeared, and response completed | Same real-page replay; 20,881 estimated input tokens and 252 estimated output tokens; no persisted DOM or provider content |
| Attachment-bearing child after ChatGPT minute limit | Claude retained a visible `Not now` prompt and disabled Send; no provider submission occurred | Failed job `36689460-bae1-4715-86b5-6e37a6ff953f`; sanitized controls only |
| Configured-page transient prompt dismissal | `Not now` became hidden; Send remained disabled, proving a separate pre-submit provider-unavailable state | Draft-only packaged CLI diagnostics; zero provider submissions |

The Universal API structured-control declaration is intentionally limited to `tools`, one call at a time, strict tool arguments, and assistant-tool history. `json_object`, `json_schema`, and multiple tool calls remain unadvertised because this run did not prove them.
