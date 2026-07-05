# Tokenless

Tokenless 让本地智能体使用你浏览器里已经登录的人工智能订阅。它把任务发送到可见的 ChatGPT、Gemini 或 Claude 页面，等待回答，再把可见回答返回给智能体，不导出浏览器凭据、浏览器存储内容，也不读取隐藏的服务商接口令牌。

## 它解决什么问题

人工智能编程智能体经常需要调用另一个模型，或者使用用户自己已经购买的订阅，但常见做法都有问题：

- 接口密钥需要额外配置、轮换和付费。
- 浏览器自动化经常使用一次性测试资料，而不是用户真实登录的浏览器。
- 手动复制提示词和回答会打断流程，也容易丢失项目上下文。
- 服务商会话应该保持可见并由用户控制，尤其是在出现登录、验证码、限流或确认弹窗时。

Tokenless 把这些操作留在用户信任的浏览器会话中。浏览器扩展只能在批准的服务商页面上工作，并且只通过可见页面元素操作，不调用服务商的私有后端接口。

## 用户体验

安装命令行工具：

```bash
npm install -g tokenless
```

加载 Tokenless 浏览器扩展：

```text
packages/extension/dist/extension
```

把扩展绑定到本机原生通信主机：

```bash
tokenless install --extension-id <chrome-extension-id>
tokenless doctor --extension-id <chrome-extension-id>
```

从本地智能体或终端运行任务：

```bash
tokenless run \
  --provider chatgpt \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --context-file /tmp/shareable-context.md \
  --extension-id <chrome-extension-id>
```

用户会看到：

1. 浏览器打开 Tokenless 任务页面。
2. 扩展打开或复用指定服务商页面。
3. 提示词被填入可见输入框并发送。
4. Tokenless 等待可见回答文本稳定。
5. 回答返回给本地智能体。

## 包含哪些部分

- `tokenless`：用户安装、智能体调用的命令行工具。
- `Tokenless Browser Session Bridge`：操作可见服务商页面的浏览器扩展。
- `tokenless-relay`：可选的网页或托管集成入口，当前不发布。
- `tokenless-client`：网页应用调用中继入口的可选辅助代码，当前不发布。

## 发布策略

现在发布：

- `tokenless`

暂不发布：

- `tokenless-relay`
- `tokenless-client`
- `tokenless-browser-session-bridge`

浏览器扩展通过 Chrome 网上应用店、未打包目录或压缩包分发。用户在浏览器里安装扩展，不通过 npm 安装扩展。

## 安全边界

Tokenless 不绕过登录、验证码、服务商权限、限流或用户可见确认。它不读取服务商 cookies、localStorage、sessionStorage、隐藏认证头，也不调用服务商私有后端接口。如果可见浏览器会话中出现阻塞，Tokenless 会报告阻塞，而不是尝试绕过。

## 开发验证

```bash
npm run build
npm test
npm run test:e2e
```

真实 ChatGPT 测试需要真实登录的浏览器资料，因此默认不运行：

```bash
TOKENLESS_LIVE_CHATGPT=1 npm run test:e2e:live-chatgpt
```

## 本地开发测试

在仓库根目录运行：

```bash
REPO_ROOT="$(pwd)"

npm install
npm run build
npm test
npm run test:e2e

npm install -g ./packages/cli
```

从 `packages/extension/dist/extension` 加载未打包扩展：

```bash
open "chrome://extensions"
```

复制真实的 32 字符扩展编号，然后运行：

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"

tokenless install --extension-id "$TOKENLESS_EXTENSION_ID" --json
tokenless doctor --extension-id "$TOKENLESS_EXTENSION_ID" --json
```

在同一个浏览器资料中打开 ChatGPT，然后运行冒烟测试：

```bash
open "https://chatgpt.com"

cat > /tmp/tokenless-request.md <<'EOF'
请只回复下面这一行文字，不要回复其他内容：

TOKENLESS_LOCAL_OK_48291
EOF

cat > /tmp/tokenless-context.md <<'EOF'
这是一次本地 Tokenless 冒烟测试，不包含任何私密信息。
EOF

tokenless run \
  --provider chatgpt \
  --project-root "$REPO_ROOT" \
  --prompt-file /tmp/tokenless-request.md \
  --context-file /tmp/tokenless-context.md \
  --extension-id "$TOKENLESS_EXTENSION_ID" \
  --read-timeout-ms 180000 \
  --json
```

成功信号是返回 `ok: true`，并且 `compactOutput` 包含 `TOKENLESS_LOCAL_OK_48291`。
