# Private Provider-Turn Contract V0

`tokenless.internal.web-ai-interaction-protocol/v0` is the retained V0 wire discriminator for Tokenless's private provider-turn contract. It is not the OpenAI-compatible API, an external package, or an industry-standard claim.

V0 defines serialized messages for capability discovery, one new-conversation bootstrap start, and durable turn state. The canonical HTTP paths and serialized schemas live in [`../tokenless.openapi.json`](../tokenless.openapi.json); this file is supporting narrative documentation.

## Core messages

`capability-document` reports the protocol version, an opaque `ProviderRef`, and supported capabilities. This slice recognizes only `conversation.chat` and `file.upload`; a start request requires both in that exact order, while discovery may report either or both.

`start-turn-request` creates exactly one new conversation. It carries opaque `ProviderRef` and `ProviderBindingRef`, a finalized short message, exactly one leading `system_prompt` attachment, and up to 32 following `skill` attachments. Every Markdown file has an independent opaque `AttachmentRef`, display name, byte length, and lowercase SHA-256 digest; the files share one atomic visible upload action and one aggregate delivery state.

`turn-state` contains opaque provider, binding, conversation, and turn references. Its lifecycle is `queued`, `running`, `waiting_for_user`, `succeeded`, `failed`, or `cancelled`; dispatch certainty is always `not_dispatched`, `dispatched`, or `ambiguous`. A queued turn is always `not_dispatched` with a pending attachment, and dispatched or ambiguous states always have a delivered attachment.

`waiting_for_user` includes one bounded waiting reason. `succeeded` requires a terminal text/citations result and proven `dispatched`, while `failed` requires a stable error and `cancelled` requires a cancel reason. Nonterminal states contain no terminal payload, and no message implies a retry, fallback, replay, or exactly-once guarantee.

The System Prompt attachment must be delivered before a state may report `dispatched` or `ambiguous`. A rejected attachment is a failed, proven non-dispatch state; V0 has no partial attachment receipt or Skill-delivery semantics.

Every protocol reference is kind-specific and opaque: `request:`, `provider:`, `binding:`, `conversation:`, `turn:`, or `attachment:` followed by exactly 32 lowercase hexadecimal characters. Bare identifiers, paths, and implementation identifiers are invalid.

## Runtime ownership

The authenticated loopback Client Adapter belongs to `packages/harness/src/http/provider-turn/`. It calls `/v1/private/provider-turn/*` for binding, capability discovery, attachment staging, start/read/resume/cancel, and request cancellation.

The HTTP Server Adapter and request validation belong to `packages/server/src/http/private/provider-turn/`. Neither Adapter is exported from this documentation package. OpenAI-compatible model requests remain owned by `/v1/chat/completions`, `/v1/responses`, and `/v1/images/generations`; this private Interface is retained only for current semantics those Interfaces do not yet express losslessly.

An ambiguous dispatch must remain ambiguous across transport boundaries. A client must obtain provider-specific evidence before considering any new submission.
