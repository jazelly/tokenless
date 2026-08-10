---
"tokenless": patch
---

Observe visible pending processing on the same normalized-name Qwen attachment cards, then wait for them to remain visibly ready for a short bounded window before prompt submission; use provider-specific interaction windows, require provider acknowledgement after a visible submit click, retry that click once only when the visible draft remains actionable without a transition, and fail response reads that have no visible answer.

在提交 prompt 前先观察同一组规范化文件名的 Qwen 附件卡片处于可见 pending processing，再等待其在短暂的有界窗口内持续可见就绪；使用 provider-specific 交互等待窗口，在可见 submit click 后要求 provider acknowledgement；仅在没有转换且可见 draft 仍可操作时重试一次点击，并让没有可见答案的 response read 明确失败。

The final 2026-08-10 lifecycle run passed three-file readiness and visible prompt input, but received no submission acknowledgement (`provider_submitted_at` stayed unset) and produced no response or savings event; the route remains unadvertised.

最终的 2026-08-10 lifecycle run 已通过三文件 readiness 与可见 prompt input，但没有得到 submission acknowledgement（`provider_submitted_at` 仍未设置），也没有 response 或 savings event；route 仍未公开。
