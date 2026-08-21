#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceApp = path.join(repositoryRoot, 'dist', 'macos', 'Tokenless API.app')
const applicationsDirectory = path.join(os.homedir(), 'Applications')
const installedApp = path.join(applicationsDirectory, 'Tokenless API.app')
const bindingDirectory = path.join(os.homedir(), 'Library', 'Application Support', 'Tokenless API')
const bindingPath = path.join(bindingDirectory, 'menubar-binding.json')

if (!fs.existsSync(sourceApp)) {
  throw new Error('Built macOS app not found. Run npm run build:macos-menu first. / 找不到已构建的 macOS app，请先运行 npm run build:macos-menu。')
}

const cliCommand = resolveTokenlessCommand()
const cliEntrypoint = cliCommand
const nodeExecutable = fs.realpathSync(process.execPath)
const homeDirectory = path.resolve(process.env.TOKENLESS_HOME || path.join(os.homedir(), '.tokenless'))

validateCliEntrypoint(cliEntrypoint)

fs.mkdirSync(applicationsDirectory, { recursive: true })
fs.rmSync(installedApp, { recursive: true, force: true })
fs.cpSync(sourceApp, installedApp, { recursive: true })

fs.mkdirSync(bindingDirectory, { recursive: true, mode: 0o700 })
const binding = {
  schema: 'tokenless.macos-menu-binding.v1',
  nodeExecutable,
  cliEntrypoint,
  homeDirectory,
}
fs.writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(bindingPath, 0o600)

const appProcess = spawn('open', ['-a', installedApp], {
  detached: true,
  stdio: 'ignore',
})
appProcess.unref()

console.log('Installed Tokenless API menu bar app / 已安装 Tokenless API 菜单栏应用。')
console.log('The app was launched and uses the bound local CLI / 应用已启动，并使用绑定的本地 CLI。')

function resolveTokenlessCommand() {
  let command
  try {
    command = execFileSync('which', ['tokenless'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new Error('Cannot resolve tokenless with which. Build or link the CLI, then rerun the macOS installer. / 无法用 which 解析 tokenless；请先 build 或 link CLI，再重新运行 macOS installer。')
  }
  if (!command || !path.isAbsolute(command)) {
    throw new Error('which tokenless did not return an absolute CLI path. / which tokenless 未返回绝对 CLI 路径。')
  }
  return command
}

function validateCliEntrypoint(command) {
  try {
    const entry = fs.lstatSync(command)
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('not a file or symlink')
    fs.accessSync(command, fs.constants.R_OK)
  } catch {
    throw new Error(`The tokenless CLI entrypoint resolved by which is not a readable file or symlink / which 解析出的 tokenless CLI entrypoint 不是可读文件或 symlink：${command}`)
  }
}
