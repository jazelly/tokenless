# GPT4Free direct provider service

Tokenless setup 会安装一个固定版本的私有 GPT4Free HTTP service。Tokenless daemon 仍是唯一 public API，并拥有 profile、feature flag、visible-browser automation 与 session scope。

```text
Caller -> Tokenless daemon API -> native direct adapter
                               -> private G4F service -> provider HTTP
                                                      -> 隔离的 headless browser，用于 provider challenge
Tokenless managed browser -----^ 只负责 session bootstrap
```

## Runtime 固定

| Dependency | 固定值 |
|---|---|
| Python | `3.12` |
| GPT4Free | `g4f[all]==8.1.2` |
| GPT4Free commit reference | `fdbd84b7c5129ea8faa7c66065425ca344ea5fb2` |
| PA providers | `6f9be4e8ae489ea9d66755d99afda478e970c0c1` |

精确 `uv.lock` 包含 `curl-cffi`、`browser-cookie3`、`zendriver` 与 `platformdirs`。Setup 下载 Python environment 与 PA providers；npm package 只包含 Tokenless wrapper、lock 和 notice。

## Backend 选择

Direct execution 与 provider backend 是两个独立选择：

```bash
tokenless run --profile default --provider chatgpt \
  --execution-mode direct --provider-backend g4f \
  --prompt "Reply with OK" --json
```

保留的 native ChatGPT 或 Perplexity 实现使用 `--provider-backend native`。持久默认值位于 `directProvider.defaultBackend` 与 `directProvider.providerBackends`。

## Authenticated daemon API

所有 route 都要求普通 Tokenless daemon bearer token。
Provider guest mode 与 daemon authentication 相互独立：data-plane request 不携带 `x-tokenless-auth-context` 时，Tokenless 不会注入 browser 或已存储的 provider credential。

| Route | 用途 |
|---|---|
| `GET /v1/direct/g4f/providers` | 精确 provider inventory |
| `GET /v1/direct/g4f/providers/{provider}/models` | Provider models |
| `GET /v1/direct/g4f/providers/{provider}/quota` | Provider quota |
| `POST /v1/direct/g4f/auth-contexts/{id}` | 创建 scoped auth context |
| `GET /v1/direct/g4f/auth-contexts` | 列出不含 session value 的 context metadata |
| `POST /v1/direct/g4f/auth-contexts/{id}/files` | 上传 `.har` 或 cookie `.json` |
| `DELETE /v1/direct/g4f/auth-contexts/{id}` | 删除 context 与 private files |
| `POST /v1/direct/g4f/{provider}/chat/completions` | Chat completion 与 SSE |
| `POST /v1/direct/g4f/{provider}/responses` | Responses API |
| `POST /v1/direct/g4f/{provider}/messages` | Messages API |
| `POST /v1/direct/g4f/{provider}/images/generations` | Image generation |
| `POST /v1/direct/g4f/{provider}/audio/transcriptions` | Audio transcription |
| `POST /v1/direct/g4f/{provider}/audio/speech` | Speech generation |
| `GET /v1/direct/g4f/assets/{images|media}/{file}` | Generated media |
| `GET /v1/direct/g4f/pa/providers` | Setup 管理的 PA inventory |

`chatgpt` 等已知 Tokenless ID 会映射到固定 upstream provider。精确 G4F provider 使用 `g4f:<ProviderName>`，包括显式 `g4f:AnyProvider`；Tokenless 永远不会静默选择 `AnyProvider`。

Auth source type 包括 `empty`、`manual`、`har`、`cookie-file`、`browser-cookie3`、`cookie-database` 与 loopback `cdp`。两种 Cookie DB source 都必须提供位于所选 managed profile 内的精确 database path；不允许无 scope 的 browser scanning。Manual value 仅限所选 provider domain。

macOS 会禁用 `browser-cookie3` 与直接 Cookie DB 解密，因为该 library 会调用 Keychain CLI。请使用 Tokenless managed CDP/session bridge，让 credential access 留在正在运行的 browser 内。

`ephemeral` context 只存在于当前 service process。`user-persisted` context 会以 `0600` 权限把 provider-scoped source material 保存到本地 Tokenless home，并在 daemon 重启后重新加载。

上传的 HAR 会在保存前缩减为所选 provider domain 的 request。Cookie JSON 中只要包含其他 provider scope 的 cookie 就会被拒绝。

## 隔离

- Service 使用动态 loopback port 与临时 private credential。
- 一个 worker 在完整 response stream 期间串行化 auth activation。
- 每个 auth context 使用独立 private directory；activation 前会清理 provider class auth state。
- Stock request log、wildcard CORS、GUI、docs、OpenAPI、cookie upload 与 runtime PA download route 均不可达。
- G4F 自己启动的 browser 会被强制设为 headless；它可以计算 provider challenge token，但不暴露 provider UI。自动发现其他 CDP browser 已禁用；只有显式选择的 `cdp` auth source 才能连接现有 browser。
- Provider session value 不会进入 caller response、daemon error、telemetry 或 service log。

Visible-browser execution 继续由 Tokenless 原生实现。ChatGPT G4F direct 未显式指定 auth context 时，Tokenless 只从所选 managed browser 读取该 provider session，创建临时 provider-scoped G4F auth cache，并在请求后删除。

真实 E2E 同时覆盖两种认证边界：

- Guest：显式请求 `g4f:GLM`，不携带 provider auth-context header，在隔离的 headless browser 中完成 Aliyun traceless verification，要求返回精确随机 marker，并验证请求前后没有创建 auth context。
- 已登录：ChatGPT direct 只从选中的 Cloak browser profile 读取 ChatGPT cookies、access token、user agent 与 language headers，写入一个 provider-scoped 临时 context。

## Provider 错误

G4F provider 调用失败时，Tokenless 对外返回 HTTP `502`，同时保留安全的 upstream diagnostics。Error code 会保留 G4F exception type，例如 `g4f_upstream_missing_auth_error` 或 `g4f_upstream_curl_error`；`upstream` 只包含 `status`、`type`、`category`、`provider` 与 `model`。

G4F 的自由文本 exception message 可能含有 provider session material，因此不会返回。OpenAI-compatible request 会在 OpenAI error envelope 中携带同一个具体 Tokenless code。
