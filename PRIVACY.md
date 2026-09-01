# Tokenless Privacy Policy

Effective date: 2026-08-11

Tokenless runs locally. It operates visible ChatGPT, Claude, Gemini, Grok, and experimental Qwen pages through managed Playwright browser profiles and an authenticated local daemon.

## Data handling

- Managed browser profiles, provider sign-in state, configuration, job state, logs, and snapshots remain on the user's device.
- Setup does not copy or import complete browser profiles. In the current visible-browser mode, browser state and credentials remain in the running Google Chrome or Brave Browser selected by the user.
- A direct provider-protocol mode, when available and explicitly enabled, may acquire the required provider session values from the selected live browser or CDP session, a user-supplied HAR, the selected browser's Cookie database, manually supplied cookies or tokens, and required browser storage. Access is local and limited to the provider and auth source explicitly selected by the user.
- When an import or save auth source is available, it requires explicit user action to persist a HAR, cookies, or tokens locally. Tokenless does not import or persist session values without that choice; each auth source is identified as ephemeral or user-persisted.
- On macOS, explicit direct mode may read only the browser encryption material required to decrypt the selected provider's cookies, including through the necessary OS or Keychain API. Tokenless does not read passwords, unrelated Keychain items, or credentials for another provider, account, or profile.
- The explicitly selected local direct adapter or sidecar may receive the minimum provider session values it needs in process memory, but it does not log, independently persist, or return them. Tokenless does not print those values to stdout or stderr; include them in logs, errors, telemetry, jobs, checkpoints, or UI responses; expose them to agents or web models; or send them to a Tokenless-operated remote service or any unrelated service. The selected provider receives only the values required to authenticate its own requests.
- Browser visibility settings (`auto`, `headed`, and `headless`) only change how the local managed browser is presented. They do not disable Chromium sandboxing, and they keep the same local daemon and managed profile flow.
- Prompt text, selected files, and visible page actions are sent only to the provider chosen by the user. That provider's privacy, retention, and subscription terms apply.
- Prompt text and visible results are stored locally only as needed to execute and report jobs. Raw caller file paths are removed before job submission.
- The local daemon and Playwright worker communicate over authenticated loopback interfaces. Tokenless does not operate a remote service that receives provider-session data.
- Selected files are staged locally, checked for integrity, and uploaded through the provider's visible file control.
- CAPTCHA, sign-in, payment, plan, and ambiguous or external confirmation steps remain visible and under user control. For a provider the user has selected, a provider adapter may automatically accept an exact, known onboarding Terms/Privacy dialog required to use that provider.

## User control

Users can inspect logical Tokenless profiles with `tokenless profiles list`, remove one with `tokenless profiles clear --profile <slug>`, or remove all with `tokenless profiles clear --all`. These commands do not remove or modify the selected Chrome or Brave browser profile. Removing `~/.tokenless` removes local Tokenless runtime state.

## Contact

For privacy questions or reports, open an issue at https://github.com/jazelly/tokenless/issues.
