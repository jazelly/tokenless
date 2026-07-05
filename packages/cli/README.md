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

## Run A Task

```bash
tokenless run \
  --provider chatgpt \
  --idempotency-key agent-chat-123 \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --context-file /tmp/shareable-context.md \
  --extension-id <chrome-extension-id>
```

Tokenless opens a browser task page, routes the request through the extension, submits the prompt in the visible provider UI, waits for visible answer text, and returns that answer to the local agent.

## Conversation Mapping

Use one stable `--idempotency-key` per agent chat thread. Tokenless stores the local provider-conversation mapping in `~/.tokenless/meta/conversations.json`. A new key opens the provider home URL, and once ChatGPT redirects to a conversation URL such as `https://chatgpt.com/c/...`, later runs with the same key return to that same conversation.

## Boundary

Tokenless does not bypass login, CAPTCHA, provider permissions, rate limits, or user-visible confirmations. It does not read provider cookies, localStorage/sessionStorage tokens, hidden auth headers, or private provider backend APIs.
