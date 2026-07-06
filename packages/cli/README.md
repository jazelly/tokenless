# Tokenless CLI

Tokenless lets a local agent use the AI sessions already open in your browser. It sends a task to a visible ChatGPT, Gemini, or Claude tab, waits for the answer, and returns the visible response without exporting provider cookies, browser storage, or hidden API tokens.

## Install

```bash
npm install -g tokenless
```

## Set Up The Browser Bridge

Install the Tokenless browser extension through Chrome Web Store, an unpacked build, or a zip package. Then bind that extension id to the local native host:

```bash
tokenless install --extension-id <chrome-extension-id>
tokenless doctor --extension-id <chrome-extension-id>
```

The CLI resolves the extension id in this order: `--extension-id`, `TOKENLESS_EXTENSION_ID`, then the bundled fallback in `src/default-extension-id.js`. Update that tracked file when the distributed extension id changes.

## Configure Provider Preference

```bash
tokenless config --preferred-providers claude,chatgpt,gemini
```

This writes `~/.tokenless/config.json`. When `tokenless run` has no explicit `--provider`, it uses the first configured provider before falling back to ChatGPT. The extension side panel displays this local configuration.

## Run A Task

```bash
tokenless run \
  --provider chatgpt \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --context-file /tmp/shareable-context.md \
  --extension-id <chrome-extension-id>
```

Tokenless opens a browser task page, routes the request through the extension, submits the prompt in the visible provider UI, waits for visible answer text, and returns that answer to the local agent.

By default, `tokenless run` and `tokenless snapshot-dom` print compact `[tokenless]` status lines to stdout when the local job is created, opened, polled, and completed. Use `--json` when the caller needs a single parseable JSON payload; the same status summary is included as `status` and `statusLog`. Use `--quiet` to suppress status lines in non-JSON mode.

## Capture A DOM Snapshot

```bash
tokenless snapshot-dom \
  --provider chatgpt \
  --extension-id <chrome-extension-id> \
  --json
```

Tokenless asks the extension to capture a sanitized DOM snapshot from the visible provider page, then writes artifacts under `~/.tokenless/snapshots/<provider>/`. It does not read provider cookies, localStorage/sessionStorage, hidden auth headers, or private provider APIs. Use `--include-text` only when the visible page text is intentionally shareable.

## Conversation Mapping

Use stable `--project-name` and `--chat-name` values from the calling agent. Tokenless derives a conversation key from both names, or from either single name when only one is available, unless an explicit `--idempotency-key` is provided. If neither name nor explicit key is present, Tokenless starts from a new visible chat instead of reusing a mapped conversation. It stores the local provider-conversation mapping in `~/.tokenless/meta/conversations.json`. A new key opens the provider home URL, and once ChatGPT redirects to a conversation URL such as `https://chatgpt.com/c/...`, later runs with the same key return to that same conversation. The extension side panel shows local task history grouped by project and chat, including the mapped provider URL.

## Boundary

Tokenless does not bypass login, CAPTCHA, provider permissions, rate limits, or user-visible confirmations. It does not read provider cookies, localStorage/sessionStorage tokens, hidden auth headers, or private provider backend APIs.
