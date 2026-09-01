# Test Helpers

## Live Provider E2E Reports

Every live provider suite writes a private JSON report under `test-results/live-provider-e2e/`. The report groups results by provider, records readiness separately, and then lists every capability as required, unavailable, selected, passed, failed, known issue, or not run. Observable reachability failures use the `network_or_navigation` classification; the report does not infer a firewall, region, or policy cause. Reports contain no DOM, screenshots, storage, credentials, account content, or raw CLI output.

## Real Web UI Provider E2E

The representative Web UI provider test loads the complete Tokenless home named by `TOKENLESS_TEST_HOME` in `.env`, derives its root `config.json`, and uses only the adjacent registry's default profile. Authenticate that profile manually before running:

```bash
npm run test:e2e:web-provider
```

The test submits one real ChatGPT job through that profile, then verifies the completed job in the local Web UI through the same managed browser context. `test/live-web-ui-matrix.json` describes only representative navigation states; home and profile always come from `TOKENLESS_TEST_HOME`.

## Real Provider Website Boundary

Provider selectors, blockers, controls, transitions, and outcomes are developed and verified only through the configured persistent browser profile on the real provider website. The repository does not capture, store, generate, promote, or test against provider DOM fixtures or local provider replicas.

Declare required cases in `test/live-provider-capability-matrix.json`, implement their journeys in `test/live-managed-playwright.e2e.mjs`, and run them through the built CLI and packaged daemon.

## Live Capability Case Isolation

The live capability suite reuses the configured profile, browser process, context, and authentication. Each independent matrix case passes a distinct Page Ref and gets a distinct managed Chromium target.
One explicit test daemon owns the full suite, so separate CLI processes preserve the runtime's Page Ref binding.

Actions and turns inside one case keep the same Page Ref and target. This preserves conversation and native Project continuity without leaking composer, attachment, model, or effort state into the next case.
