# Tokenless Harness Browser Extension

Experimental Manifest V3 candidate for user-owned real-page acceptance. It attaches one explicitly selected Chrome tab to the local Tokenless Harness API.

## Build

```bash
npm run build --workspace packages/harness-browser-extension
```

Load `dist/unpacked` with **Chrome → Extensions → Developer mode → Load unpacked**. Do not package or publish this candidate.

## Use

1. Start the configured Tokenless API daemon at `http://127.0.0.1:7331`.
2. Open the extension side panel, open **Settings**, and choose **Pair in Dashboard** under Connection.
3. In the local Dashboard, verify the extension ID and approve one provider/profile route.
4. Open a normal `http` or `https` page and keep its tab selected.
5. Enter a task in the side panel. The first send prepares the current page and asks for page access only when it is needed.
6. Review the page origin and each exact proposed action, then approve or reject every action before it runs.
7. For an upload proposal, choose exactly one local file in the side panel before approval.

The V2 candidate exposes `browser_page_observe`, `browser_page_input`, `browser_page_click`, `browser_page_submit`, `browser_page_radio`, `browser_page_upload`, and `browser_page_navigate`. It does not run arbitrary JavaScript or accept selectors.

Full local evidence is written under the selected Tokenless API home's `harness-browser-extension-evidence/` directory with owner-only permissions. It includes raw DOM, entered values, screenshots, the scoped extension credential, route identity, action decisions, and results.

## Repair and removal

- If the tab, document, or daemon changes, use **Refresh page context** in the side panel and start a new run.
- Connection, language, and privacy details live under **Settings**; the side panel stays focused on the task.
- **Unpair** revokes the extension-scoped credential. Removing the extension from Chrome removes its local credential copy.
- A daemon restart discards the in-memory extension session and Harness run; the candidate does not replay page mutations.

See the [full guide](../../docs/harness-browser-extension.md).
