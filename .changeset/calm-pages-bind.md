---
"tokenless": minor
---

Add caller-controlled Page Refs so independent provider work owns independent tabs while multi-turn work can reuse one stable tab.
Remove the E2E-only provider-task isolation branch and recover cleanly when users close managed tabs.

新增由调用方控制的 Page Ref，让独立的 provider 工作使用独立 tab，同时让多轮工作稳定复用同一个 tab。
移除仅供 E2E 使用的 provider-task 隔离分支，并在用户关闭托管 tab 后安全恢复。
