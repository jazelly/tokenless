# Tokenless Direct Mode and Gateway Broker

Status: Implemented and independently verified

Date: 2026-07-13

Upstream reviewed: [`Wei-Shaw/sub2api@4bc7486c3b4cf0a0c4b4b551bdb3f5cb5f825ad2`](https://github.com/Wei-Shaw/sub2api/tree/4bc7486c3b4cf0a0c4b4b551bdb3f5cb5f825ad2)

Account routing amendment: [Tokenless Account Pool and Project Routing](./account-pool-rfc.md)

## Summary

Tokenless will support two execution modes behind one CLI:

1. `visible` keeps the current daemon, Playwright worker, managed browser profile, and user-visible provider DOM path.
2. `direct` runs through a provider-owned programmatic client or calls a user-configured public provider/gateway API without starting the daemon or managed browser runtime.

The first provider-owned client is OpenAI Codex. The first compatible gateway is Sub2API. Compatibility means Tokenless implements Sub2API's documented public inference protocols. Tokenless will not embed, fork, launch, administer, or copy Sub2API, and it will not reproduce Sub2API's upstream account implementation.

This separation is deliberate. Sub2API is an API gateway and account scheduler, not browser UI automation. Its subscription-account paths persist OAuth credentials and forward requests to provider services, including private provider endpoints. Those mechanisms conflict with Tokenless's visible-session safety boundary and are not imported into this repository.

## Goals

- Add `tokenless run --mode direct` next to the existing visible-session mode.
- Keep `visible` as the default so existing commands remain compatible.
- Let ChatGPT-plan users run through the official Codex executable without Tokenless reading Codex credentials or reproducing its transport.
- Let one local operator configure multiple isolated provider accounts, keep each project on a preferred account while healthy, and fail over persistently when that account is unavailable.
- Support every platform exposed by the reviewed Sub2API gateway: OpenAI, Anthropic, Gemini, Grok, and Antigravity.
- Support official public provider APIs with the same direct adapters where their protocols match.
- Read outbound API credentials from process environment only; never persist them in Tokenless configuration or job state.
- Provide a loopback API broker that can expose the configured direct upstreams to local API clients without disclosing outbound credentials.
- Preserve streaming responses in the broker.
- Keep provider-specific protocols intact while returning one normalized result from `tokenless run`.
- Fail closed on insecure upstream URLs, ambiguous provider routing, unsupported paths, oversized bodies, and authentication errors.

## Non-goals

- Extracting cookies, browser storage, provider access tokens, refresh tokens, or hidden headers.
- Calling `chatgpt.com/backend-api`, Claude private services, Gemini Code Assist private services, or other undocumented provider backends from Tokenless.
- Reusing a first-party CLI's OAuth credential in a Tokenless HTTP client.
- Pretending to be Codex CLI, Claude Code, Gemini CLI, Grok CLI, or a browser.
- Turning a provider-owned subscription client into a network-exposed, shared, multi-user, or resale proxy.
- Reimplementing provider OAuth flows or managing Sub2API users, payments, groups, account credentials, or deployment.
- Guaranteeing that an independently operated gateway complies with provider terms.
- Translating every provider feature into a lowest-common-denominator schema.

## Upstream findings

Sub2API describes itself as an AI API gateway for distributing subscription quota. The reviewed source has five platform constants: `anthropic`, `openai`, `gemini`, `antigravity`, and `grok`. Its public gateway accepts Anthropic Messages, OpenAI Responses and Chat Completions, Gemini `v1beta`, media routes, and dedicated Antigravity routes.

The implementation is materially different from Tokenless visible mode:

- OpenAI OAuth uses the Codex client id, stores access and refresh tokens, adds `chatgpt-account-id`, and sends inference to `https://chatgpt.com/backend-api/codex/responses` for subscription accounts.
- Anthropic supports OAuth and setup-token account types in addition to API keys and cloud providers.
- Gemini and Antigravity cache and refresh OAuth credentials before calling their upstream services.
- Grok supports xAI OAuth subscription accounts and public API-key accounts.
- Sub2API performs multi-account scheduling, billing, quotas, concurrency control, and protocol conversion on a server.

Pinned evidence:

- [Platform and account-type constants](https://github.com/Wei-Shaw/sub2api/blob/4bc7486c3b4cf0a0c4b4b551bdb3f5cb5f825ad2/backend/internal/domain/constants.go)
- [Public gateway routes](https://github.com/Wei-Shaw/sub2api/blob/4bc7486c3b4cf0a0c4b4b551bdb3f5cb5f825ad2/backend/internal/server/routes/gateway.go)
- [OpenAI OAuth token structures](https://github.com/Wei-Shaw/sub2api/blob/4bc7486c3b4cf0a0c4b4b551bdb3f5cb5f825ad2/backend/internal/pkg/openai/oauth.go)
- [OpenAI subscription upstream](https://github.com/Wei-Shaw/sub2api/blob/4bc7486c3b4cf0a0c4b4b551bdb3f5cb5f825ad2/backend/internal/service/openai_gateway_service.go)
- [Sub2API license](https://github.com/Wei-Shaw/sub2api/blob/4bc7486c3b4cf0a0c4b4b551bdb3f5cb5f825ad2/LICENSE)

The repository is LGPL-3.0 licensed. Tokenless will implement protocol compatibility from public route contracts and will not copy or link Sub2API code. This avoids a runtime dependency and keeps the projects independently releasable.

## Provider policy boundary

Provider policy is another reason not to reproduce the upstream account layer:

- [Gemini CLI's terms documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md) says third-party access to the services powering Gemini CLI through its OAuth is prohibited; supported third-party access uses Gemini Developer API or Vertex AI credentials.
- [Anthropic's account authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) directs third-party products to API keys or supported cloud providers and prohibits identity misrepresentation or routing third-party traffic against subscription limits.
- [OpenAI supports ChatGPT-plan use through first-party Codex clients](https://help.openai.com/en/articles/11369540-using-codex-with-chatgpt), but that does not make ChatGPT's private backend a public third-party API.

Tokenless therefore owns only the orchestration or downstream client boundary. A direct backend may be:

- a provider-owned client with an explicitly supported machine-readable interface;
- an official provider API;
- an organization-controlled compatible gateway; or
- a Sub2API deployment exposing its documented inference API.

Tokenless does not inspect or attest how a compatible gateway obtains its upstream authority. Documentation must not instruct users to import subscription OAuth credentials into a gateway. Operators remain responsible for provider terms, account rules, and data handling.

The local account-pool amendment does not use multiple ChatGPT subscriptions to aggregate quota, rate limits, or concurrency. ChatGPT subscription projects require an explicit local pin, all managed subscription profiles share a global inference lock, and failover is limited to proven pre-dispatch profile-local unavailability such as an operator-disabled or logged-out profile. Rate limits, quota responses, busy slots, and ambiguous post-dispatch Codex failures never rotate subscription accounts.

## Architecture

```text
                              +-> daemon -> Playwright worker -> managed profile -> visible DOM
Agent -> tokenless CLI -> mode |
                              +-> direct
                                  +-> official Codex executable owns auth + transport
                                  +-> public API or compatible gateway
                                      -> normalized CLI result

Local API client -> authenticated loopback broker -> project account router
                                                  +-> isolated official Codex profile
                                                  +-> provider-specific public route
                                                      -> configured public upstream
```

The mode decision occurs before any visible-session initialization. Direct mode must not:

- resolve or start the Rust daemon;
- read the daemon token;
- inspect the bridge marker;
- open a browser; or
- write direct credentials to `config.json`.

### Source layout

The implementation belongs in the public CLI package:

```text
packages/cli/src/direct/
  api-client.ts       normalized public API execution
  api-transport.ts    bounded redirect-free HTTP transport
  account-pool.ts     account metadata, project affinity, health, and failover
  local-lock.ts       atomic registry and account execution leases
  broker.ts           authenticated loopback streaming broker
  client.ts           direct backend selection
  config.ts           environment-only upstream resolution and URL validation
  official-client.ts  isolated provider-owned client execution
  protocols/          provider-specific public request and response contracts
  types.ts            public direct protocol types
```

`packages/cli/src/index.ts` exports the reusable direct client and broker APIs. `tokenless.mts` remains command orchestration rather than accumulating provider protocol logic.

## CLI contract

### Visible mode

Existing behavior stays unchanged:

```bash
tokenless run --mode visible --provider chatgpt --prompt "..."
```

`--mode` is optional and defaults to `visible`.

There is no automatic fallback between modes. A visible failure must not silently create API charges, and a direct failure must not silently open a browser or share the prompt with a second transport.

Web subscriptions and public API accounts are separate products unless a provider explicitly documents otherwise. Public API broker requests can incur provider or gateway charges independently of a ChatGPT, Claude, Gemini, or Grok web subscription. The project-routed ChatGPT subset invokes an isolated official Codex client profile locally; Tokenless never converts that entitlement into an API credential or sends it through Tokenless-owned HTTP transport.

### Direct mode

ChatGPT defaults to the provider-owned Codex backend:

```bash
tokenless run \
  --mode direct \
  --provider chatgpt \
  --prompt "..." \
  --json
```

Tokenless invokes `codex exec` with the prompt on stdin, an isolated empty working directory, no execution environment, an explicit deny-by-default permission profile, ephemeral sessions, ignored user configuration/rules, and machine-readable output. The profile denies the filesystem root and sandboxed network access. Tokenless explicitly disables Codex skills, MCP, hooks, plugins, apps, browser/computer control, hosted search/image generation, collaboration, and shell features. A loopback-only Responses canary inspects the installed client's actual tool schema before authentication or inference and accepts only the inert planning tool. The legacy Codex `read-only` sandbox is not used because it permits host-wide reads. Codex alone owns its OAuth credential store and upstream HTTP. Tokenless does not read `auth.json`, a keychain, access tokens, or refresh tokens.

The official-client backend currently fails closed on Windows because npm's command shim and descendant-process isolation do not provide the same direct-executable and process-group guarantees. Windows users can use the public API backend. The official-client backend is supported on macOS and Linux.

`TOKENLESS_CODEX_BIN` may select a trusted installed Codex executable by path. Tokenless checks the executable's supported flags and features, proves that its root-deny profile blocks local process execution, checks provider-owned login status, requires ChatGPT authentication for this backend, and fails with an upgrade or login instruction when the client cannot provide the contract. Every Codex subprocess receives a small positive environment allowlist; API keys, endpoint overrides, proxy overrides, dynamic-loader variables, and Node injection variables are not inherited. Model-generated commands inherit none of Tokenless's parent environment, and filesystem-capable tools remain confined by the permission profile. API users select `--direct-backend api`. Tokenless never falls back to weaker arguments.

Codex 0.143 does not provide a flag that suppresses `$CODEX_HOME/AGENTS.override.md` or `$CODEX_HOME/AGENTS.md` independently of its credential home. The ambient single-profile CLI backend therefore preserves that provider-owned global-instructions behavior. Tokenless-managed account profiles reject those instruction files by existence and type checks without reading them. Public API backends do not load Codex instructions.

The API backend is explicit for ChatGPT:

```bash
TOKENLESS_DIRECT_BASE_URL=https://gateway.example.com \
TOKENLESS_DIRECT_CHATGPT_API_KEY=... \
tokenless run \
  --mode direct \
  --direct-backend api \
  --provider chatgpt \
  --model gpt-5.4 \
  --prompt "..." \
  --json
```

The API backend requires an explicit model. Model availability changes independently of Tokenless and must not be hard-coded as a silent default. The Codex backend may use its provider-owned default or accept `--model`.

Provider names are:

- `chatgpt`: OpenAI Responses protocol; maps to Sub2API platform `openai`.
- `claude`: Anthropic Messages protocol; maps to platform `anthropic`.
- `gemini`: Gemini `generateContent` protocol; maps to platform `gemini`.
- `grok`: OpenAI Responses protocol; maps to platform `grok`.
- `antigravity`: dedicated Antigravity route; protocol is selected from an unambiguous `claude-*` or `gemini-*` model prefix.

Visible mode accepts `chatgpt`, `claude`, `gemini`, and `grok`; direct-only `antigravity` remains outside the visible-session path.

`--direct-backend` accepts `official-client` or `api`. It defaults to `official-client` for ChatGPT and `api` for every other direct provider. `official-client` is rejected for a provider until that provider publishes and documents a stable programmatic client interface suitable for third-party orchestration.

Direct mode rejects visible-only options such as browser, target URL, bridge/read delays, `--no-open`, `--no-wait`, `--long-running`, ChatGPT surface, and visible effort controls. `state`, `cancel`, `snapshot-dom`, and visible control commands remain visible-session commands.

### Environment

Shared routing settings:

- `TOKENLESS_DIRECT_BASE_URL`
- `TOKENLESS_DIRECT_TIMEOUT_MS`

`TOKENLESS_DIRECT_API_KEY` is accepted only for an operator-initiated normalized direct run. The broker rejects generic credentials. A legacy request without `x-tokenless-project` requires the matching provider-specific key; a project-routed public request uses only the credential environment named by the selected account record. This prevents a local caller from selecting a route that sends one provider's secret to another provider origin.

Per-provider settings take precedence:

- `TOKENLESS_DIRECT_CHATGPT_BASE_URL`
- `TOKENLESS_DIRECT_CHATGPT_API_KEY`
- `TOKENLESS_DIRECT_CLAUDE_BASE_URL`
- `TOKENLESS_DIRECT_CLAUDE_API_KEY`
- `TOKENLESS_DIRECT_GEMINI_BASE_URL`
- `TOKENLESS_DIRECT_GEMINI_API_KEY`
- `TOKENLESS_DIRECT_GROK_BASE_URL`
- `TOKENLESS_DIRECT_GROK_API_KEY`
- `TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL`
- `TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY`

API keys are intentionally unavailable as CLI flag values because command lines are commonly visible in process listings and shell history. Base URLs may be supplied with `--direct-base-url` because they are not credentials.

For a request without `x-tokenless-project`, the broker requires the matching `TOKENLESS_DIRECT_<PROVIDER>_API_KEY`. A project-routed API request requires its selected account's `TOKENLESS_DIRECT_ACCOUNT_<PROVIDER>_<ACCOUNT>_API_KEY`. Missing credentials fail before upstream contact even if `TOKENLESS_DIRECT_API_KEY` is present.

Remote upstreams must use HTTPS. Plain HTTP is accepted only for loopback hosts, which supports local development and a local Sub2API deployment without allowing accidental cleartext credentials over a network. Normalized direct runs fail closed when `NODE_TLS_REJECT_UNAUTHORIZED=0` disables process-wide certificate verification. They also refuse loopback HTTP while Node environment proxying is enabled, preventing a proxy from receiving a cleartext loopback credential; HTTPS remains allowed with certificate verification. The broker bypasses global proxy agents and explicitly enables certificate verification on every HTTPS request. Base URLs with userinfo, query, or fragment are rejected. Redirects are rejected so credentials cannot cross origins.

## Direct request protocol

The reusable client accepts:

```ts
type DirectRunRequest = {
  provider: 'chatgpt' | 'claude' | 'gemini' | 'grok' | 'antigravity'
  model?: string
  prompt: string
  backend?: 'official-client' | 'api'
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
}
```

It returns protocol `tokenless.direct.v1` with:

- the selected backend;
- an explicit capability id (`openai.codex` for the official client and `openai.responses` for the ChatGPT API backend) so the two products are never represented as interchangeable;
- provider and model;
- normalized assistant text;
- normalized usage where the upstream reports it;
- upstream request id where available;
- the provider-native response under `raw` for lossless CLI JSON use.

The client sends only documented authentication headers:

- OpenAI and Grok: `Authorization: Bearer`.
- Anthropic: `x-api-key` and `anthropic-version`.
- Gemini: `x-goog-api-key`.
- Antigravity through a compatible gateway: `x-api-key`.

No caller-supplied arbitrary headers are accepted.

Normalized direct-run adapters set documented provider-side storage opt-outs where their request protocol supports one. This is an adapter guarantee only; independently operated providers and gateways retain responsibility for their own logging and retention.

For compatible gateways, an API key's configured group/platform must match the Tokenless provider and requested model. Tokenless cannot override server-side account grouping with a request field and reports a gateway mismatch rather than attempting a different provider.

### Provider-owned client certification

An `official-client` adapter is admitted only when all of these are true:

- the provider documents the executable, SDK, or app-server surface for programmatic orchestration;
- authentication and token refresh remain entirely inside provider-owned code;
- the interface has machine-readable, versionable output;
- Tokenless can isolate filesystem, rules, hooks, plugins, and tool privileges;
- the installed client passes Tokenless's fail-closed loopback tool-schema and permission-profile canaries before authentication or inference;
- the adapter does not copy a first-party OAuth client, endpoint, header fingerprint, or credential cache; and
- any broker exposure is authenticated, loopback-only, single-operator, project-routed, capability-bounded, and delegates transport to the unchanged provider client.

At the reviewed date, only OpenAI Codex passes this gate for this initiative. Other providers remain on their documented public APIs or a compatible gateway.

## Provider matrix

| Tokenless provider | Direct path | Request protocol | Text extraction |
| --- | --- | --- | --- |
| `chatgpt` | `/v1/responses` | OpenAI Responses | `output_text` content blocks only |
| `claude` | `/v1/messages` | Anthropic Messages | text content blocks |
| `gemini` | `/v1beta/models/{model}:generateContent` | Gemini Content | candidate text parts |
| `grok` | `/v1/responses` | OpenAI Responses | `output_text` content blocks only |
| `antigravity` + Claude model | `/antigravity/v1/messages` | Anthropic Messages | text content blocks |
| `antigravity` + Gemini model | `/antigravity/v1beta/models/{model}:generateContent` | Gemini Content | candidate text parts |

Claude Messages always includes `max_tokens` (default `4096`) and accepts an explicit temperature only from `0` through `1`. Its normalized input usage is the safe sum of ordinary, cache-creation, and cache-read input tokens. Gemini requests use a bare, route-safe model identifier, force `store: false`, select only the first candidate, exclude `thought: true` parts from visible text, and include reported thought tokens in normalized output usage. Grok uses the same strict Responses text parser as ChatGPT but retains the distinct `xai.responses` capability and always sends `store: false`.

Antigravity has no default upstream. It requires an explicit compatible-gateway base URL and accepts only strict lowercase `claude-*` or `gemini-*` model families before any network request. A base may point to the gateway root, a path prefix, `/antigravity`, or the matching Antigravity version root; Tokenless joins the dedicated route exactly once. Tokenless never discovers or calls an Antigravity private upstream.

M1 implements ChatGPT. M2 adds every remaining row without changing the direct client contract; all API adapters share one bounded, redirect-free transport.

## Loopback API broker

The broker command is:

```bash
TOKENLESS_DIRECT_SERVER_KEY=... \
TOKENLESS_DIRECT_CHATGPT_API_KEY=... \
tokenless serve --mode direct --port 8788
```

Properties:

- Binds `127.0.0.1` by default.
- Requires `TOKENLESS_DIRECT_SERVER_KEY` for every route, including health and capabilities; there is no unauthenticated default.
- Requires that local server key to contain at least 32 visible non-whitespace characters; documentation generates 32 random bytes.
- Accepts the local key only as `Authorization: Bearer` and never forwards it.
- Removes inbound provider credentials, cookies, credential-like headers, and hop-by-hop headers, then forwards only an explicit safe header allowlist.
- Injects the configured outbound credential only for selected public API accounts.
- Does not log prompt bodies; public API routes stay opaque, while the managed Codex route parses only its bounded text subset.
- Preserves provider response status, content type, request ids, rate-limit metadata, and streaming bytes.
- Enforces header, request body, request, upstream, and bounded graceful-shutdown limits.
- Rejects credential query parameters.

The broker supports only the following public inference subset reviewed across the pinned Sub2API route contract and official provider contracts:

- OpenAI-compatible `POST /v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/images/generations`, and `/v1/images/edits`.
- Grok-only `POST /v1/videos/generations`, `/v1/videos/edits`, and `/v1/videos/extensions`, plus `GET /v1/videos/{id}`. Every video route requires exact Grok selection.
- `GET /v1/models` and `/v1/models/{id}`. ChatGPT is the default; callers targeting Claude or Grok must send an exact provider selector so an OpenAI-shaped path is never guessed across those upstreams.
- Anthropic `POST /v1/messages` and `/v1/messages/count_tokens`.
- Gemini `GET /v1beta/models` and `/v1beta/models/{model}`, plus `POST /v1beta/models/{model}:generateContent` and `/v1beta/models/{model}:streamGenerateContent`. These are the only verified Gemini public broker actions.
- Dedicated Antigravity `GET /antigravity/v1/models`, `/antigravity/v1beta/models`, and `/antigravity/v1beta/models/{model}`, plus `POST /antigravity/v1/messages`, `/antigravity/v1/messages/count_tokens`, `/antigravity/v1beta/models/{model}:generateContent`, and `/antigravity/v1beta/models/{model}:streamGenerateContent` against an explicitly configured compatible gateway.

OpenAI-shaped inference routes default to `chatgpt`; exact `x-tokenless-provider: grok` selects Grok where that route is supported. Anthropic and Gemini routes infer their provider from the unambiguous protocol path. Antigravity uses only its dedicated path and has no default upstream. Ambiguous, unsupported, or mismatched routing fails before upstream contact.

The broker intentionally does not expose generic `/v1/usage`, provider account or usage routes, unreviewed Gemini model actions, `/antigravity/models`, `/antigravity/v1/usage`, unversioned model aliases, Sub2API admin, user, payment, OAuth, account import, scheduling, quota, or `/backend-api/*` routes. Account administration remains local CLI state, not an HTTP surface. The broker is not an arbitrary-path proxy.

With an exact `x-tokenless-project` header, `POST /v1/responses` may resolve to a managed ChatGPT account and invoke its isolated official Codex profile. That adapter accepts only the bounded stateless text contract in the account-routing RFC. It rejects provider-side continuation, tools, files, images, remote connectors, and unsupported controls. All other official-client routes remain closed.

Public API routes preserve request bodies as opaque streaming bytes. They do not rewrite request JSON and therefore do not inject `store: false`; the local caller controls any documented provider storage field, and the configured upstream controls its logging and retention. The managed Codex route is the deliberate exception: it parses and validates a bounded request before passing only normalized text and an optional model to the provider-owned executable.

## Error contract

Direct failures use stable Tokenless codes:

- `direct_configuration_error`
- `direct_insecure_upstream`
- `direct_unsupported_provider`
- `direct_ambiguous_model`
- `direct_authentication_failed`
- `direct_rate_limited`
- `direct_upstream_error`
- `direct_timeout`
- `direct_invalid_response`
- `direct_request_too_large`

Errors may include upstream HTTP status, a bounded sanitized provider message, request id, and retryability. They must not contain configured credentials, outbound authorization headers, cookies, or full HTML error pages.

## Testing strategy

### Contract and unit tests

- URL normalization, HTTPS/loopback policy, and path joining.
- Environment precedence without secret persistence.
- Exact provider paths, documented headers, and request bodies.
- Codex subprocess arguments, exact child environment, stdin prompt delivery, isolated working directory, permission-profile canary, cancellation, process-tree termination, output validation, and credential non-access.
- Response normalization for all provider protocols.
- Bounded and redacted error handling.
- Timeout and abort behavior.
- Visible mode regression: the default path still initializes the daemon and Playwright worker.
- Direct mode isolation: it succeeds with daemon and Playwright worker unavailable.

### Focused integration tests

A local HTTP fixture will act as a public compatible gateway. Tests use real sockets and verify the complete CLI or broker path rather than mocking `fetch`:

- ChatGPT direct CLI request and normalized response.
- All provider route/header/body contracts.
- SSE and binary response pass-through without buffering or mutation.
- Inbound credential stripping and outbound credential selection.
- Broker authentication, route allowlist, body limit, cancellation, and upstream disconnects.

### Optional live proof

An opt-in API test runs only when the operator supplies a disposable compatible-gateway URL, API key, provider, and model. A separate opt-in Codex test invokes the provider-owned executable and lets that executable use its own existing ChatGPT login; Tokenless never opens or copies its credential store. CI does not require paid-provider traffic.

## Milestones

Each milestone ends in an independent reviewer pass, focused verification, and a dedicated commit.

### M0: Research and architecture

- Pin the reviewed Sub2API revision.
- Record the protocol, license, security, and provider-policy findings.
- Accept the dual-mode design and provider contract.

Acceptance: this RFC is internally consistent with the repository boundary and contains executable acceptance criteria for later milestones.

### M1: ChatGPT direct client

- Add the isolated official Codex adapter.
- Add direct configuration and OpenAI Responses adapter.
- Add `--mode direct`, `--direct-base-url`, and direct request options.
- Prove no daemon, Playwright worker, managed profile, or browser dependency is touched.
- Add real-socket CLI integration coverage.

Acceptance: ChatGPT direct requests work through official Codex and against official OpenAI-compatible or Sub2API-compatible public gateways. Codex owns subscription authentication; API credentials are environment-only; both return normalized results.

### M2: Provider expansion

- Add Claude, Gemini, Grok, and both Antigravity protocol paths.
- Add provider-specific usage normalization and errors.
- Add full provider matrix integration coverage.

Acceptance: all five reviewed Sub2API platforms pass route, auth, body, response, failure, and isolation tests.

### M3: Unified local API and release readiness

- Add the authenticated loopback streaming broker.
- Add capabilities, health, route allowlist, limits, and graceful shutdown.
- Add public documentation and optional live test instructions.
- Run security review and full repository verification.

Acceptance: compatible local clients can use the broker without receiving outbound credentials; streaming and non-streaming routes work; the existing visible path remains green.

M4 and later account-pool milestones are specified in the account-routing amendment. They extend the authenticated broker without weakening the completed M1-M3 credential, transport, or visible-mode boundaries.

## Release and rollback

- Direct mode is opt-in and does not change the default visible behavior.
- Existing installations need no credential migration. The optional account registry stores only metadata, environment-variable references, project bindings, and provider-owned identity fingerprints; credentials remain environment-owned or provider-client-owned.
- The broker is a separate command and does not change the daemon protocol.
- A direct-mode regression can be rolled back independently without changing the Playwright worker or Rust daemon binary.
- Upstream compatibility is tested against a pinned route contract. Upstream drift changes fixtures and implementation together in a reviewed commit.

## Completion criteria

The initiative is complete only when:

- all milestone commits exist and contain only initiative-owned changes;
- all five providers pass focused integration tests;
- direct mode is proven independent of daemon and Playwright worker availability;
- the authenticated broker preserves streaming and enforces its security boundary;
- lint, build, existing tests, and new tests pass;
- independent implementation and security reviewers approve the final diff; and
- any skipped live provider proof is reported explicitly with its credential or cost reason.
