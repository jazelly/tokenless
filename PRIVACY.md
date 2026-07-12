# Tokenless Privacy Policy

Effective date: 2026-07-11

Tokenless connects a local command-line tool to browser sessions that a user has already authorized. It is designed to operate through visible provider pages such as ChatGPT, Claude, and Gemini.

## Data handling

- Tokenless does not collect or transmit provider cookies, browser storage tokens, hidden authorization headers, or private provider API requests.
- The extension interacts only with the visible page DOM after the user grants the listed host permissions.
- Prompt text and visible results are stored locally in the user's Tokenless home only as needed to run and report a daemon-backed job. Prompt bodies and claim tokens are not exposed in extension history.
- The Rust daemon listens only on loopback. The native host and extension communicate through Chrome Native Messaging on the user's device.
- Tokenless does not operate a remote service that receives provider-session data. An optional relay, if separately configured by a user, cannot control a browser and is outside this local visible-session flow.

## User control

Users can disable or remove the browser extension at any time. Removing `~/.tokenless` removes the local Tokenless runtime state, including its daemon database, configuration, logs, and snapshots.

## Contact

For privacy questions or reports, open an issue at https://github.com/jazelly/tokenless/issues.
