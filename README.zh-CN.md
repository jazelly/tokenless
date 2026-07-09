# Tokenless

Tokenless 帮 agent 省 token。

很多 agent 请求其实不一定要消耗付费 API token。它们可以交给你浏览器里已经打开的 AI 网页版来回答。Tokenless 会把这些请求路由到可见的 ChatGPT、Claude 或 Gemini 网页，再把回答带回本地 agent。

English version: [README.md](README.md)

## 核心价值

Tokenless 解决的问题很简单：

> agent 不应该把 token 花在网页版 AI 已经能免费处理的事情上。

当一个请求适合交给网页版处理时，Tokenless 会把它发送到 provider 的普通网页。回答会回到 agent 流程里，所以你不用手动复制提示词和答案。

它适合用在这些日常 agent 工作里：

- 找第二意见
- research-style 问答
- 草稿改写
- code review 备注
- 解释一段内容
- 简单格式转换
- 网页版回答已经足够好的任务

## 它怎么工作

从用户视角看：

1. 你在浏览器里保持 ChatGPT、Claude 或 Gemini 登录。
2. 本地 agent 让 Tokenless 执行一个请求。
3. Tokenless 打开可见的 AI 网页聊天。
4. 提示词通过你能看见的页面发出。
5. 可见回答返回给 agent。

不用来回复制粘贴。这个请求不用单独 API key。也不会调用隐藏的 provider 后端接口。

## 为什么重要

Agent 很强，但 token 消耗也很快。很多 agent 工作并不是高强度推理，而是检查、改写、解释、总结，或者拿另一个模型的视角。

Tokenless 给这类工作一条更低成本的路径。重要的地方用 token。网页版够用的时候，就用网页版。

## 安装

安装 CLI：

```bash
npm install -g tokenless
```

安装 Tokenless skill，让 agent 可以调用它：

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless
```

安装 Tokenless 浏览器扩展，可以用 Chrome Web Store、未打包目录或 zip 包。

然后把扩展连接到本机：

```bash
tokenless install --extension-id <chrome-extension-id>
tokenless doctor --extension-id <chrome-extension-id>
```

设置 Tokenless 优先使用哪些网页版 provider：

```bash
tokenless config --preferred-providers claude,chatgpt,gemini
```

这会写入 `~/.tokenless/config.json`。

## 运行一个请求

```bash
tokenless run \
  --provider chatgpt \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --context-file /tmp/shareable-context.md \
  --extension-id <chrome-extension-id>
```

Tokenless 会把 provider 网页上的可见回答返回给本地 agent。

如果再次传入同一个 project name 和 chat name，Tokenless 可以回到同一个网页对话，而不是重新开始。

## 包含哪些部分

- `tokenless`：用户安装、agent 调用的 CLI。
- `Tokenless`：操作可见 provider 页面的浏览器扩展。
- `tokenless-relay`：给托管集成使用的可选 relay package。
- `tokenless-client`：给使用 relay 的应用准备的可选 helper code。

现在发布：

- `tokenless`

暂不发布：

- `tokenless-relay`
- `tokenless-client`
- `tokenless-browser-session-bridge`

## 安全边界

Tokenless 只在用户授权后，通过可见浏览器会话工作。

它不绕过登录、验证码、限流、provider 权限或用户确认。它不读取 provider cookies、浏览器存储 token、隐藏认证头，也不调用 provider 私有后端 API。

如果 provider 页面需要用户处理某个阻塞，Tokenless 会报告这个阻塞，而不是尝试绕过。

## 开发

```bash
npm run build
npm test
npm run test:e2e
```

`npm run build` 会生成未打包扩展到 `packages/extension/dist/extension`。

在 Chrome 或 Edge 里加载它：

1. 打开 `chrome://extensions`。
2. 开启 developer mode。
3. 选择 **Load unpacked**。
4. 选择 `packages/extension/dist/extension`。

然后绑定真实 extension id：

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"

tokenless install --extension-id "$TOKENLESS_EXTENSION_ID" --json
tokenless doctor --extension-id "$TOKENLESS_EXTENSION_ID" --json
```

在已登录 ChatGPT 的浏览器资料里运行本地 smoke test：

```bash
open "https://chatgpt.com"

cat > /tmp/tokenless-request.md <<'EOF'
请只回复下面这一行文字，不要回复其他内容：

TOKENLESS_LOCAL_OK_48291
EOF

cat > /tmp/tokenless-context.md <<'EOF'
这是一次本地 Tokenless smoke test，不包含任何私密信息。
EOF

tokenless run \
  --provider chatgpt \
  --project-name "Tokenless local dev" \
  --chat-name "Smoke test" \
  --project-root "$(pwd)" \
  --prompt-file /tmp/tokenless-request.md \
  --context-file /tmp/tokenless-context.md \
  --extension-id "$TOKENLESS_EXTENSION_ID" \
  --read-timeout-ms 180000 \
  --json
```

成功信号是返回 `ok: true`，并且 `compactOutput` 包含 `TOKENLESS_LOCAL_OK_48291`。
