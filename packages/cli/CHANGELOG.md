# tokenless

## 0.6.0

### Minor Changes

- 500eeb4: Present API jobs as localized chat history with readable titles, provider identities, execution modes, token estimates, and conversation transcripts.

  将 API jobs 以本地化 chat history 展示，提供可读标题、provider identity、执行模式、token estimates 与 conversation transcripts。

- 2b30ad7: Add Arena browser-mode chat, exact Direct model choice, same-conversation continuation, grounded Direct Search with visible citations, complete Battle and Side-by-Side comparison results, Direct Image generation/editing, Direct Code website generation, Agent Mode execution, and Battle Video generation with structured visible results through the selected managed browser profile.

  新增 Arena browser-mode chat、精确 Direct model 选择、同 conversation continuation、带可见 citations 的 grounded Direct Search、完整 Battle 与 Side-by-Side 对比结果、Direct Image generation/editing、Direct Code website generation、Agent Mode 执行，以及通过选定 managed browser profile 获取结构化可见结果的 Battle Video generation。

- 371039f: Add ChatGPT, Grok, Arena, and Meta AI browser-mode image asset downloads plus G4F direct image persistence: generated PNG/JPEG/WebP bytes are verified and stored under task-, conversation-, request-, and time-scoped assets, while responses expose a relative asset reference, metadata, and SHA-256 digest. Add authenticated daemon readback at `/v1/asset/{taskId}/{conversationId}/{assetBatch}/{assetFile}`.

  新增 ChatGPT、Grok、Arena 与 Meta AI browser mode 图片 asset 下载能力，并加入 G4F direct 图片持久化：生成得到的 PNG/JPEG/WebP bytes 会经过验证，并按 task、conversation、request 与时间保存；response 只暴露 relative asset reference、metadata 与 SHA-256 digest。新增 authenticated daemon 读取接口 `/v1/asset/{taskId}/{conversationId}/{assetBatch}/{assetFile}`。

- 500eeb4: Accept one validated reference image on browser `/v1/images/generations` requests and route it through evidence-backed image editing.

  允许 browser `/v1/images/generations` requests 接收一个经过验证的 reference image，并通过有证据支持的 image editing route 处理。

- f0aa326: Add caller-controlled Page Refs so independent provider work owns independent tabs while multi-turn work can reuse one stable tab.
  Remove the E2E-only provider-task isolation branch and recover cleanly when users close managed tabs.

  新增由调用方控制的 Page Ref，让独立的 provider 工作使用独立 tab，同时让多轮工作稳定复用同一个 tab。
  移除仅供 E2E 使用的 provider-task 隔离分支，并在用户关闭托管 tab 后安全恢复。

- 0ebf5e6: Expose execution mode on task capability bindings and bump the catalog schema to v3 so Browser evidence is not confused with future direct bindings.

  在 task capability bindings 中公开 execution mode，并将 catalog schema 升级到 v3，避免把 Browser evidence 与未来的 Direct bindings 混淆。

- 500eeb4: Add direct ChatGPT image generation through the canonical image endpoint with mode-aware capability routes and scoped asset persistence.

  通过 canonical image endpoint 新增 direct ChatGPT image generation，并提供按 execution mode 区分的 capability routes 与 scoped asset persistence。

- 2b30ad7: Add a setup-managed, pinned private GPT4Free provider service behind the authenticated daemon API, with native or G4F backend selection, scoped HAR/Cookie/browser auth contexts, provider/media APIs, and retained native ChatGPT and Perplexity adapters for A/B rollout.

  在 authenticated daemon API 后新增 setup-managed、pinned 的 private GPT4Free provider service，支持 native 或 G4F backend 选择、按范围隔离的 HAR/Cookie/browser auth contexts 与 provider/media APIs，并保留 native ChatGPT 与 Perplexity adapters 以支持 A/B rollout。

- f5cc843: Route direct G4F traffic through the standard OpenAI Chat Completions and Responses endpoints with upstream streaming, and remove the public G4F-specific daemon routes.

  让 direct G4F traffic 通过标准 OpenAI Chat Completions 与 Responses endpoints，并支持 upstream streaming；移除公开的 G4F-specific daemon routes。

- 77edff2: Add the durable `tokenless agent run|read|resume|cancel` workflow with authenticated daemon routing, local stdio MCP catalogs, exact approval arguments, and restart-safe provider continuation.

  新增 durable `tokenless agent run|read|resume|cancel` workflow，支持 authenticated daemon routing、local stdio MCP catalogs、精确 approval arguments，以及可安全跨 restart 继续的 provider continuation。

- 610136f: Replace the ad hoc coding-prompt collection with a pinned FeatureBench agent runtime: task-scoped provider channels, container filesystem/shell/test tools, official `fb eval` verdicts, non-overwriting run reports, and real-provider wiring/full E2E entry points.

  用 pinned FeatureBench agent runtime 替代临时 coding-prompt collection：提供 task-scoped provider channels、container filesystem/shell/test tools、官方 `fb eval` verdicts、不会覆盖旧结果的 run reports，以及真实 provider wiring 与完整 E2E entry points。

- bb66332: Expose the consolidated G4F vendor catalog as Direct providers and show each provider's supported execution modes in the dashboard.

  将 consolidated G4F vendor catalog 公开为 Direct providers，并在 dashboard 中展示每个 provider 支持的 execution modes。

- dc9f8fd: Add a bilingual Experimental Router area to Providers with persisted provider routing roles, profile-aware eligibility, Chrome Prompt API testing and compatibility diagnostics, plus focused provider detail pages for routing and existing controls.

  在 Providers 中新增双语 Experimental Router 区域，支持持久化 provider routing roles、profile-aware eligibility、Chrome Prompt API testing 与 compatibility diagnostics，并提供聚焦 routing 和现有 controls 的 provider detail pages。

- abf8626: Add experimental Meta AI browser chat, file upload, and Instant/Thinking controls through the selected signed-in managed profile.

  通过选定的 signed-in managed profile 新增 experimental Meta AI browser chat、file upload 与 Instant/Thinking controls。

- 81709ce: Accept modern OpenAI function tools and structured final output on Chat Completions requests, including terminal SSE frames, complete multiple-call history, every `tool_choice` mode, `parallel_tool_calls`, `strict: true` arguments, `json_object`, and a published closed-object `json_schema` subset. Tokenless validates request-scoped catalogs, call/result history, tool arguments, and final JSON before returning model-ordered standard calls or exact schema-valid JSON text. Structured JSON numbers use one canonical finite spelling and safe integers so returned text cannot differ from the AJV value. Structured output also works without tools and after caller-owned tool execution; the API proxy never executes tools. Invalid requests fail before provider submission, while invalid provider framing, calls, arguments, or structured content fail with `provider_output_protocol_error`. Prompt-emulated calls use one strict whole-response JSON object, accepting only bare JSON or one complete `json`/`text` fence; marker wrappers, prose, and multiple fences fail closed. A nonce-correlated outer `kind: final` JSON string-escaping failure may receive one bounded same-provider correction before exposure; corrected inner structured content must still pass strict parsing and schema validation.

  The Universal API and Standalone Web Agent Harness now share only strict JSON parsing and AJV 2020 setup. Their OpenAI choice/correction/structured-output and Harness `action_batch`/execution semantics remain separate.

  Universal API 与 Standalone Web Agent Harness 现在只共享 strict JSON parsing 与 AJV 2020 setup；两者的 OpenAI choice/correction/structured-output 以及 Harness `action_batch`/execution semantics 仍然独立。

  Add the Universal Responses API on `/v1/responses` and `/v1/openai/responses`. It supports current flat function tools, typed call/result items, structured `text.format`, non-streaming output, typed terminal streaming, full-input replay, and same-route `previous_response_id` continuation through a 24-hour, 1,000-entry local ledger. Missing, expired, mismatched, or unverifiable opaque replay state fails before provider submission; Tokenless stores no fabricated reasoning or provider session state.

  在 `/v1/responses` 与 `/v1/openai/responses` 新增 Universal Responses API，支持当前 flat function tools、typed call/result items、structured `text.format`、non-streaming output、typed terminal streaming、full-input replay，以及通过 24 小时、1,000 条目的 local ledger 实现同 route 的 `previous_response_id` continuation。缺失、过期、不匹配或无法验证的 opaque replay state 会在 provider submission 前失败；Tokenless 不存储伪造 reasoning 或 provider session state。

  Add explicit `tokenless/auto` for OpenAI browser-mode tool and structured-final requests. Auto filters enabled and currently usable providers by the complete evidence-backed requirement set, preserves canonical tool history and versioned public call ids across providers, prefers the prior auto call's settled provider when still eligible, and reuses the existing durable pre-submission fallback plan. Responses ledger continuation treats its settled provider as portable affinity. The response metadata reports the actual settled provider, prompt strategy, and redacted provider attempts; exact provider models never auto-switch, and post-submission outcomes never replay to another provider.

  为 OpenAI browser-mode tool 与 structured-final requests 新增显式 `tokenless/auto`。Auto 会按完整的 evidence-backed requirement set 筛选已启用且当前可用的 providers，跨 provider 保留 canonical tool history 与 versioned public call ids；此前 auto call 的 settled provider 仍符合条件时会优先复用，并沿用现有 durable pre-submission fallback plan。Responses ledger continuation 将 settled provider 视为 portable affinity；response metadata 报告实际 settled provider、prompt strategy 与 redacted provider attempts，exact provider models 不会自动切换，post-submission outcomes 也不会重放到其他 provider。

- e3ce67e: Show Browser and Direct capability badges for every provider and add profile-scoped execution-mode controls to provider details.

  为每个 provider 展示 Browser 与 Direct capability badges，并在 provider details 中新增 profile-scoped execution-mode controls。

- b5ac343: Add one authenticated `/v1/images/generations` endpoint for browser and direct image generation, route CLI image runs through it, remove the public G4F-namespaced image route, and close Gemini, Dola, and Doubao browser image routes.

  为 browser 与 direct image generation 新增统一的 authenticated `/v1/images/generations` endpoint，让 CLI image runs 通过该 endpoint 路由；移除公开的 G4F-namespaced image route，并关闭 Gemini、Dola 与 Doubao browser image routes。

- 7653c94: Add an experimental Tokenless Harness Chrome side-panel extension with scoped Dashboard pairing, semantic page observation, full private local evidence, and individually approved input, click, submit, radio, upload, and navigation actions for one explicitly selected tab.

  新增 experimental Tokenless Harness Chrome side panel 扩展，通过 scoped Dashboard pairing、semantic page observation、完整私有本地证据，以及逐项批准的 input、click、submit、radio、upload 与 navigation 操作一个明确选择的 tab。

- 8885628: Add synchronous Tokenless Harness delegation with bounded workspace read/search tools, a reversible DeepSeek Harness subagent provider integration, and the pinned Terminal-Bench 2.0 runner for that combined lane. Document Codex as explicit delegation because its hooks do not replace native subagent execution.

  新增同步 Tokenless Harness delegation、有界 workspace read/search tools、可逆的 DeepSeek Harness subagent provider 集成，以及用于该组合 lane 的固定 Terminal-Bench 2.0 runner。Codex 因 hooks 无法替换 native subagent execution，按显式 delegation 如实记录。

- c5329ae: Add the authenticated menu bar snapshot contract, dashboard job deep links, and a read-only `tokenless upgrade --check` command for native macOS clients.

  新增 authenticated menu bar snapshot contract、dashboard job deep links，以及供原生 macOS clients 使用的只读 `tokenless upgrade --check` command。

- 5c60425: Move every non-compatibility bearer-authenticated Tokenless machine endpoint under `/v1/private/*`. Make `packages/contracts` a documentation-only OpenAPI source with one generated reference, and move runtime primitives and the provider-turn Client Adapter to their owning packages without changing payload, lifecycle, Dashboard, CLI, Harness, or provider behavior.

  将所有非 compatibility 的 bearer-authenticated Tokenless machine endpoint 统一迁移到 `/v1/private/*`。`packages/contracts` 收纯为 documentation-only OpenAPI source 与单一 generated reference，runtime primitive 和 provider-turn Client Adapter 回到各自 owner package；payload、lifecycle、Dashboard、CLI、Harness 与 provider behavior 保持不变。

- 28362bf: Let DeepSeek Harness benchmark agents inspect one file, delegate one bounded read-only workspace pass, then batch or locally search the permitted changes with a hard verification budget. Record safe live-page limit evidence, configured provider plan observations, and per-interaction token estimates in Terminal-Bench reports. Add the one-pass 89-task Terminal-Bench sweep as the required phase gate before the formal k=5 run.

  让 DeepSeek Harness benchmark agents 检查一个文件、执行一次有界的只读 workspace pass，再对获准变更进行 batch 或本地搜索，并设置严格的 verification budget。在 Terminal-Bench reports 中记录安全的 live-page limit evidence、配置的 provider plan observations 与每次 interaction 的 token estimates；在正式 k=5 run 前增加一次性 89-task Terminal-Bench sweep 作为必需的 phase gate。

  Terminal-Bench reports now distinguish successful and failed DeepSeek Harness parents from unsettled parent routing requests, and the sweep gate rejects those failures even when verifier rewards pass.

  Terminal-Bench reports 现在会区分成功和失败的 DeepSeek Harness parents 与尚未定案的 parent routing requests；即使 verifier rewards pass，sweep gate 仍会拒绝这些 failures。

- 5a5f421: Turn System into a complete configuration center with structured editing, a fresh server-backed config.json view, bottom-anchored navigation, and a dedicated Chat History icon.

  将 System 扩展为完整配置中心，提供结构化编辑、由 server 实时读取的 config.json 视图、固定在底部的导航入口，以及专用的对话历史图标。

- ef2ec65: Open Chat History conversations as complete Dashboard pages, keep provider-readiness feedback visually stable, and synchronize the local UI session before protected mutations.

  将对话历史详情改为完整的 Dashboard 页面，保持 Provider 就绪状态反馈稳定，并在受保护的修改请求前同步本地 UI 会话。

- f3426da: Add a Google Chrome Prompt API Dashboard flow for generating the pinned Terminal-Bench semantic manifest.

  新增 Google Chrome Prompt API Dashboard 流程，用于生成 pinned Terminal-Bench semantic manifest。

- 62d15e2: Localize CLI setup and success output, the full Dashboard, generated HTTP API references, and public product documentation in English and Simplified Chinese without changing commands, protocol values, or runtime behavior.

  为 CLI setup 与成功输出、完整 Dashboard、生成式 HTTP API reference 和公开产品文档提供 English/简体中文双语支持，不改变 command、protocol value 或 runtime behavior。

- bf11fbe: Keep Tokenless Harness runs in daemon memory and remove durable admissions, restart recovery, and `--admission-ref`.

  让 Tokenless Harness runs 保存在 daemon memory 中，并移除 durable admissions、restart recovery 与 `--admission-ref`。

- 2056fe7: Add provider-neutral semantic preferences and provider-scoped rate-limit fallback for Tokenless API auto routing, with per-provider Terminal-Bench observations.

  Allow auto private provider-turn continuations to retain their settled provider mapping while carrying portable provider-home fallback alternatives; exact provider bindings remain pinned.

  为 Tokenless API auto routing 增加 provider-neutral semantic preference 与 provider-scoped rate-limit fallback，并在 Terminal-Bench 中按 provider 记录观测指标。

  允许 auto private provider-turn continuation 保留 settled provider mapping，同时携带 portable provider-home fallback alternative；精确 provider binding 仍保持 pinned。

- 86d7b64: Allow every eligible text conversation provider to carry Tokenless-owned prompt-emulated function calls and structured finals. Recover one unambiguous JSON object from surrounding provider prose while preserving protocol, nonce, tool, call-count, history, and schema validation. Close a still-visible Z.ai announcement through its scoped dialog control when Escape does not unblock the real send button. Normalize provider-rendered non-breaking JSON spaces, read Meta AI JSON from its visible Raw view, and keep Arena Direct from treating the submitted prompt as an assistant answer.

  允许每个 eligible text conversation provider 承载由 Tokenless 实现的 prompt-emulated function call 与 structured final。在 provider prose 中提取唯一且无歧义的 JSON object，同时保留 protocol、nonce、tool、call-count、history 与 schema validation。当 Escape 未能解除 Z.ai 公告对真实发送按钮的遮挡时，只通过该公告内部的 dialog control 关闭它。统一 provider 页面渲染出的 JSON non-breaking space，从 Meta AI 可见的 Raw 视图读取 JSON，并防止 Arena Direct 把已提交的 prompt 当成 assistant answer。

- 315aa73: Add a dedicated setup route that discovers installed Chrome, Brave, and CloakBrowser runtimes, lets users add a verified native executable path, and saves the selected runtime with the config-wired default profile.

  新增专用 setup 路由，发现已安装的 Chrome、Brave 和 CloakBrowser runtime，允许用户添加经过验证的原生 executable path，并将所选 runtime 与配置关联的默认 profile 一起保存。

- 455a289: Use one `tokenless.sqlite3` for current business records: jobs, provider Project and conversation mappings, Responses API continuation entries, output-savings events, provider status observations, and Tokenless Harness context when used. Keep only in-flight Web AI execution in daemon memory; remove custom writer/startup locks, claim leases, checkpoints, replay/resume, delayed recovery, idempotency-key aliases, dispatch-certainty state, request-cancellation tombstones, legacy profile-registry import, and the background output-savings queue. Unfinished jobs fail with `job_interrupted` after restart; completed history and continuation state remain available.

  只使用一个 `tokenless.sqlite3` 存储当前业务记录：jobs、provider Project 与 conversation mappings、Responses API continuation entries、output-savings events、provider status observations，以及使用 Tokenless Harness 时的 context。只有 in-flight Web AI execution 留在 daemon memory；移除自定义 writer/startup lock、claim lease、checkpoint、replay/resume、delayed recovery、idempotency-key alias、dispatch-certainty state、request-cancellation tombstone、旧 profile-registry import 与后台 output-savings queue。重启后未完成 job 以 `job_interrupted` 失败；已完成历史和 continuation state 会继续保留。

### Patch Changes

- 91a7345: Keep Terminal-Bench Harness child terminal results inside the required JSON response envelope.

  确保 Terminal-Bench Harness child terminal result 保持在所需的 JSON response envelope 内。

- 893b2c9: Guide Terminal-Bench Git recovery through existing Git metadata and make benchmark Harness delegation distinguish workspace content searches from shell commands.

  引导 Terminal-Bench Git recovery 使用现有 Git metadata，并让 benchmark Harness delegation 明确区分 workspace content search 与 shell command。

- 0029040: Accept valid strict JSON tool-protocol finals whose text contains Markdown code fences, while continuing to reject multiple outer response fences.

  接受 final text 含 Markdown code fence 的有效 strict JSON tool-protocol response，同时继续拒绝多个 outer response fences。

- 5685e9c: Disable Dola image-generation and artifact routes after the 2026-09-01 real run could not reach the daemon, while retaining verified chat and document routes.

  在 2026-09-01 真实运行无法连接 daemon 后，关闭 Dola 的图像生成与 artifact 路由，同时保留已验证的聊天和文档路由。

- 902644d: Close Arena website-generation and agent-execution routes until stable real response evidence is restored, and correct the workspace response baseline check for one visible answer.

  在稳定的真实响应证据恢复前关闭 Arena website-generation 和 agent-execution 路由，并修正 workspace response baseline 检查以匹配单个可见回答。

- 4ba3477: Fix current Arena model selection and Qwen effort selection controls.

  修复 Arena 当前 model 选择和 Qwen effort 选择控件。

- 4f89cfe: Granularize browser file-input capabilities and stabilize Qwen document uploads.

  细分 browser file-input capabilities，并稳定 Qwen document uploads。

- 3553ec6: Make local API proxy failures distinguishable and serve the default OpenAI paths. Errors now carry a real HTTP status and a stable code — `404` for an unknown model, `413` for an oversized body, `499` on client disconnect, `502` for a visible-provider failure, `503` for a disabled proxy or unready profile, `504` for the completion deadline — so clients can decide whether to retry without matching message strings. `POST /v1/chat/completions` and `GET /v1/models` are accepted as aliases of the `/v1/openai` routes, letting an unmodified OpenAI client work with only a base-URL change, and every proxy route now requires the proxy to be enabled. `tokenless api-proxy status --json` reports the additional `openaiDefault` endpoint.

  让 local API proxy 的失败可区分，并提供默认 OpenAI paths。错误现在带有真实 HTTP status 与稳定 code：未知 model 为 `404`、请求体过大为 `413`、client disconnect 为 `499`、visible-provider failure 为 `502`、proxy disabled 或 profile 未就绪为 `503`、completion deadline 超时为 `504`，客户端无需匹配错误文本即可决定是否重试。`POST /v1/chat/completions` 与 `GET /v1/models` 作为 `/v1/openai` routes 的 aliases 接受，未修改的 OpenAI client 只需更换 base URL；每个 proxy route 都要求 proxy 已启用，`tokenless api-proxy status --json` 也会报告新增的 `openaiDefault` endpoint。

- 0b98b27: Keep Doubao capability inspection from opening the native file picker.

  保持 Doubao capability inspection 不打开 native file picker。

- 3e5e203: Restore Doubao image generation on the current Seedream surface and submit control.

  在当前 Seedream surface 上恢复 Doubao image generation 与 submit control。

- b5ac343: Detect Grok Free, SuperGrok Lite, and SuperGrok subscription access from the live model menu, and stop advertising Heavy or Build as selectable when the SuperGrok upgrade boundary is visible.

  从真实 model menu 检测 Grok Free、SuperGrok Lite 与 SuperGrok 订阅权限，并在 SuperGrok upgrade 边界可见时不再将 Heavy 或 Build 报告为可选。

- cf23603: Complete Linux x64 managed browser support: add the pinned Chrome for Testing 146 entry so `auto` resolves on Linux instead of failing with a missing catalog entry, discover system browsers from their Linux install paths instead of falling through to the Windows branch, and extract zip artifacts with unzip where GNU tar cannot read them.

  完成 Linux x64 managed browser 支持：加入 pinned Chrome for Testing 146 entry，使 `auto` 在 Linux 上能正常解析；从 Linux 安装路径发现 system browsers，避免错误落入 Windows branch；在 GNU tar 无法读取 zip artifacts 时使用 unzip 解压。

- cf23603: Add an opt-in local API proxy so existing OpenAI- and Anthropic-compatible clients can route Q&A traffic through visible provider sessions: new daemon routes `POST /v1/openai/chat/completions`, `GET /v1/openai/models`, and `POST /v1/anthropic/messages`, explicit `tokenless/<provider>` model naming, a `new-conversation` or `continue-conversation` mapping chosen during setup or with `tokenless api-proxy`, and fail-closed rejection of tool, function, and structured-output fields that visible pages cannot honour.

  新增 opt-in local API proxy，让现有 OpenAI- 与 Anthropic-compatible clients 可以通过 visible provider sessions 路由问答流量：提供 `POST /v1/openai/chat/completions`、`GET /v1/openai/models` 与 `POST /v1/anthropic/messages` daemon routes，明确使用 `tokenless/<provider>` model naming，并支持在 setup 或 `tokenless api-proxy` 中选择 `new-conversation` 或 `continue-conversation` mapping；visible pages 无法兑现的 tool、function 与 structured-output fields 会 fail closed。

- 1164999: Preserve fenced code and line breaks in visible-provider `response.read` results so generated programs can be evaluated without code-block toolbar text or whitespace loss.

  在 visible-provider `response.read` results 中保留 fenced code 与换行，使生成的程序可以在不混入 code-block toolbar text、也不丢失 whitespace 的情况下被评估。

- 500eeb4: Align the local API proxy with standard stateless Chat Completions and Responses continuation semantics: Chat Completions and Anthropic requests always start fresh provider chats, while a valid Responses `previous_response_id` resumes its mapped browser conversation and sends only the current input delta.

  让 local API proxy 对齐标准 stateless Chat Completions 与 Responses continuation semantics：Chat Completions 和 Anthropic requests 始终启动新的 provider chats；有效的 Responses `previous_response_id` 会恢复映射的 browser conversation，并只发送当前 input delta。

- 610136f: Prevent resident managed browsers from accumulating diagnostic `chrome://version` tabs and released provider `about:blank` pages across repeated test or worker detach cycles. Real provider, protected, borrowed, and control-plane pages remain open.

  防止驻留的托管浏览器在重复测试或 worker detach 后不断累积诊断用 `chrome://version` tab 与已释放的 provider `about:blank` 页面。真实 provider、protected、borrowed 与 control-plane 页面仍保持打开。

- a3c2d40: Harden the local dashboard's daemon connection with a shared typed contract, profile-scoped provider-readiness state, semantic dashboard operations, and immediate secure 404 responses for missing UI assets.

  通过 shared typed contract、profile-scoped provider-readiness state、semantic dashboard operations，以及对缺失 UI assets 立即返回的 secure 404 responses，强化 local dashboard 的 daemon connection。

- 0981a5e: Align the Dashboard header metrics on one line, report idle runtime activity accurately, and add a finished-job count.

  将 Dashboard header 指标对齐为单行，准确显示空闲 runtime 状态，并增加已结束任务计数。

- 293e258: Bind newly created and setup-managed profiles to the exact browser executable that created them, while retaining the existing protection against opening a profile with an older browser version.

  将新建和通过 setup 管理的 managed profile 绑定到创建它的确切 browser executable，同时保留现有的旧版本浏览器保护。

- 4ab236f: Clarify the installed Codex coordination guidance and paired documentation for internal sub-agents, sidebar-visible separate tasks, and concise coordinator reporting.

  补充 Codex coordination guidance 与配套文档，明确 internal sub-agent、侧边栏可见的 separate task，以及简洁的 coordinator 报告规则。

- 86d7b64: Classify uncertain visible prompt-submission failures as unknown-window provider rate limits so automatic routing can fall back before any provider submission occurs.

  将不确定的可见 prompt 提交失败归类为未知窗口的 provider rate limit，使自动路由可以在 provider 尚未收到提交时安全 fallback。

- d95a211: Close every released Tokenless API-owned provider tab after its idle timeout and let the Dashboard reopen an empty profile browser on demand.

  在空闲超时后关闭所有已释放且由 Tokenless API 拥有的 provider tabs，并允许 Dashboard 按需重新打开没有 tab 的 profile 浏览器。

- 536edf9: Bound auto new-conversation provider completion time within the existing request deadline and continue through each untried provider route once after a submitted timeout.

  在现有 request deadline 内限制 auto new-conversation 的单 provider completion 时间，并在 submitted timeout 后依次尝试每条尚未使用的 provider route 一次。

- 657872b: Open the Tokenless Dashboard in the operating system's default browser instead of the selected provider profile browser.

  使用操作系统默认浏览器打开 Tokenless Dashboard，不再使用所选 provider profile 的浏览器。

- d0021fd: Defer providers after a real visible rate-limit observation so auto routing does not immediately select the same exhausted provider again.

  真实可见的 rate-limit observation 出现后暂时 defer 对应 provider，避免 auto routing 立即再次选择同一个已耗尽 provider。

- a7ce915: Fix Dashboard Direct tooltips and links to show each provider's upstream API URL.

  修复 Dashboard Direct tooltips 与 links，使其显示每个 provider 的 upstream API URL。

- 89803cf: Remove AI Badgr and Api.Airforce from the Tokenless API provider catalog.

  从 Tokenless API provider catalog 中移除 AI Badgr 与 Api.Airforce。

- 89803cf: Explain Provider readiness icons and badges with localized hover tooltips, including observed provider-specific subscription tiers.

  为 Provider readiness icons 与 badges 增加 localized hover tooltips，并包含已观察到的 provider-specific subscription tiers 说明。

- 455a289: Mark providers that do not expose subscription tiers and hide the plan indicator for them in the dashboard.

  标记不提供订阅等级的 provider，并在 dashboard 中隐藏其方案指示器。

- 2e24f7d: Fix Arena authentication status detection by inspecting the visible sidebar account surface.

  通过检查可见的侧边栏账户界面，修复 Arena 登录状态检测。

- 89803cf: Increase text sizes throughout the Tokenless Dashboard for easier reading.

  增大 Tokenless Dashboard 的整体文字尺寸，提升可读性。

- b9ed152: Read completed Claude code-block responses, enter Claude prompts through native keyboard input, dismiss its observed transient `Not now` prompt, clear restored draft attachments and reload the cleared draft before Universal API new conversations, submit through its visible enabled send control even when a non-mutating actionability probe times out, retain native Enter only when no send control is present, preserve sanitized submit-actionability and provider-session diagnostics through the provider-action boundary before safe fallback, route away safely when that control remains disabled, isolate Universal API new conversations on replacement pages while preserving continuations, make the existing one-shot correction explicitly repair invalid structural punctuation and schema-invalid tool arguments, and admit its real-provider-proven single-call strict tool and tool-history scope to `tokenless/auto` routing.

  读取已完成的 Claude code-block response；通过原生键盘输入 Claude prompt；关闭已观察到的短暂 `Not now` 弹窗；在 Universal API 新会话开始前清除恢复的旧 draft 附件并 reload 已清空的 draft；即使非变更性 actionability 检查超时，仍通过可见且 enabled 的发送按钮提交，只在完全没有发送控件时保留 Claude 原生 Enter 路径；在安全 fallback 前让净化后的 submit actionability 与 provider-session diagnostics 完整穿过 provider-action 边界，并在控件仍 disabled 时安全路由到下一个 provider；让 Universal API 新会话使用 replacement page 隔离旧 draft，同时保留 continuation page；明确要求现有的一次性 correction 修复无效结构标点与 schema-invalid tool arguments；并将真实 provider 已验证的 single-call strict tool 与 tool-history scope 纳入 `tokenless/auto` routing。

- c5329ae: Show relative provider and conversation timestamps, readable truncated chat titles, per-provider readiness checks, a clearly limited recent-conversation summary, and direct job-detail links in the local Dashboard overview.

  在 local Dashboard overview 中显示 relative provider 与 conversation timestamps、可读的截断 chat titles、按 provider 的 readiness checks、明确受限的 recent-conversation summary，以及直接的 job-detail links。

- 5e297c8: Show canonical Browser and Direct entry URLs in interactive provider mode tooltips.

  在 interactive provider mode tooltips 中显示 canonical Browser 与 Direct entry URLs。

- c5329ae: Persist provider authentication observations in the shared `tokenless.sqlite3` while keeping profile identity and configuration in `config.json`.

  将 provider authentication observations 持久化到共享的 `tokenless.sqlite3`，profile identity 与 configuration 继续保存在 `config.json`。

- 455a289: Give every Tokenless Dashboard page its own pathname instead of a URL hash.

  为每个 Tokenless Dashboard 页面提供独立 pathname，不再使用 URL hash。

- ab8cde5: Require real bootstrap, tool, continuation, and final-result evidence for Browser Harness eligibility while retaining independently verified generic Markdown upload routes.

  要求 Browser Harness eligibility 必须具备真实 bootstrap、tool、continuation 与 final-result evidence，同时保留已独立验证的 generic Markdown upload routes。

## 0.5.0

### Minor Changes

- f89070a: Add an opt-in Codex integration with reversible global guidance, native lifecycle hooks, exact project/chat/turn/tool-call binding, App Server enrichment, and durable provider conversation continuity.
- 1347720: Enable output savings measurement by default, durably process first-response tokenization after provider completion in an isolated child process, and keep a prominent savings summary on the dashboard with a clear disabled state.
- e840aee: Add Dola as an experimental managed-browser provider with signed-in chat, Fast/Pro selection, file input, image/writing/video/translation/homework capability candidates, navigation, sanitized-DOM capture, and real-provider release gates.

  新增实验性 Dola managed-browser provider，覆盖登录态 chat、Fast/Pro、file input、图片/写作/视频/翻译/作业能力候选、navigation、sanitized DOM capture 与真实 provider release gates。

- 3eb3f73: Add native Google Chrome and Brave selection after the Anti-Detect setup choice, support a verified user-supplied executable path, attach through the selected browser's managed CDP endpoint, and retire browser-profile import compatibility checks. Missing native browsers now produce an end-of-setup action warning; the first browser action validates the configured path or standard installation before use.
- 6075a7f: Replace managed browser profile imports with headed native connections to the user's running Google Chrome 144+ instance. After the user enables Remote Debugging, Chrome manages the CDP endpoint and Tokenless discovers it without a fixed-port setting. Tokenless checks support by connecting, manages only its own tabs, and disconnects without closing Chrome when the daemon stops.
- e0c7f3c: Store complete per-profile provider configuration in `config.json` under `profiles`, migrate the legacy side table with the registered profiles, and expose profile configuration directly in CLI and dashboard payloads.
- 15ebb8c: Separate provider-native workflows from canonical capabilities, remove `skill.invoke`, and deliver caller-selected Harness Skills through the standard chat and file-upload route.

  将 provider-native workflow 与 canonical capability 分离，删除 `skill.invoke`，并通过标准 chat 与 file-upload route 交付 caller-selected Harness Skills。

- 1c0d2e9: Add explicit `tokenless setup --install-codex` onboarding and bind Codex CLI calls to concrete `CODEX_THREAD_ID` tasks while preserving Hook session-tree provenance and automatically reusing native provider workspaces.

### Patch Changes

- 75ad601: Consolidate managed browser control on CDP, remove the obsolete browser connection mode from configuration and UI contracts, and keep Playwright's page and locator APIs for automation. Existing configuration files must remove `browserConnectionMode`; all legacy values are rejected.
- 1bf51f9: Add checksum-pinned official CloakBrowser downloads for Intel macOS and Linux arm64/x64 while retaining the existing Apple Silicon macOS and Windows x64 pins.
- f1ea0fb: Advertise experimental DeepSeek chat and Markdown file-upload routes after a real headed managed-browser run proved three visible attachment cards, prompt submission, and response reading.

  在真实 headed managed browser 运行验证三张可见附件卡片、prompt 提交与回复读取后，公开实验性的 DeepSeek chat 和 Markdown 文件上传 routes。

- cccf099: Open the loopback local console directly without a bootstrap ticket while preserving UI CSRF and machine API bearer protections.
- dbb999c: Report configuration completeness in `tokenless doctor`, including stale or missing user-supplied Chrome and Brave executable paths.
- f1ea0fb: Update Dola's relative upload and submit controls and recognize physical Markdown attachment cards, while leaving chat and file-upload routes unadvertised because the selected profile accepted only one visible document card.

  更新 Dola 的相对 upload 与 submit controls，并识别物理可见的 Markdown 附件卡片；由于选定 profile 仅接收一张可见文档卡片，chat 与 file-upload routes 仍不公开。

- 562baed: Recognize Gemini's signed-in navigation and Z.ai's visible user menu before reporting a guest session from `auth.status`.
- a26661a: Add experimental Gemini Markdown file upload with physical attachment-card acceptance and the visible Upload & tools flow. Implement Qwen's visible Upload attachment chooser and Markdown card detector while keeping its route unadvertised because the real built-product send click had no visible transition and submission remained ambiguous.

  新增实验性的 Gemini Markdown 文件上传，通过物理附件卡片与可见 Upload & tools 流程证明接收。实现 Qwen 的可见 Upload attachment chooser 与 Markdown 卡片检测；由于真实 built-product 的发送点击没有可见转换，submission 仍存在歧义，继续不公开其 route。

- 94bf3c1: Keep hook-injected project and chat names as task identity unless Workspace handling is explicitly requested.
- 7871659: Keep managed browsers resident across jobs and daemon restarts. Dashboard provider-readiness refreshes run headlessly when the profile is idle, reuse an existing headed browser without replacing or foregrounding it, and reserve visible browser handoff for explicit user actions.

  Managed browsers 会跨 jobs 和 daemon 重启保持常驻。Dashboard 刷新 Provider 就绪状态时，会在 Profile 空闲时以 headless 方式运行；已有 headed browser 时则静默复用且不替换或带到前台，仅在用户显式操作时启动可见 handoff。

- ed476a9: Upload the Harness System Prompt and every selected Skill as independent Markdown files in one visible provider batch.
- f1ea0fb: Reconnect a managed browser that was already running before resident-browser session metadata existed, instead of trying to launch a second browser against the same profile.

  重新连接在驻留浏览器 session 元数据出现前已运行的托管浏览器，避免对同一 profile 启动第二个浏览器。

- c3a7c2d: Refresh Tokenless skills in the canonical shared directory and existing direct agent skill directories during setup and upgrade, including Codex and Claude Code.
- 913b9d0: Let production managed browsers use native credential storage so compatible copied profiles can preserve macOS Keychain-encrypted sign-in state, and document the expected Safe Storage prompt.
- f1ea0fb: Perplexity file upload remains unadvertised when the selected Free plan visibly requires an upgrade for a third document.

  当选定的 Free plan 对第三个文档显示可见升级要求时，Perplexity 文件上传继续不对外公开。

- 0290c36: Move browser opening from the global dashboard header to profile-specific controls, always open those controls in a visible managed browser, and let headed dashboard pages respond to the managed browser window size.
- 83b6352: Use profile slugs as the only profile names across the CLI and local console.
- f1ea0fb: Recognize Claude attachment filenames before concatenated card metadata and Kimi filenames with separate extension badges, while retaining count-plus-extension evidence. During the CDP-only transition, accept only the exact legacy `browserConnectionMode: 'playwright'` value and omit that retired field from normalized config.

  正确识别 Claude 附件卡片中拼接元数据前的文件名，以及 Kimi 将扩展名拆分为独立标记的成功文件卡片，同时保留数量加扩展名证据。迁移到 CDP-only 控制期间，仅接受精确的旧值 `browserConnectionMode: 'playwright'`，并从规范化配置中省略该已退役字段。

- 6148137: Keep headed provider tabs and the local dashboard open when another provider tab is closed or the dashboard is refreshed.
- 0290c36: Simplify interactive setup provider selection with an all-enabled list and numbered removals.
- 5db3fdd: Wait for Qwen attachments to finish visible parsing before prompt submission, use provider-specific interaction windows, require provider acknowledgement after one actionable submit click, and fail response reads that have no visible answer.

  在提交 prompt 前等待 Qwen 附件完成可见解析，使用 provider-specific 交互等待窗口，在唯一一次可操作提交点击后要求 provider acknowledgement，并让没有可见答案的 response read 明确失败。

- dfd367c: Add an Overview refresh control that rechecks sign-in readiness for every enabled provider in the selected managed profile.
- f129343: Stop rejecting managed profile registries based on POSIX mode bits so valid Windows profiles remain usable while Tokenless continues to create registry files with private permissions where supported.

  不再根据 POSIX mode 位拒绝托管浏览器配置注册表，避免有效的 Windows 配置被误判；Tokenless 仍会在平台支持时以私有权限创建注册表文件。

- 091258f: Persist bounded, text-free response selector diagnostics with sanitized snapshots and response reads.
- 83b6352: Stop the daemon only after background output-savings work has released the shared database, and let live release gates inspect an already-resident configured browser.

  等待后台 output-savings 工作释放共享数据库后再停止 daemon，并允许实时发布门禁检查已常驻的配置浏览器。

- 0480d5b: Dismiss blocking Z.ai announcements before prompt entry, reuse open Doubao mode menus, wait for hydrated provider choice controls, preserve mapped native Project conversations, read complete Claude responses, apply Claude Project instructions through the visible instructions dialog, and stop advertising incomplete DeepSeek and Qwen conversation, Grok and Kimi native Project, Qwen mode, and Kimi model, library, or long-running workflows.

  在输入提示词前关闭阻塞操作的 Z.ai 公告、复用已打开的豆包模式菜单、等待 provider choice 控件完成加载、保留已映射的原生 Project 对话、完整读取 Claude 回复并通过可见的说明对话框应用 Claude Project instructions，同时停止宣称未闭环的 DeepSeek、Qwen 对话、Grok、Kimi 原生 Project、Qwen mode 以及 Kimi model、library 和 long-running workflows。

- e177aef: Require a stable visible provider response before a completed run is returned.
- 35343ce: Check provider readiness in batches of up to three task-owned background tabs and close every temporary tab after observation.

  Provider 就绪检查会以最多三个一批的方式使用任务自有后台 tab，并在观察结束后关闭所有临时 tab。

- 47b7373: Wait for provider responses and managed job completion without a universal elapsed-time deadline while preserving explicit cancellation and runner shutdown. Explicit `--timeout-ms` continues to cancel the waiting job when it elapses.

  等待 provider 响应和托管任务完成时不再使用统一的耗时截止，同时保留显式取消与 runner 停止能力。显式 `--timeout-ms` 到期时仍会取消正在等待的任务。

- e0c7f3c: Use stable locale catalog keys for CLI output and local-console error summaries, with Simplified Chinese privacy guidance.
- 15ebb8c: Accept multi-file provider uploads from newly visible attachment evidence by count and file-extension multiset, even when providers rename files.

  通过新增可见附件证据的数量与文件扩展名多重集接受多文件 Provider 上传，即使 Provider 重命名文件也能正常识别。

- f08835d: Add an authenticated loopback Web AI Interaction Protocol V0 control-plane surface for configured managed provider profiles.
- 7a01fb8: Add durable cancellation fencing for local Web AI V0 request references.
- 5f5e54d: Make local Web AI bootstrap `requestRef` retries durable and conflict-safe across daemon restarts.
- f1ea0fb: Add experimental Z.ai Markdown file upload after the real headed managed-browser flow proves physical visible attachment chips.

  在真实 headed managed browser 流程验证物理可见附件卡片后，新增实验性 Z.ai Markdown 文件上传。

## 0.4.1

### Patch Changes

- b4556a9: Fix `tokenless upgrade --json` rejecting its default empty capability argument state before starting the upgrade workflow.

## 0.4.0

### Minor Changes

- f676cd6: Add experimental signed-in Kimi chat, text-file upload, Web search with citations, model and thinking-effort controls, and provider-native Plugin and Skill controls with real Cloak capability gates.
- 2986940: Add profile-bound browser runtime selection with system-first auto discovery, a locked managed Chrome for Testing fallback, explicit Anti-Detect CloakBrowser setup, safe known-Chromium profile/version inventory before Cloak download, exact four-component Cloak compatibility classification, interactive or explicit non-interactive clean-profile confirmation, clean runtime-isolated profiles, exact daemon runtime errors, transactional artifact security verification, per-provider setup review tabs, keychain-neutral E2E Cloak launches, separate doctor profile/runtime compatibility checks, and gated real-browser acceptance coverage.
- bf24d96: Cache the verified browser executable path in persistent config, resolve concrete browser selections during setup and install, retry standard-path discovery after stale cache entries, and add CLI and dashboard recovery controls for custom system-browser paths. Interactive setup no longer asks users to choose a normal browser runtime. Anti-Detect setup discloses Cloak installation in its initial question and uses one clean-or-compatible-profile source choice, without redundant import, copy-consent, or final installation prompts. Opaque import remains limited to profiles whose Chromium version exactly matches the supported CloakBrowser runtime, with a final compatibility check at the copy boundary.
- f6dd951: Add experimental four-provider capability inspection, explicit Workspace fallback modes, trusted conversation continuation, and visible file-upload acceptance evidence.
- 1d44047: Add a canonical task-capability catalog, expose evidence-backed provider routes through `tokenless capabilities list`, and route normal runs by explicit and inferred capability requirements before browser mutation.
- 3f21056: Rank automatic provider fallback by the run's complete capability requirements, recheck live eligibility before mutation, reject under-declared routes, preserve a versioned context envelope, expose structured durable fallback evidence, and fail closed when file selection lacks visible provider acceptance.
- ef33467: Unify and simplify the local CLI-daemon HTTP boundary under one Tokenless Daemon API v1 OpenAPI contract: keep only public job and browser-runtime routes, run Playwright coordination in-process, require proof before bearer use, and remove unreleased legacy payloads and extension compatibility.
- d099d88: Add experimental Qwen guest-session support through the shared provider registry and visible Playwright workflow.
- 09f5f07: Add the experimental DeepSeek visible-session provider with safe navigation, sign-in detection, baseline chat controls, and evidence-gated capability classification.
- 3f21056: Add experimental DeepSeek visible provider support with exact Instant, Expert, and Vision mode selection, independent DeepThink and Search controls, hCaptcha detection, mode-aware capability inspection, and provenance-bound real-session DOM fixtures.
- b9421d3: Add an experimental signed-in Doubao adapter with visible account and free-tier inspection, Cloak-tested file upload, exact mode and coding-oriented Web skill controls, visible unavailable-state handling, prompt and response handling, and provider challenge detection.
- 50a20b5: Add the secure bilingual local web control plane, verified browser discovery and executable-path recovery, explicit opaque local profile import and re-import, profile-scoped provider and browser preferences, reserved dashboard tabs, setup handoff, dashboard CLI command, and browser-facing administration API.
- d3d78ce: Add English and Simplified Chinese CLI output selected during setup or through the persistent language config.
- e3c1ca0: Add opt-in output savings measurement with a lazily downloaded checksum-pinned local tokenizer, durable per-job attribution and aggregates, explicit CLI and bilingual dashboard controls, doctor diagnostics, and a real cross-platform runtime verification workflow.
- 3f21056: Add experimental Perplexity guest chat routing with live prompt submission, completed responses, normalized citations, and visible citation-link closure through a managed Cloak profile.
- bd4b7c9: Route implicit provider jobs through cached setup observations, report pre-submission errors when no cached provider is usable, and make doctor report provider usability plus normally stopped on-demand runtime state without treating either as damage.
- 3f21056: Add a packaged subscription-aware provider rate-limit catalog, durable submission history, cadence-based admission and deferral, in-scope provider fallback, visible cooldown handling, and `tokenless limits inspect` diagnostics.
- 2986940: Automatically fallback implicit runs across capability-compatible providers before human handoff while preserving one durable job and provider-attempt history.
- b9421d3: Rename persistent preferred provider configuration to `providerWhitelist`, default it to every non-disabled provider except Gemini, and migrate existing config on the next write.
- bb7bf16: Ship Tokenless as a pure JavaScript package with the TypeScript daemon embedded in the CLI package, removing platform-specific native runtime packages and standalone Playwright runner artifacts.
- 09f5f07: Preserve independent browser tabs for different providers, projects, and conversations unless a local job explicitly requests replacement.
- 7df255f: Add concise human-readable CLI output by default, `--verbose` diagnostics, and cross-platform `--color`/`--no-color` controls without changing JSON output.
- 7652158: Add Qwen-specific mode discovery and selection, including Deep Research variants and Auto/Thinking/Fast effort controls.
- 2f0f90f: Add real Claude and Grok native Project creation, exact reuse, instruction outcomes, and durable Project-scoped conversation identity. Use the canonical Qwen Studio chat surface with hydration-safe guest submission.
- df5edf7: Fail provider authentication checks closed on visible account controls and include visible provider usernames and subscription labels in managed profile output.
- 3f21056: Add experimental Z.ai guest chat routing with Cloak-verified prompt submission, completed visible responses, conversation mapping, and durable state.

### Patch Changes

- f676cd6: Keep headed automation tabs and navigation in the background, foregrounding the browser only for explicit user handoffs.
- f6dd951: Add case-sensitive `-P` profile and `-p` provider CLI shortcuts.
- 107ee7e: Add an experimental config-only Playwright/CDP browser connection mode and a two-mode real-browser capability matrix while preserving the existing default.
- 28cfb6d: Reorganize CLI help into concise canonical and advanced command groups.
- bacffef: Classify Claude Cloudflare human checks as a narrow live E2E release-gate known issue when the durable blocker code is structured as `visible_cloudflare_turnstile` or `visible_cloudflare_interstitial`.
- 21844cc: Publish a complete bilingual CLI command reference and link it from built-in help and public READMEs.
- 350fba0: Start the local daemon on demand with SQLite-backed dynamic endpoint discovery, recover leased and checkpointed jobs after restart, and add agent-scoped one-time outcome replay with durable full-result lookup.
- 0d438ec: Accept non-empty visible composer content after prompt input instead of requiring an exact DOM text match.
- f6dd951: Report Grok profiles as Free or SuperGrok from visible model entitlements and inventory redacted provider DOM fixtures by page URL.
- 0dc3e49: Add provider access/tier reporting and a provider-session state machine that runs ChatGPT and Gemini guest sessions, hands unauthenticated Claude and Grok jobs to the user before task input, and persists redacted structural DOM snapshots.
- 2986940: Preserve limited Chromium compatibility state when importing a browser profile with explicit user consent.
- 7df255f: Include Gemini in new default provider profiles and write real-provider E2E results as provider-grouped capability reports.
- b9421d3: Keep every production Chromium launch keychain-neutral with `--password-store=basic` and `--use-mock-keychain`, regardless of the configured browser executable or connection mode.
- 0d438ec: Keep managed-profile initialization user-run instead of triggering it from agent skills.
- f676cd6: Reuse an already approved provider page instead of refreshing it before every action, preserving visible conversation and control state across CLI jobs for the same task.
- 378ed4c: Keep one stable browser instance per active managed profile while removing the macOS-specific inspection launcher.
- 0d438ec: Wait for visible prompt input and submit controls, distinguish availability timeouts from action failures, and allow free or anonymous prompt surfaces without an authentication precheck.
- 1d44047: Allow `tokenless profiles open` to launch a managed profile without selecting or navigating to a provider unless `--provider` is passed.
- abc58bb: Record intermittent Qwen DNS failures as retryable suspected rate limits without claiming confirmed provider throttling, and document the distinction and recovery steps.
- f676cd6: Wait for Qwen's visible Deep Research variant menu to settle and scroll the selected option into view before clicking it.
- bcabe9a: Gracefully restart a proof-verified stale local daemon from the current CLI package when its package version or control API revision no longer matches.
- 0dc3e49: Make ordinary daemon reuse depend on verified ready identity plus the exact package version, and let `tokenless setup` reconcile same-home version drift only after proof verification.
- df5edf7: Check each provider's setup sign-in status once and report it without opening a login handoff or retrying.
- 0d438ec: Make `tokenless setup` report the local CLI version against npm latest and reconcile installed-runtime drift after verified same-home ready identity.
- 0dc3e49: Simplify daemon readiness to the same-home proof plus exact package version, and keep shutdown on the bearer-authenticated control endpoint.
- 28cfb6d: Negotiate daemon reuse independently from package versions, and add `tokenless daemon stop` with same-home ready verification followed by bearer-authenticated graceful self-shutdown that waits for the daemon-managed browser to release its profile before returning.
- 4317e00: Reject unknown and command-incompatible CLI options before dispatch, include command usage in human and JSON errors, and add common per-command `-h`/`--help`.
- 77ebc9f: Unify setup and upgrade maintenance so the verified current CLI always upserts global Tokenless skills and reconciles its matching TypeScript daemon.
- bf24d96: Move provider entry points and known page URL patterns into one navigation catalog, and use `https://z.ai/chat` as the Z.ai entry while retaining its official chat runtime origin.

## 0.3.0

### Minor Changes

- 462123b: Add browser visibility policy support to Tokenless config and managed Playwright job requests, including durable resume after a headless job parks for user handoff.

### Patch Changes

- 6d52df5: Ship the current Tokenless reliability release as one patch:

  - Retire the browser extension and Native Messaging host, leaving the managed Playwright daemon as the active runtime.
  - Remove the experimental direct runtime, direct broker, account/project routing commands, direct public exports, and direct-only documentation so managed Playwright through the authenticated local daemon is the only execution path.
  - Provision and verify the local daemon before provider sign-in, restart only process-correlated stale daemons, and keep doctor diagnostics read-only.
  - Add prompt-free `tokenless upgrade` with concise human progress and structured `--json` output to update the global CLI, refresh Tokenless agent skills, reconcile the packaged daemon through the verified new CLI, and report its final doctor result.
  - Keep animated setup progress stable on one terminal line, including in narrow and hosted terminals.
  - Make setup check every supported visible provider, preserve ChatGPT as the default run provider, reject obsolete setup-only provider filters, and document the supported browser-profile import scope.

- 08000f1: Enable Chromium sandboxing for managed visible browser sessions so Chrome no longer launches with the unsupported `--no-sandbox` flag.

## 0.2.0

### Minor Changes

- 551561f: Add Grok as a visible browser-session provider across CLI setup, provider preferences, and extension routing.

## 0.1.2

### Patch Changes

- 3900934: Publish the platform-native daemon and Native Messaging runtime packages required by the universal CLI.
