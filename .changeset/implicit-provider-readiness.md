---
"tokenless": patch
---

Run dashboard provider-readiness refreshes headlessly when the profile is idle, reuse an existing headed browser without replacing or foregrounding it, and reserve visible browser handoff for explicit user actions.

Dashboard 刷新 Provider 就绪状态时，会在 Profile 空闲时以 headless 方式运行；已有 headed browser 时则静默复用且不替换或带到前台，仅在用户显式操作时启动可见 handoff。
