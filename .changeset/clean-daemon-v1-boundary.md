---
"tokenless": minor
---

Unify and simplify the local CLI-daemon HTTP boundary under `tokenless.daemon.v1`: keep only public job and browser-runtime routes, run Playwright coordination in-process, require proof before bearer use, and remove unreleased legacy payloads and extension compatibility.
