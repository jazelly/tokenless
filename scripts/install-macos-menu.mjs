#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceApp = path.join(repositoryRoot, 'dist', 'macos', 'Tokenless API.app')
const applicationsDirectory = path.join(os.homedir(), 'Applications')
const installedApp = path.join(applicationsDirectory, 'Tokenless API.app')

requireDirectory(sourceApp, 'built macOS app')
requireExecutable(path.join(sourceApp, 'Contents', 'MacOS', 'TokenlessMenuBar'), 'built menu app executable')
requireExecutable(path.join(sourceApp, 'Contents', 'Resources', 'runtime', 'node'), 'bundled Node runtime')
requireFile(
  path.join(sourceApp, 'Contents', 'Resources', 'runtime', 'cli', 'dist', 'src', 'tokenless.mjs'),
  'bundled CLI entrypoint',
)

fs.mkdirSync(applicationsDirectory, { recursive: true })
fs.rmSync(installedApp, { recursive: true, force: true })
fs.cpSync(sourceApp, installedApp, { recursive: true, dereference: true })

const appProcess = spawn('/usr/bin/open', ['-a', installedApp], {
  detached: true,
  stdio: 'ignore',
})
appProcess.unref()

console.log('Installed and launched Tokenless menu bar app / 已安装并启动 Tokenless 菜单栏应用。')

function requireExecutable(filePath, label) {
  const resolvedPath = resolveRealPath(filePath, label)
  const stat = fs.statSync(resolvedPath)
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file / ${label} 不是普通文件：${filePath}`)
  }
  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    throw new Error(`${label} is not readable and executable / ${label} 不可读或不可执行：${filePath}`)
  }
}

function requireFile(filePath, label) {
  const resolvedPath = resolveRealPath(filePath, label)
  if (!fs.statSync(resolvedPath).isFile()) {
    throw new Error(`${label} is not a regular file / ${label} 不是普通文件：${filePath}`)
  }
}

function requireDirectory(directoryPath, label) {
  const resolvedPath = resolveRealPath(directoryPath, label)
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`${label} is not a directory / ${label} 不是目录：${directoryPath}`)
  }
}

function resolveRealPath(filePath, label) {
  try {
    return fs.realpathSync(filePath)
  } catch {
    throw new Error(`${label} is missing / 缺少 ${label}：${filePath}`)
  }
}
