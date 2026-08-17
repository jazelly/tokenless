# GPT4Free direct provider service

Tokenless setup installs one pinned private GPT4Free HTTP service. The Tokenless daemon remains the only public API and owns profiles, feature flags, visible-browser automation, and session scope.

```text
Caller -> Tokenless daemon API -> native direct adapter
                               -> private G4F service -> provider HTTP
                                                      -> isolated headless browser for provider challenges
Tokenless managed browser -----^ session bootstrap only
```

## Runtime pins

| Dependency | Pin |
|---|---|
| Python | `3.12` |
| GPT4Free | `g4f[all]==8.1.2` |
| GPT4Free commit reference | `fdbd84b7c5129ea8faa7c66065425ca344ea5fb2` |
| PA providers | `6f9be4e8ae489ea9d66755d99afda478e970c0c1` |

The exact `uv.lock` includes `curl-cffi`, `browser-cookie3`, `zendriver`, and `platformdirs`. Setup downloads the Python environment and PA providers; the npm package contains only the Tokenless wrapper, lock, and notice.

## Backend selection

Direct execution and provider backend are separate choices:

```bash
tokenless run --profile default --provider chatgpt \
  --execution-mode direct --provider-backend g4f \
  --prompt "Reply with OK" --json
```

Use `--provider-backend native` for the retained native ChatGPT or Perplexity implementation. Persistent defaults live in `directProvider.defaultBackend` and `directProvider.providerBackends`.

## Authenticated daemon API

The daemon does not expose a public G4F-namespaced route. Use the standard API proxy endpoints with `tokenless.execution_mode: direct`; the selected provider ID maps to the pinned G4F provider internally.

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions; direct G4F plain-text requests preserve upstream SSE when `stream: true` |
| `POST /v1/responses` | OpenAI Responses; direct G4F plain-text requests preserve upstream SSE when `stream: true` and do not support Tokenless `previous_response_id` continuation |
| `POST /v1/images/generations` | Provider-neutral browser or direct image generation |

For example, a direct GLM request uses the mapped Tokenless model ID:

```json
{
  "model": "tokenless/zai/GLM-4.7",
  "messages": [{"role": "user", "content": "Reply with OK."}],
  "stream": true,
  "tokenless": {"execution_mode": "direct"}
}
```

All routes require the normal Tokenless daemon bearer token. Provider guest mode is separate from daemon authentication; managed direct CLI execution creates any ephemeral provider auth context privately and removes it after the request.

Auth source types are `empty`, `manual`, `har`, `cookie-file`, `browser-cookie3`, `cookie-database`, and loopback `cdp`. Both Cookie DB source types require an exact database path inside the selected managed profile; unscoped browser scanning is rejected. Manual values are limited to the selected provider domains.

On macOS, `browser-cookie3` and direct Cookie DB decryption are disabled because that library invokes the Keychain CLI. Use the Tokenless managed CDP/session bridge, which leaves credential access inside the running browser.

`ephemeral` contexts live only for the current service process. `user-persisted` contexts store provider-scoped source material with mode `0600` under the local Tokenless home and reload after daemon restart.

Uploaded HAR files are reduced to requests for the selected provider domains before storage. Cookie JSON exports are rejected when any cookie belongs to another provider scope.

## Isolation

- The service binds to a dynamic loopback port with an ephemeral private credential.
- One worker serializes auth activation through the entire response stream.
- Each auth context has a private directory; provider class auth state is cleared before activation.
- Stock request logs, wildcard CORS, GUI, docs, OpenAPI, cookie upload, and runtime PA download routes are not reachable.
- G4F-owned browser launches are forced to headless mode; they may compute provider challenge tokens but expose no provider UI. Automatic discovery of other CDP browsers is disabled; only an explicitly selected `cdp` auth source may attach to an existing browser.
- Provider session values never enter caller responses, daemon errors, telemetry, or service logs.

Visible-browser execution remains Tokenless-native. For ChatGPT G4F direct execution without an explicit auth context, Tokenless reads only the selected provider session from its managed browser, creates an ephemeral provider-scoped G4F auth cache, and deletes it after the request.

Real E2E covers both authentication boundaries:

- Guest: a direct standard API request for `tokenless/zai/GLM-4.7` omits provider credentials, completes Aliyun traceless verification in the isolated headless browser, and requires an exact random response marker.
- Signed in: ChatGPT direct reads only the selected Cloak browser profile's ChatGPT cookies, access token, user agent, and language headers into one ephemeral provider-scoped context.
- Image: the real `tokenless/pollinations/sana` direct gate generated a 768×768 JPEG through the unified endpoint, persisted it under the supplied task identity, and proved digest plus authenticated byte-for-byte readback without exposing the private backend.

## Provider errors

Tokenless wraps a failed G4F provider call as HTTP `502` while retaining safe upstream diagnostics. Error codes preserve the G4F exception type, for example `g4f_upstream_missing_auth_error` or `g4f_upstream_curl_error`; `upstream` includes only `status`, `type`, `category`, `provider`, and `model`.

The free-form G4F exception message is not returned because it may contain provider session material. OpenAI-compatible requests carry the same specific Tokenless code in the OpenAI error envelope.
