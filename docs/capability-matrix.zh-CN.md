# Capability Matrix

[English](capability-matrix.md)

Tokenless Capability Matrix 是 caller outcome 与 provider implementation 之间的公共契约。它让用户无需依赖 provider 的按钮名称即可描述任务，也为贡献者新增或修改 provider support 提供统一的证据标准。

本文档是 capability 命名、mapping、support state 与扩展流程的规范性文档。尚未成为 Tokenless support 的产品调研记录见 [Provider Capability Census](provider-capability-census.md)。

## 三层结构

Tokenless 将三个相关层次明确分开：

1. **Canonical capability catalog** — caller 可以要求的 provider-neutral outcome，例如 `conversation.chat`、`file.upload`、`search.web`。
2. **Provider routes** — 从 canonical capability 到某个 provider strategy 的 evidence-backed mapping。
3. **Live acceptance matrix** — route 对外发布前，必须通过 built CLI、packaged daemon、managed browser 与真实 provider network 的验收用例。

Provider-specific control 不会自动成为 canonical capability。例如 DeepSeek `Search` 是可能实现 `search.web` 的 adapter control；DeepSeek `Vision` 可能实现 `image.input`。公共契约描述 outcome，adapter 负责 provider UI 细节。

## 用户模型

不打开浏览器即可列出 machine-readable catalog：

```bash
tokenless capabilities list --json
```

通过可重复 flag 请求一个或多个 outcome：

```bash
tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review this proposal."
```

Tokenless 会合并显式 requirement 与结构化推导：

- 普通 submit-and-read run 要求 `conversation.chat`；
- 任意 attachment 要求 `file.upload`；
- image、audio、video attachment 还会要求对应 input capability；
- `--workspace-mode native` 要求 `workspace.native`。

Provider selection 前会展开所有 implication。同一家 provider 必须满足完整 requirement set；Tokenless 不会静默丢弃任何必需 outcome。

## 当前可路由矩阵

下表概括 checked-in routes；CLI 输出是当前列表的权威来源。

| Canonical capability | ChatGPT | Claude | Gemini | Grok | Qwen | DeepSeek | Perplexity | Z.ai | Doubao | Kimi |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conversation.chat` | Supported | Supported | Supported | Supported | Experimental | — | Experimental | Experimental | Experimental | Experimental |
| `file.upload` | Supported | Supported | — | Supported | — | — | — | — | Experimental | Experimental |

`—` 表示目前没有公开 route，不一定代表 provider 产品没有该功能；也可能是 implementation 或真实 provider evidence 尚未完成。

Route 会按完整 requirement set 评估。例如 image attachment 同时要求 `file.upload` 与 `image.input`；仅有 `file.upload` 这一行并不代表图片上传已经 routeable。

DeepSeek 目前已实现 provider-specific controls，并为以下 candidate mapping 声明了 release gates：

| DeepSeek behavior | Canonical outcome | Public route state |
| --- | --- | --- |
| Instant chat 与可见 final response | `conversation.chat` | Gate pending |
| 同一 conversation 的 follow-up | `conversation.continue` | Gate pending |
| Instant 或 Vision 文件选择 | `file.upload` | Gate pending |
| Vision 图片输入 | `image.input` | Gate pending |
| Instant Search | `search.web` | Gate pending |
| DeepThink | `reasoning.extended` | Gate pending |
| 可见 source links | `response.citations` | Gate pending |

Perplexity `conversation.chat` 已作为 experimental route 对外提供。Guest session、prompt draft、submission、completed answer、normalized citations、可见 citation links、conversation mapping 与 durable state 已通过 built CLI、packaged daemon、runtime-bound Cloak profile 和真实 provider network。File acceptance、continuation、model selection、Deep Research、Spaces 与 generated assets 仍不公开。

Z.ai `conversation.chat` 已作为 experimental route 对外提供。Guest continuation、prompt draft、submission、completed visible answer、conversation mapping 与 durable state 已通过 built CLI、packaged daemon、runtime-bound Cloak profile 和真实 provider network。当前配置的 entry point 已改为 `https://z.ai/chat`；该官方入口目前会把已准备的 draft 交给 `https://chat.z.ai` chat runtime，因此两个 origins 都继续获准使用。此前 acceptance 覆盖的是通过仅限 E2E 的 process-local resolver mapping 访问 chat runtime；新的 entry-to-runtime journey 仍需作为手动 release rerun。Continuation、files、model 或 effort selection 及 GLM 高级工作流仍不公开。

Doubao `file.upload` 已作为 experimental route 对外提供文件选择能力。可见加号控件、provider 文件 input 与显示已接收文件名的卡片，均已通过 built CLI、packaged daemon、runtime-bound Cloak profile 和真实 provider network。`conversation.chat` 仍注册为需要登录的 experimental route：同一产品链路中的 readiness 与 prompt drafting 已通过，两次直接提交也得到了关联的可见 marker 回复。由于附着 E2E observer 时豆包显示 provider 自有的可见验证 iframe，所需 built-product mutation gate 尚未达到 release closure；challenge detection 会以 `visible_provider_blocker` fail closed。

豆包还公开 provider-specific 的 `doubao.mode` 与 `doubao.skill` actions。真实 non-submission gate 已检查、选择、在可见 DOM 中确认并恢复快速、专家、工作任务 Turbo，以及每一个适合 coding 工作流且可用的 Web 技能。可见 UI 要求升级时，工作任务 Pro 会报告 unavailable；录音转写的 Web 入口只提供桌面版下载流程，因此也报告 unavailable。这些 controls 会映射到 canonical candidates，但选择控件本身不能证明完整 outcome lifecycle，所以 generation、research、reasoning、background-task、transcription 与 spreadsheet routes 目前均不公开。

豆包 `auth.status` 也会读取可见账号控件，且只打开它的账号菜单。可见的“升级到专业版”会被派生为 `免费版` / `signed_in_free`；尚未观察的付费账号状态仍返回 `signed_in_unknown`，不会把购买页默认选中的报价误当成已购套餐。

Kimi `conversation.chat` 与 text-file `file.upload` 已作为 experimental routes 对外提供，但只适用于选定的已登录 profile。Built CLI、packaged daemon、runtime-bound Cloak profile 与真实 provider network 已闭环 readiness、prompt drafting、精确模型与思考强度选择及恢复、文件接收、附件感知回答、normalized 且可见的引用、第二个 CLI 进程在同一 conversation URL 上续聊，以及持久 task mapping。页面可见的 Projects、Web search、Plugins 与 Skills 目前只是产品控件观察，不是公共 capability routes。

| Doubao control | Canonical outcome candidates | Public route state |
| --- | --- | --- |
| 快速 | `conversation.chat` | Chat mutation gate pending |
| 专家 | `reasoning.extended` | Control 已闭环；outcome gate pending |
| 工作任务 Turbo / Pro | `task.background`, `task.interactive` | Turbo control 已闭环；Pro 可见要求升级；outcome gates pending |
| 帮我写作 | `document.generation` | Control 已闭环；artifact gate pending |
| PPT 生成 | `presentation.generation` | Control 已闭环；artifact gate pending |
| 图像生成 | `image.generation` | Control 已闭环；artifact gate pending |
| 视频生成 | `video.generation` | Control 已闭环；artifact gate pending |
| 深入研究 | `research.deep` | Control 已闭环；research lifecycle gate pending |
| AI 播客 / 音乐生成 | `audio.generation` | Controls 已闭环；artifact gates pending |
| 解题答疑 | `conversation.chat`, `reasoning.extended` | Control 已闭环；reasoning outcome gate pending |
| AI 表格 | `spreadsheet.generation`, `data.analyze` | Control 已闭环；artifact 与 analysis gates pending |
| 录音转写 | `audio.transcription` | Web 不可用；需要桌面版 |

## Capability families

V1 catalog 按持久语义分组，而不是按 provider marketing category 分组：

| Family | Canonical capabilities |
| --- | --- |
| Conversation | `conversation.chat`, `conversation.continue` |
| Input | `file.upload`, `image.input`, `audio.input`, `video.input`, `url.input`, `repository.import` |
| Retrieval and reasoning | `search.web`, `research.deep`, `reasoning.extended`, `audio.transcription`, `code.execute`, `data.analyze` |
| Media generation | `image.generation`, `image.edit`, `video.generation`, `audio.generation` |
| Artifact generation | `document.generation`, `presentation.generation`, `spreadsheet.generation`, `website.generation` |
| Workspace and knowledge | `workspace.native`, `workspace.instructions`, `workspace.knowledge`, `source.connected` |
| Evidence and lifecycle | `response.citations`, `artifact.download`, `task.background`, `task.interactive` |

即使 candidate entry 没有 route，也会保留在 catalog 中，方便发现预期 vocabulary，同时避免夸大 support。

## Capability 的定义内容

每个 canonical capability 都定义：

- 稳定 identifier 与 user-facing outcome；
- JSON parameter schema；
- lifecycle：`immediate`、`interactive` 或 `long_running`；
- 对外有意义的 side effects；
- implied、composable 与 conflicting capabilities；
- 必需的 visible 与 durable evidence；
- normalized output kinds；
- catalog stability：`candidate`、`experimental` 或 `supported`。

Provider route 会另外声明 strategy、evidence identifiers，以及 `experimental` 或 `supported` route status。Runtime eligibility 是第三个维度：当前 selected profile 对应 `eligible`、`unchecked` 或 `ineligible`。

这些状态不能合并。稳定的 catalog definition 可以没有 provider route；supported route 也可能因为 selected profile 未登录、遇到 challenge、被限流或缺少必需 visible control 而暂时 ineligible。

## Evidence ladder

每个 provider/capability cell 独立推进：

1. `product_documented` — provider 官方材料描述了产品能力。
2. `live_observed` — 真实可见 session 暴露相关状态或控件。
3. `implemented` — provider strategy 实现了完整预期 lifecycle。
4. `e2e_closed` — built CLI 与 packaged daemon 在真实 provider 上证明 final outcome。
5. `routeable` — 公共 router 可以展示并选择该 provider route。

菜单项、selector、fixture 或成功的手工 prompt 都不足以声明 `e2e_closed`。Fixture 用于 focused selector、parser、sanitizer maintenance；真实 provider E2E 才是 acceptance boundary。

## 新增 Capability

只有当产品需要新的 provider-neutral outcome 时才增加 canonical capability，不能因为某家 provider 新增了控件或 marketing label 就直接添加。

1. **定义语义。** 写清 user outcome、parameters、outputs、lifecycle、side effects、implications、conflicts 与 terminal conditions。
2. **先检查 composition。** 如果现有 capability 或其组合能够完整表达结果，应优先复用。
3. **新增 catalog definition。** 更新 `packages/cli/src/providers/task-capabilities.ts`，identifier 不得包含 provider 名称。
4. **实现 provider strategies。** Selector 与 provider-specific control 保留在 provider adapter 和 typed capability class 中。
5. **采集真实 fixture。** 为每个 materially distinct selector/parser state 保存脱敏且 provenance-bound 的 reduction；不得发明或拼接 DOM。
6. **声明 live acceptance。** 在 `test/live-provider-capability-matrix.json` 增加真实 case，并在 `test/live-managed-playwright.e2e.mjs` 实现 journey。
7. **闭环真实 boundary。** 使用 built CLI、packaged daemon、managed browser 与真实 provider network；不得使用 fixture、interception 或 simulated response。
8. **最后添加 route。** 只有所需 lifecycle 与 evidence 闭环后才发布 mapping。
9. **更新公共文档。** 同步本文档、两份 README、command documentation 和 release changeset。

### Admission questions

新增 identifier 前必须回答：

- 这是 user-visible outcome，还是 UI control？
- 是否至少有两家 provider 能够合理实现相同语义？
- success、failure、cancellation、continuation boundary 是否可测试？
- parameters 与 outputs 能否在不丢失关键行为的前提下 normalize？
- 它需要的是新的 capability，还是新的 lifecycle/safety contract？
- 组合现有 capabilities 是否更清晰？

Provider-only concept 可以保留为 `deepseek.mode`、`qwen.mode` 等 namespaced action。它们可以实现 canonical capability，但自身无需进入公共 catalog。

## Compatibility 与版本管理

当前 catalog schema 是 `tokenless.task-capability-catalog.v1`。

- 新增独立 capability 通常属于 additive change。
- 新增 optional parameter 在旧 request 语义完全不变时可以是 additive change。
- 修改含义、required parameters、output contract、implications 或 safety boundary 属于 breaking change；应增加新的 capability identifier 或 catalog schema version。
- 新增或删除 provider route 改变的是 support availability，不改变 canonical capability 的含义。
- Provider UI label 与 selector 可以变化；只要 outcome contract 不变，就不需要修改公共 capability。

持久化 job 会记录 normalized capability route 与 evidence identifiers，因此 implementation 不得用不兼容语义重新解释既有 job。

## Sources of truth

| Concern | Source |
| --- | --- |
| Catalog definitions 与 provider routes | `packages/cli/src/providers/task-capabilities.ts` |
| Provider-specific actions 与 payload contracts | `packages/cli/src/providers/contracts.ts`、`action-catalog.ts` |
| Provider implementations | `packages/cli/src/providers/` |
| 真实 provider required cases | `test/live-provider-capability-matrix.json` |
| 真实 provider journeys | `test/live-managed-playwright.e2e.mjs` |
| Fixture rules 与 inventory | `test/fixtures/provider-dom/README.md`、`manifest.json` |
| Product reconnaissance | `docs/provider-capability-census.md` |
| CLI behavior | `COMMANDS.md` |

当文档与 runtime output 不一致时，以 `tokenless capabilities list --json` 和 checked-in source 为准，并在同一次 change 中修正文档。
