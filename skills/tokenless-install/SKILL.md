---
name: tokenless-install
description: Install, set up, upgrade, synchronize skills, and repair Tokenless API CLI or its optional macOS app. Use for requested maintenance, installation health checks, or browser sign-in handoff.
---

# Tokenless API installation and maintenance

Install prepares software; setup changes user choices; upgrade replaces software while preserving those choices. Match the requested scope and report in the user's language; a check-only request stays read-only.

## Select the installation channel

Identify the OS, architecture, and executable location before choosing commands.

| Installation | Route |
| --- | --- |
| Windows x64 (prerelease) | npm CLI in PowerShell or a terminal; no macOS menu app. |
| Apple Silicon macOS, npm CLI | npm CLI; the menu app is a separate optional install. |
| Apple Silicon macOS 13+, standalone app | Bundled Node, CLI, and daemon; use the app's own update action or embedded CLI. Global npm does not update this app. |
| Source-linked CLI | Refresh the selected checkout and preserve its development link; do not replace it with a published npm package. |

The standalone app needs no global Node/npm, but excludes browsers and the G4F Python environment. For a requested app install, use the matching release ZIP and SHA-256 checksum; a requested source build uses `npm run install:macos-menu`. Verify the menu and daemon afterward. Do not infer support for other platforms from browser artifacts alone.

## Choose the workflow

| Request | Commands |
| --- | --- |
| Fresh npm CLI | Check Node.js 22.13+ and npm, then `npm install --global tokenless@latest` and `tokenless --version`; continue to setup, or run skill sync for a software-only install. |
| Interactive setup | `tokenless setup` |
| Setup with known browser/profile choices | `tokenless setup --browser <chrome|brave|cloak> --profile <slug> --defaults --json` |
| Check for updates | `tokenless upgrade --check --json` |
| Authorized upgrade | `tokenless upgrade --yes --json` through the selected installation channel. |
| Sync skills only | `tokenless skills sync --json` |
| Diagnose installation | `tokenless doctor --json` |

Use the installed `tokenless` command, never `npx tokenless`. Install missing prerequisites within the authorized installation scope or report what is missing.

## Setup and browser handoff

Check `uv --version` before setup: setup enables G4F and prepares its pinned Python runtime. It also synchronizes skills, saves browser/profile choices, reconciles the daemon, and checks enabled providers; it can open provider review tabs. Use it for onboarding or configuration changes, not routine software maintenance.

- Native Chrome/Brave is user-installed and headed-only; setup does not download either browser or copy its profile. Enable remote debugging at `chrome://inspect/#remote-debugging` or `brave://inspect/#remote-debugging` and let the user approve the connection. Supply `--browser-executable-path <absolute-path>` when discovery needs help.
- CloakBrowser downloads only for selected Anti-Detect setup (`--browser cloak` or `--anti-detect`). Optional Codex hooks require `--install-codex`; `--codex-home <dir>` requires that flag. The user trusts hooks in Codex `/hooks`.
- Reuse the selected logical profile. `--provider-whitelist <list>` controls enabled providers; `--no-open` suppresses the dashboard, not provider checks. The old `--fresh` and profile-import workflow no longer apply.

For a selected provider's sign-in follow-up, run `tokenless profiles open --profile <slug> --provider <id>`. State what completed and the visible action needed; let the user handle sign-in, CAPTCHA, permission, and Keychain prompts. Afterward run `tokenless profiles status --profile <slug> --provider <id> --json` and doctor for the same selection. Keep session secrets in the browser and out of diagnostics or reports.

## Upgrade and source refresh

An upgrade may restart the daemon and interrupt active tasks. `--yes` supplies non-interactive confirmation; `--json` alone does not. Do not ask again when the user already authorized the update.

Upgrade preserves configuration, profiles, and provider choices, synchronizes matching skills, and verifies the activated runtime. It does not run setup or doctor. `up_to_date` still synchronizes skills but does not restart the daemon. For an explicitly supplied local package, add `--package <absolute-path>`: `.tgz` for npm, release ZIP for the embedded app.

For source refresh, follow the checkout's instructions, preserve uncommitted work, and compare the selected branch with upstream before claiming it is current. Refresh dependencies when needed. Rebuild with `npm run build` when runtime code or bundled skills changed, then run `npm run sync:skill`; the sync script requires a built CLI. Verify the linked executable resolves to that checkout. Refresh the menu app or activate the daemon only when included in the request, and verify each separately.

## Skill synchronization

Both skills (`tokenless` and `tokenless-install`) ship with the npm package and macOS app. Install/setup/upgrade use one local synchronizer to replace their complete directories under `~/.agents/skills` and existing supported agent roots, respecting configured roots. Other skills and agent instructions remain intact.

Skill-only sync restores the installed package's version without network access, setup, or daemon startup. Source sync uses the checkout's `skills/`; pulling Git alone does not refresh global copies. Reload agent sessions that already loaded old instructions. Other package users receive changes through release automation, not local sync.

## Verify and repair

Run doctor after installation/setup and when health verification is requested. Doctor checks complete skill contents against the package; it is read-only and does not refresh provider observations.

- Require `ok: true` and inspect the returned status/proof before reporting success. Report software installation separately from onboarding: `action_required` or pending sign-in means onboarding is incomplete. A healthy stopped daemon is not running, and cached provider observations do not prove current usability.
- For failures, report the failed check or phase and its error code, then repair that boundary. Use skill sync for stale skills, the configured executable path for a missing browser, and setup for missing profiles or requested choice changes.
- For a runtime provisioning repair, `tokenless install --browser <selected-browser> --json` saves runtime preferences, enables/prepares G4F, syncs skills, and reconciles the daemon; it does not update the CLI or sign in. Use it only when those effects are needed.
- Preserve user state. Do not reset profiles, delete databases, or rewrite schemas to pass a health check. A failed upgrade may have partially applied; do not claim rollback or downgrade against a migrated database. Resolve the reported failure before retrying.

For additional flags and update result details, consult the [command reference](https://github.com/jazelly/tokenless/blob/main/COMMANDS.md) and [update guide](https://github.com/jazelly/tokenless/blob/main/docs/updates.md).
