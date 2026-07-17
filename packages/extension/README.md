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

## Visible Provider Enrichment

Generic control actions inventory the exact visible model labels and selected /
available state. Selection uses complete label equality after case and
whitespace normalization.

It tries declared fallbacks in order, verifies the new visible state, and blocks
before submission when no requested label is available.

| Provider | Visible models | `--attach-file` input | Project-isolated `--target-url` | Current boundary |
| --- | --- | --- | --- | --- |
| ChatGPT | Enabled | Exact captured input | Existing `/g/g-p-…/project` URL | Visible account UI and limits remain authoritative |
| Claude | Disabled until authenticated model-menu capture | Exact captured input | Existing `/project/<id>` URL | Model selector and native Project picker |
| Gemini | Enabled for exact available menu items | Disabled until authenticated file-input capture | Not implemented | Uploads, Gems, and saved isolation |
| Grok | Enabled | Exact captured input | Not implemented | Authenticated active-generation busy state and Projects |

Project targeting does not discover, create, or select a Project. For ChatGPT
and Claude, the caller supplies an exact existing Project URL.

Post-submit navigation must remain in that same Project id. Ordinary-chat or
cross-Project routes fail closed.

Visible attachments are delivered only for submit actions. The extension
receives path-free name, MIME type, size, and SHA-256 descriptors, streams bytes
from the claimed native-host job, and verifies ordered chunks and the digest.

It sets exactly one captured provider file input. Submission waits for a new
visible filename beside the composer.

Gemini upload stays disabled because its authenticated file input has not been
captured. Grok model and file controls are captured, but authenticated response
completion remains gated until a real busy-state DOM contract is observed.

## Safety Contract

- No cookie export.
- No localStorage/sessionStorage token extraction.
- No private provider backend calls.
- Domain-scoped host permissions only.
- User-visible tab focus for write actions.
- Native and provider request/response messages use versioned protocols.
- No external web origin can drive a provider session.
- The extension uses Chrome's `debugger` permission only for trusted clicks on visible ChatGPT model and Intelligence controls. The background worker validates the sending ChatGPT tab, canonical URL, and viewport coordinates, sends only two `Input.dispatchMouseEvent` commands, and immediately detaches. It never enables Network, Storage, Fetch, Runtime, DOM, or Page CDP domains.
- Attachment descriptors contain no local source path, and file bytes are bound
  to the claimed daemon job before they enter the visible provider input.
- Attachment transfer fails closed on path, identity, size, offset, hash, exact
  input, accepted-type, or visible-filename verification failure.

## Visible-provider runtime envelope

Extension-owned pages may call the capability-gated v1 action route directly:

```js
import {
  VISIBLE_PROVIDER_ACTIONS,
  createVisibleProviderActionRequest,
  createVisibleProviderRuntimeEnvelope,
} from 'tokenless-browser-session-bridge/protocol'

const response = await chrome.runtime.sendMessage(
  createVisibleProviderRuntimeEnvelope(createVisibleProviderActionRequest({
    provider: 'gemini',
    action: VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT,
    payload: {},
  }))
)
```

The service worker accepts this envelope only from an extension-owned page;
provider content scripts and foreign extension origins are rejected. It checks
the advertised provider capability before opening a tab, obtains auth state
only through the visible content action, blocks auth-required actions when that
state is not positively authenticated, and returns the action-specific
privacy-safe response schema.

This direct route does not replace the daemon attachment transport. File and
skill upload actions remain unavailable through it until they can be bound to
an active native-host claim; existing daemon submit attachments continue to use
the correlated native byte stream.

## Local Development

```bash
npm run lint -w tokenless-browser-session-bridge
npm run build -w tokenless-browser-session-bridge
npm test
```

Load `packages/extension/dist/extension` as an unpacked extension in Chrome, Brave, Edge, Chromium, or Arc developer mode.

Click the extension action to open Settings. Daemon jobs run in the background and open or reuse only the visible provider page required for the job.

The current extension build targets Chromium-family browsers: Chrome, Brave, Edge, Chromium, and Arc. Firefox and Safari need target-specific manifests and Safari's containing app wrapper before release.
