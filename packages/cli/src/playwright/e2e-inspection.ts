import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { tokenlessError } from './errors.js'

export const E2E_BROWSER_INSPECTION_PROTOCOL = 'tokenless.e2e-browser-inspection.v1' as const

export type E2EBrowserInspectionConfig = {
  protocol: typeof E2E_BROWSER_INSPECTION_PROTOCOL
  runId: string
  nonce: string
  rootDir: string
  timeoutMs: number
}

type ObserverRelease = {
  protocol: typeof E2E_BROWSER_INSPECTION_PROTOCOL
  runId: string
  jobId: string
  nonce: string
}

const SAFE_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_NONCE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/
const DEFAULT_OBSERVER_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 50

export function resolveE2EBrowserInspectionConfig(
  homeDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): E2EBrowserInspectionConfig | null {
  const enabled = env.TOKENLESS_E2E_BROWSER_INSPECTION
  if (enabled === undefined || enabled === '') return null
  if (enabled !== '1') {
    throw tokenlessError(
      'invalid_e2e_browser_inspection',
      'TOKENLESS_E2E_BROWSER_INSPECTION must be exactly 1 when enabled.',
      { retryable: false },
    )
  }
  if (!homeDir) {
    throw tokenlessError(
      'invalid_e2e_browser_inspection',
      'E2E browser inspection requires an explicit Tokenless home.',
      { retryable: false },
    )
  }
  const runId = requiredSafeComponent(env.TOKENLESS_E2E_RUN_ID, 'TOKENLESS_E2E_RUN_ID')
  const nonce = String(env.TOKENLESS_E2E_NONCE ?? '')
  if (!SAFE_NONCE_PATTERN.test(nonce)) {
    throw tokenlessError(
      'invalid_e2e_browser_inspection',
      'TOKENLESS_E2E_NONCE must be a 32 to 256 character base64url value.',
      { retryable: false },
    )
  }
  const timeoutMs = optionalPositiveInteger(
    env.TOKENLESS_E2E_OBSERVER_TIMEOUT_MS,
    DEFAULT_OBSERVER_TIMEOUT_MS,
    'TOKENLESS_E2E_OBSERVER_TIMEOUT_MS',
  )
  const resolvedHome = path.resolve(homeDir)
  return Object.freeze({
    protocol: E2E_BROWSER_INSPECTION_PROTOCOL,
    runId,
    nonce,
    rootDir: path.join(resolvedHome, 'e2e', 'browser-inspection', runId),
    timeoutMs,
  })
}

export function e2eInspectionJobDirectory(config: E2EBrowserInspectionConfig, jobId: string) {
  return path.join(config.rootDir, requiredSafeComponent(jobId, 'job id'))
}

export function e2eInspectionJobPrefix(config: Pick<E2EBrowserInspectionConfig, 'runId'>) {
  const runKey = createHash('sha256').update(config.runId).digest('base64url').slice(0, 16)
  return `tlp_e2e_${runKey}_`
}

export function createE2EInspectionJobId(env: NodeJS.ProcessEnv = process.env) {
  if (env.TOKENLESS_E2E_BROWSER_INSPECTION !== '1') return null
  const runId = requiredSafeComponent(env.TOKENLESS_E2E_RUN_ID, 'TOKENLESS_E2E_RUN_ID')
  return `${e2eInspectionJobPrefix({ runId })}${randomUUID()}`
}

export async function waitForE2EBrowserObserver(options: {
  config: E2EBrowserInspectionConfig
  jobId: string
  profileId: string
  profileDirectory: string
  provider: string
  url: string
  signal?: AbortSignal | undefined
}): Promise<void> {
  const { config } = options
  const jobId = requiredSafeComponent(options.jobId, 'job id')
  const jobDir = e2eInspectionJobDirectory(config, jobId)
  const waitingPath = path.join(jobDir, 'waiting.json')
  const releasePath = path.join(jobDir, 'release.json')
  await fs.mkdir(jobDir, { recursive: true, mode: 0o700 })
  await writeJsonAtomically(waitingPath, {
    protocol: config.protocol,
    runId: config.runId,
    jobId,
    nonce: config.nonce,
    profileId: options.profileId,
    profileDirectory: options.profileDirectory,
    provider: options.provider,
    url: options.url,
    waitingAt: new Date().toISOString(),
  })
  const deadline = Date.now() + config.timeoutMs
  try {
    while (Date.now() <= deadline) {
      throwIfAborted(options.signal)
      const release = await readRelease(releasePath)
      if (release && validRelease(release, config, jobId)) return
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), options.signal)
    }
    throw tokenlessError(
      'e2e_browser_observer_timeout',
      `Timed out after ${config.timeoutMs}ms waiting for the E2E browser observer.`,
      { retryable: false },
    )
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function readRelease(releasePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(releasePath, 'utf8'))
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return null
    throw error
  }
}

function validRelease(
  value: unknown,
  config: E2EBrowserInspectionConfig,
  jobId: string,
): value is ObserverRelease {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value).sort()
  const expected = ['jobId', 'nonce', 'protocol', 'runId']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false
  return (
    value.protocol === config.protocol &&
    value.runId === config.runId &&
    value.jobId === jobId &&
    value.nonce === config.nonce
  )
}

async function writeJsonAtomically(target: string, value: unknown) {
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  await fs.rename(temporary, target)
}

function requiredSafeComponent(value: unknown, label: string) {
  const normalized = String(value ?? '')
  if (!SAFE_COMPONENT_PATTERN.test(normalized)) {
    throw tokenlessError(
      'invalid_e2e_browser_inspection',
      `${label} is invalid for E2E browser inspection.`,
      { retryable: false },
    )
  }
  return normalized
}

function optionalPositiveInteger(value: unknown, fallback: number, label: string) {
  if (value === undefined || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 300_000) {
    throw tokenlessError(
      'invalid_e2e_browser_inspection',
      `${label} must be a positive integer no greater than 300000.`,
      { retryable: false },
    )
  }
  return numeric
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw tokenlessError('playwright_job_canceled', 'Managed Playwright job was canceled.', { retryable: false })
  }
}

function delay(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(tokenlessError('playwright_job_canceled', 'Managed Playwright job was canceled.', { retryable: false }))
      return
    }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(tokenlessError('playwright_job_canceled', 'Managed Playwright job was canceled.', { retryable: false }))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal) {
      void Promise.resolve().then(() => {
        if (!signal.aborted) return
        abort()
      })
    }
  })
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
