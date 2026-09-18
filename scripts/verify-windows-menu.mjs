#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Manual local control-plane check: no provider/browser launch or profile changes.
// Run in an unlocked Windows session and avoid opening terminals during the check.
assert.equal(process.platform, 'win32', 'Run on Windows / 请在 Windows 上运行')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--home'), 'Usage: node scripts/verify-windows-menu.mjs [--home <path>]')
const homeDir = path.resolve(args[1] ?? path.join(os.homedir(), '.tokenless'))
await fs.access(path.join(homeDir, 'config.json'))
const cli = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const trayExecutable = path.join(root, 'dist/windows/TokenlessApiTray.exe')
await fs.access(cli)
await fs.access(trayExecutable)
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', process.arch === 'ia32' ? 'Framework' : 'Framework64', 'v4.0.30319/csc.exe')
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-windows-console-'))
const probe = path.join(output, 'WindowsConsoleProbe.exe')
const run = promisify(execFile)
const options = { windowsHide: true, timeout: 40000, maxBuffer: 256 * 1024 }
try {
  await run(compiler, [
    '/nologo', '/target:winexe', '/warnaserror+',
    '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    `/out:${probe}`, path.join(root, 'test/helpers/windows-console-probe.cs'),
  ], options)
  for (const command of [['menubar', 'status'], ['dashboard', '--no-open']]) {
    const reportPath = path.join(output, `${command[0]}.json`)
    await run(probe, [reportPath, process.execPath, cli, ...command, '--home', homeDir, '--json'], options)
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
    assert.equal(report.timedOut, false, `${command[0]} timed out / 命令超时`)
    const failureDetail = `exit ${report.exitCode}, error ${report.errorCode ?? 'none'}, stdout ${report.stdoutBytes ?? 0} bytes, stderr ${report.stderrBytes ?? 0} bytes`
    assert.equal(report.exitCode, 0, `${command[0]} failed (${failureDetail}) / 命令失败（${failureDetail}）`)
    assert.equal(report.ok, true, `${command[0]} returned an unsuccessful result / 命令未成功`)
    assert.deepEqual(report.windows, [], `${command[0]} showed console windows / 命令弹出了控制台窗口`)
    console.log(`${command.join(' ')}: OK, 0 console windows / 成功，0 个控制台窗口`)
  }
  await verifyTrayLifecycle()
} finally {
  await fs.rm(output, { recursive: true, force: true })
}

async function verifyTrayLifecycle() {
  await run(trayExecutable, ['--exit'], options)
  const tray = spawn(trayExecutable, [], { windowsHide: true, stdio: 'ignore' })
  try {
    await delay(1500)
    assert.equal(tray.exitCode, null, 'Tray exited during startup / 托盘在启动时退出')
    await run(trayExecutable, [], options)
    assert.equal(tray.exitCode, null, 'Starting a duplicate stopped the resident tray / 重复启动导致驻留托盘退出')
    await run(trayExecutable, ['--exit'], options)
    await waitForExit(tray, 7000)
    assert.equal(tray.exitCode, 0, 'Tray did not exit cleanly / 托盘未正常退出')
    console.log('tray lifecycle: OK, singleton and graceful exit / 托盘生命周期成功，单实例且正常退出')
  } finally {
    if (tray.exitCode === null) {
      await run(trayExecutable, ['--exit'], options).catch(() => {})
      await waitForExit(tray, 7000).catch(() => {})
    }
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return
  await Promise.race([
    once(child, 'exit'),
    delay(timeoutMs).then(() => { throw new Error('Timed out waiting for tray exit / 等待托盘退出超时') }),
  ])
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
