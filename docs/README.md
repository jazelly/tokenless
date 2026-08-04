# Tokenless Documentation

This index separates user guidance, stable product contracts, implementation architecture, provider research, and future roadmaps so each document has one clear responsibility.

## Start Here

- [README](../README.md) — product overview, installation, and first run.
- [CLI Commands](../COMMANDS.md) — complete command and option reference.
- [Capability Matrix](capability-matrix.md) — canonical outcomes, current provider mappings, support states, and extension rules.
- [Privacy](../PRIVACY.md) — browser-profile, credential, file, and local-data boundaries.

## Concepts and Architecture

- [Architecture](architecture.md) — daemon, managed browser, provider adapter, routing, and control-plane design.
- [Provider Capability Census](provider-capability-census.md) — provider product reconnaissance and evidence gaps; not a support declaration.
- [Roadmaps](roadmaps/README.md) — active, backlog, and archived delivery plans.

## Provider and Capability Development

- Start with the [Capability Matrix extension process](capability-matrix.md#adding-a-new-capability).
- Follow the [Provider DOM Fixture Policy](../test/fixtures/provider-dom/README.md).
- Declare required real-provider cases in [`live-provider-capability-matrix.json`](../test/live-provider-capability-matrix.json).
- Implement real journeys in [`live-managed-playwright.e2e.mjs`](../test/live-managed-playwright.e2e.mjs).
- Keep provider-specific behavior under [`packages/cli/src/providers/`](../packages/cli/src/providers/).

## Adding Documentation

- Put installation and first-run guidance in the paired root READMEs.
- Put stable user and developer contracts under `docs/` and link them from this index.
- Put complete CLI syntax in the paired `COMMANDS` references rather than duplicating it across guides.
- Keep product reconnaissance in the capability census; observed product features are not support declarations.
- Keep intended work, sequencing, and incomplete acceptance criteria under `docs/roadmaps/`; directory location defines roadmap lifecycle.
- Add an English and Simplified Chinese partner for every reasonable user-facing document, keep their structure and meaning aligned, and update this index in the same change.
- Prefer links to one source of truth over copied tables. When a small user-facing summary is useful, name the runtime or source file that remains authoritative.

## Language

User-facing documentation is maintained in English and Simplified Chinese. Use the `*.zh-CN.md` partner for Chinese; internal technical records may remain English when translation adds no user value.
