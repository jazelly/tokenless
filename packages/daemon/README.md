# Tokenless Daemon

This crate implements the Tokenless local control plane. It has no Node runtime dependency.

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
leases. Expired claims are requeued so a worker crash cannot strand a job.

`claim_token` is treated as a capability. Create responses return it to the
authenticated creator, and protected claim responses return it to the trusted
worker. List/get/claim/complete responses expose only a token-free job view.

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
home, exposes `tokenless.daemon.v1`, and the binary version, and adds:

```json
{
  "ready_proof_protocol": "tokenless.daemon-ready-proof.v1",
  "ready_challenge": "<exact challenge>",
  "ready_proof": "<unpadded base64url HMAC-SHA256>"
}
```

The HMAC key is the UTF-8 daemon-token string. Missing, padded, noncanonical, or
wrong-length challenges return `400` without a proof. Every `/jobs` and
`/control/jobs` request requires `Authorization: Bearer <contents of daemon.token>`.

`GET /jobs` accepts optional `status`, `provider`, `task_id`, and `limit` query
parameters. Results remain newest-first and `limit` is clamped to `1..=1000`.

## Protected job endpoints

Every endpoint listed above except `/health` and `/ready` requires:

```http
Authorization: Bearer <contents of daemon.token>
```

Example:

```sh
TOKEN="$(tr -d '\n' < /tmp/tokenless-home/daemon.token)"
curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  "http://127.0.0.1:7331/control/jobs/claim-next?provider=chatgpt&action=submit_and_read"
```

The response is always JSON. When a queued job is claimed, the daemon returns the
claimed job with `claim_token`. When no queued job matches, the daemon returns
`200 OK` with `{ "job": null }`.

Missing bearer auth returns `401` JSON. Invalid bearer auth returns `403` JSON.
Cancellation accepts an empty body or `{ "reason": <structured JSON> }` and
atomically transitions a queued, claimed, or running job to `canceled`.

Security note: this remains a loopback-only local control plane. The bearer
token protects all job data and mutations from unrelated local processes; it
is not remote network auth and should not be copied into logs, telemetry, or
provider sessions.
