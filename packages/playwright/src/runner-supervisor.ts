import childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fsSync, { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenlessError } from './errors.js'
import { withPrivateSqliteWriterLock } from './profiles/sqlite-lock.js'

export type RunnerSupervisorState = 'running' | 'stopped' | 'stale' | 'unsafe'

export type RunnerSupervisorStatus = {
  state: RunnerSupervisorState
  pid: number | null
  sessionId: string | null
  safeToStop: boolean
  heartbeatAt: string | null
}

export type RunnerSupervisorStartResult = RunnerSupervisorStatus & {
  started: boolean
}

export type RunnerSupervisorOptions = {
  homeDir?: string | undefined
  daemonUrl?: string | undefined
  nodePath?: string | undefined
  entryPath?: string | undefined
  spawnDetached?: SpawnDetached | undefined
  isProcessAlive?: ((pid: number) => boolean | Promise<boolean>) | undefined
  killProcess?: ((pid: number, signal: NodeJS.Signals) => void | Promise<void>) | undefined
  sessionId?: string | undefined
  heartbeatTimeoutMs?: number | undefined
  now?: (() => Date) | undefined
}

type SpawnDetached = (command: string, args: readonly string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  logFile: string
}) => Promise<{ pid: number }>

type SupervisorSession = {
  protocol: 'tokenless.playwright.runner-session.v1'
  sessionId: string
  pid: number
  startedAt: string
}

type SupervisorHeartbeat = {
  protocol: 'tokenless.playwright.runner-heartbeat.v1'
  sessionId: string
  pid: number
  updatedAt: string
}

const RUNNER_DIR = 'playwright-runner'
const PID_FILE = 'pid.json'
const SESSION_FILE = 'session.json'
const HEARTBEAT_FILE = 'heartbeat.json'
const LOG_FILE = 'runner.log'
const WRITER_LOCK_FILE = 'runner.writer.sqlite'
export const RUNNER_HEARTBEAT_INTERVAL_MS = 2_000
export const RUNNER_HEARTBEAT_FRESHNESS_MS = 15_000

export async function startRunnerSupervisor(options: RunnerSupervisorOptions): Promise<RunnerSupervisorStartResult> {
  const markers = await ensureRunnerMarkersDir(options.homeDir)
  return await withPrivateSqliteWriterLock(markers.writerLockFile, async () => {
    return await startRunnerSupervisorUnlocked(options, markers)
  })
}

async function startRunnerSupervisorUnlocked(
  options: RunnerSupervisorOptions,
  markers: Awaited<ReturnType<typeof ensureRunnerMarkersDir>>
): Promise<RunnerSupervisorStartResult> {
  const current = await runnerSupervisorStatusUnlocked(options, markers)
  if (current.state === 'running') return { ...current, started: false }
  if (current.state === 'unsafe') {
    throw tokenlessError('playwright_runner_identity_unverified', 'A live managed Playwright runner marker is not verified; refusing to overwrite it.')
  }

  await validateWritableMarkers(markers)
  const sessionId = options.sessionId ?? randomUUID()
  const entryPath = options.entryPath ?? fileURLToPath(new URL('./runner-entry.mjs', import.meta.url))
  const nodePath = options.nodePath ?? process.execPath
  const args = [
    entryPath,
    '--home-dir', markers.homeDir,
    '--session-id', sessionId,
    ...(options.daemonUrl ? ['--daemon-url', options.daemonUrl] : []),
  ]
  const spawned = await (options.spawnDetached ?? defaultSpawnDetached)(nodePath, args, {
    cwd: process.cwd(),
    env: process.env,
    logFile: markers.logFile,
  })
  const startedAt = (options.now ?? (() => new Date()))().toISOString()
  const session: SupervisorSession = {
    protocol: 'tokenless.playwright.runner-session.v1',
    sessionId,
    pid: spawned.pid,
    startedAt,
  }
  await writePrivateJson(markers.sessionFile, session)
  await writePrivateJson(markers.pidFile, session)
  try {
    const status = await waitForMatchingHeartbeat(options, markers, sessionId, spawned.pid)
    return { ...status, started: true }
  } catch (error) {
    await cleanupFailedStartHandshake(options, markers, sessionId, spawned.pid)
    throw error
  }
}

export async function stopRunnerSupervisor(options: RunnerSupervisorOptions): Promise<RunnerSupervisorStatus> {
  const markers = await ensureRunnerMarkersDir(options.homeDir)
  return await withPrivateSqliteWriterLock(markers.writerLockFile, async () => {
    const status = await runnerSupervisorStatusUnlocked(options, markers)
    if (status.state === 'unsafe') {
      throw tokenlessError('playwright_runner_identity_unverified', 'Managed Playwright runner identity is not verified; refusing to stop the process.')
    }
    if (status.state !== 'running' || !status.pid) return status
    if (!status.safeToStop) {
      throw tokenlessError('playwright_runner_identity_unverified', 'Managed Playwright runner identity is not verified; refusing to stop the process.')
    }
    await (options.killProcess ?? defaultKillProcess)(status.pid, 'SIGTERM')
    await Promise.all([
      fs.rm(markers.pidFile, { force: true }),
      fs.rm(markers.sessionFile, { force: true }),
      fs.rm(markers.heartbeatFile, { force: true }),
    ])
    return {
      state: 'stopped',
      pid: null,
      sessionId: null,
      safeToStop: false,
      heartbeatAt: null,
    }
  })
}

export async function runnerSupervisorStatus(options: RunnerSupervisorOptions): Promise<RunnerSupervisorStatus> {
  const markers = await ensureRunnerMarkersDir(options.homeDir)
  return await runnerSupervisorStatusUnlocked(options, markers)
}

async function runnerSupervisorStatusUnlocked(
  options: RunnerSupervisorOptions,
  markers: Awaited<ReturnType<typeof ensureRunnerMarkersDir>>
): Promise<RunnerSupervisorStatus> {
  let session: SupervisorSession | null
  try {
    session = await readJson<SupervisorSession>(markers.sessionFile)
  } catch (error) {
    if (isMarkerMalformedError(error)) return unsafeStatus(null, null)
    throw error
  }
  if (!session) return stoppedStatus()
  if (!isValidSession(session)) {
    return unsafeStatus(
      Number.isInteger(session.pid) && session.pid > 0 ? session.pid : null,
      typeof session.sessionId === 'string' ? session.sessionId : null
    )
  }
  const alive = await (options.isProcessAlive ?? defaultIsProcessAlive)(session.pid)
  if (!alive) {
    return {
      state: 'stale',
      pid: session.pid,
      sessionId: session.sessionId,
      safeToStop: false,
      heartbeatAt: null,
    }
  }
  let heartbeat: SupervisorHeartbeat | null
  try {
    heartbeat = await readJson<SupervisorHeartbeat>(markers.heartbeatFile)
  } catch (error) {
    if (!isMarkerMalformedError(error)) throw error
    heartbeat = null
  }
  const heartbeatMatches = heartbeat !== null &&
    heartbeat.protocol === 'tokenless.playwright.runner-heartbeat.v1' &&
    heartbeat.sessionId === session.sessionId &&
    heartbeat.pid === session.pid &&
    isFreshHeartbeat(heartbeat.updatedAt, options)
  const heartbeatAt = heartbeatMatches && heartbeat !== null ? heartbeat.updatedAt : null
  return {
    state: heartbeatMatches ? 'running' : 'unsafe',
    pid: session.pid,
    sessionId: session.sessionId,
    safeToStop: heartbeatMatches,
    heartbeatAt,
  }
}

export async function writeRunnerHeartbeat(options: {
  homeDir?: string | undefined
  sessionId: string
  pid?: number | undefined
  now?: (() => Date) | undefined
}) {
  const markers = await ensureRunnerMarkersDir(options.homeDir)
  await writePrivateJson(markers.heartbeatFile, {
    protocol: 'tokenless.playwright.runner-heartbeat.v1',
    sessionId: options.sessionId,
    pid: options.pid ?? process.pid,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  } satisfies SupervisorHeartbeat)
}

export async function ensureRunnerMarkersDir(homeDir = tokenlessHome()) {
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  const canonicalHomeDir = await fs.realpath(homeDir)
  const runnerDir = path.join(canonicalHomeDir, RUNNER_DIR)
  await fs.mkdir(runnerDir, { recursive: true, mode: 0o700 })
  await assertPrivateDirectory(runnerDir)
  const logFile = path.join(runnerDir, LOG_FILE)
  await ensurePrivateMarkerFile(logFile)
  return {
    homeDir: canonicalHomeDir,
    runnerDir,
    pidFile: path.join(runnerDir, PID_FILE),
    sessionFile: path.join(runnerDir, SESSION_FILE),
    heartbeatFile: path.join(runnerDir, HEARTBEAT_FILE),
    writerLockFile: path.join(runnerDir, WRITER_LOCK_FILE),
    logFile,
  }
}

function tokenlessHome(explicitHome = process.env.TOKENLESS_HOME) {
  return path.resolve(explicitHome || path.join(os.homedir(), '.tokenless'))
}

async function defaultSpawnDetached(command: string, args: readonly string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  logFile: string
}) {
  const logFd = fsSync.openSync(
    options.logFile,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  )
  const child = childProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  return { pid: requirePid(child.pid) }
}

function requirePid(pid: number | undefined) {
  if (!Number.isInteger(pid) || !pid) {
    throw tokenlessError('playwright_runner_spawn_failed', 'Managed Playwright runner did not report a valid pid.', { retryable: true })
  }
  return pid
}

function defaultIsProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals) {
  process.kill(pid, signal)
}

async function writePrivateJson(file: string, value: unknown) {
  await validateMarkerBeforeOverwrite(file)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
  let wrote = false
  try {
    const handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.chmod(0o600)
    } finally {
      await handle.close()
    }
    await assertPrivateFile(tmp)
    await fs.rename(tmp, file)
    wrote = true
    await assertPrivateFile(file)
  } finally {
    if (!wrote) await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    await assertPrivateFile(file)
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error) {
    if (isMarkerPermissionError(error)) throw error
    if (!isMissingFile(error)) {
      throw tokenlessError('playwright_runner_marker_malformed', 'Managed Playwright runner marker JSON is malformed.', { cause: error })
    }
    return null
  }
}

async function waitForMatchingHeartbeat(
  options: RunnerSupervisorOptions,
  markers: Awaited<ReturnType<typeof ensureRunnerMarkersDir>>,
  sessionId: string,
  pid: number
) {
  const timeoutMs = Math.max(1, Math.floor(options.heartbeatTimeoutMs ?? RUNNER_HEARTBEAT_FRESHNESS_MS))
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const status = await runnerSupervisorStatusUnlocked(options, markers)
    if (status.state === 'running' && status.sessionId === sessionId && status.pid === pid && status.safeToStop) {
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw tokenlessError('playwright_runner_heartbeat_timeout', 'Managed Playwright runner did not report a matching heartbeat.', { retryable: true })
}

async function cleanupFailedStartHandshake(
  options: RunnerSupervisorOptions,
  markers: Awaited<ReturnType<typeof ensureRunnerMarkersDir>>,
  sessionId: string,
  pid: number
) {
  try {
    const session = await readJson<SupervisorSession>(markers.sessionFile)
    if (!session || session.sessionId !== sessionId || session.pid !== pid) return
    await (options.killProcess ?? defaultKillProcess)(pid, 'SIGTERM')
    await Promise.all([
      fs.rm(markers.pidFile, { force: true }),
      fs.rm(markers.sessionFile, { force: true }),
      fs.rm(markers.heartbeatFile, { force: true }),
    ])
  } catch {
    // Preserve the heartbeat timeout or identity failure that triggered cleanup.
  }
}

async function assertPrivateDirectory(directory: string) {
  const fileStat = await fs.lstat(directory)
  if (!fileStat.isDirectory() || fileStat.isSymbolicLink()) {
    throw tokenlessError('playwright_runner_marker_permissions', 'Managed Playwright runner marker directory is not private.')
  }
  assertCurrentUser(fileStat)
  if (process.platform !== 'win32' && (fileStat.mode & 0o7777) !== 0o700) {
    throw tokenlessError('playwright_runner_marker_permissions', 'Managed Playwright runner marker directory is not private.')
  }
  await fs.chmod(directory, 0o700)
}

async function assertPrivateFile(file: string) {
  const fileStat = await fs.lstat(file)
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
    throw tokenlessError('playwright_runner_marker_permissions', 'Managed Playwright runner marker file is not private.')
  }
  assertCurrentUser(fileStat)
  if (process.platform !== 'win32' && (fileStat.mode & 0o7777) !== 0o600) {
    throw tokenlessError('playwright_runner_marker_permissions', 'Managed Playwright runner marker file is not private.')
  }
  await fs.chmod(file, 0o600)
}

async function ensurePrivateMarkerFile(file: string) {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    await handle.chmod(0o600)
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error
    await assertPrivateFile(file)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function validateWritableMarkers(markers: Awaited<ReturnType<typeof ensureRunnerMarkersDir>>) {
  await Promise.all([
    validateMarkerBeforeOverwrite(markers.sessionFile),
    validateMarkerBeforeOverwrite(markers.pidFile),
    validateMarkerBeforeOverwrite(markers.heartbeatFile),
  ])
}

async function validateMarkerBeforeOverwrite(file: string) {
  await assertPrivateDirectory(path.dirname(file))
  try {
    await assertPrivateFile(file)
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
}

function assertCurrentUser(metadata: { uid: number }) {
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw tokenlessError('playwright_runner_marker_permissions', 'Managed Playwright runner marker path is not owned by the current user.')
  }
}

function stoppedStatus(): RunnerSupervisorStatus {
  return {
    state: 'stopped',
    pid: null,
    sessionId: null,
    safeToStop: false,
    heartbeatAt: null,
  }
}

function unsafeStatus(pid: number | null, sessionId: string | null): RunnerSupervisorStatus {
  return {
    state: 'unsafe',
    pid,
    sessionId,
    safeToStop: false,
    heartbeatAt: null,
  }
}

function isValidSession(session: SupervisorSession) {
  return session.protocol === 'tokenless.playwright.runner-session.v1' &&
    typeof session.sessionId === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(session.sessionId) &&
    Number.isSafeInteger(session.pid) &&
    session.pid > 0 &&
    typeof session.startedAt === 'string' &&
    Number.isFinite(Date.parse(session.startedAt))
}

function isFreshHeartbeat(updatedAt: string, options: RunnerSupervisorOptions) {
  const updatedAtMs = Date.parse(updatedAt)
  if (!Number.isFinite(updatedAtMs)) return false
  const nowMs = (options.now ?? (() => new Date()))().getTime()
  const ageMs = nowMs - updatedAtMs
  const timeoutMs = Math.max(1, Math.floor(options.heartbeatTimeoutMs ?? RUNNER_HEARTBEAT_FRESHNESS_MS))
  return ageMs >= 0 && ageMs <= timeoutMs
}

function isMarkerPermissionError(error: unknown) {
  return error instanceof Error &&
    error.name === 'TokenlessPlaywrightError' &&
    'code' in error &&
    error.code === 'playwright_runner_marker_permissions'
}

function isMarkerMalformedError(error: unknown) {
  return error instanceof Error &&
    error.name === 'TokenlessPlaywrightError' &&
    'code' in error &&
    error.code === 'playwright_runner_marker_malformed'
}

function isErrno(error: unknown, code: string) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function isMissingFile(error: unknown) {
  return isErrno(error, 'ENOENT')
}
