# Tokenless Protocols

This directory is the machine-readable source of truth for Tokenless wire contracts.
Package versions describe releases; protocol identifiers describe compatibility.

## Sources of truth

- `registry.json`, validated by `registry.schema.json`, owns every production
  `tokenless.*.vN` identifier, its owner, direction, status, artifacts, and
  generated constant names.
- `openapi/tokenless.daemon.v1.openapi.json` defines the versioned local
  control-plane endpoints, authentication, requests, responses, status codes,
  and stable error envelope.
- `schemas/*.schema.json` define non-HTTP job and visible-action payloads.
- `EVOLUTION.md` defines compatibility and version-bump rules.

Run `npm run protocol:generate` after changing registry constants. CI and
`npm run lint` run `npm run protocol:check`, which rejects stale generated
TypeScript or JavaScript constants and invalid protocol artifacts.

## Compatibility negotiation

`GET /ready` retains the legacy challenge-bound
`tokenless.daemon-ready-proof.v1` HMAC tuple unchanged for compatibility with
published 0.2 clients and daemons. A current daemon also returns
`supported_protocols` with exactly three arrays: `daemon`, `job`, and `action`.
Current values include `tokenless.daemon.v1`, both managed job protocols, and
both visible action protocols.

Threat model: Tokenless is a local-loopback control plane. After the unchanged
same-home ready proof validates, the CLI treats `supported_protocols` from that
same response as advisory negotiation data. The arrays have no separate
signature and do not encode directionality or freshness. Older daemons without
`supported_protocols` use a narrow legacy fallback based on their existing
daemon/native protocol fields.

Setup may replace a mismatch daemon only after the ready proof validates and
the canonical home matches. Shutdown uses the existing bearer-authenticated
`/control/shutdown` endpoint; the CLI verifies `/ready` for the same home
immediately before sending the bearer token. Unauthenticated `/health` output is
diagnostic only.

## Compatibility and conformance

Ordinary runtime reuse is based on protocol overlap, not the npm
semantic-version major. Setup never stops a compatible same-home daemon for
version drift; when only the installed daemon runtime is stale, setup refreshes
that installed runtime for the next start and leaves the running daemon in
place.

The gated `test/protocol-cross-version.e2e.mjs` suite downloads historical npm
CLI packages, plus historical native runtime packages when testing versions
that published them, using npm's package cache/integrity handling and exercises
real processes in both directions. `.github/workflows/protocol-cross-version.yml`
runs the conformance matrix across supported operating-system and architecture
packages without requiring the removed implementation source or a non-Node toolchain.
