#!/usr/bin/env node

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceApp = path.join(repositoryRoot, 'dist', 'macos', 'Tokenless.app')
const installedApp = path.join(os.homedir(), 'Applications', 'Tokenless.app')

try {
  // The build is a prerequisite of this script, so the shared replacement
  // implementation is available in the package's compiled dist tree.
  const { replaceMacOSApp } = await import('../packages/cli/dist/src/commands/macos-app-replacement.mjs')
  const result = await replaceMacOSApp({
    sourceAppPath: sourceApp,
    installedAppPath: installedApp,
  })
  const action = result.hadInstalledApp ? 'Upgraded' : 'Installed'
  const actionZh = result.hadInstalledApp ? '已升级' : '已安装'
  console.log(`${action} and launched Tokenless menu bar app / ${actionZh}并启动 Tokenless 菜单栏应用。`)
} catch (error) {
  console.error(`Install failed / 安装失败：${formatError(error)}`)
  process.exitCode = 1
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
