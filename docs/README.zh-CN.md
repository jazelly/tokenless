# Tokenless 文档

本索引将用户指南、稳定产品契约、implementation architecture、provider research 与未来 roadmap 分开，使每份文档只有一个明确职责。

## 从这里开始

- [README](../README.zh-CN.md) — 产品概览、安装与首次运行。
- [CLI 命令](../COMMANDS.zh-CN.md) — 完整 command 与 option reference。
- [Capability Matrix](capability-matrix.zh-CN.md) — canonical outcomes、当前 provider mappings、support states 与扩展规则。
- [API Proxy 接入指南](api-proxy-integration.zh-CN.md) — 从既有项目调用 OpenAI/Anthropic 兼容的本地 proxy。
- [HTTP API 参考](../packages/contracts/reference.zh-CN.html) — 生成的 OpenAI-compatible、Anthropic-compatible、private、Dashboard 与 readiness interface。
- [Provider 访客访问](../PROVIDER_GUEST_ACCESS.zh-CN.md) — 已观察的登出行为与认证路由规则。
- [Provider Rate Limits](provider-rate-limits.zh-CN.md) — 官方 Web provider 限额知识与 runtime 策略。
- [Provider Tool-Calling Conformance 参考](provider-tool-calling-conformance.zh-CN.md) — 当前官方 provider contract、canonical mapping 与 Tokenless evidence 边界。
- [隐私政策](../PRIVACY.zh-CN.md) — browser profile、credential、file 与本地数据边界。

## 概念与架构

- [架构](architecture.zh-CN.md) — 稳定的两层设计：Universal API、Web Agent Harness、provider runtime、ownership 与 trust boundary。
- [术语表](glossary.zh-CN.md) — Harness model role、execution、authentication 与 direct provider 的标准术语。
- [Provider Capability Census](provider-capability-census.zh-CN.md) — provider 产品调研与 evidence gaps；不代表 support 声明。
- [Roadmaps](roadmaps/README.md) — active、backlog 与 archived delivery plans。

## Provider 与 Capability 开发

- 从 [Capability Matrix 扩展流程](capability-matrix.zh-CN.md#新增-capability) 开始。
- Provider 行为只能通过配置好的浏览器 profile 在真实 provider 网站上开发与验证。
- 在 [`live-provider-capability-matrix.json`](../test/live-provider-capability-matrix.json) 声明必需的真实 provider cases。
- 在 [`live-managed-playwright.e2e.mjs`](../test/live-managed-playwright.e2e.mjs) 实现真实 journeys。
- Provider-specific behavior 应保留在 [`packages/server/src/providers/`](../packages/server/src/providers/) 中。

## 新增文档

- 不要提交大段文字墙：保持段落简短；如果项目符号、表格、图示或截图能更快表达同一信息，就使用它们。
- Root README 应保持为便于浏览的 landing page；详细说明应放进负责该主题的专门文档，并从 README 链接过去。
- 安装与首次运行指南放在配对的 root README 中。
- 稳定的用户与开发者契约放在 `docs/` 下，并从本索引链接。
- 完整 CLI syntax 放在配对的 `COMMANDS` reference 中，避免在不同 guide 重复维护。
- 产品调研保留在 capability census；观察到产品功能不代表 Tokenless support 声明。
- 计划工作、执行顺序与未完成 acceptance criteria 放在 `docs/roadmaps/`；目录位置定义 roadmap lifecycle。
- 每份合理的 user-facing document 都要提供英文与简体中文版本，保持结构和语义对齐，并在同一次 change 中更新本索引。
- 优先链接到单一 source of truth，不复制大表。如果需要简短的 user-facing summary，要明确哪个 runtime output 或 source file 才是权威来源。

## 语言

User-facing documentation 同时维护英文和简体中文。中文使用对应的 `*.zh-CN.md`；当翻译无法增加用户价值时，内部技术记录可以只保留英文。
