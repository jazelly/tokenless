[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

Tokenless 通过 Playwright 为智能体提供统一的本地命令行和接口，用同一套操作调用你已经登录的 AI 网页，无需让调用方理解各家网页的实现差异。

> **当前状态：** Tokenless 正在将网页运行层迁移到 Playwright。浏览器扩展架构将被移除；ChatGPT、Claude、Gemini 和 Grok 正在统一接入；文件上传和更完整的网页能力仍在持续开发。新架构无需安装任何浏览器扩展。

## 为什么使用 Tokenless

- **首先是节省模型用量。** 研究、起草、审查、解释和内容转换可以复用现有网页订阅，不必再支付一次模型接口调用费用。
- **安全操作可见网页。** Tokenless 只通过 Playwright 操作服务商的正常网页，不提取 Cookie 或浏览器存储凭证，不截取隐藏授权信息，也不调用服务商私有接口。
- **免费、MIT 开源、本地运行。** Tokenless 不设托管中继；浏览器配置和登录状态保留在本机，只有提示词和主动选择的文件会发给所选服务商。
- **一套接口覆盖多家服务商。** 智能体使用相同操作调用 ChatGPT、Claude、Gemini 和 Grok，网页、控件和流程差异由 Tokenless 处理。

## 工作方式

`智能体 → 命令行或本地接口 → tokenless-daemon → Playwright 运行进程 → 托管 Chrome 配置 → 可见的服务商网页`

`tokenless setup` 会创建可长期复用的本地 Chrome 配置，并在需要登录时打开服务商网页。即使各家网页结构和文件上传控件不同，调用方看到的流程也保持一致。

| 模式 | 执行路径 | 身份认证 | 状态 |
| --- | --- | --- | --- |
| 网页模式（`visible`，默认） | Playwright 操作可见网页 | 本地托管的 Chrome 配置 | **推荐，正在迁移** |
| 直连模式（`direct`） | 官方客户端、公开接口或显式配置的兼容网关 | 客户端登录或环境变量密钥 | **实验性** |

两种模式完全隔离：网页自动化不会静默改走付费接口，直连请求也不会静默打开浏览器。Tokenless 是独立项目，不依赖 Noop 内部实现。

**本地接口**只是调用同一批 Playwright 网页任务的另一种入口；**直连模式**则绕过 Playwright，改用官方客户端或服务商公开接口。

## 安装

需要 Node.js 24.15+ 和 Google Chrome，无需安装扩展。

### npm（推荐）

```bash
npm install --global tokenless@latest
tokenless setup --json
tokenless doctor --json
```

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

### 智能体技能（智能体使用时必装）

如果由智能体使用 Tokenless，请安装这个维护技能，让智能体代你完成安装、升级、修复和完整检查：

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless-install --yes
```

交给智能体执行：

```text
请使用 $tokenless-install 安装或升级 Tokenless、安装主技能，并运行完整检查。
```

## 使用 Tokenless

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --attach-file ./brief.pdf \
  --prompt "审查这份材料并列出主要风险。" \
  --json
```

统一的 Playwright 操作协议将覆盖可见登录状态、精确模型与思考强度选择、文件上传、提示词输入与提交、回答读取、引用链接、阻断检测和脱敏网页快照。四家服务商的能力对齐及端到端文件上传仍在完善。

托管配置可以长期复用并隔离不同登录身份：

```bash
tokenless profiles add --profile work --set-default
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
```

命令行是主要入口。本地接口将开放同一套与服务商无关的任务和操作，使其他智能体与应用无需编写浏览器适配逻辑。该接口属于当前 Playwright 开发工作，尚未形成稳定兼容性承诺。

## 浏览器与隐私边界

- Playwright 在本机运行，并使用可见、可长期复用的 Google Chrome 配置。
- 导入现有 Chrome 配置必须获得明确同意；用户也可以始终选择新建干净配置。
- Tokenless 可以在本机复制登录状态，但绝不解析、打印、记录、导出或传输其中的凭证值。
- 自动化只操作可见网页控件并验证可见结果；验证码、登录、套餐限制和确认步骤仍由用户控制。
- 所选文件会在本机暂存并校验完整性，再通过可见的文件控件上传；任务结果不会暴露原始本地路径。

## 实验性直连模式

直连模式与 Playwright 完全分离，并可能产生服务商接口费用：

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "审查这个设计。" --json
```

使用公开接口时必须显式指定模型，并仅通过环境变量提供密钥。Tokenless 不接受命令行参数中的接口密钥，也不会将密钥写入自身状态。支持范围、本地鉴权服务、账户路由和安全边界见[直连模式文档](docs/direct-mode.md)。

## 路线图

- 完成 ChatGPT、Claude、Gemini 和 Grok 的统一 Playwright 操作协议。
- 让文件上传、模型选择、思考强度、引用链接和长时间回答在不同服务商之间保持一致体验。
- 开放项目、工作区、服务商文件、插件、连接器和工具。
- 支持图片生成、图片输入和更完整的多模态流程。
- 稳定本地接口，让智能体把 AI 网页直接作为可编程执行环境。

路线图内容尚不构成兼容性承诺。实现边界和验收计划见 [Playwright 架构交接文档](docs/handoff-visible-provider-web-automation.md)。

## 开发

需要 Node.js 24.15+、npm、Rust 和 Google Chrome。

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

以上命令不会发布任何内容。发布流程见 [npm 发布文档](docs/npm-publishing.md)。

## 许可证

[MIT](LICENSE)
