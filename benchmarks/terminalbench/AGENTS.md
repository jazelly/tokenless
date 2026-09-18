# Terminal-Bench harness rules

## Scope

This directory is the tracked, open-source Terminal-Bench 4.0 harness. The runner, adapters, pinned manifests, and benchmark documentation belong here; keep the harness provider-neutral and pinned to the revisions declared by `revision.json`.

Local execution state is deliberately separate from the tracked harness:

- `results/` contains raw Harbor job directories and is ignored by Git.
- `observations/` contains local semantic manifests and other bounded run observations and is ignored by Git.
- `cache/` contains generated build and runtime artifacts and is ignored by Git.

The runner defaults Harbor jobs to `results/`. An explicit `--jobs-dir` may select only `results/` or one of its subdirectories. `runs/` is a legacy location and must not be used for new output.

## Evidence and privacy

Preserve raw result directories byte-for-byte. Do not rewrite, normalize, backfill, merge, or delete a result unless a verified move or copy has already preserved it and the source is explicitly in scope. Resolve directory-name collisions before any migration.

Use real Harbor, Tokenless API, and provider boundaries for benchmark evidence. Never add provider DOM fixtures, replicas, intercepted responses, synthetic provider pages, mocked provider responses, credentials, browser session values, screenshots, full DOM, prompts, responses, or unrelated account content to this directory or its reports. Token estimates must remain labeled as estimates rather than provider billing usage, and infrastructure exceptions must remain explicit outcomes rather than fabricated provider evidence.

Do not claim a benchmark score from an interrupted, infrastructure-blocked, or incomplete run. Keep the official Harbor verifier result separate from routing observations, and retain failed-run evidence for diagnosis.

Record requested and observed model and effort separately at the actual provider submission boundary. Preserve visible aliases such as `Latest` without inventing an underlying model ID. Missing observations require an explicit reason and must not be presented as a verified model configuration.

Keep official task outcomes, recording completeness, and model-comparison eligibility separate. Record tool proposals separately from observed execution results; timing must identify the boundary actually measured. Native billing usage must remain unavailable when the provider does not expose it, rather than being replaced with token estimates.

Capture the execution source and runtime identities before the run. Preserve a hash inventory of the resulting evidence and task artifacts. Never substitute the current checkout or current browser controls for the state of an earlier run.

Generate `observations/<job-name>/run-observation.json` only through the harness collector and validate it against the tracked `observation.schema.json`. The observation must remain a deterministic metadata-only projection of the matching result and audit files, include their relative paths and SHA-256 digests, and never rely on an AI-authored summary. Keep official rewards, routing outcomes, timing, token estimates, and their limitations explicit and separate.

## Serial execution

Run one explicitly selected official task at a time. Stop and report the official reward, deep integration evidence, exceptions, and result path after each task. Do not start the next task, a sweep, a full run, or a scheduled automation without a new user instruction.

## Reproduction

Before a real run, use `npm run benchmark:terminalbench -- inspect` and `npm run benchmark:terminalbench -- help` to verify the pinned contract and paths. Use the canonical `benchmarks/terminalbench/results` output and the local semantic manifest under `benchmarks/terminalbench/observations` when the run requires one. Do not start provider or Harbor work merely to exercise a parser.

Real reruns require the pinned Harbor version, dataset digest, DeepSeek Harness revision, and an explicitly selected configured Tokenless API profile. Login, CAPTCHA, Turnstile, and Keychain prompts remain manual user actions. Do not silently switch profiles, create disposable browser profiles, or add retries and recovery machinery to compensate for an unavailable environment.

## Documentation

Keep `README.md` and `README.zh-CN.md` structurally and semantically aligned. User-facing commands, path boundaries, evidence rules, and benchmark status must be updated in both languages; this internal rules file remains English.
