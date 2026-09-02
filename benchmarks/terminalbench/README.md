# Terminal-Bench 2.0

[简体中文](README.zh-CN.md)

This lane measures the `DeepSeek Harness + Tokenless API + Tokenless Harness adapter` integration. DeepSeek Harness keeps its native agent loop, terminal tools, session, and compaction; Tokenless API supplies `tokenless/auto` model turns, and a native DSH `subagent` call may delegate a child task to Tokenless Harness.

## Fixed baseline

| Item | Value |
| --- | --- |
| Harbor | `0.22.0` |
| Dataset | `terminal-bench/terminal-bench-2` at the digest in `revision.json` |
| Tasks | 89 |
| Phase gate | `sweep`: `k=1` per task, 89 trials, verifier reward 1 required |
| Formal attempts | `full`: `k=5` per task, 445 trials |
| Harbor trial retries | 0 |

The runner does not change official task instructions, timeouts, resources, environments, or verifiers. A task container receives only a random task-scoped bearer for OpenAI completions and private Harness provider turns; the host daemon admin bearer and provider browser session remain on the host.

For this combined lane, the bridge constrains the first DSH parent decision to one structurally read-only `read` inspection, then constrains the next eligible decision to DSH's native named `subagent` tool. The child Tokenless Harness run starts with exactly one read-only workspace search probe inside the official task filesystem, then uses one comprehensive read-only inspection batch and returns the best task-relevant result on the following turn. The DSH parent must batch independent permitted changes before final verification; finite allowed-change spaces with a local verifier use one terminal search script whose own monotonic deadline and verifier counter cap the combined search and final verification at 64 executions and 120 seconds, track and preserve the best candidate by a numeric verifier result, and never enumerate a power set or launch a second search. When a machine-readable allowlist or mapping constrains mutations, the script preserves the original, generates candidates only from parsed permitted transformations, validates each complete candidate against that source before any metric or verifier, and never substitutes model-inferred equivalents. If every allowlist or mapping entry is a single whitespace token, validation also preserves the original whitespace-token count and compares positions: unchanged tokens must be exactly identical, and each changed token must belong to the parsed family of the original token; any violation is rejected before the metric or verifier and that candidate is never retained as the best or final candidate. Final verification runs the complete provided verifier or test suite, and only validated task-permitted candidates may be retained. The benchmark child registry exposes only `workspace.read` and `workspace.search`; no MCP server or writable tool binding is supplied, so the DSH parent remains responsible for task mutations and final verification. These constraints apply only to this benchmark adapter; official task text and ordinary Tokenless Harness behavior are unchanged.

Deep integration is established only by a host-observed, ordered HTTP/process chain: the initial parent read-only inspection completion and routing finish; a later parent completion request is forced to the native named `subagent` tool and completes; a child bootstrap turn and its terminal provider routing complete; one or more child continuation turns may execute on the same provider conversation, with terminal routing recorded for each; a later parent completion and routing complete; then the DSH process returns. The continuation boundary proves that a real child result was delivered back into the parent flow, but does not claim a direct child-tool execution trace. Provider response Markdown is normalized only at the DSH transport boundary so the strict OpenAI-compatible JSON envelope can be validated.

## Commands

```sh
npm run benchmark:terminalbench -- inspect
npm run benchmark:terminalbench -- observe \
  --job-dir benchmarks/terminalbench/results/<job-name>
npm run benchmark:terminalbench -- oracle \
  --jobs-dir benchmarks/terminalbench/results
npm run benchmark:terminalbench -- sweep \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-20260826-auto-v2.json \
  --jobs-dir benchmarks/terminalbench/results
npm run benchmark:terminalbench -- wiring \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-20260826-auto-v2.json \
  --jobs-dir benchmarks/terminalbench/results
npm run benchmark:terminalbench -- full \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest benchmarks/terminalbench/observations/semantic-manifest-20260826-auto-v2.json \
  --jobs-dir benchmarks/terminalbench/results
```

The tracked harness, adapter, pinned manifests, and bilingual documentation live in `benchmarks/terminalbench`. Harbor jobs default to the ignored `benchmarks/terminalbench/results/`; an explicit `--jobs-dir` must stay in that directory or one of its subdirectories. The ignored `benchmarks/terminalbench/observations/` directory holds the local semantic manifest and bounded run observations, while `cache/` holds generated runtime artifacts. The legacy `runs/` directory is not an output location.

Every settled run that produces `tokenless-run.json` also produces `observations/<job-name>/run-observation.json`. The runner constructs and validates this ignored artifact against `observation.schema.json`; `observe` applies the same deterministic collector to an existing compatible result job and never overwrites evidence.

The observation separates official verifier outcomes from routing outcomes. It records the selected profile and run-pinned execution mode, Harbor run/trial/stage timing, every ordered provider interaction and fallback reason, submission and failure rates, visible limit evidence, estimated token usage, response character counts and hashes, and SHA-256 correspondence to the source result/audit files. New DeepSeek Harness runs pin `executionMode` in `tokenless-run.json`; an older report without that field records it as `unavailable` instead of attributing today's configuration to a past run. Collection is code-driven and metadata-only: v4 does not prove per-provider latency, token values are estimates rather than provider billing usage, and prompt or response bodies are never stored.

`wiring` runs one unchanged official task with `k=1`. `sweep` runs all 89 unchanged official tasks once (`k=1`, one concurrent trial, zero Harbor retries) and is a phase gate: it is successful only when all 89 trials settle without infrastructure errors/cancellations/retries, have complete deep chains, and receive verifier reward `1`. `full` always runs all 89 tasks with `k=5`, one concurrent trial, and no Harbor retry. The committed task manifest pins every official task name to both its Harbor task ref and full instruction digest. The DeepSeek Harness commands require the semantic manifest at the local `observations/` path shown above (or another explicitly selected manifest) whose 89 sorted entries match those instruction digests; entries contain only the full instruction digest, `preferredProvider`, bounded `taskType`, `complexity` (`low`/`medium`/`high`), and `truncated`, plus a deterministic whole-manifest digest. The DSH adapter identity stays fixed, while every parent and child model turn requests `tokenless/auto`; the manifest preference is advisory and can reorder providers only within the operation router's highest current eligibility tier. The benchmark profile disables DSH model-request retries and lets the Tokenless API deadline settle first, so a submitted turn is never replayed while its exact local job is still active. Each job writes a non-secret `tokenless-run.json` with the semantic manifest digest; the report keeps per-provider routing counts separate from official verifier rewards, discloses `deepIntegration.trialsWithCompleteChain`, and lists proven exceptions that occurred before provider routing under `preRoutingExceptions`. A DSH command failure is an agent outcome and proceeds to the official verifier instead of becoming an infrastructure exception; failed sweep evidence remains in its job directory and the command exits nonzero.

`deepIntegration` reports host-observed parent completion requests, child bootstrap/continuation starts, terminal provider routing, complete ordered chains, `successfulDshParents`, `failedDshParents`, and `unsettledParentCompletionRequests`. A successful route becomes terminal evidence after its complete response body has been relayed; a failed upstream response is recorded before relay so a client disconnect cannot erase its routing and token estimate. `providerRouting.scopes.parent.providers` and `providerRouting.scopes.child.providers` keep parent and child counters separate: `routed`, `attempted`, `submitted`, `rateLimited`, `fallbackOut`, `completed`, `failed`, `preferenceRequested`, `preferenceHonored`, and estimated input/output/total tokens. `fallbackOut` counts a source provider abandoned for a fallback and also counts as `failed=1`; a `rate_limit` attempt increments `rateLimited` only for that source provider. The final provider counters describe only its own terminal outcome. The `sweep` gate additionally requires one successful DSH parent completion and one terminal parent route for every trial; `wiring` and `full` retain these outcome fields for diagnosis without treating a verifier reward of `0` as a Harbor infrastructure error.

Every route attempt and final provider interaction records `observedAt`, `providerSubmitted`, and an `o200k_base` estimate over the serialized benchmark input and visible assistant output. The report pins the estimator revision and labels these values as estimates, not provider billing usage; missing interaction estimates invalidate a non-oracle report. `accountPlans` records only the configured profile's catalog-resolved plan ID, catalog-matched observed label, tier class, and `checkedAt` for providers used by the run, never account names or unmatched persisted labels.

Every visible rate or plan limit records a bounded detector proof ID, `minute | hour | day | week | unknown`, visible retry-after when present, and the interaction's estimated tokens. Generic live-DOM detection covers rate limits, too-many-requests, temporary unavailability, hourly/daily/weekly caps or limits, and plan/usage limits. When a formal run exposes a new provider surface, the still-available providers continue through Operation Router; the exact persistent provider tab is then inspected and the corresponding detector is updated from that real page. The audit keeps no prompts, responses, task text, credentials, browser session values, full DOM, screenshots, or page copy.

Every non-oracle trial must contribute either a non-empty, valid `deep-integration.jsonl` or a proven pre-routing exception from the official Harbor result. A pre-routing exception does not create a provider attempt; `sweep` still fails when one occurs. `sweep` additionally requires one complete host-observed chain, one successful DSH parent outcome, and one terminal parent route per trial; `wiring` and `full` retain incomplete but valid audit outcomes for reporting. Missing or invalid evidence fails the report instead of being skipped. Optional DSH failure diagnostics are classification-only JSON with a bounded classification and exception class name; raw DSH stdout, stderr, exception messages, and provider output are never retained.
