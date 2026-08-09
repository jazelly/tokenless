<p align="center">
  <img src="assets/tokenless-wordmark.png" alt="Tokenless" width="560">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/v/tokenless?logo=npm&amp;label=version" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/tokenless"><img src="https://img.shields.io/npm/dm/tokenless?logo=npm&amp;label=downloads" alt="npm monthly downloads"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <strong>Use the AI providers you already have—through the browser, without provider API keys.</strong><br>
  Tokenless gives agents one local interface for visible AI workflows while reducing agent-side token use.
</p>

<p align="center">
  <a href="#start-in-three-commands">Quick start</a> · <a href="COMMANDS.md">CLI</a> · <a href="docs/capability-matrix.md">Capabilities</a> · <a href="PRIVACY.md">Privacy</a>
</p>

<p align="center">
  <img src="assets/dashboard-hero.png" alt="Real Tokenless dashboard showing 2,475 estimated output tokens saved and one running Kimi job" width="1600">
</p>

<p align="center"><sub>Captured from a real local browser session; token totals and job states are actual local dashboard data, not a benchmark.</sub></p>

## 10 providers. One local interface.

Four providers are supported today; seven more are experimental and fail closed when a workflow is not verified.

<table>
  <tr>
    <td align="center" width="20%"><img src="https://cdn.oaistatic.com/assets/favicon-miwirzcw.ico" alt="ChatGPT" width="32" height="32"><br><strong>ChatGPT</strong><br><sub>Supported</sub></td>
    <td align="center" width="20%"><img src="https://claude.ai/favicon.ico" alt="Claude" width="32" height="32"><br><strong>Claude</strong><br><sub>Supported</sub></td>
    <td align="center" width="20%"><img src="https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg" alt="Gemini" width="32" height="32"><br><strong>Gemini</strong><br><sub>Supported</sub></td>
    <td align="center" width="20%"><img src="https://grok.com/images/favicon.svg" alt="Grok" width="32" height="32"><br><strong>Grok</strong><br><sub>Supported</sub></td>
    <td align="center" width="20%"><img src="https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.2.83/favicon.png" alt="Qwen" width="32" height="32"><br><strong>Qwen / 千问</strong><br><sub>Experimental</sub></td>
  </tr>
  <tr>
    <td align="center" width="20%"><img src="https://cdn.simpleicons.org/deepseek/4D6BFE" alt="DeepSeek" width="32" height="32"><br><strong>DeepSeek</strong><br><sub>Experimental</sub></td>
    <td align="center" width="20%"><img src="https://cdn.simpleicons.org/perplexity/20808D" alt="Perplexity" width="32" height="32"><br><strong>Perplexity</strong><br><sub>Experimental</sub></td>
    <td align="center" width="20%"><img src="https://z-cdn.chatglm.cn/z-ai/static/logo.svg" alt="Z.ai" width="32" height="32"><br><strong>Z.ai / GLM</strong><br><sub>Experimental</sub></td>
    <td align="center" width="20%"><img src="https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/favicon/new-doubao/128x128.png" alt="Doubao" width="32" height="32"><br><strong>Doubao / 豆包</strong><br><sub>Experimental</sub></td>
    <td align="center" width="20%"><img src="https://www.kimi.com/favicon-light.ico" alt="Kimi" width="32" height="32"><br><strong>Kimi</strong><br><sub>Experimental</sub></td>
  </tr>
  <tr>
    <td align="center" width="20%"><img src="https://sf-flow-web-cdn.ciciai.com/obj/ocean-flow-web-sg/dola_web/favicon-dola.png" alt="Dola" width="32" height="32"><br><strong>Dola</strong><br><sub>Experimental</sub></td>
  </tr>
</table>

See the [Capability Matrix](docs/capability-matrix.md) for the verified workflows behind each provider.

## Start in three commands

Requires Node.js 22.13+ and stable Google Chrome 144 or newer. Apple Silicon macOS is the current target, and Windows x64 remains prerelease.

Before setup, open `chrome://inspect/#remote-debugging` in your everyday Chrome, enable remote debugging, and approve Chrome's connection prompt. Tokenless tests capability by connecting; it does not copy your profile or launch another browser.

```bash
npm install --global tokenless@latest
tokenless setup
tokenless run --provider chatgpt --prompt "Review this proposal."
```

Setup creates a logical Tokenless profile, connects to your running headed Chrome, checks enabled providers, and opens the local dashboard; reopen it later with `tokenless dashboard`.

Native mode is headed-only for now. Stopping or restarting the Tokenless daemon disconnects automation but does not close Chrome.

## What agents get

- Prompts, visible responses, and citations through real provider websites.
- File uploads plus verified model, reasoning, and provider-specific controls.
- Stable provider tabs, task continuity, and supported native Projects.
- Browser state and credentials remain in your Chrome; job history and token-savings estimates remain local.

## Optional Codex integration

Install delegation guidance and exact invocation continuity without wrapping or replacing Codex:

```bash
tokenless setup --install-codex
# Or install it separately after setup:
tokenless agents install codex
```

Setup never installs the integration by default; `--codex-home <dir>` is available only with `--install-codex`. Restart Codex, open `/hooks`, and trust the Tokenless hook definition.

## Go deeper

- [CLI commands](COMMANDS.md)
- [Capability Matrix](docs/capability-matrix.md)
- [Privacy boundaries](PRIVACY.md)
- [Architecture](docs/architecture.md)
- [Documentation index](docs/README.md)

Tokenless is in early access: it reduces agent-side token use, but does not eliminate token use or bypass provider account requirements.
