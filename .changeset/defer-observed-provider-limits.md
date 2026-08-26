---
"tokenless": patch
---

Defer providers after a real visible rate-limit observation so auto routing does not immediately select the same exhausted provider again.

真实可见的 rate-limit observation 出现后暂时 defer 对应 provider，避免 auto routing 立即再次选择同一个已耗尽 provider。
