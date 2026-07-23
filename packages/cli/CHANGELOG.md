# tokenless

## 0.3.0

### Minor Changes

- 462123b: Add browser visibility policy support to Tokenless config and managed Playwright job requests, including durable resume after a headless job parks for user handoff.

### Patch Changes

- 6d52df5: Ship the current Tokenless reliability release as one patch:

  - Archive the browser extension and Native Messaging host under `legacy/`, leaving the managed Playwright daemon as the active runtime.
  - Remove the experimental direct runtime, direct broker, account/project routing commands, direct public exports, and direct-only documentation so managed Playwright through the authenticated local daemon is the only execution path.
  - Provision and verify the local Rust daemon before provider sign-in, restart only process-correlated stale daemons, and keep doctor diagnostics read-only.
  - Add prompt-free `tokenless upgrade` with concise human progress and structured `--json` output to update the global CLI, refresh Tokenless agent skills, reconcile the packaged daemon through the verified new CLI, and report its final doctor result.
  - Keep animated setup progress stable on one terminal line, including in narrow and hosted terminals.
  - Make setup check every supported visible provider, preserve ChatGPT as the default run provider, reject obsolete setup-only provider filters, and document the supported browser-profile import scope.

- 08000f1: Enable Chromium sandboxing for managed visible browser sessions so Chrome no longer launches with the unsupported `--no-sandbox` flag.

## 0.2.0

### Minor Changes

- 551561f: Add Grok as a visible browser-session provider across CLI setup, provider preferences, and extension routing.

## 0.1.2

### Patch Changes

- 3900934: Publish the platform-native daemon and Native Messaging runtime packages required by the universal CLI.
