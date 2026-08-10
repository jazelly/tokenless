# Provider 直连协议与浏览器会话桥接

Status: active provider protocol design | Priority: P0

Related: [Provider Expansion and Parity](P0-provider-expansion.md), [Real Provider Browser E2E and Native Projects](P0-real-provider-browser-e2e-and-native-projects.md), and [Web AI Interaction Protocol](P0-web-ai-interaction-protocol.md)

## 当前决策门：Browser Impersonation 工具链

在继续实现 Provider protocol 前，先选出能够高保真复用用户浏览器请求特征的 session acquisition 与 HTTP transport 组合。一次返回 `200` 或一次聊天成功只证明可行，不足以成为选型结论。

### Mission Contract

`goal`：用同一已登录 managed profile 和同一真实 ChatGPT 基础协议，对 Node.js 候选与 Python `curl_cffi` 基准做可复现比较，给出主组合、fallback 或明确的 `no winner`。

`non-goals`：新增 Provider capability、自动处理 CAPTCHA/Turnstile/Arkose、读取 macOS Keychain、持久化 provider session、构建通用 benchmark 平台或把候选 transport 接入产品路径。

`v1 boundary`：session acquisition 比较 CDP、显式 HAR 与浏览器 Cookie DB 路线；macOS Cookie DB 方案只做静态审查。Transport 比较真实页面内的 browser-native `fetch`、`impers@0.1.0`、`curl-cffi@0.1.50`、`node-libcurl-ja3@5.2.2` 与当前稳定 Python `curl_cffi`，并分别给出 resident-browser 最高保真路线和可脱离页面的 direct HTTP 路线。

| ID | 可观察行为 | 证据 |
| --- | --- | --- |
| TOOL-001 | 每个候选记录 exact version、native library 来源、平台范围和公开 API 缺口 | README、类型、安装脚本和实际加载路径审查 |
| TOOL-002 | 指纹探针报告实际 HTTP version、TLS/JA3/HTTP2 摘要和 User-Agent 匹配关系，不记录请求 secret | 公共 TLS diagnostic endpoint 的净化输出 |
| TOOL-003 | Cookie 路线说明 domain、path、host-only、partition 和更新语义；不能保真的候选不得因聊天成功入选 | CDP cookie schema 与各 transport Cookie Jar 实现审查 |
| TOOL-004 | 入选候选支持真正的流式响应，并明确 SSE、WebSocket、upload、redirect、proxy/bypass 和 abort 边界 | API/源码审查加最低限度运行探针 |
| TOOL-005 | 通过前置门槛的候选使用同一配置 profile 完成真实 ChatGPT 新文本聊天，浏览器和 profile 保留，输出只含状态、marker 与时间 | 隔离的真实 endpoint 运行 |
| TOOL-006 | 结论按 hard gate 淘汰，不用星数、作者关系或单次成功替代保真证据 | 独立 reviewer 审查完整矩阵 |

约束：任何候选默认跟随跨 host redirect、忽略 profile proxy bypass、首次加载未校验 native binary、丢失当前请求必需 Cookie 语义，或把 session material 写入证据时，均不能成为主组合。`browser_cookie3` 及同类 macOS DB reader 会读取 Chrome Safe Storage/Keychain，因此本轮不执行。

`stop condition`：一个组合通过 TOOL-001 至 TOOL-006 并获 reviewer 批准；或所有 Node 候选至少一项 hard gate 失败，结论明确采用 Python `curl_cffi` 基准或保留 `no winner`。选型完成前不继续扩 Provider protocol。

### 选型结论（2026-08-10）

主线选用 **configured managed Chrome + browser-native same-origin `fetch`**。Session、Cookie、partition、UA、TLS/H2/H3 和 proxy/bypass 都留在真实 Chrome 网络栈内，不导出到另一套 Cookie Jar；这条路线是 resident-browser transport，不宣传为可脱离浏览器的 direct HTTP client。

| 候选 | 实证与边界 | 决定 |
| --- | --- | --- |
| Browser-native same-origin `fetch` | 同一 managed profile 连续两次完成真实 ChatGPT 新文本聊天；均为 HTTP/2 + `text/event-stream`，marker 命中且 assistant text 非空；分别收到 20 个 SSE data frame | **Resident-browser winner**；先用它推进 Provider protocol |
| Python `curl_cffi==0.16.0` | PyPI arm64 wheel 本地 SHA-256 与官方 metadata 一致；公共探针通过 HTTP/2 和真实 SSE | **Detachable baseline only**；没有 selected-profile ChatGPT 实证，也没有已验证的 Chrome partition-key bridge，不是 fallback |
| `impers@0.1.0` | README 明示 alpha；首次运行下载 native library 而未校验 artifact hash；Cookie bridge 对 partition/host-only 语义有损 | 排除主选，现有产品 spike 不进入验收 |
| npm `curl-cffi@0.1.50` | 独立 Node 项目；安装脚本动态下载 native asset 与 CA，缺少下载物摘要校验，Cookie 被压平 | 排除主选 |
| `node-libcurl-ja3@5.2.2` | native prebuild/source fallback 均缺少可验证的下载物摘要；Chrome Cookie fidelity 未证明 | 排除主选 |

浏览器原生路线本轮只证明 ChatGPT 文本 SSE。WebSocket、upload、abort 和特定 proxy 行为仍是设计/静态能力，必须随具体 Provider capability 单独实证。TLS diagnostic hash 含握手随机量，不作为跨次 fingerprint 相等证明。

## 结果

Tokenless 将 Provider Web protocol 作为显式执行模式逐项实现。最高保真路径在选定 profile 的真实同源页面执行协议请求；只有 Provider 经过独立证据证明 Cookie 与网络语义可安全分离时，才评估 detachable transport。

Protocol 模式与可见 DOM automation 共用 provider、profile、job、capability 和结果边界，但保持不同的执行证明。任何 protocol capability 必须通过真实 endpoint 单独验证，不能用 DOM automation 结果或 transport 的通用 API 声明代替。

## gpt4free 能力基线

截至 2026-08-10，gpt4free 的 `OpenaiChat` 路线包含以下可复用思路：

| 层次 | gpt4free 当前能力 | Tokenless 处理方向 |
| --- | --- | --- |
| 会话引导 | HAR、cookies、access token 或浏览器登录 | 只从用户显式选择的 managed profile 在内存中引导 |
| HTTP transport | `curl_cffi` Chrome impersonation、session cookies、SSE、WebSocket | 主线用 managed Chrome 内的 same-origin `fetch`；Python `curl_cffi` 仅为可分离线路基准 |
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

`goal`：用户可通过构建后的 CLI，使用一个已登录 ChatGPT 的 Tokenless profile，在其真实同源页面内完成一次 protocol 文本聊天并取得回答。

`non-goals`：续聊、附件、模型或 effort 选择、联网搜索、图像或音频、Projects、guest access、自动 fallback、重试或会话材料持久化。

`v1 boundary`：`tokenless run --provider chatgpt --execution-mode direct --prompt <text> --json` 是唯一新增 happy path。现有默认 browser mode 保持原行为。

### Assertions

| ID | 可观察行为 | 证据 |
| --- | --- | --- |
| DIR-001 | CLI 只在用户显式选择 `direct` 时进入直连模式；当前只允许已单独验证的 ChatGPT 与 Perplexity，且对非基础文本动作明确失败 | 构建后的 CLI 参数验证 |
| DIR-002 | adapter 在选定 profile 的 ChatGPT 同源页面内取得最小 access token；Cookie 仍由 Chrome 管理，任何 session value 都不出现在 stdout、stderr、job result、checkpoint 或测试报告 | 代码审查加真实失败/成功输出检查 |
| DIR-003 | browser-native transport 对真实 ChatGPT requirements 和 conversation endpoint 完成请求并消费流式响应 | 构建后的 CLI 真实账号运行 |
| DIR-004 | 成功结果包含非空回答与 direct-protocol proof；相关浏览器 profile、页面和 resident browser 保留 | CLI JSON 结果与运行后 browser/profile 观察 |
| DIR-005 | 不传 `--execution-mode direct` 的现有 browser-mode 核心路径和构建检查不回归 | 现有 focused integration / browser E2E 中最便宜的决定性检查 |

### Constraints

- provider session 材料只存在于当前进程内存，并只发送给 `chatgpt.com` 的已批准 endpoint。
- 不读取密码、Keychain item 或无关 provider 数据，不自动登录，不处理 CAPTCHA。
- 不记录请求或响应 fixture；验收只使用真实 provider endpoint。
- 第一里程碑不为可能发生的过期、断线、重放或恢复预建机制；真实失败重复出现后再开修复切片。
- transport 保持薄封装，不把页面生命周期或某一 Provider 的协议字段扩散到公共 provider/daemon contract。

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
| DIR2-003 | browser-native transport 请求真实 query endpoint，只把 `blocks[].diff_block.patches` 的 `markdown_block` 增量作为回答，不把 reasoning 当作回答 | 代码审查与真实 endpoint 运行 |
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
| Node native impersonation transport 仍处 alpha 或下载边界不完整 | 不进入持有 provider session 的主进程；未来重新评估必须先补 artifact integrity 与 Cookie fidelity 证据 |
| TLS fingerprint、Cookie 或页面状态不一致 | 主线请求留在选定 managed Chrome 的同源网络栈，不跨 Cookie Jar 复制 |
| session 材料泄露 | 限定 provider/profile/origin，不进入日志、结果、checkpoint 或 UI |
| direct 与 browser capability 被误认为等价 | capability 与 proof 按 execution mode 分开记录 |
