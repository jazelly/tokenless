# Web AI Interaction Protocol

This private package contains the provisional V0 protocol binding used inside Tokenless. It is not published, a claim on an external namespace, or evidence of provider conformance.

The package root exposes only strict parsers and TypeScript types. Canonical schemas, examples, and the normative specification are packaged as files for schema-level validation.

`tokenless-web-ai-interaction-protocol/local-http` is the private authenticated loopback transport binding. Its caller supplies the daemon origin, bearer token, and markdown bytes directly; it never reads token files, browser profiles, or source paths.

V0 supports one new-conversation bootstrap turn with both required capabilities in fixed order, one required System Prompt attachment, and up to 32 independent Skill attachments. The local transport stages those files into one upload batch while preserving each file's opaque reference, display name, byte length, and digest. The turn exposes one aggregate delivery state for that atomic batch rather than per-file receipts.
