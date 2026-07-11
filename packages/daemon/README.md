# Tokenless Daemon

This crate implements the Tokenless local control plane and Chrome Native
Messaging host. It has no Node runtime dependency.

The daemon state lives in SQLite at:

- `$TOKENLESS_HOME/tokenless.sqlite3` when `TOKENLESS_HOME` is set
- `--home <path>/tokenless.sqlite3` when an explicit home is passed to the CLI
- `~/.tokenless/tokenless.sqlite3` by default

The protected local control token lives next to the database at:

- `$TOKENLESS_HOME/daemon.token` when `TOKENLESS_HOME` is set
- `--home <path>/daemon.token` when an explicit home is passed to the CLI
- `~/.tokenless/daemon.token` by default

`JobStore::open` creates the token file when missing. On Unix the daemon home is
restricted to `0700` and `daemon.token` is restricted to `0600`.

The API supports creating, listing, reading, claiming, canceling, and completing
jobs. Claims use atomic SQLite updates, rotating per-claim tokens, and renewable
leases. Expired claims are requeued so an extension or native-host crash cannot
strand a job.

`claim_token` is treated as a capability. Create responses return it to the
authenticated creator, and the protected bridge-facing claim-next response
returns it to the trusted bridge. List/get/claim/complete responses expose only
a token-free job view.

## Local commands

```sh
cargo test --manifest-path packages/daemon/Cargo.toml
cargo build --manifest-path packages/daemon/Cargo.toml
```

Example:

```sh
cargo run --manifest-path packages/daemon/Cargo.toml --bin tokenless-daemon -- \
  --home /tmp/tokenless-home \
  create --provider chatgpt --action submit_and_read --request-json '{"prompt":"hello"}'
```

Start the local HTTP daemon:

```sh
cargo run --manifest-path packages/daemon/Cargo.toml --bin tokenless-daemon -- \
  --home /tmp/tokenless-home \
  serve --host 127.0.0.1 --port 7331
```

The daemon binds to `127.0.0.1:7331` by default.
It rejects non-loopback bind hosts such as `0.0.0.0` by default because the
HTTP API is a local control plane.

Available JSON endpoints:

- `GET /health`
- `GET /ready?challenge=<base64url>`
- `POST /jobs`
- `GET /jobs`
- `GET /jobs/{job_id}`
- `POST /jobs/{job_id}/claim`
- `POST /jobs/{job_id}/complete`
- `POST /control/jobs/claim-next`
- `POST /control/jobs/{job_id}/cancel`

`GET /health` is an unauthenticated diagnostic and must not be trusted as daemon
identity. `GET /ready` requires a canonical unpadded base64url challenge that
decodes to exactly 32 bytes. A valid response identifies the canonical daemon
home, exposes `tokenless.daemon.v1`, `tokenless.native.v1`, and the binary
version, and adds:

```json
{
  "ready_proof_protocol": "tokenless.daemon-ready-proof.v1",
  "ready_challenge": "<exact challenge>",
  "ready_proof": "<unpadded base64url HMAC-SHA256>"
}
```

The HMAC key is the UTF-8 daemon-token string. Its canonical message contains,
in order, the proof protocol, challenge, daemon protocol, native protocol, and
the exact returned canonical `home_dir`. Each UTF-8 field is prefixed by its
four-byte unsigned big-endian byte length, with no separator or terminator.
Missing, padded, noncanonical, or wrong-length challenges return `400` without
a proof. Every `/jobs` and `/control/jobs` request requires
`Authorization: Bearer <contents of daemon.token>`.

`GET /jobs` accepts optional `status`, `provider`, `task_id`, and `limit` query
parameters. `task_id` is an exact indexed match against bounded task keys
projected at job creation from top-level `taskId`, `idempotencyKey`, or
`requestId`, and from `metadata.taskId` or `metadata.idempotencyKey`. Results
remain newest-first and `limit` is clamped to `1..=1000`.

## Native Messaging host

Both entry points run the same Rust native-host implementation:

```sh
tokenless-daemon --home /path/to/home native-host
tokenless-native-host
```

`tokenless-native-host` resolves `TOKENLESS_HOME` first. Without that variable,
an installed `<home>/bin/tokenless-native-host[.exe]` resolves `<home>` from its
executable location. Chrome origin and parent-window arguments are ignored.

Native messages use four-byte little-endian length framing followed by JSON.
Requests, responses, and pushes use `protocol: "tokenless.native.v1"`; missing
or different protocol versions are rejected. The host never writes logs to
stdout and caps host-to-Chrome messages at 1 MiB.

The long-lived `tokenless.native.daemon_connect` bridge claims directly from
SQLite, transitions a job to `running`, renews its lease while the extension is
working, and waits for a strictly correlated ready message before claiming
another job:

```json
{
  "protocol": "tokenless.native.v1",
  "type": "tokenless.native.daemon_ready",
  "jobId": "<current job_id>",
  "claimToken": "<current claim_token>"
}
```

Both fields must match the current claim. Bare, duplicate, or stale ready
messages are rejected and cannot release a different claim. Configuration
lives in `<home>/config.json` with protocol
`tokenless.config.v1` and is replaced atomically with `0600` permissions on
Unix. Native history uses a dedicated scalar-only SQLite query and is a
bounded, redacted summary without prompts, results, errors, arbitrary error
codes, or claim tokens.

While connected, the host atomically maintains:

- `<home>/extension-bridge.json`
- protocol `tokenless.extension-bridge-state.v1`
- fields `sessionId`, `pid`, `connectedAt`, and `heartbeatAt`

The bridge also holds an exclusive session lock for its lifetime. A competing
bridge receives a retryable `bridge_busy` error instead of superseding the
active lease owner. Short-lived ping, configuration, history, and completion
native hosts do not acquire this lock and remain available. The marker is
heartbeated while connected and removed on graceful disconnect only when its
on-disk `sessionId` still belongs to that host.

## Protected job endpoints

Every endpoint listed above except `/health` and `/ready` requires:

```http
Authorization: Bearer <contents of daemon.token>
```

Optional query filters:

- `provider`
- `action`

Example:

```sh
TOKEN="$(tr -d '\n' < /tmp/tokenless-home/daemon.token)"
curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  "http://127.0.0.1:7331/control/jobs/claim-next?provider=chatgpt&action=submit_and_read"
```

The response is always JSON. When a queued job is claimed, the daemon returns:

```json
{
  "job": {
    "job_id": "...",
    "claim_token": "...",
    "provider": "chatgpt",
    "action": "submit_and_read",
    "status": "claimed",
    "request_json": {},
    "result_json": null,
    "error_json": null,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

When no queued job matches, the daemon returns `200 OK` with:

```json
{ "job": null }
```

Missing bearer auth returns `401` JSON. Invalid bearer auth returns `403` JSON.
Cancellation accepts an empty body or `{ "reason": <structured JSON> }` and
atomically transitions a queued, claimed, or running job to `canceled`.

Security note: this remains a loopback-only local control plane. The bearer
token protects all job data and mutations from unrelated local processes; it
is not remote network auth and should not be copied into logs, telemetry, or
provider sessions.
