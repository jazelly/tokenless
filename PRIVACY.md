# Tokenless Privacy Policy

Effective date: 2026-07-15

Tokenless offers two separate local transports. Visible mode connects the command-line tool to browser sessions that a user has already authorized and operates through visible provider pages such as ChatGPT, Claude, Gemini, and Grok. Opt-in direct mode delegates to the provider-owned Codex executable or sends requests to a documented public provider API or an explicitly configured compatible gateway.

## Data handling

- Tokenless does not collect or transmit provider cookies, browser storage tokens, hidden authorization headers, or private provider API requests.
- The extension reads only the visible page DOM after the user grants the listed host permissions. For visible ChatGPT model and Intelligence controls that require a trusted user gesture, it may use Chrome's debugger permission only to send one bounded mouse press and release to the validated active control, then immediately detach. It does not use debugger access to inspect network traffic, browser storage, hidden page state, or provider secrets.
- Prompt text and visible results are stored locally in the user's Tokenless home only as needed to run and report a daemon-backed job. Prompt bodies and claim tokens are not exposed in extension history.
- The Rust daemon listens only on loopback. The native host and extension communicate through Chrome Native Messaging on the user's device.
- Direct API credentials are read only from the current process environment. Tokenless does not persist them in configuration, the daemon database, browser storage, or job state.
- In the ChatGPT official-client backend, Codex owns its authentication and transport. Tokenless does not read the Codex credential store. Codex can load user-authored `$CODEX_HOME/AGENTS.override.md` or `$CODEX_HOME/AGENTS.md` global instructions and send them with the prompt; Tokenless does not open or parse those files.
- A direct API request sends the prompt and request parameters to the selected public provider or compatible gateway. That operator's privacy, logging, retention, and billing terms apply. Provider API usage can be billed separately from a web subscription.
- The authenticated local direct broker binds only to loopback, removes inbound provider credentials and cookies, injects an environment-supplied outbound credential, and streams only allowlisted public inference routes. It does not expose provider or gateway private, administration, account, OAuth, payment, quota, or usage APIs.
- Broker request bodies are opaque streaming data. Tokenless does not parse or log their prompts and does not inject `store: false`; the caller controls provider-supported storage fields and the upstream controls its retention policy. Normalized `tokenless run --mode direct` adapters set documented storage opt-outs where supported.
- Tokenless does not operate a remote service that receives provider-session data.

## User control

Users can disable or remove the browser extension at any time. Removing `~/.tokenless` removes the local visible-mode runtime state, including its daemon database, configuration, logs, and snapshots. Direct API credentials are not stored there; unset their environment variables separately. Stop the direct broker with `SIGINT` or `SIGTERM` to close its listener and outstanding upstream work.

## Contact

For privacy questions or reports, open an issue at https://github.com/jazelly/tokenless/issues.
