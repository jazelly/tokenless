# Product Localization 收口

Status: completed 2026-08-19 | Priority: P1

Disposition: completed after shared locale primitives, surface-owned CLI/Dashboard catalogs, paired public documentation, generated English/简体中文 API references, packaged CLI verification, full local gates, and configured persistent-browser Dashboard E2E all passed without product behavior regression.

Related: [Tokenless Architecture](../architecture.zh-CN.md)、[Local Web Control Plane](P0-local-web-control-plane.md)

## Outcome

所有 reasonable user-facing surface 同时提供 English 与简体中文，不改变 command、flag、identifier、protocol field、provider/model name 或现有产品行为。

- CLI 与 Dashboard 各自拥有 presentation catalog；
- `packages/shared` 只拥有 supported locale、normalization、fallback 与共同 message interpolation；
- Server 与 Harness 返回 stable error code 和现有 fallback message，不拥有 CLI/Dashboard 文案；
- public Markdown 保持 `.md` / `.zh-CN.md` 配对；
- `packages/contracts/tokenless.openapi.json` 继续是唯一 HTTP structure source，中文 Overlay 只替换 human-readable text，并生成中文 API reference。

## Mission Contract

### Assertions

1. Built CLI 在 `en` 与 `zh-CN` 下显示对应 help、setup/progress 与 representative error。
2. Dashboard 使用持久化 `config.language` 切换全部页面、form、toast、state、error 与 accessibility copy。
3. CLI 与 Dashboard 使用同一 locale normalization/fallback implementation，但不共享 surface-specific copy。
4. Public user documentation 同时存在 English 与简体中文版本；两份内容结构和语义一致。
5. OpenAPI path、schema、operationId 与 example 只有一份 canonical source；English 与中文 reference 都由该 source 生成。
6. 现有 CLI、Dashboard、Server、Harness、HTTP 与 provider behavior 无回退。

### Non-goals

- 翻译 command、flag、identifier、protocol field、provider/model name、code snippet 或 internal log；
- 为内部 evidence、roadmap、AGENTS instruction 或 maintainer-only document 强制生成双语副本；
- 引入第三方 i18n framework、remote translation service、runtime locale negotiation framework 或新的 HTTP field；
- 借 localization 重写 UI、Server error schema、Harness prompt 或 provider implementation；
- 新增 unit test、mock、fake、fixture 或 source/doc regex test。

## Delivery

### Phase 1：Shared locale kernel

- [x] 将 locale type、supported locale、normalization、fallback 与 interpolation 移到 `packages/shared`。
- [x] CLI 与 Dashboard 使用 shared kernel，并保留各自 catalog。
- [x] 删除 Server 对 presentation locale primitive 的 ownership。

### Phase 2：User-facing runtime surfaces

- [x] 收口 CLI catalog 与 representative built CLI English/中文行为。
- [x] 收口 Dashboard catalog，避免 known server error 直接泄漏英文 fallback。
- [x] 通过真实 Dashboard browser flow 验证 language switch 与 representative mutation/error copy。

### Phase 3：Public documentation

- [x] 为缺失的 public Markdown 补齐 `.zh-CN.md` 配对并同步导航。
- [x] 添加中文 OpenAPI Overlay，生成 English 与中文 Scalar reference。
- [x] 保持 `packages/contracts` documentation-only。

### Phase 4：Verification and lifecycle

- [x] 运行 typecheck、API docs check、built CLI、完整 local gate 与 Dashboard browser E2E。
- [x] 审计所有 reasonable user-facing surface，并记录明确不翻译的 internal surface。
- [x] 完成后归档 roadmap 并同步索引。

## Completion Definition

只有当 built CLI、真实 Dashboard browser 与 generated API documentation 都能从用户入口观察到 English/简体中文结果，公开文档配对完成，且现有全量行为 gate 无回退后，本 roadmap 才能归档。
