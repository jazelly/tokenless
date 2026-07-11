# Tokenless

Tokenless 帮 agent 省 token：把适合的工作交给用户已经登录的、可见的 ChatGPT、Claude 或 Gemini 网页版，再把网页中可见的回答返回给 agent。

English version: [README.md](README.md)

## 核心价值

第二意见、research-style 问答、草稿、解释、review 和简单转换，通常不值得再消耗一次付费 API 调用。Tokenless 给 agent 一个本地 CLI 入口，只操作用户能看见的 provider UI，并把可见结果接回 agent 流程。

## 它怎么工作

1. Agent 调用 `npx tokenless run`。
2. CLI 确认所请求 home 对应的 Rust daemon 已就绪；没有运行时会自动启动 package 自带的 binary。
3. 如果扩展的 Rust Native Messaging bridge 已存活，CLI 就不预先打开 wake tab；否则只在配置的 Chromium 浏览器里打开所选 provider 的、经过校验的 HTTPS 页面。扩展随后会复用已批准的 provider tab，必要时只打开一个 provider tab。默认 provider 是 ChatGPT。
4. 扩展只通过可见 DOM 提交 prompt 并读取回答。
5. Rust host 完成 daemon job，CLI 把可见结果返回给 agent。

它没有本地 JSON task queue fallback、task page、local-file page、Node native host，也不会自动打开任何 `chrome-extension://` 页面。

## 安装

安装 CLI 和 agent skill：

```bash
npm install -g tokenless
npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless
```

从 Chrome Web Store、未打包目录或 zip package 安装 Tokenless 扩展，然后做一次本机设置：

```bash
tokenless install
tokenless doctor --json
```

发布版 extension id 已内置。未打包的开发扩展只需在安装时覆盖一次：

```bash
tokenless install --extension-id "<chrome-extension-id>" --json
```

Universal `tokenless` package 只包含 JavaScript。npm 会按 OS/CPU 选择同版本 optional dependency，其中包含 `tokenless-daemon` 和 `tokenless-native-host`；`install` 再把这些本地 binary 复制到 `~/.tokenless/bin`，写入唯一且精确的 native-host allowed origin，默认只绑定一个选定 Chromium 浏览器，并确认 daemon 可以启动。运行时不会下载 executable，也没有 install script；终端用户不需要 Cargo。

按需配置 provider 顺序和浏览器：

```bash
tokenless config --preferred-providers chatgpt,claude,gemini --browser chrome --json
```

没有配置 browser 时，setup 会按 Chrome、Brave、Edge、Arc、Chromium 的顺序确定性检测。Tokenless 不会把 provider URL 交给可能是 Safari 的系统默认浏览器。只有用户显式执行 `tokenless install --browsers chrome,brave` 时才会绑定多个浏览器；默认单浏览器可以避免不同 profile 竞争同一个队列。

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

普通 `run` 不需要 extension id。返回的 `taskId` 默认由 project/chat name 派生；后续 turn 可以继续传 `--task-id`。Tokenless 在交给 OS 打开之前，会确认显式或历史 target 是 HTTPS，而且 hostname 属于所选 provider。

`--no-open` 是严格模式：只有新鲜且存活的 extension bridge marker 已存在时才继续；否则在创建 job 前清楚失败，不会把任务静默留在队列里等待。

## 查询 daemon state

```bash
tokenless state --task-id "project:Website redesign:chat:Navbar review" --json
```

`state` 通过精确 provider/task filter 从 Rust daemon 的 SQLite store 读取 job 和 task metadata，不读取旧的本地 job JSON。返回视图不会暴露 prompt body 或 claim capability；经过认证的 CLI state 会完整保留 daemon `error_json`，让 agent 得到可操作的失败详情。Extension Settings history 是另一条 bounded scalar-only 视图。

显式取消 detached 或外部跟踪的 job：

```bash
tokenless cancel --job-id "<job-id>" --json
```

只有 daemon 确认 `status: canceled` 才算成功。SIGINT/SIGTERM 或显式取消无法确认时，CLI 会以 `job_cancel_failed` 非零退出，并明确说明 job 可能仍在运行，也可能已经完成。

## 获取脱敏 DOM snapshot

```bash
tokenless snapshot-dom --provider chatgpt --json
```

Snapshot 走同一条 daemon-only、provider-only wake 路径。脱敏 artifacts 写入 `~/.tokenless/snapshots/<provider>/`；未标记为 sanitized 的 payload 会被拒绝。

## 安全边界

Tokenless 只在用户授权 extension host permission 后，通过用户可见的 provider 页面工作。它不绕过登录、CAPTCHA、provider 权限、限流或可见确认；它不读取 provider cookies、localStorage/sessionStorage token、隐藏 auth header，也不会调用隐藏的 provider 后端接口。

Daemon URL 必须是 loopback HTTP。每次发送 token 的请求之前，CLI 都会向 `/ready` 发送新的 32-byte challenge，再用 home-local `daemon.token` 校验 HMAC-SHA256 proof；proof 同时绑定 challenge、两个 protocol version 和 canonical home。只猜中公开字段的伪造 listener 得不到 bearer token 或 job prompt。随后所有 job endpoint 仍要求该 bearer token；`/health` 只用于 diagnostic。Job 入队前还会做 native message size 检查。

## Packages

作为同版本集合发布：

- `tokenless`
- `tokenless-native-darwin-arm64`
- `tokenless-native-darwin-x64`
- `tokenless-native-linux-arm64`
- `tokenless-native-linux-x64`
- `tokenless-native-win32-arm64`
- `tokenless-native-win32-x64`

必须先发布全部六个 native package，再发布同版本 universal `tokenless`；依赖使用精确版本，不使用 `workspace:*`。

暂不发布：

- `tokenless-relay`
- `tokenless-client`
- `tokenless-browser-session-bridge`

## 开发

构建 repository 需要 Node.js 22+、npm 和 Rust。CLI build 会把当前 tuple 的 release binary 写入 `packages/cli/npm/tokenless-native-<platform>-<arch>/bin`；universal `tokenless` 的 `npm pack` 始终不含 binary。Native package 的 publisher-only prepack verifier 会在有限时限内执行两个 binary，并严格核对角色、与 npm 对齐的版本及规范化 target tuple，拒绝交换或过期的 artifact。Release CI 必须在可信且匹配的平台 builder 上生成并打包六个 tuple：`darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-arm64`、`win32-x64`，全部发布后再发布 universal package。正常运行只解析本地 optional package，绝不会在线下载 executable。

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

扩展输出在 `packages/extension/dist/extension`。打开 `chrome://extensions`、开启 developer mode、选择 **Load unpacked**，再选择该目录。然后绑定真实开发 extension id：

```bash
export TOKENLESS_EXTENSION_ID="<chrome-extension-id>"
tokenless install --extension-id "$TOKENLESS_EXTENSION_ID" --json
tokenless doctor --json
```

运行 visible-session smoke test：

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

成功信号是 `ok: true`，而且 `compactOutput` 包含 `TOKENLESS_LOCAL_OK_48291`。
