# Tokenless Privacy Policy

Effective date: 2026-07-20

Tokenless runs locally. It operates visible ChatGPT, Claude, Gemini, and Grok pages through managed Playwright browser profiles and an authenticated local daemon.

## Data handling

- Managed browser profiles, provider sign-in state, configuration, job state, logs, and snapshots remain on the user's device.
- With explicit consent, setup can copy supported ChatGPT, Claude, or Grok sign-in records from an existing Chrome or Brave profile into a separate Tokenless-managed profile. Gemini and shared Google sign-in data are not imported. Passwords, history, bookmarks, payment data, sync data, unrelated site data, and caches are excluded.
- Authentication values stay opaque to agents. Tokenless does not print, log, export, or send them to a Tokenless service.
- Prompt text, selected files, and visible page actions are sent only to the provider chosen by the user. That provider's privacy, retention, and subscription terms apply.
- Prompt text and visible results are stored locally only as needed to execute and report jobs. Raw caller file paths are removed before job submission.
- The local daemon and Playwright worker communicate over authenticated loopback interfaces. Tokenless does not operate a remote service that receives provider-session data.
- Selected files are staged locally, checked for integrity, and uploaded through the provider's visible file control.
- CAPTCHA, sign-in, consent, payment, plan, and confirmation steps remain visible and under user control.

## User control

Profile import requires explicit consent and never changes the source browser profile. Users can inspect managed profiles with `tokenless profiles list`, remove one with `tokenless profiles clear --profile <slug>`, or remove all with `tokenless profiles clear --all`. Removing `~/.tokenless` removes local runtime state.

## Contact

For privacy questions or reports, open an issue at https://github.com/jazelly/tokenless/issues.
