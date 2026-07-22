---
"tokenless": patch
---

Ship the current Tokenless reliability release as one patch:

- Archive the browser extension and Native Messaging host under `legacy/`, leaving the managed Playwright daemon as the active runtime.
- Provision and verify the local Rust daemon before provider sign-in, restart only process-correlated stale daemons, and keep doctor diagnostics read-only.
- Add prompt-free `tokenless upgrade` with concise human progress and structured `--json` output to update the global CLI, refresh Tokenless agent skills, reconcile the packaged daemon through the verified new CLI, and report its final doctor result.
- Keep animated setup progress stable on one terminal line, including in narrow and hosted terminals.
- Make setup check every supported visible provider, preserve ChatGPT as the default run provider, reject obsolete setup-only provider filters, and document the supported browser-profile import scope.
