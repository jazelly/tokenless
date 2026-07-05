# Tokenless Browser Session Bridge

Tokenless Browser Session Bridge is a visible browser-extension bridge for user-authorized web AI sessions. It lets Tokenless clients request actions in the user's own browser profile without exporting cookies, tokens, or hidden provider API calls.

## Surfaces

- Browser extension: Manifest V3 extension under `extension/`.
- Private workspace package: protocol and provider helpers exported from `tokenless-browser-session-bridge`.
- Web client helper: `tokenless-browser-session-bridge/web-client` sends requests to an installed extension id from Tokenless-owned web origins.
- Build output: `npm run build -w tokenless-browser-session-bridge` writes an unpacked extension to `dist/extension`.

## Provider Scope

The first package version defines adapters for ChatGPT, Gemini, and Claude web sessions. Each adapter submits text through visible page UI and reads visible answer text through DOM selectors. It stops when the tab is not available, the page is not one of the approved origins, selectors drift, login/CAPTCHA blocks the page, or the requested action is unsupported.

## Safety Contract

- No cookie export.
- No localStorage/sessionStorage token extraction.
- No private provider backend calls.
- Domain-scoped host permissions only.
- User-visible tab focus for write actions.
- Request/response messages use the versioned bridge protocol.

## Local Development

```bash
npm run lint -w tokenless-browser-session-bridge
npm run build -w tokenless-browser-session-bridge
npm test
```

Load `packages/extension/dist/extension` as an unpacked extension in Chrome or Edge developer mode.

```js
import { createExternalExtensionClient } from "tokenless-browser-session-bridge/web-client";

const bridge = createExternalExtensionClient({ extensionId: "installed-extension-id" });
const response = await bridge.request({
  provider: "chatgpt",
  action: "submit_and_read",
  prompt: "Review this plan.",
});
```

The current extension build targets Chromium-family browsers: Chrome, Edge, and Arc. Firefox and Safari need target-specific manifests and Safari's containing app wrapper before release.
