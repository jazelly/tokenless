#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceApp = path.join(repositoryRoot, 'dist', 'macos', 'Tokenless.app')
const applicationsDirectory = path.join(os.homedir(), 'Applications')
const installedApp = path.join(applicationsDirectory, 'Tokenless.app')
const stagingApp = `${installedApp}.staging-${process.pid}`
const backupApp = `${installedApp}.backup-${process.pid}`
const installedExecutable = path.join(installedApp, 'Contents', 'MacOS', 'TokenlessMenuBar')
const shutdownWaitMilliseconds = 2500
const shutdownPollMilliseconds = 50

try {
  installApp()
} catch (error) {
  console.error(`Install failed / 安装失败：${formatError(error)}`)
  process.exitCode = 1
}

function installApp() {
  validateBundle(sourceApp, 'built macOS app')

  assertCanonicalPath(applicationsDirectory, 'Applications directory')
  const hadInstalledApp = pathExists(installedApp)
  if (hadInstalledApp) {
    assertCanonicalPath(installedApp, 'installed app')
    assertCanonicalPath(installedExecutable, 'installed menu app executable')
  }

  fs.mkdirSync(applicationsDirectory, { recursive: true })
  assertPathAbsent(stagingApp, 'staging app')
  assertPathAbsent(backupApp, 'backup app')

  const wasRunning = hadInstalledApp && findRunningMenuPids(installedExecutable).length > 0
  let oldMoved = false
  let oldRestored = false
  let stagingPresent = false
  let backupPresent = false
  let newAppPresent = false

  try {
    stagingPresent = true
    fs.cpSync(sourceApp, stagingApp, { recursive: true, dereference: true })
    validateBundle(stagingApp, 'staged macOS app')

    if (wasRunning) {
      stopRunningMenuApp(installedExecutable)
    }

    if (hadInstalledApp) {
      fs.renameSync(installedApp, backupApp)
      oldMoved = true
      backupPresent = true
    }

    fs.renameSync(stagingApp, installedApp)
    stagingPresent = false
    newAppPresent = true
    validateBundle(installedApp, 'installed macOS app')
    launchApp(installedApp, 'new macOS app')
  } catch (error) {
    const rollbackErrors = []

    if (newAppPresent) {
      try {
        stopRunningMenuApp(installedExecutable)
      } catch (stopError) {
        rollbackErrors.push(`could not stop the new app / 无法停止新版应用：${formatError(stopError)}`)
      }

      if (rollbackErrors.length === 0) {
        try {
          if (pathExists(installedApp)) fs.rmSync(installedApp, { recursive: true, force: true })
          newAppPresent = false
        } catch (removeError) {
          rollbackErrors.push(`could not remove the new app / 无法移除新版应用：${formatError(removeError)}`)
        }
      }
    }

    if (oldMoved && backupPresent && !pathExists(installedApp)) {
      try {
        fs.renameSync(backupApp, installedApp)
        backupPresent = false
        oldRestored = true
      } catch (restoreError) {
        rollbackErrors.push(`could not restore the old app / 无法恢复旧版应用：${formatError(restoreError)}`)
      }
    } else if (hadInstalledApp && !oldMoved && !newAppPresent && pathExists(installedApp)) {
      oldRestored = true
    }

    if (stagingPresent) {
      try {
        fs.rmSync(stagingApp, { recursive: true, force: true })
        stagingPresent = false
      } catch (cleanupError) {
        rollbackErrors.push(`could not clean staging / 无法清理 staging：${formatError(cleanupError)}`)
      }
    }

    if (wasRunning && oldRestored) {
      try {
        if (findRunningMenuPids(installedExecutable).length === 0) {
          launchApp(installedApp, 'restored old macOS app')
        }
      } catch (relaunchError) {
        rollbackErrors.push(`could not relaunch the old app / 无法重新启动旧版应用：${formatError(relaunchError)}`)
      }
    }

    const rollbackMessage = rollbackErrors.length > 0
      ? ` Rollback issues / 回滚问题：${rollbackErrors.join('；')}`
      : ''
    throw new Error(`${formatError(error)}${rollbackMessage}`)
  }

  const action = hadInstalledApp ? 'Upgraded' : 'Installed'
  const actionZh = hadInstalledApp ? '已升级' : '已安装'
  const successMessage = `${action} and launched Tokenless menu bar app / ${actionZh}并启动 Tokenless 菜单栏应用。`
  if (backupPresent) {
    try {
      fs.rmSync(backupApp, { recursive: true, force: true })
      backupPresent = false
    } catch (cleanupError) {
      console.error(
        `${successMessage} Backup cleanup failed; the new app is running and any remaining backup is at ${backupApp} / 备份清理失败；新版应用正在运行，仍保留的旧版备份路径为 ${backupApp}。原因：${formatError(cleanupError)}`,
      )
      process.exitCode = 1
      return
    }
  }
  console.log(successMessage)
}

function validateBundle(bundlePath, label) {
  requireDirectory(bundlePath, label)
  requireExecutable(path.join(bundlePath, 'Contents', 'MacOS', 'TokenlessMenuBar'), `${label} executable`)
  requireExecutable(path.join(bundlePath, 'Contents', 'Resources', 'runtime', 'node'), `${label} Node runtime`)
  requireFile(
    path.join(bundlePath, 'Contents', 'Resources', 'runtime', 'cli', 'dist', 'src', 'tokenless.mjs'),
    `${label} CLI entrypoint`,
  )
}

function launchApp(appPath, label) {
  try {
    execFileSync('/usr/bin/open', ['-a', appPath], { stdio: 'ignore' })
  } catch (error) {
    throw new Error(`Could not launch ${label} / 无法启动${label}：${formatError(error)}`)
  }
}

function findRunningMenuPids(executablePath) {
  let output
  try {
    output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`Could not inspect running menu app / 无法检查正在运行的菜单栏应用：${formatError(error)}`)
  }

  const pids = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    const command = match[2].trimEnd()
    if (command === executablePath || command.startsWith(`${executablePath} `)) {
      pids.push(Number(match[1]))
    }
  }
  return [...new Set(pids)]
}

function stopRunningMenuApp(executablePath) {
  const pids = findRunningMenuPids(executablePath)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw new Error(`Could not stop menu app process ${pid} / 无法停止菜单栏应用进程 ${pid}：${formatError(error)}`)
      }
    }
  }

  const deadline = Date.now() + shutdownWaitMilliseconds
  while (true) {
    const remainingPids = findRunningMenuPids(executablePath).filter((pid) => pids.includes(pid))
    if (remainingPids.length === 0) return
    const remainingMilliseconds = deadline - Date.now()
    if (remainingMilliseconds <= 0) {
      throw new Error(
        `Menu app did not exit after SIGTERM (${remainingPids.join(', ')}) / 菜单栏应用在 SIGTERM 后仍未退出（${remainingPids.join('、')}）。`,
      )
    }
    waitSynchronously(Math.min(shutdownPollMilliseconds, remainingMilliseconds))
  }
}

function waitSynchronously(milliseconds) {
  const waitBuffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(waitBuffer), 0, 0, milliseconds)
}

function pathExists(pathToCheck) {
  try {
    fs.lstatSync(pathToCheck)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function assertPathAbsent(pathToCheck, label) {
  if (pathExists(pathToCheck)) {
    throw new Error(`${label} already exists / ${label} 已存在：${pathToCheck}`)
  }
}

function assertCanonicalPath(pathToCheck, label) {
  const visiblePath = path.resolve(pathToCheck)
  let nearestExistingPath = visiblePath
  while (!pathExists(nearestExistingPath)) {
    const parentPath = path.dirname(nearestExistingPath)
    if (parentPath === nearestExistingPath) break
    nearestExistingPath = parentPath
  }

  const nearestStat = fs.lstatSync(nearestExistingPath)
  const canonicalNearestPath = fs.realpathSync(nearestExistingPath)
  if (nearestStat.isSymbolicLink() || canonicalNearestPath !== nearestExistingPath) {
    throw new Error(
      `${label} uses a symlink or non-canonical path / ${label} 使用了 symlink 或非 canonical 路径：${visiblePath}`,
    )
  }

  if (pathExists(visiblePath)) {
    const visibleStat = fs.lstatSync(visiblePath)
    if (!visibleStat.isSymbolicLink() && fs.realpathSync(visiblePath) === visiblePath) return
    throw new Error(
      `${label} uses a symlink or non-canonical path / ${label} 使用了 symlink 或非 canonical 路径：${visiblePath}`,
    )
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

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
