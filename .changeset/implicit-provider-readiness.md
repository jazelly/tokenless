---
"tokenless": patch
---

Keep managed browsers resident across jobs and daemon restarts. Dashboard provider-readiness refreshes run headlessly when the profile is idle, reuse an existing headed browser without replacing or foregrounding it, and reserve visible browser handoff for explicit user actions.

Managed browsers 会跨 jobs 和 daemon 重启保持常驻。Dashboard 刷新 Provider 就绪状态时，会在 Profile 空闲时以 headless 方式运行；已有 headed browser 时则静默复用且不替换或带到前台，仅在用户显式操作时启动可见 handoff。
