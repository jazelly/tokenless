# Test Helpers

## Capture Provider DOM With CDP

Use `capture-provider-dom-cdp.mjs` to capture a sanitized DOM snapshot from a real provider page in a dedicated Chrome profile with the Chrome DevTools Protocol enabled. The helper supports `chatgpt`, `claude`, `gemini`, and `grok` through one provider-definition table. Each definition owns its allowed origin, launch URL, selector probes, and DOM artifact name.

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

Artifacts are written under `test-results/<provider>-dom-captures/<timestamp>/`:

- `<provider>-dom.sanitized.html`
- `selector-probes.json`
- `metadata.json`
- `visible-text.txt` only when `--include-text` is passed

`metadata.json` identifies the `provider`, the `visible-session-web-ui` surface, and `capturedAt`. Page query strings, fragments, and opaque conversation, Gem, Project, or custom-agent path identifiers are omitted or replaced with `[redacted]`. DOM attributes are denied by default: the sanitizer retains only fixed structural states and static values or fragments required by the selected provider's selector probes. Arbitrary `id`, `class`, `name`, ARIA, and `data-*` values are removed, while URL attributes are reduced to safe static paths or redacted markers. Form values, hidden inputs, executable/resource elements, comments, and non-visible text are sanitized or removed before output. Selector probes never include page text unless `--include-text` is explicitly passed; even then, only text visible in the viewport is retained, and `--max-text-chars` bounds every exported text field, including the DOM snapshot, visible-text artifact, page title, and selector probe samples.

The helper does not read or export provider cookies, localStorage, sessionStorage, hidden authentication headers, or private provider backend APIs. It evaluates read-only page JavaScript through CDP and writes only the sanitized DOM, probes, and metadata described above. Use a dedicated capture profile and inspect every artifact before promoting it into a test fixture.

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
