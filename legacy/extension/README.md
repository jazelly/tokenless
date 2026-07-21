# Legacy browser extension

Archived Manifest V3 extension and protocol helpers for the former Native Messaging path.

This package is not part of the active Tokenless workspace, default build, or user-facing product. The active path is managed Playwright automation through the local daemon.

Build locally only when experimenting with the archive:

```bash
npm install --prefix legacy/extension
npm run build --prefix legacy/extension
```

Load `legacy/extension/dist/extension` as an unpacked Chromium extension only for legacy experiments.
