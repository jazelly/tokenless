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
