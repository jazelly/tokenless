# Tokenless

Tokenless is a standalone project that helps agents save tokens by routing suitable work through the visible web version of ChatGPT, Claude, or Gemini that the user is already signed into.

Chinese version: [README.zh-CN.md](README.zh-CN.md)

## Core Value

Many requests—second opinions, research-style answers, drafts, explanations, reviews, and simple transformations—do not need another paid API call. Tokenless gives an agent a local CLI entrypoint, drives only the provider UI the user can see, and returns the visible answer to the agent flow.

## How It Works

1. The agent invokes `npx tokenless run`.
2. The CLI starts the packaged Rust daemon if it is not already ready for the requested Tokenless home.
3. If the extension's Rust Native Messaging bridge is live, the CLI does not pre-open a wake tab. Otherwise it opens only the selected provider's validated HTTPS page in the configured Chromium browser; ChatGPT is the default. The extension then reuses an approved provider tab or opens one provider tab when necessary.
4. The extension submits the prompt and reads the answer through visible DOM interaction.
5. The Rust host completes the daemon-backed job and the CLI returns the visible result.

There is no local JSON task queue, task-page fallback, local-file page, Node native host, or automatic `chrome-extension://` navigation.

## Install

First install and enable the Tokenless extension in Chrome. Then run the one-time local setup:

```bash
npx tokenless setup
```

`npx` downloads the CLI when needed; install globally with `npm install -g tokenless` only if you prefer the shorter command. Agents that support skills can optionally install the Tokenless skill:

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless
```

`setup` installs the local Rust runtime, binds the extension to one Chromium browser, opens ChatGPT when needed, and confirms that the browser bridge is actually connected. If ChatGPT asks you to sign in, complete that login in the visible tab. A setup that cannot see the bridge fails with a direct instruction to install or enable the extension; it never reports a false success merely because local files were written.

The published extension id is bundled. For an unpacked development build, override it once:

```bash
npx tokenless setup --extension-id "<chrome-extension-id>" --json
```

The universal `tokenless` package contains JavaScript only. npm selects an exact-version, OS/CPU-specific optional dependency containing `tokenless-daemon` and `tokenless-native-host`; setup copies those local binaries into `~/.tokenless/bin`, installs one exact native-host allowed origin, binds only the selected Chromium browser by default, and ensures the daemon and extension bridge are ready. There is no runtime executable download, install script, or Cargo requirement for end users.

Configure routing and the browser explicitly when desired:

```bash
tokenless config --preferred-providers chatgpt,claude,gemini --browser chrome --json
```

Without a configured browser, setup deterministically detects Chrome, Brave, Edge, Arc, then Chromium. Tokenless never sends provider URLs to the arbitrary system default browser. An explicit multi-browser native-host install is available through `tokenless install --browsers chrome,brave`, but a single browser avoids competing extension profiles claiming the same queue.

## Run A Request

```bash
tokenless run \
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

## Query Daemon-Backed State

```bash
tokenless state --task-id "project:Website redesign:chat:Navbar review" --json
```

`state` reads jobs and task metadata from the Rust daemon's SQLite store with exact provider/task filters. It does not inspect legacy local job JSON. Prompt bodies and claim capabilities are omitted; the authenticated CLI view preserves the daemon's full `error_json` so agents retain actionable failure detail. The extension Settings history is a separate bounded scalar-only view.

Cancel a detached or externally tracked job explicitly:

```bash
tokenless cancel --job-id "<job-id>" --json
```

Success means the daemon confirmed `status: canceled`. SIGINT/SIGTERM and explicit cancellation exit nonzero with `job_cancel_failed` when cancellation cannot be confirmed; the message warns that the job may still be running or may already have completed.

## Capture A Sanitized DOM Snapshot

```bash
tokenless snapshot-dom --provider chatgpt --json
```

Snapshots use the same daemon and provider-only wake path. Sanitized artifacts are written under `~/.tokenless/snapshots/<provider>/`; unsanitized snapshot payloads are rejected.

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

The extension build is written to `packages/extension/dist/extension`. Load it through `chrome://extensions`, enable developer mode, choose **Load unpacked**, and select that directory. Then bind its real development id:

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"
tokenless setup --extension-id "$TOKENLESS_EXTENSION_ID" --json
```

Run a visible-session smoke test:

```bash
cat > /tmp/tokenless-request.md <<'EOF'
Reply with exactly this text and nothing else:

TOKENLESS_LOCAL_OK_48291
EOF

tokenless run \
  --provider chatgpt \
  --project-name "Tokenless local dev" \
  --chat-name "Smoke test" \
  --project-root "$(pwd)" \
  --prompt-file /tmp/tokenless-request.md \
  --read-timeout-ms 180000 \
  --json
```

Success is `ok: true` with `compactOutput` containing `TOKENLESS_LOCAL_OK_48291`.
