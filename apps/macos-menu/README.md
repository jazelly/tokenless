# Tokenless macOS menu bar app

The local macOS menu bar app provides a native SwiftUI surface for the Tokenless daemon:

- status and daemon version;
- dashboard and the ten most recent conversations;
- restart, quit, update checks, and Start Tokenless at Login;
- English and Simplified Chinese labels selected from the persisted Tokenless language.

## Local build and install

On an Apple Silicon Mac with the repository dependencies installed, run:

```bash
npm run build:macos-menu
npm run install:macos-menu
```

`build:macos-menu` first builds the CLI and then creates `dist/macos/Tokenless.app` and `dist/macos/Tokenless.zip`. It targets macOS 13 or newer and contains its own arm64 Node runtime, CLI, daemon, and production Node dependencies. It does not use the installing machine's Node, nvm, Homebrew, or a global `tokenless` command.

The installer replaces `~/Applications/Tokenless.app` and launches it. The menu app invokes the embedded runtime with the user's default `~/.tokenless` home; it does not create or require a `menubar-binding.json` file. Existing binding files are ignored.

The bundle identifier is the local-only `local.tokenless.api.menubar`. The app is an agent application (`LSUIElement=true`), so it appears in the menu bar without a Dock icon.

When the app launches, it immediately runs the embedded `tokenless menubar status --json` command to ensure the daemon is ready. Therefore enabling Start Tokenless at Login starts the complete local Tokenless control surface, including the Dashboard served by the daemon; provider browsers remain on-demand.

The base app intentionally excludes the G4F Python virtual environment and browser binaries. Those optional runtimes remain separate, on-demand installation concerns and are not started at login unless their corresponding provider/runtime is explicitly configured.

The menu's update check is informational. Install the latest macOS app package to upgrade the embedded runtime; the app does not run a global npm upgrade.
