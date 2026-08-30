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
5. Consent to the provider disclosure and private local evidence capture, enter a task, and approve each exact proposed action before it runs.
6. For an upload proposal, choose exactly one local file in the side panel before approval.

The V2 candidate exposes `browser_page_observe`, `browser_page_input`, `browser_page_click`, `browser_page_submit`, `browser_page_radio`, `browser_page_upload`, and `browser_page_navigate`. It does not run arbitrary JavaScript or accept selectors.

Full local evidence is written under the selected Tokenless API home's `harness-browser-extension-evidence/` directory with owner-only permissions. It includes raw DOM, entered values, screenshots, the scoped extension credential, route identity, action decisions, and results.

## Repair and removal

- If the tab, document, or daemon changes, attach the current page again and start a new run.
- **Unpair** revokes the extension-scoped credential. Removing the extension from Chrome removes its local credential copy.
- A daemon restart discards the in-memory extension session and Harness run; the candidate does not replay page mutations.

See the [full guide](../../docs/harness-browser-extension.md).
