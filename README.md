# Tokenless

Tokenless helps agents save tokens.

Many agent requests do not need to spend paid API tokens. They can be answered by the AI web apps you already use in your browser. Tokenless routes those requests to the visible web version of ChatGPT, Claude, or Gemini, then brings the answer back to your local agent.

Chinese version: [README.zh-CN.md](README.zh-CN.md)

## Core Value

Tokenless solves one simple problem:

> Your agent should not spend tokens on work that a free or already-open web chat can handle.

When a request is a good fit, Tokenless sends it to the provider's normal web page. The answer comes back into the agent flow, so you keep working without copying prompts and responses by hand.

This can reduce token usage for everyday agent work, especially for:

- second opinions
- research-style answers
- draft writing
- code review notes
- explanations
- simple transformations
- tasks where the web chat answer is good enough

## How It Works

From the user's point of view:

1. You keep ChatGPT, Claude, or Gemini logged in in your browser.
2. Your local agent asks Tokenless to run a request.
3. Tokenless opens the visible web chat.
4. The prompt is sent through the page you can see.
5. The visible answer is returned to the agent.

No manual copy and paste. No separate API key for that request. No hidden provider backend calls.

## Why It Matters

Agents are powerful, but token usage adds up quickly. A lot of agent work is not high-stakes model reasoning. It is checking, rewriting, explaining, summarizing, or getting another model's view.

Tokenless gives your agent a lower-cost path for that kind of work. Use tokens where they matter. Use the web version when that is enough.

## Install

Install the CLI:

```bash
npm install -g tokenless
```

Install the Tokenless skill so agents can call it:

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless
```

Install the Tokenless browser extension from the Chrome Web Store, an unpacked build, or a zip package.

Then connect the extension to your machine:

```bash
tokenless install --extension-id <chrome-extension-id>
tokenless doctor --extension-id <chrome-extension-id>
```

Choose the web providers you want Tokenless to try first:

```bash
tokenless config --preferred-providers claude,chatgpt,gemini --browser brave
```

This writes `~/.tokenless/config.json`. `tokenless run` and `tokenless snapshot-dom` use `--browser` first, then this configured browser, then the platform default. Supported browser ids are `chrome`, `chrome-for-testing`, `chromium`, `edge`, `arc`, and `brave`.

## Run A Request

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

Tokenless returns the provider's visible answer to the local agent.

If you pass the same project and chat names again, Tokenless can return to the same web conversation instead of starting over.

## What Is Included

- `tokenless`: the CLI that users install and agents call.
- `Tokenless`: the browser extension that works with visible provider pages.
- `tokenless-relay`: an optional relay package for hosted integrations.
- `tokenless-client`: optional helper code for apps that use the relay.

Publish now:

- `tokenless`

Do not publish yet:

- `tokenless-relay`
- `tokenless-client`
- `tokenless-browser-session-bridge`

## Safety Boundary

Tokenless works only through the visible browser session after the user grants permission.

It does not bypass login, CAPTCHA, rate limits, provider permissions, or user confirmations. It does not read provider cookies, browser storage tokens, hidden auth headers, or private provider backend APIs.

If the provider page asks for something the user must handle, Tokenless reports that blocker instead of trying to bypass it.

## Development

```bash
npm run build
npm test
npm run test:e2e
```

`npm run build` writes an unpacked extension to `packages/extension/dist/extension`.

Load it in Chrome, Brave, Edge, Chromium, or Arc:

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Choose **Load unpacked**.
4. Select `packages/extension/dist/extension`.

Then bind the real extension id:

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"

tokenless install --extension-id "$TOKENLESS_EXTENSION_ID" --json
tokenless doctor --extension-id "$TOKENLESS_EXTENSION_ID" --json
```

Run the local smoke test against a logged-in ChatGPT browser profile:

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
  --project-name "Tokenless local dev" \
  --chat-name "Smoke test" \
  --project-root "$(pwd)" \
  --prompt-file /tmp/tokenless-request.md \
  --context-file /tmp/tokenless-context.md \
  --extension-id "$TOKENLESS_EXTENSION_ID" \
  --read-timeout-ms 180000 \
  --json
```

Success is `ok: true` with `compactOutput` containing `TOKENLESS_LOCAL_OK_48291`.
