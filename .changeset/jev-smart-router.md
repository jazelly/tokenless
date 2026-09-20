---
"tokenless": patch
---

Add the Jev smart-router engine (powered by the TypeSafe SDK) as an optional task router. When `router.enabled` is set with `router.engine: "jev"`, `router.providers`, and a `router.jevApiKey`, Tokenless can route a prompt to the best-suited configured provider based on each provider's declared `suitableTasks`. Adds a dashboard Routing view and `/dashboard-api/v1/jev/*` endpoints to run routing decisions and inspect their history.
