---
"tokenless": patch
---

Consolidate managed browser control on CDP, remove the obsolete browser connection mode from configuration and UI contracts, and keep Playwright's page and locator APIs for automation. Existing configuration files must remove `browserConnectionMode`; all legacy values are rejected.
