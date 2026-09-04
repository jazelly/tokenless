# Updating Tokenless API

`tokenless upgrade` is the update entry point for the CLI and the macOS menu app. Install prepares a machine; setup changes user choices; upgrade replaces software while preserving those choices.

## Check and update

```bash
tokenless upgrade --check --json
tokenless upgrade
# Explicit consent for non-interactive callers:
tokenless upgrade --yes --json
```

Checking is read-only: it does not install dependencies, start a daemon, or migrate a database. Updating requires confirmation because the daemon restarts and active tasks may be interrupted; coordinate task timing in Tokenless Harness.

| Installation | Update target |
| --- | --- |
| Global npm package | The verified global `tokenless` installation, using the exact checked npm version |
| macOS app | The entire installed app, including its embedded Node, CLI, and daemon |
| Source checkout / linked development CLI | Update and rebuild the checkout; the updater refuses to overwrite an unrelated global installation |

The macOS menu uses the same checks and update implementation. An npm version alone is not a macOS update: the matching macOS release archive and checksum must be available.

An older macOS app that only shows a manual-install message must be replaced once with a release containing this updater. Installing new repository code does not change an already installed app.

## What changes

1. Acquire and verify the selected package before replacing the installed software.
2. Stop only the verified Tokenless API daemon for the selected home and, for a macOS update, the selected menu app.
3. Replace the package, then invoke the newly installed runtime.
4. Prepare runtime dependencies only when already enabled, apply [database migrations](database-migrations.md), and start the new daemon.
5. Verify the running version, schema version, and an authenticated local API request before reporting success.

Upgrade does not rerun setup, enable providers, change browser bindings, reset configuration, replace browser profiles, or reinstall global agent skills. Configured native browsers remain user-owned.

Failures stop with an error. There is no automatic retry, task replay, or database downgrade. Once a database has been migrated, restoring an old executable is not a complete rollback; do not run older releases against a newer schema.

## Local packages

An explicitly selected local package supports offline installation and release verification without publishing a test release:

```bash
tokenless upgrade --package /absolute/path/tokenless-version.tgz --yes --json
```

For an embedded macOS CLI, use the corresponding local release ZIP. Only use packages you trust. The selected archive may reinstall the same version; downgrades are rejected.

## Publishing and verification

The release workflow publishes the versioned macOS archive and SHA-256 checksum alongside the GitHub release. The initial macOS target is Apple Silicon / macOS 13+; signing remains ad-hoc, not Developer ID signed or notarized. The updater does not bypass Gatekeeper or system approval.

Before release, verify an actual installed npm package and an isolated macOS bundle update, preserving configuration and existing database rows. A successful build, download, or `open -a` alone is not update-completion evidence.

```bash
npm run build --workspace packages/cli
node --test test/npm-update.integration.test.mjs test/update-activation.integration.test.mjs
# On an Apple Silicon Mac:
node scripts/build-macos-menu.mjs
node --test test/macos-update.integration.mjs
```

These checks install only into temporary directories. The native check launches and replaces an isolated menu app, not the user's installed app.
