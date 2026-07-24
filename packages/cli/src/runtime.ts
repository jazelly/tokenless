import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {
  NATIVE_HOST_NAME,
  nativeMessagingHostDirs,
  normalizeBrowserId,
  snapshotsDir,
  tokenlessHome,
} from './job-store.js'
import { daemonUrl as normalizeDaemonUrl, readDaemonToken, shutdownDaemon } from './daemon-client.js'
import { resolveNativePlatformPackage, tokenlessPackageVersion } from './platform-package.js'

export const EXTENSION_BRIDGE_PROTOCOL = 'tokenless.extension-bridge-state.v1'
export const DAEMON_PROTOCOL = 'tokenless.daemon.v1'
export const NATIVE_PROTOCOL = 'tokenless.native.v1'
export const DAEMON_PROCESS_PROTOCOL = 'tokenless.daemon-process.v1'
export const DAEMON_READY_PROOF_PROTOCOL = 'tokenless.daemon-ready-proof.v1'
export const DAEMON_PROCESS_PROOF_PROTOCOL = 'tokenless.daemon-process-proof.v1'
export const EXTENSION_BRIDGE_FILE = 'extension-bridge.json'
export const DAEMON_PID_FILE = 'daemon.pid.json'
export const DAEMON_LOG_FILE = 'daemon.log'
export const NATIVE_BINARY_BUILD_INFO_PROTOCOL = 'tokenless.native-binary-build-info.v1'

const DAEMON_BINARY_NAME = 'tokenless-daemon'
const NATIVE_HOST_BINARY_NAME = 'tokenless-native-host'
const DEFAULT_BRIDGE_MAX_AGE_MS = 15_000
const BRIDGE_CLOCK_TOLERANCE_MS = 5_000
const DEFAULT_DAEMON_START_TIMEOUT_MS = 10_000
const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 2_147_483_647
const BUILD_INFO_TIMEOUT_MS = 2_000
const BUILD_INFO_OUTPUT_LIMIT_BYTES = 16_384
const SUPPORTED_PROVIDERS = new Set(['chatgpt', 'claude', 'gemini', 'grok'])

type RuntimeError = Error & {
  code?: string
  retryable?: boolean
  status?: number
}

type JsonRecord = Record<string, any>

export type DaemonReadyProbe = {
  ok: boolean
  reachable: boolean
  url: string
  expectedHome: string
  actualHome?: string | undefined
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

export type InstallRustRuntimeOptions = {
  homeDir?: string | undefined
  packageRoot?: string | undefined
  platform?: NodeJS.Platform | undefined
  arch?: string | undefined
}

export function bundledRustBinaryPath(
  name: string = DAEMON_BINARY_NAME,
  packageRoot?: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
) {
  const nativeRoot = packageRoot ?? resolveNativePlatformPackage({ platform, arch }).root
  return path.join(nativeRoot, 'bin', executableName(name, platform))
}

export function installedRustBinaryPath(
  homeDir = tokenlessHome(),
  name: string = DAEMON_BINARY_NAME,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(homeDir, 'bin', executableName(name, platform))
}

export async function resolveDaemonBinary({
  homeDir = tokenlessHome(),
  binaryPath,
  bundledRoot,
}: Pick<EnsureDaemonOptions, 'homeDir' | 'binaryPath' | 'bundledRoot'> = {}) {
  const candidates = [
    binaryPath,
    installedRustBinaryPath(homeDir, DAEMON_BINARY_NAME),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return path.resolve(candidate)
  }
  let bundledError: unknown
  try {
    const bundled = bundledRustBinaryPath(DAEMON_BINARY_NAME, bundledRoot)
    candidates.push(bundled)
    if (await isExecutable(bundled)) return path.resolve(bundled)
  } catch (error) {
    bundledError = error
  }
  throw runtimeError(
    'daemon_binary_missing',
    `Tokenless Rust daemon is not installed. Reinstall tokenless with optional dependencies enabled, then run "tokenless setup" or "tokenless doctor". Checked: ${candidates.join(', ')}${bundledError instanceof Error ? `. ${bundledError.message}` : ''}`,
    false
  )
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

  if (!response.ok || body?.ready !== true) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      body,
      code: 'daemon_not_ready',
      message: `Tokenless daemon /ready returned HTTP ${response.status} without ready=true.`,
    }
  }

  const proofError = validateDaemonReadyProof(body, readyChallenge, proofToken)
  if (proofError) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      body,
      code: proofError.code,
      message: proofError.message,
    }
  }

  const processProofError = validateDaemonProcessProof(body, readyChallenge, proofToken)
  if (processProofError) {
    body.daemon_process_identity_error = processProofError
  }

  if (body.daemon_protocol !== DAEMON_PROTOCOL) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      body,
      code: 'daemon_protocol_mismatch',
      message: `Tokenless daemon protocol is ${String(body.daemon_protocol ?? 'missing')}; expected ${DAEMON_PROTOCOL}. Reinstall Tokenless before running jobs.`,
    }
  }

  if (body.native_protocol !== NATIVE_PROTOCOL) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
      body,
      code: 'native_protocol_mismatch',
      message: `Tokenless native protocol is ${String(body.native_protocol ?? 'missing')}; expected ${NATIVE_PROTOCOL}. Reinstall Tokenless before running jobs.`,
    }
  }

  const readyHome = readyHomeFromBody(body)
  if (!readyHome) {
    return {
      ok: false,
      reachable: true,
      url,
      expectedHome,
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
      body,
      code: 'daemon_home_mismatch',
      message: `Daemon at ${url} uses ${actualHome}, not requested Tokenless home ${expectedHome}.`,
    }
  }

  return { ok: true, reachable: true, url, expectedHome, actualHome, body }
}

export async function ensureDaemonReady({
  homeDir = tokenlessHome(),
  daemonUrl,
  binaryPath,
  bundledRoot,
  timeoutMs = envNumber('TOKENLESS_DAEMON_START_TIMEOUT_MS', DEFAULT_DAEMON_START_TIMEOUT_MS),
}: EnsureDaemonOptions = {}) {
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  const initial = await probeDaemonReady({ daemonUrl, homeDir })
  if (initial.ok) {
    const coherence = await ensureRunningDaemonVersionCoherent(initial)
    if (coherence.ok) return { ...initial, started: false, binaryPath: null, pid: daemonPidFromReady(initial) ?? await readDaemonPid(homeDir) }
    throw incompatibleRunningDaemonError(coherence)
  } else {
    assertNoDaemonIdentityConflict(initial)
  }

  const releaseLock = await acquireDaemonStartLock({ homeDir, timeoutMs })
  let refreshed: string[] = []
  try {
    const afterLock = await probeDaemonReady({ daemonUrl, homeDir })
    if (afterLock.ok) {
      const coherence = await ensureRunningDaemonVersionCoherent(afterLock)
      if (coherence.ok) {
        return { ...afterLock, started: false, binaryPath: null, pid: daemonPidFromReady(afterLock) ?? await readDaemonPid(homeDir) }
      }
      throw incompatibleRunningDaemonError(coherence)
    } else {
      assertNoDaemonIdentityConflict(afterLock)
    }

    if (!binaryPath) {
      refreshed = await refreshInstalledManagedRuntime({ homeDir, packageRoot: bundledRoot })
    }
    const executable = await resolveDaemonBinary({ homeDir, binaryPath, bundledRoot })
    const executableHash = await fileHash(executable)
    if (!executableHash) {
      throw runtimeError('daemon_binary_missing', `Tokenless Rust daemon executable is missing: ${executable}`, false)
    }
    const parsedUrl = new URL(normalizeDaemonUrl(daemonUrl))
    const host = daemonBindHost(parsedUrl.hostname)
    const port = parsedUrl.port ? Number(parsedUrl.port) : 80
    const logPath = path.join(homeDir, DAEMON_LOG_FILE)
    const child = await spawnDaemon({ executable, homeDir, host, port, logPath })
    const pidPayload = {
      protocol: DAEMON_PROCESS_PROTOCOL,
      pid: child.pid,
      homeDir: await canonicalPath(homeDir),
      daemonUrl: parsedUrl.origin,
      binaryPath: executable,
      logPath,
      startedAt: new Date().toISOString(),
    }
    await writeJsonAtomic(path.join(homeDir, DAEMON_PID_FILE), pidPayload, 0o600)

    try {
      const deadline = Date.now() + timeoutMs
      let lastProbe = afterLock
      while (Date.now() < deadline) {
        lastProbe = await probeDaemonReady({ daemonUrl, homeDir })
        if (lastProbe.ok) {
          const coherence = await ensureRunningDaemonVersionCoherent(lastProbe, {
            expectedRunningHash: executableHash,
          })
          if (!coherence.ok) {
            throw runtimeError(
              coherence.code ?? 'daemon_version_mismatch',
              coherence.message ?? 'Tokenless daemon runtime is not coherent.',
              false
            )
          }
          child.unref()
          return {
            ...lastProbe,
            started: true,
            binaryPath: executable,
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
        `Tokenless Rust daemon did not become ready for ${homeDir}. See ${logPath}. Last check: ${lastProbe.message ?? lastProbe.code ?? 'unknown error'}${refreshed?.length ? ' Refreshed managed runtime before start.' : ''}`,
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
  if (!ready.ok) {
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
      `${ready.message ?? 'Tokenless daemon identity could not be verified.'} Tokenless did not send its control token or stop any process. Stop the service bound to ${url} manually if needed.`,
      false
    )
  }
  let response: JsonRecord
  try {
    response = await shutdownDaemon({
      homeDir,
      daemonUrl: url,
      requestTimeoutMs: stopTimeoutMs,
      token,
    }) as JsonRecord
  } catch (error) {
    const status = typeof (error as RuntimeError).status === 'number' ? (error as RuntimeError).status : undefined
    if (status === 404 || status === 405) {
      throw runtimeError(
        'daemon_shutdown_unsupported',
        `The verified daemon at ${url} does not support authenticated self-shutdown. Tokenless did not stop any process. Upgrade Tokenless or stop daemon pid ${daemonPidFromReady(ready) ?? '<unknown>'} manually.`,
        false
      )
    }
    throw error
  }
  const pid = typeof response.pid === 'number' && Number.isSafeInteger(response.pid) && response.pid > 0
    ? response.pid
    : daemonPidFromReady(ready) ?? undefined
  const stopped = await waitForDaemonListenerGone(url, stopTimeoutMs)
  if (!stopped) {
    throw runtimeError(
      'daemon_shutdown_unconfirmed',
      `The verified daemon at ${url} accepted authenticated shutdown, but the loopback listener was still reachable after ${stopTimeoutMs}ms. Tokenless did not kill any process. Stop daemon pid ${pid ?? '<unknown>'} manually if needed.`,
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
  if (!SUPPORTED_PROVIDERS.has(providerId)) {
    throw runtimeError('unsupported_provider', 'Provider must be one of: chatgpt, claude, gemini, grok.', false)
  }
  const homeUrls: Record<string, string> = {
    chatgpt: 'https://chatgpt.com/',
    claude: 'https://claude.ai/new',
    gemini: 'https://gemini.google.com/app',
    grok: 'https://grok.com/',
  }
  if (targetUrl === undefined || targetUrl === '') {
    return homeUrls[providerId] as string
  }

  const parsed = parseProviderWakeTarget(targetUrl)
  if (!parsed) {
    throw runtimeError('invalid_provider_url', 'Provider target URL must be a valid HTTPS URL.', false)
  }
  const allowedHosts: Record<string, Set<string>> = {
    chatgpt: new Set(['chatgpt.com', 'chat.openai.com']),
    claude: new Set(['claude.ai']),
    gemini: new Set(['gemini.google.com']),
    grok: new Set(['grok.com']),
  }
  if (
    !allowedHosts[providerId]?.has(parsed.hostname.toLowerCase())
  ) {
    throw runtimeError(
      'invalid_provider_url',
      `Target URL must use HTTPS and belong to the selected ${providerId} provider.`,
      false
    )
  }
  return parsed.href
}

const FORBIDDEN_PROVIDER_URL_INPUT = /[\\\u0000-\u001f\u007f\s]|%(?:00|0[1-9a-f]|1[0-9a-f]|20|23|25|2f|3f|5c|7f)/i
const MALFORMED_PROVIDER_URL_ESCAPE = /%(?![0-9a-f]{2})/i

function parseProviderWakeTarget(value: unknown) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.trim() !== value ||
    value.includes('?') ||
    value.includes('#') ||
    FORBIDDEN_PROVIDER_URL_INPUT.test(value) ||
    MALFORMED_PROVIDER_URL_ESCAPE.test(value)
  ) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null
  }
  const rawAuthority = providerUrlAuthority(value)
  if (!rawAuthority || rawAuthority.toLowerCase() !== parsed.hostname.toLowerCase()) return null
  return parsed
}

function providerUrlAuthority(value: string) {
  const scheme = value.indexOf('://')
  if (scheme < 0 || value.slice(0, scheme).toLowerCase() !== 'https') return ''
  const start = scheme + 3
  const relativeEnd = value.slice(start).search(/[/?#]/)
  return relativeEnd < 0 ? value.slice(start) : value.slice(start, start + relativeEnd)
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
  const allowedHosts = new Set(['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'grok.com'])
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !allowedHosts.has(parsed.hostname.toLowerCase())
  ) {
    throw runtimeError(
      'invalid_provider_url',
      'Tokenless only opens allowlisted ChatGPT, Claude, Gemini, or Grok HTTPS pages.',
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

export async function installRustRuntime({
  homeDir = tokenlessHome(),
  packageRoot,
  platform = process.platform,
  arch = process.arch,
}: InstallRustRuntimeOptions = {}) {
  const binDir = path.join(homeDir, 'bin')
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 })
  const daemonSource = bundledRustBinaryPath(DAEMON_BINARY_NAME, packageRoot, platform, arch)
  const daemonExecutable = installedRustBinaryPath(homeDir, DAEMON_BINARY_NAME, platform)
  await installExecutable(daemonSource, daemonExecutable)
  return {
    runtime: 'rust',
    daemonExecutable,
  }
}

/** @deprecated Native Messaging host install is archived under legacy/. */
export async function installNativeHost() {
  throw runtimeError(
    'legacy_native_host_removed',
    'The Tokenless Native Messaging host is no longer installed. Use managed Playwright setup via "tokenless setup".',
    false
  )
}

export function windowsNativeHostRegistryCommands({
  manifestPath,
  browsers,
}: {
  manifestPath: string
  browsers: string[]
}) {
  const roots: Record<string, string> = {
    chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    'chrome-for-testing': 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
    edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    arc: 'HKCU\\Software\\The Browser Company\\Arc\\NativeMessagingHosts',
  }
  const seen = new Set<string>()
  const commands: string[][] = []
  for (const browser of browsers) {
    const browserId = normalizeBrowserId(browser)
    const root = browserId ? roots[browserId] : undefined
    if (!root) continue
    const key = `${root}\\${NATIVE_HOST_NAME}`
    if (seen.has(key)) continue
    seen.add(key)
    commands.push(['reg.exe', 'ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'])
  }
  return commands
}

export async function inspectNativeHostManifests({
  homeDir = tokenlessHome(),
  manifestHome,
  browsers = ['chrome'],
  platform = process.platform,
}: {
  homeDir?: string | undefined
  manifestHome?: string | undefined
  browsers?: string[] | undefined
  platform?: NodeJS.Platform | undefined
} = {}) {
  const candidates = platform === 'win32'
    ? [path.join(homeDir, 'native-messaging', `${NATIVE_HOST_NAME}.json`)]
    : browsers.flatMap((browser) => {
        const browserId = normalizeBrowserId(browser)
        return browserId
          ? nativeMessagingHostDirs(browserId, manifestHome, platform).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
          : []
      })
  const uniqueCandidates = [...new Set(candidates)]
  const manifests = []
  for (const manifestPath of uniqueCandidates) {
    try {
      const payload = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as JsonRecord
      const expectedHost = installedRustBinaryPath(homeDir, NATIVE_HOST_BINARY_NAME, platform)
      const valid = payload.name === NATIVE_HOST_NAME &&
        payload.type === 'stdio' &&
        path.resolve(payload.path ?? '') === path.resolve(expectedHost) &&
        Array.isArray(payload.allowed_origins) &&
        payload.allowed_origins.length === 1 &&
        /^chrome-extension:\/\/[a-p]{32}\/$/.test(payload.allowed_origins[0])
      manifests.push({ path: manifestPath, ok: valid, manifest: payload })
    } catch {
      // Missing manifests are summarized through candidate and valid counts below.
    }
  }
  return {
    ok: manifests.some((entry) => entry.ok),
    candidates: uniqueCandidates,
    manifests,
  }
}

export async function inspectRustBinaries(homeDir = tokenlessHome()) {
  return inspectManagedRuntime(homeDir)
}

export async function inspectManagedRuntime(homeDir = tokenlessHome(), packageRoot?: string | undefined) {
  const daemon = installedRustBinaryPath(homeDir, DAEMON_BINARY_NAME)
  const daemonExecutable = await isExecutable(daemon)
  let bundledDaemon: string | null = null
  let packageCheck: ManagedRuntimeInspection['package']
  try {
    const nativePackage = packageRoot === undefined
      ? resolveNativePlatformPackage()
      : {
          ok: true,
          name: null,
          version: tokenlessPackageVersion(),
          platform: process.platform,
          arch: process.arch,
          root: packageRoot,
          manifestPath: null,
        }
    bundledDaemon = path.join(nativePackage.root, 'bin', executableName(DAEMON_BINARY_NAME))
    packageCheck = {
      ok: true,
      ...(nativePackage.name === null ? {} : { name: nativePackage.name }),
      version: nativePackage.version,
      platform: nativePackage.platform,
      arch: nativePackage.arch,
      root: nativePackage.root,
      ...(nativePackage.manifestPath === null ? {} : { manifestPath: nativePackage.manifestPath }),
      error: null,
    }
  } catch (error) {
    const runtimeError = error as RuntimeError
    packageCheck = {
      ok: false,
      error: runtimeError.message ?? String(error),
      code: runtimeError.code,
    }
  }
  const [daemonHash, bundledDaemonHash, packagedBuildInfo] = await Promise.all([
    fileHash(daemon),
    bundledDaemon ? fileHash(bundledDaemon) : null,
    bundledDaemon ? readNativeBinaryBuildInfo(bundledDaemon, DAEMON_BINARY_NAME) : failedBuildInfo('native_platform_package_missing', 'Native platform package is unavailable.'),
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
        daemonHash === null ? 'rust_binary_missing' : 'rust_binary_hash_mismatch',
        daemonHash === null
          ? `Native runtime executable is missing: ${daemon}`
          : 'Installed daemon binary hash does not match the verified packaged daemon; refusing to execute it.',
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

export async function refreshInstalledRustBinaries({
  homeDir = tokenlessHome(),
  packageRoot,
}: {
  homeDir?: string | undefined
  packageRoot?: string | undefined
} = {}) {
  return refreshInstalledManagedRuntime({ homeDir, packageRoot })
}

export async function refreshInstalledManagedRuntime({
  homeDir = tokenlessHome(),
  packageRoot,
}: {
  homeDir?: string | undefined
  packageRoot?: string | undefined
} = {}) {
  const source = bundledRustBinaryPath(DAEMON_BINARY_NAME, packageRoot)
  const destination = installedRustBinaryPath(homeDir, DAEMON_BINARY_NAME)
  const [sourceHash, destinationHash, destinationExecutable, sourceBuildInfo] = await Promise.all([
    fileHash(source),
    fileHash(destination),
    isExecutable(destination),
    readNativeBinaryBuildInfo(source, DAEMON_BINARY_NAME),
  ])
  if (!sourceHash) {
    throw runtimeError('rust_binary_missing', `Native runtime package is missing executable: ${source}`, false)
  }
  if (!sourceBuildInfo.ok) {
    throw runtimeError(
      sourceBuildInfo.code ?? 'rust_binary_invalid',
      sourceBuildInfo.error ?? `Native runtime package has invalid build info: ${source}`,
      false
    )
  }
  if (sourceHash === destinationHash && destinationExecutable) return []
  await installExecutable(source, destination)
  return [destination]
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
    protocol: 'tokenless.daemon-snapshot.v1',
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
  executable,
  homeDir,
  host,
  port,
  logPath,
}: {
  executable: string
  homeDir: string
  host: string
  port: number
  logPath: string
}) {
  const logFd = fsSync.openSync(logPath, 'a', 0o600)
  const child = spawn(executable, [
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
      `Could not start Tokenless Rust daemon: ${error instanceof Error ? error.message : String(error)}`,
      true
    )
  } finally {
    fsSync.closeSync(logFd)
  }
  if (!child.pid) {
    throw runtimeError('daemon_start_failed', 'Tokenless Rust daemon started without a process id.', true)
  }
  return child as typeof child & { pid: number }
}

async function ensureRunningDaemonVersionCoherent(
  probe: DaemonReadyProbe,
  { expectedRunningHash }: { expectedRunningHash?: string | undefined } = {}
) {
  const expectedVersion = tokenlessPackageVersion()
  const runningVersion = typeof probe.body?.version === 'string' ? probe.body.version : null
  const runningHash = typeof probe.body?.running_binary_hash === 'string' ? probe.body.running_binary_hash : null
  const expectedMajor = semanticVersionMajor(expectedVersion)
  const runningMajor = runningVersion === null ? null : semanticVersionMajor(runningVersion)
  if (expectedMajor === null || runningMajor === null || runningMajor !== expectedMajor) {
    return {
      ok: false,
      code: 'daemon_version_mismatch',
      message: `Tokenless daemon at ${probe.url} reports version ${runningVersion ?? 'missing'}; expected semantic-version major ${expectedMajor ?? 'from tokenless@' + expectedVersion}.`,
    }
  }
  const processProofError = probe.body?.daemon_process_identity_error
  if (processProofError !== undefined) {
    return {
      ok: false,
      code: processProofError.code ?? 'daemon_process_identity_unverified',
      message: processProofError.message ?? 'Tokenless daemon process identity could not be verified.',
    }
  }
  if (expectedRunningHash !== undefined && runningHash !== expectedRunningHash) {
    return {
      ok: false,
      code: 'daemon_binary_hash_mismatch',
      message: `Newly spawned Tokenless daemon at ${probe.url} reports binary hash ${runningHash ?? 'missing'}; expected started executable hash ${expectedRunningHash}.`,
    }
  }
  return { ok: true }
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

function incompatibleRunningDaemonError(coherence: { code?: string; message?: string }) {
  return runtimeError(
    coherence.code ?? 'daemon_version_mismatch',
    `${coherence.message ?? 'The running Tokenless daemon is incompatible.'} Tokenless left the daemon running. Run "tokenless daemon stop --json", then retry.`,
    false
  )
}

function daemonPidFromReady(probe: DaemonReadyProbe) {
  const pid = probe.body?.pid
  return Number.isSafeInteger(pid) && pid > 0 ? pid as number : null
}

async function readNativeBinaryBuildInfo(binaryPath: string, expectedBinary: string) {
  if (!(await isExecutable(binaryPath))) {
    return failedBuildInfo('rust_binary_missing', `Native runtime executable is missing: ${binaryPath}`)
  }
  let result: Awaited<ReturnType<typeof execFileJson>>
  try {
    result = await execFileJson(binaryPath, ['--tokenless-build-info'])
  } catch (error) {
    return failedBuildInfo(
      'rust_binary_build_info_failed',
      error instanceof Error ? error.message : String(error)
    )
  }
  const buildInfo = result.value
  const expectedVersion = tokenlessPackageVersion()
  const valid = isRecord(buildInfo) &&
    buildInfo.protocol === NATIVE_BINARY_BUILD_INFO_PROTOCOL &&
    buildInfo.binary === expectedBinary &&
    buildInfo.version === expectedVersion &&
    buildInfo.platform === process.platform &&
    buildInfo.arch === process.arch
  if (!valid) {
    return failedBuildInfo(
      'rust_binary_build_info_mismatch',
      `Native runtime build info for ${binaryPath} does not match tokenless@${expectedVersion} on ${process.platform}-${process.arch}.`,
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
    body.ready_proof_protocol !== DAEMON_READY_PROOF_PROTOCOL ||
    body.ready_challenge !== challenge ||
    typeof body.daemon_protocol !== 'string' ||
    typeof body.native_protocol !== 'string' ||
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
      DAEMON_READY_PROOF_PROTOCOL,
      challenge,
      body.daemon_protocol,
      body.native_protocol,
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

function validateDaemonProcessProof(body: JsonRecord, challenge: string, token: string) {
  if (
    body.daemon_process_proof_protocol === undefined &&
    body.daemon_process_proof === undefined &&
    body.pid === undefined &&
    body.instance_id === undefined
  ) {
    return {
      code: 'daemon_process_proof_missing',
      message: 'Tokenless daemon /ready did not return a process identity proof.',
    }
  }
  if (
    body.daemon_process_proof_protocol !== DAEMON_PROCESS_PROOF_PROTOCOL ||
    body.ready_challenge !== challenge ||
    typeof body.daemon_protocol !== 'string' ||
    typeof body.native_protocol !== 'string' ||
    typeof body.home_dir !== 'string' ||
    typeof body.daemon_process_proof !== 'string' ||
    !Number.isSafeInteger(body.pid) ||
    body.pid <= 0 ||
    typeof body.instance_id !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(body.instance_id) ||
    typeof body.running_binary_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(body.running_binary_hash)
  ) {
    return {
      code: 'daemon_process_proof_invalid',
      message: 'Tokenless daemon /ready returned an incomplete process identity proof.',
    }
  }
  let actualProof: Buffer
  try {
    actualProof = Buffer.from(body.daemon_process_proof, 'base64url')
  } catch {
    actualProof = Buffer.alloc(0)
  }
  if (actualProof.length !== 32 || actualProof.toString('base64url') !== body.daemon_process_proof) {
    return {
      code: 'daemon_process_proof_invalid',
      message: 'Tokenless daemon /ready returned an invalid process identity proof.',
    }
  }
  const expectedProof = createHmac('sha256', token)
    .update(daemonReadyProofMessage([
      DAEMON_PROCESS_PROOF_PROTOCOL,
      challenge,
      body.daemon_protocol,
      body.native_protocol,
      body.home_dir,
      String(body.pid),
      body.instance_id,
      body.running_binary_hash,
    ]))
    .digest()
  if (!timingSafeEqual(actualProof, expectedProof)) {
    return {
      code: 'daemon_process_proof_mismatch',
      message: 'Daemon process identity proof does not match this Tokenless home.',
    }
  }
  return null
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

async function installExecutable(source: string, destination: string) {
  if (!(await isExecutable(source))) {
    throw runtimeError('rust_binary_missing', `Packaged Rust binary is missing: ${source}`, false)
  }
  if (path.resolve(source) === path.resolve(destination)) return
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await fs.copyFile(source, temporary)
  if (process.platform !== 'win32') await fs.chmod(temporary, 0o755)
  await fs.rename(temporary, destination)
}

async function isExecutable(file: string) {
  try {
    await fs.access(file, process.platform === 'win32' ? fsSync.constants.F_OK : fsSync.constants.X_OK)
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

function executableName(name: string, platform: NodeJS.Platform = process.platform) {
  return `${name}${platform === 'win32' ? '.exe' : ''}`
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

async function execFile(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0) {
    throw runtimeError('native_host_registry_failed', `${command} failed: ${stderr.trim()}`, false)
  }
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
        'native_binary_build_info_too_large',
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
        'native_binary_build_info_timeout',
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
    throw runtimeError('native_binary_build_info_failed', `${command} failed: ${stderr.trim()}`, false)
  }
  try {
    return { value: JSON.parse(stdout) as unknown }
  } catch (error) {
    throw runtimeError(
      'native_binary_build_info_invalid',
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
