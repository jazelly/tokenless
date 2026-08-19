# Tokenless Internal Contracts

This private workspace package owns cross-package data contracts. It is not an HTTP server layer and is never published independently.

Exports are responsibility-specific:

- `tokenless-internal-contracts/private/provider-turn` contains the private provider-turn schemas, types, and validators.
- `tokenless-internal-contracts/private/provider-turn-http` is the thin authenticated loopback HTTP client adapter for `/v1/private/provider-turn/*`.
- `tokenless-internal-contracts/ui` contains the shared Dashboard/application DTO contract.
- `tokenless-internal-contracts/structured-json` contains shared strict JSON and AJV helpers.
- `tokenless-internal-contracts/localized-errors` contains shared localized error summaries.

The actual HTTP route implementation belongs to `packages/server/src/http`. OpenAI-compatible request and response contracts belong to the compatibility endpoints and are not redefined here.
