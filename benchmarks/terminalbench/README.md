# Terminal-Bench 2.0

[简体中文](README.zh-CN.md)

This lane measures the `DeepSeek Harness + Tokenless API + Tokenless Harness adapter` integration. DeepSeek Harness keeps its native agent loop, terminal tools, session, and compaction; Tokenless API supplies `tokenless/auto` model turns, and a native DSH `subagent` call may delegate a child task to Tokenless Harness.

## Fixed baseline

| Item | Value |
| --- | --- |
| Harbor | `0.22.0` |
| Dataset | `terminal-bench/terminal-bench-2` at the digest in `revision.json` |
| Tasks | 89 |
| Formal attempts | `k=5` per task, 445 trials |
| Harbor trial retries | 0 |

The runner does not change official task instructions, timeouts, resources, environments, or verifiers. A task container receives only a random task-scoped bearer for OpenAI completions and private Harness provider turns; the host daemon admin bearer and provider browser session remain on the host.

For this combined lane, the bridge constrains the first eligible DSH parent decision to DSH's native named `subagent` tool. The child Tokenless Harness run starts with exactly one read-only workspace search probe inside the official task filesystem, then continues the parent's self-contained delegated inspection and returns the real task-relevant result. The benchmark child registry exposes only `workspace.read` and `workspace.search`; no MCP server or writable tool binding is supplied, so the DSH parent remains responsible for task mutations and final verification. These constraints apply only to this benchmark adapter; official task text and ordinary Tokenless Harness behavior are unchanged.

Deep integration is established only by a host-observed, ordered HTTP/process chain: a parent completion request is forced to the native named `subagent` tool and completes; a child bootstrap turn and its terminal provider routing complete; a child continuation turn and its terminal provider routing complete; a later parent completion and routing complete; then the DSH process returns. The continuation boundary proves that a real child result was delivered back into the parent flow, but does not claim a direct child-tool execution trace. Provider response Markdown is normalized only at the DSH transport boundary so the strict OpenAI-compatible JSON envelope can be validated.

## Commands

```sh
npm run benchmark:terminalbench -- inspect
npm run benchmark:terminalbench -- oracle --jobs-dir <path>
npm run benchmark:terminalbench -- wiring \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest <external-semantic-manifest.json> \
  --jobs-dir <path>
npm run benchmark:terminalbench -- full \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --profile web-ai \
  --semantic-manifest <external-semantic-manifest.json> \
  --jobs-dir <path>
```

`wiring` runs one unchanged official task with `k=1`. `full` always runs all 89 tasks with `k=5`, one concurrent trial, and no Harbor retry. The committed task manifest pins every official task name to both its Harbor task ref and full instruction digest. Both commands also require an external semantic manifest whose 89 sorted entries match those instruction digests; entries contain only the full instruction digest, `preferredProvider`, bounded `taskType`, `complexity` (`low`/`medium`/`high`), and `truncated`, plus a deterministic whole-manifest digest. The DSH adapter identity stays fixed, while every parent and child model turn requests `tokenless/auto`; the manifest preference is advisory and can reorder providers only within the operation router's highest current eligibility tier. The benchmark profile disables DSH model-request retries and lets the Tokenless API deadline settle first, so a submitted turn is never replayed while its exact local job is still active. Each job writes a non-secret `tokenless-run.json` with the semantic manifest digest; the report keeps per-provider routing counts separate from official verifier rewards and discloses `deepIntegration.trialsWithCompleteChain`. All 445 verifier rewards must exist with no Harbor trial errors, cancellations, or retries; a DSH command failure is an agent outcome and proceeds to the official verifier instead of becoming an infrastructure exception.

`deepIntegration` reports host-observed parent completion requests, child bootstrap/continuation starts, terminal provider routing, and complete ordered chains. A route becomes terminal evidence only after its complete response body has been relayed successfully. `providerRouting.scopes.parent.providers` and `providerRouting.scopes.child.providers` keep parent and child request counters separate: `routed`, `attempted`, `rateLimited`, `fallbackOut`, `completed`, `failed`, `preferenceRequested`, and `preferenceHonored`. `fallbackOut` counts a source provider whose pre-submit attempt was abandoned for a fallback; that fallback-out also counts as `failed=1`, and a `rate_limit` attempt increments `rateLimited` only for that source provider. `rateLimited` on the final provider describes only its own terminal failure; a completed final provider is always `rateLimited=false`. `completed` and `failed` for the final provider describe its own terminal outcome. Browser provider turns do not expose reliable token usage, so `providerRouting.tokenUsage` explicitly reports `unavailable` rather than fabricating token counts. The observer contains no prompts, responses, task text, credentials, browser session values, or DOM.

Every non-oracle trial must contain a valid `deep-integration.jsonl` and one complete host-observed chain; missing or invalid evidence fails the report instead of being skipped. Optional DSH failure diagnostics are classification-only JSON with a bounded classification and exception class name; raw DSH stdout, stderr, exception messages, and provider output are never retained.
