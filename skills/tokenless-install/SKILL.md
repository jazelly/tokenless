---
name: tokenless-install
description: Install, upgrade, repair, and verify Tokenless API CLI, agent skills, browser/runtime dependencies, and the optional macOS menu app. Use for requested installation, upgrades, setup, browser sign-in handoff, or installation health checks.
---

# Tokenless API installation and maintenance

Match the requested task: install prepares software, setup changes user choices, and upgrade replaces software while preserving those choices. An audit or version check does not authorize running setup or an upgrade. Report results and user actions in the user's preferred language.

## Platform and installation channel

Identify the OS, architecture, and installation channel from the host and executable location before choosing commands. When Node is available:

```bash
node -p "process.platform + '-' + process.arch"
```

| Platform / installation | Required path | macOS menu app |
| --- | --- | --- |
| Windows x64 (prerelease) | npm CLI, local daemon, and selected browser/runtime dependencies | Do not install, build, update, or require it. |
| Apple Silicon macOS, npm CLI | npm CLI, local daemon, and selected browser/runtime dependencies | Separate, optional installation; npm install/setup does not install it. |
| Apple Silicon macOS 13+, standalone app | App bundle with embedded Node, CLI, daemon, and Node dependencies | Update the entire app through its own runtime. |

Do not infer release support for another platform from a browser artifact alone. Report an unsupported platform instead of substituting a macOS archive. Windows commands run in PowerShell or a normal terminal; do not use Bash installers, Swift, LaunchServices, Keychain steps, or `~/Applications/Tokenless.app` there.

The standalone macOS app does not require global Node or npm to run. Its base bundle excludes browser binaries and the G4F Python environment. For an explicitly requested app install, use the matching versioned release ZIP and SHA-256 checksum. For an explicitly requested source build on Apple Silicon macOS, the repository command is `npm run install:macos-menu`; it builds, installs to `~/Applications/Tokenless.app`, and launches the app. Verify the menu and daemon afterward. System security approval remains user-controlled.

## Fresh CLI installation and setup

1. Check Node.js 22.13+ and npm:

   ```bash
   node --version
   npm --version
   ```

2. Install the CLI only when installation is requested:

   ```bash
   npm install --global tokenless@latest
   tokenless --version
   tokenless skills sync --json
   ```

   Invoke the installed `tokenless` command, never `npx tokenless`. npm installation alone does not configure profiles, install the menu app, or download browsers.

3. For requested onboarding, check `uv --version`: current setup enables G4F and uses `uv sync` to prepare its pinned Python environment and provider dependencies. If a prerequisite is missing, install it within the authorized installation scope or report the exact missing prerequisite; do not claim setup completed.

4. Use `tokenless setup` for interactive user choices. When the browser/profile choices are already known and non-interactive setup is requested, use the current flags, for example:

   ```bash
   tokenless setup --browser chrome --profile <slug> --defaults --json
   ```

   Replace `<slug>` with the selected logical profile. Preserve an existing selection; do not invent another profile during maintenance. `--provider-whitelist <list>` selects enabled providers. `--no-open` suppresses the dashboard opening, not provider checks. Do not use the removed `--fresh` or browser-profile import workflow.

5. Run `tokenless doctor --json` separately after installation/setup. Report CLI installation, runtime health, setup `status`, and provider readiness separately. `action_required`, missing browser/profile, or sign-in work means onboarding is still incomplete even if software installation succeeded.

Setup synchronizes both bundled agent skills, prepares the selected browser, saves configuration, prepares G4F, reconciles the daemon, and checks enabled providers when the browser resolves. It can open provider review tabs. Do not run it just to check versions, refresh skills, or upgrade software.

Native mode uses user-installed Chrome or Brave and connects to the running browser; it does not copy/import a browser profile or download Chrome/Brave. Enable remote debugging at `chrome://inspect/#remote-debugging` or `brave://inspect/#remote-debugging` and let the user approve the connection prompt. Use `--browser-executable-path <absolute-path>` when discovery needs an explicit installed path. Native mode is headed-only.

Download CloakBrowser only for a selected Anti-Detect setup (`--browser cloak` or `--anti-detect`). Optional Codex guidance/hooks require `--install-codex`; `--codex-home <dir>` requires that flag. Ordinary setup does not install hooks, and users must trust installed hooks in Codex `/hooks` themselves.

## Upgrade

Check the selected installation without changing it:

```bash
tokenless upgrade --check --json
```

For an authorized update, explain that the daemon restarts and active tasks may be interrupted, then use the non-interactive form:

```bash
tokenless upgrade --yes --json
```

`--json` alone does not confirm an update; it fails with `upgrade_confirmation_required`. Do not request confirmation again when the user has already authorized the update. A check-only request remains read-only.

- Global npm CLI: acquire the exact checked package version, verify the global installation, stop the verified daemon, replace the package, and activate the new runtime.
- Embedded macOS CLI / menu app: use the app's update action or embedded runtime to replace the whole bundle. Upgrading global npm does not update the app, and the app does not run a global npm upgrade.
- Source checkout / linked development CLI: update and rebuild the selected checkout within the requested scope. Do not bypass the updater's global-install identity checks.

Upgrade prepares dependencies only when already enabled, applies bundled database migrations, starts the new daemon, and verifies running version, database version, and an authenticated local API request. It does not rerun setup, change browser/provider choices, replace profiles, or run doctor. It synchronizes both skills from the installed package, including when the software is already up to date. Run `tokenless doctor --json` separately when installation health verification is requested.

For npm results, inspect `ok`, `status`, and the returned `phases`; an update includes `runtimeInstall` activation proof. For macOS results, inspect `ok`, `status`, and `runtime` when updated. `up_to_date` is successful without replacement or runtime activation, but still includes skill synchronization proof (`phases.skills` for npm, `skills` for macOS). Updated runtime proof includes `skills.ok: true`. Do not require a `doctor` upgrade phase.

When an update fails, report the first failed phase or returned error code. Earlier phases may have taken effect; do not claim rollback, automatically retry, or downgrade against a migrated database. An explicitly supplied local package uses `--package <absolute-path>` with `--yes --json`: `.tgz` for npm, matching release ZIP for the embedded macOS app.

## Source checkout refresh

For an explicitly selected source checkout, preserve the development link and use the repository's instructions and scripts. Inspect its worktree and remotes, fetch, and compare the selected branch with its upstream before claiming it is synchronized. Preserve uncommitted work; fast-forward only when the checkout is clean and the histories permit it.

Read the repository's Node.js requirement, then run `npm ci` and `npm run build` in that checkout. The current build creates the development launcher and links the CLI globally. Run `npm run sync:skill` when refreshing the bundled skills. Do not replace a source-linked CLI with a published npm package.

On Apple Silicon macOS, run `npm run install:macos-menu` only when refreshing the menu app is also requested. Verify the linked CLI resolves to the selected checkout, its version is correct, and the worktree and upstream still agree. When runtime activation is requested, verify the daemon's executable belongs to that checkout; verify the installed menu app separately when it was refreshed.

A source refresh preserves configuration, profiles, and provider choices. Run setup only for requested configuration changes. If the daemon rejects persisted state, report the exact failure and use the repository's supported migration path within an authorized repair; do not delete the home or database or manually rewrite its schema to make startup pass.

## Skill distribution and synchronization

The npm package and macOS app bundle include `tokenless` and `tokenless-install` under the CLI's `dist/skills`. Install/setup and upgrade use the same local synchronizer; no global npm or separate skills CLI is needed to sync the embedded app's skills.

- Fresh npm install: run `tokenless skills sync --json` after npm; setup also syncs when onboarding continues.
- Upgrade: run the installed channel's `tokenless upgrade --yes --json`; the new package supplies its matching skills. `upgrade --check` never writes skill files.
- Skill-only repair or a newly installed agent: run `tokenless skills sync --json`. It restores the installed version, not an unreleased GitHub branch.
- Source checkout: after pulling changes and building the CLI, run `npm run sync:skill`. It uses the repository's `skills/` source and the same synchronizer. Pulling Git alone does not refresh global copies.

The canonical copy lives in `~/.agents/skills`. Existing Codex, Claude Code, Cursor, Copilot, Gemini CLI, Hermes, OpenCode, Pi, Windsurf, and legacy `.agent` roots receive complete copies, including `agents/openai.yaml` and supporting resources. Configured Codex/Claude/OpenCode roots are respected. Only the two product-owned skill directories are replaced; unrelated skills and agent instructions stay intact.

Doctor compares every skill file against the installed package. Reload or start a new agent session after sync if it has already loaded the old instructions. To distribute a skill change to other package users, include it in a release through repository release automation; local edits or local sync do not publish it.

## Doctor and targeted repair

Start with `tokenless doctor --json` and repair only the reported boundary:

- Missing CLI or a CLI too old to expose `upgrade`: install `tokenless@latest` globally for the npm channel, then inspect that installed CLI's help. Do not replace an app runtime with npm.
- Missing/stale skills: run `tokenless skills sync --json`, then doctor. This copies the installed package's complete skills without setup, network access, daemon restart, or browser changes.
- Browser missing: resolve the selected user-installed browser or its configured executable path; do not silently switch browsers or download a replacement.
- Missing profile or requested preference changes: use the setup workflow with the user's selected choices. Never reset/delete profiles or import browser data as an installation repair.
- Runtime provisioning failure: `tokenless install --browser <selected-browser> --json` is the low-level provisioning command. It writes runtime preferences, enables/prepares G4F, refreshes skills, and reconciles the daemon; use it only for a requested repair requiring those effects. It does not upgrade the CLI or configure provider sign-in.
- Unknown or contradictory output: report the failed check and stop guessing. An unchanged-version upgrade synchronizes skills but does not reactivate the daemon; do not repeat it as a generic runtime repair.

Doctor is read-only and does not open/close browser windows or refresh provider observations. A stopped daemon can be healthy (`ok: true`, `running: false`); do not label that an installation failure or claim it is running. Provider observations may be stale, and doctor success alone does not prove a provider is currently signed in or usable.

## Browser handoff and verification

For the selected provider's sign-in or permission follow-up:

```bash
tokenless profiles open --profile <slug> --provider <id>
```

Tell the user what completed, the exact visible action needed, and what will be verified afterward. Pause for user-only sign-in, CAPTCHA, plan/permission UI, Keychain, or provider confirmation. After the user finishes, verify the same profile/provider:

```bash
tokenless profiles status --profile <slug> --provider <id> --json
tokenless doctor --json
```

Keep authentication in the selected browser. Installation work does not authorize inspecting, importing, exporting, printing, or transmitting cookies, browser storage, passwords, hidden headers, or other session secrets. Preserve browser profiles, resident browsers, and sandboxing. Summaries must omit authentication data and unrelated account content.
