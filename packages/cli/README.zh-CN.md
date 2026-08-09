# Tokenless CLI

`tokenless` 让 agent 通过本机 CLI 使用你正在运行的 Google Chrome 中可见的 AI 网站。Provider 凭据和浏览器状态始终保留在本机 Chrome 中。

[English](README.md) · [命令参考](https://github.com/jazelly/tokenless/blob/main/COMMANDS.zh-CN.md) · [能力矩阵](https://github.com/jazelly/tokenless/blob/main/docs/capability-matrix.zh-CN.md) · [隐私](https://github.com/jazelly/tokenless/blob/main/PRIVACY.zh-CN.md)

## 安装

需要 Node.js 22.13+ 和稳定版 Google Chrome 144+。

```bash
npm install --global tokenless@latest
tokenless setup
tokenless doctor --json
```

在 setup 前，请在已使用的 Chrome 中打开 `chrome://inspect/#remote-debugging`、启用 remote debugging，并在 Chrome 出现提示时确认连接。Tokenless 自动发现 Chrome 管理的 CDP endpoint；不要传入固定端口，也不会复制浏览器 profile 或读取凭据。

## 运行任务

```bash
tokenless run --profile default --provider chatgpt --prompt "Review this proposal." --json
```

使用 `tokenless capabilities list --json` 查看证据支持的任务结果和 provider 路由。`--capability` 可以重复提供；一个 provider 必须满足合并后的全部要求。

## Profile 与浏览器

一个 Tokenless profile 可包含多个已启用 provider 的 tab。Profile 组织 Tokenless 维护的 tab 和配置，不会创建独立 Chrome identity，也不会导出 cookies、tokens、browser storage 或 Keychain 数据。

```bash
tokenless profiles list --json
tokenless profiles open --profile work
tokenless profiles status --profile work --provider chatgpt --json
```

本机 daemon 与 Playwright worker 只通过经过认证的 loopback 接口通信。登录、CAPTCHA、同意、付款、方案和确认始终可见并由你控制。

## Codex 集成（可选）

```bash
tokenless agents install codex
```

重启 Codex 后，在 `/hooks` 中信任 Tokenless 定义即可。该集成可通过 `tokenless agents status codex` 检查，并可用 `tokenless agents uninstall codex` 移除。
