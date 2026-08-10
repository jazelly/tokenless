---
"tokenless": patch
---

Add an opt-in local API proxy so existing OpenAI- and Anthropic-compatible clients can route Q&A traffic through visible provider sessions: new daemon routes `POST /v1/openai/chat/completions`, `GET /v1/openai/models`, and `POST /v1/anthropic/messages`, explicit `tokenless/<provider>` model naming, a `new-conversation` or `continue-conversation` mapping chosen during setup or with `tokenless api-proxy`, and fail-closed rejection of tool, function, and structured-output fields that visible pages cannot honour.
