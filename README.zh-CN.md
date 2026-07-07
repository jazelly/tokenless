# Tokenless

Tokenless 让本地 agents 使用你浏览器里已经登录的 AI 订阅。它把任务发送到可见的 ChatGPT、Gemini 或 Claude 页面，等待回答，再把可见回答返回给 agents，不导出浏览器凭据、浏览器存储内容，也不读取隐藏的 provider API 令牌。

## 它解决什么问题

AI 编程 agents 经常需要调用另一个模型，或者使用用户自己已经购买的订阅，但常见做法都有问题：

- API需要额外配置、轮换和付费。
- 浏览器自动化经常使用一次性测试资料，而不是用户真实登录的浏览器。
- 手动复制提示词和回答会打断流程，也容易丢失项目上下文。
- provider 会话应该保持可见并由用户控制，尤其是在出现登录、验证码、限流或确认弹窗时。

Tokenless 把这些操作留在用户信任的浏览器会话中。浏览器 extension 只能在批准的 provider 页面上工作，并且只通过可见页面元素操作，不调用 provider 的私有后端接口。

## 用户体验

1. 安装 CLI 命令行工具：

```bash
npm install -g tokenless
```

2. 安装 Tokenless Skill 到本地（使 agents 能够与 Tokenless 进行前端交互）：

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless
```

3. 安装 Tokenless 浏览器扩展：浏览器扩展通过 Chrome 网上应用店、未打包目录或压缩包分发。如果你是从源码仓库开始，需要先编译 extension；步骤见下文「本地开发测试」。

4. 把 extension 绑定到本机 Native Messaging Host：

```bash
tokenless install --extension-id <chrome-extension-id>
tokenless doctor --extension-id <chrome-extension-id>
```

配置 agents 在没有显式指定 provider 时使用的 provider 优先级：

```bash
tokenless config --preferred-providers claude,chatgpt,gemini
```

这个命令会写入 `~/.tokenless/config.json`。CLI 把这个文件当作配置源；extension 侧边栏会显示这份配置，让浏览器界面和本地 agents 保持一致。

从本地 agent 或终端运行任务：

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

CLI 会返回一个由项目名和聊天名派生的稳定 `taskId`。agents 应保存它，用 `tokenless state --task-id "<taskId>" --json` 查询执行状态，并在后续运行中通过 `--task-id "<taskId>"` 继续同一个任务/对话映射。

从可见 provider 页面抓取 sanitized DOM snapshot：

```bash
tokenless snapshot-dom \
  --provider chatgpt \
  --extension-id <chrome-extension-id> \
  --json
```

Snapshot 产物会写入 `~/.tokenless/snapshots/<provider>/`。默认情况下，Tokenless 会在 HTML snapshot 中遮蔽可见页面文字，并把 selector probe 结果单独保存。只有在页面可见文字可以明确分享时才传 `--include-text`。

用户会看到：

1. 浏览器打开 Tokenless 任务页面。
2. extension 打开已映射的 provider 对话；如果是新的 idempotency key，则从新的可见聊天开始。
3. 提示词被填入可见输入框并发送。
4. Tokenless 等待可见回答文本稳定。
5. 回答返回给本地 agent。

## 对话映射

每个 agent 聊天线程传入稳定的项目名和聊天名。Tokenless 会把本地映射保存到 `~/.tokenless/meta/conversations.json`。

- `--project-name` 是调用方 agent 里的项目名。
- `--chat-name` 是调用方 agent 里的聊天标题、线程标题或稳定聊天标签。
- 如果没有显式传 `--idempotency-key`，Tokenless 会从 `--project-name` 和 `--chat-name` 派生稳定对话 key。
- 这个派生 key 会作为 `taskId` 返回给 agents；后续查询状态或继续运行时，优先使用 agent-facing 的 `--task-id` 参数。
- 如果只传了 `--project-name` 或只传了 `--chat-name`，Tokenless 也会基于这个单独名称派生稳定 key。
- 如果两个名称都没有传，也没有显式 `--idempotency-key`，Tokenless 不复用已有映射，会从新的可见聊天开始。
- 如果调用方 agent 已经有稳定线程编号，也可以继续通过 `--idempotency-key` 显式传入。

- 新 key 第一次运行时打开 provider 主页，例如 `https://chatgpt.com/`，从新的可见聊天开始。
- 当 provider 把这次运行跳转到对话 URL，例如 `https://chatgpt.com/c/...`，Tokenless 会把这个 URL 保存到该 key。
- 同一个 key 后续运行会回到同一个 provider 对话。
- 不同 key 不会意外复用已有 provider 对话。
- 扩展侧边栏会按项目和聊天显示本地任务历史，并展示映射到的 provider URL。

## Provider 配置

Tokenless 支持可见的 ChatGPT、Claude 和 Gemini 页面。你可以通过以下两种方式配置 preferred providers：

1. **手动配置**：直接编辑 `~/.tokenless/config.json` 配置文件，或者运行 `tokenless config --preferred-providers` 命令。
2. **UI 配置**：在 extension 侧边栏/UI 界面中直接进行配置。

## 包含哪些部分

- `tokenless`：用户安装、agents 调用的 CLI 工具。
- `Tokenless`：操作可见 provider 页面的浏览器 extension。
- `tokenless-relay`：可选的网页或托管集成入口，当前不发布。
- `tokenless-client`：网页应用调用中继入口的可选辅助代码，当前不发布。

## 安全边界

Tokenless 不绕过登录、验证码、provider 权限、限流或用户可见确认。它不读取 provider cookies、localStorage、sessionStorage、隐藏认证头，也不调用 provider 私有后端接口。如果可见浏览器会话中出现阻塞，Tokenless 会报告阻塞，而不是尝试绕过。

## 开发验证

```bash
npm run build
npm test
npm run test:e2e
```

`npm run build` 会在 `packages/extension/dist/extension` 生成 unpacked extension。构建完成后，在 Chrome 或 Edge 中打开 `chrome://extensions`，启用开发者模式，选择「加载已解压的扩展程序」/「Load unpacked」，并指向该目录。完整 CLI 绑定与 smoke test 见下文「本地开发测试」。

`npm run test:e2e` 会用 Playwright 在 `https://chatgpt.com/**` 下提供一个规范化的 ChatGPT real-DOM fixture，验证本地 extension/native-host 链路。它会覆盖 Tokenless 针对 ChatGPT 使用的可见输入框、发送按钮和助手消息 selector 形态，但不证明当前线上 ChatGPT DOM 仍然兼容。

真实 ChatGPT 测试会打开真正的 `https://chatgpt.com/` DOM，并且需要真实登录的浏览器资料，因此默认不运行：

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
npm run test:e2e # real-DOM fixture E2E，不是 live ChatGPT

npm install -g ./packages/cli
```

从 `packages/extension/dist/extension` 加载 unpacked extension：

```bash
open "chrome://extensions"
```

复制真实的 32 字符 extension ID，然后运行：

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"

tokenless install --extension-id "$TOKENLESS_EXTENSION_ID" --json
tokenless doctor --extension-id "$TOKENLESS_EXTENSION_ID" --json
```

在同一个浏览器资料中打开 ChatGPT，然后运行 smoke test：

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
  --project-root "$REPO_ROOT" \
  --prompt-file /tmp/tokenless-request.md \
  --context-file /tmp/tokenless-context.md \
  --extension-id "$TOKENLESS_EXTENSION_ID" \
  --read-timeout-ms 180000 \
  --json
```

成功信号是返回 `ok: true`，并且 `compactOutput` 包含 `TOKENLESS_LOCAL_OK_48291`。
