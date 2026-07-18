---
name: tokenless-install
description: Install, upgrade, repair, and verify Tokenless and its main agent skill. Use for initial setup, Playwright or managed-Chrome-profile readiness, browser sign-in handoff, upgrades, failed doctor checks, or installation integrity checks.
---

# Tokenless installation and maintenance

Complete this workflow before using the `tokenless` skill. Execute commands yourself, keep user-facing updates short, and report every status, manual action, and result in the user's preferred language. Infer that language from the conversation and default to the latest user message.

## Install

1. Require Node.js 24.15 or newer:

   ```bash
   node --version
   ```

   If it is missing or older, report the exact requirement and stop until the user installs it.

2. Run the canonical interactive setup. It installs and verifies both Tokenless skills from `github.com/jazelly/tokenless`, detects supported browsers, configures or explicitly re-imports one managed profile, asks for preferred providers, starts the local runtime, and performs visible readiness checks:

   ```bash
   npx tokenless@latest setup
   ```

3. Verify the complete installation:

   ```bash
   npx tokenless@latest doctor --json
   ```

Report success only when `doctor` exits successfully and returns `ok: true`. Summarize skill, browser, managed profile, daemon, worker, and visible provider readiness without exposing account identity or credential data.

## User handoff for browser actions

Run the CLI step first. Pause only when Tokenless reports a user-only action, such as:

- approving the exact local browser profile copy described by interactive setup;
- signing in inside the visible Tokenless-managed browser window;
- completing CAPTCHA, plan, permission, or provider confirmation UI.

Report the handoff in the user's preferred language with exactly three short parts:

1. **Completed locally:** state which installation steps succeeded.
2. **Action needed:** give the exact visible user action and name the affected managed profile and provider when known.
3. **Next verification:** ask the user to reply when finished, then rerun `setup` if requested and always rerun `doctor`.

Never install or request a browser extension. Never ask for an extension id, cookie, browser-storage value, password, hidden header, or other secret. Do not bypass login, CAPTCHA, copy consent, or provider confirmation.

## Upgrade

```bash
npx tokenless@latest setup --refresh-skills
npx tokenless@latest doctor --json
```

`setup` refreshes the packaged runtime while preserving registered managed profiles. Do not download or substitute binaries manually. Report completion only after the refreshed `doctor` result is healthy.

## Doctor and repair

Run `npx tokenless@latest doctor --json` first and use its exact failed check as the repair boundary:

- Node.js failure: require Node.js 24.15 or newer.
- CLI, daemon, or Playwright worker failure: rerun `npx tokenless@latest setup`, then rerun `doctor`.
- Browser failure: require a supported installed browser selected by setup; do not silently substitute a different browser.
- Missing or invalid default profile: rerun setup to create or select one. Never delete a profile unless the user explicitly requests removal and confirms it.
- Profile re-import failure: report the copy error and retry only with user consent. The source browser may remain open; a failed or unusable clone must never trigger extension fallback or mutation of the source profile.
- Provider unauthenticated or visibly blocked: open it with `npx tokenless@latest profiles open --profile <slug> --provider <id>`, use the user handoff, then rerun `doctor`.
- Unknown or contradictory output: report the exact failed check and stop instead of guessing, weakening validation, or switching to direct mode.

Keep all authentication state private. Tokenless may preserve it opaquely in a managed local browser profile, but neither this skill nor the agent may inspect, print, log, export, or transmit it.
