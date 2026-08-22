# Provider Rate-Limit 知识与 Runtime 策略

最近复核：2026-08-02

## 范围

Tokenless 在 [`packages/cli/catalog/provider-rate-limits.v1.json`](../packages/cli/catalog/provider-rate-limits.v1.json) 中维护目前对 consumer Web provider 限额的最佳认知。该 catalog 不描述 provider API 限额，不会跨浏览器 profile 关联同一个外部账户，也不声称能够复现 provider 的私有执行策略。

一个 managed browser profile 是一个独立的 provider capacity scope。触及真实 provider 限额仍属于可恢复的预期状态。

## 当前 Runtime 知识

| Provider | 保留的官方精确数字规则 | Runtime 解释与剩余不确定性 |
| --- | --- | --- |
| ChatGPT | Go/Plus 的 GPT-5.5 Instant：每 3 小时 160 条消息；Go 手动 Thinking：每 5 小时 10 条消息；已登录上传：每 3 小时 80 个文件；Free 上传：每天 3 个文件 | 动态 Free 消息额度、受限的 Pro/Business 访问、Enterprise/Edu 消息限额、访客限额，以及 provider 原生 model fallback 行为 |
| Claude | 无 | 五小时 session 形态、每周窗口、Pro/Max/Team 相对倍数、动态用量，以及 Enterprise consumption 行为 |
| Gemini | 无 | 五小时和每周窗口形态、付费 plan 相对倍数、基于 compute 的动态用量、Workspace 限额，以及原生 fallback 行为 |
| Grok | 无 | 定性更高限额声明，以及未知的 consumer Web 数字限额 |
| Qwen | 无 | 未知的 consumer Web 数字限额与已发布的使用策略约束 |
| DeepSeek | 无 | 未知的 consumer Web 数字限额；明确排除 API concurrency 数字 |
| Perplexity | Free Pro Search：3 次/天；Enterprise Pro Search：400 次/周；Enterprise Max Pro Search：4000 次/周 | 在 run 能区分 Pro Search 前，精确规则只观察不执行；general/Best mode 行为、consumer 付费每周范围、feature 用量、上传和重度使用降额仍然没有数字 |
| Z.ai / GLM | 无 | 未知的 consumer Web 数字限额；明确排除独立的 GLM Coding Plan quota |
| Doubao / 豆包 | 无 | 未知的已登录 consumer Web 数字限额；明确排除 API 与 enterprise product quota |
| Kimi | 无 | 未知的已登录 consumer Web 数字限额；不会从交互式 usage surface 推断数字 allowance |

Catalog 为每项事实链接官方来源。目前的主要来源是 OpenAI Help、Anthropic Help、Google Gemini Help、xAI pricing、Qwen 使用策略、DeepSeek 用户协议、Perplexity Help、Z.ai GLM 官方公告、豆包功能介绍和 Kimi 官方 Web 入口。只有 catalog 包含 `official_exact` 证据时，精确数字才可执行；relative、dynamic、qualitative、guarded、consumption-based 与 unknown allowance 在 runtime 中都保持为非数字。

## Runtime 解释

Runtime 将当前观察到的 profile subscription label 解析为标准 catalog plan。精确可见 label 优先；`signed_in_free` 可以选择 provider 的 Free family；无法区分的 paid 或 unknown plan 保持 `unknown`，绝不会继承 provider 的最高 allowance。

对于精确规则，Tokenless：

1. 从现有 SQLite `jobs` 表读取不可变的 `provider_submitted_at` facts；
2. 从每个结构化 job request 推导 prompt 与 attachment units；
3. 隔离 provider、profile、model family、mode、action 与匹配窗口；
4. 仅当发布的 allowance 至少为 20 units 时应用 90% 的 planning allowance；
5. 应用带 5% 有界 burst 的 GCRA cadence，并将 burst 限制为 2–8 units；以及
6. 返回 `admit` 或可解释的 `defer`，但不会创建延迟 job。

对于所有非数字或不匹配规则，Tokenless 返回 `unknown` 并允许执行。这样可以保留不确定性，而不虚构 quota。

Provider mutation 前，已知 capacity defer 会在当前 execution 中先消耗经过筛选的自动 provider fallback plan。若没有剩余的 in-scope fallback，请求会清晰失败，不会延迟或重新排队。提交前出现的可见 rate 或 plan blocker 仍然是当前 execution 的失败。已证明或含糊的提交后工作绝不会在其他 provider 或 profile 上 replay。

配置的 provider 列表只充当 filter。其顺序不会改变 capability、subscription、capacity、fairness 或 route selection。

## 已保存事实与诊断

Rate-limit 状态保留在现有 `jobs` 表中：

- `provider_submitted_at` 可为空、不可变，并在可见 prompt 提交成功后立即写入；
- `provider`、`profile_id` 与 `request_json` 保留重建本地用量所需的维度；以及
- `(provider, profile_id, provider_submitted_at)` 支持有界历史查询。

不存在独立的 rate-limit ledger table。

使用以下命令检查下一个 prompt projection：

```sh
tokenless limits inspect --profile <slug> --provider <provider> --json
```

输出包括匹配的 plan、match confidence、catalog revision、适用规则、published 与 effective allowance、本地观察用量、remaining estimate、cadence、burst allowance 和 decision。

## 验证边界

Rate-limit 验收是算法性的。Focused integration test 使用构建后的 CLI、daemon、真实 HTTP boundary、真实 profile registry，以及带受控 timestamp 的真实 SQLite history。它验证 subscription matching、精确和非数字知识、model-pool 隔离、sliding window、remaining capacity、burst cadence、defer time 与 CLI diagnostic。

它不会通过刷 provider 网站来发现或耗尽 quota。真实 provider blocker 是普通 runtime 证据，不是 release test load generator。

## 维护

- 重新检查事实时更新官方来源的 retrieval 与 review 日期。
- 当官方页面不再发布数字时保留不确定性。
- 只有具备官方精确证据时才新增精确数字。
- 在 `runtimePolicy` 下将 runtime policy 参数与 provider facts 分开。
- 每次修改 catalog 或 policy 后，运行 packaged catalog check 与 focused rate-limit simulation。
- 当事实或策略的变化实质改变调度时添加 changeset。
