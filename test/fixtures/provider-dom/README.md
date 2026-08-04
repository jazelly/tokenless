# Provider DOM Fixtures

This directory stores redacted, reduced DOM evidence captured from visible provider pages. It covers authenticated ChatGPT, Claude, Gemini, Grok, and DeepSeek sessions plus the public Qwen guest surface without retaining cookies, browser storage, tokens, account email addresses, chat content, or private route identifiers.

The hierarchy is:

```text
provider-dom/
  <provider>/
    <account-state>/
      <scenario>.html
      <scenario>.provenance.json
```

Every provenance file records the sanitized page URL, route class, capture date, account-state classification, observed plan confidence, evidence selectors, redactions, and the SHA-256 digest of its paired HTML file. Generated workflow fixtures also record their operation phase and capability outcome. The v2 `manifest.json` inventories those fields with every fixture and provenance path so multiple routes and overlays can coexist under one provider account state.

Provider development must capture each materially distinct capability-relevant state from a real visible session before relying on its selectors. Reduce and redact the capture once, then use the checked-in fixture for focused selector, parser, and sanitizer work instead of repeatedly revisiting the provider. Login, CAPTCHA, mode, menu, upload-selection, streaming, completed-response, and terminal-error states are separate evidence when they change behavior. If a state cannot be captured without signing the user out, changing accounts, or crossing another user-controlled boundary, record the evidence gap; never invent or splice DOM and never disturb the authenticated profile just to complete the corpus.

An available menu, input, or creation form proves only that captured phase. It must not be treated as a successful upload or workspace mutation without a separate visible success fixture.

The committed fixtures intentionally contain only the minimum visible DOM needed for regression tests. Raw page HTML is not committed because it is privacy-sensitive, highly volatile, and may include executable provider code. Use `test/helpers/capture-provider-dom-cdp.mjs` to collect a fresh sanitized candidate, inspect it manually, then reduce and promote only the relevant visible evidence.

The deep workflow corpus currently covers:

| Provider | Additional authenticated workflows |
| --- | --- |
| ChatGPT | Existing conversation, upload/tools menu, library, connector directory, scheduled jobs, settings, generated-image result |
| Claude | Existing conversation, upload/connectors menu, settings, connector settings, projects, artifacts |
| Gemini | Existing conversation, chat search, upload/tools menu, connected upload sources, settings menu, image workspace, media library |
| Grok | Attachment menu, skills, connectors, Imagine, automation list and creation, account settings, empty history, project creation |
| DeepSeek | Instant, Expert, and Vision composer states with mode-dependent DeepThink, Search, and file controls |

Run `node test/helpers/build-provider-workflow-fixtures.mjs` after changing the deep workflow descriptor. It rewrites those reduced HTML fixtures and their provenance sidecars, recalculates content digests, and regenerates the complete v2 manifest without replacing the older baseline fixture variants.

Grok has two retained model-menu variants:

- `signed-in-unknown/model-menu-open` preserves an older DOM variant whose reduced artifact did not expose a reliable disabled-state signal.
- `signed-in-free/model-menu-open` records the current Free-account contract: `Auto`, `Expert`, and `Heavy` use Grok's visible `text-secondary opacity-75` unavailable styling while `Fast` remains available.

Qwen retains two guest-session fixtures captured on 2026-07-26:

- `signed-out-guest/composer-idle` proves the public composer, sign-in invitation, and submit control.
- `signed-out-guest/response-complete` proves a visibly complete response, same-origin conversation continuation, and the absence of the observed streaming-state class.

DeepSeek retains signed-in, plan-unknown fixtures captured on 2026-08-01. The composer variants prove only visible control topology: Instant exposes DeepThink, Search, and a file input; Expert exposes DeepThink without Search or a file input; Vision exposes DeepThink and a file input without Search. Separate completed-response variants preserve the stable final-answer selector, the distinct DeepThink reasoning container, and Search responses with visible public source links.

The DeepSeek signed-out login and visible hCaptcha states were observed but were not captured before the temporary managed session was closed. They remain an explicit fixture gap. Runtime challenge detection recognizes visible hCaptcha frames as `visible_hcaptcha`; a future fixture must come from a real user-visible signed-out session and must not be obtained by logging the authenticated Chrome profile out.
