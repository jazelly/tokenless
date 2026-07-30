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

## 项目简介

Tokenless 是一个本地 CLI，让 Agent 通过 managed Playwright browser profiles 使用可见的 AI 网页服务。它把适合的工作分流到 web session，从而降低 Agent 侧 token 消耗；provider credentials、browser state、daemon state 和 job results 都保留在用户本机。

| Provider | 阶段 | 未登录使用 |
| --- | --- | --- |
| ChatGPT | Supported | 支持 Guest |
| Claude | Supported | 需要登录 |
| Gemini | Supported | 支持 Guest |
| Grok | Supported | 需要登录 |
| Qwen / 千问 | Experimental | 支持 Guest |

## 安装与初始化

```bash
npm install --global tokenless@latest
tokenless setup
tokenless doctor --json
```

`tokenless setup` 会安装所需 agent skills，将本地 daemon 对齐到已安装 CLI 版本，选择 supported Chromium browser，创建或导入 managed profile，并对所有 enabled providers 各检查一次。Clean path 为：

```bash
tokenless setup --fresh --json
```

Fresh setup 会创建或复用 `default` profile，选择 registry stage 不为 `disabled` 的每一家 provider（包括 Qwen），并只报告一次 sign-in state。它不会打开 sign-in handoff。

## 执行

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --prompt "Review this proposal." \
  --json
```

没有显式 provider 时，Tokenless 会选择第一个已有 Guest 或登录缓存记录的 configured provider。如果没有可用 provider，它会在创建 job 前失败。显式 provider 不会被静默替换。

## 当前能力

- Tokenless 通过 authenticated loopback daemon 和 persistent managed browser profiles 在本地运行。
- Runtime actions 只操作可见 provider 页面和可见 postconditions。Unsupported 或尚未证明的行为会 fail closed。
- ChatGPT 和 Gemini 可以通过可见 Guest sessions 运行。Experimental Qwen 也可通过其 Guest path 运行。Claude 和 Grok 会在输入 task content 前要求登录。
- File upload、citations、model 或 effort controls、Workspace handling 和 conversation continuation 都是 provider/profile-specific runtime capabilities，不是 blanket promises。可用 `tokenless provider-action --action capability.inspect --provider <provider> --json` 检查。
- 默认情况下，`--project-name` 只是 task metadata；只有传入 `--workspace-mode` 时才请求 Workspace。Workspace behavior 仍为 experimental，并在已证明时报告 native `created`/`reused` 或 conversation `fallback`。

## 实验性 Qwen Modes

Qwen 专属的 composer modes 通过 optional `qwen.mode` capability 暴露。可以使用 `qwen.mode.inspect` 检查当前可见 modes，也可以在一次 run 中选择 mode：

```bash
tokenless run \
  --provider qwen \
  --qwen-mode "Deep Research" \
  --qwen-mode-variant "Advanced" \
  --prompt "Proceed with a standalone report on this topic; use official sources and do not compare competitors." \
  --json
```

该 experimental capability 证明 exact mode selection 和第一条关联的可见 response；目前尚未声称完成 Qwen 的完整 multi-turn final-report lifecycle。Auto、Thinking 和 Fast 仍是通过 `--effort` 选择的 effort choices。

详细信息见 [CLI 命令](COMMANDS.zh-CN.md)、[隐私政策](PRIVACY.md)和[架构](docs/architecture.md)。

## 补充说明

项目目前处于内测阶段。后续计划发布关于 token 节省效果的具体评测数据，供大家参考。

## 已知问题

### Codex 的 sandbox policy 可能阻止 Tokenless 运行

在 Codex 中，Agent 使用的 sandbox policy 可能会阻止 Tokenless 启动浏览器或执行必要的本地操作。在可信环境中，可以将 Codex 设置为 Full Access；也可以在 Codex 弹出授权询问时批准该操作，并选择今后允许相同操作，避免后续重复授权。
