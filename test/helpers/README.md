# Test Helpers

## Live Provider E2E Reports

Every live provider suite writes a private JSON report under `test-results/live-provider-e2e/`. The report groups results by provider, records readiness separately, and then lists every capability as required, unavailable, selected, passed, failed, known issue, or not run. Observable reachability failures use the `network_or_navigation` classification; the report does not infer a firewall, region, or policy cause. Reports contain no DOM, screenshots, storage, credentials, account content, or raw CLI output.

## Real Web UI Provider E2E

The representative Web UI provider test reuses the dedicated live-provider harness and its Cloak-bound `live-provider-cloak` profile. Prepare that profile and authenticate manually before running:

```bash
npm run test:e2e:prepare -- --browser cloak
npm run test:e2e:web-provider
```

The test submits one real ChatGPT job through the dedicated profile, then verifies the completed job in the local Web UI using the same managed browser context. It does not use a local configuration-combination fixture.

## Capture Provider DOM With CDP

Use `capture-provider-dom-cdp.mjs` to capture a sanitized DOM snapshot from a real provider page in a dedicated Chrome profile with the Chrome DevTools Protocol enabled. The helper supports `chatgpt`, `claude`, `gemini`, `grok`, `qwen`, and `deepseek` through one provider-definition table. Each definition owns its allowed origin, launch URL, selector probes, and DOM artifact name.

Start a dedicated Chrome profile at the provider page you want to inspect. For example, for Claude:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tokenless-cdp-chrome-profile \
  https://claude.ai/new
```

Sign in manually in that Chrome window if needed, then capture the page:

```bash
node test/helpers/capture-provider-dom-cdp.mjs --provider claude
```

The accepted provider values and default pages are:

| Provider | Page |
| --- | --- |
| `chatgpt` | `https://chatgpt.com/` |
| `claude` | `https://claude.ai/new` |
| `gemini` | `https://gemini.google.com/app` |
| `grok` | `https://grok.com/` |
| `qwen` | `https://chat.qwen.ai/` |

Artifacts are written under `test-results/<provider>-dom-captures/<timestamp>/`:

- `<provider>-dom.sanitized.html`
- `selector-probes.json`
- `metadata.json`
- `visible-text.txt` only when `--include-text` is passed

`metadata.json` identifies the `provider`, the `visible-session-web-ui` surface, and `capturedAt`. Page query strings, fragments, and opaque conversation, Gem, Project, or custom-agent path identifiers are omitted or replaced with `[redacted]`. DOM attributes are denied by default: the sanitizer retains only fixed structural states and static values or fragments required by the selected provider's selector probes. Arbitrary `id`, `class`, `name`, ARIA, and `data-*` values are removed, while URL attributes are reduced to safe static paths or redacted markers. Form values, hidden inputs, executable/resource elements, comments, and non-visible text are sanitized or removed before output. Selector probes never include page text unless `--include-text` is explicitly passed; even then, only text visible in the viewport is retained, and `--max-text-chars` bounds every exported text field, including the DOM snapshot, visible-text artifact, page title, and selector probe samples.

The helper does not read or export provider cookies, localStorage, sessionStorage, hidden authentication headers, or private provider backend APIs. It evaluates read-only page JavaScript through CDP and writes only the sanitized DOM, probes, and metadata described above. Use a dedicated capture profile and inspect every artifact before promoting it into a test fixture.

Promoted regression evidence lives under `test/fixtures/provider-dom/<provider>/<account-state>/`. Its machine-readable v2 `manifest.json` lists each HTML/provenance pair with the provider, sanitized page URL, route class, account state, capture date, scenario, operation phase, and capability outcome. A ready menu, input, or form does not imply that a later provider mutation succeeded; only a captured success postcondition may record that outcome.

The authenticated deep-workflow reductions are maintained by:

```bash
npm run fixtures:build
```

That helper rewrites the reduced workflow fixtures, recalculates their provenance digests, and inventories the full corpus. It never replaces the capture step: refresh visible evidence through Chrome or CDP first, inspect and redact it, then update the descriptor.

Useful options:

```bash
node test/helpers/capture-provider-dom-cdp.mjs \
  --provider claude \
  --url-includes /new \
  --output-dir test-results/manual-claude-captures
```

Pass `--help` for all options. `--include-text` is deliberately opt-in because it may retain visible conversation content.

## ChatGPT Compatibility Entry Point

`capture-chatgpt-dom-cdp.mjs` remains available with its original command and options. It is a thin ChatGPT-only wrapper around the provider helper, and it keeps the existing default directory and DOM filename:

```bash
node test/helpers/capture-chatgpt-dom-cdp.mjs
```

The artifacts remain under `test-results/chatgpt-dom-captures/<timestamp>/`, including `chatgpt-dom.sanitized.html`.

## Existing Daily Chrome Fallback

`capture-existing-chrome-chatgpt-dom.mjs` targets an already-open macOS Google Chrome tab through Apple Events. It is useful only when you must inspect the daily Chrome process that was not launched with `--remote-debugging-port`.

Chrome blocks this path unless `View > Developer > Allow JavaScript from Apple Events` is enabled.
