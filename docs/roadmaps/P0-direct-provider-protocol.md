# Web AI → API：Provider 直连协议

Status: active product direction; parity not complete | Priority: P0

Related: [Provider Expansion and Parity](P0-provider-expansion.md), [Real Provider Browser E2E and Native Projects](P0-real-provider-browser-e2e-and-native-projects.md), and [Web AI Interaction Protocol](P0-web-ai-interaction-protocol.md)

## Outcome

Tokenless 同时推进两条并列 P0 主线：

1. **Web Provider**：继续复用现有 Node.js、provider registry、managed browser 与 visible-browser automation，交付真实网页上的可见 capability。
2. **Web AI → API**：由用户显式选择 `direct` mode，通过现有 authenticated local API 暴露真实 provider Web protocol；第一阶段把固定版本的 [gpt4free](https://github.com/xtekky/gpt4free) 作为完整的私有 HTTP upstream，先获得其 provider、认证与媒体能力面，再逐 provider internalize。

第二条线使用一个由 Tokenless setup 安装并由 daemon 管理生命周期的本地 Python service。Tokenless 是唯一 public API；G4F 只绑定 loopback、使用独立 service credential，并通过 typed HTTP/JSON/SSE adapter 被调用。现有 native ChatGPT 与 Perplexity 实现保留，`providerBackend = native | g4f` 允许按 provider A/B、逐步放量与回切。

这是一份方向与交付计划，不宣称 parity 已完成。本文的新顺序覆盖旧 spike 对后续优先级的结论；已完成的实证历史仍保留在下文。

## 当前诚实状态

| Route | 当前状态 | 已知边界 |
| --- | --- | --- |
| ChatGPT native direct | **Experimental new-text-only PoC** | 保留现有实现，作为 internalization 与 A/B baseline；不因 G4F 集成而删除 |
| Perplexity native direct | **Experimental new-text-only PoC** | 保留现有实现；broader direct parity 先走 G4F |
| G4F direct service | **Core surface implemented; provider parity incomplete** | Private runtime/daemon/API/auth/media/PA boundary 已通过真实进程测试；ChatGPT exact-marker completion 已通过，固定版本的 ChatGPT SSE 会截断，因此未宣称该 provider 的 SSE parity |

默认 visible-browser mode 的状态独立于 direct mode。任何 capability 都必须按 `provider × execution mode` 分别声明、实现和验证，不能用另一条模式的成功证据代替。

2026-08-12 evidence：`g4f-service.real-boundary.e2e.mjs` 从空 home 安装固定 runtime，验证 private/public auth boundary、provider/PA inventory、persisted auth context、`browserMode=headless` 与 disabled CDP auto-discovery；`live-g4f-guest.e2e.mjs` 通过 authenticated packaged daemon 显式请求 `g4f:GLM`，不传 provider auth context，在隔离 headless browser 中完成 Aliyun traceless verification，并从真实 GLM endpoint 返回 exact marker，请求前后 auth-context 集合不变；`live-chatgpt-g4f-direct.e2e.mjs` 通过 built CLI、packaged daemon、selected Cloak browser profile 与真实 ChatGPT endpoint 返回 exact marker。ChatGPT G4F SSE 连续三次只返回 marker 前缀，因此 CLI adapter 使用已通过的 non-stream completion，通用 API 仍透明传递 upstream SSE。

## 实现边界

### Tokenless 继续拥有

- CLI、authenticated local API、OpenAI-compatible proxy、daemon、profile 选择、显式 mode consent 与 capability validation；
- 现有 browser/CDP、visible-browser automation 与 native direct 实现；
- `executionMode = browser | direct` 和 direct 下的 `providerBackend = native | g4f` 路由；
- provider-neutral request/result contract、auth-context ownership、proof、错误净化与真实边界 E2E；
- G4F runtime 的安装、固定版本、启动、停止、健康检查、private credential 与升级入口。

### 固定版本 G4F private service 拥有

- G4F provider protocol、`curl_cffi` browser impersonation、SSE、provider-specific challenge，以及只用于 direct prerequisite 的隔离 headless browser；
- chat、responses、messages、images、audio、files/media、provider models 与 quota；
- G4F 的 HAR parser、cookie parsing、`browser_cookie3`/browser Cookie DB 与 `zendriver` 能力；
- 精确 provider 选择；除非 caller 明确选择 `AnyProvider`，不得静默 fallback。

G4F service 不拥有 Tokenless daemon job、profile registry、public API 或 visible-browser automation。其 `zendriver` 与 CDP browser launch 被 wrapper 强制为 headless，只允许用于 CAPTCHA/challenge token 等 direct HTTP prerequisite。v1 使用一个 worker，并在 auth-context 请求边界串行化，以避免 G4F 进程级 provider/auth 状态跨 profile 混用；不为尚未出现的吞吐问题预建 queue、retry 或分布式协调。

### 私有 service surface

| Surface | 决策 |
| --- | --- |
| Chat / Responses / Messages / Images / Audio / Files | 保留，通过 Tokenless API 和 typed adapter 暴露 |
| Provider models / quota / availability | 保留，作为 capability 与诊断数据源 |
| HAR、Cookie import、Cookie DB、browser/CDP、zendriver login | 能力保留；只能通过 Tokenless auth-context/control plane 使用 |
| Raw request/response logs | 禁用，不得收集 prompt、response 或 session material |
| GUI、docs、OpenAPI | 不启动；Tokenless 是唯一用户接口与 API contract |
| Arbitrary filesystem access | 禁止；所有路径必须来自显式 auth source 并通过 provider/profile scope 校验 |
| Runtime PA auto-download | daemon 运行时禁用；setup/update 固定并安装 PA provider 依赖 |

## Auth-source contract

Direct mode 永远需要用户显式选择。Contract 必须允许并区分以下来源：

| Auth source | 允许范围 | Lifetime |
| --- | --- | --- |
| Live browser / CDP | 从用户选择的 browser、profile、provider origin 读取当前必要 cookies、tokens、headers 与 browser storage | Ephemeral |
| User-supplied HAR | 只解析用户显式提供、且属于所选 provider 的必要 session fields | Ephemeral，或用户显式 import/save 后 user-persisted |
| Browser Cookie database | 只读取所选 profile 与 provider domains；保留 host-only、path、expiry、partition 等必要语义 | 读取时 ephemeral；原 database 仍由 browser 管理 |
| Manual cookies / tokens | 接受用户显式提供的最小 provider session values，不推断或抓取其他账号材料 | Ephemeral，或用户显式 save 后 user-persisted |
| macOS browser encryption material | 不由 Tokenless 或 G4F sidecar 读取；`browser-cookie3`/Cookie DB source 在 macOS fail closed，改用 managed CDP/session bridge | 不适用 |

Contract 还必须定义 source precedence、所选 provider 与 auth source scope、仅在适用时的 profile/origin scope、`ephemeral | user-persisted` lifetime、失效行为与用户可见 consent。用户可以显式 import/save HAR、cookies 或 tokens；未经该选择不得静默导入或持久化。它不得读取密码、无关 Keychain item，或其他 provider、account、profile 的凭据。

Provider session secret 可在本地进程内存中传给用户显式选择的 direct adapter/sidecar，并只发送给所选 provider 为其自身请求完成认证。Adapter/sidecar 不得记录、持久化或返回 secret；secret 不得进入 stdout、stderr、log、error、telemetry、job、checkpoint、test evidence 或 UI，不得暴露给 caller 或 web model，也不得发送给 Tokenless 运营的远程服务或任何无关服务。

## gpt4free parity baseline

当前 baseline 固定到 PyPI `g4f[all]==8.1.2` 与 upstream commit [`fdbd84b7c5129ea8faa7c66065425ca344ea5fb2`](https://github.com/xtekky/gpt4free/tree/fdbd84b7c5129ea8faa7c66065425ca344ea5fb2)。Python 固定为 3.12，并为安装使用 exact lock 与 hashes。源码存在只代表该固定版本提供实现参考；某个 provider 只有通过 Tokenless packaged daemon → private G4F service → real provider endpoint 的验收后才可声明可用。

### 能力矩阵

| 能力组 | gpt4free baseline | Tokenless delivery rule |
| --- | --- | --- |
| Auth bootstrap | browser login、HAR、Cookie DB、manual cookies/tokens、access token | 先关闭统一 auth-source contract，再逐 provider 验证最小必要字段 |
| Transport | browser automation、`curl_cffi` impersonation、SSE | visible browser 仍走 Tokenless；direct HTTP provider 走固定 G4F service，并允许其隔离 headless browser 完成 protocol prerequisite |
| Provider challenges | sentinel requirements、proof-of-work、短期 token、部分 CAPTCHA/Turnstile/Arkose 路径 | 允许 G4F 在 headless browser 中自动完成无需用户交互的 challenge；需要人工交互时必须明确失败或交还用户 |
| Text chat | new chat、streaming、conversation/message identity、continuation、variant、auto-continue、temporary chat | 先修复 new text，再逐项交付 identity 与 continuation |
| Model controls | model、reasoning effort、system hints、web search | 每个 provider 与 mode 单独验证，不从文本成功推断 |
| Context | file upload、image input、system message、history | 优先复用现有 browser capability；direct 缺口按真实 endpoint 补齐 |
| Rich results | citations、reasoning、title、image、audio、async media | 分 capability 交付，文本回答不算 rich result parity |
| Provider coverage | 多 provider 文本与媒体 adapter | 维护 pinned source inventory；first-party boundary 不成立的 adapter 不计入目标 |

### 固定 provider inventory

| Provider | 固定源码路径 / 核心流程 | Tokenless 当前方向 |
| --- | --- | --- |
| ChatGPT | `g4f/Provider/needs_auth/OpenaiChat.py`；session/access token → requirements → PoW → conversation stream | G4F 为第一默认 backend；native 保留并 A/B |
| Gemini | `g4f/Provider/needs_auth/Gemini.py`、`gemini_utils.py`；Google cookies、XSRF/SID/build metadata → framed stream | browser 保留；direct 先走 G4F |
| Grok | `g4f/Provider/needs_auth/Grok.py`；login cookies → new/continued conversation stream | browser 已支持；direct 未实现 |
| Qwen | `g4f/Provider/Qwen.py`；auth/JWT → new chat → SSE；部分路径要求 reCAPTCHA | browser experimental；只验证无需自动 CAPTCHA 的路径 |
| DeepSeek | `g4f/Provider/needs_auth/DeepSeek.py`、`needs_auth/deepseek/pow_solver.wasm`；auth token → PoW → session → SSE | browser experimental；PoW 与 session create 分开验证 |
| Perplexity | `g4f/Provider/Perplexity.py`；origin cookies、可选 auth-session → diff blocks | G4F 覆盖 broader direct；native new-text 保留并 A/B |
| Z.ai / GLM | `g4f/Provider/glm/__init__.py`、`glm/captcha_solver.py`；guest JWT → headless Aliyun traceless verification → fingerprint/signature → SSE | G4F guest direct 已通过 exact-marker E2E；visible browser 仍独立验证 |
| Claude | baseline 使用第三方 `claude.gpt4free.workers.dev`，不是 `claude.ai` first-party Web protocol | 不计入 direct parity；需独立研究 first-party boundary |
| Kimi / Doubao / Dola | 固定 commit 无对应 first-party Web adapter | 无可移植 baseline；保留现有 browser 方向 |

## 发布与 GPLv3 gate

官方 gpt4free 仓库当前标注 **GPL-3.0**，Tokenless 当前为 MIT。受控、固定版本的本地 Python adapter/sidecar 可以先作为显式 opt-in 的实现候选，但在任何 gpt4free code、package 或 runtime 随 npm artifact 分发前，必须完成并记录 GPLv3 分发与组合作品审查。

审查必须决定源码修改、进程边界、IPC、安装方式、依赖获取、notice/source offer 与 Tokenless package/license 的处理方式。本文不假设独立 sidecar 一定规避 copyleft；license/package 决策未关闭时，不得把该 runtime bundled 到发布物，也不得宣称可发布集成已完成。

## 交付顺序

### 0. 固定 runtime 与 private service（2026-08-12 已完成）

- setup 在 Tokenless private runtime 中安装 Python 3.12、exact `g4f[all]` lock 与受控 service wrapper；daemon 不在启动时修改 provider code。
- service 只绑定 loopback、一个 worker、随机 service credential，禁用 raw logger、GUI、docs/OpenAPI、access log 与 PA auto-download。
- daemon 负责启动、health、停止；sidecar stdout/stderr 被丢弃，不进入 daemon log。

Exit：packaged daemon 可启动固定 G4F service，健康检查返回 pinned version/commit，关闭 daemon 后 service 退出；npm artifact 只携带 Tokenless wrapper/lock/notice，不携带 G4F source 或 Python environment。

### 1. 定义并实现 auth-source contract（2026-08-12 已完成 core contract）

- 实现 live browser/CDP、user-supplied HAR、browser Cookie DB 与 manual cookies/tokens 的 source contract 和显式 consent。
- 每个 source 声明 `ephemeral | user-persisted`；只有用户显式 import/save 的 HAR、cookies 或 tokens 可以本地持久化，且不得借此预建通用 secret-storage framework。
- macOS 不调用 Keychain API 解密 Cookie DB；使用 managed CDP/session bridge 保持 browser credential ownership。
- 真实边界测试证明 scope、precedence、redaction 和失败语义；不保存 provider fixture 或 secret evidence。

Exit：同一 provider action 可明确选择受支持 auth source 与 lifetime，user-persisted 只来自显式 import/save，且任何失败都不会泄露 session material。

### 2. 集成完整 G4F data/control plane（2026-08-12 已完成 HTTP surface）

- typed adapter 代理 chat/responses/messages/images/audio/files/media、models 与 quota，并保留 G4F 原生 stream 语义。
- auth-context control plane 接入 HAR、manual cookie/token、Cookie DB/browser_cookie3 与 Tokenless managed CDP/zendriver；不重新实现 G4F 的 HAR/provider parser。
- 每次请求显式指定 provider、profile/auth context、source 与 lifetime；一个 worker 中对 auth-context activation + provider request 串行化。
- PA provider 由 setup/update 固定安装，runtime request 不允许自动下载或修改代码。

Exit：每个保留的 G4F private surface 都能从 Tokenless authenticated control/data plane 到达，所有被禁 surface 都不可到达。

### 3. ProviderProtocolRouter 与现有 API（2026-08-12 已完成）

- 不新建 public API service；把 `browser | direct` 和 `native | g4f` 路由接到现有 authenticated local API。
- 保留 native ChatGPT/Perplexity adapters；默认 direct backend 可配置为 G4F，provider override 支持 feature-flag A/B 与回切。
- API request 必须显式选择 `direct`，并复用 CLI/daemon 的 provider、auth source、capability validation 与净化结果边界。
- 将已支持字段、未支持参数、provider blocker 与 direct-only failure 诚实映射到现有 API contract；不得忽略参数后声称兼容。
- 通过真实 API client → local proxy → packaged daemon → real provider endpoint 的 E2E 重跑 exact-marker 与 secret non-disclosure assertions。

Exit：相同 ChatGPT/Perplexity contract 可在 native 与 G4F 间显式切换；其他映射 provider 走 G4F；unsupported provider fail closed。

### 4. 真实 provider 验收与逐项 internalize

优先顺序为：

1. conversation/message identity 与 continuation；
2. model、effort、reasoning 与 web search；
3. file upload、image input、system/history messages；
4. citations 与 structured reasoning；
5. image、audio 与 async media；
6. 按固定 provider inventory 扩展 first-party provider coverage。

每个条目都需要 built CLI、packaged daemon、private service 与真实 provider endpoint 的证据。某 provider 的 native 实现达到同一 E2E 后，可通过 feature flag 放量、A/B、默认切换；G4F dependency 只有在所有目标 provider 均完成 internalization 后才可移除。

## 已完成 spike 历史（非当前产品验收）

2026-08-10 的 transport spike 在同一 managed profile 上比较了 browser-native same-origin `fetch`、`impers@0.1.0`、npm `curl-cffi@0.1.50`、`node-libcurl-ja3@5.2.2` 与 Python `curl_cffi==0.16.0`。

当时 browser-native `fetch` 两次得到 HTTP/2 SSE 与非空回答；Python `curl_cffi` 只通过公共探针，未证明 selected-profile Cookie fidelity。三个 Node impersonation 候选因 alpha、未校验 native artifact 或 Cookie 语义损失而未入选。

这些结果继续支持“优先复用真实 browser network stack”，但不再阻止为明确缺口采用固定 gpt4free Python adapter。一次成功 spike 也不能替代当前 production same-origin exact-marker E2E。

## Non-goals

- 不把 G4F public API 或 Python class/object 直接暴露给 Tokenless caller。
- 不让 G4F 接管 Tokenless visible-browser automation、profile registry 或 daemon job ownership。
- 不构建通用 queue、retry、recovery、checkpoint、distributed coordination 或 fallback platform。
- 不自动登录、读取密码或自动处理 CAPTCHA、Turnstile、Arkose。
- 不用 fixture、provider replica、intercepted response 或 synthetic transport 证明 provider capability。
- 不把 direct mode 静默降级为 browser mode，反之亦然。

## 风险与处理

| 风险 | 当前处理 |
| --- | --- |
| 私有 Web protocol 变化 | 逐 capability 运行真实 endpoint E2E；失败时关闭或降级声明，不使用 fixture 替代 |
| Session secret 泄露 | auth source 限域；所有进程和结果边界统一做 exact secret non-disclosure 检查 |
| Python runtime 扩散架构 | 一个固定版本、一个 private service、一个 typed adapter；业务路由仍由 Tokenless 拥有 |
| G4F 全局 auth/provider 状态跨 profile 混用 | 单 worker，并串行化 auth-context activation 与 request；每个 context 使用独立 private directory |
| GPLv3 与 MIT 组合/分发不清楚 | npm bundling 前关闭正式 license/package gate；不假设 sidecar 自动隔离义务 |
| gpt4free baseline 失效 | 固定 commit、记录真实运行证据，并把 baseline 与 Tokenless availability 分开 |
| browser 与 direct 被误认为等价 | capability matrix、proof 与用户文档按 execution mode 分开 |
