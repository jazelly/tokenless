# Provider 直连协议与浏览器会话桥接

Status: active implementation | Priority: P0

Related: [Provider Expansion and Parity](P0-provider-expansion.md), [Real Provider Browser E2E and Native Projects](P0-real-provider-browser-e2e-and-native-projects.md), and [Web AI Interaction Protocol](P0-web-ai-interaction-protocol.md)

## 结果

Tokenless 增加用户显式选择的 provider 直连模式。它从选定的本地浏览器 profile 取得当前 provider 所需的会话材料，再用浏览器指纹一致的 Node.js HTTP transport 调用该 provider 的真实 Web endpoint。

直连模式与可见浏览器模式共用 provider、profile、job、capability 和结果边界，但保持不同的执行证明。任何 direct capability 必须通过真实 endpoint 单独验证，不能用 browser-mode 结果代替。

## gpt4free 能力基线

截至 2026-08-10，gpt4free 的 `OpenaiChat` 路线包含以下可复用思路：

| 层次 | gpt4free 当前能力 | Tokenless 处理方向 |
| --- | --- | --- |
| 会话引导 | HAR、cookies、access token 或浏览器登录 | 只从用户显式选择的 managed profile 在内存中引导 |
| HTTP transport | `curl_cffi` Chrome impersonation、session cookies、SSE、WebSocket | Node.js `impers`；若真实边界证明失败，再单独评估 Python |
| 请求要求 | sentinel requirements、proof-of-work、短期 token | provider adapter 每次按真实协议取得和计算 |
| 基础聊天 | prepare、conversation request、流式文本、conversation/message identity | 第一阶段只交付一次新文本聊天 |
| 对话控制 | continuation、variant、auto-continue、temporary chat | 后续按独立 capability 验证 |
| 模型能力 | model、reasoning effort、system hints、web search | 后续按独立 capability 验证 |
| 上下文 | 文件上传、图片输入、系统消息、历史消息 | 后续与现有 browser capability 对齐 |
| 富结果 | citations、reasoning、title、图片生成、音频合成、异步媒体任务 | 后续逐项标准化，不把文本成功误报为富能力成功 |

基线只描述竞品源码能够尝试的协议路径，不等于 Tokenless 已支持，也不等于 provider 对当前账号持续提供该能力。

### 固定源码清单

以下清单固定到 gpt4free commit [`4d750f842f0b60de07c65e0bcc024a54ec2fd0f0`](https://github.com/xtekky/gpt4free/tree/4d750f842f0b60de07c65e0bcc024a54ec2fd0f0)。路径存在只证明该版本包含相应实现，不证明它仍能成功，也不代表 Tokenless 已支持 direct mode。

| Provider | 固定源码路径与核心流程 / challenge | Tokenless 状态 / 下一优先级 |
| --- | --- | --- |
| ChatGPT | `g4f/Provider/needs_auth/OpenaiChat.py`；session/access token → requirements → PoW，可遇 Turnstile/Arkose → conversation stream | direct 新文本已实证；后续按 continuation、model、附件拆分 |
| Gemini | `g4f/Provider/needs_auth/Gemini.py`、`gemini_utils.py`；Google cookies、页面 XSRF/SID/build metadata → `StreamGenerate` framed stream，另有 cookie rotation | browser 已支持、direct 未实现；优先于媒体能力先验证纯文本 token/bootstrap |
| Grok | `g4f/Provider/needs_auth/Grok.py`；登录 cookies → `/rest/app-chat/conversations/new` 或 continuation response stream | browser 已支持、direct 未实现；作为下一批较薄的 first-party REST 候选 |
| Qwen | `g4f/Provider/Qwen.py`；auth/JWT → new chat → `/api/v2/chat/completions` SSE；部分路径要求 reCAPTCHA | browser experimental、direct 未实现；先证明不自动处理 CAPTCHA 的新文本路径 |
| DeepSeek | `g4f/Provider/needs_auth/DeepSeek.py`、`needs_auth/deepseek/pow_solver.wasm`；auth token → PoW challenge/solve → chat session → completion SSE | browser experimental、direct 未实现；PoW 与 session create 是独立验证切片 |
| Perplexity | `g4f/Provider/Perplexity.py`；origin cookies、可选 auth-session → `/rest/sse/perplexity_ask` → diff blocks | direct 新文本已实证；后续验证 continuation、citations 和 model controls |
| Z.ai / GLM | `g4f/Provider/glm/__init__.py`、`glm/captcha_solver.py`；JWT/API key → new chat → fingerprint query + `x-signature` → SSE；可能要求 Aliyun Captcha | browser experimental、direct 未实现；不自动解 CAPTCHA，先验证无 challenge 的真实账号路径 |
| Claude | `g4f/Provider/needs_auth/Claude.py` 指向第三方 `claude.gpt4free.workers.dev`，不是 `claude.ai` first-party Web protocol | browser 已支持；该来源不进入 direct baseline，需独立研究 first-party boundary |
| Kimi / Doubao / Dola | 该 commit 没有对应 first-party Web adapter | browser experimental；无可移植 baseline，待独立真实流量研究 |

## 第一里程碑：ChatGPT 新文本聊天

### Mission Contract

`goal`：用户可通过构建后的 CLI，使用一个已登录 ChatGPT 的 Tokenless profile，完成一次 Node.js direct HTTP 文本聊天并取得回答。

`non-goals`：续聊、附件、模型或 effort 选择、联网搜索、图像或音频、Projects、guest access、自动 fallback、重试或会话材料持久化。

`v1 boundary`：`tokenless run --provider chatgpt --execution-mode direct --prompt <text> --json` 是唯一新增 happy path。现有默认 browser mode 保持原行为。

### Assertions

| ID | 可观察行为 | 证据 |
| --- | --- | --- |
| DIR-001 | CLI 只在用户显式选择 `direct` 时进入直连模式；当前只允许已单独验证的 ChatGPT 与 Perplexity，且对非基础文本动作明确失败 | 构建后的 CLI 参数验证 |
| DIR-002 | adapter 从选定 profile 的当前 ChatGPT 浏览器会话取得最小 cookies、access token 和 user agent，且这些值不出现在 stdout、stderr、job result、checkpoint 或测试报告 | 代码审查加真实失败/成功输出检查 |
| DIR-003 | Node.js transport 使用 Chrome impersonation，对真实 ChatGPT requirements 和 conversation endpoint 完成一次请求并消费流式响应 | 构建后的 CLI 真实账号运行 |
| DIR-004 | 成功结果包含非空回答与 direct-protocol proof；相关浏览器 profile、页面和 resident browser 保留 | CLI JSON 结果与运行后 browser/profile 观察 |
| DIR-005 | 不传 `--execution-mode direct` 的现有 browser-mode 核心路径和构建检查不回归 | 现有 focused integration / browser E2E 中最便宜的决定性检查 |

### Constraints

- provider session 材料只存在于当前进程内存，并只发送给 `chatgpt.com` 的已批准 endpoint。
- 不读取密码、Keychain item 或无关 provider 数据，不自动登录，不处理 CAPTCHA。
- 不记录请求或响应 fixture；验收只使用真实 provider endpoint。
- 第一里程碑不为可能发生的过期、断线、重放或恢复预建机制；真实失败重复出现后再开修复切片。
- transport 保持薄封装，避免把 alpha Node binding 扩散到 provider contract 和 daemon contract 之外。

`stop condition`：DIR-001 至 DIR-005 有充分证据且独立 reviewer 批准；或真实 provider/session 条件无法提供证据。相同切片最多进行三轮 review 修正。

## 后续里程碑

按真实用户价值和真实边界证据逐项推进，不一次复制整个 gpt4free adapter：

1. conversation identity 与续聊；
2. model、effort、reasoning 与 web search；
3. 文件上传、图片输入和系统/历史消息；
4. citations 与结构化 reasoning；
5. 图像、音频和异步媒体任务；
6. 继续选择下一个 provider；共享 direct contract 已先由 ChatGPT 与 Perplexity 两条真实路径证明。

每一项都必须同时声明 direct-mode availability 和 browser-mode availability。两者不要求内部实现相同，只要求外部语义诚实。

## 第二里程碑：Perplexity 新文本聊天

### Mission Contract

`goal`：用户可通过构建后的 CLI，使用 Tokenless profile 中当前 guest 或 signed-in Perplexity session，调用真实 `www.perplexity.ai/rest/sse/perplexity_ask` endpoint 并取得非空文本回答。

`non-goals`：续聊、附件、model 或 effort 选择、fallback、user handoff、自动 CAPTCHA、重试框架和 session material 持久化。

`v1 boundary`：`tokenless run --provider perplexity --execution-mode direct --prompt <text> --json` 只新增一次新 `conversation.chat`，action 固定为 `prompt.input → prompt.submit → response.read`。ChatGPT direct 和默认 browser mode 保持原行为。

### Assertions

| ID | 可观察行为 | 证据 |
| --- | --- | --- |
| DIR2-001 | direct validation 允许 ChatGPT 与 Perplexity，拒绝其他 provider、附件、续聊、control 和 fallback | 构建后的 CLI 负向调用与代码审查 |
| DIR2-002 | adapter 只读取当前 `www.perplexity.ai` 页面与 origin cookies，以及实际 UA、language 和 timezone；session value 只存在于内存并只发送到获准 Perplexity origin | 代码审查与真实输出检查 |
| DIR2-003 | 现有 `impers` Chrome transport 请求真实 query endpoint，只把 `blocks[].diff_block.patches` 的 `markdown_block` 增量作为回答，不把 reasoning 当作回答 | 代码审查与真实 endpoint 运行 |
| DIR2-004 | 成功结果包含非空 text、`executionMode=direct` 和 direct-protocol proof，resident browser 与 profile 保留 | `live-perplexity-direct.e2e.mjs` |
| DIR2-005 | ChatGPT direct 构建行为和默认 browser mode 不回归 | build、focused CLI 检查；按需运行 ChatGPT live |

### Constraints

- guest 与 signed-in session 在此 v1 都使用 `turbo`；frontend 与 context identity 每次随机生成。
- 不自动处理 CAPTCHA，不记录 provider response fixture，不把 session value 写入 stdout、stderr、job、checkpoint 或测试报告。
- 第二里程碑只移植当前一次新文本聊天所需字段，不新增 registry、重试、恢复或持久化层。

`stop condition`：DIR2-001 至 DIR2-005 获得证据，或真实 provider/session 给出具体外部 blocker；只进行一轮实现，不扩展 scope。

## 风险

| 风险 | 当前处理 |
| --- | --- |
| provider 私有 Web 协议随时变化 | 真实 endpoint 验证；失败时明确报告，不回退到 fixture |
| Node transport 仍处 alpha | 第一阶段薄封装并实跑；只有实跑失败才评估 Python |
| TLS fingerprint 与页面 user agent 不一致 | 使用 `impers` Chrome profile，并以浏览器实际 user agent 构造请求 header |
| session 材料泄露 | 限定 provider/profile/origin，不进入日志、结果、checkpoint 或 UI |
| direct 与 browser capability 被误认为等价 | capability 与 proof 按 execution mode 分开记录 |
