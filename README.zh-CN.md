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
  <strong>通过浏览器使用你已有的 AI provider，无需 provider API Key。</strong><br>
  Tokenless 为 Agent 提供统一的本地可见 AI 工作流接口，同时减少 Agent 侧 token 消耗。
</p>

<p align="center">
  <a href="#三条命令开始使用">快速开始</a> · <a href="COMMANDS.zh-CN.md">CLI</a> · <a href="docs/capability-matrix.zh-CN.md">Capabilities</a> · <a href="PRIVACY.zh-CN.md">隐私</a>
</p>

<p align="center">
  <img src="assets/dashboard-hero.png" alt="真实 Tokenless 控制台显示已节省 2,475 个估算输出 token，并有一项 Kimi 任务正在运行" width="1600">
</p>

<p align="center"><sub>截图来自真实本地浏览器 session；token 总量与任务状态均为真实本地数据，不是 benchmark。</sub></p>

## 10 家 provider，一个本地接口

目前有 4 家 provider 受支持，另外 7 家处于实验阶段；未经验证的工作流会明确停止。

<table>
  <tr>
    <td align="center" width="20%"><img src="https://cdn.oaistatic.com/assets/favicon-miwirzcw.ico" alt="ChatGPT" width="32" height="32"><br><strong>ChatGPT</strong><br><sub>已支持</sub></td>
    <td align="center" width="20%"><img src="https://claude.ai/favicon.ico" alt="Claude" width="32" height="32"><br><strong>Claude</strong><br><sub>已支持</sub></td>
    <td align="center" width="20%"><img src="https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg" alt="Gemini" width="32" height="32"><br><strong>Gemini</strong><br><sub>已支持</sub></td>
    <td align="center" width="20%"><img src="https://grok.com/images/favicon.svg" alt="Grok" width="32" height="32"><br><strong>Grok</strong><br><sub>已支持</sub></td>
    <td align="center" width="20%"><img src="https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.2.83/favicon.png" alt="Qwen" width="32" height="32"><br><strong>Qwen / 千问</strong><br><sub>实验性</sub></td>
  </tr>
  <tr>
    <td align="center" width="20%"><img src="https://cdn.simpleicons.org/deepseek/4D6BFE" alt="DeepSeek" width="32" height="32"><br><strong>DeepSeek</strong><br><sub>实验性</sub></td>
    <td align="center" width="20%"><img src="https://cdn.simpleicons.org/perplexity/20808D" alt="Perplexity" width="32" height="32"><br><strong>Perplexity</strong><br><sub>实验性</sub></td>
    <td align="center" width="20%"><img src="https://z-cdn.chatglm.cn/z-ai/static/logo.svg" alt="Z.ai" width="32" height="32"><br><strong>Z.ai / GLM</strong><br><sub>实验性</sub></td>
    <td align="center" width="20%"><img src="https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/favicon/new-doubao/128x128.png" alt="Doubao" width="32" height="32"><br><strong>Doubao / 豆包</strong><br><sub>实验性</sub></td>
    <td align="center" width="20%"><img src="https://www.kimi.com/favicon-light.ico" alt="Kimi" width="32" height="32"><br><strong>Kimi</strong><br><sub>实验性</sub></td>
  </tr>
  <tr>
    <td align="center" width="20%"><img src="https://sf-flow-web-cdn.ciciai.com/obj/ocean-flow-web-sg/dola_web/favicon-dola.png" alt="Dola" width="32" height="32"><br><strong>Dola</strong><br><sub>实验性</sub></td>
  </tr>
</table>

每家 provider 已验证的工作流见 [Capability Matrix](docs/capability-matrix.zh-CN.md)。

## 三条命令开始使用

需要 Node.js 22.13+，以及能提供浏览器自主管理 remote debugging endpoint 的当前版 Google Chrome 或 Brave Browser；当前目标平台是 Apple Silicon macOS，Windows x64 仍处于 prerelease 阶段。

Setup 前，请在日常使用的 Google Chrome 中打开 `chrome://inspect/#remote-debugging`，或在 Brave 中打开 `brave://inspect/#remote-debugging`，启用 remote debugging，并确认浏览器的连接提示。底层 CDP endpoint 由浏览器管理、由 Tokenless 自动发现，因此不需要用 `--remote-debugging-port` 启动浏览器，也不需要配置固定端口。Tokenless 直接以连接是否成功判断能力，不复制 profile，也不启动另一份浏览器。

```bash
npm install --global tokenless@latest
tokenless setup
tokenless run --provider chatgpt --prompt "Review this proposal."
```

Setup 会先询问是否使用 Anti-Detect mode。若选择不使用，再选择 Google Chrome 或 Brave；Tokenless 随后创建逻辑 profile、连接正在运行的 headed 浏览器、检查已启用的 provider 并打开本地控制台。之后可用 `tokenless dashboard` 再次打开。

Native mode 目前只支持 headed。停止或重启 Tokenless daemon 只会断开自动化连接，不会关闭所选浏览器。

显式启用 Anti-Detect setup 时，也可以在 macOS arm64/x64、Linux arm64/x64 或 Windows x64 上从 CloakBrowser 官方 GitHub release 安装经过 checksum 固定的版本。这些 catalog 路径不代表已在每类真实 host 上完成 provider 验收；Tokenless 不会捆绑或再分发 CloakBrowser。

## Agent 可以获得什么

- 通过真实 provider 网站发送 prompt，并读取可见 response 和 citation。
- 上传文件，并使用已验证的 model、reasoning 和 provider-specific controls。
- 保留稳定的 provider tab、task continuity 和受支持的 native Project。
- Browser state 和 credential 留在你的 Chrome 中；job history 与 token 节省估算保留在本机。

## 可选的 Codex 集成

安装委派指引和精确调用连续性，不会包装或替换 Codex：

```bash
tokenless setup --install-codex
# 也可以在 setup 后单独安装：
tokenless agents install codex
```

Setup 默认不会安装该集成；`--codex-home <dir>` 只能与 `--install-codex` 一起使用。重启 Codex，打开 `/hooks`，然后信任 Tokenless hook definition。

## 深入了解

- [CLI 命令](COMMANDS.zh-CN.md)
- [Capability Matrix](docs/capability-matrix.zh-CN.md)
- [隐私边界](PRIVACY.zh-CN.md)
- [架构](docs/architecture.md)
- [文档索引](docs/README.zh-CN.md)

Tokenless 仍处于内测阶段：它会减少 Agent 侧 token 消耗，但不会完全消除 token 消耗，也不会绕过 provider 的账号要求。
