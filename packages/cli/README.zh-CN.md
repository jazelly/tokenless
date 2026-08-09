# Tokenless CLI

`tokenless` 让 agent 通过本机 CLI 使用你正在运行的 Google Chrome 或 Brave Browser 中可见的 AI 网站。Provider 凭据和浏览器状态始终保留在本机所选浏览器中。

[English](README.md) · [命令参考](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md) · [Capability Matrix](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.zh-CN.md) · [隐私](https://github.com/jazelly/tokenless/blob/main/PRIVACY.zh-CN.md)

## 安装

需要 Node.js 22.13+，以及能提供浏览器自主管理 remote debugging endpoint 的当前版 Google Chrome 或 Brave Browser。Apple Silicon macOS 是当前主要 target；Windows x64 仍处于 prerelease。

```bash
npm install --global tokenless@latest
tokenless setup
tokenless doctor --json
```

在 setup 前，请在日常使用的 Google Chrome 中打开 `chrome://inspect/#remote-debugging`，或在 Brave 中打开 `brave://inspect/#remote-debugging`，启用 remote debugging，并在浏览器出现提示时确认连接。浏览器管理 CDP endpoint，Tokenless 会自动发现；不要使用 `--remote-debugging-port` 或配置固定端口。

Setup 会先询问是否使用 Anti-Detect mode，再让 native-mode 用户选择 Chrome 或 Brave。随后它会创建或选择逻辑 Tokenless profile、连接正在运行的 headed 浏览器、准备 daemon，并对每个已启用 provider 检查一次可见登录状态。Tokenless 不会复制 browser profile，也不会自动登录。

如需非交互式 setup：

```bash
tokenless setup --defaults --json
```

Setup 会创建或复用命名的逻辑 profile，并使用其持久化的 `profiles[slug].enabledProviders`。交互式 setup 可按编号移除 provider。

## 可选 Codex 集成

```bash
tokenless agents install codex
```

重启 Codex，在 `/hooks` 中信任 Tokenless definition，然后继续正常启动 Codex。Tokenless 不提供 Codex wrapper、relay 或自定义 model provider；它只添加可逆的全局 guidance 与 native hooks，用于绑定精确 chat、turn、tool call、本地 project 和 provider conversation。

使用 `tokenless agents status codex --json`、`tokenless agents inspect codex --chat-id <codex-thread-id> --json` 和 `tokenless agents uninstall codex` 进行检查与移除。Harness ledger 只保存有界 ID 与 hash，不保存原始 prompt、transcript、credential 或 browser state。

## 运行

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --prompt "Review this proposal." \
  --json
```

如未显式指定 provider，Tokenless 会使用第一个已配置且有 guest 或 signed-in 观测的 provider；没有可用项时会在创建 job 前失败。

使用 `tokenless capabilities list --json` 查看有证据支持的 task outcome 与 provider route。`--capability` 可重复提供；附件和 workspace intent 也会推导 capability，一个 provider 必须满足合并后的全部要求。

```bash
tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review the attached proposal." \
  --json
```

普通隐式路由会保存兼容的 provider alternatives。在 prompt 提交前遇到 auth、CAPTCHA、capacity 或 plan blocker 时，同一 durable job 可重新排队到下一个满足完整 capability 的 provider；显式 provider、精确 continuation 和不可重建操作会 fail closed。

## Providers

| Provider | 阶段 | 未登录使用 |
| --- | --- | --- |
| ChatGPT | 已支持 | 支持 guest |
| Claude | 已支持 | 需要登录 |
| Gemini | 已支持 | 支持 guest |
| Grok | 已支持 | 需要登录 |
| Qwen / 千问 | 实验性 | 支持 guest |
| DeepSeek | 实验性 | 需要登录 |
| Perplexity | 实验性 | 支持 guest |
| Z.ai / GLM | 实验性 | 支持 guest |
| Doubao / 豆包 | 实验性 | 需要登录 |

Prompt 提交与 response 读取是共同 baseline。File、citation、model/effort control、continuation 和 Workspace 支持取决于 provider、profile 和 account state。不受支持、有歧义或未证明的行为会 fail closed。

## Qwen Modes

Qwen 通过 `qwen.mode.inspect` 和 `qwen.mode.select` 暴露 provider-specific mode：

```bash
tokenless run --provider qwen --qwen-mode "Deep Research" --qwen-mode-variant "Advanced" --prompt "Proceed with a standalone report." --json
```

当前实验性 capability 证明精确 mode selection 和第一个关联的可见 response，尚不声称完整的多轮最终报告 lifecycle。

## Doubao Modes 与 Skills

Doubao 通过 `doubao.mode.inspect/select` 和 `doubao.skill.inspect/select` 暴露精确 controls。稳定的英文 action payload 选择中文可见 label，每次选择都需要可见 selected-state postcondition。完整 generation/research lifecycle 通过独立 real-provider gate 前仍为 candidate。

## Workspaces

如未提供 `--workspace-mode`，`--project-name` 仅是 task metadata。

- `auto` 优先使用已证明的 native Project，只在可见证据表明不可用时 fallback。
- `native` 需要精确创建或复用 native Project。
- `conversation` 需要 conversation strategy。

Claude 和 Grok 的 native Project 行为已有实验性 gate，但在完整 gate 通过前不会将 `workspace.native` 广告为 router route。

## Managed Profiles

一个 managed profile 可保持所有已启用 provider 的 session。如需同一 provider 的多个 account，请使用不同 profile。

```bash
tokenless profiles list --json
tokenless profiles open --profile work
tokenless profiles open --profile work --provider claude
tokenless profiles status --profile work --provider claude --json
```

Tokenless profile 只组织 provider tab 与配置，不创建独立 browser identity。Tokenless 不检查或暴露 cookie、token、browser storage、Keychain data 或 authentication value。

## Browser 与本地 Runtime

Native mode 只支持 headed，因为它控制用户已打开的 Chrome 或 Brave。停止或重启 daemon 只会断开 Playwright，不会关闭所选浏览器。

每个请求都使用经过认证的 loopback daemon 和所选浏览器中的 Tokenless-owned tab。凭据对 agent 保持 opaque；登录、CAPTCHA、同意、付款、plan 和确认步骤始终由用户控制。

所有命令和 option 见[命令参考](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md)；完整 capability 语义见 [Capability Matrix](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.zh-CN.md)。
