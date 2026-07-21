---
name: tokenless
description: Route shareable Q&A, analysis, review, research, writing, and file-based tasks through a user's visible ChatGPT, Claude, Gemini, or Grok website using Tokenless Playwright automation to save API tokens.
---

# Tokenless agent workflow

Use `tokenless` as the entrypoint. Do not reproduce provider-specific Playwright or DOM work yourself.

Tokenless sends visible jobs through its authenticated local Rust daemon and Playwright worker into a persistent managed Chromium profile selected during `tokenless setup`. Keep provider authentication opaque inside that profile, operate only visible page controls, and use only documented public APIs when the caller explicitly selects direct mode.

## Installation prerequisite

Require the `tokenless-install` skill to finish setup, upgrades, repairs, and `doctor` verification before provider work. If the CLI, daemon, Playwright worker, configured browser, managed profile, or visible provider session is not ready, use `tokenless-install`; do not improvise installation or weaken a failed check.

## Resolve provider and profile

```bash
tokenless config --json
tokenless profiles list --json
```

Use an explicitly requested provider and profile first, then configured defaults. ChatGPT is the provider default. Fail before submitting work if no managed profile resolves; use `tokenless-install` to repair it.

Before the first job for a chosen pair, confirm readiness:

```bash
tokenless profiles status --profile "<managed-profile>" --provider chatgpt --json
```

If status shows unauthenticated or blocked readiness, hand off to `tokenless-install` instead of submitting a job.

## Build only shareable context

Create a prompt file when the request needs structured context:

```bash
tokenless \
  --project-root "/absolute/path/to/project" \
  --project-name "<agent project name>" \
  --chat-name "<agent task name>" \
  --prompt "<user request>" \
  --file <relative-shareable-file> \
  --output /tmp/tokenless-prompt.md
```

Include only the request, explicit shareable context, and intentionally selected files. Never include hidden reasoning, credentials, cookies, browser storage, private headers, unrelated private files, or secrets.

## Run through the visible provider website

```bash
tokenless run \
  --profile "<managed-profile>" \
  --provider chatgpt \
  --project-name "<agent project name>" \
  --chat-name "<agent task name>" \
  --project-root "/absolute/path/to/project" \
  --prompt-file /tmp/tokenless-prompt.md \
  --json
```

Repeat `--attach-file <path>` only for files the user intends to share. Tokenless stages regular files privately, verifies integrity, uploads through the visible page control, and keeps raw local paths out of daemon job results.

Use `provider-controls` to discover exact visible labels before requesting a model or effort setting:

```bash
tokenless provider-controls --profile "<managed-profile>" --provider chatgpt --json
```

Pass only an exact returned label with `--model`, ordered `--model-fallback`, or `--effort`. If a requested control or action is unsupported or unverified, surface the failure; do not guess or silently change providers or modes.

For work expected to exceed three minutes, keep the daemon job attached and add `--long-running`. Do not use `--no-wait`, do not replace the web task with a local agent run, and do not claim a result before the daemon reports `succeeded`.

Retain the returned `jobId` and `taskId`, and pass `--task-id "<taskId>"` on later turns for the same task. Continue waiting while a run reports `queued`, `claimed`, `running`, or `daemon_waiting`. If it reports `waiting_for_user`, stop the agent task immediately: tell the user to complete the visible verification or sign-in in the already-open managed browser window, keep the same `jobId`/`taskId`, never retry, reimport, resubmit, or create a replacement job, and query the same task only after the user confirms. Do not claim completion until the daemon reports `succeeded`. Stop on `failed`, `canceled`, `timed_out`, `blocked`, or `ui_mismatch` and report the exact visible blocker.

If sign-in, CAPTCHA, plan limits, consent, or confirmation requires the user, state the completed work, exact visible action, and next verification in the user's preferred language. Never request credentials or browser state.

## Query daemon-backed state

```bash
tokenless state --task-id "<returned taskId>" --json
```

Use `latest.status`, `latest.state`, `latest.result`, `latest.error`, and `jobs` as the source of truth. State comes from the authenticated Rust daemon, not a local task-page or JSON fallback.

Cancel only through daemon-confirmed cancellation:

```bash
tokenless cancel --job-id "<jobId>" --json
```

Treat cancellation as complete only when the CLI returns `ok: true` and `status: canceled`. On `job_cancel_failed`, say that the job may still be running or may already have completed, then query `state`.

## Provider guidance

- `chatgpt`: coding, debugging, transformations, multimodal work, and fast iteration.
- `claude`: long-form writing, critique, architecture tradeoffs, code review, and synthesis.
- `gemini`: large-context reading, research summaries, Google ecosystem context, and document comparison.
- `grok`: current-event synthesis, concise exploration, and Grok-native web workflows.
