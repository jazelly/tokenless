#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32') throw new Error('Build on Windows / 请在 Windows 上构建')
const output = path.join(root, 'dist', 'windows')
const cli = path.join(root, 'packages', 'cli', 'dist', 'src', 'tokenless.mjs')
if (!fs.existsSync(cli)) throw new Error('Build the CLI first / 请先构建 CLI')
const compiler = resolveCompiler()
fs.mkdirSync(output, { recursive: true })
const staged = path.join(output, 'TokenlessApiTray.next.exe')
const executable = path.join(output, 'TokenlessApiTray.exe')
execFileSync(compiler, [
  '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/warnaserror+',
  '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll',
  `/resource:${path.join(root, 'assets', 'tokenless-mark.png')},tokenless-mark.png`,
  `/out:${staged}`, path.join(root, 'apps', 'windows-menu', 'TrayApp.cs'),
], { stdio: 'inherit', windowsHide: true })
// Ask only our per-user tray to detach. The daemon and browser stay resident.
if (fs.existsSync(executable)) execFileSync(executable, ['--exit'], { windowsHide: true })
for (let attempt = 0; ; attempt++) {
  try { fs.renameSync(staged, executable); break } catch (error) {
    if (attempt >= 40 || !['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code)) throw error
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
fs.writeFileSync(path.join(output, 'runtime.json'), `${JSON.stringify({ node: process.execPath, cli }, null, 2)}\n`)
console.log(`Built Tokenless API tray / 已构建 Tokenless API 托盘：${executable}`)

function resolveCompiler() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  const compiler = candidates.find(candidate => fs.existsSync(candidate))
  if (!compiler) {
    throw new Error('Could not find the .NET Framework C# compiler (csc.exe) / 找不到 .NET Framework C# 编译器（csc.exe）')
  }
  return compiler
}
