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

| Canonical capability | ChatGPT | Claude | Gemini | Grok | Qwen | DeepSeek | Perplexity | Z.ai | Doubao | Kimi | Dola | Arena | Meta AI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conversation.chat` | Supported | Supported | Supported | Supported | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | — | Supported | Experimental |
| `conversation.continue` | — | — | — | — | — | — | — | — | — | — | — | Supported | — |
| `model.compare` | — | — | — | — | — | — | — | — | — | — | — | Supported | — |
| `agent.execute` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `file.upload` | Supported | Supported | Experimental | Supported | — | Experimental | — | Experimental | Experimental | Experimental | — | Experimental | Experimental |
| `image.input` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `image.generation` | Experimental | — | Experimental | Experimental | — | — | — | — | Experimental | — | Experimental | Experimental | Experimental |
| `image.edit` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `artifact.download` | Experimental | — | Experimental | Experimental | — | — | — | — | Experimental | — | Experimental | Experimental | Experimental |
| `website.generation` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `video.generation` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `search.web` | — | — | — | — | — | — | — | — | — | Experimental | — | Experimental | — |
| `response.citations` | — | — | — | — | — | — | — | — | — | Experimental | — | Experimental | — |

`—` 表示目前没有公开 route，不一定代表 provider 产品没有该功能；也可能是 implementation 或真实 provider evidence 尚未完成。

当前表是 **Browser execution matrix**。catalog 同时暴露独立的 direct bindings：ChatGPT 有 `conversation.chat`、`image.generation` 与 `artifact.download`，Perplexity 有独立的 direct `conversation.chat` binding。Direct evidence 不能从 Browser route，也不能从恰好声明 `direct` 的 provider descriptor 推断。

Route 会按完整 requirement set 评估。例如 image attachment 同时要求 `file.upload` 与 `image.input`；仅有 `file.upload` 这一行并不代表图片上传已经 routeable。

ChatGPT、Gemini、Grok、豆包、Dola、Arena 与 Meta AI Image artifact 会通过选定的 Playwright browser session 下载到按 task、conversation、job 与时间划分的 `assets` 目录。公开 response 只包含 relative asset reference、media type、尺寸、byte size 与 SHA-256 digest；带签名的 provider URL 仅在内存中使用。authenticated daemon 的 `GET /v1/private/assets/{taskId}/{conversationId}/{assetBatch}/{assetFile}` endpoint 会以实际图片 media type 返回已验证 bytes；路径越界、损坏或缺失 asset 会 fail closed。

ChatGPT 的 `image.generation` 与 `artifact.download` 已作为 experimental routes 实现。Image reader 只读取最新可见的 `section[data-turn="assistant"]`，按 canonical URL 对重复的 `[id^="image-"] img` 去重，等待 stop control 消失，通过选定 browser session 下载 provider/CDN HTTPS bytes，使用 browser decoder 校验尺寸，并且不会把带签名 URL 放进 response。真实 asset run 生成了一张去重后的 1254×1254 PNG，并验证 DOM bytes、本地 digest、browser decode 与 authenticated daemon readback。

Grok 的 `image.generation` 与 `artifact.download` 已在独立 Imagine Image surface 上实验性开放。Tokenless 会精确选择 ×2 output、记录提交前的 post set，等待恰好两个新的终态 post identity，忽略网格里的 data-URI preview，逐个打开当前 `/imagine/post/:assetId`，且只下载匹配 `assets.grok.com/.../generated/:assetId/` 的 HTTPS 图片。真实 asset run 生成了两张 768×1152 JPEG，并验证 baseline set-difference、post identity、provider bytes、本地 digest、browser decode 与 authenticated daemon readback。

Arena `conversation.chat`、`conversation.continue` 与 `model.compare` 已支持选定的已登录 profile。新建文字会话前，adapter 会精确选择 **Direct** mode；`model.inspect` 与 `model.select` 可在提交前精确选择一个可见 Direct model，并恢复原始 **Max** router。Built CLI 与 packaged daemon 已证明实质性的 selected-model 回复、持久化 `/c/:conversationId` mapping，以及第二个 CLI 进程在同一 URL 只返回最新回答。Battle 会返回两份匿名回答，并将 `model` 明确设为 `null`；Side-by-Side 会返回两份回答与两个可见 selected model 标签。Generic client 会收到完整 A/B 文本，结构化 client 还会收到 `alternatives`。Arena `search.web` 与 `response.citations` 已作为 experimental routes 开放：请求 Search outcome 会自动选择 Direct Search；真实 reader 已返回一份实质 grounded answer，以及与该回答关联的 source cards 中 normalized HTTPS links。Arena `file.upload`、`image.input`、`image.generation`、`image.edit` 与 `artifact.download` 已作为 experimental routes 开放。Image outcome 会自动选择 Direct Image，并返回当前 answer 的 `artifacts`，其中包含 task-scoped asset reference、media type、尺寸、byte size、SHA-256 digest 与 proof；真实运行分别生成了一张 1024×1024 JPEG，并在可见接受 source image 后产生了一张 1333×1180 编辑 PNG。Image task 会在 daemon 提交前拒绝 comparison/search surface、continuation 与 generic model controls；`artifact.download` 必须与 `image.generation` 或 `image.edit` 一起请求。Arena `website.generation` 已作为 experimental route 开放，并会自动选择 Direct Code。真实 reader 返回了当前 assistant 的完整单文件 `index.html` artifact、与其关联的 HTTPS `arena.site` preview，以及可见 download availability；code execution 仍不公开。Arena `agent.execute` 已作为 experimental route 开放，并会进入独立 `/agent` surface，而不是 Direct Search。它的 current-run reader 会在 provider 显示 task-success review panel 后，返回一份终态回答、answer-scoped 官方 citations 与结构化可见 tool steps；Tokenless 不会回答该 review prompt。Agent attachment、continuation、comparison、Image/Code 组合与 model controls 会在 daemon 提交前失败。Arena `video.generation` 已作为 experimental route 开放，并会自动进入独立且仅支持 Battle 的 `/video` surface。其 current-turn reader 会同时返回匿名 A/B 两个 HTTPS MP4 artifact 及其尺寸与时长；真实运行得到 1280×720/8 秒和 848×480/8.041667 秒两个视频，而 model selection、attachment、continuation、download 与跨 surface outcome 仍不可用。Adapter 也会处理 provider 自身提供、内容精确的 **Terms of Use & Privacy Policy** → **Agree** onboarding 对话框；由于当前所选账号已经接受过条款，新账号重复验证仍待完成。

Authenticated `POST /v1/images/generations` endpoint 是 browser 与 direct execution 共用的 canonical image input。Browser auto routing 只把 enabled、usable provider 与 `image.generation`、`artifact.download` 两条 route 取交集，再由已选 provider 组装自己的 image action；Gemini、豆包与 Dola 已加入此前闭环的 browser image routes。Direct V1 保留 logical `tokenless/pollinations/sana` model，并增加显式的 `tokenless/chatgpt/gpt-image`；两者使用同一个 scoped asset contract，同时不在 public model ID、response 或 capability evidence 中暴露 private backend name。ChatGPT direct image 会从选定的 managed browser bootstrap 一个短生命周期 provider-scoped session，经 private adapter 提交，最终只返回已验证的本地 asset。两种 mode 都返回共有 authenticated asset URL 与 metadata。真实 Pollinations direct gate 已生成并回读一张 768×768 JPEG；Gemini、Dola 与豆包的 focused gate 也分别完成了一次可见提交、终态 artifact、本地 digest 与 authenticated readback。

Browser image 请求现在可携带一个不超过 8 MiB 的 PNG、JPEG 或 WebP `reference_image` data URL。此类请求会按 `image.edit`、`image.input`、`file.upload` 与 `artifact.download` 的完整要求路由；remote URL 与 direct-mode reference image 会在 provider submission 前失败。目前只有 Arena 对外公开 reference-image route，因为只有它完成了真实编辑闭环。ChatGPT、Gemini、Grok、Qwen、Meta AI、豆包与 Dola 在各自 focused built-CLI gate 通过前仍不公开 editing。

可选开启的本地 [API proxy](api-proxy-integration.zh-CN.md) 覆盖解析出的 profile 上任何已启用 provider 的 `conversation.chat`，model 命名为 `tokenless/<provider>`。其 OpenAI Chat Completions route 已实现现代 function calls，可用非流式或终态 SSE 返回：Tokenless 校验 catalog 与完整的一对一 result history，调用方仍是唯一 tool executor。Prompt-emulated call 使用一个 strict whole-response JSON object，只接受 bare JSON 或一个完整的 `json`/`text` fence；prose、marker wrapper 与 multiple fence 均会 fail closed。Gemini 的 prompt-emulated tool selection 在三次真实 submission 中未观察到 injection refusal，但 prose lead-in 未通过这一边界，故仍不作支持声明；见[脱敏 evidence](evidence/openai-tool-prompt-framing-2026-08-15.md)。`tool_choice` 支持 auto、none、required 与一个精确 named function；省略/true `parallel_tool_calls` 允许按 model order 返回多个调用，false 最多允许一个，而 named choice 始终恰好返回一个。`strict: true` 只准入递归 closed object schema，要求每个 property 都是 required，并对返回 arguments 做 schema 校验。Framing、choice、call-count 或 schema violation 会以 `provider_output_protocol_error` 失败；只有 nonce-correlated outer final-content escaping failure 可以获得既有 bounded correction。Packaged daemon 已通过真实 DeepSeek 完成 [single-call](evidence/openai-tool-choice-strict-deepseek-2026-08-15.md)、[sequential streaming](evidence/dsh-streaming-tool-loop-2026-08-15.md) 与 [multiple-call](evidence/openai-multiple-tool-calls-deepseek-2026-08-15.md) tool loop。OpenAI structured final 现已支持有无 tools 时的 `json_object` 与已发布的递归 closed `json_schema` subset；non-stream 与终态 SSE 的成功 content 都是通过声明 schema 的 strict JSON，否则请求会明确失败。Structured number 必须是 canonical finite JSON number，schema/output 的整数值必须是 JavaScript safe integer。`$defs`、`$ref`、根节点 `anyOf` 与未列出的 schema keyword 会在创建 job 前被拒绝。Responses alias 现已公开同一 function/structured 语义，并支持 typed terminal event、full-input replay 与 bounded provider-affine `previous_response_id` ledger；见[当前 SDK 真实证据](evidence/openai-responses-deepseek-2026-08-15.md)。Anthropic tool use 仍不公开。Comparison、Search、Image、Code、Agent 与 Video 等 specialized outcome 继续使用 task API，以保留结构化输出。

保留的 `tokenless/auto` model 只为 `new-conversation` mode 下的 OpenAI browser tool 与 structured-final 请求公开。它会取 selected-profile enablement/current access、`conversation.chat` matrix 与更窄 Universal API evidence matrix 的交集；当前 candidate 为 DeepSeek 与 ChatGPT，Gemini tool routing 仍排除。完整 requirements 覆盖 tools、strict schema、history replay、request 允许的 multiple call，以及 text/`json_object`/`json_schema` final control。Selection 先偏好最近 auto public call id 编码的 origin，再沿用既有 capability rank 与 configured order。完整 canonical call/result pair 会以同一 public id replay 到新 provider conversation；provider-local URL 与 opaque state 不可 portable。现有 Managed Playwright fallback plan 只可在 `provider_submitted_at` 前切换；submission 后 failure 为 terminal，same-provider bounded correction 绕过 auto selection。Response 的 `tokenless` object 会暴露 settled provider、prompt strategy 与脱敏 durable attempt list。[当前脱敏 evidence](evidence/openai-auto-provider-routing-2026-08-15.md)覆盖 DeepSeek-to-ChatGPT tool continuation、两条 JSON strategy 与一次自然 post-submission terminal failure。

2026-08-15 的固定真实 provider复测中，ChatGPT 的 named strict call 为 5/5 public-valid，nested JSON Schema final为 4/5 public-valid（合计 9/10）。DeepSeek的两个五分钟 pilot均停留在 provider submission前 queued，未产生 public response；这是 availability结果，不是 schema accuracy结果。Gemini diagnostic虽有 upstream completion，但没有可靠 public-rate ledger，因此仍不进入支持矩阵。详见[rate evidence](evidence/openai-structured-control-rate-2026-08-15.md)。

Meta AI 的 `conversation.chat`、`file.upload`、`image.generation` 与 `artifact.download` 已对选定的登录 profile 实验性开放。Built CLI 与 packaged daemon 通过 headed Cloak `web-ai` 和真实 `meta.ai` network boundary，闭环了 readiness、prompt drafting、Instant/Thinking 精确选择与恢复、Markdown 附件可见接受、防御性 browser-fingerprinting 实质回答、conversation fallback 与持久化 mapping。图片 route 只读取最新可见 `[data-testid="assistant-message"]`，等待终态，通过 browser session 下载 authenticated HTTPS image bytes，使用 browser decoder 校验尺寸，保存 bytes，并提供 authenticated daemon readback 与本地 digest evidence。真实 asset run 生成了 1600×1600 PNG。Meta AI image editing 不公开；research steps、source list 与最终 citation link 仍未闭环。

Gemini Markdown `file.upload` 已作为 experimental route 对外提供，但仅适用于选定的已登录 profile。Gemini 会从卡片文本与 accessibility metadata 中移除文件名后缀，因此其 provider-specific acceptance proof 要求三张新增且物理可见的 `gem-attachment` 卡片，同时保留 caller 已验证的选定文件扩展名；generic detector 与其他 provider 仍要求可见扩展名 evidence。上传路径依次选择 **Upload & tools** 与 **Upload files**，并通过 **Cancel** 关闭可选 MMGen disclaimer，不代替用户接受该声明。

Gemini 的 `image.generation` 与 `artifact.download` 已作为 experimental browser routes 对外提供。Image action 会在 prompt input 前进入 Gemini Images；reader 以提交前 blob baseline 关联新出现且已 decode 的 `<img>`，在已 decode 图片仍可读取、但原 blob URL 即将失效时通过 canvas 导出，保存 PNG 并验证 authenticated daemon readback。

2026-08-09，built CLI 与 packaged daemon 通过 headed Cloak `web-ai` 上传了三份 Markdown 文档，并读取附件相关的可见回复（job `tlp_0b9dde88-e2c2-46e5-8231-81b4f74403e1`；provider 端到端 27.3 秒）。提交给 Gemini 的 Tokenless-rendered request 原样包含冻结的 521 字符 Matrix V2 user prompt；完整 rendered request 为 853 字符，并不等同于该 user prompt。本地 output-savings event 以 `o200k_base` 为 1,607 个可见回复字符估算了 295 个输出 token；这只是本地可见输出估算，并非 provider 计费或 input-token telemetry。

Qwen 的可见 **Select Mode** → **Upload attachment** chooser 与物理 Markdown 卡片检测已实现，但 `file.upload` 仍未公开。2026-08-09，仅包含本任务 provider 变更的 detached build 到达了三张可见 `.fileitem-btn` 卡片，其扩展名均为 `.md`；853 字符的 rendered request 原样包含冻结的 521 字符 Matrix V2 user prompt（job `tlp_14ec13d8-aba7-42c6-b328-f9095360d03a`；14.6 秒）。点击发送后没有出现可见转换：draft 与三张卡片仍在，没有 answer 或 busy state，durable state 中的 `provider_submitted_at` 仍未设置。Create Image action 与 current-turn image reader 现已实现，包括提交前 URL baseline 与 Qwen 图片 asset 落盘。Browser image routes 仍不公开，因为配置 profile 在 provider submission 前反复遇到 `chat.qwen.ai` DNS failure；独立页面观察不能替代规定的 built-CLI gate。

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

Perplexity `conversation.chat` 已作为 experimental route 对外提供。Guest session、prompt draft、submission、completed answer、normalized citations、可见 citation links、conversation mapping 与 durable state 已通过 built CLI、packaged daemon、runtime-bound Cloak profile 和真实 provider network。可见的 **Add files or tools** 菜单与 file chooser 已实现，但 `file.upload` 仍不公开：2026-08-09 在选取第三个文档时，选定的 Free plan 显示 **Upgrade for additional document analysis**，只留下两张可见附件卡片，因而无法完成完整的真实 E2E closure。Continuation、model selection、Deep Research、Spaces 与 generated assets 也仍不公开。

Z.ai `conversation.chat` 与 Markdown `file.upload` 已作为 experimental routes 对外提供。2026-08-09，built CLI 与 packaged daemon 通过 headed Cloak `web-ai` 添加了三张物理可见 Markdown 卡片，提交 exact attachment-detector prompt，并读取附件相关回复（job `tlp_0bc5f6de-b04d-4b35-85a0-2bd59e2ed227`；provider 端到端 34.1 秒）。该 job 记录了 531 estimated output tokens 与 2,770 visible characters，且没有 provider blocker。配置的 entry point 为 `https://z.ai/chat`；官方入口会把已准备的 draft 交给获准使用的 `https://chat.z.ai` runtime。Continuation、model 或 effort selection 及 GLM 高级工作流仍不公开。

Doubao `file.upload` 已作为 experimental route 对外提供文件选择能力。可见加号控件、provider 文件 input 与显示已接收文件名的卡片，均已通过 built CLI、packaged daemon、runtime-bound Cloak profile 和真实 provider network。`conversation.chat` 仍注册为需要登录的 experimental route：同一产品链路中的 readiness 与 prompt drafting 已通过，两次直接提交也得到了关联的可见 marker 回复。由于附着 E2E observer 时豆包显示 provider 自有的可见验证 iframe，所需 built-product mutation gate 尚未达到 release closure；challenge detection 会以 `visible_provider_blocker` fail closed。

豆包的 `image.generation` 与 `artifact.download` 已作为 experimental browser routes 对外提供。Image lifecycle 会在 prompt input 前使用已有 `doubao.skill` action 选择 `image-generation`，以提交前 baseline 关联最新 assistant image turn，保存 terminal image bytes 并验证 authenticated daemon readback。豆包还公开 provider-specific 的 `doubao.mode` 与 `doubao.skill` actions。较早的 non-submission gate 曾完成 mode/skill 检查与恢复，但 2026-08-17 focused rerun 目前在 `doubao.mode.inspect` 失败；这个 selector regression 与独立通过的 image route 分开记录。其他 controls 仍需各自完整的 outcome lifecycle，不能由 control selection 推断。

豆包 `auth.status` 也会读取可见账号控件，且只打开它的账号菜单。可见的“升级到专业版”会被派生为 `免费版` / `signed_in_free`；尚未观察的付费账号状态仍返回 `signed_in_unknown`，不会把购买页默认选中的报价误当成已购套餐。

Kimi `conversation.chat`、text-file `file.upload`、`search.web` 与基于搜索的 `response.citations` 已作为 experimental routes 对外提供，但只适用于选定的已登录 profile。Built CLI、packaged daemon、runtime-bound Cloak profile 与真实 provider network 已闭环 readiness、prompt drafting、精确模型与思考强度选择及恢复、文件接收、附件感知回答、Web search Auto/Off 精确选择、normalized 且可见的引用、第二个 CLI 进程在同一 conversation URL 上续聊，以及持久 task mapping。Plugin 与 Skill 的检查和精确可见选择也通过了 non-submission gate，但完整提交 outcome 当前受 Kimi 可见容量队列阻塞，因此未公开为 routes。Projects、Deep Research、agent workflows 与 artifact lifecycles 已有实现和 release gates，但真实 provider gates 尚未闭环，所以仍不公开。

Dola 已注册为需要登录的 experimental provider。其 `image.generation` 与 `artifact.download` 现在已作为独立于未公开 general `conversation.chat` route 的 experimental routes 对外提供。Image action 会在 prompt input 前进入精确的 `https://www.dola.com/chat/create-image` surface，以提交前 baseline 关联新出现且已 decode 的图片结果，保存 terminal image bytes 并验证 authenticated daemon readback。该 profile 的 general file 与 specialist workflows 仍分别受 gate 约束。

| Dola 控件或界面 | Canonical outcome candidates | 当前证据与 route 状态 |
| --- | --- | --- |
| Chat 与同 conversation 续聊 | `conversation.chat`, `conversation.continue` | 选定 profile 中已完成两轮关联对话；built-product gates 待完成 |
| Fast / Pro | `conversation.chat`；provider control `model.choice` | 两个选项均已 live-observed；exact selection 与 restoration gate 待完成 |
| 添加文件 | `file.upload` | 已实现相对 upload control 与 Markdown card detection；选定 profile 在多文档和顺序选择中都只显示一张物理卡片，因此 route 仍不公开 |
| Create Image / AI Creation | `image.generation`、`artifact.download` | Experimental routeable image surface；built CLI 与 packaged daemon 已完成一次可见提交、terminal image artifact、本地 digest 与 authenticated readback |
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

菜单项、selector、本地 replica 或成功的手工 prompt 都不足以声明 `e2e_closed`。Provider 行为只能在真实 provider 网站上开发与验证；真实 provider E2E 才是 acceptance boundary。

## 新增 Capability

只有当产品需要新的 provider-neutral outcome 时才增加 canonical capability，不能因为某家 provider 新增了控件或 marketing label 就直接添加。

1. **定义语义。** 写清 user outcome、parameters、outputs、lifecycle、side effects、implications、conflicts 与 terminal conditions。
2. **先检查 composition。** 如果现有 capability 或其组合能够完整表达结果，应优先复用。
3. **新增 catalog definition。** 更新 `packages/server/src/providers/task-capabilities.ts`，identifier 不得包含 provider 名称。
4. **实现 provider strategies。** Selector 与 provider-specific control 保留在 provider adapter 和 typed capability class 中。
5. **基于真实网站实现。** 在配置好的持久浏览器 profile 中观察并操作每个 materially distinct selector、parser state、blocker 与 transition；不得捕获或替代为 provider DOM fixture。
6. **声明 live acceptance。** 在 `test/live-provider-capability-matrix.json` 增加真实 case，并在 `test/live-managed-playwright.e2e.mjs` 实现 journey。
7. **闭环真实 boundary。** 使用 built CLI、packaged daemon、managed browser 与真实 provider network；不得使用本地 replica、interception 或 simulated response。
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

当前 catalog schema 是 `tokenless.task-capability-catalog.v3`。V3 为每个 provider binding 增加 `executionMode`，避免混淆 Browser 与 direct evidence。Runtime capability route 使用 `tokenless.task-capability-route.v2`，并通过 resolver、validator 与 managed job 传递同一个 mode。V2 删除了 `skill.invoke`：provider-native workflow 保持 namespaced provider control，user-owned Skill 则作为 Harness input 经 `file.upload` 交付。

- 新增独立 capability 通常属于 additive change。
- 新增 optional parameter 在旧 request 语义完全不变时可以是 additive change。
- 修改含义、required parameters、output contract、implications 或 safety boundary 属于 breaking change；应增加新的 capability identifier 或 catalog schema version。
- 新增或删除 provider route 改变的是 support availability，不改变 canonical capability 的含义。
- Provider UI label 与 selector 可以变化；只要 outcome contract 不变，就不需要修改公共 capability。

持久化 job 会记录 normalized capability route 与 evidence identifiers，因此 implementation 不得用不兼容语义重新解释既有 job。

## Sources of truth

| Concern | Source |
| --- | --- |
| Catalog definitions 与 provider routes | `packages/server/src/providers/task-capabilities.ts` |
| Provider-specific actions 与 payload contracts | `packages/server/src/providers/contracts.ts`、`action-catalog.ts` |
| Provider implementations | `packages/server/src/providers/` |
| 真实 provider required cases | `test/live-provider-capability-matrix.json` |
| 真实 provider journeys | `test/live-managed-playwright.e2e.mjs` |
| Provider website 测试边界 | `AGENTS.md`、`test/live-provider-capability-matrix.json` |
| Product reconnaissance | `docs/provider-capability-census.md` |
| CLI behavior | `COMMANDS.md` |

当文档与 runtime output 不一致时，以 `tokenless capabilities list --json` 和 checked-in source 为准，并在同一次 change 中修正文档。
