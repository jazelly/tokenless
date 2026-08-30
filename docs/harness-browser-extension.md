# Tokenless Harness Browser Extension

Status: experimental V2 candidate; user-owned real-page/provider acceptance and provider-session evidence capture are still required.

The Chrome extension is a Tokenless Harness client and browser-tool adapter. Tokenless API remains the provider-facing layer; Tokenless Harness remains the Agent runtime; Tokenless Harness API is the local run/control/tool-exchange boundary.

## Supported candidate boundary

| Supported | Not supported |
|---|---|
| One explicitly selected top-level `http` or `https` tab | Protected Chrome pages, cross-origin frames, closed shadow DOM, or canvas-only controls |
| Visible textual inputs, `textarea`, and verifiable `contenteditable` surfaces | Password, OTP, payment, authentication-secret, hidden, disabled, or read-only controls |
| Non-sensitive buttons, form submit controls, native radio controls, and file inputs | CAPTCHA, MFA, purchase, delete, download, popup, or multi-tab automation |
| One approved absolute `http` or `https` navigation | Implicit navigation, background continuation, or protected browser URLs |
| Opaque `elementRef` from the latest bounded observation | JavaScript, CSS selector, XPath, or CDP escape hatches |

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
6. Review the exact action, target, text, or destination. For upload, choose one local file. Approve or reject each action separately.
7. Confirm the intended visible result and the side panel's final output.

The candidate is not accepted until the user visually confirms the correct field changed on a user-selected real page and unrelated fields and tabs did not change.

## Data flow and lifetime

- The content script sends semantic metadata for at most 128 supported controls to the Harness Task Model. Raw page HTML is stored only in the private local evidence bundle.
- Each run uses the observation frozen at attachment time. A changed or stale page fails closed and requires a new attachment and run.
- Existing text values, password-like fields, cookies, storage, authorization data, and unrelated tabs remain excluded from model context.
- The user-approved private evidence bundle stores raw DOM, task and entered values, before/after screenshots, the scoped extension credential, route identity, decisions, and results under the Tokenless API home with owner-only permissions.
- Capturing the selected provider's raw session values into that same private bundle remains a required acceptance item; the candidate is not verified until that evidence exists.
- Daemon restart discards the run and daemon-memory payload overlay. Detaching removes the extension session's access to that run; mutations are not replayed.

## Repair, revoke, and uninstall

- After any tab/document/origin change, select the page and attach it again.
- Use **Unpair** to revoke the credential before removing the extension.
- Remove the unpacked extension from `chrome://extensions` when testing is complete.

Do not publish or distribute this candidate before the active roadmap's real-page acceptance gate passes.
