# Daemon Fastify HTTP API

Status: cancelled | Priority: P1

Disposition: cancelled after the daemon v1 clean break removed the remote-worker
HTTP surface and kept the small built-in Node HTTP server. Adding Fastify would
increase the protocol and dependency surface without serving a current product
need. This document is preserved as historical design context only.

Depends on: Local daemon job persistence, claim leases, the Tokenless Daemon API v1 OpenAPI contract, and embedded browser-runtime supervision

## Outcome

The Tokenless daemon exposes its existing durable asynchronous job workflow through a maintainable Fastify server. Trusted local callers can submit a job over HTTP, poll one stable job resource, observe coarse durable status, and retrieve the final provider result after completion.

The first supported interaction model is deliberately simple:

1. create a job with `POST /jobs`;
2. retain the returned `job_id`;
3. poll `GET /jobs/{job_id}`;
4. continue while the job is non-terminal;
5. handle `waiting_for_user` through the returned blocker; and
6. read the complete result or error from the terminal job.

Fastify replaces the bare `node:http` routing implementation. It does not replace the SQLite job store, runner ownership model, claim fencing, provider action protocol, or visible provider execution boundary.

## Decision Summary

- Use Fastify for daemon routing, request lifecycle, schema integration, authentication hooks, and graceful shutdown.
- Keep ordinary HTTP request/response semantics for job creation and polling.
- Treat SQLite job state as the durable source of truth.
- Keep the existing daemon API paths, status codes, authentication, and error envelopes compatible during the migration.
- Report provider work coarsely as `running`; do not claim token-level, percentage, or partial-response progress.
- Return the provider response only after the job reaches `succeeded`.
- Do not add SSE, WebSocket, DOM response streaming, provider-network interception, or provider-specific streaming adapters in this roadmap.

## Current Behavior Audit

The daemon already provides the required product foundations:

- `POST /jobs` creates a durable job and wakes the embedded Playwright runtime when required.
- `GET /jobs/{job_id}` returns a public job view.
- `GET /jobs` lists public job views with status, backend, profile, provider, task, and limit filters.
- Jobs persist request, result, error, blocker, checkpoint, resume state, and timestamps in SQLite.
- Public job views omit claim tokens, runner checkpoints, resume payloads, and claim-expiry internals.
- The runner transitions jobs through `queued`, `claimed`, `running`, `waiting_for_user`, and terminal states.
- The current client waits by polling `GET /jobs/{job_id}` every 250 milliseconds by default.
- The daemon binds only to loopback and protects job and control routes with the home-scoped bearer token.
- `/health` and challenge-bound `/ready` behavior are already defined by the OpenAPI contract and cross-version conformance tests.

The missing piece is not asynchronous execution. It is a maintainable HTTP implementation and an explicitly supported polling contract for callers outside the CLI command path.

## Polling Contract

### Job Creation

`POST /jobs` retains its existing request and response semantics for protocol compatibility. The migration does not change the successful response from `200` to `202`, rename fields, introduce a new path prefix, or remove the claim token required by existing producer and worker flows.

A future caller-specific facade may adopt `202 Accepted` and omit internal ownership material, but it must be introduced through an explicit Tokenless Daemon API revision rather than silently changing existing responses.

### Job Read

`GET /jobs/{job_id}` remains the canonical polling resource. Its public response contains:

- stable job identity and execution scope;
- current durable status;
- the original request;
- `blocker_json` when user intervention is required;
- `result_json` after successful completion;
- `error_json` after failure, cancellation, or timeout; and
- creation and last-update timestamps.

Responses should include `Cache-Control: no-store`. A non-terminal response may include a conservative `Retry-After` hint without changing the JSON contract.

### Status Semantics

| Status | Caller meaning |
| --- | --- |
| `queued` | The job is durably admitted and waiting for an eligible runner. |
| `claimed` | A runner owns a live lease and is preparing execution. |
| `running` | Visible provider work is in progress; no partial answer is promised. |
| `waiting_for_user` | Execution requires explicit user action described by `blocker_json`. |
| `succeeded` | The complete provider result is available in `result_json`. |
| `failed` | Execution ended with an error in `error_json`. |
| `canceled` | Cancellation was durably confirmed. |
| `timed_out` | Execution exceeded its supported time boundary. |

Callers must treat the terminal states as authoritative. They must not infer provider completion from elapsed time, response length, browser visibility, or provider-specific DOM behavior.

## Fastify Architecture

### Server Lifecycle

The daemon owns one Fastify instance and continues to expose the underlying Node server where existing lifecycle code or integration tests require it.

- Validate the configured host before listening and reject non-loopback binds.
- Configure the existing two-megabyte HTTP body limit.
- Start with `fastify.listen({ host, port })`.
- Stop accepting new requests with `fastify.close()`.
- Coordinate browser-runtime quiescence, Fastify shutdown, and `JobStore` closure without abandoning active ownership recovery.
- Preserve signal and authenticated `/control/shutdown` behavior.

### Route Organization

Split the current monolithic request dispatcher into bounded Fastify plugins:

```text
packages/cli/src/daemon/
├── server.ts
├── auth.ts
├── schemas.ts
└── routes/
    ├── health.ts
    ├── jobs.ts
    └── control.ts
```

- `health.ts` owns unauthenticated `/health` and `/ready`.
- `jobs.ts` owns job creation, listing, lookup, claim, completion, and resume.
- `control.ts` owns browser-runtime control, worker claim-next, lifecycle mutations, cancellation, and shutdown.
- `auth.ts` owns bearer parsing and delegates constant-time verification to `JobStore`.
- `schemas.ts` owns transport-level parameter, query, body, and response schemas.

Domain rules remain outside Fastify handlers. `JobStore` continues to enforce state transitions, claim tokens, leases, execution-backend constraints, and durable persistence.

### Validation and Errors

Fastify schemas should reject malformed transport shapes and prevent accidental response-field disclosure. Existing domain validators remain responsible for semantics that require stable Tokenless error codes.

The server must normalize:

- invalid or missing JSON;
- oversized bodies;
- invalid path and query parameters;
- missing or rejected bearer tokens;
- unknown routes;
- state conflicts;
- missing jobs; and
- unexpected internal failures

into the existing status codes and documented error envelope. Fastify default error payloads must not leak through compatibility routes.

### API Source of Truth

`api/tokenless-daemon-api.openapi.json` remains the implemented HTTP contract. Fastify route schemas and serializers must stay aligned with it.

This archived roadmap predates the clean-break OpenAPI simplification. Any later caller-specific API or richer progress resource requires an explicit Tokenless Daemon API revision.

## Security Boundary

This remains a local-loopback control plane, not a remotely exposed web service.

- Bind only to verified loopback hosts.
- Require the daemon bearer token on every non-diagnostic route.
- Do not enable wildcard CORS.
- Do not place bearer tokens in URLs.
- Do not expose claim tokens, checkpoints, resume payloads, credentials, or private browser state through public job reads.
- Do not infer that adopting Fastify authorizes LAN, public Internet, or hosted-browser access.

A future local web UI or remote companion integration must define its own origin, session, CSRF, and least-privilege authorization model.

## Delivery Phases

### Phase 0: Freeze Observable HTTP Behavior

- Record the current route, status, authentication, body-limit, response, error, readiness, and shutdown behavior in real daemon-process integration tests.
- Identify every cross-version client expectation before changing the server implementation.
- Document polling as the supported asynchronous result flow.

Exit: the existing daemon behavior has real-process conformance coverage sufficient to detect a transport regression.

### Phase 1: Introduce Fastify with Route Parity

- Add Fastify as a runtime dependency.
- Replace the manual `node:http` dispatcher with the Fastify lifecycle.
- Register health, job, and control route plugins.
- Preserve loopback enforcement, body limits, authentication, and graceful shutdown.
- Keep request and response JSON unchanged.

Exit: the full current daemon conformance suite passes against Fastify without client changes.

### Phase 2: Schema and Error Hardening

- Add route schemas for parameters, queries, bodies, and responses.
- Add response serializers that prevent internal job fields from crossing public routes.
- Normalize Fastify parse, validation, body-limit, not-found, and internal errors into the existing daemon contract.
- Add `Cache-Control: no-store` and an optional polling hint where compatible.

Exit: malformed, unauthorized, oversized, conflicting, and successful requests produce the documented stable contract through a built daemon process.

### Phase 3: Public Polling Documentation

- Document authenticated local HTTP submission and polling for both Chinese-speaking and English-speaking users.
- Provide minimal `curl`, Node `fetch`, and terminal-state examples without exposing the bearer token in logs or URLs.
- Explain that `running` is coarse provider progress and that only `succeeded` contains a complete response.
- Add a changeset because the supported external CLI/daemon surface becomes user-visible.

Exit: a trusted local caller can implement the full asynchronous flow from public documentation without relying on CLI internals.

## Acceptance Criteria

- The daemon HTTP implementation uses Fastify and no longer contains a manual method-and-path dispatcher.
- Existing Tokenless Daemon API v1 clients continue to operate without request or response changes.
- `POST /jobs` durably creates a job and returns before visible provider completion.
- `GET /jobs/{job_id}` returns the latest durable state throughout execution.
- Polling observes `waiting_for_user` blockers and every terminal outcome.
- `succeeded` returns the same complete managed provider result consumed by the CLI.
- Public job reads never expose claim tokens, checkpoints, resume payloads, or claim-expiry internals.
- Non-loopback binding remains rejected.
- Missing and rejected authentication remain distinguishable under the existing error contract.
- Shutdown closes HTTP admission, browser-runtime work, and SQLite ownership in the documented order.
- Focused integration tests exercise the built daemon process, real HTTP socket, real filesystem, and real SQLite store without mocks, fakes, Fastify injection, or source-string assertions.
- Cross-version conformance passes in every supported client/daemon direction.

## Required Evidence

| Scenario | Observable proof |
| --- | --- |
| Create and poll | A real HTTP client creates a job, polls the same id, and observes durable status. |
| Successful completion | A managed job reaches `succeeded` and returns its complete `result_json`. |
| User handover | Polling exposes `waiting_for_user` and the durable blocker without creating a replacement job. |
| Failure and cancellation | Polling returns the correct terminal status and error payload. |
| Daemon restart | A persisted job remains queryable from the restarted built daemon. |
| Authentication | Missing and invalid bearer tokens are rejected; diagnostic routes remain available as documented. |
| Body limit | Oversized and malformed requests preserve the documented response semantics. |
| Compatibility | Historical supported clients operate against the Fastify daemon and the current client operates against historical supported daemons. |
| Shutdown | Authenticated shutdown stops new admission and closes runtime and store resources cleanly. |

Provider browser E2E coverage is not required solely to prove the Fastify transport migration because provider execution behavior is unchanged. Existing gated real-provider suites remain the authority for visible provider completion.

## Risks and Responses

| Risk | Response |
| --- | --- |
| Fastify defaults change status codes or error bodies | Install a Tokenless error handler and verify exact real-socket conformance. |
| Schema serializers drop compatibility fields | Compare every success response against the OpenAPI fixtures through the built daemon. |
| Fastify shutdown races browser-runtime recovery | Keep one daemon-owned close sequence and exercise active-job shutdown. |
| Runtime dependency size or startup time increases | Measure packaged startup and retain only Fastify core for this roadmap. |
| Callers poll too aggressively | Document a conservative interval and provide a compatible `Retry-After` hint. |
| `running` is mistaken for precise provider progress | Define it explicitly as coarse visible-provider execution with no partial-result promise. |
| A local HTTP API is mistaken for a public web API | Preserve loopback-only binding, bearer authentication, and default-deny cross-origin behavior. |

## Non-Goals

- Server-Sent Events
- WebSocket
- Streaming or partial AI responses
- DOM mutation observation or periodic response extraction
- Provider-specific progress percentages
- Interception of provider network traffic or private APIs
- Remote, LAN, or public daemon binding
- A hosted web application authentication model
- A new job database or queue implementation
- Changes to provider action execution or completion detection
