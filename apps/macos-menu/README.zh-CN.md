# Tokenless macOS 菜单栏应用

本地 macOS 菜单栏应用使用原生 SwiftUI 为 Tokenless daemon 提供以下界面：

- daemon 状态和版本；
- Dashboard 以及最近十个对话；
- 重启、退出、检查更新和登录时启动 Tokenless；
- 根据持久化 Tokenless language 选择 English 或简体中文标签。

## 本地构建和安装

在安装好仓库依赖的 Apple Silicon Mac 上，首次安装或升级都运行：

```bash
npm run install:macos-menu
```

`build:macos-menu` 会先构建 CLI，再生成 `dist/macos/Tokenless.app`、带版本号的 `dist/macos/tokenless-macos-darwin-arm64-v<version>.zip` 及匹配的 `.sha256` 文件。它面向 macOS 13 或更高版本，并内置 arm64 Node runtime、CLI、daemon 及 production Node dependencies，不使用安装机器上的 Node、nvm、Homebrew 或全局 `tokenless` 命令。

`npm run install:macos-menu` 会重新构建 bundle，先复制到同目录的 staging 路径，并检查 app 目录、菜单栏可执行文件、内置 Node runtime 和内置 CLI，然后替换 `~/Applications/Tokenless.app`。如果已安装的菜单栏应用正在运行，安装器只按该可执行文件的精确路径查找进程，发送 `SIGTERM` 并短暂等待退出；不会停止 Tokenless daemon。新版通过校验并且 LaunchServices 接受启动请求前，旧版会保留在同目录的 backup 路径。如果 staging、替换、校验或启动请求失败，旧 bundle 会恢复；如果升级前旧版正在运行，还会重新启动旧版。

首次安装时没有旧 bundle 可恢复。成功后只保留 `~/Applications/Tokenless.app`，并清理本次命令创建的 staging 和 backup 路径。LaunchServices 接受 `open -a` 只表示 macOS 接受了启动请求，不能检测之后发生的 crash，因此安装器不声称能对启动后的 crash 自动回滚。

菜单应用使用内置 runtime 和用户默认的 `~/.tokenless` home，不创建也不依赖 `menubar-binding.json`；已有 binding 文件会被忽略。

Bundle identifier 使用本地专用的 `local.tokenless.api.menubar`。应用设置为 agent application（`LSUIElement=true`），所以只出现在菜单栏，不会显示 Dock 图标。

应用启动时会立即执行内置的 `tokenless menubar status --json`，确保 Tokenless daemon 已就绪。因此开启“登录时启动 Tokenless”就会启动完整的本地 Tokenless 控制面，包括由 daemon 提供的 Dashboard；provider 浏览器仍然按需启动。

基础 app 会刻意排除 G4F Python virtual environment 和浏览器二进制。它们仍是独立的按需 runtime，只有用户显式配置对应 provider/runtime 时才会启动，不会随登录启动自动运行。

菜单里的“检查更新”和确认后的更新操作共用 `tokenless upgrade` 入口。更新会替换整个 app，保留所选 home，执行随包发布的数据库 migration，并验证新版 daemon 和已认证 API 后才报告成功；应用不会执行全局 npm upgrade。发布渠道和失败处理见[更新指南](../../docs/updates.zh-CN.md)。

只有提示信息的旧版已安装 app，需要先手动替换一次，才能获得这个 updater。
