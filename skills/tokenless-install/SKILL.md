---
name: tokenless-install
description: Install, upgrade, repair, and verify Tokenless, its agent skills, local Playwright runtime, and managed browser profiles. Use for initial setup, choosing existing-profile or fresh-profile onboarding, browser sign-in handoff, upgrades, failed doctor checks, or installation integrity checks.
---

# Tokenless installation and maintenance

Complete this workflow before using the `tokenless` skill. Execute available steps yourself. Report status, manual actions, and final results in the user's preferred language, inferred from the conversation.

## Install

1. Require Node.js 22.13 or newer:

   ```bash
   node --version
   ```

   If it is missing or older, report the exact requirement and stop until the user installs it.

2. Install the latest CLI:

   ```bash
   npm install --global tokenless@latest
   ```

   Do not run profile setup as root. Setup installs and verifies both Tokenless agent skills, detects supported browsers, starts the local daemon and Playwright worker, and checks provider readiness.

3. Use one profile strategy.

   **Existing browser profile (recommended):**

   ```bash
   tokenless setup
   ```

   Run this in an interactive terminal. Let the user choose the browser, providers, source profile, and local-copy consent. Do not choose or approve profile import for the user. Setup copies only selected provider sign-in state into a separate managed profile and leaves the source unchanged.

   **Fresh profile:**

   ```bash
   tokenless setup --fresh --json
   ```

   Use this when the user requests a clean start or interactive input is unavailable. On first use it creates `default`, selects the first supported browser and ChatGPT, starts the runtime, and opens the provider when visible sign-in is needed. It never imports an existing browser profile.

4. Verify the installation:

   ```bash
   tokenless doctor --json
   ```

Report success only when `doctor` exits successfully and returns `ok: true`. Summarize skill, browser, managed profile, daemon, worker, and provider readiness without exposing account identity or authentication data.

## User handoff

Run the CLI step first. Pause only for a user-only action such as selecting or consenting to profile import, signing in, CAPTCHA, plan or permission UI, or provider confirmation.

Report the handoff in the user's preferred language with exactly three short parts:

1. **Completed locally:** state which installation steps succeeded.
2. **Action needed:** give the exact visible action and name the managed profile and provider when known.
3. **Next verification:** ask the user to reply when finished, then resume the same setup flow when applicable and rerun `doctor`.

Keep authentication data inside the managed profile. Never ask for a cookie, browser-storage value, password, hidden header, or other secret. Do not bypass login, CAPTCHA, copy consent, or provider confirmation.

## Upgrade

```bash
npm install --global tokenless@latest
tokenless setup --fresh --refresh-skills --json
tokenless doctor --json
```

Setup refreshes the packaged runtime and both agent skills while reusing the registered default profile. Do not re-import, reset, or replace a profile during upgrade unless the user explicitly asks. Report completion only after `doctor` is healthy.

## Doctor and repair

Run `tokenless doctor --json` first and use its exact failed check as the repair boundary:

- Node.js failure: require Node.js 22.13 or newer.
- CLI, daemon, or Playwright worker failure: rerun `npm install --global tokenless@latest`, then `tokenless setup --fresh --refresh-skills --json` and `doctor`.
- Browser failure: require a supported installed browser selected by setup; do not silently substitute another browser.
- Missing default profile: run fresh setup to create one. For an invalid existing profile, report it instead of replacing it automatically.
- Profile import failure: report the copy error and retry only with user consent. Never mutate the source profile.
- Provider unauthenticated or visibly blocked: run `tokenless profiles open --profile <slug> --provider <id>`, use the user handoff, then rerun `doctor`.
- Unknown or contradictory output: report the exact failed check and stop instead of guessing, weakening validation, or switching to direct mode.

Neither this skill nor the agent may inspect, print, log, export, or transmit authentication state.
