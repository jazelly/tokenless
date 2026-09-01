# Gemini browser structured-control evidence — 2026-08-27

This note records the narrow Gemini browser capability admitted to the Tokenless API structured-control matrix. It does not claim native provider tool calling or provider-reported token usage.

## Boundary

- Real `gemini.google.com` page in the configured persistent browser profile.
- Built CLI and packaged Tokenless API daemon.
- Browser execution through the public OpenAI-compatible HTTP boundary.
- No fixtures, response interception, provider replica, or synthetic DOM.
- Observed access was Gemini guest access.

## Results

| Request | Public result |
| --- | --- |
| Exact named `strict: true` function call with `parallel_tool_calls: false` | HTTP `200`; one schema-valid call to `report_probe` |
| Exact named `strict: true` function call after complete assistant-call and tool-result history | HTTP `200`; one schema-valid call to `finalize_probe` |
| `tokenless/auto` with advisory Gemini semantic preference | HTTP `200`; Gemini selected, preference honored, no fallback, one schema-valid call |

The auto response also exposed bounded exclusions for every other enabled provider, including `provider_access_account_blocked` for the currently suspended DeepSeek account and `provider_mode_disabled` for direct-only providers.

## Admitted scope

Gemini browser structured control declares:

- tools: yes;
- multiple calls: no;
- strict tools: yes;
- complete tool history: yes;
- JSON object final: no;
- JSON schema final: no.

Exact web token totals were not available. Benchmark observer totals remain explicitly labeled estimates derived from normalized request text and visible assistant text.
