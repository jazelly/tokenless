---
"tokenless": minor
---

Move Tokenless-specific versioned endpoints under `/v1/private/*`, including Harness run control, provider-turn extensions, FeatureBench channels, and authenticated asset readback. Rename the internal shared package to `packages/contracts` without changing provider-turn payload or lifecycle behavior.

将 Tokenless-specific versioned endpoint 统一迁移到 `/v1/private/*`，包括 Harness run control、provider-turn extension、FeatureBench channel 与 authenticated asset readback。内部共享 package 改名为 `packages/contracts`，provider-turn payload 与 lifecycle behavior 保持不变。
