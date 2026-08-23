# Tokenless macOS 菜单栏应用

本地 macOS 菜单栏应用使用原生 SwiftUI 为 Tokenless daemon 提供以下界面：

- daemon 状态和版本；
- Dashboard 以及最近十个对话；
- 重启、退出、检查更新和登录时启动 Tokenless；
- 根据持久化 Tokenless language 选择 English 或简体中文标签。

## 本地构建和安装

在安装好仓库依赖的 Apple Silicon Mac 上运行：

```bash
npm run build:macos-menu
npm run install:macos-menu
```

`build:macos-menu` 会先构建 CLI，再生成 `dist/macos/Tokenless.app` 和 `dist/macos/Tokenless.zip`。它面向 macOS 13 或更高版本，并内置 arm64 Node runtime、CLI、daemon 及 production Node dependencies，不使用安装机器上的 Node、nvm、Homebrew 或全局 `tokenless` 命令。

安装器会替换并启动 `~/Applications/Tokenless.app`。菜单应用使用内置 runtime 和用户默认的 `~/.tokenless` home，不创建也不依赖 `menubar-binding.json`；已有 binding 文件会被忽略。

Bundle identifier 使用本地专用的 `local.tokenless.api.menubar`。应用设置为 agent application（`LSUIElement=true`），所以只出现在菜单栏，不会显示 Dock 图标。

应用启动时会立即执行内置的 `tokenless menubar status --json`，确保 Tokenless daemon 已就绪。因此开启“登录时启动 Tokenless”就会启动完整的本地 Tokenless 控制面，包括由 daemon 提供的 Dashboard；provider 浏览器仍然按需启动。

基础 app 会刻意排除 G4F Python virtual environment 和浏览器二进制。它们仍是独立的按需 runtime，只有用户显式配置对应 provider/runtime 时才会启动，不会随登录启动自动运行。

菜单里的更新检查只提供信息。要升级内置 runtime，请安装最新的 macOS app package；应用不会执行全局 npm upgrade。
