# Structured-Control Observed Rate — 2026-08-15

This report records a small real-provider revalidation through the packaged Tokenless daemon, the configured persistent browser profile, and the real provider websites and networks. It is an observed conformance sample, not an SLA, benchmark, or long-term reliability claim.

## Boundary and method

| Item | Value |
| --- | --- |
| Tokenless revision | `9cdcb56` |
| Configuration | SHA-256 `10c43fe6b4ccc0a9e0df71d2620354a29d3cad6238e0d886c95473966d6a9e44`, unchanged after the run |
| API | `POST /v1/chat/completions`, browser execution, `new-conversation` |
| Tool sample | Exact named `record_probe`; closed `strict: true` arguments fixed to `kind=rate_probe`, `value=7` |
| Schema sample | Closed nested object with fixed scalar values, a nullable leaf, and a two-item enum array |
| Success | Public HTTP `200` plus independent local validation of the exact tool name/arguments or final JSON |
| Scheduling | Serial; no caller retry and no provider retry |

The runner kept request and response bodies in memory. Evidence retains only sample identity, public status/error class, finish reason, successful public job id, settled provider/strategy, local validation outcome, and elapsed time.

## Advertised provider observations

| Provider | Category | Public-valid | Observed rate | Failure classification |
| --- | --- | ---: | ---: | --- |
| ChatGPT | Named strict tool | 5 / 5 | 100% | None |
| ChatGPT | Nested `json_schema` | 4 / 5 | 80% | One HTTP `502 upstream_error` before a public structured response |
| ChatGPT | Combined | 9 / 10 | 90% | One upstream failure |
| DeepSeek | Named strict tool | 0 / 1 | 0% | Caller transport timeout after about 301 seconds; durable job remained pre-submission queued and was canceled |
| DeepSeek | Nested `json_schema` | 0 / 1 | 0% | Same pre-submission availability/transport outcome; job canceled |

Every successful ChatGPT tool sample returned `finish_reason: tool_calls`, settled provider `chatgpt`, strategy `prompt_tool_envelope`, and locally valid exact arguments. Every successful schema sample returned `finish_reason: stop`, strategy `prompt_json_envelope`, and a locally valid nested object.

### ChatGPT public sample ledger

| Sample | Category | Public result | Local validation | Finish / strategy | Public job id |
| --- | --- | --- | --- | --- | --- |
| 1 | Tool | `200` | pass | `tool_calls` / `prompt_tool_envelope` | `5e9665c7-2555-4728-b053-6be7ff485e27` |
| 2 | Tool | `200` | pass | `tool_calls` / `prompt_tool_envelope` | `6da23959-0b9b-4cc3-ad4d-ff301194b717` |
| 3 | Tool | `200` | pass | `tool_calls` / `prompt_tool_envelope` | `93e3c029-072b-4eab-a200-07d28fb258fe` |
| 4 | Tool | `200` | pass | `tool_calls` / `prompt_tool_envelope` | `5882e0c8-6feb-4be0-adb5-e6752dbeffd5` |
| 5 | Tool | `200` | pass | `tool_calls` / `prompt_tool_envelope` | `38a47359-33bf-4001-9f3e-11ed8be869ca` |
| 1 | Schema | `200` | pass | `stop` / `prompt_json_envelope` | `b89bda17-03fd-4f36-9d75-63f1e5e0c8cf` |
| 2 | Schema | `200` | pass | `stop` / `prompt_json_envelope` | `27dbf625-82f0-4285-b99e-2adb815902df` |
| 3 | Schema | `200` | pass | `stop` / `prompt_json_envelope` | `952d389c-a7c6-4e87-ace3-17fd65a0f05d` |
| 4 | Schema | `502 upstream_error` | fail | none | — |
| 5 | Schema | `200` | pass | `stop` / `prompt_json_envelope` | `db91b12e-183a-415b-96e9-c35ae0f5714d` |

The public job id is absent for the failing sample because the public error envelope did not expose one. This table comes from the in-memory caller ledger captured during the serial run; durable provider-job status alone cannot reconstruct public finish reasons or local schema validation.

DeepSeek stopped after the two fixed pilots because both consumed the full five-minute caller window without a public response. Continuing eight equivalent samples would add queued work but no unique generation-quality evidence. These failures measure current route availability, not DeepSeek schema-generation quality; both known queued jobs were explicitly canceled before provider submission.

## Gemini diagnostic

Gemini remains outside the advertised structured-control matrix. Two diagnostic rounds, each containing one tool and one schema request, created four real Gemini provider jobs; all four were submitted and marked succeeded upstream. The temporary caller observer did not produce a reliable public result row, so this report does not invent a Gemini public-valid numerator or denominator. The diagnostic only confirms that upstream completion status alone is insufficient to claim OpenAI tool/schema conformance.

## Interpretation

- ChatGPT's observed public conformance was `90%` across this fixed ten-request sample: `100%` for named strict calls and `80%` for nested schema finals.
- DeepSeek's observed public availability was `0/2` during the window; no claim about conditional schema accuracy is possible because neither sample reached a public provider outcome.
- Gemini has no rate from this run and remains unadvertised.
- Existing bounded correction was not inferred from job count. No sample is labeled corrected without a reliable public correlation signal.

No provider response text, full tool arguments, prompt, credential, cookie, DOM, screenshot, or unrelated account content is retained. The configured browser remained resident and the profile was neither replaced nor deleted.
