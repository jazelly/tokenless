---
"tokenless": minor
---

Allow API proxy execution mode preference to hold both `browser` and `direct`, tried in the configured order when a request does not pin one. Existing config files with the older single-mode `executionMode` value are read as that one mode, preserving the previous `enabled` setting.
