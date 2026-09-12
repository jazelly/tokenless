# Provider Rate-Limit 知识与 Runtime 策略

最近复核：2026-08-02

## 范围

Tokenless API 在 [`packages/server/catalog/provider-rate-limits.v1.json`](../packages/server/catalog/provider-rate-limits.v1.json) 中维护目前对 consumer Web provider 限额的最佳认知。该 catalog 不描述 provider API 限额，不会跨浏览器 profile 关联同一个外部账户，也不声称能够复现 provider 的私有执行策略。

官方额度估算按 profile 隔离。内部规则明确选择所有本机 profile 共用或各 profile 独立计数，不推断外部账号身份。

## Dashboard 规则表

在 Tokenless API Dashboard 打开**限流规则**，按 provider、请求类型和执行状态筛选目录。每行显示套餐与模型范围、额度、窗口、计数操作和带日期的来源；消息、图片生成及文件上传的缺失规则会明确标为未知。

内部规则只有一个事实来源：持久化 `config.json` → 额度计算与原子准入 → Router 和 Dashboard。Dashboard 使用与准入相同的算法显示当前用量、剩余额度和下次可用时间。官方来源日期保持不变；内部配置不代表 provider 官方额度。

在 Dashboard 点击**添加内部规则**或**编辑规则**，选择 provider、请求类型、范围、窗口秒数与最大尝试次数并保存。现有 `PATCH /dashboard-api/v1/config` 也支持完整的 `rateLimits` 数组；保存后下一次检查立即生效，无需重新构建，也不会清空用量。

```json
{
  "rateLimits": [
    { "id": "chatgpt.hour", "provider": "chatgpt", "requestType": "submission", "scope": "provider", "windowSeconds": 3600, "maxRequests": 20 },
    { "id": "chatgpt.ten-minutes", "provider": "chatgpt", "requestType": "submission", "scope": "provider", "windowSeconds": 600, "maxRequests": 10 }
  ]
}
```

操作必须同时满足所有匹配规则。`submission` 统计文字及图片 prompt 尝试；`message` 与 `image` 分别限定一种类型；`file` 统计上传操作（一个批次为一次操作）。`provider` 在本机所有 profile、所有模型间共用额度；`profile` 按 profile 分别计数。规则覆盖 Tokenless API 的 browser 执行，不覆盖 direct mode、手动网页使用或每个底层 HTTP 请求。

内部规则使用精确滑动窗口 `(now - window, now]`，没有额外百分比折扣或突发额度。在提交或上传前，SQLite 事务将额度检查与一次尝试计数一起完成。失败尝试保留计数；未获准的操作不占额度。修改规则及进程重启均保留用量。

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

对于官方精确规则，Tokenless API：

1. 从现有 SQLite `jobs` 表读取不可变的 `provider_submitted_at` facts；
2. 从每个结构化 job request 推导 prompt 与 attachment units；
3. 隔离 provider、profile、model family、mode、action 与匹配窗口；
4. 仅当发布的 allowance 至少为 20 units 时应用 90% 的 planning allowance；
5. 应用带 5% 有界 burst 的 GCRA cadence，并将 burst 限制为 2–8 units；以及
6. 返回 `admit` 或可解释的 `defer`，但不会创建延迟 job。

非数字或不匹配的官方规则返回 `unknown`；已配置的内部规则仍然生效。这样可以保留不确定性，而不虚构 quota。

Provider mutation 前，已知 capacity defer 会在当前 execution 中先消耗经过筛选的自动 provider fallback plan。若没有剩余的 in-scope fallback，请求会清晰失败，不会延迟或重新排队。提交前出现的可见 rate 或 plan blocker 仍然是当前 execution 的失败。已证明或含糊的提交后工作绝不会在其他 provider 或 profile 上 replay。

配置的 provider 列表只充当 filter。其顺序不会改变 capability、subscription、capacity、fairness 或 route selection。

## 已保存事实与诊断

官方额度估算使用现有 `jobs` 表：

- `provider_submitted_at` 可为空、不可变，并在可见 prompt 提交成功后立即写入；
- `provider`、`profile_id` 与 `request_json` 保留重建本地用量所需的维度；以及
- `(provider, profile_id, provider_submitted_at)` 支持有界历史查询。

内部准入尝试保存在 `provider_rate_limit_attempts`，包含 provider、profile、action index、请求类型与时间戳。当前窗口内已有提交会计入用量直至过期，且不会与准入记录重复计数。

使用以下命令检查下一个 prompt projection：

```sh
tokenless limits inspect --profile <slug> --provider <provider> --json
```

输出包括匹配的 plan、match confidence、catalog revision、适用规则、published 与 effective allowance、本地观察用量、remaining estimate、cadence、burst allowance 和 decision。

## 验证边界

Rate-limit 验收是算法性的。Focused integration test 使用构建后的 CLI、daemon、真实 HTTP boundary、来自 `config.json` 的 profiles，以及带受控 timestamp 的真实 SQLite history。它验证 subscription matching、精确和非数字知识、model-pool 隔离、sliding window、remaining capacity、burst cadence、defer time 与 CLI diagnostic。

内部规则集成测试还验证持久化修改、批量准入、两个窗口、重启保留用量、独立图片规则及真实 Runner 的 fallback 路径；两个 provider 均在获取浏览器页面前被本地额度拦住。

它不会通过刷 provider 网站来发现或耗尽 quota。真实 provider blocker 是普通 runtime 证据，不是 release test load generator。

## 维护

- 重新检查事实时更新官方来源的 retrieval 与 review 日期。
- 当官方页面不再发布数字时保留不确定性。
- 只有具备官方精确证据时才新增精确数字。
- 在 `runtimePolicy` 下将 runtime policy 参数与 provider facts 分开。
- 每次修改 catalog 或 policy 后，运行 packaged catalog check 与 focused rate-limit simulation。
- 当事实或策略的变化实质改变调度时添加 changeset。
