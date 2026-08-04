# Optional Output Savings Measurement

Priority: P1  
Lifecycle: active  
Delivery status: v1 implemented; cross-provider calibration and published benchmarks remain active  
Last reviewed: 2026-08-04

## Outcome

Give users an honest, durable estimate of the output tokens Tokenless avoided returning through an upstream agent, without intercepting private provider APIs, estimating input context, or imposing tokenizer cost on users who did not opt in.

## Product Decisions

- Measure the complete normalized visible assistant text at the shared `response.read` boundary before Tokenless applies its public response-length bound.
- Count output only. File context, prompt construction, hidden provider state, input tokens, hidden reasoning, and provider billing are outside the metric.
- Use one versioned `o200k_base` estimator across providers. Label every value as estimated; never present it as model-specific provider usage or billing truth.
- Attribute each measurement to the exact durable job, response request, estimator revision, and source-text hash. Reconciliation must be idempotent across retries and daemon restarts.
- Keep collection disabled by default and out of setup. Only an explicit dashboard or `tokenless savings enable` action may download and enable the tokenizer.
- Do not call private provider backend APIs. Provider adapters continue to own visible DOM extraction; metering is injected once at the provider-neutral response boundary.

## Runtime Envelope

The v1 runtime is `tiktoken-o200k_base-1.0.22`:

- download: 10,611,708 bytes from the pinned npm artifact;
- installed selected payload: 3,413,323 bytes;
- implementation: deterministic WebAssembly tokenizer plus vocabulary, not a local AI model;
- hardware: CPU only, no GPU;
- execution: short-lived Node.js worker, serialized to one concurrent measurement;
- input guard: 4 MiB maximum visible UTF-8 text per response;
- worker guard: 10-second timeout and bounded output;
- integrity: pinned archive and selected-file SHA-256 verification, safe archive paths, private permissions, atomic installation, and an installed self-test.

The tokenizer payload is not a package dependency and is not included in the Tokenless npm artifact. Status, setup, normal configuration, and disabled provider runs must not create the tokenizer directory.

## Durable Model

`output_savings_events` stores one measurement per `(job_id, response_request_id, estimator_revision)`. The source text is not duplicated in the measurement table; only its SHA-256 digest, visible character count, estimated tokens, basis, revision, and timestamp are stored. A durable clear transaction tombstones known measurement identities, strips embedded measurement envelopes from completed job results, records a time cutoff for in-flight work, and deletes aggregate events so recovery cannot resurrect cleared history.

Job details expose their own measurements. The local control plane exposes aggregate token, response, character, and job counts, plus first and last measurement times.

## User Controls

```text
tokenless savings status
tokenless savings enable
tokenless savings disable
tokenless savings clear --confirm-delete
tokenless savings uninstall --confirm-delete
```

`disable` preserves the runtime and history for cheap re-enablement. `clear` preserves configuration and runtime. `uninstall` disables collection and removes the runtime. Doctor treats disabled as healthy and reports enabled-without-ready-runtime as an error.

## Acceptance Evidence

- Real packaged CLI download, archive verification, self-test, known token count, disable, tamper detection, and uninstall.
- Real SQLite completion, restart, duplicate reconciliation, job attribution, clear cutoff, and cascade behavior.
- Real loopback UI session, CSRF, OpenAPI validation, bilingual controls, default no-download behavior, and Chromium rendering.
- Package tarball proof that no WASM or encoder payload ships in npm.
- Checked-in GitHub Actions matrix for Node.js 22.13 on Ubuntu, macOS, and Windows.
- Applicable real-provider release gates must demonstrate that enabling collection adds a measured result to a real visible `response.read` outcome without changing provider success semantics.

## Remaining Work

- Run and retain the Windows x64 CI and real-hardware evidence before claiming Windows release acceptance.
- Publish estimator-error bands across representative languages, providers, and model families.
- Consider additional estimator revisions only when calibration proves that one shared estimator is materially misleading; never infer a provider model tokenizer from a display label alone.

## Latest Live Evidence

On 2026-08-04, the dedicated Cloak live-provider profile completed a real Kimi visible chat through the built CLI and packaged daemon. The exact 45-character visible response was measured as 16 `o200k_base` tokens, persisted as one event for its exact job and response request, and returned by `tokenless savings status`. The feature was then disabled and its runtime uninstalled from the test home. A preceding ChatGPT attempt failed at the existing visible prompt-input boundary with `prompt_input_failed`; it produced no response and is not counted as output-savings acceptance evidence.
