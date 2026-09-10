# Tokenless Web Harness Documentation

This index separates user guidance, stable product contracts, implementation architecture, provider research, and future roadmaps so each document has one clear responsibility.

## Start Here

- [README](../README.md) — Web Harness, Dashboard, three workflows, and quick start.
- [Provider catalog](../README.md#providers) — all 44 catalog entries, browser and Direct modes, and verification status.
- [CLI Commands](../COMMANDS.md) — complete command and option reference.
- [Updates](updates.md) — unified CLI and macOS app updates, configuration preservation, and database migrations.
- [Capability Matrix](capability-matrix.md) — canonical outcomes, current provider mappings, support states, and extension rules.
- [API Proxy Integration](api-proxy-integration.md) — calling the OpenAI/Anthropic-compatible local proxy from an existing project.
- [Tokenless Harness Browser Extension](harness-browser-extension.md) — install, pairing, supported inputs, approval, and the experimental real-page acceptance flow.
- [Harness Integrations](harness-integrations.md) — model-base-URL integration, Tokenless Harness subagent delegation, and current host support.
- [HTTP API Reference](../packages/contracts/reference.html) — generated OpenAI-compatible, Anthropic-compatible, private, Dashboard, and readiness interfaces.
- [Provider Guest Access](../PROVIDER_GUEST_ACCESS.md) — observed signed-out behavior and authentication routing rules.
- [Provider Rate Limits](provider-rate-limits.md) — official Web-provider limit knowledge and runtime policy.
- [Provider Tool-Calling Conformance](provider-tool-calling-conformance.md) — current official provider contracts, canonical mapping, and Tokenless evidence boundaries.
- [Privacy](../PRIVACY.md) — browser-profile, credential, file, and local-data boundaries.

## Concepts and Architecture

- [Architecture](architecture.md) — the stable two-layer design: Universal API, Web Agent Harness, provider runtime, ownership, and trust boundaries.
- [Glossary](glossary.md) — canonical Harness model roles, execution, authentication, and direct-provider terms.
- [Provider Capability Census](provider-capability-census.md) — provider product reconnaissance and evidence gaps; not a support declaration.
- [Roadmaps](roadmaps/README.md) — active, backlog, and archived delivery plans.

## Provider and Capability Development

- Start with the [Capability Matrix extension process](capability-matrix.md#adding-a-new-capability).
- Develop and verify provider behavior only against the real provider website through the configured browser profile.
- Declare required real-provider cases in [`live-provider-capability-matrix.json`](../test/live-provider-capability-matrix.json).
- Implement real journeys in [`live-managed-playwright.e2e.mjs`](../test/live-managed-playwright.e2e.mjs).
- Keep provider-specific behavior under [`packages/server/src/providers/`](../packages/server/src/providers/).

## Adding Documentation

- Do not ship walls of text: keep paragraphs short, and switch to bullets, tables, diagrams, or screenshots when they communicate the same information faster.
- Keep the root README as a scannable landing page; move detailed explanations into the focused document that owns them and link to it.
- Put installation and first-run guidance in the paired root READMEs.
- Put stable user and developer contracts under `docs/` and link them from this index.
- Put complete CLI syntax in the paired `COMMANDS` references rather than duplicating it across guides.
- Keep product reconnaissance in the capability census; observed product features are not support declarations.
- Keep intended work, sequencing, and incomplete acceptance criteria under `docs/roadmaps/`; directory location defines roadmap lifecycle.
- Add an English and Simplified Chinese partner for every reasonable user-facing document, keep their structure and meaning aligned, and update this index in the same change.
- Prefer links to one source of truth over copied tables. When a small user-facing summary is useful, name the runtime or source file that remains authoritative.

## Language

User-facing documentation is maintained in English and Simplified Chinese. Use the `*.zh-CN.md` partner for Chinese; internal technical records may remain English when translation adds no user value.
