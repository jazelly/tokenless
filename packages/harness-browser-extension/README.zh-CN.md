# Tokenless Harness Browser Extension

这是交给用户在真实页面验收的 experimental Manifest V3 candidate。它把用户明确选择的一个 Chrome tab 附着到本地 Tokenless Harness API。

## Build

```bash
npm run build --workspace packages/harness-browser-extension
```

在 **Chrome → 扩展程序 → 开发者模式 → 加载已解压的扩展程序** 中选择 `dist/unpacked`。不要打包或发布此 candidate。

## 使用

1. 在 `http://127.0.0.1:7331` 启动已配置的 Tokenless API daemon。
2. 打开 extension side panel，选择 **Pair in Dashboard**。
3. 在本地 Dashboard 核对 extension ID，并批准一个 provider/profile route。
4. 打开普通 `http` 或 `https` 页面，选择 **Attach**，检查 origin 与有界 control inventory。
5. 明确同意、输入任务，并在任何 mutation 前批准拟填写的确切文字。

V1 只暴露 `browser_page_observe` 与 `browser_page_input`；不会 click、submit、upload、navigate、运行 arbitrary JavaScript，也不接受 selector。

## 修复与移除

- Tab、document 或 daemon 发生变化后，重新附着当前页面并启动新的 run。
- **Unpair** 会撤销 extension-scoped credential；从 Chrome 移除扩展会清除其本地 credential 副本。
- Daemon 重启会丢弃内存中的 extension session 与 Harness run；V1 不重放页面内容或 mutation。

完整说明见 [Tokenless Harness Browser Extension 指南](../../docs/harness-browser-extension.zh-CN.md)。
