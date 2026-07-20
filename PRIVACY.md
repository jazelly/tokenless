# Tokenless Privacy Policy

Effective date: 2026-07-20

Tokenless runs locally. Managed web mode operates visible ChatGPT, Claude, Gemini, and Grok pages through Playwright. Opt-in direct mode uses a provider-owned client, a documented public provider API, or an explicitly configured compatible gateway.

## Data handling

- Managed browser profiles, provider sign-in state, configuration, job state, logs, and snapshots remain on the user's device.
- With explicit consent, setup can copy selected ChatGPT, Claude, or Grok sign-in records from an existing Chrome or Brave profile into a separate Tokenless-managed profile. Gemini and shared Google sign-in data are not imported. Passwords, history, bookmarks, payment data, sync data, unrelated site data, and caches are excluded.
- Authentication values stay opaque to agents. Tokenless does not print, log, export, or send them to a Tokenless service.
- Prompt text, selected files, and visible page actions are sent only to the provider chosen by the user. That provider's privacy, retention, and subscription terms apply.
- Prompt text and visible results are stored locally only as needed to execute and report jobs. Raw caller file paths are removed before job submission.
- The local daemon and Playwright worker communicate over authenticated loopback interfaces. Tokenless does not operate a remote service that receives provider-session data.
- Selected files are staged locally, checked for integrity, and uploaded through the provider's visible file control.
- CAPTCHA, sign-in, consent, payment, plan, and confirmation steps remain visible and under user control.
- Direct API credentials are read only from the current process environment and are not persisted in Tokenless configuration, managed profiles, or job state.
- In the ChatGPT official-client backend, Codex owns authentication and transport. Tokenless does not read the Codex credential store.
- A direct API request sends its prompt and parameters to the selected provider or compatible gateway. That operator's privacy, logging, retention, and billing terms apply; API usage may be billed separately from a web subscription.
- The authenticated direct broker binds only to loopback, removes inbound provider credentials and cookies, injects an environment-supplied outbound credential, and forwards only allowlisted public inference routes.

## User control

Profile import requires explicit consent and never changes the source browser profile. Users can inspect managed profiles with `tokenless profiles list`, remove one with `tokenless profiles clear --profile <slug>`, or remove all with `tokenless profiles clear --all`. Removing `~/.tokenless` removes local runtime state. Direct API credentials are removed by unsetting their environment variables.

## Contact

For privacy questions or reports, open an issue at https://github.com/jazelly/tokenless/issues.
