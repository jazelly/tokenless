# Harness 集成

Tokenless 提供两个互相独立的集成深度。安装其中一项不代表已经安装另一项。

## 通过 Tokenless API 访问模型

外部 Harness 保留自己的 Agent Loop、tools、session、continuation 与 subagent，只修改模型 endpoint：

```text
外部 Harness Agent Loop
  -> 使用 Tokenless API base URL 的现有 model adapter
  -> Tokenless API
  -> 所选 provider
```

DeepSeek Harness 已验证的路径使用它现有的 `llm-deepseek` adapter。该集成不启用、也不依赖 `llm-pi-ai`，同时不会删除 DeepSeek Harness 独立维护的这个 package。

## 通过 Tokenless Harness 执行 subagent

如果宿主提供可替换的 subagent executor，就可以把 child task 委托给 Tokenless Harness：

```text
宿主主 Agent Loop
  -> 宿主 subagent provider seam
  -> Tokenless Harness adapter
  -> Tokenless Harness-owned AgentRun 与 workspace tools
  -> Tokenless API
  -> 所选 provider
  -> 把 child final result 返回宿主
```

DeepSeek Harness 通过 `SubagentProvider` 暴露了这个 seam：

```bash
tokenless agents install dsh \
  --dsh-home ~/.dsh \
  --dsh-profile headless \
  --provider chatgpt \
  --profile default \
  --json
```

Installer 会向该 profile 的 `cordis.patch.yml` 添加带 marker 的区块，注册 `tokenless-harness` provider，并让普通 `subagent` tool 选择它。其他 profile row 保持不变。

```bash
tokenless agents status dsh --dsh-home ~/.dsh --dsh-profile headless --json
tokenless agents uninstall dsh --dsh-home ~/.dsh --dsh-profile headless --json
```

V1 provider 是 one-shot。Delegated task 获得 parent workspace root 与有界 read/search tools；Tokenless Harness 负责完整 model/tool continuation，直到返回 final result。

## 显式委托

没有可替换 subagent executor 的宿主仍可显式调用同一 boundary：

```bash
tokenless agent delegate \
  --provider chatgpt \
  --profile default \
  --workspace-root "$PWD" \
  --prompt "Find where the API endpoint is configured." \
  --json
```

Codex 当前属于这一类。它的 [native spawn handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs) 负责创建 subagent；[SubagentStart hook input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/subagent-start.command.input.schema.json) 是观测 context，不是 executor replacement。因此 Tokenless 为 Codex 如实提供显式 delegation，不声称 native `spawn_agent` 已被替换。

## Ownership

| Path | Agent Loop owner | Tool executor | Provider access |
| --- | --- | --- | --- |
| Model base URL | 外部 Harness | 外部 Harness | Tokenless API |
| DSH subagent provider | child 由 Tokenless Harness 负责 | Tokenless Harness | Tokenless API |
| 显式 delegation | delegated run 由 Tokenless Harness 负责 | Tokenless Harness | Tokenless API |
