---
name: tokenless-install
description: Install, upgrade, repair, and verify Tokenless, its agent skills, local Playwright runtime, and managed browser profiles. Use for initial noninteractive setup, fresh or import onboarding, browser sign-in handoff, upgrades, failed doctor checks, or installation integrity checks.
---

# Tokenless installation and maintenance

Complete this workflow before using the `tokenless` skill. Execute every CLI step yourself. Never run interactive setup prompts: this skill runs inside an agent session where a human cannot answer CLI questions. Collect any required choices in chat, then pass them as flags. Report status, manual actions, and final results in the user's preferred language, inferred from the conversation.

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

3. Choose one noninteractive profile strategy in chat, then run the matching command. Never run bare `tokenless setup`.

   **Fresh managed profile (default when the user does not ask to import):**

   ```bash
   tokenless setup --fresh --json
   ```

   On first use this creates `default`, selects the first supported browser and ChatGPT, starts the runtime, and opens the provider when visible sign-in is needed. It never imports an existing browser profile.

   **Import an existing browser profile (only after explicit user choice in chat):**

   ```bash
   tokenless profiles discover --browser chrome --json
   ```

   Ask the user which discovered `directoryKey` and which providers to import. Then run:

   ```bash
   tokenless setup \
     --browser chrome \
     --preferred-providers chatgpt \
     --import-browser-profile "Default" \
     --consent-local-profile-copy \
     --json
   ```

   Pass `--browser brave` when that is the chosen browser. Add `--browser-user-data-dir <dir>` when discover reports ambiguity. Do not invent consent: `--consent-local-profile-copy` is allowed only after the user explicitly agrees in chat to copy selected provider sign-in state into a separate managed profile. The source browser profile stays unchanged.

4. Verify the installation:

   ```bash
   tokenless doctor --json
   ```

Report success only when `doctor` exits successfully and returns `ok: true`. Summarize skill, browser, managed profile, daemon, worker, and provider readiness without exposing account identity or authentication data.

## User handoff

Run the CLI step first. Pause only for a user-only browser action such as signing in, CAPTCHA, plan or permission UI, or provider confirmation.

Report the handoff in the user's preferred language with exactly three short parts:

1. **Completed locally:** state which installation steps succeeded.
2. **Action needed:** give the exact visible action and name the managed profile and provider when known.
3. **Next verification:** ask the user to reply when finished, then run `tokenless profiles status --profile <slug> --provider <id> --json` and `tokenless doctor --json`.

Keep authentication data inside the managed profile. Never ask for a cookie, browser-storage value, password, hidden header, or other secret. Do not bypass login, CAPTCHA, copy consent, or provider confirmation.

Use `profiles open` only for headed browser handoff. It always opens a visible browser window. If a job was parked from a headless run, tell the user to resume the same job with `tokenless resume --job-id <job-id> --browser-visibility headed --json` instead of starting over.

`doctor` is read-only. It does not open or close browser windows, and Chromium sandbox stays enabled in both headless and headed modes.

## Upgrade

When `tokenless upgrade` is available, it is the canonical upgrade path. The command itself is prompt-free and does not read answers from stdin. Agents must use its structured automation form instead of composing separate npm, skill, setup, runtime, or doctor commands:

```bash
tokenless upgrade --json
```

The command owns this order:

1. Install `tokenless@latest` globally with npm.
2. Resolve and verify the installed package, version, binary declaration, and exact CLI entrypoint before handing off to new code.
3. Refresh both GitHub-backed Tokenless agent skills.
4. Use that verified new CLI to reconcile the packaged daemon and local runtime.
5. Use the same new CLI to run the final read-only `doctor --json` check.

Do not run setup before or after an upgrade unless the returned doctor result identifies a profile or provider problem that specifically requires setup. Upgrade does not run provider setup, sign in, re-import, reset, or replace a managed profile.

For a pre-upgrade CLI that reports `upgrade` as an unknown command, bootstrap the canonical command exactly once:

```bash
npm install --global tokenless@latest
tokenless upgrade --json
```

After that bootstrap, always use `tokenless upgrade --json`; do not keep maintaining a parallel manual upgrade recipe.

`--json` selects machine-readable output; it is not a different upgrade workflow or a version selector. Do not allocate a TTY, answer prompts, or add a separate noninteractive command. Human users may omit the flag and run `tokenless upgrade` for concise progress and a summary; agents and CI keep `--json` so stdout contains one structured result.

Report completion only when the top-level result has `ok: true`, every returned phase is healthy, and the nested doctor result is healthy. When `ok` is false, report the first failed phase, its stable error code, and any returned follow-up. Earlier successful phases may remain installed; do not claim rollback. Fix only the reported boundary and rerun the canonical command. If npm installation or global CLI verification fails, later phases are intentionally absent. Once the new CLI is verified, the command still attempts the final doctor check after a skill or runtime failure so the user receives a complete diagnostic.

## Doctor and repair

Run `tokenless doctor --json` first and use its exact failed check as the repair boundary:

- Node.js failure: require Node.js 22.13 or newer.
- CLI, daemon, or Playwright worker failure: run `tokenless upgrade --json`, then inspect its nested doctor result.
- Browser failure: require a supported installed browser selected by setup; do not silently substitute another browser.
- Missing default profile: run fresh setup to create one. For an invalid existing profile, report it instead of replacing it automatically.
- Profile import failure: report the copy error, obtain fresh chat consent, rediscover if needed, then retry only with `--import-browser-profile`, `--preferred-providers`, `--consent-local-profile-copy`, and `--json`. Never mutate the source profile.
- Provider unauthenticated or visibly blocked: run `tokenless profiles open --profile <slug> --provider <id>`, use the user handoff, then rerun `profiles status` and `doctor`.
- Unknown or contradictory output: report the exact failed check and stop instead of guessing, weakening validation, or switching runtime paths.

Neither this skill nor the agent may inspect, print, log, export, or transmit authentication state.
