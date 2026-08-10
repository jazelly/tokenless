# Capability Matrix

[English](capability-matrix.md)

Tokenless Capability Matrix 是 caller outcome 与 provider implementation 之间的公共契约。它让用户无需依赖 provider 的按钮名称即可描述任务，也为贡献者新增或修改 provider support 提供统一的证据标准。

本文档是 capability 命名、mapping、support state 与扩展流程的规范性文档。尚未成为 Tokenless support 的产品调研记录见 [Provider Capability Census](provider-capability-census.md)。

## 四个独立关注点

Tokenless 将四个相关关注点明确分开：

1. **Canonical capability catalog** — caller 可以要求的 provider-neutral outcome，例如 `conversation.chat`、`file.upload`、`search.web`。
2. **Provider bindings** — 从 canonical outcome 到 namespaced provider workflow/control 的 evidence-backed mapping。
3. **User-owned Skills** — Web Agent Harness 交付的 caller-selected `SKILL.md` context；它是 job input，不是 provider capability。
4. **Live acceptance matrix** — route 对外发布前，必须通过 built CLI、packaged daemon、managed browser 与真实 provider network 的验收用例。

Provider-specific control 不会自动成为 canonical capability。例如 DeepSeek `Search` 是可能实现 `search.web` 的 adapter control；Dola `translate` 目前只是实现 specialized chat path 的 namespaced workflow。公共契约描述 outcome，adapter 负责 provider UI 细节。

用户选择的 Skill 也不是 capability。Harness 会解析 `SKILL.md`、固定其内容 hash，再与 Harness System Prompt 一起通过普通 `file.upload` 交付。因此 eligible provider 只需要 `conversation.chat` 与 `file.upload`，不需要 `skill.invoke`。

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
- `--workspace-mode auto` 或 `native` 要求 `workspace.native`。

Provider selection 前会展开所有 implication。同一家 provider 必须满足完整 requirement set；Tokenless 不会静默丢弃任何必需 outcome。

## 当前可路由矩阵

下表概括 checked-in routes；CLI 输出是当前列表的权威来源。

| Canonical capability | ChatGPT | Claude | Gemini | Grok | Qwen | DeepSeek | Perplexity | Z.ai | Doubao | Kimi | Dola |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conversation.chat` | Supported | Supported | Supported | Supported | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental |
| `file.upload` | Supported | Supported | Experimental | Supported | — | Experimental | — | Experimental | Experimental | Experimental | Experimental |
| `search.web` | — | — | — | — | — | — | — | — | — | Experimental | — |
| `response.citations` | — | — | — | — | — | — | — | — | — | Experimental | — |

`—` 表示目前没有公开 route，不一定代表 provider 产品没有该功能；也可能是 implementation 或真实 provider evidence 尚未完成。

Route 会按完整 requirement set 评估。例如 image attachment 同时要求 `file.upload` 与 `image.input`；仅有 `file.upload` 这一行并不代表图片上传已经 routeable。

Gemini Markdown `file.upload` 已作为 experimental route 对外提供，但仅适用于选定的已登录 profile。Gemini 会从卡片文本与 accessibility metadata 中移除文件名后缀，因此其 provider-specific acceptance proof 要求三张新增且物理可见的 `gem-attachment` 卡片，同时保留 caller 已验证的选定文件扩展名；generic detector 与其他 provider 仍要求可见扩展名 evidence。上传路径依次选择 **Upload & tools** 与 **Upload files**，并通过 **Cancel** 关闭可选 MMGen disclaimer，不代替用户接受该声明。

2026-08-09，built CLI 与 packaged daemon 通过 headed Cloak `web-ai` 上传了三份 Markdown 文档，并读取附件相关的可见回复（job `tlp_0b9dde88-e2c2-46e5-8231-81b4f74403e1`；provider 端到端 27.3 秒）。提交给 Gemini 的 Tokenless-rendered request 原样包含冻结的 521 字符 Matrix V2 user prompt；完整 rendered request 为 853 字符，并不等同于该 user prompt。本地 output-savings event 以 `o200k_base` 为 1,607 个可见回复字符估算了 295 个输出 token；这只是本地可见输出估算，并非 provider 计费或 input-token telemetry。

Qwen 的可见 **Select Mode** → **Upload attachment** chooser 与物理 Markdown 卡片检测已实现，但 `file.upload` 仍未公开。2026-08-09，detached build 到达了三张可见 `.fileitem-btn` 卡片，其扩展名均为 `.md`；853 字符的 rendered request 原样包含冻结的 521 字符 Matrix V2 user prompt（job `tlp_14ec13d8-aba7-42c6-b328-f9095360d03a`；14.6 秒）。该历史 job 的 send click 没有可见转换，因此当时没有重试。后续 run 在未获 acknowledgement 的 submit 后，三张精确卡片仍显示 `Parsing...`（job `tlp_e2e_qwen_3980f162-f4ee-4202-b8bc-a4f6c70d2157`；132.167 秒），因此 Qwen acceptance 现要求规范化卡片文件名集合先显示 pending processing，再让同一组 ready 卡片完成短暂的有界稳定窗口；任何缺卡或 pending 重现都会重置该窗口。最终 lifecycle run 已通过该三文件 readiness gate 与可见 prompt input，但 submit 仍未获得 acknowledgement（`provider_submitted_at` 未设置；job `tlp_e2e_qwen_aca8d9e6-edf3-4488-8bf7-394bbc157408`；65.179 秒）。没有 response 或 savings event，route 仍未公开。

DeepSeek 的 `conversation.chat` 与 Markdown `file.upload` 已作为 experimental route 对外提供，但仅适用于选定的已登录 profile。2026-08-09，built CLI 与 packaged daemon 通过 headed Cloak `web-ai` 添加了三张 Markdown 卡片、写入并提交附件相关 prompt，再读取可见回复（job `tlp_4cc2da64-7fe7-4582-a0d2-d648531fd930`；端到端 28.3 秒）。本地 output-savings event 以 `o200k_base` 为 1,593 个可见回复字符估算了 305 个输出 token；这只是本地可见输出估算，并非 provider 计费或 input-token telemetry。

DeepSeek 对该 route 之外仍保留 provider-specific controls 与 candidate mappings：

| DeepSeek behavior | Canonical outcome | Public route state |
| --- | --- | --- |
| Instant chat 与可见 final response | `conversation.chat` | Experimental routeable |
| 同一 conversation 的 follow-up | `conversation.continue` | Gate pending |
| Instant 中的 Markdown 文件选择 | `file.upload` | Experimental routeable |
| Vision 图片输入 | `image.input` | Gate pending |
| Instant Search | `search.web` | Gate pending |
| DeepThink | `reasoning.extended` | Gate pending |
| 可见 source links | `response.citations` | Gate pending |

Perplexity `conversation.chat` 已作为 experimental route 对外提供。一次 2026-08-10 的 built CLI 与 packaged daemon journey 通过 headed Cloak `web-ai` 接收两份可见 Markdown 附件、提交附件相关 prompt，并读取同时包含两个精确附件 marker 与两条 normalized visible citations 的回复（job `tlp_e2e_DwUfSRhPb0RneFuf_5005733e-edcb-487d-8f12-35e220a3170f`；端到端 13.3 秒）。这次孤立成功不构成 release gate closure：后续正式两文件选择在缓存为 `signed_in_free` / `Free plan` 的 profile 上显示真实可见 dialog **Upgrade for additional document analysis**。因此 `file.upload` 继续不公开；Tokenless 将该可见状态报告为 `provider_plan_limited`。超过缓存 Free-plan 两文件边界的请求会在 stage、浏览器选择和提交之前被拒绝，但 provider 的动态 quota 仍可阻止两文件请求。Tokenless 不对 paid-plan 限额作出声明。Continuation、model selection、Deep Research、Spaces 与 generated assets 仍不公开。

Z.ai `conversation.chat` 与 Markdown `file.upload` 已作为 experimental routes 对外提供。2026-08-09，built CLI 与 packaged daemon 通过 headed Cloak `web-ai` 添加了三张物理可见 Markdown 卡片，提交 exact attachment-detector prompt，并读取附件相关回复（job `tlp_0bc5f6de-b04d-4b35-85a0-2bd59e2ed227`；provider 端到端 34.1 秒）。该 job 记录了 531 estimated output tokens 与 2,770 visible characters，且没有 provider blocker。配置的 entry point 为 `https://z.ai/chat`；官方入口会把已准备的 draft 交给获准使用的 `https://chat.z.ai` runtime。Continuation、model 或 effort selection 及 GLM 高级工作流仍不公开。

Doubao `file.upload` 已作为 experimental route 对外提供文件选择能力。可见加号控件、provider 文件 input 与显示已接收文件名的卡片，均已通过 built CLI、packaged daemon、runtime-bound Cloak profile 和真实 provider network。`conversation.chat` 仍注册为需要登录的 experimental route：同一产品链路中的 readiness 与 prompt drafting 已通过，两次直接提交也得到了关联的可见 marker 回复。由于附着 E2E observer 时豆包显示 provider 自有的可见验证 iframe，所需 built-product mutation gate 尚未达到 release closure；challenge detection 会以 `visible_provider_blocker` fail closed。

豆包还公开 provider-specific 的 `doubao.mode` 与 `doubao.skill` actions。真实 non-submission gate 已检查、选择、在可见 DOM 中确认并恢复快速、专家、工作任务 Turbo，以及每一个适合 coding 工作流且可用的 Web 技能。可见 UI 要求升级时，工作任务 Pro 会报告 unavailable；录音转写的 Web 入口只提供桌面版下载流程，因此也报告 unavailable。这些 controls 会映射到 canonical candidates，但选择控件本身不能证明完整 outcome lifecycle，所以 generation、research、reasoning、background-task、transcription 与 spreadsheet routes 目前均不公开。

豆包 `auth.status` 也会读取可见账号控件，且只打开它的账号菜单。可见的“升级到专业版”会被派生为 `免费版` / `signed_in_free`；尚未观察的付费账号状态仍返回 `signed_in_unknown`，不会把购买页默认选中的报价误当成已购套餐。

Kimi `conversation.chat`、text-file `file.upload`、`search.web` 与基于搜索的 `response.citations` 已作为 experimental routes 对外提供，但只适用于选定的已登录 profile。Built CLI、packaged daemon、runtime-bound Cloak profile 与真实 provider network 已闭环 readiness、prompt drafting、精确模型与思考强度选择及恢复、文件接收、附件感知回答、Web search Auto/Off 精确选择、normalized 且可见的引用、第二个 CLI 进程在同一 conversation URL 上续聊，以及持久 task mapping。Plugin 与 Skill 的检查和精确可见选择也通过了 non-submission gate，但完整提交 outcome 当前受 Kimi 可见容量队列阻塞，因此未公开为 routes。Projects、Deep Research、agent workflows 与 artifact lifecycles 已有实现和 release gates，但真实 provider gates 尚未闭环，所以仍不公开。

Dola `conversation.chat` 与 `file.upload` 已作为需要登录的 experimental routes 从用户选定的 managed profile 提供。chat composer、Fast/Pro model menu、文件选择器、conversation URL，以及 Create Image、Writing、Create Video、Translate 和 Homework 入口均已可见确认。2026-08-10，built CLI、packaged daemon、headed `web-ai` profile 与真实 provider network 分别接受了三张独立可见的 Markdown 卡片（job `tlp_5db59da1-44fd-40ac-b907-340d4f8ef82b`；5.664 秒）和来自真实 `.docx` 文件的三张独立可见 Word 卡片（job `tlp_148a7ac2-e104-4e60-b0d3-815e9a3c4039`；4.989 秒）；两份 receipt 都保留了可见接受 evidence 与 attachment hash。随后完整的三份 Markdown attachment-grounded upload、prompt、visible submission 与 response journey 以 job `tlp_24164113-840e-4a53-8645-e9a1268c8438` 通过：从创建到完成共 79.614 秒，其中约 64 秒在先前任务之后排队；从 visible submission 到 response 为 10.922 秒。本地 visible-output estimate 使用 `o200k_base` 记录 1,376 个字符对应的 251 tokens；这不是 provider billing。continuation、generation 与 specialist outcome 仍未公开。

| Dola 控件或界面 | Canonical outcome candidates | 当前证据与 route 状态 |
| --- | --- | --- |
| Chat 与同 conversation 续聊 | `conversation.chat`, `conversation.continue` | Experimental chat route；三文件 attachment-grounded submission 与关联 response gate 已通过；continuation 尚未证明 |
| Fast / Pro | `conversation.chat`；provider control `model.choice` | 两个选项均已 live-observed；exact selection 与 restoration gate 待完成 |
| 添加文件 | `file.upload` | Experimental file-selection route；选定 profile 中三张 Markdown 与三张 Word 物理卡片已通过 built CLI 与 packaged daemon |
| Create Image / AI Creation | `image.generation` | 已 live-observed 入口及带 model、ratio、style、template 的 Seedream 图片界面；completed image 与 bounded artifact reference 待完成 |
| Writing | `document.generation` 或 `conversation.chat` | 已 live-observed `write_assistant` 入口；尚未证明输出形态，因此不声明 document 或 downloadable file |
| Create Video | `video.generation` | 已 live-observed `video_generation` 入口；progress、terminal video 与 bounded artifact reference 待完成 |
| Translate | `conversation.chat`；provider workflow `dola.translate` | 已 live-observed `translate` 入口；关联翻译结果待完成 |
| Homework | `conversation.chat`；provider workflow `dola.exercise_assistant` | 已 live-observed `exercise_assistant` 入口；terminal homework outcome 待完成；不能仅凭按钮推导 extended reasoning |
| Projects、文件库或持久知识 | `workspace.native`, `workspace.knowledge`, `artifact.download` | Unavailable：没有观察到 Project、文件库或持久知识管理界面 |

Dola 没有独立观察到的 **Create File** 控件。可见的 **Writing** 入口不能直接当作文件创建；只有真实运行产出完整 document 后才能映射 `document.generation`，若结果可下载，还需要 `artifact.download` evidence。

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

V2 catalog 按持久语义分组，而不是按 provider marketing category 分组：

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

Provider-only concept 保留为 `deepseek.mode`、`kimi.skill`、`dola.translate`、`dola.exercise_assistant` 等 namespaced action/workflow。它们可以实现 canonical capability，但自身不进入 public catalog。User-owned Skills 始终留在 Harness context interface，也不进入该 namespace。

## Compatibility 与版本管理

当前 catalog schema 是 `tokenless.task-capability-catalog.v2`。V2 删除 `skill.invoke`：provider-native workflow 保持 namespaced provider control，user-owned Skill 则作为 Harness input 经 `file.upload` 交付。

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
