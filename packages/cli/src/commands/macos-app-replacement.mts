import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type MacOSAppReplacementOptions = {
  archivePath?: string
  sourceAppPath?: string
  installedAppPath: string
  beforeReplace?: (stagedAppPath: string) => Promise<void> | void
  beforeLaunch?: (installedAppPath: string) => Promise<void> | void
  launchArguments?: readonly string[]
  launch?: boolean
}

export type MacOSAppReplacementResult = {
  installedAppPath: string
  hadInstalledApp: boolean
  wasRunning: boolean
}

const APP_EXECUTABLE_RELATIVE_PATH = path.join('Contents', 'MacOS', 'TokenlessMenuBar')
const RUNTIME_RELATIVE_PATH = path.join('Contents', 'Resources', 'runtime')
const RUNTIME_NODE_RELATIVE_PATH = path.join(RUNTIME_RELATIVE_PATH, 'node')
const RUNTIME_CLI_RELATIVE_PATH = path.join(
  RUNTIME_RELATIVE_PATH,
  'cli',
  'dist',
  'src',
  'tokenless.mjs',
)
const RUNTIME_UPDATE_RELATIVE_PATH = path.join(
  RUNTIME_RELATIVE_PATH,
  'cli',
  'dist',
  'src',
  'bootstrap',
  'update-runtime.mjs',
)
const APP_INFO_RELATIVE_PATH = path.join('Contents', 'Info.plist')
const RUNTIME_CLI_MANIFEST_RELATIVE_PATH = path.join(RUNTIME_RELATIVE_PATH, 'cli', 'package.json')
const SHUTDOWN_WAIT_MILLISECONDS = 2_500
const SHUTDOWN_POLL_MILLISECONDS = 50

/**
 * Validate the small, fixed part of a Tokenless app bundle used by the updater.
 *
 * This deliberately validates exact regular files and rejects symlinked runtime
 * trees. The updater must never follow an archive entry out of the candidate
 * bundle before replacing the installed app.
 */
export function validateMacOSAppBundle(bundlePath: string, label = 'macOS app', requireUpdateRuntime = false) {
  const canonicalBundlePath = requireDirectory(bundlePath, label)
  requireRegularFile(path.join(canonicalBundlePath, APP_INFO_RELATIVE_PATH), `${label} Info.plist`, canonicalBundlePath)
  requireExecutable(path.join(canonicalBundlePath, APP_EXECUTABLE_RELATIVE_PATH), `${label} executable`, canonicalBundlePath)
  requireExecutable(path.join(canonicalBundlePath, RUNTIME_NODE_RELATIVE_PATH), `${label} Node runtime`, canonicalBundlePath)
  requireRegularFile(path.join(canonicalBundlePath, RUNTIME_CLI_RELATIVE_PATH), `${label} CLI entrypoint`, canonicalBundlePath)
  if (requireUpdateRuntime) requireRegularFile(path.join(canonicalBundlePath, RUNTIME_UPDATE_RELATIVE_PATH), `${label} update runtime`, canonicalBundlePath)
  assertNoSymlinks(path.join(canonicalBundlePath, RUNTIME_RELATIVE_PATH), `${label} runtime`)
  return canonicalBundlePath
}

export function readMacOSAppVersion(bundlePath: string) {
  const canonicalBundlePath = validateMacOSAppBundle(bundlePath, 'macOS app')
  const infoPath = path.join(canonicalBundlePath, APP_INFO_RELATIVE_PATH)
  try {
    const version = execFileSync('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      '--',
      infoPath,
    ], { encoding: 'utf8' }).trim()
    if (version.length > 0) return version
  } catch {
    // Fall through to the stable bundle-version error below.
  }
  throw new Error(`The macOS app has no valid CFBundleShortVersionString / macOS app 缺少有效的 CFBundleShortVersionString：${infoPath}`)
}

export function readMacOSAppPackageVersion(bundlePath: string) {
  const canonicalBundlePath = validateMacOSAppBundle(bundlePath, 'macOS app')
  const manifestPath = requireRegularFile(
    path.join(canonicalBundlePath, RUNTIME_CLI_MANIFEST_RELATIVE_PATH),
    'macOS app CLI package.json',
    canonicalBundlePath,
  )
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name === 'tokenless' && typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version
  } catch {
    // Fall through to the stable manifest error below.
  }
  throw new Error(`The macOS app CLI package.json has no valid tokenless version / macOS app CLI package.json 缺少有效的 tokenless 版本：${manifestPath}`)
}

/**
 * Replace an installed app from either a locally built bundle or a downloaded
 * zip archive. The optional callback runs after the new bundle is installed and
 * before LaunchServices is asked to start it. If that callback runs, this
 * function intentionally does not restore the old bundle on failure: the
 * callback is where the new runtime may commit a database migration.
 */
export async function replaceMacOSApp(options: MacOSAppReplacementOptions): Promise<MacOSAppReplacementResult> {
  const sourceCount = Number(options.archivePath !== undefined) + Number(options.sourceAppPath !== undefined)
  if (sourceCount !== 1) throw new Error('Provide exactly one macOS app source archive or bundle.')

  const installedAppPath = path.resolve(options.installedAppPath)
  const applicationsDirectory = path.dirname(installedAppPath)
  fs.mkdirSync(applicationsDirectory, { recursive: true })
  assertCanonicalPath(applicationsDirectory, 'macOS app parent directory')

  const hadInstalledApp = pathExists(installedAppPath)
  if (hadInstalledApp) {
    assertCanonicalPath(installedAppPath, 'installed macOS app')
    validateMacOSAppBundle(installedAppPath, 'installed macOS app')
  }

  const stagingRoot = fs.mkdtempSync(path.join(applicationsDirectory, '.tokenless-app-staging-'))
  const stagingAppPath = path.join(stagingRoot, 'Tokenless.app')
  const backupAppPath = path.join(applicationsDirectory, `.Tokenless.app.backup-${process.pid}-${randomUUID()}`)
  assertPathAbsent(backupAppPath, 'macOS app backup')

  let stagingPresent = true
  let oldMoved = false
  let backupPresent = false
  let newAppPresent = false
  let activationStarted = false
  let launchAccepted = false
  const installedExecutablePath = path.join(installedAppPath, APP_EXECUTABLE_RELATIVE_PATH)
  const wasRunning = hadInstalledApp && findRunningMenuPids(installedExecutablePath).length > 0

  try {
    if (options.archivePath !== undefined) {
      const archivePath = requireRegularFile(options.archivePath, 'macOS app archive')
      extractArchive(archivePath, stagingRoot)
    } else {
      const sourceAppPath = validateMacOSAppBundle(options.sourceAppPath!, 'built macOS app')
      fs.cpSync(sourceAppPath, stagingAppPath, { recursive: true, dereference: true })
    }
    const stagedBundlePath = validateMacOSAppBundle(stagingAppPath, 'staged macOS app', true)
    if (!isPathInside(stagedBundlePath, fs.realpathSync(stagingRoot))) {
      throw new Error('Staged macOS app escaped its staging directory / staged macOS app 超出了 staging 目录')
    }
    if (options.beforeReplace !== undefined) await options.beforeReplace(stagingAppPath)

    if (wasRunning) stopRunningMenuApp(installedExecutablePath)

    if (hadInstalledApp) {
      fs.renameSync(installedAppPath, backupAppPath)
      oldMoved = true
      backupPresent = true
    }

    fs.renameSync(stagingAppPath, installedAppPath)
    stagingPresent = false
    newAppPresent = true
    validateMacOSAppBundle(installedAppPath, 'installed macOS app', true)

    if (options.beforeLaunch !== undefined) {
      activationStarted = true
      await options.beforeLaunch(installedAppPath)
    }
    if (options.launch !== false) {
      launchMacOSApp(installedAppPath, 'new macOS app', options.launchArguments)
      launchAccepted = true
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    if (!activationStarted && !launchAccepted) {
      if (newAppPresent) {
        try {
          stopRunningMenuApp(installedExecutablePath)
        } catch (stopError) {
          rollbackErrors.push(`could not stop the new app / 无法停止新版应用：${formatError(stopError)}`)
        }
        try {
          if (pathExists(installedAppPath)) fs.rmSync(installedAppPath, { recursive: true, force: true })
          newAppPresent = false
        } catch (removeError) {
          rollbackErrors.push(`could not remove the new app / 无法移除新版应用：${formatError(removeError)}`)
        }
      }

      if (oldMoved && backupPresent && !pathExists(installedAppPath)) {
        try {
          fs.renameSync(backupAppPath, installedAppPath)
          backupPresent = false
        } catch (restoreError) {
          rollbackErrors.push(`could not restore the old app / 无法恢复旧版应用：${formatError(restoreError)}`)
        }
      }
    }

    try {
      // The staged app is renamed out of this directory on the happy path,
      // but the empty staging root still needs removing.
      fs.rmSync(stagingRoot, { recursive: true, force: true })
      stagingPresent = false
    } catch (cleanupError) {
      rollbackErrors.push(`could not clean staging / 无法清理 staging：${formatError(cleanupError)}`)
    }

    // The updater may stop the menu from its pre-replacement callback so it
    // cannot restart the old daemon while the bundle is being swapped. If
    // that callback fails, the old bundle is still installed and must become
    // visible again in the same selected home.
    if (!activationStarted && wasRunning && !newAppPresent && pathExists(installedExecutablePath) && findRunningMenuPids(installedExecutablePath).length === 0) {
      try {
          launchMacOSApp(installedAppPath, 'restored old macOS app', options.launchArguments)
      } catch (relaunchError) {
        rollbackErrors.push(`could not relaunch the old app / 无法重新启动旧版应用：${formatError(relaunchError)}`)
      }
    }

    const rollbackMessage = rollbackErrors.length > 0
      ? ` Rollback issues / 回滚问题：${rollbackErrors.join('；')}`
      : ''
    const activationMessage = activationStarted
      ? ' The new app remains installed because runtime activation may have migrated the database. / 新版应用仍保留，因为 runtime 激活可能已经迁移数据库。'
      : ''
    throw new Error(`${formatError(error)}${activationMessage}${rollbackMessage}`)
  }

  fs.rmSync(stagingRoot, { recursive: true, force: true })
  stagingPresent = false
  if (backupPresent) {
    try {
      fs.rmSync(backupAppPath, { recursive: true, force: true })
      backupPresent = false
    } catch (error) {
      throw new Error(
        `New macOS app is running, but old app cleanup failed at ${backupAppPath} / 新版 macOS app 正在运行，但旧版清理失败，仍保留在 ${backupAppPath}：${formatError(error)}`,
      )
    }
  }

  return {
    installedAppPath,
    hadInstalledApp,
    wasRunning,
  }
}

export function launchMacOSApp(appPath: string, label = 'macOS app', argumentsToPass: readonly string[] = []) {
  try {
    execFileSync('/usr/bin/open', [
      '-a',
      appPath,
      ...(argumentsToPass.length === 0 ? [] : ['--args', ...argumentsToPass]),
    ], { stdio: 'ignore' })
  } catch (error) {
    throw new Error(`Could not launch ${label} / 无法启动${label}：${formatError(error)}`)
  }
}

export function findRunningMenuPids(executablePath: string) {
  let output: string
  try {
    output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`Could not inspect running menu app / 无法检查正在运行的菜单栏应用：${formatError(error)}`)
  }

  const pids: number[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    const command = match[2]?.trimEnd() ?? ''
    if (command === executablePath || command.startsWith(`${executablePath} `)) pids.push(Number(match[1]))
  }
  return [...new Set(pids)]
}

export function stopRunningMenuApp(executablePath: string) {
  const pids = findRunningMenuPids(executablePath)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        throw new Error(`Could not stop menu app process ${pid} / 无法停止菜单栏应用进程 ${pid}：${formatError(error)}`)
      }
    }
  }

  const deadline = Date.now() + SHUTDOWN_WAIT_MILLISECONDS
  while (true) {
    const remainingPids = findRunningMenuPids(executablePath).filter((pid) => pids.includes(pid))
    if (remainingPids.length === 0) return
    const remainingMilliseconds = deadline - Date.now()
    if (remainingMilliseconds <= 0) {
      throw new Error(
        `Menu app did not exit after SIGTERM (${remainingPids.join(', ')}) / 菜单栏应用在 SIGTERM 后仍未退出（${remainingPids.join('、')}）。`,
      )
    }
    waitSynchronously(Math.min(SHUTDOWN_POLL_MILLISECONDS, remainingMilliseconds))
  }
}

function extractArchive(archivePath: string, destination: string) {
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archivePath, destination], { stdio: 'ignore' })
  } catch (error) {
    throw new Error(`Could not extract macOS app archive / 无法解压 macOS app archive：${formatError(error)}`)
  }
}

function assertNoSymlinks(rootPath: string, label: string) {
  const root = fs.realpathSync(rootPath)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      const stat = fs.lstatSync(entryPath)
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink / ${label} 包含 symlink：${entryPath}`)
      if (stat.isDirectory()) stack.push(entryPath)
    }
  }
}

function requireRegularFile(filePath: string, label: string, parentPath?: string) {
  const resolvedPath = resolveRealPath(filePath, label)
  const stat = fs.statSync(resolvedPath)
  if (!stat.isFile()) throw new Error(`${label} is not a regular file / ${label} 不是普通文件：${filePath}`)
  if (parentPath !== undefined && !isPathInside(resolvedPath, parentPath)) {
    throw new Error(`${label} is outside the app bundle / ${label} 位于 app bundle 外部：${filePath}`)
  }
  return resolvedPath
}

function requireExecutable(filePath: string, label: string, parentPath: string) {
  const resolvedPath = requireRegularFile(filePath, label, parentPath)
  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    throw new Error(`${label} is not readable and executable / ${label} 不可读或不可执行：${filePath}`)
  }
  return resolvedPath
}

function requireDirectory(directoryPath: string, label: string) {
  const visiblePath = path.resolve(directoryPath)
  let visibleStat: fs.Stats
  try {
    visibleStat = fs.lstatSync(visiblePath)
  } catch {
    throw new Error(`${label} is missing / 缺少 ${label}：${directoryPath}`)
  }
  if (visibleStat.isSymbolicLink() || !visibleStat.isDirectory()) throw new Error(`${label} is not a canonical directory / ${label} 不是 canonical 目录：${directoryPath}`)
  return fs.realpathSync(visiblePath)
}

function resolveRealPath(filePath: string, label: string) {
  try {
    return fs.realpathSync(filePath)
  } catch {
    throw new Error(`${label} is missing / 缺少 ${label}：${filePath}`)
  }
}

function assertCanonicalPath(filePath: string, label: string) {
  const visiblePath = path.resolve(filePath)
  let nearestExistingPath = visiblePath
  while (!pathExists(nearestExistingPath)) {
    const parentPath = path.dirname(nearestExistingPath)
    if (parentPath === nearestExistingPath) break
    nearestExistingPath = parentPath
  }

  const nearestStat = fs.lstatSync(nearestExistingPath)
  const canonicalNearestPath = fs.realpathSync(nearestExistingPath)
  if (nearestStat.isSymbolicLink() || canonicalNearestPath !== nearestExistingPath) {
    throw new Error(`${label} uses a symlink or non-canonical path / ${label} 使用了 symlink 或非 canonical 路径：${visiblePath}`)
  }

  if (pathExists(visiblePath)) {
    const visibleStat = fs.lstatSync(visiblePath)
    if (!visibleStat.isSymbolicLink() && fs.realpathSync(visiblePath) === visiblePath) return
    throw new Error(`${label} uses a symlink or non-canonical path / ${label} 使用了 symlink 或非 canonical 路径：${visiblePath}`)
  }
}

function assertPathAbsent(filePath: string, label: string) {
  if (pathExists(filePath)) throw new Error(`${label} already exists / ${label} 已存在：${filePath}`)
}

function pathExists(filePath: string) {
  try {
    fs.lstatSync(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

function isPathInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function waitSynchronously(milliseconds: number) {
  const waitBuffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(waitBuffer), 0, 0, milliseconds)
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
