# Tokenless CLI

`tokenless` is an agent-facing CLI with two isolated transports: recommended visible ChatGPT, Claude, Gemini, or Grok browser sessions, and an experimental opt-in direct mode through provider-owned clients or documented public APIs.

## Install

For visible mode, first install and enable the Tokenless extension in the Chromium browser that will hold your provider session. Direct-only use does not require the extension or a browser.

### npm (recommended)

```bash
npm install --global tokenless@latest
tokenless setup --json
tokenless doctor --json
```

`setup` installs the local runtime, registers the Native Messaging host for one detected browser, opens the selected provider page when needed, and succeeds only after the extension bridge is live. Sign in to the provider in that visible page if prompted. `tokenless install` remains available when you only want to provision the local runtime without activating the browser bridge.

### npx (no global install)

```bash
npx tokenless@latest setup --json
npx tokenless@latest doctor --json
```

### Raw GitHub installer

```bash
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

Because this command executes with `sudo`, [review the installer source](https://github.com/jazelly/tokenless/blob/main/deploy/install.sh) before running it. The script installs the CLI system-wide. It intentionally does not configure the browser as root; return to your normal desktop account and run `tokenless setup --json` followed by `tokenless doctor --json`.

The universal package contains JavaScript only and declares exact-version optional native packages for darwin/linux on arm64/x64 and win32 on arm64/x64. npm installs only the matching package, which contains `tokenless-daemon` and `tokenless-native-host`; publisher-side prepack verification requires each executable to report the exact role, package version, and normalized target tuple before packing. No install hook or normal command downloads or verifies an executable, and users do not need Rust. The published extension id is bundled; pass `--extension-id <id>` only for an unpacked or alternate extension build.

Configure defaults:

```bash
tokenless config --preferred-providers chatgpt,claude,gemini,grok --browser chrome --json
```

## Agent Workflow

```bash
npx tokenless run \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --json
```

`run` requires no extension id after setup. It starts the Rust daemon when needed. If the extension bridge is live, the CLI does not pre-open a wake tab; otherwise it opens only the selected provider's validated HTTPS UI in the configured Chromium browser. The extension reuses an approved provider tab when possible or opens one provider tab when necessary. ChatGPT is the provider default. Tokenless never opens a task page, extension page, local file, runner, settings, or history page.

## Experimental Direct/API Mode

Direct mode is under active development. Prefer visible extension mode unless direct client or API integration is required. It never initializes or falls back to the daemon, extension, or browser path. ChatGPT defaults to the provider-owned Codex executable on macOS and Linux. Public API execution supports ChatGPT, Claude, Gemini, Grok, and explicit Antigravity-compatible gateways; credentials are read only from environment variables.

```bash
tokenless run --mode direct --provider chatgpt --prompt "Summarize this." --json

TOKENLESS_DIRECT_GEMINI_API_KEY=... \
tokenless run --mode direct --provider gemini --model <api-model> --prompt "Summarize this." --json
```

Start an authenticated loopback API broker for compatible local clients:

```bash
TOKENLESS_DIRECT_SERVER_KEY=... \
TOKENLESS_DIRECT_CHATGPT_API_KEY=... \
tokenless serve --mode direct --host 127.0.0.1 --port 8788 --json
```

Every broker request, including `/health` and `/capabilities`, requires `Authorization: Bearer <TOKENLESS_DIRECT_SERVER_KEY>`. The broker strips inbound credentials and cookies, injects the selected environment credential, preserves streaming bytes, and exposes only its reviewed public inference allowlist. An exact `x-tokenless-project` can select a durable public API account binding or the bounded stateless ChatGPT `POST /v1/responses` adapter backed by an isolated official Codex profile. It never exposes private provider web routes or gateway administration/account routes. Public API traffic may be billed separately from a web subscription.

See [Project-Affine Multi-Account Routing](../../docs/multi-account-routing.md) for multi-account onboarding, project pinning, routing domains, and failover rules.

Use a randomly generated server key of at least 32 visible non-whitespace characters; for example, `openssl rand -hex 32` produces a suitable value.

## Visible provider controls

Use the generic visible control inventory to discover the exact models that the
current provider page exposes:

```bash
npx tokenless provider-controls --provider gemini --json
```

Configure a visible model without submitting a prompt, or attach the same
selection to `run`:

```bash
npx tokenless provider-configure \
  --provider grok \
  --model "Expert" \
  --model-fallback "Auto,Fast" \
  --json

npx tokenless run \
  --provider gemini \
  --model "3.5 Thinking" \
  --model-fallback "3.5 Flash" \
  --prompt "Review this design." \
  --json
```

Model matching uses the complete visible label after case and whitespace
normalization; it is not substring or fuzzy matching.

Tokenless tries the requested label and then each `--model-fallback` in order,
verifies the visible selected state, and blocks before prompt submission if none
is available.

ChatGPT, Gemini, and Grok currently expose captured model-menu contracts. Claude
control inventory reports no available models, and any Claude model request
fails closed until an authenticated real-DOM model selector is captured.

ChatGPT-specific `chatgpt-controls` and `chatgpt-configure` remain compatibility
aliases. ChatGPT runs enforce the visible `Chat` surface.

`--effort` accepts `instant`, `medium`, `high`, `extra_high`, or `pro` and is not
accepted for the other providers.

When a complete five-level ChatGPT Intelligence menu is visible, Tokenless
selects the strongest available level at or below the requested effort.

Incomplete or unlabelled effort menus preserve the current effort rather than
guessing. A missing requested model never silently preserves another model.

## Visible file attachments

Repeat `--attach-file` to add local files through the provider's visible file
input before the prompt is submitted:

```bash
npx tokenless run \
  --provider claude \
  --attach-file ./brief.pdf \
  --attach-file ./notes.md \
  --prompt "Compare these files." \
  --json
```

This option is visible-mode only and is accepted only for `submit` and
`submit_and_read`. Tokenless accepts at most 100 files and 512 MiB total per
request.

The provider's visible `accept` attribute and account limits may be stricter and
always win.

ChatGPT, Claude, and Grok have exact captured file-input selectors. Gemini
upload fails closed until an authenticated exact input is captured.

The CLI stages each regular, non-symlink file in a private Tokenless bundle and
computes its size and SHA-256. Only path-free descriptors cross the daemon and
extension protocols.

The native host streams bytes for the claimed job. The content script verifies
the hash before constructing a browser `File`.

The exact provider input must accept the file, and a new visible filename must
appear near the composer. Otherwise the file is cleared and the prompt is not
submitted.

The pipeline never reads browser cookies, storage, hidden auth headers, or
private provider APIs.

## Provider-native Project isolation

Use `--target-url` with an exact existing ChatGPT or Claude Project URL when the
provider conversation must stay inside that Project:

```bash
npx tokenless run \
  --provider chatgpt \
  --target-url "https://chatgpt.com/g/<g-p-project-id>/project" \
  --prompt "Review the project context." \
  --json

npx tokenless run \
  --provider claude \
  --target-url "https://claude.ai/project/<project-id>" \
  --prompt "Review the project knowledge." \
  --json
```

Tokenless validates the strict provider HTTPS origin and exact Project route.

After submission, ChatGPT may navigate only to
`/g/<same-g-p-project-id>/c/<conversation-id>`, and Claude only to
`/project/<same-project-id>/chat/<conversation-id>`.

Cross-Project and ordinary chat transitions fail closed before response text is
read.

This does not discover, create, or click a provider Project. Copy the existing
Project URL from the visible signed-in browser session.

Gemini and Grok have no verified Project route, so `--target-url` is not a
Project-isolation guarantee for those providers.

`--project-name` remains Tokenless task metadata used to derive task ids. It does
not select a provider-native Project and may be used alongside `--target-url`.

For a visible provider task expected to take longer than three minutes, add `--long-running`. It extends the visible-response wait to 35 minutes and the daemon job wait to 36 minutes. Progress heartbeats are written to stderr so `--json` keeps stdout machine-readable. Do not use `--no-wait` for this mode.

## Research citations

When a provider visibly renders citations in the final assistant response, `run --json` returns them at `result.read.sources`. Each source contains a direct external HTTPS URL, its visible title when available, and its domain. Normal `run` output prints the same sources after the answer. Tokenless deduplicates source URLs, removes common tracking parameters, and excludes provider-internal links. Citation collection is limited to visible response DOM; it does not inspect browser history, storage, or provider APIs.

Use returned task ids to inspect daemon-backed state:

```bash
npx tokenless state --task-id "project:Website redesign:chat:Navbar review" --json
```

Cancel a job only through daemon-confirmed cancellation:

```bash
npx tokenless cancel --job-id "<job-id>" --json
```

If explicit cancellation or SIGINT/SIGTERM cannot be confirmed before the bounded cancel-request deadline, the CLI exits nonzero with `job_cancel_failed` and warns that the job may continue. `--cancel-timeout-ms` can shorten that deadline for automation.

Capture a sanitized visible-page DOM snapshot through the same path:

```bash
npx tokenless snapshot-dom --provider chatgpt --json
```

`--no-open` requires an already-live bridge and fails before queueing otherwise. `--no-daemon` and local task-page fallback do not exist.

## Boundary

Visible mode uses only visible provider DOM after user-granted extension permission. Direct mode uses provider-owned clients or documented public APIs with environment-only credentials. Neither mode reads provider cookies, localStorage/sessionStorage tokens, hidden auth headers, or private backend APIs, and there is no cross-mode fallback. Daemon access is loopback-only. Before every bearer-authenticated visible job call, the CLI verifies a fresh challenge-bound `/ready` HMAC proof covering both protocols and canonical home; an unproved listener never receives the token. `doctor` refreshes installed binaries before reading config or running checks and exits nonzero when any reported check fails.
