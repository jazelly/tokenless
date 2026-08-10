---
"tokenless": patch
---

Wait for provider responses and managed job completion without a universal elapsed-time deadline while preserving explicit cancellation and runner shutdown. Explicit `--timeout-ms` continues to cancel the waiting job when it elapses.

等待 provider 响应和托管任务完成时不再使用统一的耗时截止，同时保留显式取消与 runner 停止能力。显式 `--timeout-ms` 到期时仍会取消正在等待的任务。
