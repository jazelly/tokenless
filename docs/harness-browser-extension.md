# Tokenless Harness Browser Extension

Status: experimental candidate; user-owned real-page acceptance is still required.

The Chrome extension is a Tokenless Harness client and browser-tool adapter. Tokenless API remains the provider-facing layer; Tokenless Harness remains the Agent runtime; Tokenless Harness API is the local run/control/tool-exchange boundary.

## Supported V1 boundary

| Supported | Not supported |
|---|---|
| One explicitly selected top-level `http` or `https` tab | Protected Chrome pages, cross-origin frames, closed shadow DOM, or canvas-only controls |
| Visible, enabled `text`, `search`, `email`, `tel`, `url`, and `number` inputs | Password, OTP, payment, authentication-secret, file, hidden, disabled, or read-only controls |
| `textarea` and verifiable visible `contenteditable` surfaces | Click, submit, select, upload, download, popup, or navigation |
| Opaque `elementRef` from the latest bounded observation | JavaScript, CSS selector, XPath, URL, or CDP escape hatches |

## Install the candidate

```bash
npm run build --workspace packages/harness-browser-extension
```

1. Start the normally configured Tokenless API daemon on `http://127.0.0.1:7331`.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select `packages/harness-browser-extension/dist/unpacked`.
4. Open the extension side panel and choose **Pair in Dashboard**.
5. Verify the exact extension ID in the local Dashboard, then select and approve one enabled provider/profile route.

The issued credential is scoped to that extension identity and its own Harness sessions. It cannot call daemon control, change configuration, or access another caller's run.

## Run on a page

1. Open the real page you want to use and keep its tab selected.
2. Choose **Attach or repair selected tab**.
3. Check the exact origin and semantic control inventory.
4. Read the provider disclosure, then explicitly consent before any bounded page content leaves the extension.
5. Enter a natural-language task and start the Harness run.
6. Review the exact target label and proposed text. Approve or reject it.
7. Confirm the intended visible field changed and the side panel reached a final result.

The candidate is not accepted until the user visually confirms the correct field changed on a user-selected real page and unrelated fields and tabs did not change.

## Data flow and lifetime

- The content script returns semantic metadata for at most 64 supported controls; it never sends raw page HTML.
- Each run uses the observation frozen at attachment time. A changed or stale page fails closed and requires a new attachment and run.
- Existing text values, password-like fields, cookies, storage, authorization data, and unrelated tabs are excluded.
- Task text, the semantic snapshot, proposed input text, provider response, and the unredacted final response remain in an ephemeral daemon-memory overlay; persisted provider jobs contain only redacted placeholders and correlation metadata.
- Durable pairing state stores only a credential hash and route identity. Extension storage keeps the scoped credential needed to reconnect to the running daemon.
- Daemon restart discards the run and daemon-memory payload overlay. Detaching removes the extension session's access to that run. Start a new run; V1 does not recover or replay mutations.

## Repair, revoke, and uninstall

- After any tab/document/origin change, select the page and attach it again.
- Use **Unpair** to revoke the credential before removing the extension.
- Remove the unpacked extension from `chrome://extensions` when testing is complete.

Do not publish or distribute this candidate before the active roadmap's real-page acceptance gate passes.
