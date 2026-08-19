---
"tokenless": minor
---

Move every non-compatibility bearer-authenticated Tokenless machine endpoint under `/v1/private/*`. Make `packages/contracts` a documentation-only OpenAPI source with one generated reference, and move runtime primitives and the provider-turn Client Adapter to their owning packages without changing payload, lifecycle, Dashboard, CLI, Harness, or provider behavior.

将所有非 compatibility 的 bearer-authenticated Tokenless machine endpoint 统一迁移到 `/v1/private/*`。`packages/contracts` 收纯为 documentation-only OpenAPI source 与单一 generated reference，runtime primitive 和 provider-turn Client Adapter 回到各自 owner package；payload、lifecycle、Dashboard、CLI、Harness 与 provider behavior 保持不变。
