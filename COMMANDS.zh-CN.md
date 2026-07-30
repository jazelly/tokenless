[中文](COMMANDS.zh-CN.md) | [English](COMMANDS.md)

# Tokenless CLI 命令参考

本文档是 `tokenless` 命令行接口的公开命令大全。内容将日常工作流与底层控制分开，并明确标注哪些命令会打开 provider 页面、修改本地状态，或者只读取缓存。

## 命令总览

| 命令 | 用途 | 是否访问 provider |
| --- | --- | --- |
| `tokenless help` | 显示内置命令摘要。 | 否 |
| `tokenless --version` | 输出当前安装的 CLI 版本。 | 否 |
| `tokenless install` | 验证打包的本地 runtime、所选浏览器和 daemon。 | 否 |
| `tokenless setup` | 配置 skills、浏览器、profiles、daemon，并执行一次 provider 登录检查。 | 是 |
| `tokenless doctor` | 只读检查本地配置和 runtime 健康状态，不刷新 provider。 | 否 |
| `tokenless config` | 读取或更新 Tokenless 持久化配置。 | 否 |
| `tokenless upgrade` | 升级全局 CLI、skills、本地 runtime，并运行 doctor。 | 否 |
| `tokenless profiles discover` | 发现可导入的 Chrome 或 Brave profiles。 | 否 |
| `tokenless profiles add` | 创建或导入 managed browser profile。 | 否 |
| `tokenless profiles list` | 列出 profiles 及其最后保存的 provider 检查结果。 | 否 |
| `tokenless profiles status` | 实时检查一家 provider，并把结果保存到 profile registry。 | 是 |
| `tokenless profiles open` | 使用 headed browser 在 managed profile 中打开 provider。 | 是 |
| `tokenless profiles set-default` | 设置默认 managed profile。 | 否 |
| `tokenless profiles reset` | 从已记录的来源重新导入 imported profile。 | 否 |
| `tokenless profiles clear` | 作为人工维护操作删除一个或全部 managed profiles。 | 否 |
| `tokenless profiles remove` | 通过显式确认删除一个 managed profile。 | 否 |
| `tokenless run` | 通过可见 provider session 发送 prompt 和可选文件。 | 是 |
| `tokenless replay` | 为一个 agent recipient 报告此前未见过的 daemon outcome 摘要。 | 否 |
| `tokenless state` | 查询 daemon 中持久化的 job 状态。 | 否 |
| `tokenless resume` | 使用 headed browser 恢复等待用户操作的 job。 | 是 |
| `tokenless cancel` | 取消 daemon job，并确认其已进入 canceled 状态。 | 否 |
| `tokenless provider-status` | 实时执行 provider 认证检查。 | 是 |
| `tokenless provider-controls` | 检查可见的 model 和 effort 控件。 | 是 |
| `tokenless provider-configure` | 选择精确的可见 model 或 effort label。 | 是 |
| `tokenless provider-action` | 执行一个底层可见 provider action。 | 是 |
| `tokenless chatgpt-controls` | 检查 ChatGPT 的 model 和 effort 控件。 | 是 |
| `tokenless chatgpt-configure` | 配置 ChatGPT 专用的可见控件。 | 是 |
| `tokenless snapshot-dom` | 捕获并保存经过清理的 provider DOM snapshot。 | 是 |
| `tokenless daemon stop` | 优雅停止兼容的本地 daemon。 | 否 |
| `tokenless prompt` | 构建 shareable Tokenless prompt，但不提交。 | 否 |

## 通用约定

### Provider 可选值

Provider 可选值为：

```text
chatgpt
claude
gemini
grok
qwen
```

ChatGPT、Claude、Gemini 和 Grok 是 supported providers。Qwen / 千问目前为 experimental：其 Guest-session prompt 提交与 response 读取已得到证明；cross-process continuation 和尚未证明的可选 capability 保持 unavailable 或 unknown。

Runtime browser 可选值为 `chrome`、`chrome-for-testing`、`chromium`、`edge`、`arc` 和 `brave`。本地 profile import 当前只支持 Chrome 与 Brave。

### 短选项

短选项区分大小写：

- `-P <slug>` 是 `--profile <slug>` 的短形式。
- `-p <provider>` 是 `--provider <provider>` 的短形式。
- Setup 中的 `-f` 是 `--fresh` 的短形式。
- `-V` 是 `--version` 的短形式。

### 常用执行选项

以下选项会在命令需要对应 runtime 行为时使用：

| 选项 | 含义 |
| --- | --- |
| `-h`, `--help` | 显示所选命令或子命令的用法。 |
| `--json` | 将最终结果输出为结构化 JSON。除非使用 `--quiet`，实时进度仍写入 stderr。 |
| `--quiet` | 禁止输出实时状态事件。 |
| `--home <path>` | 使用非默认的 Tokenless 状态目录。 |
| `--daemon-url <url>` | 设置首选 loopback daemon URL。若其端口被占用，Tokenless 可顺延到下一个空闲端口，并把实际 endpoint 记录到 SQLite。 |
| `--agent-kind <kind>` | 将 job 或 replay drain 定向到显式 agent kind；必须与 `--agent-session-id` 同时使用。 |
| `--agent-session-id <id>` | 将 job 或 replay drain 定向到显式 agent session；必须与 `--agent-kind` 同时使用。 |
| `--browser-visibility <auto\|headed\|headless>` | 选择浏览器可见性策略。 |
| `--timeout-ms <ms>` | 覆盖命令或 job 的等待时间。 |
| `--daemon-start-timeout-ms <ms>` | 覆盖 daemon 启动等待时间。 |
| `--runner-heartbeat-timeout-ms <ms>` | 为兼容保留；embedded Playwright runtime 会忽略它。 |
| `--cancel-timeout-ms <ms>` | 覆盖取消确认等待时间。 |
| `--target-url <url>` | 从所选 provider 域名下允许的 URL 开始执行。 |

并非所有通用选项都适用于所有命令。下面各命令章节只列出对应工作流中有意义的选项。

## 安装、初始化与维护

### `tokenless help`

输出精简的内置用法，以及本命令参考文档的链接。

```bash
tokenless help
tokenless run --help
tokenless profiles status --help
```

在任意命令或子命令后使用 `-h` 或 `--help`，可以在执行工作前打印其接受的选项。

### `tokenless --version`

输出当前安装的 package 版本。

```bash
tokenless --version
tokenless -V
```

### `tokenless install`

Upsert 所需的全局 Tokenless agent skills，验证打包的 TypeScript daemon runtime，解析所选 Chromium browser，保存 runtime 配置，并确保本地 daemon 与已安装 CLI 版本一致。

```bash
tokenless install --browser chrome --json
tokenless install --browsers chrome,brave --json
```

主要选项：

- `--browser <browser>` 选择一个浏览器。
- `--browsers <list>` 验证逗号分隔的浏览器列表。
- `--daemon-url`、`--daemon-start-timeout-ms`、`--home` 和 `--json` 控制本地 runtime。

该命令不会配置 managed profile，也不会检查 provider 登录状态。完成后仍需运行 `tokenless setup`。

### `tokenless setup`

执行完整 onboarding：无条件 upsert 全局 Tokenless agent skills，通过共享 maintenance 模块将 daemon 对齐已安装 CLI 版本、选择浏览器、保存 provider preferences、创建或选择 managed profile，并对所有 enabled providers 各执行一次实时登录检查。

交互式 setup：

```bash
tokenless setup
```

非交互创建或复用 clean profile：

```bash
tokenless setup --profile default --fresh --json
```

导入现有本地 browser profile：

```bash
tokenless setup \
  --profile work \
  --browser chrome \
  --import-browser-profile "Profile 1" \
  --consent-local-profile-copy \
  --json
```

主要选项：

- `--profile <slug>` 选择或命名 managed profile。
- `--browser <browser>` 选择本地 Chromium browser。
- `--fresh` 或 `-f` 创建 clean managed profile。
- `--defaults` 选择非交互默认值。
- `--import-browser-profile <directory-key>` 导入 Chrome 或 Brave profile。
- `--browser-user-data-dir <path>` 明确指定来源 browser directory。
- `--consent-local-profile-copy` 显式授权本地复制。
- `--reimport-profile` 从指定来源替换已存在的 imported managed profile。
- `--label <name>` 设置 profile display label。
- `--set-default` 将所选 profile 设为默认。
`setup` 会检查 registry stage 不为 `disabled` 的每一家 provider，包括 Qwen 这样的 experimental provider。Guest access、signed-out 页面、unknown state 与 sign-in-required 页面都会作为 observation 记录，而不是 setup failure；只有技术性检查失败才会让 setup 失败。该命令不接受 `--provider` 或 `--preferred-providers`。`--fresh` 不能与 profile import 或 re-import 同时使用。

### `tokenless doctor`

只读检查 Node.js、已安装 skills、打包 runtime、daemon identity/version、embedded Playwright runtime、browser、配置、默认 managed profile，以及缓存的 provider readiness。

```bash
tokenless doctor --json
```

`doctor` 不会打开 provider 页面、刷新认证状态、启动 daemon 或修复状态。Provider readiness 来自 profile 中最后保存的检查结果。`checks.providerReadiness.ok` 表示 configured providers 是否已有 recorded observations；`usableProviders` 列出缓存中可用于隐式路由的 providers。因为 daemon 按需运行，正常停止的 daemon 和 embedded browser runtime 会被报告为健康的 stopped 状态，而不是安装损坏。

主要选项：`--browser`、`--daemon-url`、`--home` 和 `--json`。

### `tokenless config`

不传配置选项时，读取持久化配置：

```bash
tokenless config --json
```

传入选项时，更新一个或多个持久化值：

```bash
tokenless config \
  --preferred-providers chatgpt,claude,gemini,grok,qwen \
  --browser chrome \
  --browser-visibility auto \
  --json
```

可配置内容：

- `--preferred-providers <list>`
- `--browser <browser>`
- `--browser-visibility <auto|headed|headless>`
- `--daemon-url <loopback-url>`
- `--home <path>`

`daemonUrl` 是首选启动 endpoint，而不是可变 runtime 状态。首选端口繁忙时 Tokenless 不会改写它；daemon 会把实际绑定 endpoint 记录到 SQLite runtime-state row。

### `tokenless upgrade`

执行受支持的 upgrade pipeline：更新全局 npm CLI、解析并验证已安装 CLI、调用新 CLI 的共享 maintenance 模块来 upsert 全局 agent skills 并协调匹配版本的 daemon，然后运行 doctor。

```bash
tokenless upgrade
tokenless upgrade --json
```

接受的选项为 `--json`、`--home`、`--daemon-url`、`--browser`、`--browsers` 和 `--daemon-start-timeout-ms`。

### `tokenless daemon stop`

验证 daemon identity 后，优雅停止兼容的 daemon。

```bash
tokenless daemon stop --json
```

选项：`--home`、`--daemon-url`、`--timeout-ms` 和 `--json`。

该命令会从 SQLite 发现实际 endpoint，也不会因为某个未验证或不兼容的进程占用了首选端口，就直接杀掉该进程。

## Managed Profiles

一个 managed profile 代表一个持久化的本地 browser identity。一个 profile 可以同时保存所有 enabled providers 的 sessions。

### `tokenless profiles discover`

发现本地可导入的 Chrome 或 Brave profiles，但不复制或修改它们。

```bash
tokenless profiles discover --browser chrome --json
tokenless profiles discover --browser brave --browser-user-data-dir /path/to/user-data --json
```

### `tokenless profiles add`

创建空的 managed profile：

```bash
tokenless profiles add -P work --label "Work" --set-default --json
```

或者将选择的认证数据导入到独立的 managed copy：

```bash
tokenless profiles add \
  -P work \
  --browser chrome \
  --import-browser-profile "Profile 1" \
  --preferred-providers chatgpt,claude \
  --consent-local-profile-copy \
  --set-default \
  --json
```

Import 必须提供显式 provider list 和 `--consent-local-profile-copy`。

### `tokenless profiles list`

读取 profile registry，并返回全部 managed profiles。

```bash
tokenless profiles list
tokenless profiles list --json
```

该命令快速、只读且没有浏览器副作用。Provider 字段是缓存的 observation，需要根据各 provider 的 `checkedAt` 判断新旧。

### `tokenless profiles status`

对一家 provider 执行实时认证检查，然后将 `auth`、可见 username、可见 subscription，以及新的 `checkedAt` 写入所选 profile。

```bash
tokenless profiles status -P work -p chatgpt --json
```

若省略参数，profile 会解析为已配置的默认 profile；provider 则依次 fallback 到环境配置或 ChatGPT。

### `tokenless profiles open`

使用 headed browser，在所选 managed profile 中打开一家 provider 并验证 navigation。

```bash
tokenless profiles open -P work -p claude --json
```

该命令用于由用户处理登录、CAPTCHA、MFA、consent 或账号切换。它不能替代 `profiles status`；操作完成后应再次运行 status 命令，保存最新 observation。

### `tokenless profiles set-default`

将一个已注册 profile 设为默认。

```bash
tokenless profiles set-default -P work --json
```

### `tokenless profiles reset`

让 embedded Playwright runtime quiesce，并从已记录来源重新导入 imported managed profile。

```bash
tokenless profiles reset -P work
tokenless profiles reset -P work --preferred-providers chatgpt,claude
```

这是人工维护命令，不接受 `--json`，并且只适用于最初通过 import 创建的 profile。

### `tokenless profiles clear`

让 embedded Playwright runtime quiesce，并删除一个或全部 managed profiles：

```bash
tokenless profiles clear -P work
tokenless profiles clear --all
```

必须且只能提供 `--profile` 或 `--all` 其中一个。该人工维护命令不接受 `--json`。

### `tokenless profiles remove`

通过结构化、显式确认的方式删除一个 managed profile：

```bash
tokenless profiles remove -P work --confirm-delete --json
```

必须提供 `--confirm-delete`。Remove 或 clear managed profile 会删除 Tokenless 管理的 browser data，但不会修改其可能来源的原始 browser profile。

## 执行任务与管理 Jobs

### `tokenless run`

构建 managed Playwright job，通过所选的可见 provider session 发送 prompt，并通常等待关联 response。

```bash
tokenless run \
  -P default \
  -p chatgpt \
  --prompt "Review this proposal." \
  --json
```

Provider 选择：

- 显式 `--provider <provider>` 或 `TOKENLESS_PROVIDER` 会保持精确匹配，不会因为缓存可用性而被替换。
- 当两者都省略时，Tokenless 会为 resolved profile 选择第一个 cached access 为 `guest` 或以 `signed_in_` 开头的 configured provider。
- Unknown 与 sign-in-required observations 不可用于隐式路由。如果没有可用 cached provider，CLI 会在创建 daemon job 前返回带 provider observation context 的 `provider_unavailable`。

Prompt 输入：

- 使用 `--prompt <text>` 或 `--prompt-file <path>` 其中一个。
- `--project-root <path>` 定义 shareable file context 的安全根目录。
- 可重复使用 `--file <path>`，将 project root 内文件的文本嵌入生成的 prompt。
- 使用 `--context <text>` 或 `--context-file <path>` 提供额外 shareable turn context。
- 可重复使用 `--attach-file <path>`，通过 provider 页面上传真实文件。`--file` 与 `--attach-file` 是不同操作。

Provider 控件：

- `--model <exact-visible-label>` 在提交前选择可见 model。
- `--effort <exact-visible-label>` 选择可见 reasoning 或 effort。
- `--thinking-effort <label>` 是另一种 effort 参数形式。
- `--qwen-mode <exact-visible-label>` 选择 Qwen 专属的 composer mode。
- `--qwen-mode-variant <exact-visible-label>` 选择该 Qwen mode 的可见 variant，并要求同时提供 `--qwen-mode`。
- `--browser-visibility <auto|headed|headless>` 覆盖已配置的可见性策略。

Identity 与 continuity：

- `--task-id <id>` 提供持久化 task identity。
- `--idempotency-key <id>` 在没有 task ID 时提供相同 identity。
- `--project-name <name>` 和 `--chat-name <name>` 会参与推导 task identity。
- `--workspace-mode <auto|native|conversation>` 显式请求 Workspace 处理，并要求同时提供 `--project-name`。
- `--project-instructions <text>` 或 `--project-instructions-file <path>` 提供可选 Workspace instructions。
- `--agent-kind <kind>` 和 `--agent-session-id <id>` 将 job 定向到一个 agent recipient。两者必须同时提供，也可通过 `TOKENLESS_AGENT_KIND` 与 `TOKENLESS_AGENT_SESSION_ID` 提供。

执行控制：

- `--no-wait` 提交后立即返回，不等待结果。
- `--long-running` 使用 long-running wait budget，且不能与 `--no-wait` 同时使用。
- `--timeout-ms`、`--cancel-timeout-ms` 和 `--daemon-start-timeout-ms` 可覆盖执行时间。`--runner-heartbeat-timeout-ms` 为兼容保留，但不再控制 standalone runner。
- `--target-url <url>` 选择 provider 域名下允许的起始 URL。

Workspace modes：

- `auto` 在 Claude 和 Grok 中优先使用可见的原生 Project。只有 provider 明确显示原生能力稳定不可用时才 fallback；临时 UI、导航、网络、blocker 和 selector 故障仍然返回错误。
- `native` 强制要求精确创建或复用原生 Project，不允许 fallback；出现重复的精确可见名称时 fail closed。
- `conversation` 强制使用 conversation-scoped strategy；只有真实 provider capability matrix 已证明的 provider/profile 才支持跨进程恢复。
- 原生结果会报告 `created` 或 `reused`、canonical provider resource identity、provider/profile scope 和 instruction outcome；conversation 结果会报告 `fallback`。
- Project 和 task conversation target 会作为精确 SQLite mapping 持久化，不再通过扫描历史 job result 恢复。

### `tokenless replay`

原子报告尚未送达给一个显式 agent recipient 的 outcome 摘要：

```bash
tokenless replay \
  --agent-kind codex \
  --agent-session-id "<stable-session-id>" \
  --json
```

该命令会按需探测或启动本地 daemon。SQLite 会在返回响应前把每个 actionable outcome revision 标为已报告，因此同一 revision 永不再次主动报告——即使本次 CLI 响应丢失。同一 job 后续进入新的 parked 或 terminal revision 时，会作为新的 outcome 再报告一次。

Replay 只包含 allowlist metadata，以及 `has_result`、`has_error`、`has_blocker` 标志；不会包含原始 result、error 或 blocker 内容。需要时使用 `tokenless state --job-id "<jobId>" --json` 读取持久化的完整 job。不要仅仅因为漏掉 replay 响应就提交替代 job。

主要选项：`--agent-kind`、`--agent-session-id`、`--limit`、`--daemon-url`、`--daemon-start-timeout-ms`、`--home` 和 `--json`。两个 identity 参数也可由 `TOKENLESS_AGENT_KIND` 与 `TOKENLESS_AGENT_SESSION_ID` 提供。

### `tokenless state`

读取 daemon 中持久化的 job 状态，不访问 provider。

```bash
tokenless state --task-id task-123 -P default --json
tokenless state --job-id tlp_... --json
tokenless state -P default -p chatgpt --limit 10 --json
```

必须提供 task ID、job ID 或 profile。结果会按 managed Playwright backend、所选 profile 和 provider 过滤。`--limit` 控制返回 job 数量。

### `tokenless resume`

当同一个 daemon job 进入 `waiting_for_user` 后，恢复该 job。

```bash
tokenless resume \
  --job-id tlp_... \
  --browser-visibility headed \
  --json
```

必须提供 `--job-id` 和 `--browser-visibility headed`。Resume 会保留原始 job 与 task identity。

### `tokenless cancel`

请求取消，并且只有在 daemon 确认进入 `canceled` 状态后才算成功。

```bash
tokenless cancel --job-id tlp_... --json
```

主要选项：`--job-id`、`--cancel-timeout-ms`、`--daemon-url`、`--home` 和 `--json`。

## Provider 检查与控制

以下命令会实时操作可见 provider 页面。除非使用的就是 `profiles status`，否则它们不会让 `profiles list` 中的缓存结果变新。

### `tokenless provider-status`

实时执行 provider authentication action，并返回检查结果。

```bash
tokenless provider-status -P default -p chatgpt --json
```

如果需要实时检查并同时更新 profile registry，请使用 `tokenless profiles status`。

### `tokenless provider-controls`

检查 provider 中可见的 model 和 effort choices。

```bash
tokenless provider-controls -P default -p claude --json
```

### `tokenless provider-configure`

选择精确的可见 model、effort label，或同时选择两者。

```bash
tokenless provider-configure \
  -P default \
  -p chatgpt \
  --model "GPT-5" \
  --effort "High" \
  --json
```

至少需要提供一个 control。Label 必须与可见 UI label 精确匹配；managed visible jobs 不支持 model fallback list。

### `tokenless chatgpt-controls`

用于检查 model 与 effort controls 的 ChatGPT 专用命令。

```bash
tokenless chatgpt-controls -P default --json
```

### `tokenless chatgpt-configure`

选择 ChatGPT 专用的 model 或 effort controls。也可以用 `--chat-surface chat` 显式约束使用 chat surface；其他 ChatGPT surfaces 会被拒绝。

```bash
tokenless chatgpt-configure \
  -P default \
  --model "GPT-5" \
  --effort "High" \
  --json
```

如果提供 `--provider`，其值必须是 `chatgpt`。

### `tokenless provider-action`

精确执行一个底层可见 action。

```bash
tokenless provider-action \
  -P default \
  -p chatgpt \
  --action capability.inspect \
  --json
```

| Action | 用途 | 必需或相关 payload 选项 |
| --- | --- | --- |
| `capability.inspect` | 检查可见的、由 subscription 决定的 capabilities。 | 无 |
| `auth.status` | 检查可见 authentication 和 account state。 | 无 |
| `model.inspect` | 列出可见 model controls。 | 无 |
| `model.select` | 选择一个精确的可见 model。 | `--model` |
| `effort.inspect` | 列出可见 effort controls。 | 无 |
| `effort.select` | 选择一个精确的可见 effort。 | `--effort` 或 `--thinking-effort` |
| `qwen.mode.inspect` | 列出 Qwen 专属的可见 composer modes。 | 无；仅限 Qwen |
| `qwen.mode.select` | 选择一个 Qwen 专属 mode 和可选的可见 variant。 | `--qwen-mode`；`--qwen-mode-variant` 可选 |
| `file.upload` | 通过可见 file controls 上传文件。 | 一个或多个 `--attach-file` |
| `workspace.ensure` | 确保存在原生或 conversation-scoped Workspace。 | `--project-name`；`--workspace-mode` 和 instructions 可选 |
| `prompt.clear` | 清空可见 composer。 | 无 |
| `prompt.input` | 将文本写入可见 composer，但不提交。 | `--prompt` 或 `--prompt-file` |
| `prompt.submit` | 提交当前可见 composer。 | 无 |
| `response.read` | 读取可见的关联 response。 | 无 |
| `snapshot.sanitized` | 返回经过清理的 structural snapshot。 | 无 |
| `navigation.check` | 验证页面位于允许的 provider origin。 | 无 |
| `blocker.check` | 检查登录或 CAPTCHA 等可见 blocker。 | 无 |

Action payload 是严格校验的：与所选 action 无关的选项会被拒绝。

`workspace.ensure` 在省略 mode 时默认使用 `--workspace-mode auto`。

### `tokenless snapshot-dom`

通过 daemon 捕获经过清理的 provider structural snapshot，并将 metadata 和 snapshot files 保存到 Tokenless home directory。

```bash
tokenless snapshot-dom -P default -p chatgpt --json
```

如果不需要持久化，可使用 `provider-action --action snapshot.sanitized`。

## Prompt 构建

### `tokenless prompt`

构建 shareable `# Tokenless Request` 文档，但不打开浏览器，也不提交 provider job。

```bash
tokenless prompt \
  --project-root /path/to/project \
  --file src/example.ts \
  --context "Only the selected files are shareable." \
  --prompt "Review this implementation." \
  --output /tmp/tokenless-request.md
```

选项：

- `--prompt` 或 `--prompt-file` 提供用户请求。
- `--project-root` 定义允许读取文件的边界。
- 重复使用 `--file` 可包含多个文件文本。
- `--context` 或 `--context-file` 提供 shareable turn context。
- `--output` 将编译后的 prompt 写入文件；否则输出到 stdout。

当第一个参数本身是选项时，也可以省略 `prompt` 这个命令词；但在文档和脚本中，显式形式更清晰。

## 兼容别名

以下 aliases 为兼容性而保留。新脚本应使用 canonical form。

| Alias | Canonical form |
| --- | --- |
| `tokenless status` | `tokenless state` |
| `tokenless provider-auth-status` | `tokenless provider-status` |
| `tokenless inspect-provider-controls` | `tokenless provider-controls` |
| `tokenless inspect-chatgpt-controls` | `tokenless chatgpt-controls` |
| `--import-chrome-profile` | `--import-browser-profile` |
| `--chrome-user-data-dir` | `--browser-user-data-dir` |
| `--turn-context` | `--context` |
| `--turn-context-file` | `--context-file` |
| `--conversation-key` | `--idempotency-key` |
| `--clean-profile` | `--fresh` |

## 状态与副作用总结

三个名称相近的 status 工作流有不同的持久化行为：

```text
profiles list
    只读取已保存的 profile registry

profiles status
    访问一家 provider，检查 auth/account controls，
    并保存 auth、username、subscription 和 checkedAt

provider-status
    访问一家 provider 并返回实时 auth 结果，
    但不是用于刷新 profile registry 的工作流
```

可能打开或操作 provider 页面的命令包括：`setup`、`profiles status`、`profiles open`、`run`、`resume`、所有 provider inspection/configuration/action 命令，以及 `snapshot-dom`。
