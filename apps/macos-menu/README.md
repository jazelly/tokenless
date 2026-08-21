# Tokenless API macOS menu bar app

The local macOS menu bar app provides a native SwiftUI surface for the Tokenless API daemon:

- status and daemon version;
- dashboard and the ten most recent conversations;
- restart, quit, update checks, upgrades, and Launch at Login;
- English and Simplified Chinese labels selected from the persisted Tokenless language.

## Local build and install

On this Apple Silicon Mac, run:

```bash
npm run build:macos-menu
npm run install:macos-menu
```

The build creates `dist/macos/Tokenless API.app` and `dist/macos/Tokenless API.zip`. It targets macOS 13 or newer, uses the checked-in `assets/tokenless-mark.png`, and applies an ad-hoc signature for local use. Developer ID signing, notarization, and external distribution are intentionally deferred.

The installer replaces `~/Applications/Tokenless API.app`, resolves `which tokenless` in the invoking shell, and writes a mode-0600 binding at `~/Library/Application Support/Tokenless API/menubar-binding.json`. The binding records the absolute Node executable, the absolute `which tokenless` command path itself (without dereferencing its symlink), the CLI entrypoint, and Tokenless home so the GUI does not depend on shell PATH while following npm global upgrades.

The bundle identifier is the local-only `local.tokenless.api.menubar`. The app is an agent application (`LSUIElement=true`), so it appears in the menu bar without a Dock icon.
