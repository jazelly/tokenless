# 下载式图片资产闭环

状态：Active  
优先级：P0  
最后更新：2026-08-16

## Goal

让 Tokenless 的图片生成结果成为真实下载、可校验、可再次读取的本地 asset，而不是只返回 provider 临时 URL。先闭环 LM Arena，再用同一边界逐个接入经过真实网页验证的 provider。

## V1 Boundary

第一里程碑只完成一条端到端路径：Arena Direct Image 生成一张图片，Tokenless 从当前 assistant turn 识别终态图片，通过当前 browser session 下载 bytes，并写入与 task、conversation、job 和生成时间关联的本地目录。

V1 不增加队列、重试、恢复、去重、迁移、跨机器同步、asset GC、通用对象存储或历史结果兼容层。其他 provider 只在 Arena 路径通过后逐个增加独立真实验证切片。

## Asset Layout

```text
<tokenless-home>/assets/<task-id-or-unscoped>/<conversation-id-or-new>/<utc-timestamp>_<job-id>/
  <index>.<verified-extension>
```

公开结果返回相对于 Tokenless home 的 asset reference，不暴露 provider credential。每个 asset 至少记录实际 media type、byte size、SHA-256、宽高、生成时间、provider、job、task 和 conversation identity。

## Mission Assertions

| ID | Observable correctness | Evidence |
| --- | --- | --- |
| IMG-001 | Arena 图片生成仍只读取当前 assistant turn 的终态图片。 | 真实 Arena browser run；结果 URL 与当前 turn 可见图片一致。 |
| IMG-002 | 成功的图片生成在 job 完成前把真实 image bytes 写入 task-scoped asset 目录。 | built CLI + packaged daemon run；本地文件存在且非空。 |
| IMG-003 | 返回的 media type、byte size、SHA-256 和宽高与落盘文件一致。 | 从公开 job result 读取 metadata，并独立读取文件验证。 |
| IMG-004 | 下载使用选定 provider/browser session，不把 cookie、token 或 auth header 写入结果、日志或文件名。 | diff 审查与真实 run 输出检查。 |
| IMG-005 | 图片不可下载、不是有效图片或 metadata 不一致时明确失败，不返回成功 artifact。 | 真实边界遇到的失败或最小 filesystem/HTTP integration evidence；不使用 provider fixture。 |
| IMG-006 | `artifact.download` 只在真实下载闭环完成的 provider 上 routeable。 | capability list 与真实 provider E2E。 |
| IMG-007 | 每个新增 provider 都分别证明生成、终态识别、下载、落盘和重新读取；未闭环 provider 保持不公开。 | 每个 provider 的 focused real-provider E2E report。 |
| IMG-008 | 已认证的 daemon asset 接口可按返回 reference 重新读取图片 bytes 与正确 Content-Type，且不能越出 Tokenless asset root。 | 真实 daemon HTTP GET 与落盘文件 digest 对比；路径越界请求明确失败。 |

## Delivery Slices

1. Arena downloaded asset（完成于 2026-08-16）：定义最小 asset result、目录与落盘流程，并完成 IMG-001 至 IMG-006、IMG-008。
2. Meta AI downloaded asset（完成于 2026-08-16）：复用 browser-session writer，读取最新 assistant image tile 并提供 authenticated daemon readback；focused real-provider E2E 已完成 IMG-007。
3. ChatGPT downloaded asset（完成于 2026-08-16）：复用 shared browser-session writer，读取最新 assistant turn、按 canonical image URL 去重并提供 authenticated daemon readback；focused real-provider E2E 已完成 IMG-007。
4. Grok downloaded assets（完成于 2026-08-16）：进入独立 Imagine Image surface、精确选择 ×2 output，以提交前 post set 做差集并等待两个新 post identity，忽略 data-URI preview，逐个打开 post 并下载与 asset ID 精确匹配的 HTTPS 图片；focused real-provider E2E 已完成 IMG-007。
5. Specialist surfaces：Gemini、Dola、Doubao、Perplexity、Qwen 按真实可用账号和 terminal artifact evidence 逐个闭环。
6. GPT4Free parity：把已验证的 `images/generations` bytes 规范化到同一 asset result；不把 raw endpoint 存在当成 provider 支持证据。

## Verified Evidence

- Arena real-provider report：`test-results/live-provider-e2e/20260816T011115Z_3c8dc994-mutation.json`。
- 真实生成 JPEG：1024×1024、89,211 bytes、SHA-256 `bbcfa1ea13e53f05c1dfa326dee64bfeba3834f484738600af15f7c3d7df1757`。
- 真实编辑 PNG：1333×1180、876,989 bytes、SHA-256 `d7b5fc6d76ec6f04a9fd68b42391afec1cc9cef4a9e82541f6317e3ce9f33d4a`。
- 两个结果均验证 current assistant bytes、0600 落盘文件、browser decoder 尺寸、authenticated daemon GET 与 traversal rejection。
- Meta AI real-provider report：`test-results/live-provider-e2e/20260816T015924Z_d46b6c2a-mutation.json`。
- 真实生成 PNG：1600×1600、181,001 bytes、SHA-256 `142b4cd915c943cd58d2965b1520bcda842deb5e5903d0b62209c76b539fbe1f`；验证 latest assistant DOM bytes、0600 文件、browser decoder 尺寸与 authenticated daemon GET。
- ChatGPT real-provider report：`test-results/live-provider-e2e/20260816T022709Z_9982f311-mutation.json`。
- 真实生成 PNG：1254×1254、759,677 bytes、SHA-256 `536f63f2b7585114303c0f26ad30f76db0e058d0d34589168bfa4a5dd5e9cc96`；验证 latest assistant URL 去重、DOM bytes、0600 文件、browser decoder 尺寸与 authenticated daemon GET。
- Grok real-provider report：`test-results/live-provider-e2e/20260816T034454Z_27b6e8f2-mutation.json`。
- 真实生成 JPEG：768×1152、79,032 bytes、SHA-256 `e7e02f71df1b76592da6c98a3d0db94a88a71f46a13c840b97490245a360dd74`；第二张 JPEG：768×1152、63,638 bytes、SHA-256 `252ffa4a56a7d3bc042e252f4061804b7ff7eb8719e088b8ead22699ef9cea64`。两张图片均验证 baseline set-difference、current post identity、provider bytes、0600 文件、browser decoder 尺寸、无 task/Project chat mapping 与 authenticated daemon GET。

## Constraints

- 所有 provider 验证必须使用真实网站、built CLI、packaged daemon、选定 persistent profile 与 provider network。
- 网页交互只使用 `ego-browser`；不自动登录、不处理 CAPTCHA、不切换 profile。
- 不保存 screenshot、完整 DOM、provider session value 或无关账号内容作为 evidence。
- 代码、schema、路径字段和用户可见产品文案使用英文；用户可见新增文案同时提供英文和简体中文。
- 每个里程碑通过独立 review、真实边界验证和单一 conventional commit 后再进入下一个 provider。

## Stop Condition

全部可访问 provider 完成真实闭环；或某 provider 连续真实运行被登录、CAPTCHA、额度、地区或 provider terminal failure 阻塞。阻塞项保留明确证据并维持 unavailable，不以 fixture、模拟响应或推断替代。
