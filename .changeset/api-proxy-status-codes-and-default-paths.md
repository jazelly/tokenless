---
"tokenless": patch
---

Make local API proxy failures distinguishable and serve the default OpenAI paths. Errors now carry a real HTTP status and a stable code — `404` for an unknown model, `413` for an oversized body, `499` on client disconnect, `502` for a visible-provider failure, `503` for a disabled proxy or unready profile, `504` for the completion deadline — so clients can decide whether to retry without matching message strings. `POST /v1/chat/completions` and `GET /v1/models` are accepted as aliases of the `/v1/openai` routes, letting an unmodified OpenAI client work with only a base-URL change, and every proxy route now requires the proxy to be enabled. `tokenless api-proxy status --json` reports the additional `openaiDefault` endpoint.
