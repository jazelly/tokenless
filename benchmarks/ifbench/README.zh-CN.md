# IFBench

[English](README.md)

这条 lane 通过官方 IFBench verifier 和本地 Tokenless API 测量精确指令遵循能力。它刻意保持为一个小型、按 provider 运行的 OpenAI-compatible runner：不实现 agent loop、MCP 工具、浏览器搜索，也不建立通用 benchmark 抽象。

## 固定契约

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/allenai/IFBench.git` |
| Commit | `fcd289db21d43aaa96c6d9291d32561cd6e19305` |
| 数据集 | `data/IFBench_test.jsonl`，300 道题，digest 见 `revision.json` |
| Verifier | 上游 `run_eval.py`，使用 checkout 自带的 `uv.lock` |
| 主指标 | prompt-level loose accuracy |
| 尝试策略 | 每题一次请求、串行、零重试 |
| Wiring 题 | 官方 key `17` |

IFBench 把 WildChat 风格的 prompt 与确定性的 verifier 组合起来。本 revision 的固定测试集使用 IFBench 和经典 IFEval instruction registry（共 83 个 verifier）；只有该 prompt 上挂载的全部 verifier 都通过时，prompt-level 才算通过。

strict verifier 直接检查模型原样返回的 response。loose verifier 会按照官方实现检查一组有限且无害的格式变体（包括去掉首行或末行、去掉星号）。论文报告的主指标是 prompt-level loose accuracy；strict accuracy 和 instruction-level accuracy 作为次要诊断指标。评测不使用 LLM judge。

## 命令

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

真实运行前，先对 external checkout 执行 `prepare`。如果 checkout HEAD、测试数据集 digest 或 `uv.lock` digest 与 `revision.json` 不一致，命令会 fail closed；通过后使用 `uv sync --frozen` 安装依赖。真实 run 也会在提交第一个 provider turn 前重复这个 preflight。

`wiring` 默认运行 key `17`（`Is it plausible that frequent hardship can make a society more resilient? Include exactly 2 numbers in the response.`）。它只证明 Tokenless API 到官方 verifier 的 wiring 可用，不是正式 benchmark 分数。`full` 始终发送固定的 300 道题，只有它用于产生 300 题分数。

在运行前，必须通过持久化的 Tokenless API `config.json` 启用 proxy。从 `tokenless api-proxy status --json` 读取 `apiProxy.endpoints.openaiDefault` 并作为 `--api-base`，不要硬编码端口。runner 从所选 home 的 `daemon.token` 读取 bearer，仅保留在内存中；它请求 `model=tokenless/<provider>`，使用 browser execution，每次只发送一个请求，并且永不重试已经提交的 turn。它不发送 `temperature`、`top_p`、`seed` 或 token limit 等 sampling controls：Tokenless browser API 无法兑现这些控制，因此 provider/browser 自己的设置不属于本分数的一部分。

原始 official-compatible `responses.jsonl`、官方 strict/loose verifier JSONL 和元数据会写入 gitignored 的 `benchmarks/ifbench/results/<run-id>/`。`tokenless-run.json` 不包含 prompt、response、bearer 或 credential；它记录 revision、实际 task count、每题状态，以及 API 返回时才有的安全 `job_id`/routing metadata。请求失败会写入空的 official response，不重试；证据会保留并以非零状态退出。

`score` 对已有 response JSONL 运行同一个上游 verifier。给子集打分时使用 `--task <key>`；不指定时按固定的 300 题数据集评测，缺失 response 会按照官方 verifier 计为失败。
