[中文](README.zh-CN.md) | [English](README.md)

# Tokenless

## 项目简介

Tokenless 是一款面向所有 AI 用户、帮助降低 token 消耗的本地工具。它通过智能分流机制，将 Agent 请求中适合的部分转发到网页版 AI 服务处理，从而降低 Agent 侧的 token 消耗。项目目前支持 ChatGPT、Claude、Grok 和 Gemini 四家网页版 AI 服务，并支持在多个服务之间混合使用。

## 为什么开发

随着 AI Agent 的应用场景不断增多，消耗的 token 也越来越多，成本压力随之上升。网页版 AI 服务与 Agent 使用的 API 消耗池相互独立，将部分任务分流到网页版处理，可以在不依赖额外 API 额度的情况下降低整体 AI 使用成本。基于这个思路，我们开发了 Tokenless。

## 项目特色

- **智能任务分流**：通过可自定义的 Skill Prompt，用户可以自行设定“什么类型的任务适合交给哪个 AI 处理”，实现灵活、可控的分流策略。
- **多 AI 服务支持**：目前支持 ChatGPT、Claude、Grok、Gemini 四家网页版 AI 服务，且支持混合使用。
- **完全本地运行**：所有自动化流程均在本地执行，不经第三方转发，也不收集用户数据。
- **Provider-neutral 可见工作流**：在四家 provider 中统一完成提示词、完整性校验后的文件选择和对话延续。实验性的 capability 检查与 Workspace 能力会明确展示 subscription 对原生能力和 fallback 的影响。

## 技术栈

- **自动化操作层**：Playwright，用于操作各 AI 服务商的网页版界面
- **命令行工具**：基于 TypeScript 实现的 CLI，作为用户交互入口
- **本地守护进程**：基于 Rust 实现的 Daemon，负责本地状态的持久化

## 命令行短选项

Profile 和 provider 使用不同且区分大小写的短选项：

- `-P <slug>` 是 `--profile <slug>` 的短形式。
- `-p <provider>` 是 `--provider <provider>` 的短形式。

例如，`tokenless profiles status -P work -p claude --json` 会检查 `work` profile 中的 Claude 状态。

## 实验性 Workspace 处理

默认情况下，`--project-name` 仍然只作为 task metadata。显式添加 `--workspace-mode auto` 后，Tokenless 才会请求 provider-neutral Workspace：仅在 fixture 已完整证明时使用原生 Project，否则明确返回 conversation-scoped fallback。使用 `--workspace-mode native` 可禁止 fallback；使用 `--workspace-mode conversation` 可强制复用对话。

运行 `tokenless provider-action --action capability.inspect --provider <provider> --json` 可以检查当前可见 UI 中由 subscription 决定的 capability 状态。在 free、paid、unknown-plan 和 managed-account 的 live matrix 完成前，这些 contract 保持 experimental。

## 实现要点

- 前端通过 TypeScript 编写的 CLI 暴露给用户使用，本机由 Rust 编写的 Daemon 负责持久化运行与状态管理。
- 分流逻辑基于 Skill Prompt 实现，用户可以自定义规则，指定不同类型的任务应由哪个 AI 服务处理。
- Playwright 只操作 provider 的可见控件并报告 fixture 已证明的 postcondition。文件上传会区分“已选择”与“provider 已通过可见附件证明接受”，Workspace 请求也会明确返回原生资源或 conversation fallback。
- 整个流程运行在本地，不经过第三方服务转发，也不收集用户的使用数据。

## 补充说明

项目目前处于内测阶段。后续计划发布关于 token 节省效果的具体评测数据，供大家参考。
