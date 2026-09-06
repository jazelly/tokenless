# 更新 Tokenless API

`tokenless upgrade` 是 CLI 与 macOS 菜单应用的统一更新入口。Install 准备机器环境，Setup 更改用户选择，Upgrade 替换软件并保留这些选择。

## 检查与更新

```bash
tokenless upgrade --check --json
tokenless upgrade
# 非交互调用者显式确认：
tokenless upgrade --yes --json
```

检查更新是只读操作：不安装依赖、不启动 daemon、不迁移数据库。更新需要确认，因为 daemon 会重启，活跃任务可能中断；任务时机由 Tokenless Harness 协调。

| 安装形态 | 更新目标 |
| --- | --- |
| 全局 npm 包 | 已验证的全局 `tokenless` 安装位置，使用检查到的准确 npm 版本 |
| macOS 应用 | 整个已安装 App，包括内置 Node、CLI 和 daemon |
| 源码 checkout / 链接的开发 CLI | 更新并重新构建 checkout；更新器拒绝覆盖无关的全局安装 |

macOS 菜单使用相同的检查与更新实现。仅有 npm 新版本不代表 Mac App 可更新：对应的 macOS release 安装包和校验文件必须已可用。

只会提示手动安装的旧版 macOS App，需要先手动替换一次，安装包含本更新器的版本。修改仓库代码不会改变已经安装的 App。

## 更新做什么

1. 获取并验证所选安装包，再替换已安装的软件。
2. 只停止所选 home 下身份已验证的 Tokenless API daemon；macOS 更新还会停止所选菜单应用。
3. 替换安装包，然后调用新安装的 runtime。
4. 仅为已启用的 runtime 准备依赖，执行[数据库迁移](database-migrations.zh-CN.md)，同步内置 agent skills，并启动新版 daemon。
5. 验证运行版本、schema 版本及经过身份认证的本地 API 请求，再报告成功。

Upgrade 会同步两个内置 agent skills，即使软件已是当前版本也会同步。它不重跑 Setup、不启用 provider、不改变浏览器绑定、不重置配置，也不替换浏览器 profile。配置的 native 浏览器仍由用户管理。

失败时明确停止，不自动重试、重放任务或降级数据库。数据库迁移后，仅恢复旧可执行程序不构成完整回滚；不要用旧版程序打开新版 schema。

## Agent skills

npm 包与 macOS App 都包含配套的 `tokenless` 和 `tokenless-install` skills。Install、Setup 和 Upgrade 共用同一段本地同步逻辑，不依赖单独从 GitHub 下载，也不要求 App 使用全局 npm。

```bash
# 只刷新已安装版本的 skills，不运行 setup 或重启 daemon：
tokenless skills sync --json
# 源码用户拉取更新并构建 CLI 后：
npm run sync:skill
```

同步只替换 `~/.agents/skills` 及已有受支持 agent 目录中的这两个 skill，包含完整资源与默认提示。Doctor 会与安装包逐文件比较；若 agent 已加载旧指令，请重新加载会话。安装包用户通过 release automation 收到新版 skill，源码用户在拉取更新后需要执行同步。

## 本地安装包

显式选择本地安装包，可以离线安装和验证发布产物，无须先发布测试版本：

```bash
tokenless upgrade --package /absolute/path/tokenless-version.tgz --yes --json
```

使用 macOS 内置 CLI 时，选择对应的本地 release ZIP。仅使用可信的安装包。所选安装包允许重装同版本，但拒绝降级。

## 发布与验证

Release workflow 随 GitHub release 发布带版本号的 macOS 安装包及 SHA-256 校验文件。初始 macOS 目标是 Apple Silicon / macOS 13+；仍使用 ad-hoc 签名，没有 Developer ID 签名或 notarization。更新器不会绕过 Gatekeeper 或系统批准。

发布前需验证实际 npm 安装包和隔离位置中的 Mac App 更新，并检查配置及已有数据库记录保留。仅构建成功、下载成功或 `open -a` 成功不算完成更新的证据。

```bash
npm run build --workspace packages/cli
node --test test/npm-update.integration.test.mjs test/update-activation.integration.test.mjs
# On an Apple Silicon Mac:
node scripts/build-macos-menu.mjs
node --test test/macos-update.integration.mjs
```

这些检查只安装到临时目录。原生检查会启动并替换隔离的菜单应用，不会替换用户日常安装的应用。
