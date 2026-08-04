<p align="center">
  <img src="assets/tokenless-wordmark.png" alt="Tokenless" width="560">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/v/tokenless?logo=npm&amp;label=version" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/dm/tokenless?logo=npm&amp;label=downloads" alt="npm 月下载量"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="COMMANDS.zh-CN.md">CLI 命令</a> · <a href="#安装与初始化">快速开始</a>
</p>

## Tokenless 能做什么

Tokenless 为 AI Agent 提供一个统一的本地浏览器接口，用来访问 ChatGPT、Claude、Gemini、Grok、Qwen，以及实验阶段的 DeepSeek、Perplexity、Z.ai 和 Doubao / 豆包 adapter，从而减少 Agent 侧 token 消耗，也不需要配置这些服务的 API Key。

它不只是把 prompt 填进网页。Tokenless 会把各家 provider 真正提供的网页工作流适配成一个供 Agent 使用的本地接口：

- 发送 prompt，并读取回复和引用；
- 通过 provider 自己的控件上传文件；
- 使用页面上可见的模型、推理等级和 provider 专属模式；
- 创建或复用 Projects，并将每个任务限定在正确的 profile、Project 和对话中；以及
- 传递选定的项目文件和单轮上下文，不暴露无关文件。

只有经过 Tokenless 可见验证的 provider 工作流才会启用。未支持或尚未证明的行为会明确报错，不会猜测执行。Provider 登录信息、浏览器状态和 job 数据都保留在用户本机。

在同一个 managed profile 中，Tokenless 会为不同 provider 和稳定 task 保留彼此独立的浏览器标签页。Project 和对话会按 task identity 回到自己的标签页，不会覆盖并导航掉另一个 provider 或对话。Local job API 默认使用 `pagePolicy: "preserve"`；只有 integration 显式请求 `pagePolicy: "replace"` 时，Tokenless 才允许把已有标签页改作另一个 task 使用。

每个 active managed profile 都独占自己的 browser instance。Tokenless 会在该 profile 的 tabs 和 jobs 之间持续复用这个 instance，绝不会为了给另一个 profile 腾位置而关闭它；最多可同时保留四个 active profiles。

| Provider | 状态 | 是否需要登录 |
| --- | --- | --- |
| ChatGPT | 可用 | 不需要 |
| Claude | 可用 | 需要 |
| Gemini | 可用 | 不需要 |
| Grok | 可用 | 需要 |
| Qwen / 千问 | Beta | 不需要 |
| DeepSeek | 实验阶段 | 需要 |
| Perplexity | 实验阶段 | 不需要 |
| Z.ai / GLM | 实验阶段 | 不需要 |
| Doubao / 豆包 | 实验阶段 | 需要 |
| Kimi | 实验阶段 | 需要 |

## 安装与初始化

安装 CLI：

```bash
npm install --global tokenless@latest
```

然后按照交互式 setup 流程完成初始化：

```bash
tokenless setup
```

交互式 setup 会先询问是否使用 Anti-Detect 模式，并直接说明接受后会在需要时把经过验证、按平台固定版本的 CloakBrowser 安装到 `TOKENLESS_HOME` 下。拒绝后会使用已保存的普通 browser 偏好或自动发现，不再显示单独的 runtime 选择器。选择 Anti-Detect 后，setup 会链接到 CloakBrowser、显示当前平台的精确锁定版本，只扫描本机已知 Chrome、Brave、Edge、Arc、Chromium 和 Chrome for Testing profile 的安全目录/版本元数据，并标记精确版本是否匹配。有兼容 profile 时，只显示一次来源选择，其中包含 `Start clean` 和兼容 profile；选择某个 profile 本身就明确授权 opaque 本地复制，Tokenless 不会检查认证值。之后不再询问是否 import、是否同意 copy 或是否继续安装。非交互 setup 中，显式 `--anti-detect` 或 `--browser cloak` 授权安装；仅有已保存的 Cloak preference 不会触发下载，import 仍要求 `--consent-local-profile-copy`。之后 setup 才会询问哪些 provider 属于当前 managed profile，只检查这些 provider，通过一次并发后台批处理为每个 provider 保留一个 headed 页面供用户审核登录状态，并在一个保留的前台标签页中打开 Tokenless 本地控制台。之后可随时重新打开控制台：

```bash
tokenless dashboard
```

控制台只由 loopback daemon 提供，可管理浏览器身份、profile 级 provider 路由、可见就绪状态与控件、能力目录、持久任务、用户接管和脱敏诊断信息。Setup 和系统设置会发现已安装的 runtime，接受并验证用户明确填写的 system-browser executable path；经用户同意后，也可以把一个选定的本机 Chromium profile 作为 opaque 文件树复制或重新导入。浏览器 JavaScript 不会拿到 daemon bearer token、来源文件系统路径或 provider 登录信息；`tokenless dashboard` 通过一次性 bootstrap ticket 建立短期本地 UI session。

安装 npm package 只是第一步。使用 Tokenless 前必须完成 `tokenless setup`；它会选择并验证精确的 browser runtime，创建或复用绑定 runtime 的 browser profile，准备本地运行环境，检查所有已启用的 providers，并为每个 provider 打开一个审核 tab。普通模式依次遵循显式 browser、已保存偏好和自动发现；默认的 `auto` 会优先使用用户已经安装的 Chrome-family browser，只有没有可用浏览器时才 lazy download 由 Tokenless 管理的 Chrome for Testing 145。Anti-Detect 模式会选择 CloakBrowser，非交互流程也可使用 `--anti-detect`。Cloak 会从官方 release 下载到 Tokenless 私有 cache；采用单独许可的 binary 不会进入 Tokenless npm package 或 release artifact。

每个 managed profile 都会绑定创建它的 browser runtime。Tokenless 不会用不同 runtime family 静默打开 managed profile；切换 runtime family 通常会创建 clean profile。经过用户明确选择后，setup 可以把一个版本兼容的本机 Chromium profile 作为 opaque 文件树复制到新的 managed profile；Tokenless 不会检查或暴露其中单独的 cookies、tokens、browser storage 或认证值。之后由 managed browser 自己跨 job 保留该 profile 的 session。

首次 setup 会根据系统 locale 选择英文或简体中文，并把结果保存到 `~/.tokenless/config.json` 的 `language` 字段；无法识别时使用英文。该偏好同时控制 CLI、控制台和 provider 的默认回复语言；prompt 中明确指定的语言仍然优先。之后可在控制台中修改，也可运行 `tokenless config --language en` 或 `tokenless config --language zh-CN`。

Config 使用 `providerWhitelist` 作为 provider routing 边界。默认值包含除 Gemini 外的所有非 `disabled` provider；可以在 setup 中、通过 `tokenless config --provider-whitelist ...`，或在控制台中显式启用 Gemini。

Setup 会把 `auto` 解析成具体的 `browser`，并把验证过的绝对路径作为 `browserExecutablePath` 缓存到 `$TOKENLESS_HOME/config.json`。Runtime resolution 会先验证缓存，缓存失效后才扫描标准安装路径，并在 fallback 成功时刷新该字段。可以运行 `tokenless config --browser chrome --browser-executable-path "/浏览器的绝对路径"` 设置自定义 system-browser 路径；managed Chromium 与 Cloak 的路径仍由 catalog 控制，并固定在 `$TOKENLESS_HOME/browser/runtimes` 下。

为评估 browser capability，config 文件接受实验性的 `browserConnectionMode: "playwright" | "cdp"`；默认值为 `playwright`，不提供 CLI flag，并在 daemon 重启后生效。

需要 Node.js 22.13+。首批 browser runtime 目标平台是 Apple Silicon Mac 和 Windows x64；Windows x64 同时覆盖 Intel 与 AMD CPU。Windows 在真机 gate 通过前仍属于 prerelease。

## 可选的输出节省计量

输出节省计量默认停用，也不属于 setup 流程。停用时，Tokenless 不会下载、加载或运行 tokenizer。可以在控制台的“系统”页面显式启用，也可以运行：

```bash
tokenless savings enable --json
```

首次启用会下载经过 checksum 固定的 `tiktoken` 1.0.22 archive（10,611,708 bytes，约 10.1 MiB），并且只把 `o200k_base` 的 WASM runtime 和 vocabulary（3,413,323 bytes，约 3.3 MiB）安装到 `TOKENLESS_HOME`。它是确定性 tokenizer，不是本地 AI model；不需要 GPU。只有 Tokenless 读完一条可见 assistant 回复时，才会在单并发、短生命周期的 Node.js subprocess 中运行。一次本机 benchmark 观测到约 100 MB 的瞬时内存；实际 CPU 时间和峰值内存会随回复内容和机器变化。

Tokenless 只计量经过规范化的可见 assistant 输出；不估算 input token，不截取 provider 私有 API，不读取隐藏推理，也不声称与 provider billing 完全一致。`o200k_base` 提供统一、稳定的跨 provider 估算，因此界面始终标注为 estimate；结果可能与 provider 的 model-specific tokenizer 不同。每条计量会幂等归属到触发它的 durable job 和 response。

```bash
tokenless savings status --json
tokenless savings disable --json
tokenless savings clear --confirm-delete --json
tokenless savings uninstall --confirm-delete --json
```

停用后不再产生新计量，但保留已验证的 runtime 和历史；清空只删除计量历史，不改变开关；卸载会停用该功能并删除本地 runtime。Tokenizer 不包含在 Tokenless npm package 中，只有之后显式启用才会触发下载。

## 执行

Setup 完成后，可以直接让 Agent 使用 Tokenless，也可以自己快速测试：

```bash
tokenless run \
  --provider chatgpt \
  --prompt "Review this proposal."
```

不传 `--provider` 时，Tokenless 会选择一个当前可用的 configured provider。显式指定后，Tokenless 只使用该 provider。

Agent 可以发现 canonical outcome catalog，并请求一个或多个已有证据闭环的 capabilities：

```bash
tokenless capabilities list --json
tokenless limits inspect --profile default --provider chatgpt --json

tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review the attached proposal."
```

Tokenless 会合并显式 capability 与结构化输入推导出的要求。普通 run 要求 `conversation.chat`，attachments 要求 `file.upload` 及对应的 media-specific input capability，`--workspace-mode native` 要求 `workspace.native`。配置的 provider list 会限制候选成员。在这个集合内部，Router 会剔除无法满足完整 implication-expanded requirement set 的 provider，再按照新鲜 runtime eligibility 和 evidence maturity 对剩余 routes 排序；配置列表顺序仅作为最终 tie-breaker，绝不会覆盖 capability compatibility、runtime eligibility 或 evidence maturity。目前可路由的是 `conversation.chat` 和 text-file `file.upload`；`workspace.native`、`research.deep` 及其他 candidate outcomes 在完整 lifecycle 通过真实 provider E2E closure 前，会在 browser mutation 之前明确失败。

对于未显式指定 provider 的 run，Tokenless 会记录排序后的 evidence-backed alternatives，并在 mutation 前根据当前本地 capacity 与真实 provider 页面重新检查当前 route。已知 capacity window、登录、CAPTCHA、限流或套餐限制、维护、区域不可用、导航失败、稳定 surface 缺失或 capability UI 明确不可用等已分类的 safe pre-submit provider failure，可以让同一个 job 原子切换到下一条 route。每个 alternative 都必须满足完全相同的完整 capability set。显式 `--provider`、精确或已映射 continuation、provider-specific controls、不可重建 mutation、外部状态不明确以及任何 post-submission failure 都绝不会自动切换。`tokenless state --json` 会报告排序后的 fallback routes、结构化停止原因和持久化的 provider attempt 历史。

每个 routed job 还会保存带版本、provider-neutral 的 context envelope，包含 task identity、规范化 requirements、带 role 的 instructions、attachment provenance、输出约束、可选 upstream agent state 和 delivery hashes；不同 provider attempts 会原样重放同一个已验证 envelope。`tokenless state --json` 只公开不含 instruction 正文与 upstream state 内容的脱敏 envelope 摘要。

可以使用 `tokenless provider-action --action capability.inspect --provider <provider> --json` 检查某家 provider 当前可用的具体能力。

DeepSeek 提供 provider-specific 的 `Instant`、`Expert`、`Vision` mode，以及独立的 `DeepThink` 与 `Search` 控件。可分别使用 `deepseek.mode.inspect`、`deepseek.deepthink.inspect` 和 `deepseek.search.inspect` 检查；Search 与文件能力会随 mode 变化，Tokenless 不会只根据 mode 名称推断能力。

豆包通过 `doubao.mode.inspect/select` 与 `doubao.skill.inspect/select` 公开 provider-specific modes 和适合 coding 工作流的 Web skills。Runtime 会报告可见的升级限制与 desktop-only 限制，不会强行点击受限流程。Text-file `file.upload` 已作为 experimental route 提供；在每种生成或长任务 outcome 分别通过真实 provider release gate 前，skill selection 仅作为 control evidence。

Kimi 要求使用已登录的 managed profile。其 experimental routes 覆盖 `conversation.chat`、text-file `file.upload`、`search.web` 与基于搜索的 `response.citations`；真实 Cloak gates 还闭环了模型选择（`Instant`、`K3`、`K3 Swarm`）、Standard/High 思考强度、Web search Auto/Off 精确控制、可见引用、附件感知回答、同一 conversation 续聊，以及 Plugin/Skill 的精确检查与选择。Plugin/Skill 驱动的完整 outcome、Projects、Deep Research、agent workflows，以及生成或长任务 artifacts 在完整 lifecycle 闭环前均不公开。

对于显式 DeepSeek run，`search.web` 会在浏览器 mutation 前准备 Instant 并启用 Search，`reasoning.extended` 会启用 DeepThink，`image.input` 会准备 Vision。在声明的真实 provider release gate 通过之前，这些 canonical route 仍会 fail closed。

## 文档

- [文档索引](docs/README.zh-CN.md)
- [Capability Matrix](docs/capability-matrix.zh-CN.md)
- [CLI 命令](COMMANDS.zh-CN.md)
- [隐私政策](PRIVACY.md)
- [架构](docs/architecture.md)

## 补充说明

项目目前处于内测阶段。后续计划发布关于 token 节省效果的具体评测数据，供大家参考。

## 已知问题

### Codex 的 sandbox policy 可能阻止 Tokenless 运行

在 Codex 中，Agent 使用的 sandbox policy 可能会阻止 Tokenless 启动浏览器或执行必要的本地操作。在可信环境中，可以将 Codex 设置为 Full Access；也可以在 Codex 弹出授权询问时批准该操作，并选择今后允许相同操作，避免后续重复授权。

## 常见问题

### Tokenless 会完全消除 token 消耗吗？

不会。Tokenless 会把适合的任务分流到 AI provider 的网页版，从而减少 Agent 侧的 token 消耗；Agent 仍需要使用少量 token 来判断分流内容并处理结果。

### 只安装 npm package 就可以使用吗？

不可以。安装后还必须运行 `tokenless setup` 并完成 setup 流程。Tokenless 需要配置好的浏览器 profile 和至少一个可用的 provider 才能执行任务。

### Tokenless 需要 provider API Key 吗？

不需要。Tokenless 使用 provider 的可见网页，而不是 provider API。部分 provider 仍要求登录，实际可用能力取决于你的账号在网页上能够使用的功能。

### Tokenless 会把整个项目发送给 provider 吗？

不会。它只发送委派任务所需的 prompt、选定文件和 task context，不会自动暴露无关的项目文件。

### 每个 provider 都支持所有功能吗？

不支持。Tokenless 只启用已经在各 provider 可见网页上验证过的工作流；不支持或尚未验证的能力会明确报错并停止。

当前 provider mappings 与 evidence rules 见 [Capability Matrix](docs/capability-matrix.zh-CN.md)。

### 为什么 Qwen 有时会报告 `provider_dns_unavailable`？

这个错误表示 Chromium 在发出 HTTP 请求前无法解析 `chat.qwen.ai`。Tokenless 会把 Qwen 的这种情况记录为可重试的疑似 rate limit，因为 provider 边缘节点的间歇性 throttling 是可能原因之一；但同时会明确标记为尚未确认，因为仅凭 DNS 失败无法证明发生了 HTTP rate limit。

请等待一段时间后手动重试命令，并检查当前网络能否解析该 hostname。不要把这类失败计作 provider E2E 通过或 skip，也不要用测试专用 DNS override 作为验收证据。只有 provider 页面上的可见证据，或 `429`、`Retry-After` 等 HTTP 响应，才能确认 rate limit。
