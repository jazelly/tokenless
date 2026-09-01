# Tokenless 隐私政策

生效日期：2026-08-11

Tokenless 在本机运行。它通过受管理的 Playwright 浏览器 profile 和经过认证的本地 daemon 操作可见的 ChatGPT、Claude、Gemini、Grok 与实验性 Qwen 页面。

## 数据处理

- 受管理的浏览器 profile、provider 登录状态、配置、job 状态、日志和快照都保留在用户设备上。
- Setup 不会复制或导入完整的 browser profile。在当前 visible-browser mode 中，浏览器状态和凭据保留在用户选择并正在运行的 Google Chrome 或 Brave Browser 中。
- Direct provider-protocol mode 在可用并由用户显式启用后，可以从所选 live browser 或 CDP session、用户提供的 HAR、所选 browser 的 Cookie database、手动提供的 cookie 或 token，以及所需 browser storage 中获取必要的 provider session value。访问仅发生在本机，并限定于用户显式选择的 provider 与 auth source。
- 当 import 或 save auth source 可用时，只有用户显式操作才会在本机持久化 HAR、cookie 或 token。未经该选择，Tokenless 不会导入或持久化 session value；每个 auth source 都会标明其 lifetime 是 ephemeral 还是 user-persisted。
- 在 macOS 上，显式 direct mode 可以读取解密所选 provider cookie 所必需的 browser encryption material，包括通过必要的 OS 或 Keychain API。Tokenless 不会读取密码、无关 Keychain item，或其他 provider、account、profile 的凭据。
- 用户显式选择的本地 direct adapter 或 sidecar 可以在进程内存中接收其所需的最小 provider session value，但不会记录、独立持久化或返回这些值。Tokenless 不会把这些值打印到 stdout 或 stderr，不会将其写入日志、错误、telemetry、job、checkpoint 或 UI response，不会暴露给 agent 或 web model，也不会发送给 Tokenless 运营的远程服务或任何无关服务。所选 provider 只会收到验证其自身请求所必需的值。
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
