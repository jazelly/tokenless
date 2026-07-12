[中文](README.zh-CN.md) ｜ [English](README.md)

# Tokenless

Tokenless 帮助智能体节省 token：它将适合的工作交给用户已登录的 ChatGPT、Claude 或 Gemini 网页版处理，并将页面上可见的回答返回给智能体。

## 核心价值

第二意见、研究型问答、草稿撰写、解释、审查和简单转换，通常不值得再消耗一次付费 API 调用。Tokenless 为智能体提供本地命令行入口，只操作用户看得见的服务商界面，并将可见结果带回智能体工作流。

## 它怎么工作

1. 智能体调用 `npx tokenless run`。
2. 命令行工具确认目标主目录对应的 Rust 守护进程已就绪；若未运行，则启动软件包自带的二进制文件。
3. 若扩展的 Rust 原生消息桥接已连通，命令行工具不会预先打开唤醒标签页；否则它只会在已配置的 Chromium 浏览器中打开所选服务商经验证的 HTTPS 页面。扩展会复用已获准的服务商标签页，必要时仅打开一个标签页。默认服务商为 ChatGPT。
4. 扩展只通过用户可见的 DOM 提交提示词并读取回答。
5. Rust 原生主机完成守护进程任务，命令行工具将可见结果返回给智能体。

它不设本地 JSON 任务队列回退、任务页面或本地文件页面，不使用 Node 原生主机，也不会自动打开任何 `chrome-extension://` 页面。

## 安装

先在 Chrome 中安装并启用 Tokenless 扩展，然后执行一次本机设置：

```bash
npx tokenless setup
```

`npx` 会在需要时下载命令行工具；若偏好使用短命令，才需要执行 `npm install -g tokenless` 全局安装。支持技能的智能体还可额外安装 Tokenless 技能：

```bash
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless
```

`setup` 会安装本地 Rust 运行环境、为一个 Chromium 浏览器注册原生消息主机、必要时打开 ChatGPT，并且仅在扩展桥接确实连通后返回成功。如果 ChatGPT 要求登录，请在可见标签页中完成登录；若桥接未连通，命令会明确提示安装或启用扩展，不会因为本地文件已写入便误报成功。

发布版扩展 ID 已内置。未打包的开发扩展只需在设置时覆盖一次：

```bash
npx tokenless setup --extension-id "<chrome-extension-id>" --json
```

通用 `tokenless` 软件包仅包含 JavaScript。npm 会按操作系统和 CPU 架构选择同版本的可选依赖，其中包含 `tokenless-daemon` 和 `tokenless-native-host`；随后 `setup` 将这些本地二进制文件复制到 `~/.tokenless/bin`，写入唯一且精确的原生主机允许来源，默认只绑定一个选定的 Chromium 浏览器，并确认守护进程和扩展桥接可用。运行时不会下载可执行文件，也不使用安装脚本；终端用户无需安装 Cargo。

如有需要，可配置服务商优先顺序和浏览器：

```bash
tokenless config --preferred-providers chatgpt,claude,gemini --browser chrome --json
```

未配置浏览器时，`setup` 会按 Chrome、Brave、Edge、Arc、Chromium 的顺序依次检测。Tokenless 不会把服务商 URL 交给可能是 Safari 的系统默认浏览器。只有显式执行 `tokenless install --browsers chrome,brave` 才会绑定多个浏览器；默认的单浏览器配置可避免不同配置档争用同一队列。

## 运行请求

```bash
tokenless run \
  --provider chatgpt \
  --project-name "Website redesign" \
  --chat-name "Navbar review" \
  --project-root /path/to/project \
  --prompt-file /tmp/request.md \
  --context-file /tmp/shareable-context.md \
  --json
```

常规 `run` 无需扩展 ID。返回的 `taskId` 默认由项目和对话名称生成；后续轮次可继续传入 `--task-id`。在交给操作系统打开前，Tokenless 会确认指定或历史记录中的目标为 HTTPS，且主机名属于所选服务商。

`--no-open` 是严格模式：仅当存在新鲜且有效的扩展桥接标记时才会继续；否则会在创建任务前明确失败，不会将任务悄然留在队列中等待。

若预计服务商的可见任务将超过三分钟，请为 `run` 加上 `--long-running`。此模式将可见答案的等待时间延长至 35 分钟、守护进程任务的等待时间延长至 36 分钟，并持续输出进度心跳，同时保持 JSON 标准输出可供机器解析。

对于研究类回答，JSON 的 `result.read.sources` 会返回最终助手回答中可见的、去重后的直接 HTTPS 引用链接，以及其可见标题和域名；普通终端输出也会在正文后附上同一组来源。Tokenless 会排除服务商内部链接并移除常见追踪参数；不会从浏览器历史记录、存储空间或服务商 API 获取来源。

## 查询守护进程状态

```bash
tokenless state --task-id "project:Website redesign:chat:Navbar review" --json
```

`state` 通过精确的服务商和任务筛选，从 Rust 守护进程的 SQLite 存储中读取任务及其元数据，不读取旧版本地任务 JSON。返回结果不会暴露提示词正文或认领能力；已认证的命令行状态查询会完整保留守护进程的 `error_json`，以便智能体获得可操作的失败详情。扩展设置中的历史记录是另一项有界、仅含标量值的视图。

显式取消已分离或由外部追踪的任务：

```bash
tokenless cancel --job-id "<job-id>" --json
```

只有守护进程确认 `status: canceled` 才算成功。若 SIGINT、SIGTERM 或显式取消无法得到确认，命令行工具会以 `job_cancel_failed` 非零退出，并明确说明任务可能仍在运行，也可能已经完成。

## 获取脱敏 DOM 快照

```bash
tokenless snapshot-dom --provider chatgpt --json
```

快照使用同一条仅限守护进程、仅限服务商的唤醒路径。脱敏产物写入 `~/.tokenless/snapshots/<provider>/`；未标记为已脱敏的载荷会被拒绝。

## 节省 Token，不导出浏览器会话

Tokenless 适用于原本会再消耗一次付费模型或 API 调用的工作，例如研究、第二意见、草稿撰写、审查、解释和转换。它复用用户已在自己浏览器中打开的服务商会话，让智能体接收网页上可见的回答，而不接触用户的服务商凭证。

只有显式提供的提示词、可分享的当前轮次上下文和用户主动选择的项目文件会被提交到可见的服务商界面。Tokenless **不会**读取、导出、持久化或传输：

- 服务商 Cookie 或浏览器密码；
- `localStorage`、`sessionStorage` 中的 token；
- 隐藏的授权请求头或私有服务商后端 API；
- 浏览器历史记录、无关标签页，或获准服务商标签页以外的页面数据。

扩展仅在用户授予主机权限后工作，且只操作用户在页面上看得见的控件。登录、CAPTCHA、限流、权限弹窗及其他服务商确认仍完全由用户控制。

## 安全边界

Tokenless 仅在用户授予扩展主机权限后，通过用户可见的服务商页面工作。它不绕过登录、CAPTCHA、服务商权限、限流或可见确认；不读取服务商 Cookie、`localStorage`/`sessionStorage` token、隐藏授权请求头，也不调用隐藏的服务商后端接口。

本地数据处理细节见 [隐私政策](PRIVACY.md)。

守护进程 URL 必须是回环 HTTP 地址。每次发送 token 的请求前，命令行工具都会向 `/ready` 发送新的 32 字节质询，并使用本地主目录的 `daemon.token` 验证 HMAC-SHA256 证明；该证明同时绑定质询、两个协议版本和规范化主目录。仅猜中公开字段的伪造监听器无法获得持有者 token 或任务提示词。此后所有任务端点仍要求该持有者 token；`/health` 仅用于诊断。任务入队前还会检查原生消息大小。

## 软件包

以下软件包作为同版本集合发布：

- `tokenless`
- `tokenless-native-darwin-arm64`
- `tokenless-native-darwin-x64`
- `tokenless-native-linux-arm64`
- `tokenless-native-linux-x64`
- `tokenless-native-win32-arm64`
- `tokenless-native-win32-x64`

必须先发布全部六个原生软件包，再发布同版本的通用 `tokenless` 软件包；依赖使用精确版本，不使用 `workspace:*`。

以下软件包暂不发布：

- `tokenless-relay`
- `tokenless-client`
- `tokenless-browser-session-bridge`

## 开发

构建本仓库需要 Node.js 22+、npm 和 Rust。命令行工具的构建会将当前目标组合的发布二进制文件写入 `packages/cli/npm/tokenless-native-<platform>-<arch>/bin`；通用 `tokenless` 软件包执行 `npm pack` 时始终不包含二进制文件。原生软件包仅供发布者使用的预打包验证器，会在限定时间内执行两个二进制文件，并严格核验其角色、与 npm 对齐的版本及规范化目标组合，拒绝被调换或过期的产物。发布 CI 必须在可信且匹配的平台构建器上生成并打包六种目标组合：`darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-arm64`、`win32-x64`；全部发布后，才能发布通用软件包。正常运行仅解析本地可选软件包，绝不会在线下载可执行文件。

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

扩展构建产物位于 `packages/extension/dist/extension`。打开 `chrome://extensions`、开启开发者模式、选择 **加载已解压的扩展程序**，再选择该目录。然后绑定真实的开发扩展 ID：

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"
tokenless setup --extension-id "$TOKENLESS_EXTENSION_ID" --json
```

运行可见会话冒烟测试：

```bash
cat > /tmp/tokenless-request.md <<'EOF'
请只回复下面这一行文字，不要回复其他内容：

TOKENLESS_LOCAL_OK_48291
EOF

tokenless run \
  --provider chatgpt \
  --project-name "Tokenless local dev" \
  --chat-name "Smoke test" \
  --project-root "$(pwd)" \
  --prompt-file /tmp/tokenless-request.md \
  --read-timeout-ms 180000 \
  --json
```

成功标志为 `ok: true`，且 `compactOutput` 包含 `TOKENLESS_LOCAL_OK_48291`。
