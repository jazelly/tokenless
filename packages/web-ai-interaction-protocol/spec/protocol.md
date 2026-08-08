# Web AI Interaction Protocol V0

`tokenless.internal.web-ai-interaction-protocol/v0` is a provisional internal protocol name. It is not an external package, namespace, domain, organization, or industry-standard claim.

V0 defines serialized messages for capability discovery, one new-conversation bootstrap start, and durable turn state. The canonical JSON Schemas under `schemas/v0/` are normative; TypeScript types and parsers are bindings to those schemas.

## Core messages

`capability-document` reports the protocol version, an opaque `ProviderRef`, and supported capabilities. This slice recognizes only `conversation.chat` and `file.upload`; a start request requires both in that exact order, while discovery may report either or both.

`start-turn-request` creates exactly one new conversation. It carries opaque `ProviderRef` and `ProviderBindingRef`, a finalized short message, and exactly one required `system_prompt` `text/markdown` attachment with an opaque `AttachmentRef`, byte length, and lowercase SHA-256 digest. Preselected Skills are deliberately excluded until a per-attachment receipt transport exists.

`turn-state` contains opaque provider, binding, conversation, and turn references. Its lifecycle is `queued`, `running`, `waiting_for_user`, `succeeded`, `failed`, or `cancelled`; dispatch certainty is always `not_dispatched`, `dispatched`, or `ambiguous`. A queued turn is always `not_dispatched` with a pending attachment, and dispatched or ambiguous states always have a delivered attachment.

`waiting_for_user` includes one bounded waiting reason. `succeeded` requires a terminal text/citations result and proven `dispatched`, while `failed` requires a stable error and `cancelled` requires a cancel reason. Nonterminal states contain no terminal payload, and no message implies a retry, fallback, replay, or exactly-once guarantee.

The System Prompt attachment must be delivered before a state may report `dispatched` or `ambiguous`. A rejected attachment is a failed, proven non-dispatch state; V0 has no partial attachment receipt or Skill-delivery semantics.

Every protocol reference is kind-specific and opaque: `request:`, `provider:`, `binding:`, `conversation:`, `turn:`, or `attachment:` followed by exactly 32 lowercase hexadecimal characters. Bare identifiers, paths, and implementation identifiers are invalid.

## Local HTTP profile (not implemented)

A later authenticated local HTTP profile may expose capability discovery, start, read, and cancel operations. Paths, status codes, and authentication are profile concerns; they are not core fields and no network client or server is part of this package.

An ambiguous dispatch must remain ambiguous across transport boundaries. A client must obtain provider-specific evidence before considering any new submission.
