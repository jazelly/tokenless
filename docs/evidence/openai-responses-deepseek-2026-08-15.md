# OpenAI Responses — DeepSeek — 2026-08-15

This report records redacted TC-007 evidence through the packaged daemon, the current official JavaScript SDK, and the real DeepSeek website. It retains no bearer token, provider session, prompt, tool output, response text, DOM, or screenshot.

## Boundary

| Item | Value |
| --- | --- |
| SDK | Official `openai@7.4.0`, isolated temporary install |
| Route | `POST /v1/responses` |
| Model | `tokenless/deepseek` |
| Execution | Real DeepSeek website, browser mode |
| Tool execution | Caller-owned local result; Tokenless did not execute it |
| Provider fixtures/interception | None |
| Official contract | [Function calling](https://developers.openai.com/api/docs/guides/function-calling), [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create) |

## Results

| Case | Public result | Job / response |
| --- | --- | --- |
| Non-stream function call | One declared strict call; item id `fc_a0a13ff8866a42328ab8f7520480995a` differed from stable call id `call_6d1d40b3b30b4c238e932f44fdc214d2`; arguments digest `b265734193ca829e95d521e2eb32b9ea72f8e5dee70e009751dfc2be14744de2` | `5917e5cb-322e-463e-bf95-26db1312f370` / `resp_3a6f6093a1eb44f5a2b724e93ea43839` |
| Full-input replay | The caller appended the prior output item and its real local function result, then resent the same current tools catalog; final text used the result. Output digest `e9fb730c7f93b0b3452f474392ad24538e8d685ddfdff23830761e112178aa59` | `cce1e498-cf55-4b6c-9951-f1db0ce6bf83` / `resp_7e1f8e0e1189404cacb3d7d214d8d8fd` |
| `previous_response_id` | The caller sent the function result plus `resp_3a6f6093a1eb44f5a2b724e93ea43839` and resent the same current tools catalog; final text used the result. Output digest `c6b65c9a502d8fd64937807c3ef607980216b930291f3739cc48f7859f71c815` | `88da73f2-a179-474e-8629-788f1b2537aa` / `resp_969cf011d6394567bbabe0cbd82ec24d` |
| Function stream | SDK reconstructed complete arguments from `response.output_item.added`, one full arguments delta, arguments done, output item done, and `response.completed`. Item/call ids remained distinct; terminal usage was `null`; no `[DONE]` appeared. | `a6485bfa-b3c6-410b-ad6f-2e52037443fb` / `resp_df92cde249a14b4ea99b53fc51fbdeac` |
| Text stream | SDK reconstructed identical delta, done text, and completed output through the current message/content event sequence. Terminal usage was `null`; output digest `1f41bd1897dab40ff4b3602cdf9b218bd439d69243e27eee3c2eff2eb83675c2`. | `c3039688-e6eb-4cab-bfbf-d266226fdf21` / `resp_d78cf24a6f114d61bfe61a369fa147c9` |
| Structured final | `text.format.json_schema` returned strict JSON that passed the declared closed schema; output digest `8ef72ecd91e40f990cf743fe1b52efab88677e40cb7f99204a02c51d00b761db`. | `8d7e1b78-9778-464e-9beb-0e72dc56581f` / `resp_2bc142f3805043f3bf518e1144b30122` |

The function stream event types were `response.created`, `response.in_progress`, `response.output_item.added`, `response.function_call_arguments.delta`, `response.function_call_arguments.done`, `response.output_item.done`, and `response.completed`. The text stream additionally used the current content-part and `response.output_text` delta/done events. Terminal delivery reflects the visible-browser boundary and does not claim token-level provider latency.

## Local replay failures

The built daemon HTTP integration exercised missing, expired, provider mismatch, exact-model mismatch, execution-mode mismatch, and unverifiable reasoning replay through `POST /v1/responses`. Each failed before profile resolution and before any provider job was created. Expiration used a real SQLite ledger row whose deadline was moved to the past; no provider response was synthesized.

At the time of this historical run, the ledger retained canonical public transcript items for 24 hours and returned `response_expired` on the first expired lookup. That retention behavior was later removed: the current ledger persists canonical public transcript items in `tokenless.sqlite3` without expiry or count eviction; unknown ids return `response_not_found`.

## Diagnostic

An earlier SDK run completed its function-call and continuation turns but exposed that a no-tools structured request was incorrectly passed to the shared non-empty tool catalog validator. The structured request failed locally before provider submission. The mapping was narrowed so omitted Responses tools map directly to an empty canonical catalog, then the complete clean cohort above passed. No retry or provider fallback machinery was added.
