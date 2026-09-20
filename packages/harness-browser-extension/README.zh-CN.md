# Tokenless Harness Browser Extension

这是交给用户在真实页面验收的 experimental Manifest V3 candidate。它把用户明确选择的一个 Chrome tab 附着到本地 Tokenless Harness API。

## Build

```bash
npm run build --workspace packages/harness-browser-extension
```

在 **Chrome → 扩展程序 → 开发者模式 → 加载已解压的扩展程序** 中选择 `dist/unpacked`。不要打包或发布此 candidate。

## 使用

1. 在 `http://127.0.0.1:7331` 启动已配置的 Tokenless API daemon。
2. 打开 extension side panel，进入 **设置**，在连接区域选择 **在 Dashboard 配对**。
3. 在本地 Dashboard 核对 extension ID，并批准一个 provider/profile route。
4. 打开普通 `http` 或 `https` 页面，并保持该 tab 被选中。
5. 在 side panel 输入任务。第一次发送时会准备当前页面，只在确实需要时请求页面访问。
6. 检查页面 origin 与每个准确的 action，在执行前逐项批准或拒绝。
7. 遇到 upload proposal 时，在批准前通过 side panel 选择恰好一个本地文件。

V2 candidate 暴露 `browser_page_observe`、`browser_page_input`、`browser_page_click`、`browser_page_submit`、`browser_page_radio`、`browser_page_upload` 与 `browser_page_navigate`；不会运行 arbitrary JavaScript，也不接受 selector。

完整本地证据写入所选 Tokenless API home 的 `harness-browser-extension-evidence/` 目录，并使用仅 owner 可读的权限。内容包括 raw DOM、输入值、截图、scoped extension credential、route identity、action decision 与 result。

## 修复与移除

- Tab、document 或 daemon 发生变化后，使用 side panel 的 **刷新页面上下文**，再启动新的 run。
- 连接、语言和隐私说明都放在 **设置** 中；side panel 只专注于任务。
- **Unpair** 会撤销 extension-scoped credential；从 Chrome 移除扩展会清除其本地 credential 副本。
- Daemon 重启会丢弃内存中的 extension session 与 Harness run；candidate 不重放页面 mutation。

完整说明见 [Tokenless Harness Browser Extension 指南](../../docs/harness-browser-extension.zh-CN.md)。
