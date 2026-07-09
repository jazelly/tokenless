# Tokenless Daemon

This crate is the first Rust foundation for the Tokenless local control plane.
It is intentionally independent from the existing Node CLI/native-host path.

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

The current API supports creating, listing, reading, claiming, and completing
jobs through the CLI and a local HTTP skeleton. Claiming uses atomic SQLite
updates so a queued job can only be claimed once.

`claim_token` is treated as a capability. Create responses return it to the
creator, and the protected bridge-facing claim-next response returns it to the
trusted bridge. Public list/get/claim/complete responses expose only a public
job view.

## Local commands

```sh
cargo test --manifest-path packages/daemon/Cargo.toml
cargo build --manifest-path packages/daemon/Cargo.toml
```

Example:

```sh
cargo run --manifest-path packages/daemon/Cargo.toml -- \
  --home /tmp/tokenless-home \
  create --provider chatgpt --action submit_and_read --request-json '{"prompt":"hello"}'
```

Start the local HTTP daemon:

```sh
cargo run --manifest-path packages/daemon/Cargo.toml -- \
  --home /tmp/tokenless-home \
  serve --host 127.0.0.1 --port 7331
```

The daemon binds to `127.0.0.1:7331` by default.
It rejects non-loopback bind hosts such as `0.0.0.0` by default because the
HTTP API is a local control plane.

Available JSON endpoints:

- `GET /health`
- `GET /ready`
- `POST /jobs`
- `GET /jobs`
- `GET /jobs/{job_id}`
- `POST /jobs/{job_id}/claim`
- `POST /jobs/{job_id}/complete`
- `POST /control/jobs/claim-next`

## Protected control endpoint

`POST /control/jobs/claim-next` is intended for the future native-host or
extension bridge. It requires:

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

Security note: this remains a loopback-only local control plane. The bearer
token only protects trusted local bridge operations; it is not remote network
auth and should not be copied into logs, telemetry, or provider sessions.
