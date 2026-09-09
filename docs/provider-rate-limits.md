# Provider Rate-Limit Knowledge and Runtime Policy

Last reviewed: 2026-08-02

## Scope

Tokenless maintains its best current knowledge of consumer Web provider limits in [`packages/server/catalog/provider-rate-limits.v1.json`](../packages/server/catalog/provider-rate-limits.v1.json). The catalog does not describe provider API limits, does not correlate one external account across browser profiles, and does not claim to reproduce private provider enforcement.

One managed browser profile is one independent provider-capacity scope. Reaching a real provider limit remains an expected recoverable condition.

## Dashboard rule table

Open **Rate limits** in the Tokenless API Dashboard to filter the catalog by provider, request type, and execution state. Each row shows the plan/model scope, allowance, window, counted actions, and dated sources; missing message, image-generation, and file-upload coverage stays explicit.

The table reads the same server catalog as capacity preflight. `proposedPolicies` holds reviewable internal values only: the ChatGPT 20-message/hour and 10-message/10-minute windows are **not enforced**, and their counting/profile scope is pending. Enforced internal behavior must be configured through persisted `config.json`, not activated by editing these proposals.

Current usage and reset times are not connected to this first table. Existing source dates are preserved; this UI change does not reverify provider quotas.

## Current Runtime Knowledge

| Provider | Official exact numeric rules retained | Runtime interpretation and remaining uncertainty |
| --- | --- | --- |
| ChatGPT | GPT-5.5 Instant for Go/Plus: 160 messages per 3 hours; Go manual Thinking: 10 messages per 5 hours; signed-in uploads: 80 files per 3 hours; Free uploads: 3 files per day | Dynamic Free messages, guarded Pro/Business access, Enterprise/Edu message limits, guest limits, and provider-native model fallback behavior |
| Claude | None | Five-hour session shape, weekly windows, relative Pro/Max/Team multipliers, dynamic usage, and Enterprise consumption behavior |
| Gemini | None | Five-hour and weekly window shapes, relative paid-plan multipliers, compute-based dynamic usage, Workspace limits, and native fallback behavior |
| Grok | None | Qualitative higher-limit statements and unknown numeric consumer Web limits |
| Qwen | None | Unknown numeric consumer Web limits and the published usage-policy constraints |
| DeepSeek | None | Unknown numeric consumer Web limits; API concurrency numbers are explicitly excluded |
| Perplexity | Free Pro Search: 3/day; Enterprise Pro Search: 400/week; Enterprise Max Pro Search: 4000/week | Exact rules remain observe-only until the run can distinguish Pro Search; general/Best-mode behavior, consumer paid weekly ranges, feature usage, uploads, and heavy-usage reductions remain non-numeric |
| Z.ai / GLM | None | Unknown numeric consumer Web limits; separate GLM Coding Plan quotas are explicitly excluded |
| Doubao / 豆包 | None | Unknown numeric signed-in consumer Web limits; API and enterprise product quotas are explicitly excluded |
| Kimi | None | Unknown numeric signed-in consumer Web limits; no numeric allowance is inferred from the interactive usage surface |

The catalog links every fact to an official source. Its current primary sources are OpenAI Help, Anthropic Help, Google Gemini Help, xAI pricing, the Qwen usage policy, the DeepSeek user agreement, Perplexity Help, the official Z.ai GLM announcement, the Doubao feature introduction, and the official Kimi web entry. Exact numbers are executable only when the catalog contains `official_exact` evidence; relative, dynamic, qualitative, guarded, consumption-based, and unknown allowances remain non-numeric at runtime.

## Runtime Interpretation

The runtime resolves the currently observed profile subscription label to a canonical catalog plan. Exact visible labels take precedence; `signed_in_free` may select the provider's Free family; an indistinguishable paid or unknown plan remains `unknown` and never inherits the provider's highest allowance.

For an exact rule, Tokenless:

1. reads immutable `provider_submitted_at` facts from the existing SQLite `jobs` table;
2. derives prompt and attachment units from each structured job request;
3. isolates provider, profile, model family, mode, action, and matching window;
4. applies a 90% planning allowance only when the published allowance is at least 20 units;
5. applies GCRA cadence with a bounded 5% burst, clamped to 2–8 units; and
6. returns `admit` or an explainable `defer` without creating a delayed job.

For every non-numeric or unmatched rule, Tokenless returns `unknown` and allows execution. This preserves uncertainty without manufacturing quotas.

Before provider mutation, a known capacity deferral first consumes an already-filtered automatic provider fallback plan in the current execution. If no in-scope fallback remains, the request fails clearly; it is not delayed or requeued. A visible rate or plan blocker before submission remains a current-execution failure. Proven or ambiguous post-submission work is never replayed on another provider or profile.

The configured provider list is a filter only. Its order does not alter capability, subscription, capacity, fairness, or route selection.

## Stored Facts and Diagnostics

Rate-limit state stays in the existing `jobs` table:

- `provider_submitted_at` is nullable, immutable, and written immediately after visible prompt submission succeeds;
- `provider`, `profile_id`, and `request_json` retain the dimensions needed to reconstruct local usage; and
- `(provider, profile_id, provider_submitted_at)` supports bounded history queries.

No separate rate-limit ledger table exists.

Inspect the next prompt projection with:

```sh
tokenless limits inspect --profile <slug> --provider <provider> --json
```

The output includes the matched plan, match confidence, catalog revision, applicable rules, published and effective allowances, locally observed usage, remaining estimate, cadence, burst allowance, and decision.

## Validation Boundary

Rate-limit acceptance is algorithmic. The focused integration test uses the built CLI, built daemon, real HTTP boundary, profiles from `config.json`, and real SQLite history with controlled timestamps. It verifies subscription matching, exact and non-numeric knowledge, model-pool isolation, sliding windows, remaining capacity, burst cadence, deferral time, and the CLI diagnostic.

It deliberately does not spam provider websites to discover or exhaust quotas. Real provider blockers remain normal runtime evidence, not a release test load generator.

## Maintenance

- Update official source retrieval and review dates when facts are rechecked.
- Preserve uncertainty when an official page stops publishing a number.
- Add a new exact number only with official exact evidence.
- Keep runtime policy parameters separate from provider facts under `runtimePolicy`.
- Run the packaged catalog check and focused rate-limit simulation after every catalog or policy change.
- Add a changeset when a fact or policy change materially changes scheduling.
