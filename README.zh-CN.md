[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

让任何智能体通过统一的本地命令行或接口操作 AI 网页。Tokenless 为 ChatGPT、Claude、Gemini 和 Grok 提供一套与服务商无关的调用方式。

## 为什么使用 Tokenless

- **省 token。** 直接使用已经付费的网页订阅，不必为同一次模型调用再次支付接口费用。
- **安全且可见。** Playwright 操作服务商正常网页，并验证页面上的实际结果。
- **由本机掌控。** Tokenless 免费、MIT 开源；运行环境、托管配置和登录状态都保存在你的设备上。
- **一套接口调用四家服务商。** 命令行统一调用四家服务商，文件、项目、工具、图片和多模态能力也将接入同一套协议。

## 安装

需要 Node.js 22.13+ 和 Google Chrome、Brave 等受支持的 Chromium 浏览器。

```bash
npm install --global tokenless@latest
```

设置流程会安装并验证必需的 `tokenless` 和 `tokenless-install` 智能体技能。需要让智能体负责安装或升级时，直接告诉它：

```text
请使用 $tokenless-install 安装或升级 Tokenless，并运行完整检查。
```

其他部署方式：

```bash
# 不进行全局安装
npx tokenless@latest setup

# 系统级安装；执行前请先审阅脚本
curl -fsSL https://raw.githubusercontent.com/jazelly/tokenless/main/deploy/install.sh | sudo bash
```

## 启动

首次设置时选择一种托管配置方案。

### 1. 使用现有浏览器配置（推荐）

```bash
tokenless setup
```

按照交互式命令行选择浏览器、服务商和一个现有 Chrome 或 Brave 配置。获得明确同意后，Tokenless 只把所选服务商中受支持的登录状态复制到独立托管配置，不修改原浏览器配置。

### 2. 使用全新配置启动

```bash
tokenless setup --fresh
```

首次安装时，此命令会创建干净的 `default` 配置、启动本地运行环境，并在需要登录时打开 ChatGPT。它不会隐式导入现有浏览器配置。

两种方式都可以这样检查：

```bash
tokenless doctor --json
```

## 升级

```bash
tokenless upgrade
```

升级全程不会提问：它会安装最新的全局 CLI、刷新 Tokenless 智能体技能，通过新安装的 CLI 对打包的本地守护进程进行协调更新，最后运行这个新 CLI 的只读 doctor 检查。默认输出简洁、适合用户阅读；智能体和 CI 应运行 `tokenless upgrade --json`，从标准输出获得一份结构化结果。两种形式都会在任何必需阶段或 doctor 检查不健康时以非零状态退出，因此不需要另设非交互命令。

## 第一次调用

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --attach-file ./brief.pdf \
  --prompt "审查这份材料并列出主要风险。" \
  --json
```

ChatGPT、Claude、Gemini 和 Grok 正在统一到同一套流程中。四家能力对齐、端到端文件上传和公开本地接口仍在持续开发。

## 路线图

- 完成 ChatGPT、Claude、Gemini 和 Grok 的统一 Playwright 操作协议。
- 统一文件、模型控制、引用和长时间回答体验。
- 开放服务商项目、工作区、文件、插件、连接器和工具。
- 支持图片生成、图片输入和更完整的多模态流程。
- 稳定本地接口，让智能体把 AI 网页作为可编程执行环境。

路线图内容尚不构成兼容性承诺。

## Tokenless 如何工作

`智能体 → 命令行或本地接口 → 本地守护进程 → Playwright 运行进程 → 托管浏览器配置 → 服务商网页`

命令行和本地接口提交统一操作，本地守护进程负责调度，Playwright 使用所选托管配置操作网页，各服务商适配器验证可见结果。后续任务会复用同一配置。

### 托管配置

一个托管配置代表一个可长期复用的本地浏览器身份。一个配置可以登录多家服务商；同一家服务商的多个账户使用不同配置。

```bash
tokenless profiles discover --browser chrome --json
tokenless profiles discover --browser brave --json
tokenless profiles add --profile work --browser chrome --import-browser-profile "Profile 1" --preferred-providers chatgpt,claude --consent-local-profile-copy --set-default
tokenless profiles add --profile clean --set-default
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude
tokenless profiles reset --profile work
tokenless profiles clear --profile work
```

`profiles discover` 只读取配置列表。导入、重置和清除都必须显式执行，普通任务不会自动改变配置状态。

### 调用入口与运行模式

| 入口或模式 | 执行路径 | 状态 |
| --- | --- | --- |
| 命令行 | 通过本地守护进程执行 Playwright 网页任务 | 主要入口 |
| 本地接口 | 执行同一套与服务商无关的 Playwright 任务 | 持续开发中 |
| 直连模式（`--mode direct`） | 官方客户端、服务商公开接口或显式配置的兼容网关 | 实验性 |

直连模式独立于托管网页自动化，并可能产生服务商接口费用。

## 隐私与安全

- Playwright 在本机运行，并使用可见、可长期复用的托管浏览器配置。
- 经用户同意的导入只复制所选服务商的登录状态，不包含密码、历史记录、书签、支付、同步和缓存数据。
- 自动化只操作可见网页控件，并检查可见结果。
- 验证码、登录、套餐限制、授权和确认步骤仍由用户控制。
- 所选文件会在本机暂存并校验完整性，再通过服务商的可见文件控件上传。
- 每个请求只使用调用方明确选择的运行模式。

完整说明见[隐私政策](PRIVACY.md)。

## 实验性直连模式

```bash
codex login
tokenless run --mode direct --provider chatgpt --prompt "审查这个设计。" --json
```

使用公开接口时必须显式指定模型，并通过环境变量提供密钥。支持范围、账户路由和安全边界见[直连模式文档](docs/direct-mode.md)。

## 开发

需要 Node.js 22.13+、npm、Rust 和 Google Chrome。

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

以上命令不会发布任何内容。托管 Playwright 运行机制见[架构文档](docs/architecture.md)，发布流程见 [npm 发布文档](docs/npm-publishing.md)。

## 许可证

[MIT](LICENSE)
