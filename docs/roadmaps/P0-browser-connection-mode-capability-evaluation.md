# Browser Connection Mode Capability Evaluation

Status: active, implementation and available-capability comparison complete | Priority: P0 | Last reviewed: 2026-08-01

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

The real-provider matrix is declared in `test/live-provider-capability-matrix.json`. `test/run-live-connection-mode-matrix.mjs` runs one continuous journey for each selected provider in `playwright` and `cdp`, sequentially against the explicitly selected setup-managed profile. Each journey executes the provider's required capability cases in declaration order with one stable task ID and one managed page. Every browser inspection barrier asserts the same opaque Chromium target ID, so a hidden page replacement fails the journey. The harness preserves and restores the user's original connection mode and writes a bounded status report under `test-results/live-browser-connection-matrix/`.

The capability cases remain fine-grained sequential subtests for failure attribution and submission budgets; they are steps, not page-allocation boundaries. A failed capability does not suppress later capability evidence on the same page, except when a declared durable provider blocker makes the remaining journey unavailable. A provider journey may navigate the same page from its home surface into a conversation or native Project. Separate providers use separate pages because they have different origins and account state. Separate connection modes use separate browser runs because changing the mode requires daemon/browser restart.

| Provider capability family | Required comparison |
| --- | --- |
| Session readiness and CAPTCHA/blocker handoff | Same account observation, visible blocker result, and user-resolvable handoff behavior |
| Prompt and DOM controls | Same draft, clear, model, effort, and provider-specific mode outcomes |
| File upload | Same visible attachment acceptance from a real file |
| Conversation workflow | Same submissions, responses, citations, continuation, durable mapping, and two-process reuse |
| Native Project workflow | Same create/reuse, instructions, attachment, response, Project identity, and durable mappings |
| Browser/process recovery | Same failure classification and successful reconstruction on the next retry or resume |

The click and upload evidence is deliberately layered. The local Chromium matrix performs real locator clicks, direct `setInputFiles`, and a real button-triggered `filechooser` event. The provider journey then performs the actual provider control clicks and upload action through the built CLI and packaged daemon, and requires the real provider page to show the selected attachment. Neither layer uses fixture routes, interception, or simulated browser objects.

## Test Results

Local real-browser matrix on macOS arm64, 2026-08-01:

- Build: passed.
- Six browser integration cases: passed, three in each connection mode.
- Keychain prompt: none observed.
- Chromium sandbox: no disabling flag added; test-only profile retained both keychain-neutral flags.
- Initial CDP cleanup defect found and fixed: closing the default attached context could leave the owned Chromium process alive. Context closure now enters one idempotent cleanup lane, waits before relaunch, and terminates a non-exiting owned process.
- A CDP history-navigation wait observed the destination URL but did not receive Playwright's expected `load` completion within 30 seconds. Tokenless does not depend on history-back for its navigation contract; the common matrix verifies explicit document navigation. This remains a fidelity difference to monitor rather than a supported-capability failure.

Real-provider comparison used the existing explicitly selected `default` setup-managed profile. The old profile was bound in place to its already configured `system:chrome` runtime through the same validated `ManagedProfileRegistry.bindRuntime` path used by setup. No profile data was imported, copied, reset, or replaced. The harness restored `browserConnectionMode: "playwright"` after every run. No Keychain prompt was observed.

The first full run exposed an E2E evidence defect: the external observer selected the first page with a matching URL, so same-profile tabs could produce false negatives even when the runner action succeeded. The inspection barrier was upgraded to v2 and now carries the runner page's opaque Chromium target ID. The observer requires both exact target ID and canonical URL. After that correction, both modes produced identical non-submission results:

| Non-submission result per mode | `playwright` | `cdp` |
| --- | ---: | ---: |
| Passed | 11 | 11 |
| Failed on current provider/account state | 4 | 4 |
| Allowed Claude Cloudflare skips | 4 | 4 |

The eleven passes in each mode cover ChatGPT readiness, prompt draft/clear, and file selection; Gemini readiness and prompt draft/clear; Grok readiness, prompt draft/clear, and file selection; and Qwen readiness, prompt draft/clear, and effort selection. The four identical failures are Grok model/effort declarations that no longer match the current visible controls and DeepSeek readiness/draft cases blocked by sign-in. Claude's four non-submission cases hit the one declared Cloudflare known-issue skip in both modes.

Mutation results:

- ChatGPT's complete two-turn conversation workflow, including a real attachment, submission, responses, citations, continuation, and durable mapping, passed in native Playwright. The first CDP matrix attempt hit a 15-second submit-control readiness timeout; a manual no-internal-retry CDP rerun of the exact case passed in 126 seconds, comparable to Playwright's 121 seconds. The failure was not reproducible and is treated as provider/attachment readiness variance, not a demonstrated CDP capability loss.
- Gemini workspace response and citation closure passed in both modes.
- Claude conversation workflow failed authentication in both modes.
- Grok conversation workflow failed the same attachment-content postcondition in both modes.
- Qwen mode/workspace failed on the same visible plan/quota blocker in both modes.

Project results were unavailable rather than connection-mode failures. Claude native Project failed authentication in both modes. Grok native Project failed because the create control was not visible in Playwright and because the later CDP run observed sign-in required. Neither mode has current native Project acceptance evidence from this profile.

Current conclusion: CDP did not reduce any locally testable browser capability, produced exact parity across the available real-provider non-submission matrix, and passed the available ChatGPT and Gemini mutation workflows. The evidence is insufficient to change the default because native Project coverage, authenticated Claude/Grok coverage, and a real packaged browser-process crash/reconnect case remain open. Keep `playwright` as the default and `cdp` as an experimental config-only evaluation mode.

Final repository verification built successfully. The expanded parallel `npm test` run reported 72 of 78 passing because one package-contract `prepack` deleted and rebuilt `packages/cli/dist` while six tests in other files tried to execute it; all six failures were missing-artifact or empty-output failures. Re-running the affected package-contract and provider-control files serially after one build passed 16 of 16. The connection-mode browser and daemon cases passed in the complete run. This is a test-orchestration race, not a connection-mode product failure.

The provider E2E was subsequently simplified from one top-level test and implicit page per capability case to one continuous test and exact page target per provider. The obsolete case-level page allocation was removed, signed-in readiness is reused within the journey, and completed observer connections are closed instead of retained until suite teardown. Post-refactor verification passed the six local real-Chromium cases and the complete Gemini non-submission journey in both modes. The target-identity invariant passed across all Gemini steps in each mode. A wider rerun also recorded current external prerequisites independently of connection mode: ChatGPT, Grok, and DeepSeek were signed out in the selected profile, Claude hit its declared Cloudflare blocker, and Qwen DNS resolution failed. A concurrent build removed `dist` during the first unisolated CDP attempt; rebuilding serially and rerunning the focused CDP journey passed.

## Acceptance Criteria

- The configuration default preserves existing production behavior and no operational CLI flag is added.
- Both modes pass build, config filesystem validation, daemon `profiles open`, and the local real-Chromium matrix without Keychain prompts.
- Both modes run every applicable real-provider case without fixtures, interception, retries, or unauthorized profile switching.
- Each provider and connection-mode run uses one stable task/page journey, and every step proves exact Chromium target continuity.
- Results identify capability differences by observable outcome, not by protocol reputation.
- CDP remains experimental until all applicable real-provider gates pass and browser crash/reconnect behavior is proven at the packaged daemon boundary.
- Any later default change is a separate product decision with its own changeset and migration note.

## Lifecycle

Keep this roadmap active until the two-mode real-provider run is complete and a connection-mode decision is recorded. Archive it after the decision, preserving the measured results and linking any follow-up implementation roadmap.
