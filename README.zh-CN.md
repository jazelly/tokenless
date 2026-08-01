<p align="center">
  <img src="assets/tokenless-wordmark.png" alt="Tokenless" width="560">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/v/tokenless?logo=npm&amp;label=version" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/dm/tokenless?logo=npm&amp;label=downloads" alt="npm 月下载量"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="COMMANDS.zh-CN.md">CLI 命令</a> · <a href="#安装与初始化">快速开始</a>
</p>

## Tokenless 能做什么

Tokenless 让 AI Agent 把任务直接交给 ChatGPT、Claude、Gemini、Grok、Qwen 和实验阶段的 DeepSeek 网页版处理，从而减少 Agent 侧 token 消耗，也不需要配置这些服务的 API Key。

它不只是把 prompt 填进网页。Tokenless 会把各家 provider 真正提供的网页工作流适配成一个供 Agent 使用的本地接口：

- 发送 prompt，并读取回复和引用；
- 通过 provider 自己的控件上传文件；
- 使用页面上可见的模型、推理等级和 provider 专属模式；
- 创建或复用 Projects，并将每个任务限定在正确的 profile、Project 和对话中；以及
- 传递选定的项目文件和单轮上下文，不暴露无关文件。

只有经过 Tokenless 可见验证的 provider 工作流才会启用。未支持或尚未证明的行为会明确报错，不会猜测执行。Provider 登录信息、浏览器状态和 job 数据都保留在用户本机。

在同一个 managed profile 中，Tokenless 会为不同 provider 和稳定 task 保留彼此独立的浏览器标签页。Project 和对话会按 task identity 回到自己的标签页，不会覆盖并导航掉另一个 provider 或对话。Local job API 默认使用 `pagePolicy: "preserve"`；只有 integration 显式请求 `pagePolicy: "replace"` 时，Tokenless 才允许把已有标签页改作另一个 task 使用。

| Provider | 状态 | 是否需要登录 |
| --- | --- | --- |
| ChatGPT | 可用 | 不需要 |
| Claude | 可用 | 需要 |
| Gemini | 可用 | 不需要 |
| Grok | 可用 | 需要 |
| Qwen / 千问 | Beta | 不需要 |
| DeepSeek | 实验阶段 | 需要 |

## 安装与初始化

安装 CLI：

```bash
npm install --global tokenless@latest
```

然后按照交互式 setup 流程完成初始化：

```bash
tokenless setup
```

安装 npm package 只是第一步。使用 Tokenless 前必须完成 `tokenless setup`；它会准备本地运行环境，创建或导入浏览器 profile，并检查所有已启用的 providers。首次 setup 会根据系统 locale 选择英文或简体中文，并把结果保存到 `~/.tokenless/config.json` 的 `language` 字段；无法识别时使用英文。该偏好同时控制面向用户的 CLI 文案和 provider 的默认回复语言；prompt 中明确指定的语言仍然优先。之后可通过 `tokenless config --language en` 或 `tokenless config --language zh-CN` 修改。

需要 Node.js 22.13+，以及 Chrome、Brave、Edge、Arc 或 Chromium。

## 执行

Setup 完成后，可以直接让 Agent 使用 Tokenless，也可以自己快速测试：

```bash
tokenless run \
  --provider chatgpt \
  --prompt "Review this proposal."
```

不传 `--provider` 时，Tokenless 会选择一个当前可用的 configured provider。显式指定后，Tokenless 只使用该 provider。

Agent 可以发现 canonical outcome catalog，并请求一个或多个已有证据闭环的 capabilities：

```bash
tokenless capabilities list --json

tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review the attached proposal."
```

Tokenless 会合并显式 capability 与结构化输入推导出的要求。普通 run 要求 `conversation.chat`，attachments 要求 `file.upload` 及对应的 media-specific input capability，`--workspace-mode native` 要求 `workspace.native`。Router 会在 configured provider scope 内选择一家能完整满足全部要求的 provider。`research.deep` 等 candidate capabilities 仍会列在 catalog 中，但在完整 provider lifecycle 通过真实 E2E closure 前，会在浏览器 mutation 之前明确失败。

可以使用 `tokenless provider-action --action capability.inspect --provider <provider> --json` 检查某家 provider 当前可用的具体能力。

高级选项和实现细节见 [CLI 命令](COMMANDS.zh-CN.md)、[隐私政策](PRIVACY.md)和[架构](docs/architecture.md)。

## 补充说明

项目目前处于内测阶段。后续计划发布关于 token 节省效果的具体评测数据，供大家参考。

## 已知问题

### Codex 的 sandbox policy 可能阻止 Tokenless 运行

在 Codex 中，Agent 使用的 sandbox policy 可能会阻止 Tokenless 启动浏览器或执行必要的本地操作。在可信环境中，可以将 Codex 设置为 Full Access；也可以在 Codex 弹出授权询问时批准该操作，并选择今后允许相同操作，避免后续重复授权。

## 常见问题

### Tokenless 会完全消除 token 消耗吗？

不会。Tokenless 会把适合的任务分流到 AI provider 的网页版，从而减少 Agent 侧的 token 消耗；Agent 仍需要使用少量 token 来判断分流内容并处理结果。

### 只安装 npm package 就可以使用吗？

不可以。安装后还必须运行 `tokenless setup` 并完成 setup 流程。Tokenless 需要配置好的浏览器 profile 和至少一个可用的 provider 才能执行任务。

### Tokenless 需要 provider API Key 吗？

不需要。Tokenless 使用 provider 的可见网页，而不是 provider API。部分 provider 仍要求登录，实际可用能力取决于你的账号在网页上能够使用的功能。

### Tokenless 会把整个项目发送给 provider 吗？

不会。它只发送委派任务所需的 prompt、选定文件和 task context，不会自动暴露无关的项目文件。

### 每个 provider 都支持所有功能吗？

不支持。Tokenless 只启用已经在各 provider 可见网页上验证过的工作流；不支持或尚未验证的能力会明确报错并停止。

### 为什么 Qwen 有时会报告 `provider_dns_unavailable`？

这个错误表示 Chromium 在发出 HTTP 请求前无法解析 `chat.qwen.ai`。Tokenless 会把 Qwen 的这种情况记录为可重试的疑似 rate limit，因为 provider 边缘节点的间歇性 throttling 是可能原因之一；但同时会明确标记为尚未确认，因为仅凭 DNS 失败无法证明发生了 HTTP rate limit。

请等待一段时间后手动重试命令，并检查当前网络能否解析该 hostname。不要把这类失败计作 provider E2E 通过或 skip，也不要用测试专用 DNS override 作为验收证据。只有 provider 页面上的可见证据，或 `429`、`Retry-After` 等 HTTP 响应，才能确认 rate limit。
