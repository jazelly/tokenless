import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeBrowserId,
  snapshotsDir,
  tokenlessHome,
} from './job-store.js'
import { daemonUrl as normalizeDaemonUrl, readDaemonToken, shutdownDaemon } from './daemon-client.js'
import { getProviderInstanceById, getProviderInstanceForUrl, listProviderDescriptors } from './providers/registry.js'
import {
  DAEMON_PROCESS_PROTOCOL,
  DAEMON_PROTOCOL,
  DAEMON_SNAPSHOT_PROTOCOL,
  EXTENSION_BRIDGE_PROTOCOL,
} from './generated/protocol-constants.js'
import { tokenlessPackageVersion } from './platform-package.js'

export {
  DAEMON_PROCESS_PROTOCOL,
  DAEMON_PROTOCOL,
  DAEMON_SNAPSHOT_PROTOCOL,
  EXTENSION_BRIDGE_PROTOCOL,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V2,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V3,
  VISIBLE_ACTION_PROTOCOL_VERSION,
  VISIBLE_ACTION_PROTOCOL_VERSION_V1,
  VISIBLE_ACTION_PROTOCOL_VERSION_V2,
  VISIBLE_ACTION_PROTOCOL_VERSION_V3,
} from './generated/protocol-constants.js'
export const EXTENSION_BRIDGE_FILE = 'extension-bridge.json'
export const DAEMON_PID_FILE = 'daemon.pid.json'
export const DAEMON_LOG_FILE = 'daemon.log'
export const DAEMON_RUNTIME_KIND = 'typescript'

const DAEMON_ENTRY_NAME = 'daemon-entry.mjs'
const DEFAULT_BRIDGE_MAX_AGE_MS = 15_000
const BRIDGE_CLOCK_TOLERANCE_MS = 5_000
const DEFAULT_DAEMON_START_TIMEOUT_MS = 10_000
const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 2_147_483_647
const BUILD_INFO_TIMEOUT_MS = 2_000
const BUILD_INFO_OUTPUT_LIMIT_BYTES = 16_384
const SETUP_DAEMON_RECONCILE_MAX_ATTEMPTS = 2
const LEGACY_DAEMON_SUPPORTED_PROVIDERS = Object.freeze(['chatgpt', 'claude', 'gemini', 'grok'])

type RuntimeError = Error & {
  code?: string
  retryable?: boolean
  status?: number
}

type JsonRecord = Record<string, any>
type DaemonRuntimeKind = typeof DAEMON_RUNTIME_KIND | 'legacy' | 'unknown'

export type DaemonReadyProbe = {
  ok: boolean
  reachable: boolean
  url: string
  expectedHome: string
  actualHome?: string | undefined
  identityVerified?: boolean | undefined
  sameHomeVerified?: boolean | undefined
  protocolCompatible?: boolean | undefined
  runtimeKind?: DaemonRuntimeKind | undefined
  supportedProviders?: string[] | undefined
  body?: JsonRecord | undefined
  code?: string | undefined
  message?: string | undefined
}

export type ManagedRuntimeInspection = {
  ok: boolean
  package: {
    ok: boolean
    name?: string | undefined
    version?: string | undefined
    platform?: string | undefined
    arch?: string | undefined
    root?: string | undefined
    manifestPath?: string | undefined
    error?: string | null | undefined
    code?: string | undefined
  }
  packaged: {
    ok: boolean
    path: string | null
    hash: string | null
    buildInfo: JsonRecord | null
    error: string | null
    code?: string | undefined
  }
  installed: {
    ok: boolean
    path: string
    hash: string | null
    executable: boolean
    matchesBundled: boolean
    buildInfo: JsonRecord | null
    error: string | null
    code?: string | undefined
  }
  daemon: {
    ok: boolean
    path: string
    hash: string | null
    bundledHash: string | null
    matchesBundled: boolean
  }
}

export type ChromiumBrowser = {
  browser: string
  command: string
  argsPrefix: string[]
  displayName: string
  playwrightExecutablePath?: string | undefined
}

export type EnsureDaemonOptions = {
  homeDir?: string | undefined
  daemonUrl?: string | undefined
  binaryPath?: string | undefined
  bundledRoot?: string | undefined
  timeoutMs?: number | undefined
  requiredProvider?: string | undefined
}

export type StopDaemonResult = {
  ok: true
  status: 'not_running' | 'stopped'
  url: string
  homeDir: string
  pid?: number | undefined
  response?: JsonRecord | undefined
  compactOutput: string
}

export type SetupDaemonReconciliation = {
  attempted: boolean
  action: 'none' | 'refresh_installed_runtime' | 'restart_daemon'
  reason: SetupDaemonReconciliationReason
  reasons?: SetupDaemonReconciliationReason[] | undefined
  stopped?: StopDaemonResult | undefined
  stops?: StopDaemonResult[] | undefined
  refreshed?: string[] | undefined
  previous?: {
    version: string | null
    major: number | null
    pid: number | null
  } | undefined
}

export type SetupDaemonReconciliationReason =
  | 'already_compatible'
  | 'daemon_protocol_mismatch'
  | 'installed_artifact_mismatch'

export type SetupDaemonReadyResult = Awaited<ReturnType<typeof ensureDaemonReady>> & {
  expectedVersion: string
  expectedMajor: number | null
  runningVersion: string | null
  runningMajor: number | null
  protocolCompatible: boolean
  versionCompatible: boolean
  compatibilityPolicy: 'daemon-v1'
  reconciliation: SetupDaemonReconciliation
}

export type BridgeMarker = {
  path: string
  protocol: string
  pid: number
  sessionId: string
  connectedAt: string
  heartbeatAt: string
  heartbeatAgeMs: number
  raw: JsonRecord
}

export function bundledTypeScriptDaemonEntryPath(packageRoot?: string) {
  return path.join(packageRoot ?? cliPackageRoot(), 'dist', 'src', 'daemon', DAEMON_ENTRY_NAME)
}

export async function probeDaemonReady({
  daemonUrl,
  homeDir = tokenlessHome(),
  timeoutMs = 750,
  daemonToken,
  requiredProvider,
}: {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  timeoutMs?: number | undefined
  daemonToken?: string | undefined
  requiredProvider?: string | undefined
} = {}): Promise<DaemonReadyProbe> {
  const url = normalizeDaemonUrl(daemonUrl)
  const expectedHome = await canonicalPath(homeDir)
  let proofToken = daemonToken
  try {
    proofToken ??= await readDaemonToken({ homeDir })
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      url,
      expectedHome,
      code: 'daemon_token_unavailable',
      message: error instanceof Error ? error.message : 'Tokenless daemon token is unavailable.',
    }
  }
  const readyChallenge = randomBytes(32).toString('base64url')
  let response: Response
  try {
    const query = new URLSearchParams({ challenge: readyChallenge })
    response = await fetch(`${url}/ready?${query.toString()}`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return {
      ok: false,
      reachable: false,
      url,
      expectedHome,
      code: 'daemon_unavailable',
      message: 'Tokenless daemon is not reachable.',
    }
  }

  let body: JsonRecord | undefined
  try {
    body = await response.json() as JsonRecord
  } catch {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      code: 'daemon_invalid_ready',
      message: 'Tokenless daemon /ready returned invalid JSON.',
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      body,
      code: 'daemon_not_ready',
      message: `Tokenless daemon /ready returned HTTP ${response.status}.`,
    }
  }

  const proofError = validateDaemonReadyProof(body, readyChallenge, proofToken)
  if (proofError) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      identityVerified: false,
      body,
      code: proofError.code,
      message: proofError.message,
    }
  }
  const identityVerified = true

  const readyHome = readyHomeFromBody(body)
  if (!readyHome) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      identityVerified,
      sameHomeVerified: false,
      body,
      code: 'daemon_identity_missing',
      message: 'Tokenless daemon /ready did not identify its home directory.',
    }
  }
  const actualHome = await canonicalPath(readyHome)
  if (actualHome !== expectedHome) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      actualHome,
      identityVerified,
      sameHomeVerified: false,
      body,
      code: 'daemon_home_mismatch',
      message: `Daemon at ${url} uses ${actualHome}, not requested Tokenless home ${expectedHome}.`,
    }
  }
  const sameHomeVerified = true

  if (body.ready !== true) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      actualHome,
      identityVerified,
      sameHomeVerified,
      body,
      code: 'daemon_not_ready',
      message: 'Tokenless daemon /ready did not report ready=true.',
    }
  }

  const protocolCompatibility = daemonProtocolCompatibility({
    body,
  })
  if (!protocolCompatibility.ok) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      actualHome,
      identityVerified,
      sameHomeVerified,
      protocolCompatible: false,
      supportedProviders: supportedProvidersFromBody(body),
      body,
      code: protocolCompatibility.code,
      message: protocolCompatibility.message,
    }
  }
  const supportedProviders = supportedProvidersFromBody(body)
  const runtimeKind = daemonRuntimeKindFromBody(body)
  if (runtimeKind !== DAEMON_RUNTIME_KIND) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      actualHome,
      identityVerified,
      sameHomeVerified,
      protocolCompatible: true,
      runtimeKind,
      supportedProviders,
      body,
      code: 'daemon_runtime_kind_mismatch',
      message: `Tokenless daemon runtime is ${runtimeKind}; expected ${DAEMON_RUNTIME_KIND}.`,
    }
  }
  if (requiredProvider && !supportedProviders.includes(requiredProvider)) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      actualHome,
      identityVerified,
      sameHomeVerified,
      protocolCompatible: true,
      runtimeKind,
      supportedProviders,
      body,
      code: 'daemon_provider_unsupported',
      message: `Tokenless daemon at ${url} does not advertise Playwright provider support for ${requiredProvider}.`,
    }
  }

  return {
    ok: true,
    reachable: true,
    url,
    expectedHome,
    actualHome,
    identityVerified,
    sameHomeVerified,
    protocolCompatible: true,
    runtimeKind,
    supportedProviders,
    body,
  }
}

export async function ensureDaemonReady({
  homeDir = tokenlessHome(),
  daemonUrl,
  binaryPath,
  bundledRoot,
  timeoutMs = envNumber('TOKENLESS_DAEMON_START_TIMEOUT_MS', DEFAULT_DAEMON_START_TIMEOUT_MS),
  requiredProvider,
}: EnsureDaemonOptions = {}) {
  assertLocalProviderSupport(requiredProvider)
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  const initial = await probeDaemonReady({ daemonUrl, homeDir, requiredProvider })
  if (initial.ok) {
    return { ...initial, started: false, binaryPath: null, pid: daemonPidFromReady(initial) ?? await readDaemonPid(homeDir) }
  } else if (!shouldReplaceLegacyDaemon(initial) && !shouldReplaceProviderIncompatibleDaemon(initial)) {
    assertNoDaemonIdentityConflict(initial)
  }

  const releaseLock = await acquireDaemonStartLock({ homeDir, timeoutMs })
  try {
    const afterLock = await probeDaemonReady({ daemonUrl, homeDir, requiredProvider })
    if (afterLock.ok) {
      return { ...afterLock, started: false, binaryPath: null, pid: daemonPidFromReady(afterLock) ?? await readDaemonPid(homeDir) }
    } else if (shouldReplaceLegacyDaemon(afterLock) || shouldReplaceProviderIncompatibleDaemon(afterLock)) {
      await stopDaemon({ homeDir, daemonUrl, timeoutMs })
    } else {
      assertNoDaemonIdentityConflict(afterLock)
    }

    const daemonEntryPath = binaryPath ?? bundledTypeScriptDaemonEntryPath(bundledRoot)
    await assertDaemonEntryReadable(daemonEntryPath)
    const parsedUrl = new URL(normalizeDaemonUrl(daemonUrl))
    const host = daemonBindHost(parsedUrl.hostname)
    const port = parsedUrl.port ? Number(parsedUrl.port) : 80
    const logPath = path.join(homeDir, DAEMON_LOG_FILE)
    const child = await spawnDaemon({ daemonEntryPath, homeDir, host, port, logPath })
    const pidPayload = {
      protocol: DAEMON_PROCESS_PROTOCOL,
      pid: child.pid,
      homeDir: await canonicalPath(homeDir),
      daemonUrl: parsedUrl.origin,
      binaryPath: process.execPath,
      daemonEntryPath,
      runtimeKind: DAEMON_RUNTIME_KIND,
      logPath,
      startedAt: new Date().toISOString(),
    }
    await writeJsonAtomic(path.join(homeDir, DAEMON_PID_FILE), pidPayload, 0o600)

    try {
      const deadline = Date.now() + timeoutMs
      let lastProbe = afterLock
      while (Date.now() < deadline) {
        lastProbe = await probeDaemonReady({ daemonUrl, homeDir, requiredProvider })
        if (lastProbe.ok) {
          child.unref()
          return {
            ...lastProbe,
            started: true,
            binaryPath: process.execPath,
            daemonEntryPath,
            pid: child.pid,
            logPath,
          }
        }
        assertNoDaemonIdentityConflict(lastProbe)
        if (child.exitCode !== null) break
        await delay(100)
      }

      throw runtimeError(
        'daemon_start_failed',
        `Tokenless TypeScript daemon did not become ready for ${homeDir}. See ${logPath}. Last check: ${lastProbe.message ?? lastProbe.code ?? 'unknown error'}`,
        true
      )
    } catch (error) {
      await terminateSpawnedDaemonChild(child, homeDir)
      throw error
    }
  } finally {
    await releaseLock()
  }
}

export async function ensureSetupDaemonRunnable({
  homeDir = tokenlessHome(),
  daemonUrl,
  timeoutMs = envNumber('TOKENLESS_DAEMON_START_TIMEOUT_MS', DEFAULT_DAEMON_START_TIMEOUT_MS),
}: Pick<EnsureDaemonOptions, 'homeDir' | 'daemonUrl' | 'timeoutMs'> = {}): Promise<SetupDaemonReadyResult> {
  let ready: Awaited<ReturnType<typeof ensureDaemonReady>>
  try {
    ready = await ensureDaemonReady({ homeDir, daemonUrl, timeoutMs })
  } catch (error) {
    const caught = error as RuntimeError
    if (caught.code !== 'daemon_protocol_mismatch') throw error

    const verified = await probeDaemonReady({ homeDir, daemonUrl })
    if (
      verified.code !== caught.code ||
      verified.identityVerified !== true ||
      verified.sameHomeVerified !== true
    ) {
      throw error
    }

    return restartSetupDaemon({
      homeDir,
      daemonUrl,
      timeoutMs,
      previous: protocolMismatchPreviousRuntime(verified),
      reasons: [caught.code],
    })
  }

  const inspection = await inspectManagedRuntime(homeDir)
  if (!inspection.packaged.ok || !inspection.packaged.hash) {
    throw runtimeError(
      inspection.packaged.code ?? inspection.package.code ?? 'daemon_runtime_unavailable',
      inspection.packaged.error ?? inspection.package.error ?? 'Packaged TypeScript daemon runtime is unavailable.',
      false
    )
  }

  const reasons = setupDaemonRuntimeDriftReasons(ready, inspection)
  if (reasons.length === 0) {
    return setupDaemonReadyResult(ready, {
      attempted: false,
      action: 'none',
      reason: 'already_compatible',
    })
  }

  let refreshed: string[]
  try {
    refreshed = await refreshInstalledManagedRuntime({ homeDir })
  } catch (error) {
    throw runtimeError(
      'setup_installed_runtime_refresh_failed',
      `Tokenless setup could not refresh the installed daemon runtime while leaving the compatible running daemon in place: ${error instanceof Error ? error.message : String(error)}`,
      true
    )
  }
  return setupDaemonReadyResult(ready, {
    attempted: refreshed.length > 0,
    action: 'refresh_installed_runtime',
    reason: 'installed_artifact_mismatch',
    reasons,
    refreshed,
    previous: setupDaemonPreviousRuntime(ready),
  })
}

function protocolMismatchPreviousRuntime(
  verified: DaemonReadyProbe
): NonNullable<SetupDaemonReconciliation['previous']> {
  const runningVersion = typeof verified.body?.version === 'string' ? verified.body.version : null
  return {
    version: runningVersion,
    major: runningVersion === null ? null : semanticVersionMajor(runningVersion),
    pid: daemonPidFromReady(verified),
  }
}

async function restartSetupDaemon({
  homeDir,
  daemonUrl,
  timeoutMs,
  previous,
  reasons,
}: {
  homeDir: string
  daemonUrl?: string | undefined
  timeoutMs: number
  previous: NonNullable<SetupDaemonReconciliation['previous']>
  reasons: SetupDaemonReconciliationReason[]
}) {
  return reconcileSetupDaemon({
    homeDir,
    daemonUrl,
    timeoutMs,
    previous,
    reasons,
  })
}

export async function stopDaemon({
  homeDir = tokenlessHome(),
  daemonUrl,
  timeoutMs,
}: {
  homeDir?: string | undefined
  daemonUrl?: string | undefined
  timeoutMs?: number | undefined
} = {}): Promise<StopDaemonResult> {
  const stopTimeoutMs = normalizeStopTimeoutMs(timeoutMs)
  const url = normalizeDaemonUrl(daemonUrl)
  const expectedHome = await canonicalPath(homeDir)
  const reachable = await probeDaemonReachable(url, Math.min(stopTimeoutMs, 1_000))
  if (!reachable.reachable) {
    return {
      ok: true,
      status: 'not_running',
      url,
      homeDir: expectedHome,
      compactOutput: `Tokenless daemon is not running at ${url}.`,
    }
  }
  const token = await readDaemonToken({ homeDir }).catch((error) => {
    throw runtimeError(
      'daemon_stop_identity_unverified',
      `A service is listening at ${url}, but Tokenless cannot read the local daemon token needed to verify it: ${error instanceof Error ? error.message : String(error)} Stop it manually if it is a Tokenless daemon.`,
      false
    )
  })
  const ready = await probeDaemonReady({ homeDir, daemonUrl: url, daemonToken: token, timeoutMs: Math.min(stopTimeoutMs, 1_000) })
  const verifiedStoppableMismatch = ready.code === 'daemon_protocol_mismatch' ||
    ready.code === 'daemon_runtime_kind_mismatch'
  if (!ready.ok && !verifiedStoppableMismatch) {
    const stillReachable = await probeDaemonReachable(url, Math.min(stopTimeoutMs, 1_000))
    if (ready.code === 'daemon_unavailable' && !stillReachable.reachable) {
      return {
        ok: true,
        status: 'not_running',
        url,
        homeDir: expectedHome,
        compactOutput: `Tokenless daemon is not running at ${url}.`,
      }
    }
    throw runtimeError(
      'daemon_stop_identity_unverified',
      `${ready.message ?? 'Tokenless daemon identity could not be verified.'} Tokenless did not send the control token or stop any process. Stop the service bound to ${url} manually if needed.`,
      false
    )
  }
  let response: JsonRecord
  try {
    response = await shutdownDaemon({
      daemonUrl: url,
      requestTimeoutMs: stopTimeoutMs,
      controlToken: token,
    }) as JsonRecord
  } catch (error) {
    const status = typeof (error as RuntimeError).status === 'number' ? (error as RuntimeError).status : undefined
    if (status === 404 || status === 405) {
      const legacyStopped = await stopVerifiedLegacyDaemonWithoutControl({
        ready,
        homeDir: ready.actualHome ?? expectedHome,
        url,
        token,
        stopTimeoutMs,
      })
      if (legacyStopped) return legacyStopped
      throw runtimeError(
        'daemon_shutdown_unsupported',
        `The verified daemon at ${url} does not support bearer-authenticated self-shutdown. Tokenless did not stop any process. Upgrade Tokenless or stop daemon pid ${daemonPidFromReady(ready) ?? '<unknown>'} manually.`,
        false
      )
    }
    throw error
  }
  if (response.ok !== true || response.status !== 'shutting_down') {
    throw runtimeError(
      'daemon_shutdown_unconfirmed',
      `The verified daemon at ${url} returned an invalid graceful-shutdown acknowledgement. Tokenless did not kill any process.`,
      false
    )
  }
  const pid = typeof response.pid === 'number' && Number.isSafeInteger(response.pid) && response.pid > 0
    ? response.pid
    : daemonPidFromReady(ready) ?? undefined
  const stopped = await waitForDaemonListenerGone(url, stopTimeoutMs)
  if (!stopped) {
    throw runtimeError(
      'daemon_shutdown_unconfirmed',
      `The verified daemon at ${url} accepted graceful shutdown, but the loopback listener was still reachable after ${stopTimeoutMs}ms. Tokenless did not kill any process. Stop daemon pid ${pid ?? '<unknown>'} manually if needed.`,
      true
    )
  }
  if (pid !== undefined) await removePidIfOwned(ready.actualHome ?? expectedHome, pid)
  return {
    ok: true,
    status: 'stopped',
    url,
    homeDir: ready.actualHome ?? expectedHome,
    ...(pid === undefined ? {} : { pid }),
    response,
    compactOutput: `Tokenless daemon stopped at ${url}${pid === undefined ? '' : ` (pid ${pid})`}.`,
  }
}

async function stopVerifiedLegacyDaemonWithoutControl({
  ready,
  homeDir,
  url,
  token,
  stopTimeoutMs,
}: {
  ready: DaemonReadyProbe
  homeDir: string
  url: string
  token: string
  stopTimeoutMs: number
}): Promise<StopDaemonResult | null> {
  if (!shouldReplaceLegacyDaemon(ready)) return null
  const verified = await probeDaemonReady({
    homeDir,
    daemonUrl: url,
    daemonToken: token,
    timeoutMs: Math.min(stopTimeoutMs, 1_000),
  })
  if (!shouldReplaceLegacyDaemon(verified)) return null
  const listenerPid = discoverLoopbackListenerPid(url)
  if (listenerPid === null) return null
  const claimedPid = daemonPidFromReady(verified) ?? await readDaemonPid(homeDir)
  if (claimedPid === null || claimedPid !== listenerPid) return null
  const finalVerified = await probeDaemonReady({
    homeDir,
    daemonUrl: url,
    daemonToken: token,
    timeoutMs: Math.min(stopTimeoutMs, 1_000),
  })
  if (!shouldReplaceLegacyDaemon(finalVerified)) return null
  const finalClaimedPid = daemonPidFromReady(finalVerified) ?? await readDaemonPid(homeDir)
  if (finalClaimedPid !== listenerPid) return null
  try {
    process.kill(listenerPid, 'SIGTERM')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') throw error
  }
  let stopped = await waitForDaemonListenerGone(url, stopTimeoutMs)
  if (!stopped && pidIsAlive(listenerPid)) {
    try {
      process.kill(listenerPid, 'SIGKILL')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') throw error
    }
    stopped = await waitForDaemonListenerGone(url, stopTimeoutMs)
  }
  if (!stopped) {
    throw runtimeError(
      'daemon_shutdown_unconfirmed',
      `The verified legacy daemon at ${url} was signaled, but the loopback listener was still reachable after ${stopTimeoutMs}ms. Stop daemon pid ${listenerPid} manually if needed.`,
      true
    )
  }
  await removePidIfOwned(homeDir, listenerPid)
  return {
    ok: true,
    status: 'stopped',
    url,
    homeDir,
    pid: listenerPid,
    response: {
      ok: true,
      status: 'terminated_legacy_daemon',
      pid: listenerPid,
    },
    compactOutput: `Tokenless legacy daemon stopped at ${url} (pid ${listenerPid}).`,
  }
}

function discoverLoopbackListenerPid(url: string): number | null {
  const parsed = new URL(url)
  const port = parsed.port === ''
    ? (parsed.protocol === 'https:' ? '443' : '80')
    : parsed.port
  if (process.platform === 'win32') return discoverWindowsLoopbackListenerPid(port)
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  })
  if (result.status !== 0) return null
  return uniqueLivePid([...result.stdout.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1])))
}

function discoverWindowsLoopbackListenerPid(port: string): number | null {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess`,
  ], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  })
  if (result.status !== 0) return null
  return uniqueLivePid(result.stdout.split(/\s+/).map((value) => Number(value)))
}

function uniqueLivePid(values: number[]): number | null {
  const pids = [...new Set(values)]
    .filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 0 && pidIsAlive(pid))
  if (pids.length !== 1) return null
  const pid = pids[0]!
  return Number.isSafeInteger(pid) && pid > 0 && pidIsAlive(pid) ? pid : null
}

export async function readLiveBridgeMarker({
  homeDir = tokenlessHome(),
  maxAgeMs = envNumber('TOKENLESS_BRIDGE_MAX_AGE_MS', DEFAULT_BRIDGE_MAX_AGE_MS),
}: {
  homeDir?: string | undefined
  maxAgeMs?: number | undefined
} = {}): Promise<BridgeMarker | null> {
  const candidates = [
    path.join(homeDir, EXTENSION_BRIDGE_FILE),
  ]
  for (const markerPath of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(markerPath, 'utf8')) as unknown
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const payload = parsed as JsonRecord
    const marker = normalizeBridgeMarker(markerPath, payload, maxAgeMs)
    if (marker) return marker
  }
  return null
}

export async function waitForExtensionBridge({
  homeDir = tokenlessHome(),
  timeoutMs = envNumber('TOKENLESS_BRIDGE_TIMEOUT_MS', 15_000),
  pollMs = 100,
}: {
  homeDir?: string | undefined
  timeoutMs?: number | undefined
  pollMs?: number | undefined
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const marker = await readLiveBridgeMarker({ homeDir })
    if (marker) return marker
    await delay(pollMs)
  }
  throw runtimeError(
    'extension_bridge_timeout',
    `Tokenless opened the provider page, but the local runtime bridge did not become ready within ${timeoutMs} ms. Run "tokenless doctor --json", then rerun "tokenless setup".`,
    true
  )
}

export function providerWakeUrl(provider: unknown, targetUrl?: unknown) {
  const providerId = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  const providerInstance = getProviderInstanceById(providerId)
  if (!providerInstance) {
    throw runtimeError('unsupported_provider', `Provider must be one of: ${supportedVisibleProviderList()}.`, false)
  }
  const target = providerInstance.navigation.canonicalTarget(targetUrl)
  if (!target) {
    throw runtimeError(
      'invalid_provider_url',
      `Target URL must use HTTPS and belong to the selected ${providerId} provider.`,
      false
    )
  }
  return target.href
}

export async function resolveChromiumBrowser(requested?: unknown): Promise<ChromiumBrowser> {
  const requestedId = requested === undefined || requested === null || requested === ''
    ? null
    : normalizeBrowserId(requested)
  if (requested !== undefined && requested !== null && requested !== '' && !requestedId) {
    throw runtimeError(
      'invalid_browser',
      'Browser must be one of: chrome, chrome-for-testing, chromium, edge, arc, brave.',
      false
    )
  }
  if (requestedId === 'profile') {
    const executable = process.env.TOKENLESS_BROWSER_EXECUTABLE
    if (!executable || !(await isExecutable(executable))) {
      throw runtimeError(
        'browser_not_found',
        'The profile browser is test-only and requires TOKENLESS_BROWSER_EXECUTABLE.',
        false
      )
    }
    return {
      browser: 'profile',
      command: executable,
      argsPrefix: [],
      displayName: 'test browser profile',
      playwrightExecutablePath: executable,
    }
  }

  const order = requestedId
    ? [requestedId]
    : ['chrome', 'brave', 'edge', 'arc', 'chromium']
  for (const browser of order) {
    const launch = await browserLaunch(browser)
    if (launch) return launch
  }
  throw runtimeError(
    'chromium_browser_not_found',
    requestedId
      ? `Configured Chromium browser "${requestedId}" is not installed or executable.`
      : 'No supported Chromium browser was found. Install Chrome, Brave, Edge, Arc, or Chromium, then rerun tokenless setup.',
    false
  )
}

export async function openProviderUrl(url: string, browser: ChromiumBrowser) {
  // Re-validate here so future callers cannot turn this into a general URL launcher.
  const parsed = new URL(url)
  const provider = getProviderInstanceForUrl(parsed.href)
  if (
    !provider ||
    provider.navigation.classify(parsed.href).kind !== 'approved'
  ) {
    throw runtimeError(
      'invalid_provider_url',
      `Tokenless only opens allowlisted ${supportedVisibleProviderList()} HTTPS pages.`,
      false
    )
  }
  const child = spawn(browser.command, [...browser.argsPrefix, parsed.href], {
    detached: true,
    stdio: 'ignore',
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

export async function inspectManagedRuntime(homeDir = tokenlessHome(), packageRoot?: string | undefined) {
  void homeDir
  const packageDir = packageRoot ?? cliPackageRoot()
  const daemon = bundledTypeScriptDaemonEntryPath(packageDir)
  const daemonExecutable = await isReadableFile(daemon)
  const bundledDaemon: string | null = daemon
  const packageCheck: ManagedRuntimeInspection['package'] = {
    ok: true,
    name: 'tokenless',
    version: tokenlessPackageVersion(),
    platform: process.platform,
    arch: process.arch,
    root: packageDir,
    manifestPath: path.join(packageDir, 'package.json'),
    error: null,
  }
  const [daemonHash, bundledDaemonHash, packagedBuildInfo] = await Promise.all([
    fileHash(daemon),
    bundledDaemon ? fileHash(bundledDaemon) : null,
    bundledDaemon ? readTypeScriptDaemonBuildInfo(bundledDaemon) : failedBuildInfo('typescript_daemon_entry_missing', 'TypeScript daemon entry is unavailable.'),
  ])
  const matchesBundled = Boolean(bundledDaemonHash) && daemonHash === bundledDaemonHash
  const installedBuildInfo = matchesBundled && packagedBuildInfo.ok
    ? {
        ok: true,
        buildInfo: packagedBuildInfo.buildInfo,
        error: null as string | null,
        code: undefined as string | undefined,
      }
    : failedBuildInfo(
        daemonHash === null ? 'typescript_daemon_entry_missing' : 'typescript_daemon_entry_hash_mismatch',
        daemonHash === null
          ? `TypeScript daemon entry is missing: ${daemon}`
          : 'TypeScript daemon entry hash does not match the verified packaged daemon; refusing to execute it.',
      )
  const packagedOk = packageCheck.ok && Boolean(bundledDaemon) && Boolean(bundledDaemonHash) && packagedBuildInfo.ok
  const installedOk = daemonExecutable && Boolean(daemonHash) && matchesBundled && installedBuildInfo.ok
  return {
    ok: packagedOk && installedOk,
    package: packageCheck,
    packaged: {
      ok: packagedOk,
      path: bundledDaemon,
      hash: bundledDaemonHash,
      buildInfo: packagedBuildInfo.buildInfo,
      error: packagedBuildInfo.error,
      ...(packagedBuildInfo.code === undefined ? {} : { code: packagedBuildInfo.code }),
    },
    installed: {
      ok: installedOk,
      path: daemon,
      hash: daemonHash,
      executable: daemonExecutable,
      matchesBundled,
      buildInfo: installedBuildInfo.buildInfo,
      error: installedBuildInfo.error,
      ...(installedBuildInfo.code === undefined ? {} : { code: installedBuildInfo.code }),
    },
    daemon: { ok: installedOk, path: daemon, hash: daemonHash, bundledHash: bundledDaemonHash, matchesBundled },
  } satisfies ManagedRuntimeInspection
}

export async function refreshInstalledManagedRuntime({
  homeDir = tokenlessHome(),
  packageRoot,
}: {
  homeDir?: string | undefined
  packageRoot?: string | undefined
} = {}) {
  void homeDir
  const source = bundledTypeScriptDaemonEntryPath(packageRoot)
  const [sourceReadable, sourceBuildInfo] = await Promise.all([
    isReadableFile(source),
    readTypeScriptDaemonBuildInfo(source),
  ])
  if (!sourceReadable) {
    throw runtimeError('typescript_daemon_entry_missing', `TypeScript daemon entry is missing: ${source}`, false)
  }
  if (!sourceBuildInfo.ok) {
    throw runtimeError(
      sourceBuildInfo.code ?? 'typescript_daemon_entry_invalid',
      sourceBuildInfo.error ?? `TypeScript daemon entry has invalid build info: ${source}`,
      false
    )
  }
  return []
}

export async function persistDaemonSnapshot({
  homeDir = tokenlessHome(),
  jobId,
  provider,
  result,
}: {
  homeDir?: string | undefined
  jobId: string
  provider: string
  result: unknown
}) {
  const snapshot = unwrapSnapshot(result)
  if (!snapshot || snapshot.status !== 'snapshotted' || snapshot.sanitized !== true) {
    throw runtimeError(
      'invalid_snapshot_payload',
      'Daemon snapshot result is missing a sanitized snapshot payload.',
      false
    )
  }
  const snapshotProvider = safeSegment(snapshot.provider ?? provider)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(snapshotsDir(homeDir), snapshotProvider, `${stamp}-${safeSegment(jobId)}`)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const htmlPath = path.join(dir, 'dom.sanitized.html')
  const probesPath = path.join(dir, 'selector-probes.json')
  const metadataPath = path.join(dir, 'metadata.json')
  const textPath = typeof snapshot.visibleText === 'string'
    ? path.join(dir, 'visible-text.txt')
    : null
  await fs.writeFile(htmlPath, `${typeof snapshot.html === 'string' ? snapshot.html : ''}\n`, { mode: 0o600 })
  await fs.writeFile(probesPath, `${JSON.stringify(snapshot.selectorProbes ?? {}, null, 2)}\n`, { mode: 0o600 })
  if (textPath) await fs.writeFile(textPath, `${snapshot.visibleText}\n`, { mode: 0o600 })
  const metadata = {
    protocol: DAEMON_SNAPSHOT_PROTOCOL,
    jobId,
    provider: snapshot.provider ?? provider,
    action: 'snapshot_dom',
    capturedAt: snapshot.capturedAt ?? new Date().toISOString(),
    url: snapshot.url,
    title: snapshot.title,
    sanitized: true,
    includeText: Boolean(snapshot.includeText),
    htmlPath,
    selectorProbesPath: probesPath,
    visibleTextPath: textPath,
  }
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
  return { ...metadata, snapshotDir: dir, metadataPath }
}

async function spawnDaemon({
  daemonEntryPath,
  homeDir,
  host,
  port,
  logPath,
}: {
  daemonEntryPath: string
  homeDir: string
  host: string
  port: number
  logPath: string
}) {
  const logFd = fsSync.openSync(logPath, 'a', 0o600)
  const child = spawn(process.execPath, [
    daemonEntryPath,
    '--home',
    homeDir,
    'serve',
    '--host',
    host,
    '--port',
    String(port),
  ], {
    detached: process.platform !== 'win32',
    env: { ...process.env, TOKENLESS_HOME: homeDir },
    stdio: ['ignore', logFd, logFd],
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } catch (error) {
    throw runtimeError(
      'daemon_start_failed',
      `Could not start Tokenless TypeScript daemon: ${error instanceof Error ? error.message : String(error)}`,
      true
    )
  } finally {
    fsSync.closeSync(logFd)
  }
  if (!child.pid) {
    throw runtimeError('daemon_start_failed', 'Tokenless TypeScript daemon started without a process id.', true)
  }
  return child as typeof child & { pid: number }
}

export function semanticVersionMajor(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}

async function probeDaemonReachable(url: string, timeoutMs: number) {
  const parsed = new URL(url)
  const host = daemonBindHost(parsed.hostname)
  const port = parsed.port === ''
    ? (parsed.protocol === 'https:' ? 443 : 80)
    : Number(parsed.port)
  try {
    await tcpConnect({ host, port, timeoutMs: normalizeStopTimeoutMs(timeoutMs) })
    return { reachable: true }
  } catch {
    return { reachable: false }
  }
}

async function waitForDaemonListenerGone(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  do {
    const reachable = await probeDaemonReachable(url, Math.min(500, Math.max(1, deadline - Date.now())))
    if (!reachable.reachable) return true
    await delay(100)
  } while (Date.now() < deadline)
  return !(await probeDaemonReachable(url, 250)).reachable
}

function tcpConnect({ host, port, timeoutMs }: { host: string; port: number; timeoutMs: number }) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('timeout')))
    socket.once('connect', () => finish())
    socket.once('error', finish)
  })
}

function normalizeStopTimeoutMs(value: number | undefined) {
  const numeric = value === undefined ? DEFAULT_DAEMON_STOP_TIMEOUT_MS : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric) || numeric > MAX_TIMEOUT_MS) {
    throw runtimeError(
      'invalid_daemon_stop_timeout',
      `daemon stop --timeout-ms must be a finite positive integer no greater than ${MAX_TIMEOUT_MS}.`,
      false
    )
  }
  return Math.max(1, Math.floor(numeric))
}

function setupDaemonReadyResult(
  ready: Awaited<ReturnType<typeof ensureDaemonReady>>,
  reconciliation: SetupDaemonReconciliation
): SetupDaemonReadyResult {
  const expectedVersion = tokenlessPackageVersion()
  const runningVersion = typeof ready.body?.version === 'string' ? ready.body.version : null
  const expectedMajor = semanticVersionMajor(expectedVersion)
  const runningMajor = runningVersion === null ? null : semanticVersionMajor(runningVersion)
  const versionCompatible = runningVersion === expectedVersion
  return {
    ...ready,
    expectedVersion,
    expectedMajor,
    runningVersion,
    runningMajor,
    protocolCompatible: ready.protocolCompatible === true,
    versionCompatible,
    compatibilityPolicy: 'daemon-v1',
    reconciliation,
  }
}

async function reconcileSetupDaemon({
  homeDir,
  daemonUrl,
  timeoutMs,
  previous,
  reasons,
}: {
  homeDir: string
  daemonUrl?: string | undefined
  timeoutMs: number
  previous: NonNullable<SetupDaemonReconciliation['previous']>
  reasons: SetupDaemonReconciliationReason[]
}) {
  let accumulatedReasons = uniqueSetupDaemonReconciliationReasons(reasons)
  const stops: StopDaemonResult[] = []
  const refreshedPaths = new Set<string>()
  let lastDriftReasons = accumulatedReasons

  for (let attempt = 0; attempt < SETUP_DAEMON_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
    const stopped = await stopDaemon({ homeDir, daemonUrl, timeoutMs })
    stops.push(stopped)
    const refreshed = await refreshInstalledManagedRuntime({ homeDir })
    for (const refreshedPath of refreshed) refreshedPaths.add(refreshedPath)

    let restarted: Awaited<ReturnType<typeof ensureDaemonReady>>
    try {
      restarted = await ensureDaemonReady({ homeDir, daemonUrl, timeoutMs })
    } catch (error) {
      const racedReasons = await setupDaemonVerifiedMismatchReasons({
        homeDir,
        daemonUrl,
        originalError: error,
      })
      if (racedReasons === null) throw error
      lastDriftReasons = racedReasons
      accumulatedReasons = uniqueSetupDaemonReconciliationReasons([
        ...accumulatedReasons,
        ...racedReasons,
      ])
      if (attempt + 1 < SETUP_DAEMON_RECONCILE_MAX_ATTEMPTS) continue
      throw setupDaemonReconciliationFailedError({ homeDir, daemonUrl, reasons: lastDriftReasons })
    }

    const inspection = await inspectManagedRuntime(homeDir)
    if (!inspection.packaged.ok || !inspection.packaged.hash) {
      throw runtimeError(
        inspection.packaged.code ?? inspection.package.code ?? 'daemon_runtime_unavailable',
        inspection.packaged.error ?? inspection.package.error ?? 'Packaged TypeScript daemon runtime is unavailable.',
        false
      )
    }

    const driftReasons = setupDaemonRuntimeDriftReasons(restarted, inspection)
    if (driftReasons.length === 0) {
      return setupDaemonReadyResult(restarted, {
        attempted: true,
        action: 'restart_daemon',
        reason: accumulatedReasons[0] ?? 'daemon_protocol_mismatch',
        reasons: accumulatedReasons,
        stopped: stops[stops.length - 1],
        ...(stops.length > 1 ? { stops } : {}),
        refreshed: [...refreshedPaths],
        previous,
      })
    }

    lastDriftReasons = driftReasons
    accumulatedReasons = uniqueSetupDaemonReconciliationReasons([
      ...accumulatedReasons,
      ...driftReasons,
    ])
  }

  throw setupDaemonReconciliationFailedError({ homeDir, daemonUrl, reasons: lastDriftReasons })
}

function setupDaemonRuntimeDriftReasons(
  _ready: Awaited<ReturnType<typeof ensureDaemonReady>>,
  inspection: ManagedRuntimeInspection
): SetupDaemonReconciliationReason[] {
  const reasons: SetupDaemonReconciliationReason[] = []
  if (!inspection.installed.executable || !inspection.installed.matchesBundled) reasons.push('installed_artifact_mismatch')
  return reasons
}

function setupDaemonPreviousRuntime(
  ready: Awaited<ReturnType<typeof ensureDaemonReady>>
): NonNullable<SetupDaemonReconciliation['previous']> {
  const runningVersion = typeof ready.body?.version === 'string' ? ready.body.version : null
  return {
    version: runningVersion,
    major: runningVersion === null ? null : semanticVersionMajor(runningVersion),
    pid: daemonPidFromReady(ready),
  }
}

async function setupDaemonVerifiedMismatchReasons({
  homeDir,
  daemonUrl,
  originalError,
}: {
  homeDir: string
  daemonUrl?: string | undefined
  originalError: unknown
}) {
  const caught = originalError as RuntimeError
  if (caught.code !== 'daemon_protocol_mismatch') return null
  const verified = await probeDaemonReady({ homeDir, daemonUrl })
  if (
    verified.code !== caught.code ||
    verified.identityVerified !== true ||
    verified.sameHomeVerified !== true
  ) {
    return null
  }
  return [caught.code] satisfies SetupDaemonReconciliationReason[]
}

function uniqueSetupDaemonReconciliationReasons(reasons: SetupDaemonReconciliationReason[]) {
  return [...new Set(reasons)]
}

function setupDaemonReconciliationFailedError({
  homeDir,
  daemonUrl,
  reasons,
}: {
  homeDir: string
  daemonUrl?: string | undefined
  reasons: SetupDaemonReconciliationReason[]
}) {
  const url = normalizeDaemonUrl(daemonUrl)
  const reasonText = reasons.length ? reasons.join(', ') : 'unknown drift'
  return runtimeError(
    'setup_daemon_reconcile_unverified',
    `Tokenless setup restarted the same-home daemon at ${url}, but exact runtime drift remained after ${SETUP_DAEMON_RECONCILE_MAX_ATTEMPTS} reconciliation attempts for ${homeDir}: ${reasonText}. Stop the daemon and rerun "tokenless setup".`,
    true
  )
}

function daemonPidFromReady(probe: DaemonReadyProbe) {
  const pid = probe.body?.pid
  return Number.isSafeInteger(pid) && pid > 0 ? pid as number : null
}

async function readTypeScriptDaemonBuildInfo(daemonEntryPath: string) {
  if (!(await isReadableFile(daemonEntryPath))) {
    return failedBuildInfo('typescript_daemon_entry_missing', `TypeScript daemon entry is missing: ${daemonEntryPath}`)
  }
  let result: Awaited<ReturnType<typeof execFileJson>>
  try {
    result = await execFileJson(process.execPath, [daemonEntryPath, '--tokenless-build-info'])
  } catch (error) {
    return failedBuildInfo(
      'typescript_daemon_build_info_failed',
      error instanceof Error ? error.message : String(error)
    )
  }
  const buildInfo = result.value
  const expectedVersion = tokenlessPackageVersion()
  const valid = isRecord(buildInfo) &&
    buildInfo.protocol === DAEMON_PROTOCOL &&
    buildInfo.binary === 'tokenless-daemon' &&
    buildInfo.version === expectedVersion &&
    buildInfo.platform === process.platform &&
    buildInfo.arch === process.arch
  if (!valid) {
    return failedBuildInfo(
      'typescript_daemon_build_info_mismatch',
      `TypeScript daemon build info for ${daemonEntryPath} does not match tokenless@${expectedVersion} on ${process.platform}-${process.arch}.`,
      isRecord(buildInfo) ? buildInfo : null
    )
  }
  return { ok: true, buildInfo: buildInfo as JsonRecord, error: null as string | null, code: undefined as string | undefined }
}

function failedBuildInfo(code: string, error: string, buildInfo: JsonRecord | null = null) {
  return { ok: false, code, error, buildInfo }
}

async function acquireDaemonStartLock({ homeDir, timeoutMs }: { homeDir: string; timeoutMs: number }) {
  const lockPath = path.join(homeDir, '.daemon-start.lock')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 })
      return async () => fs.rm(lockPath, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const stat = await fs.stat(lockPath).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > timeoutMs) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      await delay(100)
    }
  }
  throw runtimeError(
    'daemon_start_locked',
    `Timed out waiting for another Tokenless daemon startup in ${homeDir}.`,
    true
  )
}

function normalizeBridgeMarker(markerPath: string, payload: JsonRecord, maxAgeMs: number): BridgeMarker | null {
  const expectedKeys = ['connectedAt', 'heartbeatAt', 'pid', 'protocol', 'sessionId']
  const actualKeys = Object.keys(payload).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return null
  }
  if (payload.protocol !== EXTENSION_BRIDGE_PROTOCOL) return null
  const pid = payload.pid
  const sessionId = payload.sessionId
  const connectedMs = strictIsoTimestampMs(payload.connectedAt)
  const heartbeatMs = strictIsoTimestampMs(payload.heartbeatAt)
  if (
    !Number.isInteger(pid) ||
    (pid as number) <= 0 ||
    (pid as number) > 2_147_483_647 ||
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    connectedMs === null ||
    heartbeatMs === null
  ) {
    return null
  }
  const now = Date.now()
  if (
    connectedMs > now + BRIDGE_CLOCK_TOLERANCE_MS ||
    heartbeatMs > now + BRIDGE_CLOCK_TOLERANCE_MS ||
    connectedMs > heartbeatMs + BRIDGE_CLOCK_TOLERANCE_MS
  ) {
    return null
  }
  const heartbeatAgeMs = Math.max(0, now - heartbeatMs)
  if (heartbeatAgeMs > maxAgeMs || !pidIsAlive(pid)) return null
  return {
    path: markerPath,
    protocol: EXTENSION_BRIDGE_PROTOCOL,
    pid,
    sessionId,
    connectedAt: new Date(connectedMs).toISOString(),
    heartbeatAt: new Date(heartbeatMs).toISOString(),
    heartbeatAgeMs,
    raw: payload,
  }
}

function strictIsoTimestampMs(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null
}

function pidIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    return false
  }
}

function assertNoDaemonIdentityConflict(probe: DaemonReadyProbe) {
  if (!probe.reachable) return
  throw runtimeError(
    probe.code ?? 'daemon_not_ready',
    probe.message ?? `Daemon at ${probe.url} is reachable but cannot be used.`,
    false
  )
}

function shouldReplaceLegacyDaemon(probe: DaemonReadyProbe) {
  return probe.code === 'daemon_runtime_kind_mismatch' &&
    probe.identityVerified === true &&
    probe.sameHomeVerified === true &&
    probe.runtimeKind === 'legacy'
}

function shouldReplaceProviderIncompatibleDaemon(probe: DaemonReadyProbe) {
  return probe.code === 'daemon_provider_unsupported' &&
    probe.identityVerified === true &&
    probe.sameHomeVerified === true &&
    probe.runtimeKind === DAEMON_RUNTIME_KIND
}

function assertLocalProviderSupport(requiredProvider: string | undefined) {
  if (!requiredProvider) return
  const provider = getProviderInstanceById(requiredProvider)
  if (provider && provider.descriptor.stage !== 'disabled') return
  throw runtimeError(
    'daemon_provider_unsupported',
    `This Tokenless build does not support Playwright provider ${requiredProvider}.`,
    false
  )
}

function supportedVisibleProviderList() {
  return listProviderDescriptors()
    .filter((provider) => provider.stage !== 'disabled')
    .map((provider) => provider.id)
    .join(', ')
}

async function readDaemonPid(homeDir: string) {
  try {
    const payload = JSON.parse(await fs.readFile(path.join(homeDir, DAEMON_PID_FILE), 'utf8')) as JsonRecord
    return Number.isInteger(payload.pid) && pidIsAlive(payload.pid) ? payload.pid as number : null
  } catch {
    return null
  }
}

async function removePidIfOwned(homeDir: string, pid: number) {
  const pidPath = path.join(homeDir, DAEMON_PID_FILE)
  try {
    const payload = JSON.parse(await fs.readFile(pidPath, 'utf8')) as JsonRecord
    if (payload.pid === pid) await fs.rm(pidPath, { force: true })
  } catch {
    // Best-effort cleanup after a failed start.
  }
}

async function terminateSpawnedDaemonChild(child: ReturnType<typeof spawn> & { pid: number }, homeDir: string) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGTERM')
    } catch {
      // The child may have exited between the readiness failure and cleanup.
    }
    for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt += 1) {
      await delay(100)
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Best-effort final cleanup for a child we just spawned.
      }
    }
  }
  await removePidIfOwned(homeDir, child.pid)
}

function readyHomeFromBody(body: JsonRecord) {
  const value = body.home_dir
  return typeof value === 'string' && value.trim() ? value : null
}

function validateDaemonReadyProof(body: JsonRecord, challenge: string, token: string) {
  if (
    body.protocol !== DAEMON_PROTOCOL ||
    body.ready_challenge !== challenge ||
    typeof body.home_dir !== 'string' ||
    typeof body.ready_proof !== 'string'
  ) {
    return {
      code: 'daemon_ready_proof_missing',
      message: 'Tokenless daemon /ready did not return a complete challenge-bound identity proof. Reinstall Tokenless.',
    }
  }
  let actualProof: Buffer
  try {
    actualProof = Buffer.from(body.ready_proof, 'base64url')
  } catch {
    actualProof = Buffer.alloc(0)
  }
  if (actualProof.length !== 32 || actualProof.toString('base64url') !== body.ready_proof) {
    return {
      code: 'daemon_ready_proof_invalid',
      message: 'Tokenless daemon /ready returned an invalid identity proof.',
    }
  }
  const expectedProof = createHmac('sha256', token)
    .update(daemonReadyProofMessage([
      DAEMON_PROTOCOL,
      challenge,
      body.home_dir,
    ]))
    .digest()
  if (!timingSafeEqual(actualProof, expectedProof)) {
    return {
      code: 'daemon_ready_proof_mismatch',
      message: 'Daemon identity proof does not match this Tokenless home; refusing to send its control token.',
    }
  }
  return null
}

function daemonProtocolCompatibility({
  body,
}: {
  body: JsonRecord
}): { ok: true } | { ok: false; code: 'daemon_protocol_mismatch'; message: string } {
  if (body.protocol !== DAEMON_PROTOCOL) {
    return {
      ok: false,
      code: 'daemon_protocol_mismatch',
      message: `Tokenless daemon protocol is ${String(body.protocol ?? 'missing')}; expected ${DAEMON_PROTOCOL}.`,
    }
  }
  return { ok: true }
}

function supportedProvidersFromBody(body: JsonRecord) {
  if (body.supported_providers === undefined) return [...LEGACY_DAEMON_SUPPORTED_PROVIDERS]
  const values = stringArray(body.supported_providers)
  return values ? [...new Set(values)] : []
}

function daemonRuntimeKindFromBody(body: JsonRecord): DaemonRuntimeKind {
  if (body.runtime_kind === undefined || body.runtime_kind === null) return 'legacy'
  if (body.runtime_kind === DAEMON_RUNTIME_KIND) return DAEMON_RUNTIME_KIND
  return 'unknown'
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value as string[]
    : null
}

function daemonReadyProofMessage(fields: string[]) {
  const chunks: Buffer[] = []
  for (const field of fields) {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    chunks.push(length, value)
  }
  return Buffer.concat(chunks)
}

function daemonBindHost(hostname: string) {
  if (hostname === 'localhost') return '127.0.0.1'
  if (hostname === '[::1]') return '::1'
  return hostname
}

async function canonicalPath(value: string) {
  const resolved = path.resolve(value)
  return fs.realpath(resolved).catch(() => resolved)
}

async function isExecutable(file: string) {
  try {
    await fs.access(file, process.platform === 'win32' ? fsSync.constants.F_OK : fsSync.constants.X_OK)
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

async function isReadableFile(file: string) {
  try {
    await fs.access(file, fsSync.constants.R_OK)
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

async function assertDaemonEntryReadable(daemonEntryPath: string) {
  if (await isReadableFile(daemonEntryPath)) return
  throw runtimeError(
    'typescript_daemon_entry_missing',
    `TypeScript daemon entry is missing: ${daemonEntryPath}. Run npm run build:js before starting the daemon.`,
    false
  )
}

function cliPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function browserLaunch(browser: string): Promise<ChromiumBrowser | null> {
  const displayNames: Record<string, string> = {
    chrome: 'Google Chrome',
    'chrome-for-testing': 'Google Chrome for Testing',
    brave: 'Brave Browser',
    edge: 'Microsoft Edge',
    arc: 'Arc',
    chromium: 'Chromium',
  }
  if (process.platform === 'darwin') {
    const appNames: Record<string, string> = {
      chrome: 'Google Chrome.app',
      'chrome-for-testing': 'Google Chrome for Testing.app',
      brave: 'Brave Browser.app',
      edge: 'Microsoft Edge.app',
      arc: 'Arc.app',
      chromium: 'Chromium.app',
    }
    const appName = appNames[browser]
    if (!appName) return null
    const appPath = await firstExistingFile([path.join('/Applications', appName), path.join(os.homedir(), 'Applications', appName)])
    if (!appPath) return null
    const executableNames: Record<string, string> = {
      chrome: 'Google Chrome',
      'chrome-for-testing': 'Google Chrome for Testing',
      brave: 'Brave Browser',
      edge: 'Microsoft Edge',
      arc: 'Arc',
      chromium: 'Chromium',
    }
    const playwrightExecutablePath = path.join(appPath, 'Contents', 'MacOS', executableNames[browser] as string)
    if (!(await isExecutable(playwrightExecutablePath))) return null
    return {
      browser,
      command: '/usr/bin/open',
      argsPrefix: ['-a', displayNames[browser] as string],
      displayName: displayNames[browser] as string,
      playwrightExecutablePath,
    }
  }

  if (process.platform === 'win32') {
    const relativeExecutables: Record<string, string[]> = {
      chrome: ['Google/Chrome/Application/chrome.exe'],
      brave: ['BraveSoftware/Brave-Browser/Application/brave.exe'],
      edge: ['Microsoft/Edge/Application/msedge.exe'],
      arc: ['TheBrowserCompany/Arc/Application/Arc.exe'],
      chromium: ['Chromium/Application/chrome.exe'],
    }
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
      .filter((value): value is string => Boolean(value))
    const candidates = roots.flatMap((root) => (relativeExecutables[browser] ?? []).map((relative) => path.join(root, relative)))
    const executable = await firstExistingFile(candidates)
    return executable
      ? { browser, command: executable, argsPrefix: [], displayName: displayNames[browser] as string, playwrightExecutablePath: executable }
      : null
  }

  const executableNames: Record<string, string[]> = {
    chrome: ['google-chrome', 'google-chrome-stable'],
    'chrome-for-testing': ['google-chrome-for-testing'],
    brave: ['brave-browser', 'brave'],
    edge: ['microsoft-edge', 'microsoft-edge-stable'],
    arc: ['arc'],
    chromium: ['chromium', 'chromium-browser'],
  }
  const executable = await findOnPath(executableNames[browser] ?? [])
  return executable
    ? { browser, command: executable, argsPrefix: [], displayName: displayNames[browser] as string, playwrightExecutablePath: executable }
    : null
}

async function firstExistingFile(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile() || (await fs.stat(candidate)).isDirectory()) return candidate
    } catch {
      // Keep searching.
    }
  }
  return null
}

async function findOnPath(names: string[]) {
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const name of names) {
    for (const directory of directories) {
      const candidate = path.join(directory, name)
      if (await isExecutable(candidate)) return candidate
    }
  }
  return null
}

async function fileHash(file: string) {
  try {
    const contents = await fs.readFile(file)
    return createHash('sha256').update(contents).digest('hex')
  } catch {
    return null
  }
}

function unwrapSnapshot(result: unknown): JsonRecord | null {
  if (!result || typeof result !== 'object') return null
  const value = result as JsonRecord
  if (value.status === 'snapshotted') return value
  if (value.snapshot?.status === 'snapshotted') return value.snapshot
  if (value.result?.status === 'snapshotted') return value.result
  if (value.result?.snapshot?.status === 'snapshotted') return value.result.snapshot
  const responses = Array.isArray(value.responses)
    ? value.responses
    : Array.isArray(value.result?.responses)
      ? value.result.responses
      : []
  for (const response of responses) {
    if (!response || typeof response !== 'object') continue
    const snapshot = (response as JsonRecord).result
    if (snapshot?.status === 'snapshotted') return snapshot
  }
  return null
}

function safeSegment(value: unknown) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'provider'
}

async function writeJsonAtomic(file: string, payload: unknown, mode: number) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode })
  await fs.rename(temporary, file)
}

async function execFileJson(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let outputBytes = 0
  let settled = false
  const limitOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    outputBytes += chunk.byteLength
    if (outputBytes > BUILD_INFO_OUTPUT_LIMIT_BYTES) {
      child.kill('SIGTERM')
      throw runtimeError(
        'daemon_runtime_build_info_too_large',
        `${command} --tokenless-build-info exceeded ${BUILD_INFO_OUTPUT_LIMIT_BYTES} bytes of output.`,
        false
      )
    }
    if (stream === 'stdout') stdout += chunk.toString('utf8')
    else stderr += chunk.toString('utf8')
  }
  let streamError: RuntimeError | null = null
  child.stdout?.on('data', (chunk: Buffer) => {
    try {
      limitOutput('stdout', chunk)
    } catch (error) {
      streamError = error as RuntimeError
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    try {
      limitOutput('stderr', chunk)
    } catch (error) {
      streamError = error as RuntimeError
    }
  })
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(runtimeError(
        'daemon_runtime_build_info_timeout',
        `${command} --tokenless-build-info did not exit within ${BUILD_INFO_TIMEOUT_MS} ms.`,
        false
      ))
    }, BUILD_INFO_TIMEOUT_MS)
    child.once('error', reject)
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
  if (streamError) throw streamError
  if (exitCode !== 0) {
    throw runtimeError('daemon_runtime_build_info_failed', `${command} failed: ${stderr.trim()}`, false)
  }
  try {
    return { value: JSON.parse(stdout) as unknown }
  } catch (error) {
    throw runtimeError(
      'daemon_runtime_build_info_invalid',
      `${command} returned invalid build info JSON: ${error instanceof Error ? error.message : String(error)}`,
      false
    )
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function objectRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function runtimeError(code: string, message: string, retryable: boolean): RuntimeError {
  const error = new Error(message) as RuntimeError
  error.code = code
  error.retryable = retryable
  return error
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
