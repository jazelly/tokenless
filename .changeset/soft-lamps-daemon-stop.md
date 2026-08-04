---
"tokenless": patch
---

Negotiate daemon reuse independently from package versions, and add `tokenless daemon stop` with same-home ready verification followed by bearer-authenticated graceful self-shutdown that waits for the daemon-managed browser to release its profile before returning.
