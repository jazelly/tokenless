# Tokenless

Tokenless is a standalone visible-session bridge for AI web products and local agents. It packages a browser extension, shared protocol, server-runner shell, and local scale runtime so a web app or a local agent can ask a user-authorized web session to perform visible UI work without exporting cookies or calling hidden provider APIs.

## Architecture

```text
Local agent skill
  -> scale CLI
  -> ~/.tokenless/jobs/<jobId>.request.json
  -> chrome-extension://<extension-id>/task/task.html?jobId=...&nonce=...
  -> extension task page / background worker
  -> native messaging host
  -> visible ChatGPT, Gemini, or Claude tab
  -> provider content script
  -> ~/.tokenless/jobs/<jobId>.result.json
  -> compact result for the agent
```

Hosted/webapp flow stays separate:

```text
Web app
  -> Tokenless client protocol
  -> runner server
  -> browser extension
  -> provider content script
  -> visible ChatGPT, Gemini, or Claude tab
```

## Packages

- `@tokenless/browser-session-bridge`: Manifest V3 extension, content scripts, provider selectors, and web-client helper.
- `@tokenless/client`: webapp client helpers for runner-server requests.
- `@tokenless/runner-server`: HTTP runner shell for web apps and hosted control planes.
- `@tokenless/local-scale`: self-contained local runtime and agent-facing scale script.

## Commands

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```

Load `packages/browser-session-bridge/dist/extension` as an unpacked extension in Chrome, Edge, or Arc for local extension testing.

Install local native messaging support after the extension id is known:

```bash
scale install --extension-id <chrome-extension-id> --json
scale doctor --extension-id <chrome-extension-id> --json
scale run \
  --provider chatgpt \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --context-file /tmp/shareable-context.md \
  --extension-id <chrome-extension-id> \
  --json
```

## Safety Boundary

Tokenless does not bypass login, CAPTCHA, provider permissions, rate limits, or user-visible confirmations. The browser extension can fill, click, and read approved provider pages only after the browser grants the required host permission.
