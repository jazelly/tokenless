# Visible provider evidence

Tokenless visible-session adapters are based on provider UI that a user can see
and authorize in the browser. They do not use provider cookies, browser storage,
hidden authentication headers, or private provider APIs.

This document records the time-sensitive product facts and DOM evidence used by
the adapters. Product limits can change. Runtime code must treat the visible UI
as authoritative and fail closed when a required control cannot be verified.

## Claude

Evidence reviewed on 2026-07-15:

- [Claude pricing](https://claude.com/pricing) confirms a free web plan.
- [Getting started with Claude](https://support.claude.com/en/articles/8114491-get-started-with-claude)
  describes a dynamic session limit that resets every five hours. The number of
  messages varies with prompt and attachment size, conversation length, model,
  features, and current capacity; Tokenless therefore does not hard-code a
  message count.
- [Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5) identifies
  Sonnet 5 as the default free model. The
  [model and effort guide](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings)
  documents the visible model selector. Tokenless must inventory that menu at
  runtime instead of assuming that every free account has the same alternatives.
- [File uploads](https://support.claude.com/en/articles/8241126-upload-files-to-claude)
  documents up to 20 files per chat and a current 500 MB per-file limit, with a
  30 MB per-file limit for Project knowledge. Upload limits remain subject to
  the account and visible UI.
- [Projects](https://support.claude.com/en/articles/9517075-what-are-projects)
  confirms that free accounts can create up to five Projects. Each Project has
  its own chats, knowledge, and instructions.

### DOM provenance

The reduced fixture at `test/fixtures/claude-real-dom-fixture.html` preserves the
adapter-relevant structure observed in the public SSR app shell served by
`https://claude.ai/new` on 2026-07-15. It includes these provider-owned DOM
contracts:

- `div[data-testid="chat-input"][contenteditable="true"][role="textbox"]`
- `button[data-cds="Button"][aria-label="Send message"]`
- `input[data-testid="file-upload"][aria-label="Upload files"]`
- `a[href="/projects"][aria-label="Projects"]`
- `[data-testid="virtual-message-list"]`
- `.font-claude-response-body`

The fixture is intentionally reduced and redacted. Its inline behavior is a
deterministic test shim, not copied provider JavaScript. It reproduces only
user-visible state transitions needed by the extension test: composer input,
send enablement, a new conversation URL, streaming state, and a stable answer.
Authenticated free-account captures remain required before enabling model,
file-upload, or native Project selection automation.

### Current acceptance boundary

The Claude base adapter is accepted only when focused browser tests prove prompt
submission, `/new` to `/chat/<opaque-id>` navigation, streaming completion,
stable-answer selection, blocker detection, and selector drift failure. A
separate fixture E2E exercises the complete CLI, daemon, native host, extension
service worker, and content-script chain without opening an internal task or
runner page.

## Gemini

Evidence reviewed on 2026-07-15:

- [Gemini Apps availability and account requirements](https://support.google.com/gemini/answer/13278668?hl=en)
  confirms that some Gemini web-app features can be used without signing in.
  A persistent Sign in link therefore is not an authentication blocker while
  the anonymous composer remains usable.
- [Gemini Apps limits and upgrades](https://support.google.com/gemini/answer/16275805?hl=en)
  documents dynamic limits for accounts without a Google AI subscription. Its
  current table lists a 32K context window for standard access, quota windows of
  roughly five hours, and weekly caps for some advanced access. Limits depend on
  the model, prompt size, file size, conversation length, and capacity, and may
  change. Tokenless must read the visible account UI and never hard-code these
  numbers as runtime entitlement.
- [Uploading and analyzing files](https://support.google.com/gemini/answer/14903178?hl=en)
  currently documents up to 10 files in one prompt and a 100 MB limit for most
  supported files. Video files can be up to 2 GB; the current free-access limits
  list five minutes of video and 10 minutes of audio. The visible upload control
  remains authoritative for a particular account and model.
- The limits table lists Gems as available without a paid Google AI plan.
  [Using Gems](https://support.google.com/gemini/answer/15146780?hl=en) still
  requires signing in, and eligibility varies for personal, work, and school
  accounts. Anonymous composer availability therefore does not imply Gem,
  upload, or saved-chat eligibility.

### DOM provenance

Gemini evidence combines two distinct user-visible surfaces inspected on
2026-07-15. The unauthenticated `https://gemini.google.com/app` shell supplied
the composer and static controls:

- `rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Enter a prompt for Gemini"]`
- `button[aria-label="Send message"]`, which appears after the composer becomes
  non-empty
- `button[data-test-id="bard-mode-menu-button"][aria-label^="Open mode picker, currently "]`
- `button[aria-label="Upload & tools"][aria-haspopup="menu"]`
- `button[data-test-id="local-images-files-uploader-button"][role="menuitem"][aria-label="Upload files. Documents, data, code files"]`

A public, read-only `/share/<opaque-id>` conversation supplied the provider-owned
answer hierarchy, without copying its conversation text:

- `response-container message-content`
- `response-container structured-content-container.message-content`

No live prompt was submitted while collecting this evidence, so the transient
busy control was not present in the static shell capture. The adapter uses the
current user-facing `Stop response` label documented by Google as the exact
`button[aria-label="Stop response"]` busy-state contract, and the local fixture
reproduces that state transition. A new active-generation DOM capture is
required if that accessible control drifts.

The reduced and redacted fixture at
`test/fixtures/gemini-real-dom-fixture.html` merges only those structural
contracts. Its inline script is a deterministic test shim, not Gemini
JavaScript. The capture helper also probes the static `/gems/view` sidebar route
without relying on volatile element IDs, but authenticated sidebar evidence is
still required before that route becomes an automation contract.

### Current acceptance boundary

The Gemini base adapter covers anonymous prompt submission and stable response
selection through visible DOM only. Authenticated model selection, file upload,
Gems, and saved conversation isolation remain pending the enrichment phase.
They must not be enabled until a user-granted, authenticated capture verifies
the controls and focused extension tests reproduce their visible state changes.

## Grok

Evidence reviewed on 2026-07-15:

- [Grok pricing](https://x.ai/pricing) lists a Free plan at $0 per month with
  "generous limits," but does not publish a fixed message count. Tokenless must
  therefore treat the account's visible limit state as authoritative.
- [Welcome to Grok](https://docs.x.ai/grok/overview) says Grok is free to start
  and that paid SuperGrok plans raise limits. The
  [Grok website FAQ](https://docs.x.ai/grok/faq) further distinguishes paid
  weekly usage from separate free-tier Chat and Voice limits; those free limits
  reset on their own provider-controlled schedule.
- The same FAQ documents visible web uploads of up to approximately 100 files at
  once and up to 150 MB for most individual files. Supported formats and limits
  can vary by platform or subscription, so the live upload UI remains the
  runtime authority.
- The FAQ identifies `grok.com` as the supported web host and mentions Projects,
  but does not establish a personal Free-plan Project entitlement. The
  [Grok.com workspace guide](https://docs.x.ai/grok/user-guide) documents
  licensed Business personal/team workspaces and their isolation. Tokenless does
  not infer that a Free account has equivalent workspace controls.

### DOM provenance

The anonymous `https://grok.com/` web app and a public read-only `/share/<id>`
conversation were inspected through their visible DOM on 2026-07-15. Repeated
home-page loads exposed two provider-owned composer variants:

- `div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]`
- `textarea[aria-label="Ask Grok anything"][placeholder="What do you want to know?"]`

The same visible surfaces supplied these exact contracts:

- `button[data-testid="chat-submit"][aria-label="Submit"][type="submit"]`
- `div[data-testid="assistant-message"]` for assistant answers and
  `div[data-testid="user-message"]` for user messages
- `button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]`
- `button[data-testid="attach-button"][aria-label="Attach"][aria-haspopup="menu"]`
- `input[type="file"][name="files"][multiple]`
- `div[data-testid="anon-paywall-sign-up-card"]`

A benign anonymous prompt was entered and submitted solely to observe the
visible state transition. Grok rendered the user message and then replaced the
composer with the exact anonymous paywall above. This proves that an account is
required to receive a response even though the initial anonymous composer is
interactive. Persistent Sign in and Sign up links are not treated as blockers
before that transition.

The reduced and redacted fixture at `test/fixtures/grok-real-dom-fixture.html`
combines the home-page controls with the public-share answer node without
retaining public conversation text. Its inline script is a deterministic local
test shim, not Grok JavaScript. No active authenticated response was generated
during this capture, so the base adapter deliberately does not invent a busy
selector. An authenticated visible-session capture is required before adding a
busy-state contract.

### Current acceptance boundary

The Grok base adapter is accepted only when focused browser tests prove both
observed composer variants, exact submit and answer selection, stale-answer
exclusion, `/` to `/c/<opaque-id>` navigation, anonymous-paywall failure, and
selector-drift failure. A separate fixture E2E must prove the complete CLI,
daemon, native-host, extension service-worker, and content-script chain. Model
selection, file attachment, and Project/workspace isolation remain gated on the
authenticated enrichment capture even though their public controls or product
documentation are visible.
