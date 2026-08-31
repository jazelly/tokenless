# Provider Capability Census

最近复核：2026-08-31

这是一份产品调研记录，不是 Tokenless support 声明。Provider 官方文档只能证明产品 feature 存在；只有 provider adapter 实现完整可见 lifecycle，且真实 provider browser E2E 闭合必需证据后，Tokenless 才会公布 route。规范的命名、映射、support 与扩展规则位于 [Capability Matrix](capability-matrix.zh-CN.md)。

提交到仓库的 runtime catalog 与 provider routing matrix 位于 `packages/server/src/providers/task-capabilities.ts`。`tokenless capabilities list --json` 无需打开浏览器即可公开这个带版本的 catalog。当前 V3 可路由 outcome 为：

- `conversation.chat`：ChatGPT、Claude、Gemini、Grok、Arena，以及实验性 Qwen、DeepSeek、Perplexity、Z.ai、Doubao、Kimi、Dola 和 Meta AI；
- `image.generation` 与 `artifact.download`：实验性 ChatGPT、Gemini、Grok、Doubao、Dola、Arena 和 Meta AI；
- `file.upload`：支持的 ChatGPT、Claude 与 Grok；实验性 Gemini、Qwen、DeepSeek、Perplexity、Z.ai、Doubao、Kimi、Dola 与 Meta AI；
- `search.web`：实验性 Kimi；以及
- `response.citations`：实验性 Kimi search。

下面其他条目仍是待发现 candidate。特别是 `research.deep`、作为必需 production postcondition 的 citation、作为显式 capability 的 continuation、其他 generated media 与 generated work artifact，在完整 execution contract 得到实现并通过真实 provider E2E 闭合前均不可路由。

Harness attachment gate 比 generic file upload 更严格：它要求 bootstrap Markdown、framed tool call、真实只读工具执行、同 conversation tool-result Markdown，以及无 fallback 的 succeeded child run。ChatGPT、Gemini、DeepSeek、Z.ai、Doubao、Kimi 与 Dola 已于 2026-08-31 通过。Claude、Grok、Qwen、Perplexity 与 Meta AI 保留 generic Markdown upload route，但不进入 Harness V0/Auto；Arena 接受图片而不接受 Markdown。具体当前原因记录在 [Capability Matrix](capability-matrix.zh-CN.md#harness-附件准入)。

统一的 `POST /v1/images/generations` endpoint 将 browser 与 direct result 持久化到同一个 scoped asset store。Browser auto routing 只选择同时具备 `image.generation` 和 `artifact.download`、已启用且可用的 provider；Gemini、Dola 与 Doubao gate 均已完成一次可见提交、terminal artifact、local digest 与 authenticated readback。Direct V1 包含逻辑 `tokenless/pollinations/sana` route 与显式 `tokenless/chatgpt/gpt-image` route；二者都不会在 public model ID、response 或 capability evidence 中暴露 private implementation name。Pollinations direct gate 生成并读回一个 768×768 JPEG；ChatGPT direct 在持久化已验证 image bytes 前使用 ephemeral browser-scoped auth bridge。

## Evidence Ladder

每个 provider/capability cell 独立推进：

1. `product_documented`：provider 官方描述了该 Web product capability；
2. `live_observed`：所选 managed profile 可见地提供相关 control 或 state；
3. `implemented`：provider strategy 能通过 packaged daemon 执行 lifecycle；
4. `e2e_closed`：构建后的产品在真实 provider 上证明最终可见的 outcome；以及
5. `routeable`：capability router 可以针对观察到的 account class 公布并选择该 route。

一个可见 menu item 绝不会让 capability 超过 `live_observed`。Account tier、region、quota、rollout 与 workspace policy 都可能使官方已记录的 feature 在特定 profile 中不可用。

## 当前 Tokenless Providers

Product surface 比当前 Tokenless evidence 更广。中间一列结合官方文档与之前的真实产品调研；最后一列汇总仓库中的 live acceptance matrix，而不是 provider 的营销声明。

| Provider | 已记录或已真实观察、与 Tokenless 相关的 Web product capability | 当前 Tokenless 证据 |
| --- | --- | --- |
| ChatGPT | Chat、带 citation 的 Web search、Deep Research、file 与 image input、image generation/editing、data analysis、Canvas、agent mode，以及带 file 和 instruction 的 Projects | 支持 chat 与 Harness-verified `file.upload`；live gate 已闭环 bootstrap、工具执行、continuation 上传与无 fallback 的精确 final proof。独立 image 与 Project evidence 继续分别约束 |
| Claude | Chat、Web search、Research、file 与 image、Projects 与 project knowledge、Artifacts、model selection、extended thinking 与 connector | 支持 chat、generic Markdown `file.upload` 与 native Project route；上传、提交和回复均通过，但 Harness attachment instruction 被拒绝为 prompt injection |
| Gemini | Chat、Web-grounded answer、Deep Research、file 与 image input、Deep Think、image/video/music generation、Canvas、Gems、notebook、connected source 与 GitHub repository import | 支持 chat，加 experimental Harness-verified `file.upload`；upload control 页面重绘由既有 interaction timeout 观察。Image generation 独立保持 experimental |
| Grok | Chat、带 citation 的 X 与 Web search、reasoning mode、image input 与 image generation | 支持 chat 与 generic Markdown `file.upload`；选定 profile 的可见周限额持续到 2026-09-02 06:47:22 UTC，因此当前不进入 Harness。Imagine image generation 独立保持 experimental |
| Qwen | Chat、Web search、Deep Research Normal/Advanced、file-assisted research、image generation/editing、video generation、Web Dev、Artifacts、Slides、Learn 与 travel planning mode | Focused byte、size 与 filename probe 通过后，generic Markdown `file.upload` 保持 experimental；完整 Harness job 在卡片可见性与提交 transition 上仍不稳定 |
| DeepSeek | 已登录 Web chat、Instant/Expert/Vision mode、DeepThink、Web search、广泛 file/image input 与同步 chat history | 实验性 chat 与 Harness-verified `file.upload`；bootstrap、framed 只读工具调用、同 conversation tool-result 上传与精确 final proof 已无 fallback 通过 |
| Perplexity | 带 citation 的 Web search、Pro Search、Advanced Deep Research、file-aware research、Spaces、model selection、image generation/editing 与 multi-format asset creation | 实验性 chat 与 generic Markdown `file.upload` 保留；选定 Free profile 的官方每天 3 次额度已用完，API capacity guard 会在 browser work 前排除需要 2 次上传的 Harness request |
| Z.ai / GLM | GLM-5.2 Web chat、1M context、灵活 effort level、coding 与 long-horizon agent strengths | 实验性 chat 与 Harness-verified Markdown `file.upload`；点击无 transition 后的普通 Enter 提交和 conversation 页 composer 已闭合两轮 |
| Doubao / 豆包 | 已登录中文 Web chat；可见 free-account 判别；Fast、Expert 与 Work Task mode；writing、presentation、image、video、deep-research、podcast、music、problem-solving 与 spreadsheet Web skill；广泛 file input；仅 desktop 可用的 recording transcription 入口 | 实验性 chat、image 与 Harness-verified Markdown `file.upload`；adapter 会在提交前精确关闭 provider desktop-promotion dialog |
| Kimi | 已登录 Web chat；Instant、K3 与 K3 Swarm model；Standard/High thinking effort；file、Web search、Plugins、Skills、Projects 与更广泛的 research/agent/artifact surface | 实验性 chat、search 与 Harness-verified Markdown `file.upload`；选定的 `web-ai` Cloak profile 已登录 `kimi.ai` 并完成两轮 |
| Dola | 已登录 Web chat；Fast 与 Pro 选择；file input；Create Image、Writing、Create Video、Translate 与 Homework 入口；独立 Seedream image-creation surface；未观察到 Project、file library 或 persistent knowledge-management surface | 实验性 chat 与 Harness-verified `file.upload`；两轮 Markdown 均被逐个可见观察并使用。Image generation 独立保持 experimental |
| Arena | 已登录 Battle、Direct 与 Side-by-Side chat；model selection；file input；Search、Code、Agent、Image 与 Video surface | 支持 Direct chat，独立 generated-image route 保持 experimental；真实 input 接受 PNG、JPEG 与 WebP，但不接受 Markdown，因此 generic `file.upload` 已移除 |
| Meta AI | 已登录 Web chat；Instant 与 Thinking mode；广泛 file input；可见 image generation；research-progress 与 assistant-response surface | 实验性 chat、image 与 generic Markdown `file.upload` 保留；精确 Harness bytes 可上传，但组合 attachment instruction 被静默拒绝且不创建 conversation |

官方参考：

- [ChatGPT capabilities](https://help.openai.com/en/articles/9260256-chatgpt-capabilities-overview)、[Deep Research](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt) 与 [Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [Claude Research](https://support.anthropic.com/en/articles/11088861-using-research-on-claude-ai)、[Web search](https://support.anthropic.com/en/articles/10684626-enabling-and-using-web-search)、[Projects](https://support.anthropic.com/en/articles/9529781-examples-of-projects-you-can-create) 与 [Artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Gemini Apps capability index](https://support.google.com/gemini) 与 [Gemini Deep Research](https://support.google.com/gemini/answer/15719111)
- [Grok Web search 与 citation](https://x.ai/news/grok-1212) 以及 [Web 上的 Grok](https://help.x.com/en/using-x/about-grok)
- [Qwen Deep Research](https://qwen.ai/blog?id=qwen-deepresearch) 与 [Qwen Image](https://qwen.ai/blog?id=qwen-image-2.0)
- [DeepSeek V4 Web mode](https://api-docs.deepseek.com/news/news260424)、[DeepSeek Web search](https://api-docs.deepseek.com/news/news1210/) 与 [DeepSeek file upload 和同步 history](https://api-docs.deepseek.com/news/news250115/)
- [Perplexity overview](https://www.perplexity.ai/help-center/en/articles/10352895-how-does-perplexity-work)、[account tiers](https://www.perplexity.ai/help-center/en/articles/10352998-account-management-and-security)、[Enterprise file limits](https://www.perplexity.ai/help-center/en/articles/12009761-enterprise-file-limits)、[Spaces](https://hub-prod.perplexity.ai/hub/faq/what-are-spaces) 与 [generated asset](https://www.perplexity.ai/help-center/en/articles/12528830-creating-assets-with-perplexity-overview)
- [Z.ai 上的 GLM-5.2](https://z.ai/blog/glm-5.2)
- [豆包官方功能介绍](https://www.doubao.com/legal/feature_intro)
- [豆包付费服务协议](https://www.doubao.com/legal/ey01)
- [Kimi Web product](https://www.kimi.ai/)
- [Dola Web product](https://www.dola.com/chat)
- [Arena model selection](https://help.arena.ai/articles/1858200927-arena-experiments-new-model-selector)、[file upload](https://help.arena.ai/articles/5595418316-arena-how-to-file-upload) 与 [Agent Mode](https://help.arena.ai/articles/5432423882-how-to-use-agent-mode)
- [Meta AI Web product](https://about.fb.com/news/2025/04/introducing-meta-ai-app-new-way-access-ai-assistant/) 与 [meta.ai 上的 Muse Image](https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/)

## Candidate Web Providers

| Candidate | Canonical Web 入口 | 官方已记录或当前已确认的 surface | 建议评估 |
| --- | --- | --- | --- |
| Mistral Le Chat | `https://chat.mistral.ai/` | Web search 与 citation、Deep Research、Think mode、Projects 与 Libraries、file、code interpreter、image generation/editing、Canvas、agent 与 MCP connector | P1。Capability 匹配广，官方文档相对清晰；适合作为 research 与 artifact semantics 的第二个 adapter |
| Microsoft Copilot | `https://copilot.microsoft.com/` | Web chat、Quick/Think Deeper/Smart mode、Deep Research、file upload、image generation/editing、Pages、connector、voice 与 browser-related experience | 在 2026-08-01 Cloak precheck 中被阻止：登出 surface 提供 Microsoft、Apple 与 Google 登录选择，但没有 guest composer。只有明确选择 setup-managed signed-in profile 后才能继续 |
| Tencent Yuanbao | `https://yuanbao.tencent.com/` | Web product、腾讯增强 Web search、多格式 file reading、reasoning/model surface 与更广泛的腾讯内容 ecosystem | P2。有价值的中文 search 与 file route；高级 artifact 与 workspace 声明需要官方和真实闭合 |
| MiniMax Agent | `https://agent.minimax.io/` | Long-horizon planning、Web 与 application generation、code execution、multimedia understanding/generation 与 MCP integration | P3 specialist adapter。其 autonomous-agent lifecycle 与 chat 有实质差异，不应强行放入 baseline provider contract |

官方 candidate 参考：

- [Kimi overview](https://www.kimi.com/help/getting-started/overview)、[Kimi Deep Research](https://www.kimi.com/help/deep-research/deep-research-overview) 与 [Kimi Agent](https://www.kimi.com/help/agent/agent-overview)
- [Perplexity overview](https://www.perplexity.ai/help-center/en/articles/10352895-how-does-perplexity-work)、[Spaces](https://hub-prod.perplexity.ai/hub/faq/what-are-spaces)、[image generation](https://www.perplexity.ai/help-center/en/articles/10354781-generating-images-with-perplexity) 与 [generated asset](https://www.perplexity.ai/help-center/en/articles/12528830-creating-assets-with-perplexity-overview)
- [Mistral Le Chat research 与 Projects](https://mistral.ai/news/le-chat-dives-deep/) 和 [Le Chat product surface](https://mistral.ai/news/all-new-le-chat/)
- [DeepSeek V4 Web mode](https://api-docs.deepseek.com/news/news260424) 与 [DeepSeek update](https://api-docs.deepseek.com/updates/)
- [Microsoft Copilot capabilities](https://support.microsoft.com/en-gb/microsoft-copilot)、[Deep Research](https://support.microsoft.com/en-us/Microsoft-Copilot/deep-research-in-microsoft-copilot) 与 [file upload](https://support.microsoft.com/en-US/microsoft-copilot/file-upload-in-microsoft-copilot)
- [腾讯元宝 Web search](https://cloud.tencent.com/product/wsa) 与 [desktop file support](https://yuanbao.tencent.com/evt/dl)
- [MiniMax Agent](https://www.minimax.io/news/minimax-agent)

## 2026-08-01 至 2026-08-04 Cloak 扩展检查点

- Perplexity 通过 built CLI、packaged daemon、runtime-bound Cloak profile 与 provider network 完成真实 non-submission 和 mutation journey。Guest readiness、prompt drafting、completed response、normalized/visible citation 与 conversation mapping 已闭合；`conversation.chat` 以 experimental 公布。后续 regression run 拒绝了可见 optional-cookie dialog，随后到达 `provider_sign_in_required`；未尝试登录，该依赖账户状态的 rerun 保持搁置。
- Z.ai 现已在 `https://chat.z.ai/` 通过完整 Harness Markdown round-trip；adapter 只在可见 send click 没有 accepted transition 后使用 Enter，并识别 continuation composer。
- Doubao 在提交前精确关闭 desktop-promotion dialog 后，现已通过完整 Harness Markdown round-trip。
- Microsoft Copilot 两次检查都未触发 challenge，但只提供 sign-in surface，没有 guest composer。根据 authentication-skip policy，未尝试登录，也未注册 adapter。
- Kimi 已迁移到 `kimi.ai`；用户通过选定的 `web-ai` Cloak profile 登录后，已在新 origin 通过完整 Harness Markdown round-trip。

## Canonical Capability Schema

Caller catalog 必须描述 outcome，而不是 provider control。`qwen.mode`、`deepseek.mode`、`deepseek.deepthink`、`deepseek.search`、`doubao.mode`、`doubao.skill`、`model.choice`、`effort.choice`、DOM selector 与营销 model name 保留在 provider strategy adapter 内。Doubao control inspection 报告 candidate mapping；只有 image skill 拥有独立 E2E-closed canonical outcome route。Expert 映射到 `reasoning.extended`；Work Task 映射到 background 和 interactive task semantics；其他 Web skill 映射到 research、media、document、presentation、spreadsheet、data-analysis 与 audio-transcription candidate。DeepSeek adapter 已经在 mutation 前将 `reasoning.extended` 准备为 Instant 加 DeepThink、`search.web` 准备为 Instant 加 Search、`image.input` 准备为 Vision。这些未闭合 route 在每个完整可见 lifecycle 通过 built CLI 与 packaged daemon 前均不公布。

### Proposed Capability Families

| Family | Candidate canonical capabilities |
| --- | --- |
| Conversation | `conversation.chat`、`conversation.continue` |
| Inputs | `file.upload`、`image.input`、`audio.input`、`video.input`、`url.input`、`repository.import` |
| Retrieval and reasoning | `search.web`、`research.deep`、`reasoning.extended`、`audio.transcription`、`code.execute`、`data.analyze` |
| Media generation | `image.generation`、`image.edit`、`video.generation`、`audio.generation` |
| Artifact generation | `document.generation`、`presentation.generation`、`spreadsheet.generation`、`website.generation` |
| Workspace and knowledge | `workspace.native`、`workspace.instructions`、`workspace.knowledge`、`source.connected` |
| Evidence and lifecycle | `response.citations`、`artifact.download`、`task.background`、`task.interactive` |

这是一套 candidate vocabulary。只有至少一个 provider 拥有完整 semantics 与真实 provider closure 时，capability 才能公开。相似的 provider label 不能证明行为等价。

Kimi Skill 或 Dola Homework 等 provider-native label 仍是 namespaced workflow。用户自有 `SKILL.md` 是通过 `conversation.chat` 加 `file.upload` 交付的独立 Harness context，不属于 canonical capability vocabulary。

保持 public catalog 精简。Real-time voice conversation、persistent personalization/memory、任意 autonomous Web action、connector write，以及 iterative artifact editing/sharing 都需要独立 safety 与 lifecycle contract。Schema 以后可以增加这些 outcome，但“agent”“canvas”或“memory”等 provider 营销 label 不能作为定义不足的 generic capability 进入 V2。

### Task Requirement

简单场景下，CLI 可以使用可重复的 capability identifier。MCP 与 internal contract 需要 structured parameter：

```ts
type TaskCapabilityRequirement = Readonly<{
  capability: TaskCapabilityId
  parameters?: Readonly<Record<string, unknown>>
}>

type CapabilityRunRequest = Readonly<{
  profile?: string
  providerConstraint?: ProviderId
  requirements: readonly TaskCapabilityRequirement[]
  prompt: string
  attachments?: readonly AttachmentInput[]
  workspace?: WorkspaceIntent
  requestedOutputs?: readonly OutputRequirement[]
}>
```

所有 V2 requirement 都是必需的。Attachment 推导相应 input capability；requested output kind 推导 generation capability。Router 必须找到一组 provider strategy，满足每个显式与推导 requirement，包括请求的 parameter subset。

每个 catalog definition 包含：

```ts
type TaskCapabilityDefinition = Readonly<{
  id: TaskCapabilityId
  title: string
  description: string
  family: CapabilityFamily
  parametersSchema: JsonSchema
  lifecycle: 'immediate' | 'interactive' | 'long_running'
  sideEffects: readonly CapabilitySideEffect[]
  implies: readonly TaskCapabilityId[]
  composesWith: readonly TaskCapabilityId[]
  conflictsWith: readonly TaskCapabilityId[]
  requiredEvidence: readonly CapabilityEvidenceRequirement[]
  outputKinds: readonly OutputKind[]
  stability: 'candidate' | 'experimental' | 'supported'
}>
```

Provider matrix 将 canonical definition 映射到 provider-owned strategy，并声明它能满足的 parameter subset。不受支持的 parameter 会在 mutation 前排除该 route。

## 最低 Lifecycle Contracts

### `research.deep`

选择 mode 并获得第一个 correlated response 不足以闭合。Closure 要求：

1. 选择 provider research strategy；
2. 提交 scoped research request 与可选 source；
3. 将 clarification 公开为 `waiting_for_user`，或应用显式 caller policy；
4. 需要时批准或启动可见 research plan；
5. Research 在 background 运行时保留同一个 active execution；
6. 检测 provider progress、limit、cancellation 与 terminal failure；
7. 读取 completed final report，而不是 intermediate message；
8. 证明可见 citation 或 source link；以及
9. 返回 report text 与任何可下载 report artifact。

### Generated Media 与 Files

- `image.generation`：证明 completed visible image result，并返回有界 artifact reference；声称已创建图片的 text 不构成 closure。
- `image.edit`：证明 edited result 属于提交的 source image 与 instruction。
- `video.generation` 与 `audio.generation`：处理 long-running progress，并返回 completed playable/downloadable artifact。
- `audio.transcription`：证明 source-audio correlation，并返回 completed visible transcript，而不是 file-selection 或 desktop-download prompt。
- `file.upload`：已填充的 `FileList` 只证明 selection；可见 provider attachment state 才证明 acceptance。

### Generated Work Artifacts

Document、presentation、spreadsheet 与 website capability 必须声明 output format，并证明 completed preview 或 downloadable artifact。包含 Markdown、code 或 slide suggestion 的 prose answer 不满足 artifact-generation capability。

## Routing Consequences

- Product documentation 扩展调研，不会使 route eligible。
- Router 只考虑已实现且通过真实 E2E 闭合的 provider strategy。
- Account、region、rollout 与 quota 是 runtime eligibility check。
- 一个 V2 provider 必须满足完整 requirement set。
- Provider ranking 只在 full-set capability compatibility 后发生。Fresh runtime eligibility 优先于 unchecked state，supported evidence 优先于 experimental evidence，最后由配置的 provider preference 打破平局。
- Stale cached access 是 `unchecked`，不会被信任为 live eligibility。每次 attempt 在 mutation 前执行只读 visible session 与 capability-UI preflight；不允许 probe prompt。
- Job contract 独立从 action、attachment MIME type 与 native workspace intent 推导 requirement。即使 internal caller 提供了 route，遗漏 action-required capability 的 route 仍然无效。
- Automatic fallback 消耗 ranked list，但不降低 capability。当没有 provider 满足 `research.deep` 或其他 mandatory capability 时，routing 以 `task_capability_route_unavailable` 停止，不会 fallback 到 plain chat。
- Result 记录 canonical requirement、selected provider、provider strategy、runtime observation、evidence 与 ranked remaining route。
