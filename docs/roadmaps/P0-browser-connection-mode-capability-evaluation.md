# Browser Connection Mode Capability Evaluation

Status: active, implementation complete and real-provider comparison pending | Priority: P0 | Last reviewed: 2026-08-01

## Outcome

Determine whether Playwright's native persistent-context connection or `connectOverCDP` is the better Tokenless browser-control boundary by running the same capabilities against both modes. The default remains `playwright` until the evidence supports a separate product decision.

This work protects capability fidelity, not an assumed notion of more realistic clicking. CDP is an opt-in persistent configuration value and is not a per-command CLI flag.

## Configuration Contract

`~/.tokenless/config.json` accepts:

```json
{
  "browserConnectionMode": "playwright"
}
```

The supported values are `playwright` and `cdp`. Omitted values resolve to `playwright` for backward compatibility. The daemon reads the value when it creates its embedded browser runner, so changing it requires the daemon to be restarted. Profiles, browser runtime bindings, visibility policy, provider mappings, and job contracts do not change.

In `cdp` mode Tokenless launches the exact profile-bound Chromium executable with a loopback-only ephemeral DevTools endpoint, connects through Playwright, owns the browser process, and closes or terminates that process during cleanup. Test target `profile` retains `--password-store=basic` and `--use-mock-keychain`; production non-`profile` targets retain their existing launch policy. Chromium sandboxing remains enabled.

## Capability Matrix

The local browser matrix uses a real packaged Playwright build, real local Chromium, filesystem input, a loopback website, real pages, and real browser events. It does not use browser/runtime mocks or synthetic network interception.

| Capability | `playwright` | `cdp` | Evidence boundary |
| --- | --- | --- | --- |
| locator click/fill | Passed | Passed | Real Chromium DOM and visible input value |
| DOM read | Passed | Passed | Real Chromium locator text |
| page navigation | Passed | Passed | Loopback document navigation and URL |
| direct `setInputFiles` | Passed | Passed | Real filesystem file and browser `FileList` |
| file chooser | Passed | Passed | Real `filechooser` event and selected file |
| popup | Passed | Passed | Real popup target and loaded document |
| download | Passed | Passed | Real browser download event and completed transfer |
| clipboard permissions | Passed | Passed | Real browser permission grant and Clipboard API round trip |
| visibility switching | Passed | Passed | Headless context replaced by a headed context |
| context loss/reconstruction | Passed | Passed | Closed real context replaced and logical page key reacquired |
| same-profile multiple tabs | Passed | Passed | Independent real pages and stable logical page-key reuse |

The real-provider matrix is declared in `test/live-provider-capability-matrix.json`. `test/run-live-connection-mode-matrix.mjs` runs every selected provider case once with `playwright` and once with `cdp`, sequentially against the explicitly selected setup-managed profile. It preserves and restores the user's original connection mode and writes a bounded status report under `test-results/live-browser-connection-matrix/`.

| Provider capability family | Required comparison |
| --- | --- |
| Session readiness and CAPTCHA/blocker handoff | Same account observation, visible blocker result, and user-resolvable handoff behavior |
| Prompt and DOM controls | Same draft, clear, model, effort, and provider-specific mode outcomes |
| File upload | Same visible attachment acceptance from a real file |
| Conversation workflow | Same submissions, responses, citations, continuation, durable mapping, and two-process reuse |
| Native Project workflow | Same create/reuse, instructions, attachment, response, Project identity, and durable mappings |
| Browser/process recovery | Same failure classification and successful reconstruction on the next retry or resume |

## Test Results

Local real-browser matrix on macOS arm64, 2026-08-01:

- Build: passed.
- Six browser integration cases: passed, three in each connection mode.
- Keychain prompt: none observed.
- Chromium sandbox: no disabling flag added; test-only profile retained both keychain-neutral flags.
- Initial CDP cleanup defect found and fixed: closing the default attached context could leave the owned Chromium process alive. Context closure now enters one idempotent cleanup lane, waits before relaunch, and terminates a non-exiting owned process.
- A CDP history-navigation wait observed the destination URL but did not receive Playwright's expected `load` completion within 30 seconds. Tokenless does not depend on history-back for its navigation contract; the common matrix verifies explicit document navigation. This remains a fidelity difference to monitor rather than a supported-capability failure.

Real-provider comparison: pending because this checkout does not currently have `TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME` and `TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE` in its environment. It must not be marked passed until the explicitly gated suite completes in both modes.

## Acceptance Criteria

- The configuration default preserves existing production behavior and no operational CLI flag is added.
- Both modes pass build, config filesystem validation, daemon `profiles open`, and the local real-Chromium matrix without Keychain prompts.
- Both modes run every applicable real-provider case without fixtures, interception, retries, or unauthorized profile switching.
- Results identify capability differences by observable outcome, not by protocol reputation.
- CDP remains experimental until all applicable real-provider gates pass and browser crash/reconnect behavior is proven at the packaged daemon boundary.
- Any later default change is a separate product decision with its own changeset and migration note.

## Lifecycle

Keep this roadmap active until the two-mode real-provider run is complete and a connection-mode decision is recorded. Archive it after the decision, preserving the measured results and linking any follow-up implementation roadmap.
