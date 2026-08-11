# 代码 Benchmark Prompt Collection

本目录是 local、integration 与真实 provider 测试所使用代码 prompt 的唯一来源。

## 固定内容

| Collection | 题数 | 用途 |
| --- | ---: | --- |
| `code-smoke` | 8 | 低成本验证 transport、response read 与基础代码能力；它不是完整 coding-quality benchmark。 |
| `code-core` | 20 | 代表性的代码生成、修复、library/API 与代码推理证据。 |
| `code-agent` | 0 | 每题具备完整 repository checkout、patch 与 official-test 边界前保持禁用。 |

第一版包含 26 个不重复 standalone task：LiveCodeBench 12、BigCodeBench-Instruct 6、EvalPlus MBPP+ 4、CRUXEval 4。其中 2 个 CRUXEval task 同时属于 smoke 与 core。

## 标准流程

```powershell
npm run benchmark:code -- validate
npm run benchmark:code -- list --collection code-smoke
npm run benchmark:code -- prompt --task bigcodebench:v0.1.4:4
npm run benchmark:code -- materialize --task bigcodebench:v0.1.4:4
npm run benchmark:code -- evaluate --task bigcodebench:v0.1.4:4 --response-file response.txt
```

测试只按不可变 task ID 选题。Job correlation 保存在 `taskId`、`jobId` 与 `requestId`，绝不追加到 provider prompt。

`materialize` 是显式联网操作：它下载固定 source artifact、校验文件与 record hash，并只把所选 record 写入已忽略的 `test-results/code-benchmark-cache/`。固定的 Parquet 文件会被直接解析，不会通过会随默认分支变化的 row API 取数。Hidden tests 与 gold code 留在已忽略缓存中，`prompt` 命令绝不返回它们。

代码执行使用 digest 固定的 Docker image，并关闭网络、设置只读根文件系统、移除 capabilities、限制内存/CPU/PID，使用一次性工作目录。执行前应显式拉取 `npm run benchmark:code -- status` 所列精确 image；evaluator 不会静默切换 image。

## 许可证边界

只有 repository、dataset 与 upstream content 三层许可证均已核验的 prompt 才能 vendored。LiveCodeBench 数据卡只声明了未明确版本的 `cc`，选中题面又来自 AtCoder，因此 12 个 LiveCodeBench prompt 均为 `reference_only`，显式 materialize 前不可用。

逐题 provenance 见 [`manifest.json`](manifest.json)，来源声明见 [`attributions/`](attributions/)。
