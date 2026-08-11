# Web AI → API：Provider 直连协议

Status: active product direction; parity not complete | Priority: P0

Related: [Provider Expansion and Parity](P0-provider-expansion.md), [Real Provider Browser E2E and Native Projects](P0-real-provider-browser-e2e-and-native-projects.md), and [Web AI Interaction Protocol](P0-web-ai-interaction-protocol.md)

## Outcome

Tokenless 同时推进两条并列 P0 主线：

1. **Web Provider**：继续复用现有 Node.js、provider registry、managed browser 与 visible-browser automation，交付真实网页上的可见 capability。
2. **Web AI → API**：由用户显式选择 `direct` mode，通过现有 authenticated local API 与 OpenAI-compatible proxy 暴露真实 provider Web protocol，并逐项达到 [gpt4free](https://github.com/xtekky/gpt4free) 的 provider 能力面。

第二条线以 gpt4free 作为明确的 parity baseline，但不要求把其所有实现重写为 Node.js。Tokenless 优先复用已验证的 Node/browser 路径；只有 Node 路径存在真实缺口时，才引入受控、固定版本的本地 Python adapter/sidecar。

这是一份方向与交付计划，不宣称 parity 已完成。本文的新顺序覆盖旧 spike 对后续优先级的结论；已完成的实证历史仍保留在下文。

## 当前诚实状态

| Route | 当前状态 | 已知边界 |
| --- | --- | --- |
| ChatGPT direct | **Experimental new-text-only PoC** | production same-origin 路径与 exact-marker/secret-leak E2E 尚待修复并重新证明；不支持续聊、附件、model、effort、search、Project 或 fallback |
| Perplexity direct | **Experimental new-text-only PoC** | 已有真实 endpoint spike，但仍不代表 broader direct parity；不支持续聊、附件、model control 或 fallback |
| 其他 provider direct | Not implemented | gpt4free 路径只是 baseline inventory，不是 Tokenless availability |

默认 visible-browser mode 的状态独立于 direct mode。任何 capability 都必须按 `provider × execution mode` 分别声明、实现和验证，不能用另一条模式的成功证据代替。

## 实现边界

### Node.js 继续拥有

- CLI、authenticated local API、OpenAI-compatible proxy、daemon、profile 选择、显式 mode consent 与 capability validation；
- 现有 browser/CDP 与 same-origin 执行路径；
- provider-neutral request/result contract、proof 与错误净化；
- auth-source policy、secret redaction 和真实边界 E2E；
- 已经可由现有 Node/browser adapter 可靠完成的 capability。

### 固定版本 gpt4free Python 候选只补缺口

- provider-specific bootstrap、challenge、stream parser 或 transport fidelity 中经真实运行确认的缺口；
- 以用户显式启用的本地 adapter/sidecar 运行，版本、源码 commit 与依赖锁定；
- 接口保持最小，只接收当前 direct action 所需输入，并只返回净化后的结果或错误；
- 不拥有 daemon job、queue、retry、recovery、profile registry 或通用 provider orchestration。

不得因为引入 sidecar 就复制整个 gpt4free 服务层，也不得为尚未出现的失败预建 queue、retry、checkpoint 或 recovery platform。

## Auth-source contract

Direct mode 永远需要用户显式选择。Contract 必须允许并区分以下来源：

| Auth source | 允许范围 | Lifetime |
| --- | --- | --- |
| Live browser / CDP | 从用户选择的 browser、profile、provider origin 读取当前必要 cookies、tokens、headers 与 browser storage | Ephemeral |
| User-supplied HAR | 只解析用户显式提供、且属于所选 provider 的必要 session fields | Ephemeral，或用户显式 import/save 后 user-persisted |
| Browser Cookie database | 只读取所选 profile 与 provider domains；保留 host-only、path、expiry、partition 等必要语义 | 读取时 ephemeral；原 database 仍由 browser 管理 |
| Manual cookies / tokens | 接受用户显式提供的最小 provider session values，不推断或抓取其他账号材料 | Ephemeral，或用户显式 save 后 user-persisted |
| macOS browser encryption material | 允许通过必要 OS 或 Keychain API 读取仅用于解密所选 provider cookies 的 browser encryption material | Ephemeral；不作为独立 auth source 保存 |

Contract 还必须定义 source precedence、所选 provider 与 auth source scope、仅在适用时的 profile/origin scope、`ephemeral | user-persisted` lifetime、失效行为与用户可见 consent。用户可以显式 import/save HAR、cookies 或 tokens；未经该选择不得静默导入或持久化。它不得读取密码、无关 Keychain item，或其他 provider、account、profile 的凭据。

Provider session secret 可在本地进程内存中传给用户显式选择的 direct adapter/sidecar，并只发送给所选 provider 为其自身请求完成认证。Adapter/sidecar 不得记录、持久化或返回 secret；secret 不得进入 stdout、stderr、log、error、telemetry、job、checkpoint、test evidence 或 UI，不得暴露给 caller 或 web model，也不得发送给 Tokenless 运营的远程服务或任何无关服务。

## gpt4free parity baseline

当前 baseline 固定到 gpt4free commit [`4d750f842f0b60de07c65e0bcc024a54ec2fd0f0`](https://github.com/xtekky/gpt4free/tree/4d750f842f0b60de07c65e0bcc024a54ec2fd0f0)。源码存在只代表该固定版本提供实现参考，不证明今天仍可运行，也不代表 Tokenless 已支持。每个 parity milestone 开始时先审查 upstream，并在同一变更中有意更新 pinned commit 与能力矩阵；运行时依赖仍必须固定到验收过的 exact version。

### 能力矩阵

| 能力组 | gpt4free baseline | Tokenless delivery rule |
| --- | --- | --- |
| Auth bootstrap | browser login、HAR、Cookie DB、manual cookies/tokens、access token | 先关闭统一 auth-source contract，再逐 provider 验证最小必要字段 |
| Transport | browser automation、`curl_cffi` impersonation、SSE、WebSocket | 优先复用 Node/browser；只有真实缺口才交给固定 Python adapter |
| Provider challenges | sentinel requirements、proof-of-work、短期 token、部分 CAPTCHA/Turnstile/Arkose 路径 | 可实现非交互 challenge；CAPTCHA 与登录仍由用户控制，不自动规避 |
| Text chat | new chat、streaming、conversation/message identity、continuation、variant、auto-continue、temporary chat | 先修复 new text，再逐项交付 identity 与 continuation |
| Model controls | model、reasoning effort、system hints、web search | 每个 provider 与 mode 单独验证，不从文本成功推断 |
| Context | file upload、image input、system message、history | 优先复用现有 browser capability；direct 缺口按真实 endpoint 补齐 |
| Rich results | citations、reasoning、title、image、audio、async media | 分 capability 交付，文本回答不算 rich result parity |
| Provider coverage | 多 provider 文本与媒体 adapter | 维护 pinned source inventory；first-party boundary 不成立的 adapter 不计入目标 |

### 固定 provider inventory

| Provider | 固定源码路径 / 核心流程 | Tokenless 当前方向 |
| --- | --- | --- |
| ChatGPT | `g4f/Provider/needs_auth/OpenaiChat.py`；session/access token → requirements → PoW → conversation stream | 第一目标；用最小 Python adapter 补 Node same-origin 修复后的剩余缺口 |
| Gemini | `g4f/Provider/needs_auth/Gemini.py`、`gemini_utils.py`；Google cookies、XSRF/SID/build metadata → framed stream | browser 已支持；direct 未实现 |
| Grok | `g4f/Provider/needs_auth/Grok.py`；login cookies → new/continued conversation stream | browser 已支持；direct 未实现 |
| Qwen | `g4f/Provider/Qwen.py`；auth/JWT → new chat → SSE；部分路径要求 reCAPTCHA | browser experimental；只验证无需自动 CAPTCHA 的路径 |
| DeepSeek | `g4f/Provider/needs_auth/DeepSeek.py`、`needs_auth/deepseek/pow_solver.wasm`；auth token → PoW → session → SSE | browser experimental；PoW 与 session create 分开验证 |
| Perplexity | `g4f/Provider/Perplexity.py`；origin cookies、可选 auth-session → diff blocks | direct new-text PoC；后续补 continuation、citations、model controls |
| Z.ai / GLM | `g4f/Provider/glm/__init__.py`、`glm/captcha_solver.py`；JWT/API key → fingerprint/signature → SSE | browser experimental；不自动解 CAPTCHA |
| Claude | baseline 使用第三方 `claude.gpt4free.workers.dev`，不是 `claude.ai` first-party Web protocol | 不计入 direct parity；需独立研究 first-party boundary |
| Kimi / Doubao / Dola | 固定 commit 无对应 first-party Web adapter | 无可移植 baseline；保留现有 browser 方向 |

## 发布与 GPLv3 gate

官方 gpt4free 仓库当前标注 **GPL-3.0**，Tokenless 当前为 MIT。受控、固定版本的本地 Python adapter/sidecar 可以先作为显式 opt-in 的实现候选，但在任何 gpt4free code、package 或 runtime 随 npm artifact 分发前，必须完成并记录 GPLv3 分发与组合作品审查。

审查必须决定源码修改、进程边界、IPC、安装方式、依赖获取、notice/source offer 与 Tokenless package/license 的处理方式。本文不假设独立 sidecar 一定规避 copyleft；license/package 决策未关闭时，不得把该 runtime bundled 到发布物，也不得宣称可发布集成已完成。

## 交付顺序

### 0. 修复真实 ChatGPT same-origin PoC

- 修复 production adapter，确保请求实际在所选 ChatGPT 页面与 origin 的 browser-native network stack 中执行。
- 新增真实 built CLI + packaged daemon E2E；prompt 含唯一 marker，回答必须命中 **exact marker**，不能只断言非空文本。Built CLI 是 provider protocol 的首个证明入口，不是 Web AI → API 的最终用户边界。
- 同一 E2E 覆盖成功与 provider error 路径，断言已知 session secret marker 不出现在 stdout、stderr、error、job、checkpoint、evidence 或 UI-facing result。
- 保留所选 profile、页面与 resident browser，只 detach CDP client。

Exit：ChatGPT 仍只标记 experimental new-text-only PoC，但 same-origin、exact-marker 和 secret non-disclosure 都有真实账号证据。

### 1. 定义并实现 auth-source contract

- 实现 live browser/CDP、user-supplied HAR、browser Cookie DB 与 manual cookies/tokens 的 source contract 和显式 consent。
- 每个 source 声明 `ephemeral | user-persisted`；只有用户显式 import/save 的 HAR、cookies 或 tokens 可以本地持久化，且不得借此预建通用 secret-storage framework。
- 在 macOS 上，只有 Cookie DB 路径可读取解密所选 provider cookies 必需的 browser encryption material。
- 真实边界测试证明 scope、precedence、redaction 和失败语义；不保存 provider fixture 或 secret evidence。

Exit：同一 provider action 可明确选择受支持 auth source 与 lifetime，user-persisted 只来自显式 import/save，且任何失败都不会泄露 session material。

### 2. 集成最小 gpt4free ChatGPT adapter/sidecar

- 仅补第 0、1 阶段后仍有真实证据的 ChatGPT protocol 缺口。
- 固定 gpt4free commit、Python version 与依赖；Node 继续拥有 authenticated local API、OpenAI-compatible proxy、CLI/daemon/capability/result contract。
- 先关闭 GPLv3 distribution gate，再决定 npm 发布物是否以及如何携带 runtime；未关闭前只允许本地开发候选。
- 以相同 exact-marker 与 secret-leak E2E 验收，不因 Python process 存在就降低证据标准。

Exit：至少一个 ChatGPT 缺口由窄 adapter 闭环；没有引入通用 sidecar platform。

### 3. 暴露到现有 authenticated local API proxy

- 不新建 API service；把已验证的 direct capability 接到现有 authenticated local API 与 OpenAI-compatible proxy。
- API request 必须显式选择 `direct`，并复用 CLI/daemon 的 provider、auth source、capability validation 与净化结果边界。
- 将已支持字段、未支持参数、provider blocker 与 direct-only failure 诚实映射到现有 API contract；不得忽略参数后声称兼容。
- 通过真实 API client → local proxy → packaged daemon → real provider endpoint 的 E2E 重跑 exact-marker 与 secret non-disclosure assertions。

Exit：至少一个已验证的 direct new-text capability 可从现有 OpenAI-compatible proxy 调用；CLI 与 API 对 availability、结果和错误的陈述一致。

### 4. 按 parity matrix 逐项交付

优先顺序为：

1. conversation/message identity 与 continuation；
2. model、effort、reasoning 与 web search；
3. file upload、image input、system/history messages；
4. citations 与 structured reasoning；
5. image、audio 与 async media；
6. 按固定 provider inventory 扩展 first-party provider coverage。

每个条目都需要 built CLI 的 provider-protocol 证明、现有 authenticated local API proxy 的真实用户边界、明确的 `provider × execution mode` availability、真实 endpoint 证据和 secret non-disclosure 检查。不批量宣称 parity，不因 gpt4free 存在某条源码路径而自动开放 capability。

## 已完成 spike 历史（非当前产品验收）

2026-08-10 的 transport spike 在同一 managed profile 上比较了 browser-native same-origin `fetch`、`impers@0.1.0`、npm `curl-cffi@0.1.50`、`node-libcurl-ja3@5.2.2` 与 Python `curl_cffi==0.16.0`。

当时 browser-native `fetch` 两次得到 HTTP/2 SSE 与非空回答；Python `curl_cffi` 只通过公共探针，未证明 selected-profile Cookie fidelity。三个 Node impersonation 候选因 alpha、未校验 native artifact 或 Cookie 语义损失而未入选。

这些结果继续支持“优先复用真实 browser network stack”，但不再阻止为明确缺口采用固定 gpt4free Python adapter。一次成功 spike 也不能替代当前 production same-origin exact-marker E2E。

## Non-goals

- 不一次复制整个 gpt4free provider/service layer。
- 不构建通用 queue、retry、recovery、checkpoint、distributed coordination 或 fallback platform。
- 不自动登录、读取密码或自动处理 CAPTCHA、Turnstile、Arkose。
- 不用 fixture、provider replica、intercepted response 或 synthetic transport 证明 provider capability。
- 不把 direct mode 静默降级为 browser mode，反之亦然。

## 风险与处理

| 风险 | 当前处理 |
| --- | --- |
| 私有 Web protocol 变化 | 逐 capability 运行真实 endpoint E2E；失败时关闭或降级声明，不使用 fixture 替代 |
| Session secret 泄露 | auth source 限域；所有进程和结果边界统一做 exact secret non-disclosure 检查 |
| Python runtime 扩散架构 | 只允许固定版本、显式 opt-in、ChatGPT-first 的最小 adapter |
| GPLv3 与 MIT 组合/分发不清楚 | npm bundling 前关闭正式 license/package gate；不假设 sidecar 自动隔离义务 |
| gpt4free baseline 失效 | 固定 commit、记录真实运行证据，并把 baseline 与 Tokenless availability 分开 |
| browser 与 direct 被误认为等价 | capability matrix、proof 与用户文档按 execution mode 分开 |
