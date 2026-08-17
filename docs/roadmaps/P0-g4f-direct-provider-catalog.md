# G4F Direct Provider Catalog

Status: active | Priority: P0

Related: [Web AI → API: Provider Direct Protocol](P0-direct-provider-protocol.md), [Provider Expansion and Parity](P0-provider-expansion.md), and [Local Web Control Plane](P0-local-web-control-plane.md)

## Goal

将固定 G4F `8.1.2` inventory 中的 working adapter 按厂商合并为 42 个 Tokenless provider。复用已有 provider identity，只新增缺失的 32 个，并在 dashboard 中明确区分 `Browser` 与 `Direct` mode。

## Non-goals

- 不为新 provider 实现 DOM selector 或 browser workflow。
- 不区分 free、paid、API、account 或 session 变体。
- 不为 42 个 upstream 分别增加 retry、fallback 或独立 adapter framework。
- 不声称未经真实 endpoint 验收的 provider 已达到 capability parity。

## V1 Boundary

完成一条最小端到端路径：用户可以在 dashboard 看到现有 13 个 provider 加上 32 个缺失厂商，共 45 个不重复 provider；其中 G4F direct 子集恰好是 42 个厂商。列表用 badge 区分 Browser 与 Direct 的支持和启用状态，Detail 可按 profile opt out 任一支持的 execution mode；新增 provider 可通过现有 G4F direct router 解析到一个精确 upstream provider。Browser 对接、高级 capability 与逐 provider 真实验收留待后续。

## Assertions

- `VAL-001`: G4F direct catalog 恰好暴露 42 个厂商级 provider；现有 ChatGPT、Claude、Gemini、Grok、Qwen、DeepSeek、Perplexity、Z.ai、Arena 和 Meta AI identity 被复用，只新增 32 个。Dashboard 保留不在 G4F 基线中的 Doubao、Kimi 和 Dola，因此总数为 45，没有复制项。
- `VAL-002`: 每个 provider 都显式暴露 `browser | direct` mode；新增的 32 个只暴露 `direct`。
- `VAL-003`: 42 个 provider 都能解析为一个精确 G4F upstream adapter，不使用 `AnyProvider` 或隐式 fallback。
- `VAL-004`: direct-only provider 不会创建 browser readiness/control/open job，也不会为 guest direct request 隐式打开 provider 页面。
- `VAL-005`: dashboard 英文与简体中文均显示 execution mode badge；detail 为 Browser 与 Direct 提供 profile-scoped toggle，未支持的 mode 明确禁用；direct-only detail 不显示 browser account、DOM control 或 browser routing form。
- `VAL-006`: 现有 browser provider 行为和已有 G4F streaming 工作区改动保持不变。

## Evidence

- CLI TypeScript build 与 dashboard build。
- 通过 daemon/application 真实本地边界的聚焦 integration test，验证 catalog、mode 和 direct-only browser rejection。
- 通过固定 G4F service inventory 边界验证所有 canonical upstream adapter 存在。
- 本地 dashboard E2E 验证 direct-only provider 的列表和 detail 可见结果。

## Constraints

- 以固定 `g4f[all]==8.1.2` 为唯一 inventory 基线，不跟随 latest docs 漂移。
- 用英文编写代码、identifier 和项目内部技术内容；所有用户可见文案同时提供 English 和简体中文。
- 不使用 provider fixture、mock、fake 或模拟 upstream response。
- 保留当前 dirty worktree 中的用户改动。

## Complexity Admission

新增一个共享 direct-only provider 实现和一个 execution-mode catalog，因为 `VAL-001`、`VAL-002` 与 `VAL-004` 无法在当前纯 DOM registry 中通过。不增加每 provider 子类、fallback 层或历史兼容路径。

## Stop Condition

六条 assertion 均有通过证据且独立 reviewer 批准后完成。若固定 runtime 不包含某个 canonical adapter，或必须扩大为 DOM/provider capability 实现，停止并报告具体差异。
