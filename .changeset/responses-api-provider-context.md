---
"tokenless": patch
---

Align the local API proxy with standard stateless Chat Completions and Responses continuation semantics: Chat Completions and Anthropic requests always start fresh provider chats, while a valid Responses `previous_response_id` resumes its mapped browser conversation and sends only the current input delta.
