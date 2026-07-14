[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

Tokenless 让智能体通过两种方式使用 AI：操作你已登录的服务商网页，或显式连接官方客户端和公开 API。默认且推荐使用浏览器扩展模式：它只操作可见网页界面，将浏览器凭证留在浏览器内，并避免额外消耗一次付费模型 API 请求。

## 运行模式

| 模式 | 传输路径 | 身份认证 | 状态 |
| --- | --- | --- | --- |
| 扩展模式（`visible`，默认） | ChatGPT、Claude 或 Gemini 可见网页界面 | 浏览器登录会话 | **推荐** |
| 直连/API 模式（`direct`） | 官方 Codex 客户端、公开 API 或显式配置的兼容网关 | 官方客户端登录或环境变量 API 密钥 | **实验性，持续开发中** |

两种模式完全隔离。扩展模式失败时不会自动改走付费 API；直连请求失败时也不会自动打开浏览器重试。

## 为什么使用 Tokenless

- **首先是节省 token。** 研究、草稿、审查、解释和内容转换可以复用已有网页订阅，不必再消耗一次模型 API 请求。
- **原生浏览器操作，安全边界清晰。** 扩展模式只使用正常、可见的 DOM 操作，不读取 Cookie、密码、浏览器存储 token、隐藏授权请求头或私有服务商 API。
- **免费、MIT 开源、本地运行。** Tokenless 不设接收浏览器会话的托管中继；只有提示词、明确分享的上下文和主动选择的文件会提交给所选服务商。
- **可持续扩展。** 当前可见网页适配器支持 ChatGPT、Claude 和 Gemini，也可扩展至其他具有兼容网页界面的 AI 服务商。

## 安装

需要 Node.js 24.15+。扩展模式还需要在 Chrome、Brave、Edge、Arc 或 Chromium 中安装 Tokenless 扩展。

### npm（推荐）

```bash
npm install --global tokenless@latest
tokenless setup --json
tokenless doctor --json
```

请完成 `setup` 打开的服务商登录或权限确认。只有本地运行环境与扩展桥接均可用时，`doctor` 才会成功。

不进行全局安装：

```bash
npx tokenless@latest setup --json
npx tokenless@latest doctor --json
```

系统级安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

此命令会以 `sudo` 执行，请先[审阅脚本源码](https://github.com/jazelly/tokenless/blob/main/deploy/install.sh)。脚本只安装命令行工具；完成后请以普通桌面用户运行 `tokenless setup --json` 和 `tokenless doctor --json`。

### 智能体技能（智能体使用时必装）

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless-install --yes
```

然后告诉智能体：

```text
请使用 $tokenless-install 安装 Tokenless、安装主技能，并验证它已就绪。
```

安装技能负责安装、升级、修复和 `doctor` 检查；遇到必须由你完成的浏览器操作时，它会给出明确步骤。

## 推荐：扩展模式

扩展模式是默认值，无需显式传入 `--mode visible`。

```bash
tokenless run \
  --provider chatgpt \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --prompt "Review the navigation." \
  --json
```

- 默认服务商为 ChatGPT，同时支持 Claude 和 Gemini。
- 后续轮次可通过 `--task-id` 复用返回的 `taskId`。
- 可见任务可能超过三分钟时，加入 `--long-running`。
- 服务商显示引用链接时，研究结果会在 `result.read.sources` 中返回这些可见来源。

扩展仅在用户授予主机权限后操作可见控件。登录、CAPTCHA、限流和确认步骤始终由你控制；它不会自动打开任务页、本地文件页或 `chrome-extension://` 工作流。

## 实验性：直连/API 模式

直连模式仍在持续开发。除非你明确需要官方客户端、公开 API、兼容网关、本地 API broker 或多账户项目路由，否则推荐使用扩展模式。

在 macOS 和 Linux 上，ChatGPT 默认调用服务商官方 Codex 客户端：

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "Review this design." --json
```

公开 API 后端必须显式指定模型，并通过环境变量提供凭证：

```bash
TOKENLESS_DIRECT_CLAUDE_API_KEY=... \
tokenless run \
  --mode direct \
  --provider claude \
  --model <api-model> \
  --prompt "Review this design." \
  --json
```

直连模式支持 ChatGPT、Claude、Gemini、Grok，以及显式配置的 Antigravity 兼容网关。公开 API 流量可能产生独立于网页订阅的费用。Tokenless 不接受命令行参数中的 API 密钥，也不会将密钥写入自身状态。服务商列表、本地 broker、账户路由、路由白名单和安全细节见[直连模式文档](docs/direct-mode.md)。

## 路线图

扩展模式将继续通过同一条可见、需授权的网页路径开放更多服务商原生能力：

- 项目与工作区；
- 文件与附件；
- 插件、连接器与工具；
- 图片和多模态工作流。

目标是让智能体像用户一样完整使用服务商网页，而不依赖私有网页 API。以上内容属于路线图，不代表当前兼容性承诺。

## 常用命令

```bash
tokenless config --preferred-providers chatgpt,claude,gemini --browser chrome --json
tokenless state --task-id "<task-id>" --json
tokenless cancel --job-id "<job-id>" --json
tokenless snapshot-dom --provider chatgpt --json
```

使用未打包扩展时，只需在首次设置传入真实 ID：`tokenless setup --extension-id <id> --json`。更多信息见 [CLI 参考](packages/cli/README.md)、[架构文档](docs/architecture.md)和[隐私政策](PRIVACY.md)。

## 开发

需要 Node.js 24.15+、npm 和 Rust。

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

扩展构建产物位于 `packages/extension/dist/extension`，可在 `chrome://extensions` 的开发者模式中加载。发布流程见 [npm 发布文档](docs/npm-publishing.md)和 [Chrome Web Store 发布文档](docs/chrome-web-store-release.md)；上述命令不会发布任何内容。

## 许可证

[MIT](LICENSE)
