[中文](COMMANDS.zh-CN.md) | [English](COMMANDS.md)

# Tokenless CLI 命令参考

本文档是 `tokenless` 命令行接口的公开命令大全。内容将日常工作流与底层控制分开，并明确标注哪些命令会打开 provider 页面、修改本地状态，或者只读取缓存。

## 命令总览

| 命令 | 用途 | 是否访问 provider |
| --- | --- | --- |
| `tokenless help` | 显示内置命令摘要。 | 否 |
| `tokenless --version` | 输出当前安装的 CLI 版本。 | 否 |
| `tokenless install` | 底层本地 runtime provisioning；日常维护请使用 `tokenless upgrade`。 | 否 |
| `tokenless setup` | 配置 skills、浏览器、profiles、daemon，并执行一次 provider 登录检查。 | 是 |
| `tokenless agents <install\|status\|inspect\|uninstall> codex` | 管理可选的 Codex guidance、native hooks 和精确 Harness context binding。 | 否 |
| `tokenless dashboard` | 打开本地 Web 控制台，或输出可直接访问的 loopback URL。 | 否 |
| `tokenless doctor` | 只读检查本地配置和 runtime 健康状态，不刷新 provider。 | 否 |
| `tokenless config` | 读取或更新 Tokenless 持久化配置。 | 否 |
| `tokenless upgrade` | 升级全局 CLI、skills、本地 runtime，并运行 doctor。 | 否 |
| `tokenless profiles add` | 创建用于 tab 与 provider configuration 的逻辑 Tokenless profile。 | 否 |
| `tokenless profiles list` | 列出 profiles 及其最后保存的 provider 检查结果。 | 否 |
| `tokenless profiles status` | 实时检查一家 provider，并把结果保存到 profile registry。 | 是 |
| `tokenless profiles open` | 以 headed browser 打开 managed profile，可选择是否导航到 provider。 | 可选 |
| `tokenless profiles set-default` | 设置默认 managed profile。 | 否 |
| `tokenless profiles clear` | 作为人工维护操作删除一个或全部 managed profiles。 | 否 |
| `tokenless profiles remove` | 通过显式确认删除一个 managed profile。 | 否 |
| `tokenless capabilities list` | 列出 canonical task capabilities 和已有证据闭环的 provider routes。 | 否 |
| `tokenless limits inspect` | 根据 packaged catalog 和本地 job 历史查看下一次 prompt 的 provider/profile 容量估算。 | 否 |
| `tokenless savings <status\|enable\|disable\|clear\|uninstall>` | 管理可选的本地输出节省计量及其 lazy-download tokenizer。 | 否 |
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
deepseek
perplexity
zai
doubao
kimi
dola
```

ChatGPT、Claude、Gemini 和 Grok 是 supported providers。Qwen / 千问、DeepSeek、Perplexity、Z.ai / GLM、Doubao / 豆包、Kimi 和 Dola 目前为 experimental：只公开已有证据支撑的 routes 与 controls；尚未证明的 continuation 和可选 capability 保持 unavailable 或 unknown。

Tokenless 使用 native mode：Playwright 直接连接用户已经运行的 Google Chrome Stable。需要 Chrome 144+；请在 `chrome://inspect/#remote-debugging` 启用 remote debugging，并确认 Chrome 的连接提示。底层 CDP endpoint 由 Chrome 管理、由 Tokenless 自动发现，因此 native mode 不需要 `--remote-debugging-port` 或固定端口设置。连接成功就是 capability check。Native mode 目前只支持 headed，且不会复制 browser profile。

### 短选项

短选项区分大小写：

- `-P <slug>` 是 `--profile <slug>` 的短形式。
- `-p <provider>` 是 `--provider <provider>` 的短形式。
- `-v` 是 `--verbose` 的短形式。
- `-V` 是 `--version` 的短形式。

### 常用执行选项

以下选项会在命令需要对应 runtime 行为时使用：

| 选项 | 含义 |
| --- | --- |
| `-h`, `--help` | 显示所选命令或子命令的用法。 |
| `--json` | 将最终结果作为结构化 JSON 写入 stdout。除非使用 `--quiet`，实时 status event 仍写入 stderr。 |
| `-v`, `--verbose` | 最终 human result 仍保持简洁，但会在 stderr 显示实时 status event 和结构化诊断详情。JSON stdout 保持不变。 |
| `--quiet` | 禁止输出实时状态事件。 |
| `--color` | 强制 human-readable output 使用 ANSI 颜色；对 JSON stdout 无效。 |
| `--no-color` | 禁用 ANSI 颜色，即使输出连接到 terminal 也不启用。 |
| `--home <path>` | 使用非默认的 Tokenless 状态目录。 |
| `--daemon-url <url>` | 设置首选 loopback daemon URL。若其端口被占用，Tokenless 可顺延到下一个空闲端口，并把实际 endpoint 记录到 SQLite。 |
| `--agent-kind <kind>` | 将 job 或 replay drain 定向到显式 agent kind；必须与 `--agent-session-id` 同时使用。 |
| `--agent-session-id <id>` | 将 job 或 replay drain 定向到显式 agent session；必须与 `--agent-kind` 同时使用。 |
| `--browser-visibility <headed>` | Native Chrome 目前只支持 headed。 |
| `--timeout-ms <ms>` | 覆盖命令或 job 的等待时间。 |
| `--daemon-start-timeout-ms <ms>` | 覆盖 daemon 启动等待时间。 |
| `--runner-heartbeat-timeout-ms <ms>` | 为兼容保留；embedded Playwright runtime 会忽略它。 |
| `--cancel-timeout-ms <ms>` | 覆盖取消确认等待时间。 |
| `--target-url <url>` | 从所选 provider 域名下允许的 URL 开始执行。 |

Human output 默认保持简洁：命令结果尽量使用一行摘要；prompt 正文和 provider 回复仍保留其内容。普通 status event 只会在使用 `--verbose`（或请求 JSON 输出）时显示；`--quiet` 会禁止这些事件。颜色只会在支持颜色的 TTY 中自动启用；pipe、redirect、`NO_COLOR`、`TERM=dumb` 和 JSON 输出都会禁用颜色。Node 的 terminal detection 覆盖 macOS terminal 以及现代 Windows Terminal/Console；旧版 terminal 或严格日志采集可使用 `--no-color`。

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

### `tokenless install`（底层兼容命令）

解析或安装所选的精确 browser runtime，保存 runtime preference，upsert 所需的全局 Tokenless agent skills，验证打包的 TypeScript daemon runtime，并确保本地 daemon 与已安装 CLI 的版本和 control API revision 一致。canonical skill copy 保存在 `~/.agents/skills`；当常见 agent root 已存在时，maintenance 还会刷新 Codex、Claude Code、Cursor、Copilot、Gemini CLI、OpenCode、Pi、Hermes 和 Windsurf 的 direct copy，以及 legacy 的 `~/.agent/skills`。面向普通用户的日常维护请使用 `tokenless upgrade`；本命令保留给底层 runtime provisioning 和兼容性自动化。如果同一 Tokenless home 下通过 proof 验证的 daemon 任一值已过期，当前 CLI package 会优雅重启它；foreign 或未经验证的 listener 绝不会被停止。

```bash
tokenless install --browser auto --json
tokenless install --browser cloak --json
tokenless install --browsers chrome,edge --json
```

主要选项：

- `--browser <browser>` 选择一个 browser preference。Managed selection 只会在 install 或 setup 期间下载。
- `--browsers <list>` 验证逗号分隔的浏览器列表。
- `--repair-browser` 显式替换所选 managed Chrome for Testing 或 Cloak cache；只有新下载的 replacement 通过全部校验后才会替换，repair 失败时会恢复原 cache。
- `--daemon-url`、`--daemon-start-timeout-ms`、`--home` 和 `--json` 控制本地 runtime。

该命令不会更新全局 npm CLI，不会配置 managed profile，也不会检查 provider 登录状态。直接使用本命令时，完成后仍需运行 `tokenless setup`。

### `tokenless setup`

执行完整 onboarding：发现 system 与 cached runtimes，解析或安装精确的所选 browser，创建或选择 runtime-compatible managed profile，保存已验证的 selection，upsert 全局 Tokenless agent skills，将 daemon 对齐已安装 CLI 版本，并对所有 enabled providers 各执行一次实时登录检查。使用 `--install-codex` 时，setup 会在保存 preferences 之后、skill maintenance 之前显式安装 Tokenless guidance 与 hooks；不带该 flag 时不会安装，非交互运行也不会静默安装。Codex `/hooks` 中的手工信任仍然是必需步骤。Skill maintenance 以 `~/.agents/skills` 为 canonical，并刷新已经存在的常见 agent root（包括 `~/.codex/skills` 和 `~/.claude/skills`）中的 direct copy；同时修复 legacy 的 `~/.agent/skills`。npm postinstall、daemon startup 和普通 job execution 都不会下载 browser。如果尚未配置语言，setup 会检测系统 locale：中文 locale 选择 `zh-CN`，其他情况选择 `en`，并将结果写入 config。

交互式 setup：

```bash
tokenless setup
```

非交互创建或复用逻辑 profile：

```bash
tokenless setup --profile default --defaults --json
tokenless setup --install-codex --codex-home <dir> --profile default --defaults --json
```

主要选项：

- `--profile <slug>` 选择或命名逻辑 Tokenless profile。
- `--install-codex` 在 setup 中显式安装可选的 Codex guidance、native hooks 和 skills。
- `--codex-home <dir>` 选择自定义 Codex state root，并且必须与 `--install-codex` 同时使用。
- `--provider-whitelist <list>` 在非交互 setup 中设置该 profile 的 provider membership。
- `--no-open` 完成 setup，但不打开控制台。
- `--defaults` 选择非交互默认值。
- `--label <name>` 设置 profile display label。
- `--set-default` 将所选 profile 设为默认。

Setup 会连接用户已经运行的 Google Chrome Stable。Chrome 144+ 必须在 `chrome://inspect/#remote-debugging` 启用 remote debugging，并由用户确认 Chrome 的连接提示。底层 CDP endpoint 由 Chrome 持有、由 Tokenless 自动发现——native mode 没有 `--remote-debugging-port` 启动参数或固定端口设置。Tokenless 直接以连接成功作为 capability check，不复制 Chrome profile，目前只支持 headed。Daemon 关闭时只断开自动化，不会关闭 Chrome。

交互式 `setup` 会列出所有受支持的 provider，默认全部启用，并允许用户回复界面显示的编号移除 provider；直接回车则保留全部。非交互 setup 会使用 `--provider-whitelist`、已有 profile 的 `enabledProviders`，或为新 profile 使用所有受支持 provider。Guest access、signed-out 页面、unknown state 与 sign-in-required 页面都会作为 observation 记录，而不是 setup failure；只有技术性检查失败才会让 setup 失败。每次 setup 完成后，Tokenless 都会为每个 enabled provider 保留一个 headed 审核 tab，让用户亲自检查登录状态。除非 `--json`、`--defaults` 或 `--no-open` 关闭交互 handoff，setup 还会打开本地控制台。

每个新 profile 默认包含所有非 `disabled` provider，包括 Gemini。可通过 `--profile <slug> --provider-whitelist <list>` 或控制台修改其 membership。

### `tokenless agents <install|status|inspect|uninstall> codex`

管理可选的 Codex 集成，但不会启动、包装或替换 Codex：

```bash
tokenless agents install codex
tokenless agents status codex --json
tokenless agents inspect codex --chat-id <codex-thread-id> --json
tokenless agents uninstall codex
```

`install` 会把一个 versioned inline guidance block 写入实际生效的全局 Codex instruction file，并把 Tokenless 自己的 groups 合并到 `$CODEX_HOME/hooks.json`。同目录存在非空 `AGENTS.override.md` 时，它是实际生效的 source，所以 Tokenless 会修改它而不是 `AGENTS.md`；命令本身不会创建 override。已有 instructions 和非 Tokenless hooks 都会保留。安装后必须重启 Codex，打开 `/hooks`，并显式信任 Tokenless hook definition，之后才能依赖自动绑定。

用户仍然按照原来的方式启动 Codex。Hooks 会观察 lifecycle events，但只在一次真实的 Tokenless Bash 或 MCP 调用发生时执行绑定。Hook `session_id` 是不可变的 session-tree provenance；`turn_id` 与 `tool_use_id` 标识 Hook lifecycle records。对于 CLI/shell 执行，Codex 通过 `CODEX_THREAD_ID` 提供具体 task，Tokenless 会在访问 provider 前解析该 ID，避免 descendant 被合并到 root conversation。一次受限且 best-effort 的 App Server `thread/read` 会确认具体 task、canonical cwd、session tree 和可用 lineage；它不会启动、恢复、relay 或 proxy Codex TUI。

`status` 会报告准确的 instruction/hook paths，并验证当前 guidance body 与 hook command；它不会创建 Harness state。过期或被修改的 definition 会显示为未安装，再次运行 `install` 即可修复。`inspect` 从独立的 Harness 数据库读取一个精确 chat，包括 local project、turns、invocations、稳定的 provider task identity，以及 provider Project/conversation bindings。Ledger 只保存 prompt hash，不保存原始 prompts、transcripts、assistant messages、credentials 或 browser state。`uninstall` 会从两个全局 instruction filenames 中移除 Tokenless guidance，并且只移除 Tokenless hook groups；已经保留的 Harness history 不会删除。

主要选项：

- `--codex-home <dir>` 显式选择 Codex state root，而不是使用 `CODEX_HOME` 或 `~/.codex`。
- `--home <dir>` 选择 Tokenless state root。
- `--chat-id <id>` 是 `inspect` 的必填项，必须传精确的 Codex thread ID。
- `--json` 返回结构化 status 或 context contract。

### `tokenless dashboard`

启动或发现同一 Tokenless home 的 daemon，并在所选 managed profile 中打开一个保留的控制台标签页。也可以直接在浏览器中打开 daemon 的 loopback URL：

```bash
tokenless dashboard
tokenless dashboard --profile work
tokenless dashboard --profile work --no-open --json
```

`--no-open` 不启动浏览器，只输出可直接访问的 loopback 控制台 URL。打开 `/` 会跳转到 `/ui/`，并建立短期有效的 `HttpOnly`、`SameSite=Strict` session cookie；所有 mutation 仍会校验 exact Origin 和 CSRF。控制台不会收到 daemon bearer token、provider cookies、browser storage、Keychain 数据、raw DOM、claim token、checkpoint 或私有文件路径。

控制台包含 Overview、Profiles、Providers、Capabilities、Jobs 和 System/Diagnostics。Provider membership、visibility、role label，以及不带凭据的 HTTP/HTTPS/SOCKS5 proxy 都按 profile 配置。CLI 恢复入口仍然完整保留：

Provider 就绪状态刷新会隐式运行。Profile 空闲时，Tokenless 会启动常驻 headless browser；如果同一 Profile 已有 headed browser，则复用该 runtime，不替换 browser、不关闭现有 tabs，也不把检查带到前台。刷新遇到登录或验证时只记录所需操作；只有显式 Provider、browser 或 job 操作才会启动可见 browser interaction。

```bash
tokenless config --profile work --provider-whitelist chatgpt,claude --browser-visibility headed --json
tokenless config --profile work --proxy-server socks5://127.0.0.1:1080 --proxy-bypass localhost --json
tokenless profiles open --profile work --json
tokenless state --profile work --json
```

### `tokenless doctor`

只读检查 Node.js、已安装 skills、打包 runtime、daemon identity/version、embedded Playwright runtime、browser preference、解析出的 runtime family 与精确 executable version、checksum 状态、默认 profile/runtime compatibility、配置，以及缓存的 provider readiness。

```bash
tokenless doctor --json
```

`doctor` 不会打开 provider 页面、刷新认证状态、启动 daemon 或修复状态。`checks.managedProfile.ok` 表示 registry/profile 本身是否健康，`checks.profileRuntime.ok` 则独立表示该 profile 是否具有可解析且兼容的 browser binding。Provider readiness 来自 profile 中最后保存的检查结果。`checks.providerReadiness.ok` 表示 configured providers 是否已有 recorded observations；`usableProviders` 列出缓存中可用于隐式路由的 providers。因为 daemon 按需运行，正常停止的 daemon 和 embedded browser runtime 会被报告为健康的 stopped 状态，而不是安装损坏。

主要选项：`--browser`、`--daemon-url`、`--home` 和 `--json`。

### `tokenless config`

不传配置选项时，读取持久化配置：

```bash
tokenless config --json
```

不带 `--profile` 时更新全局配置：

```bash
tokenless config \
  --language zh-CN \
  --browser chrome \
  --daemon-url http://127.0.0.1:7331 \
  --json
```

带 `--profile` 时更新该 profile 的 provider membership 与 visibility：

```bash
tokenless config \
  --profile work \
  --provider-whitelist chatgpt,claude,gemini,grok,qwen \
  --browser-visibility headed \
  --json
```

可配置内容：

- `--language <en|zh-CN>`
- `--profile <slug> --provider-whitelist <list>`
- `--profile <slug> --browser-visibility headed`
- `--browser chrome`
- `--daemon-url <loopback-url>`
- `--home <path>`

Provider membership 只属于 `profiles` 中选定的 entry。路由必须读到该 entry，绝不会 fallback 到全局 provider list。

Tokenless 会把具体的旧 per-profile side table 与 `browser/profiles.json` 合并并迁移一次。旧表中缺失的 registered profile 会把旧 root provider list 物化为自己的 `enabledProviders`；canonical config 不再保留任一旧 key。未写入文档的旧 `--preferred-providers` flag 仍作为 CLI alias 接受。

完整 config shape 如下：

```json
{
  "protocol": "tokenless.config.v1",
  "updatedAt": "2026-08-02T02:09:40.254Z",
  "profiles": {
    "default": {
      "roleLabel": "Personal",
      "enabledProviders": ["chatgpt", "claude"],
      "browserVisibility": "headed",
      "proxy": null
    }
  },
  "browser": "chrome",
  "browserExecutablePath": null,
  "browserVisibility": "headed",
  "daemonUrl": null,
  "language": "en",
  "outputSavings": { "enabled": true }
}
```

`browserExecutablePath` 是经过验证的缓存，并不是不可变 override：Tokenless 会执行浏览器的 version command 进行验证；验证失败后会 fallback 到标准路径 discovery，成功时重新写入缓存。如果两种方式都失败，可以使用上面的 CLI flag，或在 dashboard 的 **System → Browser executable path** 中粘贴绝对路径。Dashboard 只会暴露是否已经配置路径，不会把私有路径传回浏览器 JavaScript。

面向用户的命令文案和 provider 默认回复语言都会遵循 `language`；prompt 中明确指定的语言优先。命令名、flags、JSON keys、error codes、status values 和其他 integration terms 保持稳定。`daemonUrl` 是首选启动 endpoint，而不是可变 runtime 状态。首选端口繁忙时 Tokenless 不会改写它；daemon 会把实际绑定 endpoint 记录到 SQLite runtime-state row。

Tokenless 始终通过 CDP 控制 managed Chromium，内部仍使用 Playwright 的 browser、page 和 locator API。常驻浏览器因此可以在一次 daemon 连接结束后继续运行，并由之后的 daemon 重新接入，不再提供可选的 connection mode。

### `tokenless upgrade`

执行面向普通用户的 canonical maintenance pipeline：更新全局 npm CLI、解析并验证已安装 CLI、调用新 CLI 的共享 maintenance 模块来跨 canonical 与已检测到的 direct agent root upsert 全局 agent skills 并协调匹配版本的 daemon，然后运行 doctor。日常安装维护和升级请使用它，不要直接使用 `tokenless install`。

```bash
tokenless upgrade
tokenless upgrade --json
```

接受的选项为 `--json`、`--home`、`--daemon-url`、`--browser`、`--browsers` 和 `--daemon-start-timeout-ms`。

### `tokenless daemon stop`

验证 daemon identity 后，优雅停止兼容的 daemon。Managed browsers 会继续运行；之后启动的 daemon 会通过 profile-scoped CDP endpoint 重新接入。

```bash
tokenless daemon stop --json
```

选项：`--home`、`--daemon-url`、`--timeout-ms` 和 `--json`。

该命令会从 SQLite 发现实际 endpoint，也不会因为某个未验证或不兼容的进程占用了首选端口，就直接杀掉该进程。

## Tokenless Profiles

一个 Tokenless profile 用于组织已连接 Chrome identity 中的 provider tabs 与 configuration；它不会创建或复制单独的 browser identity。

### `tokenless profiles add`

创建逻辑 Tokenless profile：

```bash
tokenless profiles add -P work --label "Work" --set-default --json
```

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

以 headed browser 打开所选 managed profile。不传 `--provider` 时，Tokenless 不会解析 `TOKENLESS_PROVIDER`，不会选择 ChatGPT 或任何其他 provider，也不会执行 navigation；Chromium 会显示该 profile 自然的初始页、默认页或恢复页。传 `--provider` 时，Tokenless 会打开该 provider 并验证 navigation。

该命令属于明确的用户 handoff，因此可以将所选 profile 或 provider 标签页带到前台。自动化 job、status 检查和 navigation diagnostics 会在后台创建并操作标签页；只有确实需要用户执行可见操作时才会将页面带到前台。

```bash
tokenless profiles open -P work --json
tokenless profiles open -P work -p claude --json
```

无 provider 形式适合用户维护浏览器、切换账号或检查 managed profile。provider 形式适合处理登录、CAPTCHA、MFA、consent 或 provider 相关账号切换。它不能替代 `profiles status`；操作完成后应再次运行 status 命令，保存最新 observation。

### `tokenless profiles set-default`

将一个已注册 profile 设为默认。

```bash
tokenless profiles set-default -P work --json
```

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

必须提供 `--confirm-delete`。Remove 或 clear managed profile 只会删除 Tokenless 管理的 browser data，不会修改任何 system-browser profile。

## 执行任务与管理 Jobs

### `tokenless capabilities list`

返回带版本的 canonical task-capability catalog，不会打开浏览器：

Capability 语义、provider mapping、support state 与扩展流程见 [Capability Matrix](docs/capability-matrix.zh-CN.md)。

```bash
tokenless capabilities list --json
```

每个条目描述 caller outcome、parameter schema、lifecycle、side effects、required evidence、output kinds、stability 和已声明的 provider routes。`routeable: true` 表示至少一个已签入的 provider strategy 具有完整实现和真实 provider E2E 证据。Candidate 条目仍可通过 catalog 发现，但会标记为 `routeable: false`，不能用于 run。

`model.choice`、`effort.choice`、`qwen.mode`、`doubao.mode` 和 `doubao.skill` 等 provider control 不会出现在这里；它们保留为 provider adapter 细节，而不是 canonical caller outcome。

### `tokenless limits inspect`

根据 profile 中已观察到的订阅、packaged provider 知识和不可变的本地提交历史，估算下一次 prompt：

```sh
tokenless limits inspect --profile default --provider chatgpt --json
```

结果会报告匹配的 catalog plan 和 rules、本地 usage、公开与生效 allowance、估算剩余额度、cadence、burst allowance、decision 和 `eligibleAt`。`unknown` 表示 Tokenless 没有可执行的官方数值，因此会放行；它不表示 provider 容量无限。该命令只读且只访问本地状态，不会打开 provider 网站或提交 prompt。

### `tokenless savings`

管理只计算 output 的节省估算。它默认开启，但 setup 和 Dashboard 读取绝不会下载 tokenizer。

```bash
tokenless savings status --json
tokenless savings enable --json
tokenless savings disable --json
tokenless savings clear --confirm-delete --json
tokenless savings uninstall --confirm-delete --json
```

`enable` 会先下载并验证固定版本的 `o200k_base` WASM tokenizer，再把 `outputSavings.enabled` 设为 `true`。正常的默认开启流程则会等到第一个 provider job 已经完成、并把计量工作持久交接给 daemon 后，才在后台懒安装。`disable` 会丢弃排队文本、阻止进行中的结果被保存，并保留历史和 runtime。`clear` 会丢弃清空前的工作并删除持久化计量历史；`uninstall` 会停用计量、丢弃工作并移除 runtime；这两个破坏性操作都必须提供 `--confirm-delete`。`status` 对配置和 tokenizer 安装状态都是只读的。所有这些命令都不会打开 provider 页面。

计量范围仅包括经过规范化的可见 assistant 输出，并归属到触发它的 durable job 和 response。它是稳定的跨 provider estimate，不是 provider billing 数值；input token、隐藏推理和私有 backend traffic 都不在范围内。

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
- `--capability <capability>` 可以重复使用，用于请求 canonical caller outcome，而不是 provider 专属控件。
- Tokenless 会合并显式 capabilities 与结构化推导：普通 `submit_and_read` run 要求 `conversation.chat`，`--attach-file` 要求 `file.upload`，并在适用时增加 `image.input`、`audio.input` 或 `video.input`；`--workspace-mode auto` 或 `native` 要求 `workspace.native`。
- 未显式指定 provider 时，配置的 provider list 会过滤 membership。Tokenless 会再筛出满足完整 implication-expanded requirement set 的 providers，并按照 fresh cached eligibility 和 evidence maturity（`supported` 优先于 `experimental`）对 routes 排序；配置 list 的 position 仅作为最终 tie-breaker，不能覆盖这些更强的信号。过期但曾可用的 observation 会保持为 `unchecked`，直到 runner 执行实时只读 preflight。
- 显式 provider 无法满足完整 requirement set 时，会在提交 daemon job 前失败，不会静默切换。
- Unknown 与 sign-in-required observations 不可用于隐式路由。如果没有可用 cached provider，CLI 会在创建 daemon job 前返回带 provider observation context 的 `provider_unavailable`。
- 已知 capability 如果没有完整 route，会在 browser mutation 前返回 `task_capability_route_unavailable`。`--capability` 当前只支持正常的 `submit_and_read` action。
- 成功提交会返回并持久化 `capabilityRoute`，其中包含规范化 requirements、所选 strategies、support level、evidence identifiers 和 runtime eligibility；`tokenless state` 会返回同一 route。
- 隐式 `submit_and_read` run 可以持久化 automatic fallback plan。每次 attempt 都会在 mutation 前只读复核已知本地 provider capacity、可见 session 和 capability-specific UI，不发送 probe prompt。已分类的 safe pre-submit capacity、登录、CAPTCHA、rate/plan、维护、区域、导航、稳定 surface 和 capability availability failure，只有在下一条 ranked route 满足完全相同的完整 requirements，且此前 mutation 都可重建时，才会让同一个 job 重新排队。精确或已映射 continuation、显式 provider、provider-specific controls、不可重建 mutation、ambiguous external state 和 post-submission failure 都绝不会自动切换。JSON state 包含排序后的 `fallback.routes`、结构化停止原因和 `providerAttempts`。
- Job validator 会再次根据 actions、attachment MIME types 和 native workspace intent 推导 capabilities，因此 internal 或 agent caller 无法少报 fallback requirement。Routed job 携带 `tokenless.context-envelope.v1`，其中的 instructions、references、output/constraint contract、可选 upstream state 和 delivery hashes 会在每次 attempt 原样重放；JSON state 只公开脱敏后的 envelope 摘要。

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
- `--deepseek-mode <Instant|Expert|Vision>` 选择精确的 DeepSeek mode。
- `--deepseek-deepthink <on|off>` 控制当前 DeepSeek mode 中的 DeepThink。
- `--deepseek-search <on|off>` 控制 Search；该控件只在 DeepSeek Instant mode 中可用。
- DeepSeek canonical requirements 会在 mutation 前准备所需控件：`search.web` 选择 Instant 并启用 Search，`reasoning.extended` 启用 DeepThink，`image.input` 选择 Vision。显式冲突组合会在页面变化前失败。
- `--kimi-search <auto|off>` 选择 Kimi Web search 行为。
- `--kimi-plugin <exact-visible-label>` 选择一个精确的 Kimi Plugin。
- `--kimi-skill <exact-visible-label>` 选择一个精确的 provider-native Kimi workflow；它与用户自己的 Harness `SKILL.md` 无关。
- `--browser-visibility <auto|headed|headless>` 覆盖已配置的可见性策略。

Identity 与 continuity：

- `--task-id <id>` 提供持久化 task identity。
- `--idempotency-key <id>` 在没有 task ID 时提供相同 identity。
- `--project-name <name>` 和 `--chat-name <name>` 会参与推导 task identity，但不会请求 Workspace 处理。
- `--workspace-mode <auto|native|conversation>` 显式请求 Workspace 处理，并要求同时提供 `--project-name`。
- `--project-instructions <text>` 或 `--project-instructions-file <path>` 提供可选 Workspace instructions。
- `--agent-kind <kind>` 和 `--agent-session-id <id>` 将 job 定向到一个 agent recipient。两者必须同时提供，也可通过 `TOKENLESS_AGENT_KIND` 与 `TOKENLESS_AGENT_SESSION_ID` 提供。

执行控制：

- `--no-wait` 提交后立即返回，不等待结果。
- `--long-running` 使用 long-running wait budget，且不能与 `--no-wait` 同时使用。
- `--timeout-ms`、`--cancel-timeout-ms` 和 `--daemon-start-timeout-ms` 可覆盖执行时间。`--runner-heartbeat-timeout-ms` 为兼容保留，但不再控制 standalone runner。
- `--target-url <url>` 选择 provider 域名下允许的起始 URL。

Workspace modes：

- 使用 `auto` 或 `native` 的 routed `run` request 都要求 canonical `workspace.native` capability。目前没有 provider route 被公开，因此在 native Project release gate 完成前，这类 request 会在 browser mutation 之前失败。
- Claude 与 Grok 的 lower-level adapter 已为显式真实 provider acceptance suite 实现实验性的可见原生 Project 创建/复用；仅有 implementation 不构成 router support 声明。
- `workspace.native` 可路由后，`native` 将强制要求精确创建或复用原生 Project，绝不会降级到 conversation scope；出现重复的精确可见名称时 fail closed。
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

当 provider 登录、hCaptcha、MFA 或其他可见人工验证成为必要条件时，Tokenless 会报告 `waiting_for_user`，并明确提示“需要你的协助”。请完成可见步骤，然后查询或恢复同一个 job；不要提交替代 job。

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
| `deepseek.mode.inspect` | 检查 DeepSeek Instant、Expert、Vision 及其随 mode 变化的控件。 | 无；仅限 DeepSeek |
| `deepseek.mode.select` | 选择一个精确的 DeepSeek mode。 | `--deepseek-mode` |
| `deepseek.deepthink.inspect` | 检查当前 DeepSeek mode 中的 DeepThink。 | 无；仅限 DeepSeek |
| `deepseek.deepthink.select` | 启用或关闭 DeepThink。 | `--deepseek-deepthink on|off` |
| `deepseek.search.inspect` | 检查当前 DeepSeek mode 中的 Search。 | 无；仅限 DeepSeek |
| `deepseek.search.select` | 在 Instant mode 中启用或关闭 Search。 | `--deepseek-search on|off` |
| `doubao.mode.inspect` | 检查快速、专家、工作任务 Turbo，以及可见受限的工作任务 Pro。 | 无；仅限 Doubao |
| `doubao.mode.select` | 选择一个精确的 Doubao mode。 | `--doubao-mode fast|expert|work-task-turbo|work-task-pro` |
| `doubao.skill.inspect` | 检查 Doubao Web skills 及其 canonical candidate mapping。 | 无；仅限 Doubao |
| `doubao.skill.select` | 选择一个 Doubao skill，或恢复普通对话。 | `--doubao-skill <skill>` |
| `kimi.search.inspect` | 检查 Kimi Web search 选项。 | 无；仅限 Kimi |
| `kimi.search.select` | 选择 Kimi Web search 的 Auto 或 Off。 | `--kimi-search auto|off` |
| `kimi.plugin.inspect` | 按精确可见名称列出已启用的 Kimi Plugins。 | 无；仅限 Kimi |
| `kimi.plugin.select` | 选择一个精确的 Kimi Plugin。 | `--kimi-plugin <exact-visible-label>` |
| `kimi.skill.inspect` | 按精确可见名称列出已启用的 Kimi Skills。 | 无；仅限 Kimi |
| `kimi.skill.select` | 选择一个精确的 provider-native Kimi workflow；这不是 user-owned Harness Skill。 | `--kimi-skill <exact-visible-label>` |
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

Doubao skill ids 为 `chat`、`document-writing`、`presentation-generation`、`image-generation`、`video-generation`、`deep-research`、`audio-podcast`、`music-generation`、`problem-solving`、`spreadsheet-generation` 与 `audio-transcription`。最后一项可以 inspect，但可见 Web UI 要求桌面版时，select 会返回 unavailable。翻译被明确排除在这个面向 coding 的 control surface 之外。

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
| `--turn-context` | `--context` |
| `--turn-context-file` | `--context-file` |
| `--conversation-key` | `--idempotency-key` |

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

## 手动真实浏览器验收

已认证 provider capability harness 会读取 `TOKENLESS_TEST_CONFIG` 指向的完整 config，并从相邻 production registry 选择 default 或显式请求的 ready profile。Profile slug 是每位开发者自己的变量，不再是 harness 约定。Test home 必须不同于普通 Tokenless home，并且位于所有 repository/worktree 之外。启动 browser automation 前，harness 会验证 profile directory、私有权限、lifecycle、executable 和 runtime binding；不同 browser runtime 绝不会共用一个 profile。

先创建 repository-local `.env`，然后准备并手动登录 dedicated config 中的 profiles：

```dotenv
TOKENLESS_TEST_CONFIG=/absolute/path/to/tokenless-test-home/config.json
```

```bash
npm run test:e2e:prepare -- --browser cloak --home /absolute/path/to/tokenless-test-home --profile developer-cloak
# 在每个 provider tab 中手动登录，然后执行 harness 打印的 daemon-stop 命令。
npm run test:e2e
```

已认证 profile 支持 `chrome`、`edge`、`chromium`、`chrome-for-testing`、`managed-chromium` 和 `cloak`。`prepare` 会安装或解析精确 browser，把 maintenance skill 输出限制在 test-only home 内，并且创建或复用显式提供的 profile slug。登录页面名单直接来自 `profiles[slug].enabledProviders`；缺失 profile 配置会直接报错。Fresh profile 会包含所有已注册且未 disabled 的 provider，包括 Gemini；区域或网络可达性应作为 E2E evidence 报告，而不是从 preparation 中排除 provider 的理由。Preparation 保留配置顺序，绝不会改写名单。它会通过一次并发的 Chromium background-tab batch 请求名单中的每个 provider-entry tab，然后立即退出，不等待 page load、登录或 Playwright target observation。如果同一 dedicated home 下已通过 proof 验证的 daemon 早于 provider-tab endpoint，preparation 会优雅替换为当前 built daemon，并重试一次 handoff。该 daemon 停止后 resident browser 会独立继续运行；launch signature 兼容时，replacement daemon 会重新接入同一个 profile process。Browser 首次启动时仍可能取得一次焦点，但不会再按顺序把每个 provider tab 带到前台。Preparation 不读取 capability matrix，不运行 provider jobs，也不会调用 `setup`、`profiles status`、自动登录或检查认证数据。可用 `--no-open` 只验证 preparation，不导航 provider，也不进行人工 browser handoff。`run` 才会使用 live capability matrix，通过 CDP 控制的 browser 执行其中声明的 provider journeys，并在 `test-results/live-provider-e2e/` 下写入 private JSON report，先按 provider 分组，再按 capability 分层。Readiness failure 与 capability assertion 会分别分类；`network_or_navigation` 只记录可观察到的可达性失败，不会断言具体 firewall 或区域原因。Provider run 会真实修改 provider 侧状态，并可能产生使用费用。

Browser runtime 与 provider surface 验收是显式本地 gate，不会在 CI 中运行：

```bash
npm run test:e2e:browser-runtime
npm run test:e2e:browser-surfaces
npm run test:e2e:system-surfaces
npm run test:e2e:managed-surfaces
npm run test:e2e:cloak-surfaces
```

运行 `npm run test:e2e:browser-runtime`，要求 `auto` 安装或复用按平台固定版本的 managed Chrome for Testing。显式形式 `npm run test:e2e:browser-runtime -- --expected-auto managed-chromium` 会断言同一个 invariant。每一种目标 Windows x64 CPU 类型都要运行该 gate；npm 从 `cmd.exe`、PowerShell 和 POSIX shell 转发参数时行为一致。

Browser surface gate 会复用已为显式选择的 browser 准备好的 persistent profile，并通过 Tokenless production CDP path 控制它。它绝不会创建或删除 browser profile；请先为该 browser 运行 `test:e2e:prepare`。每个 case 都会通过真实网络访问全部已注册 providers 和 Google Search，检测到 anti-bot challenge 时失败，并且只报告公开 location、title、response status 与结构化 challenge 结果。它不会提交 prompt、读取 browser storage、截屏，也不能替代使用已认证 profile 的 built-CLI provider release gate。
