---
"tokenless": patch
---

Wait for Qwen attachments to finish visible parsing before prompt submission, use provider-specific interaction windows, require provider acknowledgement after one actionable submit click, and fail response reads that have no visible answer.

在提交 prompt 前等待 Qwen 附件完成可见解析，使用 provider-specific 交互等待窗口，在唯一一次可操作提交点击后要求 provider acknowledgement，并让没有可见答案的 response read 明确失败。
