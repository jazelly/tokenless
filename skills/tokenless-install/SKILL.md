---
name: tokenless-install
description: Install, upgrade, repair, and verify Tokenless, including source-linked development installs, the macOS menu bar app, agent skills, and local runtimes. Use only when the user explicitly asks for installation, upgrade, repair, browser sign-in handoff, a failed doctor check, or an installation integrity check.
---

# Tokenless installation and maintenance

Use this workflow only for the maintenance task the user explicitly requested; it is not a prerequisite for every provider job. Execute the documented noninteractive maintenance and verification commands yourself. Managed-profile initialization and import are user-run workflows outside the agent session: never initiate either one or traverse providers on the user's behalf. Report status, manual actions, and final results in the user's preferred language, inferred from the conversation.

## Choose the maintenance path

- For a normal published-package install or upgrade, use the canonical `tokenless upgrade --json` workflow below.
- When the user explicitly makes a repository checkout the canonical local installation, use **Source checkout refresh**. Do not run `tokenless upgrade`: it replaces the requested development link with the published package.
- Do not infer permission to discard a dirty worktree, replace profiles, reset `~/.tokenless`, or change provider membership from a request to refresh code.

## Source checkout refresh

Use the repository's own instructions, source, and scripts. Do not invoke the runtime Tokenless delegation skill while maintaining its repository.

1. Inspect the worktree, branch, remotes, linked CLI, running daemon, dashboard listener, and installed menu app. Fetch the remote and compare both SHAs before claiming the branch is current. Fast-forward the user-selected canonical branch only when the worktree is clean; otherwise preserve the changes and stop for direction.
2. Read `package.json` for the required Node.js and package-manager versions. Reinstall the lockfile exactly, then use the repository scripts:

   ```bash
   npm ci
   npm run install:macos-menu
   ```

   `install:macos-menu` builds all workspaces and the dashboard, npm-links the built CLI globally, builds the macOS app, replaces `~/Applications/Tokenless.app`, and launches it. Do not compose a parallel build or copy recipe unless the script itself fails.
3. If the direct-provider setup requires `uv`, check `command -v uv` before setup. When it is absent, report that prerequisite and install it with the platform package manager only when that host-level installation is within the user's requested setup scope. Rerun the same setup command after installation; do not disable the direct runtime merely to make setup green.
4. Preserve the user's existing browser, profile, provider, language, API-proxy, and output-savings choices. Run `tokenless setup` only when the user requested setup or configuration reconciliation, using explicit noninteractive flags derived from those persisted choices. Browser remote-debugging approval, authentication, CAPTCHA, and consent remain user actions.
5. Prove local ownership after the build:

   - the global `tokenless` symlink resolves into the requested checkout;
   - the active daemon process command resolves into that checkout, not the app's embedded fallback or a published package;
   - the daemon readiness response and dashboard snapshot report the built version;
   - the dashboard route returns HTTP 200;
   - the installed menu app is running and passes `codesign --verify --deep --strict`;
   - the installed app's embedded CLI hash matches the checkout build; and
   - the worktree remains clean and the local/remote canonical branch SHAs match.

   To make the linked CLI own daemon startup, quit the menu app, stop the daemon through the linked CLI, start it through `tokenless menubar status --json`, then reopen the menu app. This distinguishes a healthy development daemon from a matching embedded fallback.
6. If the user explicitly wants instant repository skill updates, create the requested global skill symlink only after setup or skill reconciliation, because those workflows may replace it. Preserve the previous global directory as a timestamped backup and verify both `readlink` and the resolved target. Do not link unrelated skills implicitly.

### Persisted-state incompatibility

Treat a current daemon rejecting old state as a migration problem, not as evidence that the browser or source build is broken.

- Never delete the complete Tokenless home, profile registry, or database as a generic repair.
- Stop the daemon and make timestamped backups of the exact config or database before changing it.
- For rejected legacy config fields, preserve the old file and regenerate current-schema configuration through the current CLI using the user's existing choices. Do not copy obsolete fields into the new schema.
- For a SQLite constraint or schema mismatch such as `NOT NULL constraint failed: jobs.claim_token`, inspect the live schema, row compatibility, foreign keys, and current source schema. Prefer a shipped migration. If none exists and the user authorized repair, apply only the narrow compatible migration, preserve valid history, then run `PRAGMA foreign_key_check` and `PRAGMA integrity_check` before restarting.
- Rerun the original failed boundary. Report setup as incomplete when provider readiness still awaits a user-controlled browser approval, even if the CLI, daemon, dashboard, menu app, and direct runtime are healthy.

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

   After installation, invoke only the global `tokenless` command. Never run the
   Tokenless CLI through `npx tokenless` or `npx tokenless@latest`.

3. Run the canonical maintenance workflow to reconcile the global skills and matching local daemon:

   ```bash
   tokenless upgrade --json
   ```

`upgrade` already runs the final read-only `doctor --json` check. Report full success only when its top-level result is `ok: true` and its `npmInstall`, `resolveGlobalCli`, `skills`, `runtimeInstall`, and `doctor` phases are healthy. Summarize skill, browser, managed profile, daemon, worker, and provider readiness without exposing account identity or authentication data. If the CLI, skills, and local runtime phases succeed but doctor reports that no managed profile exists, report that the CLI installation completed and provider readiness is pending user-run profile initialization. Do not start that workflow for the user.

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

When `tokenless upgrade` is available, it is the canonical upgrade path. The command itself is prompt-free and does not read answers from stdin. Agents must use its structured automation form instead of composing separate npm, skill, runtime, or doctor commands:

```bash
tokenless upgrade --json
```

The command owns this order:

1. Install `tokenless@latest` globally with npm.
2. Resolve and verify the installed package, version, binary declaration, and exact CLI entrypoint before handing off to new code.
3. Use that verified new CLI's shared maintenance reconciler to upsert both
   GitHub-backed Tokenless agent skills globally and reconcile the matching
   packaged daemon runtime.
4. Use the same new CLI to run the final read-only `doctor --json` check.

Do not initialize, import, reset, or replace a managed profile before or after an upgrade. If the returned doctor result identifies a profile or provider problem, report it as a user-run follow-up. Upgrade does not sign in to providers or alter managed profiles.

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
- Browser failure: require a supported installed browser selected by the user; do not silently substitute another browser.
- Missing default profile: report that the user must initialize a managed profile manually. Do not create one for them.
- Profile import failure: report the copy error and tell the user that import must be retried manually. Never inspect, copy, or mutate the source profile.
- Provider unauthenticated or visibly blocked: run `tokenless profiles open --profile <slug> --provider <id>`, use the user handoff, then rerun `profiles status` and `doctor`.
- Unknown or contradictory output: report the exact failed check and stop instead of guessing, weakening validation, or switching runtime paths.

Neither this skill nor the agent may inspect, print, log, export, or transmit authentication state.
