---
"tokenless": patch
---

Bound auto new-conversation provider completion time within the existing request deadline and continue through each untried provider route once after a submitted timeout.

在现有 request deadline 内限制 auto new-conversation 的单 provider completion 时间，并在 submitted timeout 后依次尝试每条尚未使用的 provider route 一次。
