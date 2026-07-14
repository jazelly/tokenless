# Project-Affine Multi-Account Routing

Tokenless can expose one authenticated loopback API while keeping multiple accounts for the same provider. The stable routing key is the pair `(project, provider)`. The selected account is persisted, so a project continues to use the same account across requests, broker restarts, newly added accounts, and recovery of an older account.

The design has two account drivers:

| Driver | Providers | Credential owner | Broker surface |
| --- | --- | --- | --- |
| `official-codex` | ChatGPT | A provider-owned Codex profile created and selected by Tokenless | Bounded stateless `POST /v1/responses` text requests |
| `api` | ChatGPT, Claude, Gemini, Grok, Antigravity | An account-specific environment variable in the broker process | Reviewed public inference routes for that provider protocol |

Tokenless never copies a browser login, imports an ambient Codex credential, or stores an API key. Account records contain only routing metadata and, for API accounts, the name of the environment variable that the operator must supply.

## Routing invariants

The account router enforces these rules:

1. An existing usable binding is always preferred. Load, queueing, rate limits, quota, timeouts, and transient failures do not rebalance it.
2. Automatic migration requires a proven account-unavailability signal.
3. Migration remains inside the exact provider, driver, and non-null routing domain of the binding.
4. A migrated binding stays on its replacement. Re-enabling or repairing the old account does not switch it back.
5. The request that observes an upstream credential rejection is never replayed. Tokenless preserves its upstream status and body while applying the broker's normal safe response-header filter; only a later request may migrate.
6. `strict` bindings never migrate automatically.

The routing domain is an operator-owned isolation boundary. Use different domains for accounts that must never substitute for one another, such as personal and company accounts. An isolated account with no routing domain can be pinned explicitly but has no automatic failover target.

## Configure two ChatGPT subscription accounts

Create one managed Codex profile per ChatGPT account. Give both profiles the same routing domain only if either account is an acceptable replacement for projects in that domain.

```bash
tokenless accounts add \
  --provider chatgpt \
  --account chatgpt-one \
  --routing-domain personal-subscriptions \
  --json

tokenless accounts login \
  --provider chatgpt \
  --account chatgpt-one \
  --json

tokenless accounts add \
  --provider chatgpt \
  --account chatgpt-two \
  --routing-domain personal-subscriptions \
  --json

tokenless accounts login \
  --provider chatgpt \
  --account chatgpt-two \
  --json
```

Complete each provider-owned login with the intended ChatGPT account. Codex alone reads and writes the authentication state in that profile. Tokenless verifies account identity through the official client boundary, persists only a keyed local fingerprint, and rejects two managed profiles that resolve to the same identity.

The ambient login used by a plain `tokenless run --mode direct` command is deliberately not imported. To use that same ChatGPT account in the unified project API, complete the managed `accounts login` flow for one of the profiles above.

Pin different projects to different accounts:

```bash
tokenless projects pin \
  --project project-alpha \
  --provider chatgpt \
  --account chatgpt-one \
  --json

tokenless projects pin \
  --project project-beta \
  --provider chatgpt \
  --account chatgpt-two \
  --json
```

The default failover policy is `availability-first`. Add `--failover-policy strict` when the project must stop instead of moving to another eligible account.

## Configure public API accounts

Public API accounts use the same project binding model. The CLI returns the exact environment-variable name for each account:

```bash
tokenless accounts add \
  --provider claude \
  --driver api \
  --account claude-one \
  --routing-domain company-anthropic \
  --max-concurrency 2 \
  --json

tokenless accounts add \
  --provider claude \
  --driver api \
  --account claude-two \
  --routing-domain company-anthropic \
  --max-concurrency 2 \
  --json

export TOKENLESS_DIRECT_ACCOUNT_CLAUDE_CLAUDE_ONE_API_KEY=...
export TOKENLESS_DIRECT_ACCOUNT_CLAUDE_CLAUDE_TWO_API_KEY=...

tokenless projects pin \
  --project project-alpha \
  --provider claude \
  --account claude-one \
  --json
```

The environment name is deterministic:

```text
TOKENLESS_DIRECT_ACCOUNT_<PROVIDER>_<ACCOUNT_ID_WITH_UNDERSCORES>_API_KEY
```

Credential values are accepted only from the broker process environment. They are not accepted as CLI arguments and are not written to the account registry, audit log, broker output, or response headers.

## Start the unified local API

Use a random local bearer key and the same Tokenless home used for account administration:

```bash
export TOKENLESS_DIRECT_SERVER_KEY="$(openssl rand -hex 32)"

tokenless serve \
  --mode direct \
  --home "$HOME/.tokenless" \
  --host 127.0.0.1 \
  --port 8788 \
  --json
```

Every request must include the local bearer key. `x-tokenless-project` enables project routing; it is a routing key, not an authorization credential.

```bash
curl http://127.0.0.1:8788/v1/responses \
  -H "Authorization: Bearer $TOKENLESS_DIRECT_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -H "x-tokenless-project: project-alpha" \
  --data '{"model":"gpt-5.3-codex-spark","input":"Reply with OK","store":false}'
```

For OpenAI-compatible routes, an exact lowercase `x-tokenless-provider` selects a supported alternate provider where the route contract is ambiguous. Protocol-specific Claude, Gemini, and Antigravity paths infer their provider. Callers cannot select an account, profile, credential environment, driver, or routing domain through an HTTP header.

Requests without `x-tokenless-project` retain the legacy single-credential broker behavior and use `TOKENLESS_DIRECT_<PROVIDER>_API_KEY`.

## Optional automatic assignment

Explicit pinning is recommended when account placement is part of project policy. An operator may also authorize first-use assignment for unbound API projects by configuring one provider routing domain in the broker process:

| Provider | Environment variable |
| --- | --- |
| ChatGPT | `TOKENLESS_DIRECT_CHATGPT_ROUTING_DOMAIN` |
| Claude | `TOKENLESS_DIRECT_CLAUDE_ROUTING_DOMAIN` |
| Gemini | `TOKENLESS_DIRECT_GEMINI_ROUTING_DOMAIN` |
| Grok | `TOKENLESS_DIRECT_GROK_ROUTING_DOMAIN` |
| Antigravity | `TOKENLESS_DIRECT_ANTIGRAVITY_ROUTING_DOMAIN` |

Without an explicit binding or one of these operator variables, an unbound public-API request fails closed. The caller cannot supply a routing domain. A ChatGPT `/v1/responses` request may instead use an existing explicit `official-codex` binding.

## Failover behavior

| Observation | Binding change |
| --- | --- |
| Account disabled by the operator | Migrate before dispatch when policy and domain permit |
| API credential missing or locally invalid | Mark unavailable and migrate before dispatch |
| Complete, exact provider credential-rejection contract | Preserve the current status and body without replay; migrate on a later request |
| Managed Codex profile is proven logged out, wrong-account, or otherwise account-local unavailable before prompt dispatch | Migrate before dispatch when safe |
| Queue full, queue timeout, or account concurrency occupied | Never migrate |
| HTTP 403, 429, quota, rate limit, 5xx, network timeout, malformed response, or truncated response | Never migrate |
| Failure after a managed prompt may have been delivered | Never replay and never migrate automatically |
| Old account is repaired or re-enabled | Keep the replacement binding |

Each API account has a bounded FIFO queue and a fixed concurrency limit. The selected account's slot remains occupied for the complete response stream. Busy work waits or fails according to the configured bound; it never spills to another account. Managed ChatGPT profiles are single-flight and also share a global inference fence so Tokenless does not aggregate subscription concurrency across accounts.

## Semantic isolation boundary

Project affinity isolates account selection and managed profile state. The managed ChatGPT route accepts only a bounded stateless text subset, starts Codex in an empty temporary workspace, and rejects continuation identifiers, tools, files, images, remote connectors, and unsupported controls.

The public API proxy is byte-preserving and intentionally does not rewrite request bodies. Conversation identifiers, provider-side storage fields, and retention behavior in an opaque public API request remain the caller's and provider's responsibility. `x-tokenless-project` does not erase semantic state that the caller explicitly puts in the body.

## Operations and recovery

```bash
tokenless accounts list --provider chatgpt --json
tokenless accounts status --provider chatgpt --account chatgpt-one --json
tokenless projects resolve --project project-alpha --provider chatgpt --json
tokenless projects list --json
tokenless accounts audit --provider chatgpt --json
```

After repairing an account, clear its durable health explicitly:

```bash
tokenless accounts clear-health \
  --provider chatgpt \
  --account chatgpt-one \
  --json
```

Clearing health makes the account eligible for future assignments and failovers. It does not move projects that already migrated. Use `projects pin` for an intentional reassignment.

The detailed state, locking, and migration contract is in [Account Pool and Project Routing RFC](./account-pool-rfc.md).
