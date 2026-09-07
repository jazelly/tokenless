import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeBrowserId,
  snapshotsDir,
  tokenlessHome,
} from '#tokenless-server/persistence/config.js'
import { daemonUrl as normalizeDaemonUrl, readDaemonToken, resolveDaemonUrl, shutdownDaemon } from '../http/daemon-client.js'
import { getProviderInstanceById, listProviderDescriptors } from '#tokenless-server/providers/registry.js'
import {
  DAEMON_CONTROL_API_REVISION,
  DAEMON_SNAPSHOT_SCHEMA_ID,
} from '#tokenless-server/schema-ids.js'
import { tokenlessPackageVersion } from '#tokenless-server/platform-package.js'
import { daemonReadyProof } from '#tokenless-server/runtime/ready-proof.js'
import { BrowserRuntimeManager } from '#tokenless-server/browser/runtime/manager.js'
import type {
  SnapshotDiagnosticElement,
  SnapshotResponseCandidate,
  SnapshotResponseDiagnostics,
  SnapshotResponseSelectorDiagnostics,
} from '#tokenless-server/browser/actions.js'

export {
  DAEMON_CONTROL_API_REVISION,
  DAEMON_SNAPSHOT_SCHEMA_ID,
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3,
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V4,
  VISIBLE_ACTION_SCHEMA_ID,
  VISIBLE_ACTION_SCHEMA_ID_V3,
} from '#tokenless-server/schema-ids.js'
export const DAEMON_LOG_FILE = 'daemon.log'

const DEFAULT_DAEMON_START_TIMEOUT_MS = 10_000
const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 2_147_483_647
const BUILD_INFO_TIMEOUT_MS = 2_000
const BUILD_INFO_OUTPUT_LIMIT_BYTES = 16_384
const SNAPSHOT_DIAGNOSTICS_MAX_BYTES = 64 * 1024
const SNAPSHOT_DIAGNOSTICS_MAX_SELECTORS = 8
const SNAPSHOT_DIAGNOSTICS_MAX_CANDIDATES = 3
const SNAPSHOT_DIAGNOSTICS_MAX_ANCESTORS = 3
const SNAPSHOT_DIAGNOSTIC_TAGS = new Set<SnapshotDiagnosticElement['tag']>(['article', 'blockquote', 'button', 'code', 'div', 'element', 'li', 'main', 'ol', 'p', 'pre', 'section', 'span', 'ul'])
const SNAPSHOT_DIAGNOSTIC_VALUES = {
  role: new Set<NonNullable<SnapshotDiagnosticElement['role']>>(['button', 'textbox', 'menuitem', 'option', 'combobox', 'listbox']),
  boolean: new Set<NonNullable<SnapshotDiagnosticElement['ariaBusy']>>(['true', 'false']),
  ariaLive: new Set<NonNullable<SnapshotDiagnosticElement['ariaLive']>>(['assertive', 'off', 'polite']),
  dataState: new Set<NonNullable<SnapshotDiagnosticElement['dataState']>>(['active', 'closed', 'complete', 'idle', 'inactive', 'loading', 'open', 'pending']),
}

type RuntimeError = Error & {
  code?: string
  retryable?: boolean
  status?: number
}

type JsonRecord = Record<string, any>

type DaemonReadyProbeBase = {
  reachable: boolean
  url: string
  expectedHome: string
  body?: JsonRecord | undefined
}

export type DaemonReadyProbe = (DaemonReadyProbeBase & {
  ok: true
  reachable: true
  actualHome: string
  identityVerified: true
  sameHomeVerified: true
  body: JsonRecord
}) | (DaemonReadyProbeBase & {
  ok: false
  actualHome?: string | undefined
  identityVerified?: boolean | undefined
  sameHomeVerified?: boolean | undefined
  code?: string | undefined
  message?: string | undefined
})

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
  daemon: {
    ok: boolean
    path: string
    executable: boolean
    buildInfo: JsonRecord | null
    error: string | null
    code?: string | undefined
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

export type SetupDaemonReadyResult = Awaited<ReturnType<typeof ensureDaemonReady>> & {
  expectedVersion: string
  expectedMajor: number | null
  runningVersion: string | null
  runningMajor: number | null
  versionCompatible: boolean
  expectedControlApiRevision: number
  runningControlApiRevision: number | null
  controlApiCompatible: boolean
}

export function bundledTypeScriptDaemonEntryPath(packageRoot?: string) {
  return path.join(packageRoot ?? cliPackageRoot(), 'dist', 'src', 'bootstrap', 'daemon-entry.mjs')
}

export async function probeDaemonReady({
  daemonUrl,
  homeDir = tokenlessHome(),
  timeoutMs = 750,
  daemonToken,
}: {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  timeoutMs?: number | undefined
  daemonToken?: string | undefined
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

  const expectedVersion = tokenlessPackageVersion()
  const runningVersion = typeof body.version === 'string' ? body.version : null
  if (runningVersion !== expectedVersion) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      actualHome,
      identityVerified,
      sameHomeVerified,
      body,
      code: 'daemon_version_mismatch',
      message: `Tokenless daemon version is ${runningVersion ?? 'missing'}; expected ${expectedVersion}.`,
    }
  }

  const runningControlApiRevision = body.control_api_revision
  if (runningControlApiRevision !== DAEMON_CONTROL_API_REVISION) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      actualHome,
      identityVerified,
      sameHomeVerified,
      body,
      code: 'daemon_control_api_revision_mismatch',
      message: `Tokenless daemon control API revision is ${Number.isSafeInteger(runningControlApiRevision) ? runningControlApiRevision : 'missing'}; expected ${DAEMON_CONTROL_API_REVISION}.`,
    }
  }

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

  return {
    ok: true,
    reachable: true,
    url,
    expectedHome,
    actualHome,
    identityVerified,
    sameHomeVerified,
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
  const preferredUrl = await resolveDaemonUrl({ explicitUrl: daemonUrl, homeDir })
  const deadline = Date.now() + timeoutMs
  const initial = await probeDaemonReady({ daemonUrl: preferredUrl, homeDir })
  if (initial.ok) return daemonReadyResult(initial, false, null)
  if (isReplaceableDaemonCompatibilityMismatch(initial)) {
    await stopDaemon({ homeDir, daemonUrl: preferredUrl, timeoutMs })
  }

  const daemonEntryPath = binaryPath ?? bundledTypeScriptDaemonEntryPath(bundledRoot)
  await assertDaemonEntryRunnable(daemonEntryPath)
  const parsedUrl = new URL(preferredUrl)
  const host = daemonBindHost(parsedUrl.hostname)
  const port = parsedUrl.port ? Number(parsedUrl.port) : 80
  const logPath = path.join(homeDir, DAEMON_LOG_FILE)
  const child = await spawnDaemon({
    daemonEntryPath,
    homeDir,
    host,
    port,
    logPath,
  })

  try {
    let lastProbe: DaemonReadyProbe = initial
    while (Date.now() < deadline) {
      const candidate = await probeDaemonReady({ daemonUrl: preferredUrl, homeDir })
      if (candidate.ok) {
        lastProbe = candidate
        const actualPid = daemonPidFromReady(lastProbe) ?? child.pid
        child.unref()
        return {
          ...lastProbe,
          started: true,
          binaryPath: process.execPath,
          daemonEntryPath,
          pid: actualPid,
          logPath,
        }
      }
      lastProbe = candidate
      if (child.exitCode !== null) break
      await delay(100)
    }
    const failedProbe = !lastProbe.ok ? lastProbe : null
    throw runtimeError(
      'daemon_start_failed',
      `Tokenless TypeScript daemon did not become ready for ${homeDir}. See ${logPath}. Last check: ${failedProbe?.message ?? failedProbe?.code ?? 'unknown error'}`,
      true
    )
  } catch (error) {
    await terminateSpawnedDaemonChild(child)
    throw error
  }
}

export async function ensureSetupDaemonRunnable({
  homeDir = tokenlessHome(),
  daemonUrl,
  timeoutMs = envNumber('TOKENLESS_DAEMON_START_TIMEOUT_MS', DEFAULT_DAEMON_START_TIMEOUT_MS),
}: Pick<EnsureDaemonOptions, 'homeDir' | 'daemonUrl' | 'timeoutMs'> = {}): Promise<SetupDaemonReadyResult> {
  const inspection = await inspectManagedRuntime(homeDir)
  if (!inspection.daemon.ok) {
    throw runtimeError(
      inspection.daemon.code ?? inspection.package.code ?? 'daemon_runtime_unavailable',
      inspection.daemon.error ?? inspection.package.error ?? 'Bundled TypeScript daemon runtime is unavailable.',
      false
    )
  }
  return setupDaemonReadyResult(await ensureDaemonReady({ homeDir, daemonUrl, timeoutMs }))
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
  const preferredUrl = await resolveDaemonUrl({ explicitUrl: daemonUrl, homeDir })
  const url = preferredUrl
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
  const verifiedStoppableMismatch = !ready.ok && isReplaceableDaemonCompatibilityMismatch(ready)
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

export async function resolveChromiumBrowser(
  requested?: unknown,
  homeDir = tokenlessHome(),
): Promise<ChromiumBrowser> {
  const requestedId = requested === undefined || requested === null || requested === ''
    ? 'auto'
    : normalizeBrowserId(requested)
  if (requested !== undefined && requested !== null && requested !== '' && !requestedId) {
    throw runtimeError(
      'invalid_browser',
      'Browser must be auto, a supported system browser, managed-chromium, or cloak.',
      false
    )
  }
  const runtime = await new BrowserRuntimeManager({ homeDir }).ensure(requestedId ?? 'auto', {
    allowDownload: false,
  })
  return {
    browser: runtime.browserId,
    command: runtime.executablePath,
    argsPrefix: [],
    displayName: runtime.displayName,
    playwrightExecutablePath: runtime.executablePath,
  }
}

export async function inspectManagedRuntime(homeDir = tokenlessHome(), packageRoot?: string | undefined) {
  void homeDir
  const packageDir = packageRoot ?? cliPackageRoot()
  const daemon = bundledTypeScriptDaemonEntryPath(packageDir)
  const daemonExecutable = await isReadableFile(daemon)
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
  const buildInfo = await readTypeScriptDaemonBuildInfo(daemon)
  const daemonOk = packageCheck.ok && daemonExecutable && buildInfo.ok
  return {
    ok: daemonOk,
    package: packageCheck,
    daemon: {
      ok: daemonOk,
      path: daemon,
      executable: daemonExecutable,
      buildInfo: buildInfo.buildInfo,
      error: buildInfo.error,
      ...(buildInfo.code === undefined ? {} : { code: buildInfo.code }),
    },
  } satisfies ManagedRuntimeInspection
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
  const responseDiagnosticsPath = path.join(dir, 'response-diagnostics.json')
  const metadataPath = path.join(dir, 'metadata.json')
  const textPath = typeof snapshot.visibleText === 'string'
    ? path.join(dir, 'visible-text.txt')
    : null
  const responseDiagnostics = sanitizeSnapshotResponseDiagnostics(snapshot.responseDiagnostics)
  await fs.writeFile(htmlPath, `${typeof snapshot.html === 'string' ? snapshot.html : ''}\n`, { mode: 0o600 })
  await fs.writeFile(probesPath, `${JSON.stringify(snapshot.selectorProbes ?? {}, null, 2)}\n`, { mode: 0o600 })
  await fs.writeFile(responseDiagnosticsPath, `${JSON.stringify(responseDiagnostics, null, 2)}\n`, { mode: 0o600 })
  if (textPath) await fs.writeFile(textPath, `${snapshot.visibleText}\n`, { mode: 0o600 })
  const metadata = {
    protocol: DAEMON_SNAPSHOT_SCHEMA_ID,
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
    responseDiagnosticsPath,
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
    detached: true,
    env: { ...process.env, TOKENLESS_HOME: homeDir },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
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
  ready: Awaited<ReturnType<typeof ensureDaemonReady>>
): SetupDaemonReadyResult {
  const expectedVersion = tokenlessPackageVersion()
  const runningVersion = typeof ready.body?.version === 'string' ? ready.body.version : null
  const expectedMajor = semanticVersionMajor(expectedVersion)
  const runningMajor = runningVersion === null ? null : semanticVersionMajor(runningVersion)
  const versionCompatible = runningVersion === expectedVersion
  const runningControlApiRevision = Number.isSafeInteger(ready.body?.control_api_revision)
    ? ready.body.control_api_revision as number
    : null
  return {
    ...ready,
    expectedVersion,
    expectedMajor,
    runningVersion,
    runningMajor,
    versionCompatible,
    expectedControlApiRevision: DAEMON_CONTROL_API_REVISION,
    runningControlApiRevision,
    controlApiCompatible: runningControlApiRevision === DAEMON_CONTROL_API_REVISION,
  }
}

function daemonReadyResult(
  probe: DaemonReadyProbe & { ok: true },
  started: boolean,
  binaryPath: string | null,
  fallbackPid?: number | null | undefined
) {
  return {
    ...probe,
    started,
    binaryPath,
    pid: daemonPidFromReady(probe) ?? fallbackPid ?? undefined,
  }
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
    buildInfo.binary === 'tokenless-daemon' &&
    buildInfo.version === expectedVersion &&
    buildInfo.controlApiRevision === DAEMON_CONTROL_API_REVISION &&
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

function isReplaceableDaemonCompatibilityMismatch(probe: DaemonReadyProbe) {
  return !probe.ok &&
    (probe.code === 'daemon_version_mismatch' || probe.code === 'daemon_control_api_revision_mismatch') &&
    probe.identityVerified === true &&
    probe.sameHomeVerified === true
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

async function terminateSpawnedDaemonChild(child: ReturnType<typeof spawn> & { pid: number }) {
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
}

function readyHomeFromBody(body: JsonRecord) {
  const value = body.home_dir
  return typeof value === 'string' && value.trim() ? value : null
}

function validateDaemonReadyProof(body: JsonRecord, challenge: string, token: string) {
  if (
    typeof body.home_dir !== 'string' ||
    typeof body.proof !== 'string'
  ) {
    return {
      code: 'daemon_ready_proof_missing',
      message: 'Tokenless daemon /ready did not return a complete challenge-bound identity proof. Reinstall Tokenless.',
    }
  }
  const actualProof = Buffer.from(body.proof)
  const expectedProof = Buffer.from(daemonReadyProof(token, challenge, body.home_dir))
  if (actualProof.length !== expectedProof.length || !timingSafeEqual(actualProof, expectedProof)) {
    return {
      code: 'daemon_ready_proof_mismatch',
      message: 'Daemon identity proof does not match this Tokenless home; refusing to send its control token.',
    }
  }
  return null
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

async function assertDaemonEntryRunnable(daemonEntryPath: string) {
  const buildInfo = await readTypeScriptDaemonBuildInfo(daemonEntryPath)
  if (buildInfo.ok) return
  throw runtimeError(
    buildInfo.code ?? 'typescript_daemon_entry_invalid',
    buildInfo.error ?? `TypeScript daemon entry is invalid: ${daemonEntryPath}`,
    false
  )
}

function cliPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
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

function sanitizeSnapshotResponseDiagnostics(value: unknown): SnapshotResponseDiagnostics {
  const source = objectRecord(value)
  const answerSelectors = sanitizeSnapshotResponseGroup(source.answerSelectors)
  const busySelectors = sanitizeSnapshotResponseGroup(source.busySelectors)
  const diagnostics = {
    truncated: source.truncated === true || answerSelectors.truncated || busySelectors.truncated,
    answerSelectors,
    busySelectors,
  } satisfies SnapshotResponseDiagnostics
  if (JSON.stringify(diagnostics).length <= SNAPSHOT_DIAGNOSTICS_MAX_BYTES) return diagnostics
  const withoutCandidates = (selector: SnapshotResponseSelectorDiagnostics) => ({ ...selector, truncated: true, candidates: [] })
  return {
    truncated: true,
    answerSelectors: { ...answerSelectors, truncated: true, selectors: answerSelectors.selectors.map(withoutCandidates) },
    busySelectors: { ...busySelectors, truncated: true, selectors: busySelectors.selectors.map(withoutCandidates) },
  }
}

function sanitizeSnapshotResponseGroup(value: unknown) {
  const source = objectRecord(value)
  const input = Array.isArray(source.selectors) ? source.selectors : []
  const selectors = input.slice(0, SNAPSHOT_DIAGNOSTICS_MAX_SELECTORS)
    .map((selector, index) => sanitizeSnapshotResponseSelector(selector, index))
  return {
    configured: boundedSnapshotInteger(source.configured),
    truncated: source.truncated === true || input.length > SNAPSHOT_DIAGNOSTICS_MAX_SELECTORS,
    selectors,
  }
}

function sanitizeSnapshotResponseSelector(value: unknown, fallbackIndex: number): SnapshotResponseSelectorDiagnostics {
  const source = objectRecord(value)
  const input = Array.isArray(source.candidates) ? source.candidates : []
  const total = boundedSnapshotInteger(source.total)
  return {
    selectorIndex: boundedSnapshotInteger(source.selectorIndex, fallbackIndex, SNAPSHOT_DIAGNOSTICS_MAX_SELECTORS - 1),
    total,
    visible: Math.min(total, boundedSnapshotInteger(source.visible)),
    truncated: source.truncated === true || input.length > SNAPSHOT_DIAGNOSTICS_MAX_CANDIDATES || input.some((candidate) => {
      const ancestors = objectRecord(candidate).ancestors
      return Array.isArray(ancestors) && ancestors.length > SNAPSHOT_DIAGNOSTICS_MAX_ANCESTORS
    }),
    candidates: input.slice(-SNAPSHOT_DIAGNOSTICS_MAX_CANDIDATES).map(sanitizeSnapshotResponseCandidate),
  }
}

function sanitizeSnapshotResponseCandidate(value: unknown): SnapshotResponseCandidate {
  const source = objectRecord(value)
  const input = Array.isArray(source.ancestors) ? source.ancestors : []
  return {
    ...sanitizeSnapshotDiagnosticElement(source),
    visibleTextLength: boundedSnapshotInteger(source.visibleTextLength),
    ancestors: input.slice(0, SNAPSHOT_DIAGNOSTICS_MAX_ANCESTORS).map(sanitizeSnapshotDiagnosticElement),
  }
}

function sanitizeSnapshotDiagnosticElement(value: unknown): SnapshotDiagnosticElement {
  const source = objectRecord(value)
  const tag = typeof source.tag === 'string' && SNAPSHOT_DIAGNOSTIC_TAGS.has(source.tag as SnapshotDiagnosticElement['tag'])
    ? source.tag as SnapshotDiagnosticElement['tag']
    : 'element'
  const allowed = <T extends string>(candidate: unknown, values: Set<T>) => (
    typeof candidate === 'string' && values.has(candidate as T) ? candidate as T : undefined
  )
  const role = allowed(source.role, SNAPSHOT_DIAGNOSTIC_VALUES.role)
  const ariaBusy = allowed(source.ariaBusy, SNAPSHOT_DIAGNOSTIC_VALUES.boolean)
  const ariaLive = allowed(source.ariaLive, SNAPSHOT_DIAGNOSTIC_VALUES.ariaLive)
  const dataIsStreaming = allowed(source.dataIsStreaming, SNAPSHOT_DIAGNOSTIC_VALUES.boolean)
  const dataState = allowed(source.dataState, SNAPSHOT_DIAGNOSTIC_VALUES.dataState)
  return {
    tag,
    ...(role ? { role } : {}),
    ...(ariaBusy ? { ariaBusy } : {}),
    ...(ariaLive ? { ariaLive } : {}),
    ...(dataIsStreaming ? { dataIsStreaming } : {}),
    ...(dataState ? { dataState } : {}),
  }
}

function boundedSnapshotInteger(value: unknown, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback
}

function safeSegment(value: unknown) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'provider'
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
