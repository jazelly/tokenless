# Tokenless API Contracts

This documentation-only workspace owns one canonical HTTP description: [`tokenless.openapi.json`](tokenless.openapi.json).

- `npm run api:docs` generates [`reference.html`](reference.html), a single Scalar reference for every HTTP Interface.
- `npm run api:check` validates the OpenAPI source, schemas, examples, authentication rules, and generated reference.
- Runtime routes, request validation, Client Adapters, DTO types, and localized strings do not live here.

The reference groups five distinct Interfaces: OpenAI-compatible, Anthropic-compatible, private bearer-authenticated Tokenless machine routes, Dashboard session/CSRF routes, and readiness. Runtime implementation belongs to `packages/server`; first-party provider-turn Client Adapter behavior belongs to `packages/harness`.
