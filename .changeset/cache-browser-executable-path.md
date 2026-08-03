---
"tokenless": minor
---

Cache the verified browser executable path in persistent config, resolve concrete browser selections during setup and install, retry standard-path discovery after stale cache entries, and add CLI and dashboard recovery controls for custom system-browser paths. Interactive setup no longer asks users to choose a normal browser runtime. Anti-Detect setup discloses Cloak installation in its initial question and uses one clean-or-compatible-profile source choice, without redundant import, copy-consent, or final installation prompts. Opaque import remains limited to profiles whose Chromium version exactly matches the supported CloakBrowser runtime, with a final compatibility check at the copy boundary.
