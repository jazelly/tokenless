---
name: tokenless
description: Route shareable Q&A, analysis, review, research, writing, and other non-project-writing work through a user's visible ChatGPT, Claude, or Gemini browser session to save API tokens.
---

# Tokenless agent workflow

Use `npx tokenless` as the entrypoint when this skill applies. Do not reproduce the visible-session workflow yourself.

Tokenless is daemon-only. Its packaged Rust daemon and Rust Native Messaging host connect the CLI to the browser extension. It never uses a local JSON task queue, a local file URL, a `chrome-extension://` task page, provider cookies, browser storage tokens, hidden auth headers, or private provider APIs.

## Installation prerequisite

Require the `tokenless-install` skill to complete installation, upgrades, repairs, and `doctor` verification before this skill runs provider work. If setup is incomplete or a command reports a missing binary, native host, manifest, or extension bridge, use `tokenless-install`; do not improvise a repair or request normal-run extension IDs.

## Read provider preferences

```bash
npx tokenless config --json
```

Use the first configured `preferredProviders` entry unless the user explicitly chooses `chatgpt`, `claude`, or `gemini`. When none is configured, Tokenless defaults to ChatGPT.

## Build only shareable context

You may build a prompt file before the run:

```bash
npx tokenless \
  --project-root "/absolute/path/to/project" \
  --project-name "<agent project name>" \
  --chat-name "<agent task name>" \
  --prompt "<user request>" \
  --file <relative-file> \
  --output /tmp/tokenless-prompt.md
```

Include only the user's request, explicit shareable turn context, and intentionally selected files. Never include hidden reasoning, credentials, cookies, browser storage, private headers, or secrets.

## Run through the visible provider UI

```bash
npx tokenless run \
  --project-name "<agent project name>" \
  --chat-name "<agent task name>" \
  --project-root "/absolute/path/to/project" \
  --prompt-file /tmp/tokenless-prompt.md \
  --json
```

For a provider task expected to take longer than three minutes, keep the daemon job attached and use `--long-running`:

```bash
npx tokenless run \
  --long-running \
  --provider chatgpt \
  --project-name "<agent project name>" \
  --chat-name "<agent task name>" \
  --project-root "/absolute/path/to/project" \
  --prompt-file /tmp/tokenless-prompt.md \
  --json
```

`--long-running` allows up to 35 minutes for a visible provider response and 36 minutes for the daemon job. Keep the command attached; its progress heartbeats arrive on stderr while stdout remains machine-readable JSON. Do not use `--no-wait`, do not replace the web task with a local agent run, and do not claim a result until the daemon reports `succeeded`.

Add `--provider chatgpt`, `--provider claude`, or `--provider gemini` only when provider selection is intentional. Retain the returned `taskId`, and pass `--task-id "<taskId>"` on later turns for the same task.

For ChatGPT, Tokenless selects the visible Chat surface before sending. Never request Work. Use `npx tokenless chatgpt-controls --json` to inspect the signed-in account's currently visible models and Intelligence levels. Add `--model "<visible model>"`, optional `--model-fallback "<model,...>"`, and `--effort instant|medium|high|extra_high|pro` to `run` when the user asks for them. A missing model tries the supplied fallback list then preserves the visible current model; unavailable or structurally ambiguous Intelligence levels preserve the current level. These control fallbacks must not prevent the prompt from being submitted.

The only page Tokenless may open automatically is the selected provider's HTTPS UI (ChatGPT by default). It does not automatically open extension settings, task, runner, history, or local-file pages. If a live extension bridge exists, the CLI does not pre-open a wake tab; the extension reuses an approved provider tab when available or opens one provider tab otherwise. Do not add `--no-open` unless you know a live bridge exists: otherwise Tokenless fails clearly before creating a job.

Respect CLI state. Continue waiting while a normal or long-running run reports `queued`, `claimed`, `running`, or `daemon_waiting`. Fail fast on `failed`, `canceled`, `timed_out`, `blocked`, or `ui_mismatch`, and surface any visible login, CAPTCHA, permission, or confirmation action the user must handle.

## Query daemon-backed state

```bash
npx tokenless state \
  --task-id "<returned taskId>" \
  --json
```

`state` uses exact provider/task filtering against the authenticated Rust daemon, not legacy local JSON files. Use `latest.status`, `latest.state`, `latest.result`, `latest.error`, and `jobs` as the source of truth. CLI state preserves actionable daemon error detail; do not confuse it with the extension Settings history, which is intentionally scalar-only.

To cancel a detached job, use its returned job id:

```bash
npx tokenless cancel --job-id "<jobId>" --json
```

Treat cancellation as successful only when the CLI returns `ok: true` and `status: canceled`. On `job_cancel_failed`, tell the user the job may still be running or may already have completed; query `state` instead of claiming cancellation succeeded.

## Provider guidance

- `chatgpt`: general coding, debugging, transformations, multimodal or browser-product reasoning, and fast iteration.
- `claude`: long-form writing, critique, architecture tradeoffs, broad code review, and synthesis-heavy work.
- `gemini`: large-context reading, research-style summarization, Google ecosystem context, and document comparison.
