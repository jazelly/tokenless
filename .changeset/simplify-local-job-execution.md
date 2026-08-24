---
"tokenless": minor
---

Use one `tokenless.sqlite3` for current business records: jobs, provider Project and conversation mappings, Responses API continuation entries, output-savings events, provider status observations, and Tokenless Harness context when used. Keep only in-flight Web AI execution in daemon memory; remove custom writer/startup locks, claim leases, checkpoints, replay/resume, delayed recovery, idempotency-key aliases, dispatch-certainty state, request-cancellation tombstones, legacy profile-registry import, and the background output-savings queue. Unfinished jobs fail with `job_interrupted` after restart; completed history and continuation state remain available.

只使用一个 `tokenless.sqlite3` 存储当前业务记录：jobs、provider Project 与 conversation mappings、Responses API continuation entries、output-savings events、provider status observations，以及使用 Tokenless Harness 时的 context。只有 in-flight Web AI execution 留在 daemon memory；移除自定义 writer/startup lock、claim lease、checkpoint、replay/resume、delayed recovery、idempotency-key alias、dispatch-certainty state、request-cancellation tombstone、旧 profile-registry import 与后台 output-savings queue。重启后未完成 job 以 `job_interrupted` 失败；已完成历史和 continuation state 会继续保留。
