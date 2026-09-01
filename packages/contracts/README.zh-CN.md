# Tokenless API Contracts

这个仅用于文档的 workspace 维护一份 canonical HTTP 描述：[`tokenless.openapi.json`](tokenless.openapi.json)。

- `npm run api:docs` 从同一份 contract 生成英文 [`reference.html`](reference.html) 与简体中文 [`reference.zh-CN.html`](reference.zh-CN.html)。
- `npm run api:check` 校验 OpenAPI source、schema、example、authentication rule、中文 overlay 与生成的 reference。
- Runtime route、request validation、Client Adapter、DTO type 与 localized string 均不属于这里。

Reference 将 HTTP interface 分为五组：OpenAI-compatible、Anthropic-compatible、使用 bearer authentication 的 Tokenless private machine route、Dashboard session/CSRF route，以及 readiness。Runtime implementation 属于 `packages/server`；第一方 provider-turn Client Adapter 行为属于 `packages/harness`。
