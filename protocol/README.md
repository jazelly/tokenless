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
- `schemas/*.schema.json` define non-HTTP messages and security-sensitive
  readiness, lifecycle, worker, job, and visible-action payloads.
- `EVOLUTION.md` defines compatibility and version-bump rules.

Run `npm run protocol:generate` after changing registry constants. CI and
`npm run lint` run `npm run protocol:check`, which rejects stale generated
Rust, TypeScript, or JavaScript constants and invalid protocol artifacts.

## Capability negotiation

`GET /ready` retains the legacy challenge-bound ready and process proofs. A
current daemon additionally returns:

- `tokenless.daemon-readiness.v2`
- `tokenless.daemon-lifecycle.v1`
- signed daemon `accepts` and `emits` protocol sets
- a fresh worker capability record when a managed Playwright runner is alive
- `tokenless.daemon-capability-proof.v1`, binding readiness state, canonical
  home, process identity, lifecycle protocol, protocol sets, and worker
  capability freshness to the local control token

Consumers must validate the proof before using advertised capabilities.
Automatic replacement or shutdown additionally requires a canonical same-home
match, a verified process proof, and the signed lifecycle v1 capability. The
signed daemon `accepts` set must include
`tokenless.daemon-shutdown-proof.v1`; the CLI then uses the signed,
server-issued `shutdown_challenge` to send a challenge-bound HMAC request proof
and never sends the reusable control token to `/control/shutdown`. Shutdown
challenges expire after 10 seconds, are consumed atomically on successful
verification, and are held in a bounded 128-entry per-process registry.
Unauthenticated `/health` output is diagnostic only.

`tokenless.daemon.v1` identifies the core job-control API. It does not imply
support for readiness v2, lifecycle v1, shutdown proof v1, or any worker
protocol. Those child contracts have independent identifiers and must be
negotiated explicitly. This lets a semantic change bump the narrowest owning
protocol without coupling it to npm, Cargo, or unrelated wire contracts.

## Compatibility and conformance

Ordinary runtime reuse is based on compatible signed protocol capabilities, not
the npm or Cargo semantic-version major. Setup may still reconcile exact package
versions and binary hashes after identity and lifecycle authorization succeed.

The gated `test/protocol-cross-version.e2e.mjs` suite downloads integrity-pinned
historical npm CLI and native packages and exercises real processes in both
directions. `.github/workflows/protocol-cross-version.yml` runs the conformance
matrix across supported operating-system and architecture packages.
