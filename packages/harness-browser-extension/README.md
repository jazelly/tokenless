# Tokenless Harness Browser Extension

Experimental Manifest V3 candidate for user-owned real-page acceptance. It attaches one explicitly selected Chrome tab to the local Tokenless Harness API.

## Build

```bash
npm run build --workspace packages/harness-browser-extension
```

Load `dist/unpacked` with **Chrome → Extensions → Developer mode → Load unpacked**. Do not package or publish this candidate.

## Use

1. Start the configured Tokenless API daemon at `http://127.0.0.1:7331`.
2. Open the extension side panel and choose **Pair in Dashboard**.
3. In the local Dashboard, verify the extension ID and approve one provider/profile route.
4. Open a normal `http` or `https` page, choose **Attach**, and review the origin and bounded control inventory.
5. Consent, enter a task, and approve the exact proposed text before any mutation.

V1 exposes only `browser_page_observe` and `browser_page_input`. It does not click, submit, upload, navigate, run arbitrary JavaScript, or accept selectors.

## Repair and removal

- If the tab, document, or daemon changes, attach the current page again and start a new run.
- **Unpair** revokes the extension-scoped credential. Removing the extension from Chrome removes its local credential copy.
- A daemon restart discards the in-memory extension session and Harness run; V1 does not replay page content or mutations.

See the [full guide](../../docs/harness-browser-extension.md).
