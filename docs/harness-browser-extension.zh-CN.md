# Tokenless Harness Browser Extension

状态：experimental candidate；仍需完成用户拥有的真实页面验收。

Chrome 扩展同时是 Tokenless Harness client 与 browser-tool adapter。Tokenless API 仍是 provider-facing layer；Tokenless Harness 仍是 Agent runtime；Tokenless Harness API 是本地 run/control/tool-exchange 边界。

## V1 支持边界

| 支持 | 不支持 |
|---|---|
| 用户明确选择的一个 top-level `http` 或 `https` tab | Chrome 受保护页面、cross-origin frame、closed shadow DOM 或 canvas-only control |
| 可见、启用的 `text`、`search`、`email`、`tel`、`url` 与 `number` input | Password、OTP、payment、authentication-secret、file、hidden、disabled 或 read-only control |
| `textarea` 与可验证的可见 `contenteditable` surface | Click、submit、select、upload、download、popup 或 navigation |
| 来自最新有界 observation 的 opaque `elementRef` | JavaScript、CSS selector、XPath、URL 或 CDP escape hatch |

## 安装 candidate

```bash
npm run build --workspace packages/harness-browser-extension
```

1. 在 `http://127.0.0.1:7331` 启动正常配置的 Tokenless API daemon。
2. 打开 `chrome://extensions`，启用 **开发者模式**，选择 **加载已解压的扩展程序**。
3. 选择 `packages/harness-browser-extension/dist/unpacked`。
4. 打开 extension side panel，选择 **Pair in Dashboard**。
5. 在本地 Dashboard 核对确切的 extension ID，再选择并批准一个已启用的 provider/profile route。

签发的 credential 只授权该 extension identity 及其自己的 Harness session；它不能调用 daemon control、修改配置或访问其他 caller 的 run。

## 在页面上运行

1. 打开要使用的真实页面，并保持该 tab 被选中。
2. 选择 **Attach or repair selected tab**。
3. 检查确切 origin 与 semantic control inventory。
4. 阅读 provider disclosure；任何有界页面内容离开扩展前必须明确同意。
5. 输入自然语言任务并启动 Harness run。
6. 检查确切 target label 与 proposed text，然后批准或拒绝。
7. 确认预期的可见字段发生变化，而且 side panel 到达 final result。

只有用户在自己选择的真实页面目视确认正确字段被修改、无关字段和 tab 未变化，candidate 才算通过验收。

## 数据流与生命周期

- Content script 最多返回 64 个支持控件的 semantic metadata，绝不发送 raw page HTML。
- 每个 run 使用附着时冻结的 observation；页面发生变化或变 stale 时会 fail closed，必须重新附着并启动新 run。
- 既有文字值、password-like field、cookie、storage、authorization data 与无关 tab 都会被排除。
- Task text、semantic snapshot、proposed input text、provider response 与未脱敏 final response 只保留在 daemon-memory ephemeral overlay 中；持久 provider job 只包含脱敏 placeholder 与 correlation metadata。
- 持久 pairing state 只保存 credential hash 与 route identity；extension storage 保存连接当前 daemon 所需的 scoped credential。
- Daemon 重启会丢弃 run 与 daemon-memory payload overlay；detach 会移除 extension session 对该 run 的访问。请启动新 run；V1 不恢复或重放 mutation。

## 修复、撤销与卸载

- Tab/document/origin 发生任何变化后，重新选择页面并再次附着。
- 移除扩展前先用 **Unpair** 撤销 credential。
- 测试完成后，从 `chrome://extensions` 移除 unpacked extension。

Active roadmap 的真实页面 acceptance gate 通过前，不要发布或分发此 candidate。
