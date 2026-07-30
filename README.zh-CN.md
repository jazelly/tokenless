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

Tokenless 是一款面向所有 AI 用户、帮助降低 token 消耗的本地工具。它通过智能分流机制，将 Agent 请求中适合的部分转发到网页版 AI 服务处理，从而降低 Agent 侧的 token 消耗。项目目前支持 ChatGPT、Claude、Grok 和 Gemini 四家网页版 AI 服务，并支持在多个服务之间混合使用；Qwen / 千问现作为实验性 Guest-session provider 提供。

## 为什么开发

随着 AI Agent 的应用场景不断增多，消耗的 token 也越来越多，成本压力随之上升。网页版 AI 服务与 Agent 使用的 API 消耗池相互独立，将部分任务分流到网页版处理，可以在不依赖额外 API 额度的情况下降低整体 AI 使用成本。基于这个思路，我们开发了 Tokenless。

## 项目特色

- **智能任务分流**：通过可自定义的 Skill Prompt，用户可以自行设定“什么类型的任务适合交给哪个 AI 处理”，实现灵活、可控的分流策略。
- **多 AI 服务支持**：目前支持 ChatGPT、Claude、Grok、Gemini 四家网页版 AI 服务；Qwen / 千问现作为实验性 Guest-session provider 提供。
- **完全本地运行**：所有自动化流程均在本地执行，不经第三方转发，也不收集用户数据。
- **可恢复的本地 Jobs**：CLI 只在需要时启动 daemon，从 SQLite 发现其实际 loopback 端口，在重启后恢复 lease/checkpoint work，并允许指定 agent 对每个未见 outcome 摘要只 drain 一次，同时保留完整 job result。
- **Provider-neutral 可见工作流**：在真实 provider capability matrix 已证明的范围内统一完成提示词、完整性校验后的文件选择和对话延续。Qwen 的实验性 baseline 还会暴露其 provider-specific modes 以及 Auto/Thinking/Fast reasoning control；当前选定的 Qwen 与 Gemini Guest profile 在重新打开 mapped URL 后都无法恢复上一轮上下文，因此 cross-process continuation 明确保持 unavailable。
- **明确的 Guest 与登录路由**：ChatGPT 和 Gemini 可通过可见 Guest session 执行，实验性 Qwen 集成也支持该路径；Claude 和 Grok 会在 Tokenless 输入任务内容前，将同一个 job handoff 给用户登录。

## 技术栈

- **自动化操作层**：Playwright，用于操作各 AI 服务商的网页版界面
- **命令行工具**：基于 TypeScript 实现的 CLI，作为用户交互入口
- **本地守护进程**：基于 TypeScript 实现的 Daemon，负责本地状态的持久化

## 命令行短选项

Profile 和 provider 使用不同且区分大小写的短选项：

- `-P <slug>` 是 `--profile <slug>` 的短形式。
- `-p <provider>` 是 `--provider <provider>` 的短形式。

例如，`tokenless profiles status -P work -p claude --json` 会检查 `work` profile 中的 Claude 状态。

完整的公开命令清单请参阅 [Tokenless CLI 命令参考](COMMANDS.zh-CN.md)。

## 实验性 Workspace 处理

默认情况下，`--project-name` 仍然只作为 task metadata。显式添加 `--workspace-mode auto` 后，Tokenless 才会请求 provider-neutral Workspace。Claude 和 Grok 会优先使用可见的原生 Project：不存在时按精确名称创建，只有一个精确可见匹配时复用，重名时 fail closed。只有 provider 明确显示原生 Project 稳定不可用时，`auto` 才会 fallback 到 conversation；临时 UI、导航、网络、blocker 或 selector 故障仍然返回错误。使用 `--workspace-mode native` 可禁止 fallback；使用 `--workspace-mode conversation` 可强制使用 conversation strategy。跨进程恢复仍由 capability gate 决定。

原生 Workspace 结果会明确区分 `created`、`reused` 和 `fallback`，包含 canonical resource URL、provider/profile scope，并报告所请求 Project instructions 的处理结果。Tokenless 会按 provider resource ID 将 Project identity 持久化，并在 SQLite 中保存精确的 task conversation mapping，供后续 CLI 进程复用。

运行 `tokenless provider-action --action capability.inspect --provider <provider> --json` 可以检查当前可见 UI 中由 subscription 决定的 capability 状态。在 free、paid、unknown-plan 和 managed-account 的 live matrix 完成前，这些 contract 保持 experimental。

## 实验性 Qwen Modes

Qwen 专属的 composer modes 通过 optional `qwen.mode` capability 暴露，不会伪装成 provider-neutral model 或 effort choice。可以使用 `qwen.mode.inspect` 检查当前可见 modes，也可以在一次 run 中选择 mode：

```bash
tokenless run \
  --provider qwen \
  --qwen-mode "Deep Research" \
  --qwen-mode-variant "Advanced" \
  --prompt "Research this topic and return a cited report." \
  --json
```

当前 mode availability 会在运行时从可见 UI 发现。Disabled entries 会保持 disabled；只有精确选择产生可见的 Qwen mode postcondition 后，Tokenless 才会提交 prompt。Qwen 的 Auto、Thinking 和 Fast selector 仍归入 provider-neutral `effort.choice` capability，并使用 `--effort`。

## 实现要点

- 前端通过 TypeScript 编写的 CLI 暴露给用户使用，本机按需运行的 TypeScript Daemon 负责管理持久化 SQLite 状态。配置 URL 是首选 loopback origin；端口被占用时实际端口可以顺延，并记录到 SQLite。
- 分流逻辑基于 Skill Prompt 实现，用户可以自定义规则，指定不同类型的任务应由哪个 AI 服务处理。
- Playwright 只操作 provider 的可见控件并报告运行时可见的 postcondition。文件上传会区分“已选择”与“provider 已通过可见附件证明接受”，Workspace 请求也会明确返回原生资源或 conversation fallback。
- 单一 typed provider registry 统一记录 identity、navigation、guest、账号 tier、selector 和 capability 策略。每家 provider 都是具体的 `BaseProvider` 子类；独立的 provider-session state machine 根据可见页面证据裁决 guest、account、handoff、wait 或 terminal 结果。
- 整个流程运行在本地，不经过第三方服务转发，也不收集用户的使用数据。

## 补充说明

项目目前处于内测阶段。后续计划发布关于 token 节省效果的具体评测数据，供大家参考。

## 已知问题

### Codex 的 sandbox policy 可能阻止 Tokenless 运行

在 Codex 中，Agent 使用的 sandbox policy 可能会阻止 Tokenless 启动浏览器或执行必要的本地操作。在可信环境中，可以将 Codex 设置为 Full Access；也可以在 Codex 弹出授权询问时批准该操作，并选择今后允许相同操作，避免后续重复授权。
