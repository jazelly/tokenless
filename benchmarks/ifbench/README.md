# IFBench

[简体中文](README.zh-CN.md)

This lane measures precise instruction following through the official IFBench verifier and the local Tokenless API. It is intentionally a small, provider-specific OpenAI-compatible runner: it does not implement an agent loop, MCP tools, browsing, or a shared benchmark abstraction.

## Pinned contract

| Item | Value |
| --- | --- |
| Repository | `https://github.com/allenai/IFBench.git` |
| Commit | `fcd289db21d43aaa96c6d9291d32561cd6e19305` |
| Dataset | `data/IFBench_test.jsonl`, 300 tasks, digest in `revision.json` |
| Verifier | Upstream `run_eval.py` using the checkout's `uv.lock` |
| Main metric | Prompt-level loose accuracy |
| Attempts | One request per task, serial, zero retries |
| Wiring task | Official key `17` |

IFBench combines WildChat-style prompts with deterministic verifiers. The pinned test set uses the IFBench and classic IFEval instruction registries (83 verifiers in this revision); a task passes at prompt level only when every verifier attached to that prompt passes.

The strict verifier checks the response exactly as returned. The loose verifier checks a small official set of harmless formatting variants (including removing a first or last line and asterisks). The reported paper metric is prompt-level loose accuracy; strict accuracy and instruction-level accuracy are secondary diagnostics. There is no LLM judge.

## Commands

```sh
npm run benchmark:ifbench -- inspect
npm run benchmark:ifbench -- prepare --checkout /path/to/IFBench
npm run benchmark:ifbench -- wiring \
  --checkout /path/to/IFBench \
  --home /path/to/tokenless-api-home \
  --api-base <openaiDefault-from-api-proxy-status> \
  --provider chatgpt
npm run benchmark:ifbench -- full \
  --checkout /path/to/IFBench \
  --home /path/to/tokenless-api-home \
  --api-base <openaiDefault-from-api-proxy-status> \
  --provider chatgpt
npm run benchmark:ifbench -- score \
  --checkout /path/to/IFBench \
  --responses benchmarks/ifbench/results/<run-id>/responses.jsonl
```

Run `prepare` against the external checkout before a real run. It fails closed if the checkout HEAD, test dataset digest, or `uv.lock` digest differs from `revision.json`, then installs with `uv sync --frozen`. Real runs also repeat this preflight before submitting the first provider turn.

`wiring` defaults to key `17` (`Is it plausible that frequent hardship can make a society more resilient? Include exactly 2 numbers in the response.`). It proves the Tokenless API-to-official-verifier wiring only; it is not a formal benchmark score. `full` always sends all 300 pinned tasks and is the only command intended to produce the 300-task score.

The proxy must be enabled in the persisted Tokenless API `config.json` before either run. Read `apiProxy.endpoints.openaiDefault` from `tokenless api-proxy status --json` and pass that value as `--api-base`; do not hardcode a port. The runner reads the bearer from the selected home's `daemon.token`, keeps it only in memory, requests `model=tokenless/<provider>`, uses browser execution, one serial request at a time, and never retries a submitted turn. It does not send `temperature`, `top_p`, `seed`, or token-limit sampling controls: the Tokenless browser API cannot honor those controls, so provider/browser settings remain outside this score.

Raw official-compatible `responses.jsonl`, official strict/loose verifier JSONL, and metadata are written to the gitignored `benchmarks/ifbench/results/<run-id>/`. `tokenless-run.json` contains no prompt, response, bearer, or credential; it records the revision, actual task count, per-task status, and any safe `job_id`/routing metadata returned by the API. A failed request produces an empty official response and no retry, then leaves the evidence in place and exits nonzero.

`score` runs the same upstream verifier against an existing response JSONL. Use `--task <key>` when scoring a subset; without it, the pinned 300-task dataset is evaluated, so missing responses count as failures under the official verifier.
