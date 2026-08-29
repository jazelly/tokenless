# Tokenless CLI

`tokenless` 目前让 agent 通过本机 CLI 使用你正在运行的 Google Chrome 或 Brave Browser 中可见的 AI 网站。在该 visible-browser mode 中，provider 凭据和浏览器状态保留在本机所选浏览器中。

[English](README.md) · [命令参考](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md) · [Capability Matrix](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.zh-CN.md) · [隐私](https://github.com/jazelly/tokenless/blob/main/PRIVACY.zh-CN.md)

## 安装

Browser 功能需要 Node.js 22.13+，以及能提供浏览器自主管理 remote debugging endpoint 的当前版 Google Chrome 或 Brave Browser。Apple Silicon macOS 是当前主要 target；Windows x64 仍处于 prerelease。

Chrome 与 Brave 必须由用户自行提供；Tokenless 不会 bundle 或下载它们。Setup 找不到所选浏览器时仍会保存配置、跳过 provider 检查，并在结束时提示如何添加 executable path。首次 browser action 会验证该 path，或再次尝试标准 discovery。在 setup 过程中，CloakBrowser 是 Tokenless 唯一会下载并准备的 browser runtime。

```bash
npm install --global tokenless@latest
tokenless setup
tokenless doctor --json
```

在使用 browser 功能前，请在日常使用的 Google Chrome 中打开 `chrome://inspect/#remote-debugging`，或在 Brave 中打开 `brave://inspect/#remote-debugging`，启用 remote debugging，并在浏览器出现提示时确认连接。

Setup 会先询问是否使用 Anti-Detect mode，再让 native-mode 用户选择 Chrome 或 Brave。Browser discovery 失败时 setup 仍会完成并提示添加 executable path；在 browser access 可用前不会运行 provider 检查。

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

Codex hooks 不会替换 native subagent execution。Codex workflow 需要显式委托 Tokenless Harness-owned child 时，请使用 `tokenless agent delegate --workspace-root "$PWD" ...`。

使用 internal Codex sub-agent 不会隐藏 Codex UI delegation messages；Tokenless 不能控制 Codex UI，也不能控制 native `spawn_agent` 的行为。只有在用户明确要求 separate tasks，或明确需要 independently visible progress 时，sidebar-visible 的 worker/reviewer 工作才使用 separate Codex tasks；主 task 读取 status 并给出简短 synthesis。不要重复粘贴长 child report：报告只包含 child name、status、at most one blocker 和 coordinator decision。

## DeepSeek Harness Subagent 集成

```bash
tokenless agents install dsh --provider chatgpt --profile default --dsh-profile headless --json
```

该命令注册一个 DeepSeek Harness `SubagentProvider`，并把它的普通 one-shot `subagent` tool 路由到 Tokenless Harness。它与 model base URL 路径彼此独立；后者继续使用 DeepSeek Harness 现有的 `llm-deepseek` adapter。

## 运行

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --prompt "Review this proposal." \
  --json
```

使用 setup 管理的 GPT4Free backend 完成一次 ChatGPT direct 文本聊天：

```bash
tokenless run \
  --profile default \
  --provider chatgpt \
  --execution-mode direct \
  --provider-backend g4f \
  --prompt "Review this proposal." \
  --json
```

使用 `--provider-backend native` 可保留现有 Tokenless ChatGPT 或 Perplexity 实现，用于 A/B 测试和回切。

Setup 会安装一个固定版本的私有 `g4f[all]` Python service。Tokenless 继续拥有 browser control 与 profile；G4F 在 authenticated daemon API 后处理 direct provider HTTP、impersonation、Sentinel/PoW、streaming、HAR/Cookie auth 与 media。不传 `--execution-mode direct` 时保持 visible-browser 行为。

Backend flag、标准 API route、provider mapping、版本固定与隔离边界见 [GPT4Free direct provider service](../../docs/g4f-direct-provider-service.zh-CN.md)。

如未显式指定 provider，Tokenless 会使用第一个已配置且有 guest 或 signed-in 观测的 provider；没有可用项时会在创建 job 前失败。

使用 `tokenless capabilities list --json` 查看有证据支持的 task outcome 与 provider route。`--capability` 可重复提供；附件和 workspace intent 也会推导 capability，一个 provider 必须满足合并后的全部要求。

```bash
tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review the attached proposal." \
  --json
```

普通隐式路由会为当前 execution 保留兼容的 provider alternatives。在 prompt 提交前遇到 auth、CAPTCHA、capacity 或 plan blocker 时，会立即尝试下一个满足完整 capability 的 provider；显式 provider、精确 continuation 和不可重建操作会 fail closed。

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
| Kimi | 实验性 | 需要登录 |
| Dola | 实验性 | 需要登录 |
| Arena | 已支持 | 需要登录 |
| Meta AI | 实验性 | 需要登录 |

Prompt 提交与 response 读取是共同 baseline。File、citation、model/effort control、continuation 和 Workspace 支持取决于 provider、profile 和 account state。Meta AI 的 chat 与 file upload 已可从选定的登录 profile 实验性路由，并支持 Instant/Thinking 选择；在 CLI 暴露图片 artifact lifecycle 前，image generation 仍不公开。

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

Tokenless profile 只组织 provider tab 与配置，不创建独立 browser identity。当前已发布的 visible-browser mode 不检查单个 cookie、token、browser storage、Keychain data 或 authentication value；任何 mode 都不会把这些值暴露给 agent。

## Browser 与本地 Runtime

Native mode 只支持 headed，因为它控制用户已打开的 Chrome 或 Brave。停止或重启 daemon 只会断开 Playwright，不会关闭所选浏览器。

每个 visible-browser 请求都使用经过认证的 loopback daemon 和所选浏览器中的 Tokenless-owned tab。Provider 凭据绝不会暴露给 agent；登录、CAPTCHA、付款、plan 以及含义不明确或涉及外部授权的确认始终由用户控制。对于用户已选择的 provider，provider adapter 可以接受内容明确且已知的 onboarding Terms/Privacy 对话框。

所有命令和 option 见[命令参考](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md)；完整 capability 语义见 [Capability Matrix](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.zh-CN.md)。
