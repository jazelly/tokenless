# Tokenless 隐私政策

生效日期：2026-07-20

Tokenless 在本机运行。它通过受管理的 Playwright 浏览器 profile 和经过认证的本地 daemon 操作可见的 ChatGPT、Claude、Gemini、Grok 与实验性 Qwen 页面。

## 数据处理

- 受管理的浏览器 profile、provider 登录状态、配置、job 状态、日志和快照都保留在用户设备上。
- 在你明确同意后，setup 可以把所选 ChatGPT、Claude、Grok 或实验性 Qwen 的登录记录和有限 Chromium 兼容性状态复制到独立的 Tokenless profile；不会导入 Gemini 或共享 Google 登录数据，也不会导入密码、完整历史、书签、付款数据、同步数据、无关站点存储或缓存。
- 身份验证值对 agent 保持不透明。Tokenless 不会打印、记录、导出或发送它们到 Tokenless 服务。
- `auto`、`headed` 与 `headless` 仅改变本地受管理浏览器的呈现方式；它们不会关闭 Chromium sandbox，且仍使用同一套本地 daemon 与 profile 流程。
- Prompt、所选文件和可见页面操作只会发送给你选择的 provider；其隐私、保留与订阅条款同样适用。
- Prompt 和可见结果仅在执行和报告 job 所需的范围内本地保存；提交前会移除原始调用方文件路径。
- 本地 daemon 与 Playwright worker 通过经过认证的 loopback 接口通信；Tokenless 不运营接收 provider 会话数据的远程服务。
- 所选文件会在本地暂存、检查完整性，并通过 provider 可见的文件控件上传。
- CAPTCHA、登录、同意、付款、方案与确认步骤始终可见并由用户控制。

## 用户控制

导入 profile 需要明确同意，且不会修改源浏览器 profile。可使用 `tokenless profiles list` 检查受管理 profile，使用 `tokenless profiles clear --profile <slug>` 移除单个 profile，或使用 `tokenless profiles clear --all` 移除全部 profile。删除 `~/.tokenless` 会移除本地运行时状态。

## 联系方式

如有隐私问题或报告，请在 https://github.com/jazelly/tokenless/issues 提交 issue。
