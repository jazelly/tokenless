# Tokenless Privacy Policy

Effective date: 2026-07-20

Tokenless runs locally. It operates visible ChatGPT, Claude, Gemini, Grok, and experimental Qwen pages through managed Playwright browser profiles and an authenticated local daemon.

## Data handling

- Managed browser profiles, provider sign-in state, configuration, job state, logs, and snapshots remain on the user's device.
- Setup does not copy or import browser profiles. In native mode, browser state and credentials remain in the running Google Chrome or Brave Browser selected by the user.
- Authentication values stay opaque to agents. Tokenless does not print, log, export, or send them to a Tokenless service.
- Browser visibility settings (`auto`, `headed`, and `headless`) only change how the local managed browser is presented. They do not disable Chromium sandboxing, and they keep the same local daemon and managed profile flow.
- Prompt text, selected files, and visible page actions are sent only to the provider chosen by the user. That provider's privacy, retention, and subscription terms apply.
- Prompt text and visible results are stored locally only as needed to execute and report jobs. Raw caller file paths are removed before job submission.
- The local daemon and Playwright worker communicate over authenticated loopback interfaces. Tokenless does not operate a remote service that receives provider-session data.
- Selected files are staged locally, checked for integrity, and uploaded through the provider's visible file control.
- CAPTCHA, sign-in, consent, payment, plan, and confirmation steps remain visible and under user control.

## User control

Users can inspect logical Tokenless profiles with `tokenless profiles list`, remove one with `tokenless profiles clear --profile <slug>`, or remove all with `tokenless profiles clear --all`. These commands do not remove or modify the selected Chrome or Brave browser profile. Removing `~/.tokenless` removes local Tokenless runtime state.

## Contact

For privacy questions or reports, open an issue at https://github.com/jazelly/tokenless/issues.
