# GitHub Copilot 网页控制

[English](github-copilot.md)

GitHub Copilot 使用选定的 Tokenless API 浏览器 profile 及其中已登录的 GitHub 账户。适配器处于实验阶段；能力与模型权限以当前可见页面为准。

## 查看与选择

```bash
tokenless provider-controls --provider github-copilot --json
tokenless provider-configure --provider github-copilot --copilot-mode ask --copilot-repo owner/repo --model "GPT-5.6 Luna" --json
```

| 控制 | 返回信息 | 选择方式 |
| --- | --- | --- |
| 模式 | Ask、Agent 及当前选中状态 | `--copilot-mode ask\|agent` |
| Repository | 当前可见 repository 及选中状态；精确选择时搜索 picker | `--copilot-repo owner/repo` |
| 模型 | 精确 label、`selected`、`enabled`，以及锁定选项中观察到的 `requiredPlan` / `description` | `--model "exact label"` |
| Reasoning | 当前 Agent 模型提供的选项 | `--effort "exact label"` |
| 用量 | 账户 AI credits 和预算；页面可见时返回最新回复的输入／输出 tokens 和 AI credits | 只读 |

Ask 与 Agent 的模型列表不同。禁用的 Pro+ 或 Max 模型仍会出现在查看结果中，但不能被选中；适配器不根据静态套餐表推测权限。

账户仪表提供 **AI credits**、剩余额度、页面显示的重置日期和额外 USD 预算。每条回复还可能提供实际的**输入 tokens**、**输出 tokens**及该条回复的 AI credits 消耗。

`github-copilot.usage.inspect` 返回账户计数与可为 null 的 `latestMessage`；`response.read.usage` 在可观测时返回该回复的计数。历史页面可能不再显示单条回复用量。适配器保留原始单位和观察时间；查看用量不会修改计费设置。

## Repository 作为 Project

```bash
tokenless run --provider github-copilot --workspace-mode native --project-name owner/repo --model "GPT-5.6 Luna" --prompt "Explain the root package.json in this repository." --json
```

`workspace.ensure` 选择已有 repository，并将其作为原生 Project identity 返回，同时提供 GitHub repository 的规范 URL。Repository instructions 继续在 Git 中管理。

## GitHub 云端 Agent

```bash
tokenless run --provider github-copilot --copilot-mode agent --workspace-mode native --project-name owner/repo --model "GPT-5.6 Luna" --prompt "Inspect the repository and explain its test command. Do not modify files." --json
```

Agent 使用页面显示的 repository 和 branch 创建 GitHub 云端 session。适配器跟随本次新建的 session，等待完成，再返回回答、可见工具步骤名称、session URL 和观察到的 session AI credits。

Agent 委派要求项目上下文已存在于 GitHub，且 Copilot 能够访问。`tokenless agent run` 和 `tokenless agent delegate` 会将 GitHub Copilot 任务直接交给原生云端 Agent，不进入 Tokenless Harness 工具循环。

```bash
tokenless agent delegate --provider github-copilot --profile <profile> --copilot-repo owner/repo --prompt "Inspect the repository and explain its test command. Do not modify files." --json
```

也可以使用 `agent delegate --workspace-root <path>`，从 checkout 的 GitHub `origin` 获取候选 repository。提交前必须在 Copilot 自己的 picker 中选中精确 repository；仅有本地 remote URL 不代表可以访问。两个命令都会等待完成并返回现有 provider job 结果，包括原生 Agent session URL 和反馈。

云端 Agent 使用 GitHub 页面显示的 repository 和 branch，不同步本地文件或未推送改动。缺少 GitHub 上下文或 repository 不可访问时，Agent Task 会被阻止；不会创建 repository，也不会改用 Ask 工具循环。这条路径不支持本地 Harness skills、MCP tools、turn limits 或 benchmark tool channels。

GitHub Copilot 不参与 Harness 附件路由，包括自动路由。Ask 文本和文件请求仍可通过 `tokenless run` 使用。

委派入口处于实验阶段，仍待新的真实 provider 验收：9 月 10 日的检查在提交前报 `provider_surface_not_ready`。此前 Ask 附件验收不能证明原生 Agent 委派通过。

## 单项 Action

使用 `tokenless provider-action --provider github-copilot --action <action> --json`：

| Action | Payload / CLI option |
| --- | --- |
| `github-copilot.mode.inspect` | 空 |
| `github-copilot.mode.select` | `{"mode":"ask"}` / `--copilot-mode ask` |
| `github-copilot.repository.inspect` | 空 |
| `github-copilot.repository.select` | `{"label":"owner/repo"}` / `--copilot-repo owner/repo` |
| `github-copilot.usage.inspect` | 空 |

已有的 `model.inspect/select`、`effort.inspect/select`、`workspace.ensure`、`file.upload` 和 conversation actions 也使用同一真实浏览器边界。

## 文件验证

最初验收覆盖 TXT 内容读取、Markdown 选择，以及 GPT-5.6 Luna 完整的两轮 Harness Markdown／工具结果往返。新增的 focused file-input case 在同一次真实请求中检查 TXT、Markdown、JSON、CSV、TypeScript 和 PNG 内容。

Ask picker 声明支持 text/code 和 image 扩展名。Agent 图片 picker 接受 PNG、JPEG、GIF 和 WebP；独立的 Agent image 用例检查 PNG 内容读取。适配器在填入任务提示词时保留已上传图片的链接。Picker 中可选不代表每种扩展名都已通过语义验收；这些用例不声称支持 PDF、Office、audio 或 video。

官方参考：[GitHub.com chat](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/chat-in-github)、[查看 AI credits](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage)。

专项真实 provider 用例为 `github-copilot-controls`、`github-copilot-repository`、`github-copilot-agent`、`github-copilot-agent-image` 和 `github-copilot-file-inputs`。它们使用构建后的 CLI、打包 daemon 和配置中的持久 profile；文件内容用例同时检查实际输入／输出 token 计数。GitHub Copilot 的旧 `harness-attachment-roundtrip` 用例已退役，仅保留为历史证据。
