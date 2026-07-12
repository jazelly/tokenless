[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

Tokenless is a standalone project that helps agents save tokens by routing suitable work through the visible web version of ChatGPT, Claude, or Gemini that the user is already signed into.

## Install

You need Node.js 22+ and the Tokenless extension installed and enabled in Chrome, Brave, Edge, Arc, or Chromium. The extension and your provider sign-in are the only manual browser steps.

Install the Tokenless setup skill:

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless-install --yes
```

Then send your agent this message:

```text
Use $tokenless-install to install Tokenless, install its main skill, and verify that it is ready.
```

The setup skill installs the main `tokenless` skill, provisions the latest CLI and local runtime, and finishes with `doctor`. It reports any required browser action directly. To upgrade or repair later, tell the agent: `Use $tokenless-install to upgrade Tokenless and verify it.`

## Why Tokenless

### 1. Save tokens first

Use the web subscription you already have for second opinions, research-style answers, drafts, explanations, reviews, and simple transformations—work that often does not justify another paid API call. Tokenless returns the visible result to the agent workflow without consuming another model API request.

### 2. Browser-native, safer by design

Tokenless uses the same general extension-and-local-bridge model as browser-integrated agent tools: it drives only the visible controls in your signed-in browser. It never reads or exports provider cookies, browser passwords, storage tokens, hidden authorization headers, or private provider APIs. This keeps your credentials in the browser and avoids private API automation; provider terms and visible confirmations still apply.

### 3. Free, open source, and privacy-respecting

Tokenless is free and open source. It has no hosted relay that receives your browser session. Only the prompt, explicitly shareable context, and intentionally selected files are submitted to the provider's visible web UI. Your provider login, cookies, and unrelated browser data remain private.

### 4. Powerful and extensible

Tokenless supports ChatGPT, Claude, and Gemini today. Its visible-session adapter model is designed to extend to AI providers with compatible web interfaces, without changing the safety boundary above.

## How It Works

1. The agent invokes `npx tokenless run`.
2. The CLI starts the packaged Rust daemon if it is not already ready for the requested Tokenless home.
3. If the extension's Rust Native Messaging bridge is live, the CLI does not pre-open a wake tab. Otherwise it opens only the selected provider's validated HTTPS page in the configured Chromium browser; ChatGPT is the default. The extension then reuses an approved provider tab or opens one provider tab when necessary.
4. The extension submits the prompt and reads the answer through visible DOM interaction.
5. The Rust host completes the daemon-backed job and the CLI returns the visible result.

There is no local JSON task queue, task-page fallback, local-file page, Node native host, or automatic `chrome-extension://` navigation.

## Advanced Setup

The published extension id is bundled. For an unpacked development build, provide its id once:

```bash
npx tokenless@latest setup --extension-id "<chrome-extension-id>" --json
```

The universal `tokenless` package contains JavaScript only. npm selects an exact-version, OS/CPU-specific optional dependency containing `tokenless-daemon` and `tokenless-native-host`; setup copies those local binaries into `~/.tokenless/bin`, installs one exact native-host allowed origin, binds only the selected Chromium browser by default, and ensures the daemon and extension bridge are ready. There is no runtime executable download, install script, or Cargo requirement for end users.

Configure routing and the browser explicitly when desired:

```bash
npx tokenless@latest config --preferred-providers chatgpt,claude,gemini --browser chrome --json
```

Without a configured browser, setup deterministically detects Chrome, Brave, Edge, Arc, then Chromium. Tokenless never sends provider URLs to the arbitrary system default browser. An explicit multi-browser native-host install is available through `npx tokenless@latest install --browsers chrome,brave`, but a single browser avoids competing extension profiles claiming the same queue.

## Run A Request

```bash
npx tokenless run \
  --provider chatgpt \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --context-file /tmp/shareable-context.md \
  --json
```

Normal runs do not require an extension id. The returned `taskId` is derived from the project/chat names unless `--task-id` is supplied. Reuse it on later turns. Tokenless validates every explicit or remembered target as an HTTPS URL belonging to the selected provider before opening it.

`--no-open` is strict: it succeeds only when a fresh, live extension bridge marker already exists. Otherwise Tokenless fails before it queues a job, avoiding a request that waits forever.

For visible provider work expected to exceed three minutes, add `--long-running` to `run`. Tokenless then keeps the job attached for up to 36 minutes, permits up to 35 minutes for the visible answer, and emits progress heartbeats without polluting JSON stdout.

## ChatGPT Model and Intelligence

By default, Tokenless enters the visible **Chat** surface and preserves the model and Intelligence setting already selected by the user. Select Sol / Pro once in ChatGPT and later runs reuse that visible configuration. When a requested control is unavailable, Tokenless reports it as `preserved_current` rather than claiming that a different setting was selected, and still submits the prompt.

Strict CLI control is an explicit advanced mode. It requires the separately installed **Tokenless Debugger Control** companion and a per-run extension id; the id is never stored in Tokenless settings:

```bash
npx tokenless run \
  --provider chatgpt \
  --debugger-control-extension-id "<debugger-control-extension-id>" \
  --model "GPT-5.6 Sol" \
  --effort pro \
  --prompt "..." \
  --json
```

The default extension never requests Chrome's `debugger` permission. The companion is a separate MV3 extension restricted to ChatGPT origins; it has no content script, Native Messaging bridge, Network/Storage/CDP read path, or cookie/storage access. Its only debugger commands are a press and release for an already visible, validated control in the approved ChatGPT tab, followed immediately by detach.

For research answers, the JSON result includes `result.read.sources`: deduplicated direct HTTPS links visibly rendered inside the final assistant response, with their visible title and domain. Normal terminal output appends the same sources below the answer. Tokenless excludes provider-internal links and strips common tracking parameters; it never obtains citations from browser history, storage, or provider APIs.

## Query Daemon-Backed State

```bash
npx tokenless state --task-id "project:Website redesign:chat:Navbar review" --json
```

`state` reads jobs and task metadata from the Rust daemon's SQLite store with exact provider/task filters. It does not inspect legacy local job JSON. Prompt bodies and claim capabilities are omitted; the authenticated CLI view preserves the daemon's full `error_json` so agents retain actionable failure detail. The extension Settings history is a separate bounded scalar-only view.

Cancel a detached or externally tracked job explicitly:

```bash
npx tokenless cancel --job-id "<job-id>" --json
```

Success means the daemon confirmed `status: canceled`. SIGINT/SIGTERM and explicit cancellation exit nonzero with `job_cancel_failed` when cancellation cannot be confirmed; the message warns that the job may still be running or may already have completed.

## Capture A Sanitized DOM Snapshot

```bash
npx tokenless snapshot-dom --provider chatgpt --json
```

Snapshots use the same daemon and provider-only wake path. Sanitized artifacts are written under `~/.tokenless/snapshots/<provider>/`; unsanitized snapshot payloads are rejected.

## Save Tokens Without Exporting Your Session

Tokenless is for work that would otherwise consume another paid model/API call: research, second opinions, drafting, review, explanation, and transformations. It reuses the provider session that the user has already opened in their own browser, so the agent can return the visible answer without receiving the user's provider credentials.

Only the explicitly supplied prompt, shareable turn context, and intentionally selected project files are sent to the visible provider UI. Tokenless does **not** read, export, persist, or transmit:

- provider cookies or browser passwords;
- `localStorage` or `sessionStorage` tokens;
- hidden authorization headers or private provider backend APIs;
- browser history, unrelated tabs, or page data outside the approved provider tab.

The extension works only after the user grants host permission, and it drives the same visible controls the user can see. Login, CAPTCHA, rate limits, permission prompts, and other provider confirmations remain under the user's control.

## Safety Boundary

Tokenless operates only after the user grants extension host permission and only through user-visible provider pages. It does not bypass login, CAPTCHA, provider permissions, rate limits, or visible confirmations. It does not read provider cookies, localStorage/sessionStorage tokens, hidden auth headers, or private provider backend APIs.

See [the privacy policy](PRIVACY.md) for local data-handling details.

Daemon URLs must be loopback HTTP URLs. Before every token-bearing request, the CLI sends a fresh 32-byte challenge to `/ready` and verifies its HMAC-SHA256 proof with the home-local `daemon.token`; the proof binds the challenge, both protocol versions, and canonical home. A listener that only guesses those public fields never receives the bearer token or job prompt. Every job endpoint then requires that bearer token. `/health` is diagnostic only. Native messages are size-checked below Chrome's limit before a job is queued.

## Packages

Release as one versioned set:

- `tokenless`
- `tokenless-native-darwin-arm64`
- `tokenless-native-darwin-x64`
- `tokenless-native-linux-arm64`
- `tokenless-native-linux-x64`
- `tokenless-native-win32-arm64`
- `tokenless-native-win32-x64`

Publish all six native packages before the same-version universal `tokenless` package. The universal package declares exact versions, never `workspace:*` ranges.

Do not publish yet:

- `tokenless-relay`
- `tokenless-client`
- `tokenless-browser-session-bridge`

## Development

Building the repository requires Node.js 22+, npm, and Rust. The CLI build places the current tuple's release binaries in `packages/cli/npm/tokenless-native-<platform>-<arch>/bin`; `npm pack` of `tokenless` remains universal and binary-free. Before a native pack is created, its publisher-only verifier executes both binaries with a finite deadline and requires exact role, npm-aligned version, and normalized target tuple, rejecting swapped or stale artifacts. Release CI must build and pack the six supported tuples (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`) on appropriate trusted builders before publishing the universal package. Normal runtime resolution uses only the locally installed optional package and never downloads an executable.

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

The default extension build is written to `packages/extension/dist/extension`. Load it through `chrome://extensions`, enable developer mode, choose **Load unpacked**, and select that directory. Then bind its real development id:

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"
npx tokenless setup --extension-id "$TOKENLESS_EXTENSION_ID" --json
```

The separately loadable advanced companion is written to `packages/extension/dist/debugger-control`. Load it only when you need strict CLI model / Intelligence selection, copy its extension id from `chrome://extensions`, and pass that id with `--debugger-control-extension-id` for the individual run.

Run a visible-session smoke test:

```bash
cat > /tmp/tokenless-request.md <<'EOF'
Reply with exactly this text and nothing else:

TOKENLESS_LOCAL_OK_48291
EOF

npx tokenless run \
  --provider chatgpt \
  --project-name "Tokenless local dev" \
  --chat-name "Smoke test" \
  --project-root "$(pwd)" \
  --prompt-file /tmp/tokenless-request.md \
  --read-timeout-ms 180000 \
  --json
```

Success is `ok: true` with `compactOutput` containing `TOKENLESS_LOCAL_OK_48291`.
