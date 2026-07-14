# Tokenless

Tokenless is a visible browser extension for user-authorized web AI sessions. It executes jobs pushed by the local Tokenless daemon in the user's own browser profile without exporting cookies, tokens, or hidden provider API calls.

## Surfaces

- Browser extension: Manifest V3 extension under `extension/`.
- Private workspace package: protocol and provider helpers exported from `tokenless-browser-session-bridge`.
- Background coordinator: a versioned Native Messaging connection receives daemon jobs and drives approved provider pages.
- Settings page: provider preferences, local daemon configuration, and redacted daemon job history opened from the extension action.
- Build output: `npm run build -w tokenless-browser-session-bridge` writes the unpacked extension to `dist/extension`.

## Provider Scope

The extension defines adapters for ChatGPT, Claude, Gemini, and Grok web sessions. Each adapter submits text through visible page UI and reads visible answer text through DOM selectors. It stops when the tab is not available, the page is not one of the approved origins, selectors drift, login/CAPTCHA blocks the page, or the requested action is unsupported.

## Safety Contract

- No cookie export.
- No localStorage/sessionStorage token extraction.
- No private provider backend calls.
- Domain-scoped host permissions only.
- User-visible tab focus for write actions.
- Native and provider request/response messages use versioned protocols.
- No external web origin can drive a provider session.
- The extension uses Chrome's `debugger` permission only for trusted clicks on visible ChatGPT model and Intelligence controls. The background worker validates the sending ChatGPT tab, canonical URL, and viewport coordinates, sends only two `Input.dispatchMouseEvent` commands, and immediately detaches. It never enables Network, Storage, Fetch, Runtime, DOM, or Page CDP domains.

## Local Development

```bash
npm run lint -w tokenless-browser-session-bridge
npm run build -w tokenless-browser-session-bridge
npm test
```

Load `packages/extension/dist/extension` as an unpacked extension in Chrome, Brave, Edge, Chromium, or Arc developer mode.

Click the extension action to open Settings. Daemon jobs run in the background and open or reuse only the visible provider page required for the job.

The current extension build targets Chromium-family browsers: Chrome, Brave, Edge, Chromium, and Arc. Firefox and Safari need target-specific manifests and Safari's containing app wrapper before release.
