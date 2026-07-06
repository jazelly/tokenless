# Test Helpers

## Capture ChatGPT DOM With CDP

Use `capture-chatgpt-dom-cdp.mjs` as the standard helper for grabbing a sanitized DOM snapshot from a real ChatGPT page in a browser profile that was started with Chrome DevTools Protocol enabled.

Start a dedicated Chrome profile:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tokenless-cdp-chrome-profile \
  https://chatgpt.com/
```

Sign in to ChatGPT in that Chrome window if needed, then capture:

```bash
node test/helpers/capture-chatgpt-dom-cdp.mjs
```

Artifacts are written under `test-results/chatgpt-dom-captures/<timestamp>/`:

- `chatgpt-dom.sanitized.html`
- `selector-probes.json`
- `metadata.json`
- `visible-text.txt` only when `--include-text` is passed

The helper does not read cookies, localStorage, sessionStorage, hidden auth headers, or provider backend APIs. It evaluates read-only page JavaScript through CDP and sanitizes the captured DOM by default.

## Existing Daily Chrome Fallback

`capture-existing-chrome-chatgpt-dom.mjs` targets an already-open macOS Google Chrome tab through Apple Events. It is useful only when you must inspect the daily Chrome process that was not launched with `--remote-debugging-port`.

Chrome blocks this path unless `View > Developer > Allow JavaScript from Apple Events` is enabled.
