---
"tokenless": minor
---

Accept modern OpenAI function tools on Chat Completions requests, including terminal SSE tool-call frames and serializer-compatible `strict: false` and `parallel_tool_calls: false`. Tokenless now validates request-scoped tool catalogs and paired tool history, compiles a strict provider envelope, and returns either one schema-valid standard tool call with a Tokenless-owned id or final text. Streaming tool calls carry a stable index, id, name, complete arguments, `finish_reason: tool_calls`, and `[DONE]` without fabricated usage. A nonce-correlated `kind: final` JSON string-escaping failure may receive one bounded same-provider correction before exposure; other malformed requests or provider output fail immediately with machine-readable errors, and caller tools are never executed by the API proxy.
