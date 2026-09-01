# Tokenless API Contracts

This documentation-only workspace owns one canonical HTTP description: [`tokenless.openapi.json`](tokenless.openapi.json).

- `npm run api:docs` generates English [`reference.html`](reference.html) and Simplified Chinese [`reference.zh-CN.html`](reference.zh-CN.html) from the same contract.
- `npm run api:check` validates the OpenAPI source, schemas, examples, authentication rules, Chinese overlay, and generated references.
- Runtime routes, request validation, Client Adapters, DTO types, and localized strings do not live here.

The reference groups five distinct Interfaces: OpenAI-compatible, Anthropic-compatible, private bearer-authenticated Tokenless machine routes, Dashboard session/CSRF routes, and readiness. Runtime implementation belongs to `packages/server`; first-party provider-turn Client Adapter behavior belongs to `packages/harness`.
