# OpenAI Auto Provider Routing — Real-Boundary Evidence

Date: 2026-08-15

## Boundary

- Packaged daemon: current local `dev` build, restarted after the structured-final grammar repair.
- Profile: repository-configured persistent `web-ai` profile and its production browser runtime.
- Harness: an external Node process used the OpenAI Chat Completions HTTP boundary; Tokenless did not execute tools.
- Provider traffic: real ChatGPT, DeepSeek, and Gemini websites and networks; no fixture, interception, synthetic provider response, or browser-profile replacement.
- Config safety: `/Users/jazelly/.tokenless/config.json` was snapshotted before changing only `web-ai.enabledProviders`. Its SHA-256 was `ca57f4cac4b6f090c239748d6a04512194d4bd9eb47601e0c4c0e8f711b74c57` before the run and after byte-for-byte restore; `cmp` succeeded. No profile, browser state, or authentication material was changed.

Credentials, provider output bodies other than the short asserted final answers, hidden reasoning, and unrelated account content were not recorded.

## Cross-provider tool continuation

The harness first enabled only DeepSeek, then submitted `model: tokenless/auto` with one named strict `read_project_manifest` function.

| Boundary | Observed result |
| --- | --- |
| Provider A | DeepSeek job `b852a644-28b1-4fce-8d58-3ab78feaa91a` |
| Public call | `call_tla1_deepseek_7f991d6cfb1d426896ea80162bc71485`; origin matched the settled provider |
| Caller action | The external harness read the real checkout's `package.json`: name `tokenless`, version `0.1.0` |
| Safe switch | DeepSeek was disabled and ChatGPT enabled before the next model submission |
| Provider B | ChatGPT job `f52f9397-2e8a-488a-9e2a-565ac4621946` |
| Portable history | The complete assistant `tool_calls` item and role=`tool` result used the unchanged public call id |
| Grounded final | `The package.json project manifest is for tokenless, version 0.1.0.` |
| Attempts | One succeeded durable attempt for each job; both used `prompt_tool_envelope` |

This proves explicit next-turn reselection at a safe boundary. It does not claim provider-local URL or opaque-state portability.

## Structured-final strategies

The first current-code probes reproduced a double-serialization failure after the admitted same-provider correction on both DeepSeek and ChatGPT. That repeated real failure admitted one small internal grammar repair: structured `final.content` is now the JSON object directly, while text remains a string. The public OpenAI response is still exact JSON text after validation.

Fresh post-repair runs used the same closed schema requiring `{"kind":"tc008","value":8}`:

| Provider | Job | Strategy | Attempts | Public validation |
| --- | --- | --- | --- | --- |
| ChatGPT | `8243a9ea-fcb6-4b0c-83c8-6e660c2c03aa` | `prompt_json_envelope` | 1 | exact schema-valid payload |
| DeepSeek | `c4b0b3dc-99fa-4895-9a58-dcc764c42b23` | `prompt_json_envelope` | 1 | exact schema-valid payload |

A fresh combined DeepSeek tool-plus-schema run kept ordinary tool-call parsing separate from exact-number structured-final validation. Job `68941880-590c-47e1-a4e2-9cb4d99cc976` returned the call; the caller read the real manifest; job `e57e18cc-b6ea-40b6-a420-19862dfd1c80` returned `{"name":"tokenless","version":"0.1.0"}`. Both jobs had one attempt and the call id was unchanged.

## Post-submission terminal boundary

Gemini remains excluded from the auto capability matrix. A fresh exact `tokenless/gemini` named-tool diagnostic on the final build naturally returned HTTP 502 `provider_output_protocol_error` (`JSON contains an invalid value`). Durable job `d41bd42e-2584-4e27-a1e5-4bd05932ce51` had a non-null `provider_submitted_at` and exactly one Gemini attempt. No other provider received the request.

The admitted nonce-correlated final-string escaping correction remains bounded to the same provider and strategy and bypasses auto resolution.

## Local contract checks

- `npm run build`: passed.
- `node --test --test-concurrency=1 test/api-proxy-local-http.integration.test.mjs`: 20/20 passed.
- `npm run api:check`: passed.
- `git diff --check`: passed before review handoff.

