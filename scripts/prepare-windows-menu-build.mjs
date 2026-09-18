#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Windows tray builds require Windows / Windows 托盘构建需要在 Windows 上运行')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'packages', 'cli', 'dist', 'src', 'tokenless.mjs')
const daemonEntrypoint = path.join(root, 'packages', 'cli', 'dist', 'src', 'bootstrap', 'daemon-entry.mjs')
const home = path.join(os.homedir(), '.tokenless')
const daemons = findDaemons(daemonEntrypoint)

if (daemons.length === 0) {
  console.log('No running Tokenless API daemon found; continuing build. / 未发现运行中的 Tokenless API daemon，继续构建。')
  process.exit(0)
}

const unexpectedDaemons = daemons.filter((daemon) => !daemon.commandLine.toLowerCase().includes(home.toLowerCase()))
if (unexpectedDaemons.length > 0) {
  throw new Error(
    `A Tokenless API daemon for another home is running (pid ${unexpectedDaemons.map((daemon) => daemon.pid).join(', ')}); refusing to stop it during a build. Stop that daemon manually first. / 另一个 home 的 Tokenless API daemon 仍在运行（PID ${unexpectedDaemons.map((daemon) => daemon.pid).join('、')}）；为避免误停，构建已停止。请先手动停止该 daemon。`,
  )
}

if (!fs.existsSync(cli)) {
  throw new Error(
    `A Tokenless API daemon is running (pid ${daemons.map((daemon) => daemon.pid).join(', ')}), but the CLI build is missing. Stop the daemon manually before rebuilding. / Tokenless API daemon 仍在运行（PID ${daemons.map((daemon) => daemon.pid).join('、')}），但 CLI 构建产物不存在；请先手动停止 daemon 再重新构建。`,
  )
}

const status = runCli('menubar', 'status')
const activeJobCount = Number(status.activeJobCount)
if (!Number.isFinite(activeJobCount)) {
  throw new Error('Could not verify active Tokenless API jobs; refusing to rebuild. / 无法确认 Tokenless API 的活动任务数，已拒绝重新构建。')
}
if (activeJobCount > 0) {
  throw new Error(
    `Tokenless API has ${activeJobCount} active job(s); refusing to stop the daemon during a build. Finish or stop those jobs, then rebuild. / Tokenless API 当前有 ${activeJobCount} 个活动任务；为避免中断任务，构建已停止。请完成或停止这些任务后再构建。`,
  )
}

const stopped = runCli('daemon', 'stop')
if (stopped.ok !== true) throw new Error('Tokenless API daemon stop was not acknowledged. / Tokenless API daemon 未确认停止。')
const remainingDaemons = findDaemons(daemonEntrypoint)
if (remainingDaemons.length > 0) terminateDaemons(remainingDaemons)
await waitForDaemonsToExit(daemonEntrypoint)
console.log('Stopped the idle Tokenless API daemon before rebuilding. / 已在重新构建前停止空闲的 Tokenless API daemon。')

function runCli(...args) {
  let output
  try {
    output = execFileSync(process.execPath, [cli, ...args, '--home', home, '--json'], {
      cwd: path.dirname(cli),
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
    })
  } catch (error) {
    const detail = error?.stderr?.toString('utf8').trim()
    throw new Error(`Could not inspect Tokenless API before rebuilding${detail ? `: ${detail}` : '.'} / 重新构建前无法检查 Tokenless API${detail ? `：${detail}` : '。'}`)
  }
  let payload
  try {
    payload = JSON.parse(output)
  } catch {
    throw new Error('Tokenless API returned invalid JSON during build preflight. / Tokenless API 在构建前检查时返回了无效 JSON。')
  }
  if (payload.ok !== true) throw new Error('Tokenless API build preflight returned an unsuccessful response. / Tokenless API 构建前检查返回失败。')
  return payload
}

function findDaemons(entrypoint) {
  const script = '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  let output
  try {
    output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    }).trim()
  } catch {
    throw new Error('Could not inspect Windows processes before rebuilding. / 重新构建前无法检查 Windows 进程。')
  }
  if (!output) return []
  let processes
  try { processes = JSON.parse(output) } catch { throw new Error('Windows process inspection returned invalid JSON. / Windows 进程检查返回了无效 JSON。') }
  if (!Array.isArray(processes)) processes = [processes]
  const needle = entrypoint.toLowerCase()
  return processes
    .filter((process) => typeof process?.CommandLine === 'string' && process.CommandLine.toLowerCase().includes(needle))
    .map((process) => ({ pid: Number(process.ProcessId), commandLine: process.CommandLine }))
    .filter((process) => Number.isInteger(process.pid) && process.pid > 0)
}

function terminateDaemons(daemons) {
  const commands = daemons.map(({ pid }) => `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`).join('; ')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', commands], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (error) {
    const detail = error?.stderr?.toString('utf8').trim()
    throw new Error(`Could not stop the idle Tokenless API daemon${detail ? `: ${detail}` : '.'} / 无法停止空闲的 Tokenless API daemon${detail ? `：${detail}` : '。'}`)
  }
}

async function waitForDaemonsToExit(entrypoint) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (findDaemons(entrypoint).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Tokenless API daemon did not exit before the build started. / Tokenless API daemon 在构建开始前仍未退出。')
}
