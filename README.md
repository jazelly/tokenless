# Tokenless

Tokenless lets a local agent use the AI subscriptions already open in your browser. It sends a task to a visible ChatGPT, Gemini, or Claude tab, waits for the answer, and returns the visible response to the agent without exporting cookies, browser storage, or hidden provider API tokens.

Chinese version: [README.zh-CN.md](README.zh-CN.md)

## Why It Exists

AI coding agents often need a second model or a user-owned subscription, but the normal options are awkward:

- API keys are another secret to provision, rotate, and pay for.
- Browser automation often assumes a disposable test profile instead of the browser where the user is already logged in.
- Copying prompts and answers by hand breaks flow and loses project context.
- Provider sessions should stay visible and user-controlled, especially when login, CAPTCHA, rate limits, or confirmations appear.

Tokenless keeps that work in the browser session the user already trusts. The extension can only act on approved provider pages, and it operates through visible UI selectors rather than private provider endpoints.

## User Experience

Install the CLI:

```bash
npm install -g tokenless
```

Load the Tokenless browser extension from:

```text
packages/extension/dist/extension
```

Then bind the extension to the local native host:

```bash
tokenless install --extension-id <chrome-extension-id>
tokenless doctor --extension-id <chrome-extension-id>
```

Run a task from a local agent or terminal:

```bash
tokenless run \
  --provider chatgpt \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --context-file /tmp/shareable-context.md \
  --extension-id <chrome-extension-id>
```

What the user sees:

1. A Tokenless task page opens in the browser.
2. The extension opens or reuses the selected provider tab.
3. The prompt is inserted into the visible composer and submitted.
4. Tokenless waits for the visible response text.
5. The answer is returned to the local agent.

## What It Includes

- `tokenless`: the CLI users install and agents call.
- `Tokenless Browser Session Bridge`: the browser extension that works with visible provider tabs.
- `tokenless-relay`: an optional HTTP relay for web or hosted integrations that need a stable Tokenless entrypoint.
- `tokenless-client`: optional helper code for web apps talking to the relay.

## Publishing

Publish now:

- `tokenless`

Do not publish yet:

- `tokenless-relay`
- `tokenless-client`
- `tokenless-browser-session-bridge`

The extension is distributed through Chrome Web Store, an unpacked build, or a zip package. Users install it in the browser, not through npm.

## Safety Boundary

Tokenless does not bypass login, CAPTCHA, provider permissions, rate limits, or user-visible confirmations. It does not read provider cookies, localStorage/sessionStorage tokens, hidden auth headers, or private provider backend APIs. If a blocker appears in the visible browser session, Tokenless reports it instead of trying to bypass it.

## Development

```bash
npm run build
npm test
npm run test:e2e
```

The live ChatGPT test is opt-in because it requires a real logged-in browser profile:

```bash
TOKENLESS_LIVE_CHATGPT=1 npm run test:e2e:live-chatgpt
```

## Local Dev Test

Run these commands from the repo root:

```bash
REPO_ROOT="$(pwd)"

npm install
npm run build
npm test
npm run test:e2e

npm install -g ./packages/cli
```

Load the unpacked extension from `packages/extension/dist/extension`:

```bash
open "chrome://extensions"
```

Copy the real 32-character extension id, then run:

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"

tokenless install --extension-id "$TOKENLESS_EXTENSION_ID" --json
tokenless doctor --extension-id "$TOKENLESS_EXTENSION_ID" --json
```

Open ChatGPT in the same browser profile, then run the smoke test:

```bash
open "https://chatgpt.com"

cat > /tmp/tokenless-request.md <<'EOF'
Reply with exactly this text and nothing else:

TOKENLESS_LOCAL_OK_48291
EOF

cat > /tmp/tokenless-context.md <<'EOF'
This is a local Tokenless smoke test. No private secrets are included.
EOF

tokenless run \
  --provider chatgpt \
  --project-root "$REPO_ROOT" \
  --prompt-file /tmp/tokenless-request.md \
  --context-file /tmp/tokenless-context.md \
  --extension-id "$TOKENLESS_EXTENSION_ID" \
  --read-timeout-ms 180000 \
  --json
```

Success is `ok: true` with `compactOutput` containing `TOKENLESS_LOCAL_OK_48291`.
