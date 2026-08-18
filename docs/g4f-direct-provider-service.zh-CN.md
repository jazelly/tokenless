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

Daemon 不暴露 public G4F namespace route。请在标准 API proxy endpoint 上设置 `tokenless.execution_mode: direct`；所选 provider ID 会在内部映射到固定版本的 G4F provider。

| Route | 用途 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions；direct G4F plain-text request 在 `stream: true` 时保留 upstream SSE |
| `POST /v1/responses` | OpenAI Responses；direct G4F plain-text request 在 `stream: true` 时保留 upstream SSE，且不支持 Tokenless `previous_response_id` continuation |
| `POST /v1/images/generations` | Provider-neutral browser 或 direct image generation |

例如，direct GLM request 使用映射后的 Tokenless model ID：

```json
{
  "model": "tokenless/zai/GLM-4.7",
  "messages": [{"role": "user", "content": "Reply with OK."}],
  "stream": true,
  "tokenless": {"execution_mode": "direct"}
}
```

Direct ChatGPT image generation 使用同一个 provider-neutral image endpoint：

```json
{
  "model": "tokenless/chatgpt/gpt-image",
  "prompt": "A simple green leaf icon on a white background.",
  "tokenless": {"execution_mode": "direct"}
}
```

Image response 只包含 Tokenless asset URL 与已验证 metadata。Direct ChatGPT image failure 使用中性的 image error contract，不会暴露 private adapter name。

所有 route 都要求普通 Tokenless daemon bearer token。Provider guest mode 与 daemon authentication 相互独立；managed direct CLI execution 会在本地私下创建临时 provider auth context，并在 request 后删除。

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

- Guest：通过标准 API direct request 请求 `tokenless/zai/GLM-4.7`，不携带 provider credential，在隔离的 headless browser 中完成 Aliyun traceless verification，并要求返回精确随机 marker。
- 已登录：ChatGPT direct 只从选中的 Cloak browser profile 读取 ChatGPT cookies、access token、user agent 与 language headers，写入一个 provider-scoped 临时 context。
- 图片：真实 `tokenless/pollinations/sana` direct gate 通过统一 endpoint 生成了一张 768×768 JPEG，按请求提供的 task identity 落盘，并在不暴露 private backend 的前提下验证 digest 与 authenticated byte-for-byte readback。
- ChatGPT image：direct binding 从选定的 managed browser session 创建一个 provider-scoped 临时 auth context，并且只按请求提供的 task identity 持久化已验证图片 bytes。

## Provider 错误

G4F provider 调用失败时，Tokenless 对外返回 HTTP `502`，同时保留安全的 upstream diagnostics。Error code 会保留 G4F exception type，例如 `g4f_upstream_missing_auth_error` 或 `g4f_upstream_curl_error`；`upstream` 只包含 `status`、`type`、`category`、`provider` 与 `model`。

G4F 的自由文本 exception message 可能含有 provider session material，因此不会返回。OpenAI-compatible request 会在 OpenAI error envelope 中携带同一个具体 Tokenless code。
