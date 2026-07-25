# Provider DOM Fixtures

This directory stores redacted, reduced DOM evidence captured from visible, authenticated provider pages. It covers ChatGPT, Claude, Gemini, and Grok without retaining cookies, browser storage, tokens, account email addresses, chat content, or private route identifiers.

The hierarchy is:

```text
provider-dom/
  <provider>/
    <account-state>/
      <scenario>.html
      <scenario>.provenance.json
```

Every provenance file records the sanitized page URL, route class, capture date, account-state classification, observed plan confidence, evidence selectors, redactions, and the SHA-256 digest of its paired HTML file. Generated workflow fixtures also record their operation phase and capability outcome. The v2 `manifest.json` inventories those fields with every fixture and provenance path so multiple routes and overlays can coexist under one provider account state.

An available menu, input, or creation form proves only that captured phase. It must not be treated as a successful upload or workspace mutation without a separate visible success fixture.

The committed fixtures intentionally contain only the minimum visible DOM needed for regression tests. Raw page HTML is not committed because it is privacy-sensitive, highly volatile, and may include executable provider code. Use `test/helpers/capture-provider-dom-cdp.mjs` to collect a fresh sanitized candidate, inspect it manually, then reduce and promote only the relevant visible evidence.

The deep workflow corpus currently covers:

| Provider | Additional authenticated workflows |
| --- | --- |
| ChatGPT | Existing conversation, upload/tools menu, library, connector directory, scheduled jobs, settings, generated-image result |
| Claude | Existing conversation, upload/connectors menu, settings, connector settings, projects, artifacts |
| Gemini | Existing conversation, chat search, upload/tools menu, connected upload sources, settings menu, image workspace, media library |
| Grok | Attachment menu, skills, connectors, Imagine, automation list and creation, account settings, empty history, project creation |

Run `node test/helpers/build-provider-workflow-fixtures.mjs` after changing the deep workflow descriptor. It rewrites those reduced HTML fixtures and their provenance sidecars, recalculates content digests, and regenerates the complete v2 manifest without replacing the older baseline fixture variants.

Grok has two retained model-menu variants:

- `signed-in-unknown/model-menu-open` preserves an older DOM variant whose reduced artifact did not expose a reliable disabled-state signal.
- `signed-in-free/model-menu-open` records the current Free-account contract: `Auto`, `Expert`, and `Heavy` use Grok's visible `text-secondary opacity-75` unavailable styling while `Fast` remains available.
