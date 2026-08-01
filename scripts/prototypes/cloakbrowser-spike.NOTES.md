# CloakBrowser spike notes

This is a throwaway prototype. Delete it and remove the `prototype:cloakbrowser`
package script after the feasibility question is answered.

## Question

Can Tokenless drive the official no-key CloakBrowser legacy binary through the
existing test-only executable seam and pass real, non-submission provider E2E
checks without changing the production browser runtime?

## Scope

- Uses the official platform-specific no-key legacy binary.
- Uses an isolated runtime cache and a fresh, disposable Tokenless profile.
- Runs only Gemini guest `session-readiness` and `prompt-draft` cases.
- Does not submit a prompt or mutate provider-side state.
- Does not touch the user's configured Tokenless home or managed profiles.

## Result

Run on 2026-08-01 on `darwin-arm64` with wrapper `0.5.3` and the official
no-key macOS binary `145.0.7632.109.2`.

Passed:

- Official download completed and its Ed25519 signature and SHA-256 checksum
  were verified by the wrapper.
- The binary launched and reported `Chromium 145.0.7632.109`.
- The current dirty worktree built successfully.
- The normal Tokenless Playwright path completed real Gemini `auth.status`,
  `blocker.check`, `prompt.input`, and `prompt.clear` actions.
- Gemini reported no visible blocker; the unique draft became visible and was
  cleared without submission.

Failed:

- The repository's headed macOS E2E observer path did not reach a usable CDP
  attachment. One run connected its WebSocket but timed out during Playwright
  attachment; later runs timed out waiting for `DevToolsActivePort`.
- Consequently, the existing `session-readiness` and `prompt-draft` E2E cases
  did not pass, even though their underlying normal-path provider actions did.

Control run with the configured stock Chrome and the existing `default`
managed profile:

- `session-readiness` passed, proving that the current macOS background/CDP
  observer can attach to stock Chrome in this worktree.
- `prompt-draft` reached the observer but failed its unique-draft visibility
  assertion. That is a later assertion failure than CloakBrowser's launch/CDP
  failure and may reflect the existing dirty worktree or current Gemini DOM.

Verdict: the CloakBrowser binary works through Tokenless's normal Playwright
execution path. The current macOS `/usr/bin/open` plus CDP observer seam is not
compatible with this legacy build and must be qualified separately. This run
does not establish a CAPTCHA-rate improvement or signed-in provider support.

The machine-readable result is written to
`test-results/cloakbrowser-spike/last-run.json`.
