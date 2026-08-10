---
"tokenless": patch
---

Complete Linux x64 managed browser support: add the pinned Chrome for Testing 146 entry so `auto` resolves on Linux instead of failing with a missing catalog entry, discover system browsers from their Linux install paths instead of falling through to the Windows branch, and extract zip artifacts with unzip where GNU tar cannot read them.
