# CloakBrowser spike notes

This is a throwaway prototype. Delete it and remove the `prototype:cloakbrowser`
package script after the feasibility question is answered.

## Question

Can Tokenless drive the official no-key CloakBrowser `145.0.7632.109.2` binary
across every declared provider through the production daemon/runner, and can
the same browser launch path reach ordinary Google Search without a CAPTCHA
blocker?

## Scope

- Pins the official `145.0.7632.109.2` release on Linux x64, macOS arm64,
  macOS x64, and Windows x64.
- Rejects Linux arm64 because that exact 145 release has no Linux arm64 asset.
- Uses an isolated runtime cache and a fresh, disposable guest profile.
- Probes ChatGPT, Claude, Gemini, Grok, Qwen, and DeepSeek with real
  `auth.status`, `blocker.check`, `prompt.input`, and conditional
  `prompt.clear` plus `submit-and-read` jobs through the built CLI.
- Uses a separate, isolated Playwright context with the same Cloak binary for
  ordinary Google Search because Google Search is not an authorized Tokenless
  provider origin.
- Does not load `test/live-managed-playwright.e2e.mjs`, create an observer
  Playwright client, or attach an external CDP connection.
- Supports bounded `--observe-google-ms=<milliseconds>` and
  `--observe-ms=<milliseconds>` periods for direct macOS accessibility and
  process inspection.
- Does not touch the user's configured Tokenless home, managed profile,
  Keychain, browser credentials, or browser storage.

## Result

Run on 2026-08-01 on `darwin-arm64` with wrapper `0.5.3` and the official
no-key macOS binary `145.0.7632.109.2`.

### Google Search

- A fresh Cloak context navigated to a normal Google Search for
  `OpenAI API documentation`.
- Google returned HTTP 200 at `/search`; real result links and page navigation
  were visibly rendered.
- No `/sorry/` redirect, reCAPTCHA iframe, unusual-traffic warning, or consent
  blocker appeared. The machine result records `captchaTriggered: false`.
- Direct macOS accessibility observation independently confirmed the visible
  result page.

This proves one ordinary search succeeded without triggering a challenge. It
does not prove that Cloak can solve reCAPTCHA, because no challenge appeared,
and it is not a CAPTCHA-rate measurement.

### Provider sweep

| Provider | Guest result | Conversation result | Visible blocker |
| --- | --- | --- | --- |
| ChatGPT | Guest composer; readiness, draft, and clear succeeded | ChatGPT visibly returned the exact marker, but the durable job failed with `playwright_response_timeout` | None |
| Claude | Signed-out page loaded; readiness returned | Not submitted; `provider_sign_in_required` | Sign-in only; no CAPTCHA or Cloudflare |
| Gemini | Readiness, draft, and clear succeeded | Exact marker response and durable state succeeded | None |
| Grok | Homepage, guest composer, model selector, and attachment control rendered | Not submitted; runtime returned `provider_sign_in_required` | Sign-in only; no CAPTCHA or Cloudflare |
| Qwen | Guest composer; readiness, draft, and clear succeeded | Exact marker response and durable state succeeded | None |
| DeepSeek | Signed-out page loaded; readiness returned | Not submitted; `provider_sign_in_required` | Sign-in only; no CAPTCHA |

Grok also exposed a transient navigation race during its prompt action:
`page.evaluate: Execution context was destroyed, most likely because of a
navigation`. The final CLI handoff was the expected sign-in requirement. This
is a runtime timing issue to qualify with a signed-in Cloak profile, not a
fingerprint or CAPTCHA block.

### Runtime evidence

- The binary launched and reported `Chromium 145.0.7632.109`.
- The current dirty worktree built successfully.
- All six provider origins were reached through the production Tokenless
  daemon/runner and its own `playwright-core` persistent context.
- The browser used `--remote-debugging-pipe`; renderer processes carried a
  generated Cloak `--fingerprint` value.
- Test-only `--password-store=basic` and `--use-mock-keychain` flags remained
  present, Chromium sandboxing remained enabled, and no Keychain prompt
  appeared.
- No CAPTCHA was observed on Google Search or any of the six provider pages.
- Direct observation confirmed the exact ChatGPT, Gemini, and Qwen marker
  responses, plus the real Grok, Claude, and DeepSeek signed-out surfaces.
- The disposable Google context, Tokenless daemon, runner, browser, and guest
  profile were removed after the observation period.

## Verdict and next boundary

CloakBrowser 145 is compatible with Tokenless's production Playwright runtime
on macOS arm64 across all six declared provider origins. Gemini and Qwen passed
the complete guest submit/read/durable-state loop. ChatGPT completed visibly
but revealed a response-completion detector issue. Claude, Grok, and DeepSeek
reached their real pages without an anti-bot challenge but require a signed-in
profile for conversation acceptance.

The user's existing managed profile was imported from Chrome 150, while this
Cloak build is Chromium 145. Opening that profile in place would risk profile
schema mutation; copying it would violate browser-secret handling rules.
Signed-in acceptance should therefore use a dedicated Cloak-managed profile
that the user signs into manually. Linux and Windows still require native
execution tests even though exact 145 download assets exist.

The machine-readable result is written to
`test-results/cloakbrowser-spike/last-run.json`.
