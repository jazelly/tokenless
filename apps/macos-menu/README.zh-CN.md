# Tokenless API macOS 菜单栏应用

本地 macOS 菜单栏应用使用原生 SwiftUI 为 Tokenless API daemon 提供以下界面：

- daemon 状态和版本；
- Dashboard 以及最近十个对话；
- 重启、退出、检查更新、升级和登录时启动；
- 根据持久化 Tokenless language 选择 English 或简体中文标签。

## 本地构建和安装

在这台 Apple Silicon Mac 上运行：

```bash
npm run build:macos-menu
npm run install:macos-menu
```

构建会生成 `dist/macos/Tokenless API.app` 和 `dist/macos/Tokenless API.zip`。它面向 macOS 13 或更高版本，使用仓库中的 `assets/tokenless-mark.png`，并为本地使用执行 ad-hoc 签名。Developer ID 签名、notarization 和对外分发暂时保留。

安装器会替换 `~/Applications/Tokenless API.app`，在调用安装器的 shell 中解析 `which tokenless`，并在 `~/Library/Application Support/Tokenless API/menubar-binding.json` 写入 mode-0600 binding。binding 保存绝对 Node executable、`which tokenless` 本身返回的绝对 command path（不解引用 symlink）、CLI entrypoint 和 Tokenless home，因此 GUI 不依赖 shell PATH，并能跟随 npm global upgrade。

Bundle identifier 使用本地专用的 `local.tokenless.api.menubar`。应用设置为 agent application（`LSUIElement=true`），所以只出现在菜单栏，不会显示 Dock 图标。
