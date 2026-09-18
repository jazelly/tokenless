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

The live capability suite reuses the configured profile, browser process, context, and authentication. Each independent matrix case passes a distinct Page Ref and gets a distinct managed Chromium target; the API also permits concurrent callers to reuse one Page Ref without a busy rejection.
One explicit test daemon owns the full suite, so separate CLI processes preserve the runtime's Page Ref binding. The Tokenless Harness remains responsible for sequencing turns that share one conversation, while runtime detach leaves resident provider tabs available for a later binding.

Actions and turns inside one case keep the same Page Ref and target. This preserves conversation and native Project continuity without leaking composer, attachment, model, or effort state into the next case.

## Idle Tab Collection

After building the CLI, run the focused acceptance through ego-browser with the configured persistent profile. The lifecycle check uses production page allocation and collection; the conversation check sends three real ChatGPT turns and verifies the original conversation survives tab closure. It does not change the selected test home's configuration.

```bash
ego-browser nodejs <<'EOF'
const repo = '/absolute/path/to/tokenless'
const nodeExecutable = '/absolute/path/to/node'
const packageRoot = repo + '/packages/cli'
const { verifyTabGcLifecycle, verifyTabGcConversation } = await import(repo + '/test/live-browser-tab-gc.e2e.mjs')
await verifyTabGcLifecycle({ packageRoot, log: cliLog })
await verifyTabGcConversation({ packageRoot, nodeExecutable, log: cliLog })
EOF
```

Replace the two absolute paths above with the checkout and system Node executable. Keep the same packaged daemon running throughout the conversation check. With default settings, allow about eight minutes for both checks; observations use the configured retention and sweep intervals without shortening them.

The multi-profile/restart acceptance is explicitly scoped to the user's existing registered profiles and requires at least two signed-in ChatGPT profiles. It checks automatic attachment, persisted target identity across a daemon restart, an unsent draft surviving the complete retention window, an idle-clock reset after reloading the same URL, subsequent collection after clearing the draft, and continuation in the second profile after collection. It never creates a profile or relaunches a browser.

Invoke `verifyTabSupervision({ packageRoot, nodeExecutable, log: cliLog })` from the same ego-browser runtime. An optional `residentBaseline` containing freshly observed profile names and target IDs can additionally verify collection of the exact idle tabs left by an earlier daemon; these IDs are live observations, not provider fixtures.
