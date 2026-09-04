# Tokenless 术语表

本文定义 Tokenless 与 AI provider Web surface 交互时使用的标准术语。它描述的是 execution boundary，不代表 provider support 声明。

## Product layer

| 术语 | 定义 | 不要作为同义词使用 |
|---|---|---|
| **Tokenless API** | Tokenless 的 provider-access 产品层，包括 daemon、CLI、configuration、control surfaces 和 Universal API。它负责 provider-turn routing 与 lifecycle，并暴露面向 provider 的 HTTP/API boundary；它与 Tokenless Harness 分开。 | Tokenless Harness、provider 官方 API |
| **Tokenless Harness** | Tokenless 在 `packages/harness/` 中独立维护的 first-party agent runtime。它负责 AgentRun state、Skills、tool discovery 与 execution、MCP、approval、continuation 和 final output，并通过 HTTP 使用 Tokenless API。 | Tokenless API、external Harness |
| **Tokenless Harness API** | Tokenless Harness 对 caller 暴露的本地 API。它负责启动、观察、恢复与取消 AgentRun，并为经过显式授权的本地 client 交换 Harness-owned tool action 与 result。它位于 Tokenless API 之上并使用 Tokenless API；它不是面向 provider 的 API。 | Tokenless API、Dashboard UI API、external Harness API |

## Harness model role

| 术语 | 定义 | 不要作为同义词使用 |
|---|---|---|
| **Harness AI Engine** | Tokenless Harness Front Door 用于有界辅助推理的内部 model，例如生成 title、进行 task classification 与 provider routing；它不执行 Harness task，也不替代 Tokenless API route。 | Harness Task Model、provider route、Tokenless API |
| **Harness Task Model** | 通过 Tokenless API 及其所选 provider route 执行 Harness 用户任务的 provider model。 | Harness AI Engine、sidecar model |
| **AI Sidecar** | 在当前进程内 provider-execution loop 之外使用 Harness AI Engine 的 Harness-owned auxiliary component。 | Provider adapter、Harness task executor |
| **Front Door** | Harness run 开始前准备 conversation metadata，并选择具体 Tokenless API provider route 的 pre-run AI Sidecar。 | Tokenless API router、Harness AI Engine |

## Execution mode

| 术语 | 定义 | 不要作为同义词使用 |
|---|---|---|
| **Browser Mode** | 由 public V1 API 的 `tokenless.execution_mode: browser` 选择的 route。Tokenless 通过 visible browser automation 完成 provider turn。 | Headless browser、direct provider protocol |
| **Direct Mode** | 由 public V1 API 的 `tokenless.execution_mode: direct` 选择的 route。Tokenless 通过 direct provider protocol 与所选 direct provider implementation 完成 provider turn。 | Provider 官方 API、visible browser automation |
| **Visible Browser Automation** | Tokenless 控制一个用户可见的真实 browser，并通过 provider 网站 UI 完成交互。 | Direct protocol、HTTP impersonation |
| **Headless Browser Execution** | 一个没有可见窗口的真实 browser process，仍具备 JavaScript engine、DOM、storage 与 network stack。 | HTTP impersonation、fake browser |
| **HTTP Impersonation** | 非 browser 的 HTTP client 在不启动 browser process 的情况下，复现 TLS/HTTP2 fingerprint、header 等 browser network/request 特征，并直接调用 provider Web endpoint。 | Headless browser、browser automation |
| **Browser-Assisted HTTP Impersonation** | HTTP impersonation 仍是 provider 主 data plane；隔离的 headless browser 只提供必须由 browser 完成的前置结果，例如 JavaScript challenge、CAPTCHA proof、PoW token 或短期 request token。 | Visible browser automation、完整 browser execution |
| **Direct Provider Protocol** | Tokenless 不操作 provider 的可见 UI，而是通过纯 HTTP impersonation 或 browser-assisted HTTP impersonation 与 provider Web protocol 通信。 | Provider 官方 API、visible browser automation |

## Authentication 与 routing

| 术语 | 定义 | 不要作为同义词使用 |
|---|---|---|
| **Guest Mode** | Tokenless 不向 provider 提供已登录 provider session 的请求模式。 | 未认证的 daemon request |
| **Auth Context** | 由用户显式选择、限定到单个 provider、声明 lifetime，并供一个 direct provider implementation 使用的一组 session input。 | Browser profile、account |
| **Session Bootstrap** | Direct request 前，Tokenless 仅从显式选择的来源取得所选 provider 必需的 session input。 | Login automation、隐式 cookie scanning |

## 关系

```text
Visible Browser Automation
  -> 真实可见 browser -> provider UI

Direct Provider Protocol
  -> HTTP Impersonation -> provider Web endpoint
  -> Browser-Assisted HTTP Impersonation
       -> 隔离的 headless browser -> challenge artifact
       -> impersonating HTTP client -> provider Web endpoint
```

- **HTTP Impersonation** 绝不表示 Chrome 或其他 browser process 正在运行。
- **Headless Browser Execution** 始终表示真实 browser process 正在运行，只是没有显示窗口。
- **Browser-Assisted HTTP Impersonation** 只在 protocol 必须执行 browser code 时使用 headless browser；主请求仍由 impersonating HTTP client 发送。
- Daemon authentication 与 provider **Guest Mode** 相互独立：caller 可以通过 Tokenless 认证，而 provider request 仍保持 guest。
- **Browser Mode** 与 **Direct Mode** 是同一套 V1 API routing contract 的取值，不是两套独立的 public API。JSON request field 使用 `tokenless.execution_mode`；内部 TypeScript contract 使用 `executionMode`。
- **Harness AI Engine** 只服务于 **AI Sidecar**；它绝不会成为执行用户 Harness task 的 model route。
- 无论 **Harness AI Engine** 是 local、browser-provided 还是 remote，**Harness Task Model** 都必须通过 **Tokenless API** 到达。
- **Front Door** 可以为 **Harness Task Model** 选择 provider route，但它自己的 inference 仍由独立的 **Harness AI Engine** 执行。
- **Tokenless Harness API** 是 caller 与 **Tokenless Harness** 交互的 control 与 tool-exchange interface。Harness 仍然只通过 **Tokenless API** 到达 **Harness Task Model**。

## 对话示例

> **Developer：**“GLM direct path 使用 browser 吗？”
>
> **Domain expert：**“它使用 **Browser-Assisted HTTP Impersonation**：隔离的 **Headless Browser Execution** 先生成 challenge artifact，再由 **HTTP Impersonation** 发送 chat request。”
>
> **Developer：**“所以它不是 **Visible Browser Automation**？”
>
> **Domain expert：**“对，这条路径不会暴露或控制 provider UI。”

> **Developer：**“如果 Front Door 使用本地 Qwen model，Harness task 也会改由 Qwen 执行吗？”
>
> **Domain expert：**“不会。Qwen 是供 **AI Sidecar** 使用的 **Harness AI Engine**；**Harness Task Model** 仍通过 **Tokenless API**，在 **Front Door** 选择的 provider route 上执行。”

## 应避免的歧义表达

- **Browser impersonation** 有歧义。没有 browser process 时称为 **HTTP Impersonation**；headless browser 提供前置结果时称为 **Browser-Assisted HTTP Impersonation**。
- **Browser Mode** 是 API selector。讨论具体实现时，应使用 **Visible Browser Automation**，不要把它泛化为所有 browser execution 的同义词。
- **Direct Mode** 是 API selector。讨论具体实现时，如 backend 区别重要，应指出具体的 direct provider implementation。
- **Harness model** 有歧义。Sidecar inference 应称为 **Harness AI Engine**；通过 Tokenless API 执行用户任务的 provider model 应称为 **Harness Task Model**。
- **Harness AI Engine** 不得泛指 Harness 对接的所有 model；它只表示内部 sidecar inference dependency。
