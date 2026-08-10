# Tokenless 隐私政策

生效日期：2026-08-10

Tokenless 在本机运行。它通过受管理的 Playwright 浏览器 profile 和经过认证的本地 daemon 操作可见的 ChatGPT、Claude、Gemini、Grok 与实验性 Qwen 页面。

## 数据处理

- 受管理的浏览器 profile、provider 登录状态、配置、job 状态、日志和快照都保留在用户设备上。
- Setup 不会复制或导入完整的 browser profile。在当前 visible-browser mode 中，浏览器状态和凭据保留在用户选择并正在运行的 Google Chrome 或 Brave Browser 中。
- Direct provider-protocol mode 在可用并由用户显式启用后，可以读取并使用调用该 provider Web endpoint 所需的 session cookie、token、header 与 browser-storage value。访问仅发生在本机，并限定于用户选择的 provider 与 profile。
- Tokenless 不会打印 provider session value，不会将其写入日志或 telemetry，不会暴露给 agent 或 UI client，也不会发送给 Tokenless 运营的服务。所选 provider 会收到验证其自身请求所需的值。
- `auto`、`headed` 与 `headless` 仅改变本地受管理浏览器的呈现方式；它们不会关闭 Chromium sandbox，且仍使用同一套本地 daemon 与 profile 流程。
- Prompt、所选文件和可见页面操作只会发送给你选择的 provider；其隐私、保留与订阅条款同样适用。
- Prompt 和可见结果仅在执行和报告 job 所需的范围内本地保存；提交前会移除原始调用方文件路径。
- 本地 daemon 与 Playwright worker 通过经过认证的 loopback 接口通信；Tokenless 不运营接收 provider 会话数据的远程服务。
- 所选文件会在本地暂存、检查完整性，并通过 provider 可见的文件控件上传。
- CAPTCHA、登录、付款、方案以及含义不明确或涉及外部授权的确认步骤始终可见并由用户控制。对于用户已选择的 provider，provider adapter 可以自动接受使用该 provider 所必需、内容明确且已知的 onboarding Terms/Privacy 对话框。

## 用户控制

可使用 `tokenless profiles list` 检查逻辑 Tokenless profile，使用 `tokenless profiles clear --profile <slug>` 移除单个 profile，或使用 `tokenless profiles clear --all` 移除全部 profile。这些命令不会移除或修改所选 Chrome 或 Brave browser profile。删除 `~/.tokenless` 会移除本地 Tokenless runtime 状态。

## 联系方式

如有隐私问题或报告，请在 https://github.com/jazelly/tokenless/issues 提交 issue。
