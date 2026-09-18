# Tokenless API Windows 托盘

适用于 Windows 10 和 Windows 11 的原生通知区域应用。左键在默认浏览器中打开 Dashboard；右键打开菜单。无需单独的应用窗口或内嵌浏览器。

- 实时显示 daemon 状态和版本、活跃任务数、活跃浏览器 Profile 数，以及最近十个会话。
- 打开 Dashboard、刷新状态、重启和检查 CLI 更新。
- 可选的登录启动；默认关闭，需在菜单中开启。
- 重启、更新检查和登录启动切换通过 Windows 原生通知明确反馈，无需打开额外窗口。
- 可仅退出托盘，或停止 Tokenless API 并退出。有任务运行时，停止或重启会请求确认。
- 中英文跟随 Windows 首选 UI 语言；只有 Windows 没有提供语言时，才使用 `~/.tokenless/config.json` 中的 `language`。
- 图标使用深色和浅色两套渲染，根据 Windows shell 主题自动切换，在浅色和深色任务栏上都保持清晰。

## 构建与启动

在已安装 Node.js 22.13+ 和仓库依赖的源码目录运行：

```powershell
npm run install:windows-menu
```

命令会构建 CLI 和原生应用，创建名为 **Tokenless API** 的开始菜单快捷方式，并启动托盘。使用 Windows 自带的 .NET Framework 编译器，无需 Electron 或额外的 .NET SDK。图标直接显示在任务栏还是收在折叠箭头中，由 Windows 决定。

`npm run build:windows-menu` 构建 CLI 和 `dist/windows/TokenlessApiTray.exe`，但不启动托盘。构建前会停止空闲 daemon 以释放旧文件；有活动任务时会阻止构建。替换应用时现有托盘会退出。同一 Windows 会话内重复启动只保留一个实例。

### 验证 Windows 行为

构建后，在已解锁的 Windows 会话中运行 `npm run verify:windows-menu`。检查器从隐藏的 GUI 进程执行状态查询和 Dashboard 准备命令，出现新的 Console Host 或 Windows Terminal 窗口就会失败；同时检查托盘启动、单实例和正常退出。检查期间请勿另开终端。默认读取当前 API home，可用 `-- --home <path>` 指定另一个已配置的 home。检查不会打开 provider 浏览器或修改 profiles。

## 运行方式与移除

这是**连接本地源码的开发版应用**，不是独立发布包。`dist/windows/runtime.json` 记录构建机器上 Node 和已构建 CLI 的绝对路径。请保留源码目录和 Node 安装；移动任一位置后需要重新安装。生产行为仍由现有 Tokenless API `config.json` 控制，运行时路径记录不会覆盖配置。

应用使用默认的 `~/.tokenless` home，通过 `menubar status --json` 启动本地 daemon。Dashboard 和会话通过现有 CLI 打开，不读取浏览器凭据。Provider 浏览器仍由现有 daemon 控制。命令在后台运行，不弹出控制台窗口。

检查更新使用 `upgrade --check`；源码和托盘升级需要更新并重新构建仓库。此应用不会替换源码或用 npm 发布版覆盖源码。当前不包含 Windows 发布包和应用自动替换功能。

移除时，先关闭**登录时启动**，选择**仅退出托盘**，再删除开始菜单中的 **Tokenless API** 快捷方式。可选启动项位于当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Tokenless API`，无需管理员权限。配置、profiles 和浏览器数据都会保留。
