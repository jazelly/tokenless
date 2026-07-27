# Tokenless Protocol Evolution

`protocol/registry.json` is the source of truth for protocol identifiers and generated constants.

Rules:

- Protocol identifiers are immutable. Introduce a new `.vN` identifier for wire-incompatible changes.
- A semantic change must bump the protocol that owns that semantic boundary. The daemon HTTP API has one CLI-daemon wire boundary: `tokenless.daemon.v1`, described by `openapi/tokenless.daemon.v1.openapi.json`.
- Every daemon HTTP route must appear in the daemon OpenAPI document before it is treated as implemented. This includes readiness, errors, job control, shutdown, and browser runtime control routes.
- In-process TypeScript module calls are implementation details, not wire protocols. The daemon's browser runtime controller and Playwright runner do not negotiate separate CLI-daemon protocols.
- Nested payload schemas inside daemon.v1 requests or responses do not negotiate independently on the CLI-daemon boundary. If a job, action, checkpoint, or handover shape needs durable versioning, classify it as an internal payload or local storage schema identifier in the registry instead of a peer wire protocol.
- Local and persisted metadata schema identifiers have their own compatibility rules. They may version file contents, checkpoints, release metadata, or internal payload records, but they do not imply daemon HTTP API compatibility.
- Adding an optional response field or a new independently optional endpoint may keep the current protocol identifier when existing consumers can safely ignore it.
- Adding a required field, making an optional field required, or changing an existing field or endpoint's semantics requires a new protocol major identifier.
- Removing or renaming a field or endpoint requires a new protocol major identifier. Keep the old artifact available while any supported consumer still negotiates it.
- Every registry entry must declare one owner plus the components that accept and emit that protocol.
- `tokenless.protocol-registry.v1` is the bootstrap exception for the registry document itself. The generator validates this exact value in `registryProtocol` and rejects it as a normal protocol entry so generated constants do not recurse on their own source file.
- Generated TypeScript and JavaScript constants must be updated with `npm run protocol:generate`.
- `npm run protocol:check` must fail when generated constants are stale.
- Implemented machine-readable contracts belong in `artifacts` and must exist and pass `protocol:check`. Future contracts may be listed in `plannedArtifacts`, but a path cannot be both implemented and planned.
- Future request/response schemas must state directional extensibility explicitly. Managed Playwright job requests and visible-action requests must remain closed.
- Closed request protocols may add a request field only in a new protocol version, unless the field was already explicitly declared optional in the current schema.
- Additive response changes are compatible when consumers can ignore unknown fields. New response fields must be optional for existing consumers unless a new protocol version makes them required.
- Consumers must ignore unknown response fields unless a protocol artifact explicitly says the response is closed.
- Cryptographic proof protocols version both the protocol identifier and the exact signed input tuple. Adding, removing, reordering, renaming, recoding, or changing defaults for proof input fields requires a new proof protocol.
- The daemon readiness proof is part of daemon.v1. Changing its signed tuple is a daemon API compatibility decision, not a separate proof-protocol negotiation.
- Semantic changes require a new protocol version when they alter authorization meaning, authentication state meaning, status transitions, default behavior, retryability, terminality, idempotency, or ownership boundaries.
- Default-value changes are protocol changes when an omitted field would produce a different externally observable behavior.
- Auth and status enum changes are protocol changes unless the current artifact explicitly reserves an extensible enum value space and consumers already handle unknown values.
- Protocol versions are independent from npm package versions. A package release may contain no protocol change, and a protocol version may remain stable across many package releases.
- The daemon error contract is the single daemon.v1 OpenAPI error envelope with stable `code`, `message`, `retryable`, and optional `details` fields.
- Narrow prerelease exception: while a protocol version has not been released to real users and the project explicitly decides on a coordinated reset, a clean-break change may update that unreleased `.vN` identifier in place. Do not use this exception after external users or independently deployed consumers exist.
