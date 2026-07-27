# Tokenless Protocols

This directory is the machine-readable source of truth for Tokenless protocol
and schema contracts. Package versions describe releases; protocol identifiers
describe compatibility at their declared boundary.

## Sources of truth

- `registry.json`, validated by `registry.schema.json`, owns every production
  `tokenless.*.vN` identifier, its owner, direction, status, category,
  artifacts, and generated constant names. `category` distinguishes daemon HTTP
  wire APIs from internal payload schemas, local metadata, and release metadata.
- `openapi/tokenless.daemon.v1.openapi.json` defines the versioned local
  control-plane endpoints, authentication, requests, responses, status codes,
  readiness proof, browser runtime control routes, and stable error envelope.
- `schemas/*.schema.json` define internal or persisted non-HTTP payload shapes,
  such as Playwright job and visible-action payloads.
- `EVOLUTION.md` defines compatibility and version-bump rules.

Run `npm run protocol:generate` after changing registry constants. CI and
`npm run lint` run `npm run protocol:check`, which rejects stale generated
TypeScript or JavaScript constants and invalid protocol artifacts.

## Daemon readiness

`GET /ready` returns a challenge-bound HMAC proof as part of
`tokenless.daemon.v1`. The proof binds the daemon protocol identifier, caller
challenge, and canonical Tokenless home directory. The readiness response
declares protocol compatibility with `protocol: "tokenless.daemon.v1"` only.
Nested job, action, error, proof, browser runtime, and provider payload schemas
do not negotiate as independent CLI-daemon peer protocols.

Threat model: Tokenless is a local-loopback control plane. After the
same-home ready proof validates, the CLI may send the daemon control token to
bearer-authenticated daemon.v1 routes. Unauthenticated `/health` output is
diagnostic only.

Setup may replace a mismatch daemon only after the ready proof validates and
the canonical home matches. Shutdown uses the existing bearer-authenticated
`/control/shutdown` endpoint; the CLI verifies `/ready` for the same home
immediately before sending the bearer token.

## Compatibility and conformance

Ordinary runtime reuse is based on daemon.v1 compatibility, not the npm
semantic-version major. Setup never stops a compatible same-home daemon for
version drift; when only the installed daemon runtime is stale, setup refreshes
that installed runtime for the next start and leaves the running daemon in
place.

Historical 0.2 cross-version compatibility is not supported by this clean-break
daemon.v1 boundary. Current conformance checks verify the OpenAPI artifact,
readiness proof, protocol constants, and safe handling of mismatched or
incompatible daemons.
