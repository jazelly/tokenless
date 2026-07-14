# Tokenless Direct Mode

Tokenless has two deliberately separate execution modes:

| Mode | Transport | Authentication owner | Default behavior |
| --- | --- | --- | --- |
| `visible` | Local daemon, native host, extension, and the provider's visible browser UI | The user's visible browser session | Default for `tokenless run` |
| `direct` | The official Codex executable, a documented public provider API, or an explicitly configured compatible gateway | The provider-owned client or an environment-supplied API key | Opt-in with `--mode direct` |

The mode is selected before Tokenless initializes a transport. There is no fallback between them. A visible-session failure never creates API traffic or charges, and a direct failure never starts the daemon, contacts the extension, opens a browser, or resends the prompt through the visible UI.

## Billing and account boundary

Web subscriptions and public API accounts are separate products unless a provider explicitly documents otherwise. A ChatGPT, Claude, Gemini, or Grok web subscription does not by itself supply Tokenless with public API quota. Direct API and broker requests can incur usage charges from the provider or gateway configured by the operator.

The ChatGPT `official-client` backend is the exception in transport, not in ownership: it asks the provider-owned Codex executable to use its own supported ChatGPT authentication. Tokenless never converts that entitlement into an API key. A plain direct run uses the ambient Codex login; the authenticated broker can expose only the bounded stateless `POST /v1/responses` subset for an explicitly managed project/account binding.

## Run a direct request

ChatGPT defaults to the official Codex backend on macOS and Linux:

```bash
codex login

tokenless run \
  --mode direct \
  --provider chatgpt \
  --prompt "Summarize the trade-offs." \
  --json
```

`TOKENLESS_CODEX_BIN` may select a trusted Codex executable. The backend performs fail-closed capability and isolation checks before inference. It is not available on Windows; use the API backend there.

Codex currently loads `$CODEX_HOME/AGENTS.override.md` or `$CODEX_HOME/AGENTS.md` as provider-owned global instructions. Tokenless cannot suppress those files independently of the Codex credential home. Tokenless does not open or parse them, but their contents can influence the answer and Codex can send them with the prompt. Use the API backend when that behavior is undesirable.

The API backend requires an explicit model and an environment-supplied credential:

```bash
TOKENLESS_DIRECT_CHATGPT_API_KEY=... \
tokenless run \
  --mode direct \
  --direct-backend api \
  --provider chatgpt \
  --model <api-model> \
  --prompt "Summarize the trade-offs." \
  --json
```

Claude, Gemini, Grok, and Antigravity always use the API backend. Direct-run adapters use documented public protocols and opt out of provider-side response storage where that protocol exposes a supported request field. They do not call provider web-session backends.

## Provider and backend matrix

| Provider | Default direct backend | Public API protocol | API route | Credential variable |
| --- | --- | --- | --- | --- |
| `chatgpt` | Official Codex | OpenAI Responses when `api` is selected | `/v1/responses` | `TOKENLESS_DIRECT_CHATGPT_API_KEY` |
| `claude` | API | Anthropic Messages | `/v1/messages` | `TOKENLESS_DIRECT_CLAUDE_API_KEY` |
| `gemini` | API | Gemini Content | `/v1beta/models/{model}:generateContent` | `TOKENLESS_DIRECT_GEMINI_API_KEY` |
| `grok` | API | xAI Responses | `/v1/responses` | `TOKENLESS_DIRECT_GROK_API_KEY` |
| `antigravity` with `claude-*` | API | Dedicated gateway Anthropic Messages | `/antigravity/v1/messages` | `TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY` |
| `antigravity` with `gemini-*` | API | Dedicated gateway Gemini Content | `/antigravity/v1beta/models/{model}:generateContent` | `TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY` |

OpenAI, Anthropic, Google, and xAI use their official public API origins by default. Antigravity has no provider-owned public origin and no default: it requires an explicit compatible-gateway base URL and a strict lowercase `claude-*` or `gemini-*` model.

## Environment configuration

Shared routing settings are:

- `TOKENLESS_DIRECT_BASE_URL`
- `TOKENLESS_DIRECT_TIMEOUT_MS`

`TOKENLESS_DIRECT_API_KEY` is a convenience credential only for an operator-initiated normalized `tokenless run --mode direct` request. The broker never accepts it, because a local broker caller can choose a different provider route and must not cause one provider's generic secret to cross into another provider's trust boundary.

Provider-specific settings take precedence:

- `TOKENLESS_DIRECT_CHATGPT_BASE_URL` and `TOKENLESS_DIRECT_CHATGPT_API_KEY`
- `TOKENLESS_DIRECT_CLAUDE_BASE_URL` and `TOKENLESS_DIRECT_CLAUDE_API_KEY`
- `TOKENLESS_DIRECT_GEMINI_BASE_URL` and `TOKENLESS_DIRECT_GEMINI_API_KEY`
- `TOKENLESS_DIRECT_GROK_BASE_URL` and `TOKENLESS_DIRECT_GROK_API_KEY`
- `TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL` and `TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY`

API keys are accepted only from the process environment. Tokenless does not put them in CLI arguments, `config.json`, the daemon database, browser storage, or job state. Remote base URLs must use HTTPS; plain HTTP is accepted only for a loopback upstream. Normalized direct runs fail closed if `NODE_TLS_REJECT_UNAUTHORIZED=0` disables process-wide certificate verification. They also refuse loopback HTTP while Node environment proxying is enabled, so a proxy cannot receive a cleartext loopback credential; HTTPS remains allowed with certificate verification. The broker bypasses global proxy agents and explicitly requires certificate verification for every HTTPS socket. Redirects are rejected.

Every legacy broker route without a project header requires the matching provider-specific `TOKENLESS_DIRECT_<PROVIDER>_API_KEY`. A project-routed public API request instead uses the selected account's `TOKENLESS_DIRECT_ACCOUNT_<PROVIDER>_<ACCOUNT>_API_KEY`; a managed ChatGPT project delegates to its isolated official Codex profile. Missing credentials fail before an upstream socket is opened, even when `TOKENLESS_DIRECT_API_KEY` is set.

## Project-affine multi-account routing

`x-tokenless-project` opts a broker request into durable `(project, provider)` account routing. Tokenless supports multiple public API accounts for all five direct providers and multiple ChatGPT subscription accounts through isolated official Codex profiles.

An existing usable binding remains fixed across requests, restarts, new accounts, and recovery of an older account. Busy queues, 429 responses, quota, permission errors, timeouts, 5xx responses, and ambiguous or post-dispatch failures never rebalance it. Only a proven account-local unavailability signal can migrate an `availability-first` binding, and migration stays inside the exact provider, driver, and operator-defined routing domain. A `strict` binding never migrates.

The response that proves an API credential rejection keeps its upstream status and body and is never replayed; the broker still applies its normal safe response-header filter. The account is marked unavailable for later requests, and the next request may persistently migrate to an eligible replacement. Repairing the old account does not switch the project back.

See [Project-Affine Multi-Account Routing](./multi-account-routing.md) for two-account ChatGPT onboarding, public API account environment names, project pinning, automatic-assignment domains, failover behavior, and semantic-isolation limits.

## Local direct API broker

The broker lets local API clients use configured public upstreams without receiving their outbound credentials:

```bash
export TOKENLESS_DIRECT_SERVER_KEY="$(openssl rand -hex 32)"

TOKENLESS_DIRECT_SERVER_KEY="$TOKENLESS_DIRECT_SERVER_KEY" \
TOKENLESS_DIRECT_CHATGPT_API_KEY=... \
tokenless serve --mode direct --home "$HOME/.tokenless" --host 127.0.0.1 --port 8788 --json
```

Every request, including `/health` and `/capabilities`, must send the local key:

```bash
curl http://127.0.0.1:8788/health \
  -H "Authorization: Bearer $TOKENLESS_DIRECT_SERVER_KEY"
```

The server key must be at least 32 visible non-whitespace characters; the command above generates 32 random bytes. The server binds a loopback address only. `SIGINT` and `SIGTERM` stop accepting requests, abort outstanding upstream work after the bounded shutdown grace period, and close the listener. The broker has finite header, body, request, and upstream limits.

The broker removes inbound provider credentials, cookies, hop-by-hop headers, and credential-like headers; forwards only an explicit safe header allowlist; and injects the selected environment credential. It rejects credential query parameters, redirects, unsupported methods, and paths outside this inference allowlist:

| Local route | Method | Provider selection |
| --- | --- | --- |
| `/v1/responses`, `/v1/responses/compact`, `/v1/chat/completions` | `POST` | ChatGPT by default; exact `x-tokenless-provider: grok` where the Grok contract supports the route |
| `/v1/embeddings` | `POST` | ChatGPT only |
| `/v1/images/generations`, `/v1/images/edits` | `POST` | ChatGPT by default; exact Grok selector for Grok |
| `/v1/videos/generations`, `/v1/videos/edits`, `/v1/videos/extensions` | `POST` | Grok only; selector required |
| `/v1/videos/{id}` | `GET` | Grok only; selector required |
| `/v1/models`, `/v1/models/{id}` | `GET` | ChatGPT by default; an exact `claude` or `grok` selector is required for those upstreams |
| `/v1/messages`, `/v1/messages/count_tokens` | `POST` | Claude, inferred from the Anthropic protocol |
| `/v1beta/models`, `/v1beta/models/{model}` | `GET` | Gemini, inferred from the Gemini protocol |
| `/v1beta/models/{model}:generateContent`, `/v1beta/models/{model}:streamGenerateContent` | `POST` | Gemini, inferred from the Gemini protocol |
| `/antigravity/v1/messages`, `/antigravity/v1/messages/count_tokens` | `POST` | Explicit Antigravity compatible gateway |
| `/antigravity/v1/models`, `/antigravity/v1beta/models`, `/antigravity/v1beta/models/{model}` | `GET` | Explicit Antigravity compatible gateway |
| `/antigravity/v1beta/models/{model}:generateContent`, `/antigravity/v1beta/models/{model}:streamGenerateContent` | `POST` | Explicit Antigravity compatible gateway |

The Gemini broker surface is intentionally limited to reviewed public model discovery, generation, and streaming-generation routes. Generic `/v1/usage`, provider usage/account endpoints, unversioned Gemini aliases, `/antigravity/models`, and `/antigravity/v1/usage` are not exposed.

The broker is a streaming, protocol-preserving forwarder. It does not parse or rewrite request bodies and therefore does not inject `store: false`. The caller controls any provider-supported storage field in the opaque request body, while the selected provider or gateway controls its own retention policy. This differs from `tokenless run`, whose normalized adapters set documented storage opt-outs themselves.

## Security boundary

Direct mode does not extract or forward provider cookies, localStorage/sessionStorage values, hidden web authorization headers, or private web endpoints. The broker exposes no Sub2API administration, user, payment, OAuth, account import, account scheduling, quota, or usage API. It also does not expose provider admin/account APIs or a generic arbitrary-path proxy.

Tokenless can validate its own routing and credential handling, but it cannot attest how an independently operated compatible gateway obtains upstream authority. Operators remain responsible for gateway security, provider terms, billing, logging, and retention.

## Optional live API proof

The regular test suite uses real loopback sockets and never requires paid provider traffic. To make one explicit live public-API request, set the selected provider credential from the table above and run:

```bash
TOKENLESS_LIVE_DIRECT_PROVIDER=claude \
TOKENLESS_LIVE_DIRECT_MODEL=<api-model> \
TOKENLESS_DIRECT_CLAUDE_API_KEY=... \
npm run test:e2e:live-direct
```

Set `TOKENLESS_LIVE_DIRECT_BASE_URL` for an explicitly reviewed compatible gateway. Optional `TOKENLESS_LIVE_DIRECT_PROMPT`, `TOKENLESS_LIVE_DIRECT_TIMEOUT_MS`, and `TOKENLESS_LIVE_DIRECT_TEST_TIMEOUT_MS` values customize the proof. This command intentionally spends one provider or gateway API request. It never accepts a credential as a CLI argument.

To prove the ambient ChatGPT login through the provider-owned Codex client, use the separate double-opt-in test. Its model is intentionally hard-coded and cannot be overridden:

```bash
TOKENLESS_LIVE_AMBIENT_CODEX_CONFIRM=I_ACCEPT_SUBSCRIPTION_USAGE \
npm run test:e2e:live-ambient-codex
```

This spends one ChatGPT subscription request with `gpt-5.3-codex-spark`. It proves the ambient official-client path, not multi-account project routing. A live managed-project proof additionally requires an explicitly created managed account, provider-owned login, and project pin.
