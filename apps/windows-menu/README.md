# Tokenless API Windows tray

A native notification-area app for Windows 10 and Windows 11. Left-click opens the Dashboard in your default browser; right-click opens the menu. There is no separate app window or embedded browser.

- Live daemon status and version, active task and browser-profile counts, plus the ten most recent conversations.
- Open Dashboard, refresh status, restart, and check for CLI updates.
- Optional start at sign-in; disabled until you enable it in the menu.
- Native notifications confirm restart, update-check, and start-at-sign-in results without opening another window.
- Exit the tray alone, or stop Tokenless API and exit. Stopping or restarting with active tasks asks for confirmation.
- English and Simplified Chinese follow the Windows preferred UI language; `language` in `~/.tokenless/config.json` is used only when Windows does not expose one.
- The mark is rendered in a dark-ink and light-ink variant. It follows the Windows shell theme so it stays visible on light and dark taskbars.

## Build and launch

From a checkout with Node.js 22.13+ and repository dependencies installed:

```powershell
npm run install:windows-menu
```

This builds the CLI and native app, adds a **Tokenless API** Start menu shortcut, and launches the tray. It uses the Windows .NET Framework compiler; no Electron or additional .NET SDK is required. Windows controls whether the icon appears directly on the taskbar or under the hidden-icons arrow.

`npm run build:windows-menu` builds the CLI and `dist/windows/TokenlessApiTray.exe` without launching the tray. It stops the idle daemon to release old CLI files; active jobs prevent the build. The existing tray exits during replacement. Starting the app twice keeps one instance per Windows session.

### Verify Windows behavior

After building, run `npm run verify:windows-menu` in an unlocked Windows session. It checks status and Dashboard preparation from a hidden GUI host, fails if a new Console Host or Windows Terminal window appears, and exercises tray startup, single-instance behavior, and graceful exit. Avoid opening other terminals during the check. The check reads the default API home; use `-- --home <path>` to select another configured home. It does not open a provider browser or change profiles.

## Runtime and removal

This is a **source-linked development app**, not a standalone release bundle. `dist/windows/runtime.json` records the build machine's absolute Node and built CLI paths. Keep this checkout and Node installation in place; rerun installation after moving either. Production behavior remains in the existing Tokenless API `config.json`; the runtime binding does not override it.

The app uses the default `~/.tokenless` home and starts the local daemon through `menubar status --json`. It opens Dashboard and conversations through the existing CLI; it never reads browser credentials. Provider browsers remain under the existing daemon's control. Commands run without console windows.

Update checks use `upgrade --check`; source changes and tray upgrades require updating and rebuilding the checkout. This app does not replace the source checkout or install npm releases over it. Windows release packaging and automatic app replacement are not included.

To remove it, disable **Start at sign-in**, choose **Exit tray only**, and delete the **Tokenless API** Start menu shortcut. The optional startup entry is the current user's `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Tokenless API`; no administrator access is needed. Your config, profiles, and browser data are retained.
