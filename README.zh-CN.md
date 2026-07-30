<p align="center">
  <img src="assets/tokenless-wordmark.png" alt="Tokenless" width="560">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/v/tokenless?logo=npm&amp;label=version" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/dm/tokenless?logo=npm&amp;label=downloads" alt="npm 月下载量"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="COMMANDS.zh-CN.md">命令大全</a> · <a href="docs/roadmaps/README.md">Roadmaps</a>
</p>

## Tokenless 能做什么

Tokenless 让 AI Agent 把任务直接交给 ChatGPT、Claude、Gemini、Grok 和 Qwen 的网页版处理，从而减少 Agent 侧 token 消耗，也不需要配置这些服务的 API Key。

它不只是把 prompt 填进网页。Tokenless 会把各家 provider 真正提供的网页工作流适配成一个供 Agent 使用的本地接口：

- 发送 prompt，并读取回复和引用；
- 通过 provider 自己的控件上传文件；
- 使用页面上可见的模型、推理等级和 provider 专属模式；
- 创建或复用 Projects，并将每个任务限定在正确的 profile、Project 和对话中；以及
- 传递选定的项目文件和单轮上下文，不暴露无关文件。

只有经过 Tokenless 可见验证的 provider 工作流才会启用。未支持或尚未证明的行为会明确报错，不会猜测执行。Provider 登录信息、浏览器状态和 job 数据都保留在用户本机。

| Provider | 状态 | 是否需要登录 |
| --- | --- | --- |
| ChatGPT | 可用 | 不需要 |
| Claude | 可用 | 需要 |
| Gemini | 可用 | 不需要 |
| Grok | 可用 | 需要 |
| Qwen / 千问 | Beta | 不需要 |

## 安装与初始化

```bash
npm install --global tokenless@latest
tokenless setup
```

需要 Node.js 22.13+，以及 Chrome、Brave、Edge、Arc 或 Chromium。`tokenless setup` 会准备本地运行环境，创建或导入浏览器 profile，并检查所有已启用的 providers。

## 执行

Setup 完成后，可以直接让 Agent 使用 Tokenless，也可以自己快速测试：

```bash
tokenless run \
  --provider chatgpt \
  --prompt "Review this proposal."
```

不传 `--provider` 时，Tokenless 会选择一个当前可用的 configured provider。显式指定后，Tokenless 只使用该 provider。

可以使用 `tokenless provider-action --action capability.inspect --provider <provider> --json` 检查某家 provider 当前可用的具体能力。

高级选项和实现细节见 [CLI 命令](COMMANDS.zh-CN.md)、[隐私政策](PRIVACY.md)和[架构](docs/architecture.md)。

## 补充说明

项目目前处于内测阶段。后续计划发布关于 token 节省效果的具体评测数据，供大家参考。

## 已知问题

### Codex 的 sandbox policy 可能阻止 Tokenless 运行

在 Codex 中，Agent 使用的 sandbox policy 可能会阻止 Tokenless 启动浏览器或执行必要的本地操作。在可信环境中，可以将 Codex 设置为 Full Access；也可以在 Codex 弹出授权询问时批准该操作，并选择今后允许相同操作，避免后续重复授权。
