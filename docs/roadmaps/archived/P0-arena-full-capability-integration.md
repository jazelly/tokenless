# Arena 全能力接入

Status: completed | Priority: P0 | Started: 2026-08-10 | Completed: 2026-08-11

Disposition: Completed after all ten acceptance assertions passed through the built CLI, packaged daemon, real Arena website, authenticated local HTTP API, and independent review.

Superseded detail: the Arena-only OpenAI-compatible adapter recorded below (`arena:max` on `GET /v1/models` and `POST /v1/chat/completions`) was later folded into the shared local API proxy, where Arena Direct chat is reached as `tokenless/arena` and those two paths became dialect-neutral aliases. The evidence below is preserved as the record of what was proven at completion; see [API Proxy Integration](../../api-proxy-integration.md) for the current surface.

Depends on: [Provider Expansion and Parity](../P0-provider-expansion.md), [Real Provider Browser E2E and Native Projects](../P0-real-provider-browser-e2e-and-native-projects.md), and the existing built CLI, packaged daemon, selected `web-ai` profile, and production CDP path

## 目标

在真实 `arena.ai` 网站上完整接入并验证 Arena 当前高价值能力，同时通过现有 Tokenless task capability、visible action 和 OpenAI-compatible boundary 对外提供不会丢失结果的接口。

## 非目标

- 不读取、导出或记录 cookie、token、隐藏 header、browser storage 或其他凭据。
- 不创建 provider DOM fixture、页面副本、route interception 或模拟响应。
- 不把按钮存在、selector 命中或开始生成当作完成证据。
- 不为假设中的未来 provider 设计通用恢复、重试或迁移框架。

## V1 边界

每个能力先完成一条最小的端到端真实路径：selected profile → built CLI → packaged daemon → production CDP → real Arena website → 可见终态。能力只有在完整 lifecycle 关闭后才进入路由矩阵；未完成能力继续明确为 unavailable 或 unadvertised。

## 验收合同

| ID | 可观察结果 | 证据 |
| --- | --- | --- |
| ARENA-001 | Direct 新对话与同一 `/c/:conversationId` 续聊返回最新逻辑回答 | 两个合理 prompt、同一 conversation URL、第二次读取只返回最新回答 |
| ARENA-002 | 调用方可检查并精确选择一个当前可见模型，选择后回答来自所选 Direct 会话 | built CLI `model.inspect` / `model.select`、可见选中标签、一次实质回答、恢复原选择 |
| ARENA-003 | PDF 和图片输入能被 Arena 可见接受，并产生基于附件内容的回答或编辑结果 | `file.upload`、新增可见 attachment、附件相关 prompt、终态回答或产物 |
| ARENA-004 | Search 返回实质研究回答和可见、规范化 citation 链接 | Search 模式实跑、终态文本、至少一个真实 HTTPS citation |
| ARENA-005 | Image Arena 完成 text-to-image 与 image edit，并返回新生成的可见图片 artifact | 每种流程各一次，生成前后 artifact cursor/delta、可读取 artifact reference |
| ARENA-006 | Battle 与 Side-by-Side 保留两个不同逻辑回答，不静默丢弃任一结果 | 每种 mode 一次合理比较 prompt、两个结果、匿名或已揭示模型状态的真实表示 |
| ARENA-007 | Code Arena 生成可打开的网站结果，并返回预览或代码 artifact | 一次小型网站 prompt、当前 assistant 的生成终态、至少一个可打开预览或代码结果 |
| ARENA-008 | Agent Mode 完成带 web search、文件输出或 sandbox 执行的多步任务 | 一次合理多步任务、可见 tool steps、task-success review panel 与终态结果 |
| ARENA-009 | Video Arena 完成 text-to-video；若当前账户允许，再完成 image-to-video | 终态 video artifact；若 provider quota 阻塞，记录明确的可见 quota 证据并保持未公开 |
| ARENA-010 | 简单单结果能力有 OpenAI-compatible 映射，多结果或长任务能力通过明确扩展保持完整语义 | 真实 HTTP/CLI 请求返回完整文本、citations 或 artifacts；Battle 不被压缩为单一 choice |

## 合理真实用例

- Direct continuation：先要求用三点解释 Adelaide 时区，再追问其中一个具体换算。
- Model choice：要求解释 JavaScript event loop 的 microtask/macrotask 顺序，并给出短例子。
- PDF/image input：上传本任务专用的小型英文 Markdown/PDF 或无敏感信息图片，询问其中明确可验证的内容。
- Search：查询当前 Arena 官方产品能力并要求引用官方来源。
- Image：生成一个无文字的蓝色纸飞机图标；编辑输入图使背景变为浅黄色。
- Battle/Side-by-Side：比较两种 TypeScript API error-handling 设计并给出可执行建议。
- Code：生成一个单页番茄钟，包含开始、暂停和重置。
- Agent：研究两个官方文档页面，写出短 Markdown 对比文件，并用 sandbox 检查文件存在。
- Video：生成一个五秒左右、无人物的纸飞机从桌面起飞动画。

## 里程碑

1. Direct parity：续聊路由、精确模型选择、PDF/图片上传。**完成并通过独立审阅（2026-08-10）**。
2. Research and comparison：Battle、Side-by-Side、Search 与 answer-scoped citations。**完成并通过独立审阅（2026-08-11）**。
3. Generated media：图片生成、图片编辑与 current-answer artifact 读取。**完成并通过独立审阅（2026-08-11）**。
4. Long-running surfaces：Code Arena、Agent Mode 与 Video Arena。**完成并通过独立审阅（2026-08-11）**。
5. Public compatibility：task routes、OpenAI-compatible mapping、双语文档和完整真实回归。**完成并通过独立审阅（2026-08-11）**。

## 当前证据

- Direct 精确选择 `gemini-3-flash` 后完成实质性 JavaScript event-loop 回答，并恢复 `Max`。
- 第二个 CLI process 使用同一 `/c/:conversationId` mapping，只返回第二轮最新回答。
- PNG 在 Direct 显示可见 preview，PDF 在 Battle 显示可见 file card；两次 `file.upload` 均成功，未提前公开 `image.input`。
- `conversation.continue` 缺少 conversation intent、稳定 task identity 或精确 mapping 时，在 managed job 和 browser submission 前 fail closed。
- Slice 1 build、lint、package/routing checks 通过，独立 reviewer verdict 为 `approved`。
- `model.compare` 已在 Battle 与 Side-by-Side 各完成一次实质性 TypeScript API 设计比较；generic `text` 与结构化 `alternatives` 都保留两份完整回答。
- Battle 匿名模型明确返回 `null`；Side-by-Side 仅返回两个可见模型标签，不自动投票、不猜测模型。
- `arena.surface.inspect/select` 已通过 public built CLI 精确选择 mode 与 modality；未闭环的 Direct/Search/continuation/model-control comparison 组合在 daemon 前 fail closed。
- Search reader 修复后，同一真实 conversation 的 public `response.read` 返回实质回答与 5 个 answer-scoped、normalized HTTPS citations；`search.web` 与 `response.citations` 已作为 experimental routes 公开。
- Direct Image 分别返回当前 assistant 的 1024×1024 JPEG generation 与 1372×1146 PNG edit artifact；edit artifact 与可见 source preview 明确不同。
- Direct Code 返回当前 assistant 精确 `Created index.html` 控件所关联的唯一完整代码、HTTPS `arena.site` preview 与可见 download availability；stale/global pane 不作为证据。
- Agent `/agent` run 返回 terminal task-success review panel、当前 response card 的实质回答、answer-scoped 官方 citations 与可见 structured tool steps；automation 未回答 review prompt。
- Video `/video` Battle run 返回两个当前 assistant MP4 alternatives：1280×720/8 秒与 848×480/8.041667 秒；poster、model selection、download 和 continuation 不作为已支持能力。
- 本地 authenticated `GET /v1/models` 返回唯一 `arena:max`。一次真实 non-streaming `POST /v1/chat/completions` 通过 packaged daemon 与 Arena Direct `Max` 返回标准单 choice、完整 event-loop 回答和真实 job identity；多 message 仅做 stateless transcript replay，每个请求都新建 conversation。
- Comparison、Search、Image、Code、Agent 与 Video 的结构化结果保留在 task API，不通过 Chat Completions 压缩或丢弃。

## 约束

- 所有 browser E2E 从 repository `.env` 读取 `TOKENLESS_TEST_CONFIG`，只使用 registry default profile 和 production CDP path。
- 不自动登录、不创建测试账户、不关闭或删除 browser/profile；测试 teardown 只 detach CDP client。
- 不截取 screenshot、完整 DOM、storage、凭据或无关账号内容。
- provider 产生真实 conversation、附件、图片、网站、workspace 文件和视频是本任务明确允许的副作用。
- 测试不内部 retry；失败后先检查真实页面，再进行一次有证据支持的最小修复。

## 停止条件

全部断言获得真实证据并进入相应 capability route 后完成。若某项连续三轮都被同一个用户账户、provider quota、地区或 provider-side availability 阻塞，则保留实现但不公开该 route，记录具体 blocker，并继续其余能力；不得用 fixture 替代。
