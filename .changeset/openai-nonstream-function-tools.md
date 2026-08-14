---
"tokenless": minor
---

Accept modern OpenAI function tools on non-streaming Chat Completions requests, including serializer-compatible `strict: false` and `parallel_tool_calls: false`. Tokenless now validates request-scoped tool catalogs and paired tool history, compiles a strict provider envelope, and returns either one schema-valid standard tool call with a Tokenless-owned id or final text. A nonce-correlated `kind: final` JSON string-escaping failure may receive one bounded same-provider correction before exposure; other malformed requests or provider output fail immediately with machine-readable errors, and caller tools are never executed by the API proxy.
