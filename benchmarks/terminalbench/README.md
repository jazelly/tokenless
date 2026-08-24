# Terminal-Bench 2.0

[简体中文](README.zh-CN.md)

This lane measures the fixed combination `DeepSeek Harness + Tokenless API + Tokenless Harness adapter`. DeepSeek Harness keeps its native agent loop, terminal tools, session, and compaction; Tokenless API supplies model turns, and a native DSH `subagent` call may delegate a child task to Tokenless Harness.

## Fixed baseline

| Item | Value |
| --- | --- |
| Harbor | `0.22.0` |
| Dataset | `terminal-bench/terminal-bench-2` at the digest in `revision.json` |
| Tasks | 89 |
| Formal attempts | `k=5` per task, 445 trials |
| Harbor and DSH model retries | 0 |

The runner does not change official task instructions, timeouts, resources, environments, or verifiers. A task container receives only a random task-scoped bearer for OpenAI completions, private Harness provider turns, and benchmark audit events; the host daemon admin bearer and provider browser session remain on the host.

For this combined lane, the bridge constrains the first eligible DSH parent decision to DSH's native named `subagent` tool. The child Tokenless Harness run executes exactly one read-only workspace search probe inside the official task filesystem, then returns a fixed integration acknowledgement to the DSH parent, which remains responsible for completing and verifying the task with its own terminal tools. These constraints apply only to this benchmark adapter; official task text and ordinary Tokenless Harness behavior are unchanged.

Deep integration is established only by an ordered, same-run audit chain: Tokenless Harness starts, a real provider turn occurs, a child workspace tool succeeds, the child settles successfully, and the DSH parent later completes. Provider response Markdown is normalized only at the DeepSeek transport boundary so the strict OpenAI-compatible JSON envelope can be validated.

## Commands

```sh
npm run benchmark:terminalbench -- inspect
npm run benchmark:terminalbench -- oracle --jobs-dir <path>
npm run benchmark:terminalbench -- wiring \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --provider deepseek \
  --profile web-ai \
  --jobs-dir <path>
npm run benchmark:terminalbench -- full \
  --home <tokenless-api-home> \
  --dsh-checkout <deepseek-harness-checkout> \
  --provider deepseek \
  --profile web-ai \
  --jobs-dir <path>
```

`wiring` runs one unchanged official task with `k=1`. `full` always runs all 89 tasks with `k=5`, one concurrent trial, no Harbor retry, and DSH provider `maxRetries: 0`. Each job writes a non-secret `tokenless-run.json`; the report discloses `deepIntegration.trialsWithCompleteChain` and requires at least one complete chain before it can substantiate the deep-adapter claim. All 445 verifier rewards must exist with no Harbor trial errors, cancellations, or retries; a DSH command failure is an agent outcome and proceeds to the official verifier instead of becoming an infrastructure exception.
