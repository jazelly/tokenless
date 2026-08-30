# Tokenless Harness Browser Extension

状态：experimental V2 candidate；仍需完成用户拥有的真实页面/provider 验收与 provider-session evidence capture。

Chrome 扩展同时是 Tokenless Harness client 与 browser-tool adapter。Tokenless API 仍是 provider-facing layer；Tokenless Harness 仍是 Agent runtime；Tokenless Harness API 是本地 run/control/tool-exchange 边界。

## Candidate 支持边界

| 支持 | 不支持 |
|---|---|
| 用户明确选择的一个 top-level `http` 或 `https` tab | Chrome 受保护页面、cross-origin frame、closed shadow DOM 或 canvas-only control |
| 可见 textual input、`textarea` 与可验证的 `contenteditable` surface | Password、OTP、payment、authentication-secret、hidden、disabled 或 read-only control |
| 非敏感 button、form submit control、原生 radio 与 file input | CAPTCHA、MFA、purchase、delete、download、popup 或 multi-tab automation |
| 一次经过批准的绝对 `http` 或 `https` navigation | 隐式 navigation、background continuation 或受保护 browser URL |
| 来自最新有界 observation 的 opaque `elementRef` | JavaScript、CSS selector、XPath 或 CDP escape hatch |

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
6. 检查确切 action、target、text 或 destination；upload 时选择一个本地文件。每个 action 单独批准或拒绝。
7. 确认预期的可见结果与 side panel final output。

只有用户在自己选择的真实页面目视确认正确字段被修改、无关字段和 tab 未变化，candidate 才算通过验收。

## 数据流与生命周期

- Content script 最多向 Harness Task Model 发送 128 个支持控件的 semantic metadata；raw page HTML 只写入私有本地证据包。
- 每个 run 使用附着时冻结的 observation；页面发生变化或变 stale 时会 fail closed，必须重新附着并启动新 run。
- 既有文字值、password-like field、cookie、storage、authorization data 与无关 tab 仍不会进入 model context。
- 用户批准的私有 evidence bundle 会在 Tokenless API home 中以仅 owner 可读权限保存 raw DOM、任务和输入值、前后截图、scoped extension credential、route identity、decision 与 result。
- 把所选 provider 的 raw session values 写入同一个私有 bundle 仍是必需 acceptance item；该证据存在前 candidate 不算 verified。
- Daemon 重启会丢弃 run 与 daemon-memory payload overlay；detach 会移除 extension session 对该 run 的访问，mutation 不会 replay。

## 修复、撤销与卸载

- Tab/document/origin 发生任何变化后，重新选择页面并再次附着。
- 移除扩展前先用 **Unpair** 撤销 credential。
- 测试完成后，从 `chrome://extensions` 移除 unpacked extension。

Active roadmap 的真实页面 acceptance gate 通过前，不要发布或分发此 candidate。
