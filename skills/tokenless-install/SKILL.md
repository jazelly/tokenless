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

2. Install the main Tokenless skill in the same skill scope:

   ```bash
   npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless --yes
   ```

3. Provision the current CLI, daemon, Playwright worker, and managed Chrome profile:

   ```bash
   npx tokenless@latest setup --json
   ```

4. Verify the complete installation:

   ```bash
   npx tokenless@latest doctor --json
   ```

Report success only when `doctor` exits successfully and returns `ok: true`. Summarize the resolved profile, Chrome readiness, daemon and worker readiness, and visible provider status without exposing account identity or credential data.

## User handoff for browser actions

Run the CLI step first. Pause only when Tokenless reports a user-only action, such as:

- closing ordinary Chrome before an explicitly consented local profile copy;
- approving the exact local Chrome profile copy described by interactive setup;
- signing in inside the visible Tokenless-managed Chrome window;
- completing CAPTCHA, plan, permission, or provider confirmation UI.

Report the handoff in the user's preferred language with exactly three short parts:

1. **Completed locally:** state which installation steps succeeded.
2. **Action needed:** give the exact visible user action and name the affected managed profile and provider when known.
3. **Next verification:** ask the user to reply when finished, then rerun `setup` if requested and always rerun `doctor`.

Never install or request a browser extension. Never ask for an extension id, cookie, browser-storage value, password, hidden header, or other secret. Do not bypass login, CAPTCHA, copy consent, or provider confirmation.

## Upgrade

```bash
npx skills update tokenless tokenless-install --yes
npx tokenless@latest setup --json
npx tokenless@latest doctor --json
```

`setup` refreshes the packaged runtime while preserving registered managed profiles. Do not download or substitute binaries manually. Report completion only after the refreshed `doctor` result is healthy.

## Doctor and repair

Run `npx tokenless@latest doctor --json` first and use its exact failed check as the repair boundary:

- Node.js failure: require Node.js 24.15 or newer.
- CLI, daemon, or Playwright worker failure: rerun `npx tokenless@latest setup --json`, then rerun `doctor`.
- Chrome failure: require installed Google Chrome; do not substitute an unverified browser channel.
- Missing or invalid default profile: rerun setup to create or select one. Never delete a profile unless the user explicitly requests removal and confirms it.
- Profile hot import failure: report the copy error and retry only with user consent. Chrome may remain open; a failed or unusable clone must never trigger extension fallback or mutation of the source profile.
- Provider unauthenticated or visibly blocked: open it with `npx tokenless@latest profiles open --profile <slug> --provider <id>`, use the user handoff, then rerun `doctor`.
- Unknown or contradictory output: report the exact failed check and stop instead of guessing, weakening validation, or switching to direct mode.

Keep all authentication state private. Tokenless may preserve it opaquely in a managed local Chrome profile, but neither this skill nor the agent may inspect, print, log, export, or transmit it.
