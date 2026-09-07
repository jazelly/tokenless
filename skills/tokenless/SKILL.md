---
name: tokenless
description: Use when a task can be delegated through the globally installed Tokenless CLI without directly writing to the workspace; route it to a visible AI provider website to save agent tokens.
---

# Tokenless agent workflow

Require the globally installed `tokenless` command on `PATH` and use it as the entrypoint. Never invoke Tokenless through `npx tokenless` or `npx tokenless@latest`. Do not reproduce provider-specific Playwright or DOM work yourself.

If `tokenless` is missing from `PATH` or cannot be executed, stop before provider work and tell the user to install it globally:

```bash
npm install --global tokenless@latest
```

Do not install it on the user's behalf unless the user explicitly asks for installation. Do not substitute `npx`. After the user confirms installation, use `tokenless setup` for first-time onboarding or `tokenless upgrade --json` for maintenance.

Tokenless sends visible jobs through its authenticated local TypeScript daemon and Playwright worker into a user-configured persistent managed Chromium profile. Keep provider authentication opaque inside that profile, operate only visible page controls, and use only documented Tokenless CLI or local API surfaces.

You MUST not initiate installation, onboarding, profile creation, or profile import before provider work.

## Resolve provider and profile

```bash
tokenless config --json
tokenless profiles list --json
```

Use an explicitly requested provider and profile first, then configured defaults. ChatGPT is the provider default. Fail before submitting work if no managed profile resolves, and tell the user that they must initialize one manually before retrying. Do not create or import a profile on the user's behalf.

Do not run an authentication-status check before provider work. Providers may expose usable free or anonymous prompt controls without an authenticated account. Let the visible `prompt.input` and `prompt.submit` actions establish readiness by waiting for their controls directly.

## Build only shareable context

Create a prompt file when the request needs structured context:

```bash
tokenless \
  --project-root "/absolute/path/to/project" \
  --prompt "<user request>" \
  --file <relative-shareable-file> \
  --output /tmp/tokenless-prompt.md
```

When no native hook binding exists, add `--project-name` and `--chat-name` as explicit display metadata. In a hook-bound session, omit them so the later run uses the hook-owned project and conversation identity.

Include only the request, explicit shareable context, and intentionally selected files. Never include hidden reasoning, credentials, cookies, browser storage, private headers, unrelated private files, or secrets.

## Run through the visible provider website

When `TOKENLESS_CONTEXT_BINDING_ID` is present, the native Agent hook already supplies the exact Agent chat, turn, tool call, Tokenless project, conversation, and stable provider task identity. Do not pass or invent `--agent-kind`, `--agent-session-id`, `--task-id`, `--project-name`, or `--chat-name`; the Tokenless CLI applies the hook-owned values and rejects a conflicting task id.

```bash
tokenless run \
  --profile "<managed-profile>" \
  --provider chatgpt \
  --project-root "/absolute/path/to/project" \
  --prompt-file /tmp/tokenless-prompt.md \
  --json
```

Only callers without a native Tokenless binding should add explicit `--agent-kind`, `--agent-session-id`, `--project-name`, and `--chat-name`. Such callers retain the returned `taskId` and pass `--task-id` on later turns. Never reconstruct these values from a chat title, recent file, or guessed session.

Omit `--browser-visibility` in ordinary jobs so the configured default applies. Pass it only when the user explicitly asks for a different visibility policy on this job. If a run parks with `waiting_for_user`, keep the same `jobId`/`taskId` and resume the same daemon job with headed visibility instead of resubmitting it.

Repeat `--attach-file <path>` only for files the user intends to share. Tokenless stages regular files privately, verifies integrity, uploads through the visible page control, and keeps raw local paths out of daemon job results.

File results distinguish `selected` from `accepted`. Treat only `accepted` as provider-visible attachment proof; `selected` means the local chooser or hidden file input received the file but the real provider website did not show the required visible acknowledgement.

`--project-name` remains task metadata unless the user explicitly requests Workspace behavior. For the experimental provider-neutral Workspace flow, pass one of:

```bash
tokenless run --project-name "<name>" --workspace-mode auto ...
tokenless run --project-name "<name>" --workspace-mode native ...
tokenless run --project-name "<name>" --workspace-mode conversation ...
```

`auto` may report a conversation fallback, `native` fails when real-provider E2E has not proven native creation, and `conversation` requests the conversation strategy. Never describe a conversation fallback as a native provider Project. Inspect the current full capability map with `tokenless provider-action --action capability.inspect --provider <provider> --json`.

Use `provider-controls` to discover exact visible labels before requesting a model or effort setting:

```bash
tokenless provider-controls --profile "<managed-profile>" --provider chatgpt --json
```

Pass only an exact returned label with `--model` or `--effort`. If a requested control or action is unsupported or unverified, surface the failure; do not guess or silently change providers or modes.

For work expected to exceed three minutes, keep the daemon job attached and add `--long-running`. Do not use `--no-wait`, do not replace the web task with a local agent run, and do not claim a result before the daemon reports `succeeded`.

Retain the returned `jobId` and `taskId`. In a hook-bound Agent session, later invocations receive that stable task identity automatically. In an unbound session, pass `--task-id "<taskId>"` on later turns for the same task. Continue waiting while a run reports `queued`, `claimed`, `running`, or `daemon_waiting`. If it reports `waiting_for_user`, stop the agent task immediately and inspect `blocker.browser.windowOpen`: when true, tell the user to complete the visible verification or sign-in in the already-open managed browser window, keep the same `jobId`/`taskId`, and query the same task only after the user confirms; when false, run `tokenless resume --job-id "<jobId>" --browser-visibility headed --json` for that exact job, then complete the opened visible browser handoff; never retry, reimport, resubmit, or create a replacement job. Do not claim completion until the daemon reports `succeeded`. Stop on `failed`, `canceled`, `timed_out`, `blocked`, or `ui_mismatch` and report the exact visible blocker.

If a run fails with `prompt_input_visibility_timeout` or `prompt_submit_visibility_timeout`, report which visible control did not appear within the bounded wait. Do not reinterpret that result as proof that authentication is required. If it fails with `prompt_input_failed` or `prompt_submit_failed`, report that the control appeared but the visible input or click operation failed.

If sign-in, CAPTCHA, plan limits, consent, or confirmation requires the user, state the completed work, exact visible action, and next verification in the user's preferred language. Never request credentials or browser state.

Use `profiles open` only for headed browser handoff. It always opens a visible browser window.

## Recover after an agent restart

Native Tokenless hooks own stable Agent identity when `TOKENLESS_CONTEXT_BINDING_ID` is present; keep their environment unchanged for the invocation. For unbound callers, keep one stable `agent kind` and `agent session id` for the lifetime of an agent session. Pass both flags on addressed jobs, or set `TOKENLESS_AGENT_KIND` and `TOKENLESS_AGENT_SESSION_ID` so `run`, `state`, `resume`, `cancel`, and replay use the same recipient.

After the agent process restarts, drain previously unseen outcome summaries once:

```bash
tokenless replay \
  --agent-kind "<agent kind>" \
  --agent-session-id "<stable agent session id>" \
  --json
```

Tokenless probes or starts its local daemon on demand. Replay is deliberately at-most-once per actionable outcome revision: SQLite marks the revision reported before the CLI returns it, without waiting for an agent acknowledgement. Never expect the same revision to be proactively reported again. A later parked or terminal revision of the same job may be reported once as a new outcome.

Replay contains only job identity, status, timestamps, and result/error/blocker availability flags. It never contains the full outcome. Retrieve durable full state only when useful:

```bash
tokenless state --job-id "<jobId>" --json
```

The full job remains in SQLite even after its summary is reported. If a replay response was lost, query a known `jobId` or `taskId`; do not create a replacement job solely to recover the result. Attached commands with the same agent identity record delivery at the CLI boundary automatically, so already returned outcomes do not later appear as unseen replay.

## Query daemon-backed state

```bash
tokenless state --task-id "<returned taskId>" --json
```

Use `latest.status`, `latest.state`, `latest.result`, `latest.error`, and `jobs` as the source of truth. State comes from the authenticated local daemon, not a local task-page or JSON fallback.

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
