[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

让任何智能体通过统一的本地命令行或接口，直接使用你已有的 AI 网页订阅。Tokenless 统一处理 ChatGPT、Claude、Gemini 和 Grok，调用方无需适配各家网页。

## 为什么使用 Tokenless

- **首先是节省 token。** 研究、起草、审查、解释和内容转换可以复用现有网页订阅，不必再支付一次模型接口调用费用。
- **安全、可见的浏览器自动化。** Playwright 操作服务商的正常网页，登录状态保存在本机托管的 Chrome 配置中，每个操作都验证可见结果。
- **免费、MIT 开源、本地运行。** Tokenless 在你的设备上运行。浏览器配置和登录状态保留在本机，只有提示词和主动选择的文件会发给所选服务商。
- **一套接口覆盖多家服务商。** 智能体使用相同操作调用 ChatGPT、Claude、Gemini 和 Grok，网页和控件差异由 Tokenless 处理。
- **面向完整工作流。** 统一协议将覆盖模型、思考强度、文件、提示词、回答、引用、项目、工具和多模态任务。

## 安装

需要 Node.js 22.13+ 和 Google Chrome。

### npm（推荐）

```bash
npm install --global tokenless@latest
tokenless setup --json
tokenless doctor --json
```

### 智能体技能（智能体使用时必装）

安装维护技能后，智能体可以代你完成 Tokenless 的安装、升级、修复和完整检查：

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless-install --yes
```

交给智能体执行：

```text
请使用 $tokenless-install 安装或升级 Tokenless、安装主技能，并运行完整检查。
```

### 其他安装方式

不进行全局安装：

```bash
npx tokenless@latest setup --json
npx tokenless@latest doctor --json
```

系统级安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

此命令会以 `sudo` 执行，请先[审阅脚本源码](https://github.com/jazelly/tokenless/blob/main/deploy/install.sh)。安装后请以普通桌面用户运行 `tokenless setup --json` 和 `tokenless doctor --json`。

## 快速使用

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --attach-file ./brief.pdf \
  --prompt "审查这份材料并列出主要风险。" \
  --json
```

同一套流程正在统一支持 ChatGPT、Claude、Gemini 和 Grok。目前重点是完成四家服务商的能力对齐、Playwright 端到端文件上传和公开本地接口。

## 路线图

- 完成 ChatGPT、Claude、Gemini 和 Grok 的统一 Playwright 操作协议。
- 让文件上传、模型选择、思考强度、引用和长时间回答在不同服务商之间保持一致体验。
- 开放服务商项目、工作区、文件、插件、连接器和工具。
- 支持图片生成、图片输入和更完整的多模态流程。
- 稳定本地接口，让智能体把 AI 网页作为可编程执行环境。

路线图内容尚不构成兼容性承诺。

## Tokenless 如何工作

`智能体 → 命令行或本地接口 → tokenless-daemon → Playwright 运行进程 → 托管 Chrome 配置 → 可见的服务商网页`

`tokenless setup` 会创建可长期复用的本地 Chrome 配置，并在需要登录时打开服务商网页。后续任务会继续使用该配置。Tokenless 将统一操作转换成对应网页控件，并返回一致的结果。

### 托管配置

一个托管配置代表一个可长期复用的本地浏览器身份。一个配置可以登录多家服务商；同一家服务商的多个账户则使用不同配置。

```bash
tokenless profiles add --profile work --set-default
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
```

导入现有 Chrome 配置必须获得明确同意，也可以随时选择新建干净配置。

### 调用入口与运行模式

| 入口或模式 | 执行路径 | 状态 |
| --- | --- | --- |
| 命令行 | 通过 `tokenless-daemon` 执行 Playwright 网页任务 | 主要入口 |
| 本地接口 | 执行同一套与服务商无关的 Playwright 任务 | 持续开发中 |
| 直连模式（`--mode direct`） | 官方客户端、服务商公开接口或显式配置的兼容网关 | 实验性 |

命令行和本地接口只是同一套 Playwright 自动化的不同入口。直连模式则用于明确选择的官方客户端或服务商接口调用。

## 隐私与安全

- Playwright 在本机运行，并使用可见、可长期复用的 Google Chrome 配置。
- 登录状态以不透明数据保存在所选托管配置中。
- 自动化只操作可见网页控件，并检查每个操作的可见结果。
- 验证码、登录、套餐限制、授权和确认步骤仍由用户控制。
- 所选文件会在本机暂存并校验完整性，再通过服务商的可见文件控件上传。
- 网页任务与直连请求始终遵循调用方明确选择的模式。

## 实验性直连模式

直连模式可能产生服务商接口费用：

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "审查这个设计。" --json
```

使用公开接口时必须显式指定模型，并通过环境变量提供密钥。支持范围、本地鉴权服务、账户路由和安全边界见[直连模式文档](docs/direct-mode.md)。

## 开发

需要 Node.js 22.13+、npm、Rust 和 Google Chrome。

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

以上命令不会发布任何内容。实现与验收细节见 [Playwright 架构交接文档](docs/handoff-visible-provider-web-automation.md)，发布流程见 [npm 发布文档](docs/npm-publishing.md)。

## 许可证

[MIT](LICENSE)
