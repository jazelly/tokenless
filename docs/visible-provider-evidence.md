# Visible provider evidence

Tokenless visible-session adapters are based on provider UI that a user can see
and authorize in the browser. They do not use provider cookies, browser storage,
hidden authentication headers, or private provider APIs.

This document records the time-sensitive product facts and DOM evidence used by
the adapters. Product limits can change. Runtime code must treat the visible UI
as authoritative and fail closed when a required control cannot be verified.

## Shared enrichment contract

`provider-controls` inventories model labels, availability, and selected state
from the visible provider menu. `provider-configure` and `run --model` use the
same DOM path. The older ChatGPT-specific commands remain compatibility aliases.

Model labels are compared as complete visible labels after whitespace and case
normalization. Tokenless never uses substring or guessed model matching.

It tries `--model` first, then each `--model-fallback` in order, and verifies the
visible selected state. If none is available, submission fails closed.

Repeated `run --attach-file <path>` arguments use a separate visible-attachment
protocol. The CLI copies regular, non-symlink files into a private local bundle,
records size and SHA-256, and creates path-free descriptors.

Only those descriptors reach the daemon and extension. The native host streams
bounded chunks from the claimed job.

The content script reconstructs a browser `File`, assigns it only to one exact
provider file input, and dispatches the visible input/change events.

It requires a new visible filename near the composer before submission. Hash,
offset, input, file-type, or visible-confirmation drift blocks the request.

Attachment descriptors never contain a source path. The pipeline does not read
provider cookies, browser storage, hidden authorization headers, or private web
APIs.

Provider-specific file limits and the exact visible input remain authoritative.
Tokenless also enforces a 100-file, 512 MiB request cap.

Project-isolated runs do not automate a provider Project picker. A caller may
pass an exact existing ChatGPT or Claude Project URL with `--target-url`.

Tokenless then accepts only the corresponding same-Project conversation route.
A cross-Project or ordinary-chat transition fails closed.

## ChatGPT

Evidence reviewed on 2026-07-16:

- The [ChatGPT Free Tier FAQ](https://help.openai.com/en/articles/9275245-using-chatgpt-s-free-tier-faq)
  documents free access with provider-controlled model and tool limits.
  Tokenless inventories the visible menu instead of assuming an entitlement.
- The [File Uploads FAQ](https://help.openai.com/en/articles/8555545-file-uploads-faq)
  documents visible ChatGPT uploads and quota behavior. The current input's
  accepted types and account UI remain authoritative.
- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
  says Projects are available to free and paid accounts and currently allows
  five files per Project for Free accounts.

### DOM provenance

The public ChatGPT shell re-inspected on 2026-07-16 exposed these exact controls:

- `button[data-testid="model-switcher-dropdown-button"][aria-label="Model selector"][aria-haspopup="menu"]`
- `button[data-testid="composer-plus-btn"][aria-label="Add files and more"]`
- `input#upload-files[type="file"][multiple]`

The unauthenticated model menu contained only sign-in/up-sell actions, so it is
not treated as model availability.

The signed-in reduced fixture preserves the existing model/effort menu roles
and selected state used by the accepted ChatGPT adapter. Its labels are test
data, not hard-coded account entitlement.

### Current acceptance boundary

ChatGPT control inventory and configuration use visible menu roles, exact model
labels, selected state, and the Chat-only surface. Attachments use only the
exact captured file input and require visible filename confirmation.

An exact target such as
`https://chatgpt.com/g/<g-p-project-id>/project` may transition only to
`/g/<same-g-p-project-id>/c/<conversation-id>`. Tokenless does not create a
Project or automate the Project picker.

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
- [Creating and managing Projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)
  confirms that free accounts can create up to five Projects. Each Project has
  its own chats, knowledge, and instructions.

### DOM provenance

The reduced fixture at `test/fixtures/claude-real-dom-fixture.html` preserves
adapter-relevant structure from the public `https://claude.ai/new` SSR shell
observed on 2026-07-15.

It includes these provider-owned DOM contracts:

- `div[data-testid="chat-input"][contenteditable="true"][role="textbox"]`
- `button[data-cds="Button"][aria-label="Send message"]`
- `input#chat-input-file-upload-onpage[data-testid="file-upload"][aria-label="Upload files"][type="file"][multiple]`
- `a[href="/projects"][aria-label="Projects"]`
- `[data-testid="virtual-message-list"]`
- `.font-claude-response-body`

The fixture is intentionally reduced and redacted. Its inline behavior is a
deterministic test shim, not copied provider JavaScript.

It reproduces only the user-visible test transitions: composer input, send
enablement, a new conversation URL, streaming state, and a stable answer.

It also preserves the exact file input used by the attachment receiver.

An authenticated model-menu capture remains required before Claude model
inventory or switching can be enabled. Native Project discovery, creation, and
picker automation also remain disabled; exact Project URLs are caller supplied.

### Current acceptance boundary

The Claude base adapter is accepted only when focused browser tests prove prompt
submission, `/new` to `/chat/<opaque-id>` navigation, streaming completion,
stable-answer selection, blocker detection, and selector drift failure.

A separate fixture E2E exercises the complete CLI, daemon, native host,
extension service worker, and content-script chain without opening an internal
task or runner page.

Visible attachments are accepted only through the exact captured file input and
only after the filename appears near the composer.

An exact target such as `https://claude.ai/project/<project-id>` may transition
only to
`/project/<same-project-id>/chat/<conversation-id>`.

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
2026-07-15, with the model menu re-inspected on 2026-07-16. The unauthenticated
`https://gemini.google.com/app` shell supplied the composer and static controls:

- `rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Enter a prompt for Gemini"]`
- `button[aria-label="Send message"]`, which appears after the composer becomes
  non-empty
- `button[data-test-id="bard-mode-menu-button"][aria-label^="Open mode picker, currently "]`
- `gem-menu-item[role="menuitem"][data-mode-id]`, with its primary label in
  `.label`, selected state in `data-active="true"`, and availability in
  `aria-disabled`
- `button[aria-label="Upload & tools"][aria-haspopup="menu"]`
- `button[data-test-id="local-images-files-uploader-button"][role="menuitem"][aria-label="Upload files. Documents, data, code files"]`

A public, read-only `/share/<opaque-id>` conversation supplied the provider-owned
answer hierarchy, without copying its conversation text:

- `response-container message-content`
- `response-container structured-content-container.message-content`

No live prompt was submitted while collecting this evidence, so the transient
busy control was not present in the static shell capture.

The adapter uses Google's current `Stop response` label as the exact
`button[aria-label="Stop response"]` busy-state contract. The local fixture
reproduces that state; a new capture is required if the control drifts.

The reduced and redacted fixture at
`test/fixtures/gemini-real-dom-fixture.html` merges only those structural
contracts. Its inline script is a deterministic test shim, not Gemini
JavaScript.

It reproduces model-menu inventory, exact selection, and unavailable items
without assuming that every account exposes the same models.

The capture helper also probes the static `/gems/view` sidebar route without
relying on volatile element IDs.

Authenticated sidebar and file-input evidence is still required before Gems,
saved isolation, or uploads become an automation contract.

### Current acceptance boundary

The Gemini adapter covers anonymous prompt submission, stable response
selection, model inventory, and exact available-model selection through visible
DOM. A requested unavailable label and exhausted fallback list block submission.

File upload remains disabled because no authenticated exact file input has been
captured. Gems and saved conversation isolation also remain pending.

They must not be enabled until a user-granted authenticated capture verifies
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
conversation were inspected through their visible DOM on 2026-07-15, with the
model menu and attachment controls re-inspected on 2026-07-16.

Repeated home-page loads exposed two provider-owned composer variants:

- `div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]`
- `textarea[aria-label="Ask Grok anything"][placeholder="What do you want to know?"]`

The same visible surfaces supplied these exact contracts:

- `button[data-testid="chat-submit"][aria-label="Submit"][type="submit"]`
- `div[data-testid="assistant-message"]` for assistant answers and
  `div[data-testid="user-message"]` for user messages
- `button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]`
- `[role="menuitem"][data-radix-collection-item] span.font-semibold` for each
  model's primary visible label
- `button[data-testid="attach-button"][aria-label="Attach"][aria-haspopup="menu"]`
- `input[type="file"][name="files"][multiple]`
- `div[data-testid="anon-paywall-sign-up-card"]`

A benign anonymous prompt was entered and submitted solely to observe the
visible state transition. Grok rendered the user message and then replaced the
composer with the exact anonymous paywall above.

This proves that an account is required to receive a response even though the
initial anonymous composer is interactive. Persistent Sign in and Sign up links
are not treated as blockers before that transition.

The reduced and redacted fixture at `test/fixtures/grok-real-dom-fixture.html`
combines the home-page controls with the public-share answer node without
retaining public conversation text.

Its inline script is a deterministic local test shim, not Grok JavaScript. It
reproduces exact model selection and the captured file input.

No active authenticated response was generated during this capture, so the
adapter deliberately does not invent a busy selector. An authenticated
visible-session capture is required before adding a busy-state contract.

### Current acceptance boundary

The Grok base adapter is accepted only when focused browser tests prove both
observed composer variants, exact submit and answer selection, stale-answer
exclusion, and `/` to `/c/<opaque-id>` navigation.

The same tests cover anonymous-paywall failure and selector-drift failure.

Focused fixtures also prove model inventory, exact model selection/fallback,
and attachment delivery to the captured file input.

Authenticated generation completion is still gated on a real busy-state DOM
capture.

Project/workspace isolation also remains unsupported because public evidence
does not establish a safe personal Project route or free-plan entitlement.
