# Tokenless Architecture

Tokenless has five independent surfaces:

1. Browser extension: owns provider-tab automation through visible DOM.
2. Web client: lets a web app submit relay requests without knowing transport details.
3. Relay: accepts webapp requests and returns relay jobs/results.
4. Tokenless CLI: runs on the user's machine and can collect local project context before invoking Tokenless.
5. Adapter protocol: keeps Codex, Claude Code, Antigravity, and Noop integrations optional.

## Data Flow

```text
Web app
  -> tokenless-client
  -> tokenless-relay /v1/runs
  -> extension client request
  -> browser extension background worker
  -> provider tab content script
  -> visible provider UI
  -> provider response text
  -> relay result
```

Local agent flow:

```text
Agent prompt
  -> agent skill thin wrapper
  -> tokenless run
  -> local job request at ~/.tokenless/jobs/<jobId>.request.json
  -> extension task page opened in the user's browser
  -> native messaging host claims job and reports state
  -> extension background opens or reuses provider tab
  -> content script submits prompt through visible DOM
  -> content script reads visible answer through visible DOM
  -> native messaging host writes ~/.tokenless/jobs/<jobId>.result.json
  -> compact result for the agent
```

## Boundaries

The Tokenless Relay cannot directly control a user's browser. It can create and track jobs, enforce policy, and speak the Tokenless protocol. Browser control still requires an installed extension in the user's browser or a local runtime that can reach that extension.

The Tokenless CLI can read local project files only when the user runs it locally and passes an explicit project root. It must redact obvious secrets before building prompt context and must not send hidden agent reasoning.

The local job store is nonce-bound and stateful. Jobs move through `queued`, `claimed`, `running`, `needs_user`, `succeeded`, `failed`, `canceled`, or `timed_out`. Writers use atomic JSON writes so the CLI, extension task page, and native host can recover cleanly from crashes.

The extension task page exists because MV3 background workers are not persistent and the CLI cannot directly wake an extension. Opening `task.html` gives the extension a live page that can connect to the native messaging host and start the provider workflow.

Provider adapters for ChatGPT, Gemini, and Claude operate only through visible DOM selectors on user-visible pages. They must report login, CAPTCHA, selector drift, rate limits, and other visible blockers instead of reading cookies, local/session storage tokens, hidden auth headers, or private provider APIs.
