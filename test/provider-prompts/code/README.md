# Code Benchmark Prompt Collection

This directory is the single source of code prompts used by local, integration, and real-provider tests.

## What is pinned

| Collection | Tasks | Role |
| --- | ---: | --- |
| `code-smoke` | 8 | Low-cost transport, response-read, and basic coding checks. It is not a coding-quality benchmark. |
| `code-core` | 20 | Representative generation, repair, library/API, and code-reasoning evidence. |
| `code-agent` | 0 | Disabled until each task has a complete repository checkout, patch, and official-test boundary. |

The first standalone revision contains 26 unique tasks: LiveCodeBench 12, BigCodeBench-Instruct 6, EvalPlus MBPP+ 4, and CRUXEval 4. Two CRUXEval tasks belong to both smoke and core.

## Standard workflow

```powershell
npm run benchmark:code -- validate
npm run benchmark:code -- list --collection code-smoke
npm run benchmark:code -- prompt --task bigcodebench:v0.1.4:4
npm run benchmark:code -- materialize --task bigcodebench:v0.1.4:4
npm run benchmark:code -- evaluate --task bigcodebench:v0.1.4:4 --response-file response.txt
```

Tests select an immutable task ID. Job correlation stays in `taskId`, `jobId`, and `requestId`; it is never appended to the provider prompt.

`materialize` is an explicit network action. It downloads the pinned source artifact, verifies the file and record hashes, and writes only the selected record under ignored `test-results/code-benchmark-cache/`. Pinned Parquet files are parsed directly; the workflow does not read rows from a moving default branch. Hidden tests and gold code remain in the ignored cache and are never returned by `prompt`.

Code execution uses a digest-pinned Docker image with networking disabled, a read-only root filesystem, dropped capabilities, bounded memory/CPU/PIDs, and a disposable working directory. Pull the exact images shown by `npm run benchmark:code -- status` before evaluation; the evaluator does not silently switch images.

## Licensing boundary

Vendored prompts must have verified repository, dataset, and upstream-content licenses. LiveCodeBench's dataset card declares only an unspecified `cc` license and its selected statements come from AtCoder, so those 12 prompts are `reference_only` and are unavailable until explicitly materialized.

See [`manifest.json`](manifest.json) for per-task provenance and [`attributions/`](attributions/) for source notices.
