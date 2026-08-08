# Web AI Interaction Protocol

This private package contains the provisional V0 protocol binding used inside Tokenless. It is not published, a claim on an external namespace, or evidence of provider conformance.

The package exposes only strict parsers and TypeScript types from its root. Canonical schemas, examples, and the normative specification are packaged as files for schema-level validation.

V0 supports one new-conversation bootstrap turn with both required capabilities in fixed order and one required System Prompt attachment. References use kind-specific prefixes plus 32 lowercase hexadecimal characters; it does not implement a transport, authentication, provider runtime, Harness loop, Skills, or per-attachment receipts.
