---
"tokenless": minor
---

Use one `tokenless.sqlite3` for Tokenless API and Tokenless Harness business records. Keep job execution in the current daemon process; remove custom writer/startup locks, claim leases, checkpoints, replay/resume, delayed recovery, idempotency-key aliases, dispatch-certainty state, request-cancellation tombstones, legacy profile-registry import, and the background output-savings queue. Unfinished jobs fail with `job_interrupted` after restart; Web AI duplicate starts fail clearly.

Tokenless API 与 Tokenless Harness 的业务记录共用一个 `tokenless.sqlite3`。Job execution 仅属于当前 daemon process；移除自定义 writer/startup lock、claim lease、checkpoint、replay/resume、delayed recovery、idempotency-key alias、dispatch-certainty state、request-cancellation tombstone、旧 profile-registry import 与后台 output-savings queue。重启后未完成 job 以 `job_interrupted` 失败；Web AI duplicate start 会清晰失败。
