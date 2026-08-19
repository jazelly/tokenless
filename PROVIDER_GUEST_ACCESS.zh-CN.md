# Provider 访客访问路由

本文记录了 2026-07-25 在用户提供的 Chrome Incognito 窗口中观察到的 provider 登出行为，以及通过所选真实访客 profile 验证的 Qwen 实验性访客路由。Provider 网站可以独立于 Tokenless 发生变化，因此 runtime 决策必须继续以可见页面状态为准。

| Provider | 登出入口 | 首次提交 | Runtime 路由 |
| --- | --- | --- | --- |
| ChatGPT | Composer 可用 | 返回响应 | 以访客身份继续 |
| Claude | `/new` 重定向到 `/login?from=logout`；无 composer | 不可用 | 交接登录 |
| Gemini | Composer 可用 | 返回响应 | 以访客身份继续 |
| Grok | Composer 可用，但不支持访客提交 | 被无法关闭的“Continue your conversation”注册墙替代 | 执行动作前交接 |
| Qwen | 所选访客 profile 中 composer 可用 | 返回首个可关联响应 | 以实验性访客身份继续 |

2026-07-25 的 ChatGPT、Claude、Gemini 和 Grok 页面均未提供可关闭且带有访客继续控件的认证对话框。如果 provider 以后引入这种状态，下面的 runtime 规则仍然支持它。

## Provider 账户映射

| Provider | 访客 | 免费账户证据 | 付费账户证据 |
| --- | --- | --- | --- |
| ChatGPT | 支持 | `Free` | `Go`、`Plus`、`Pro`、`Team`、`Business`、`Enterprise` |
| Claude | 不支持 | `Free` | `Pro`、`Max`、`Team`、`Enterprise` |
| Gemini | 支持 | 在获得可靠的可见 plan 证据前为未知 | 在获得可靠的可见 plan 证据前为未知 |
| Grok | 不支持 | `Auto`、`Expert` 与 `Heavy` 均明显不可用 | `Auto`、`Expert` 或 `Heavy` 中任意一项明显可用（`SuperGrok`） |
| Qwen | 实验性支持 | 在获得可靠的可见 plan 证据前为未知 | 在获得可靠的可见 plan 证据前为未知 |

账户标签把可见 session 分类为 `signed_in_free`、`signed_in_paid` 或 `signed_in_unknown`。这些标签是诊断证据，不是 capability 授权。

## 路由规则

1. Setup 对每个启用的 provider 执行一次可见 `auth.status` 观察，并报告 `auth`、`access` 与观察到的 tier。尚未稳定的页面可能报告为 `unknown`。Setup 不提交 prompt、不打开登录交接，也不会在用户登录后重试。
2. 当可用 composer 仍然可见时，可见的登录或注册入口本身不构成 blocker。
3. ChatGPT 与 Gemini 是受支持的访客 provider；Qwen 是实验性访客 provider。交接前，Tokenless 接受“Continue as guest”或“Continue without signing in”等精确可见的访客继续控件，然后再次检查页面。
4. Claude 与 Grok 的 Tokenless job 需要认证。未认证的 runtime 检查会在输入或提交任务前进行交接。
5. 执行受限动作前，未知页面 surface 会等待稳定的账户、访客 composer、登录 surface、challenge 或终止 blocker。不支持访客的 provider 若保持未知，会保守地进行交接；支持访客的 provider 若没有可用 surface，则以可重试的技术错误失败。
6. Challenge、plan、quota 与 rate-limit blocker 始终与认证路由分开处理。

## 真实证据

全新 profile 的真实 CLI matrix 保存在 `test-results/live-provider-guest-access/`，当前 provider capability 状态汇总于 `test/live-provider-capability-matrix.json`。Provider 行为只在真实网站上验证；开发和测试不会捕获 DOM 或将其提升为 fixture。
