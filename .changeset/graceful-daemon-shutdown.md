---
"tokenless": patch
---

Graceful daemon shutdown now clears its persisted endpoint only after its SQLite job store is closed, preventing shutdown-time database lock failures.

优雅关闭 daemon 现在只会在 SQLite job store 关闭后清除已持久化的 endpoint，避免关闭期间的数据库锁失败。
