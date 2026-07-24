import fs from 'node:fs/promises'
import path from 'node:path'

import { tokenlessHome } from './job-store.js'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7331'
export const MAX_NATIVE_MESSAGE_BYTES = 900 * 1024
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_CANCEL_REQUEST_TIMEOUT_MS = 3_000

export type DaemonClientOptions = {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  requestTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export type DaemonJob = {
  job_id: string
  execution_backend?: 'legacy_extension' | 'playwright'
  profile_id?: string | null
  provider: string
  action: string
  status: string
  request_json: unknown
  result_json: unknown | null
  error_json: unknown | null
  blocker_json: unknown | null
  created_at: string
  updated_at: string
}

export type DaemonClaimedJob = DaemonJob & {
  claim_token: string
}

export type CreateDaemonJobOptions = DaemonClientOptions & {
  provider: string
  action: string
  requestJson?: unknown
  executionBackend?: 'legacy_extension' | 'playwright' | undefined
  profileId?: string | undefined
  jobId?: string | undefined
  claimToken?: string | undefined
}

export type ClaimNextDaemonJobOptions = DaemonClientOptions & {
  provider?: string | undefined
  action?: string | undefined
  executionBackend?: 'legacy_extension' | 'playwright' | undefined
  profileId?: string | undefined
}

export type GetDaemonJobOptions = DaemonClientOptions & {
  jobId: string
}

export type ListDaemonJobsOptions = DaemonClientOptions & {
  status?: string | undefined
  executionBackend?: 'legacy_extension' | 'playwright' | undefined
  profileId?: string | undefined
  provider?: string | undefined
  taskId?: string | undefined
  limit?: number | undefined
}

export type CancelDaemonJobOptions = GetDaemonJobOptions & {
  reason?: unknown
}

export type ResumeDaemonJobOptions = GetDaemonJobOptions & {
  browserVisibility: 'headed'
}

export type CompleteDaemonJobOptions = DaemonClientOptions & {
  jobId: string
  claimToken: string
  result?: unknown
  error?: unknown
}

export type WaitDaemonJobResultOptions = GetDaemonJobOptions & {
  timeoutMs?: number | undefined
  pollMs?: number | undefined
  heartbeatMs?: number | undefined
  onStatus?: ((event: Record<string, unknown>) => unknown) | undefined
}

export type ShutdownDaemonOptions = DaemonClientOptions & {
  token?: string | undefined
}

export type ShutdownDaemonResponse = {
  ok: boolean
  status: 'shutting_down'
  pid?: number | undefined
}

type DaemonError = Error & {
  code?: string
  retryable?: boolean
  status?: number
}

export function daemonUrl(explicitUrl?: string) {
  const value = explicitUrl || process.env.TOKENLESS_DAEMON_URL || DEFAULT_DAEMON_URL
  const normalized = value.replace(/\/+$/, '')
  validateDaemonUrl(normalized)
  return normalized
}

export async function readDaemonToken({ homeDir = tokenlessHome() }: DaemonClientOptions = {}) {
  const tokenPath = path.join(homeDir, 'daemon.token')
  let token: string
  try {
    token = (await fs.readFile(tokenPath, 'utf8')).trim()
  } catch {
    throw daemonClientError(
      'daemon_token_unavailable',
      `Cannot read the Tokenless daemon control token at ${tokenPath}.`,
      true
    )
  }
  if (!token) {
    throw daemonClientError('daemon_token_unavailable', `Tokenless daemon control token is empty at ${tokenPath}.`, true)
  }
  return token
}

export async function createDaemonJob({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  provider,
  action,
  requestJson = {},
  executionBackend,
  profileId,
  jobId,
  claimToken,
}: CreateDaemonJobOptions) {
  assertNativeMessageSize({ provider, action, request_json: requestJson })
  const token = await authenticatedDaemonToken({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonClaimedJob>({
    daemonUrl: explicitDaemonUrl,
    path: '/jobs',
    body: {
      provider,
      action,
      request_json: requestJson,
      execution_backend: executionBackend,
      profile_id: profileId,
      job_id: jobId,
      claim_token: claimToken,
    },
    token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function listDaemonJobs({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  status,
  executionBackend,
  profileId,
  provider,
  taskId,
  limit = 100,
}: ListDaemonJobsOptions = {}) {
  const token = await authenticatedDaemonToken({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  const query = new URLSearchParams()
  if (status) query.set('status', status)
  if (executionBackend) query.set('execution_backend', executionBackend)
  if (profileId) query.set('profile_id', profileId)
  if (provider) query.set('provider', provider)
  if (taskId) query.set('task_id', taskId)
  query.set('limit', String(Math.max(1, Math.min(1000, Number(limit) || 100))))
  return daemonRequest<DaemonJob[]>({
    daemonUrl: explicitDaemonUrl,
    method: 'GET',
    path: `/jobs?${query.toString()}`,
    token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function getDaemonJob({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  jobId,
}: GetDaemonJobOptions) {
  const token = await authenticatedDaemonToken({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: explicitDaemonUrl,
    method: 'GET',
    path: `/jobs/${encodeURIComponent(jobId)}`,
    token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function claimNextDaemonJob({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  provider,
  action,
  executionBackend,
  profileId,
}: ClaimNextDaemonJobOptions = {}) {
  const token = await authenticatedDaemonToken({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  const query = new URLSearchParams()
  if (executionBackend) query.set('execution_backend', executionBackend)
  if (profileId) query.set('profile_id', profileId)
  if (provider) query.set('provider', provider)
  if (action) query.set('action', action)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''

  return daemonRequest<{ job: DaemonClaimedJob | null }>({
    daemonUrl: explicitDaemonUrl,
    path: `/control/jobs/claim-next${suffix}`,
    token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function completeDaemonJob({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  jobId,
  claimToken,
  result,
  error,
}: CompleteDaemonJobOptions) {
  const hasResult = result !== undefined
  const hasError = error !== undefined
  if (hasResult === hasError) {
    throw daemonClientError(
      'invalid_daemon_completion',
      'Pass exactly one of result or error when completing a daemon job.',
      false
    )
  }

  const token = await authenticatedDaemonToken({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: explicitDaemonUrl,
    path: `/jobs/${encodeURIComponent(jobId)}/complete`,
    body: {
      claim_token: claimToken,
      result_json: hasResult ? result : undefined,
      error_json: hasError ? error : undefined,
    },
    token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function cancelDaemonJob({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs = DEFAULT_CANCEL_REQUEST_TIMEOUT_MS,
  signal,
  jobId,
  reason,
}: CancelDaemonJobOptions) {
  const token = await authenticatedDaemonToken({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: explicitDaemonUrl,
    path: `/control/jobs/${encodeURIComponent(jobId)}/cancel`,
    ...(reason === undefined ? {} : { body: { reason } }),
    token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function shutdownDaemon({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  token,
}: ShutdownDaemonOptions = {}) {
  const controlToken = token ?? await authenticatedDaemonToken({
    daemonUrl: explicitDaemonUrl,
    homeDir,
    requestTimeoutMs,
  })
  return daemonRequest<ShutdownDaemonResponse>({
    daemonUrl: explicitDaemonUrl,
    path: '/control/shutdown',
    token: controlToken,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function resumeDaemonJob({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  jobId,
  browserVisibility,
}: ResumeDaemonJobOptions) {
  if (browserVisibility !== 'headed') {
    throw daemonClientError(
      'invalid_resume_browser_visibility',
      'A parked Tokenless browser job can be resumed only with headed visibility.',
      false
    )
  }
  const token = await authenticatedDaemonToken({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: explicitDaemonUrl,
    path: `/jobs/${encodeURIComponent(jobId)}/resume`,
    body: { browser_visibility: browserVisibility },
    token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function waitDaemonJobResult({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  jobId,
  timeoutMs = 180000,
  pollMs = 250,
  heartbeatMs = 30000,
  onStatus,
}: WaitDaemonJobResultOptions) {
  const startedAt = Date.now()
  let lastStatus: string | undefined
  let lastHeartbeatAt = startedAt
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getDaemonJob({ daemonUrl: explicitDaemonUrl, homeDir, jobId, requestTimeoutMs, signal })
    const elapsedMs = Date.now() - startedAt
    if (job.status !== lastStatus) {
      lastStatus = job.status
      lastHeartbeatAt = Date.now()
      await onStatus?.({
        event: 'daemon_status',
        status: job.status,
        jobId,
        provider: job.provider,
        action: job.action,
        elapsedMs,
      })
    } else if (heartbeatMs > 0 && Date.now() - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = Date.now()
      await onStatus?.({
        event: 'daemon_waiting',
        status: job.status,
        jobId,
        provider: job.provider,
        action: job.action,
        elapsedMs,
      })
    }
    if (job.status === 'succeeded') {
      return {
        ok: true,
        status: job.status,
        job,
        result: job.result_json,
        compactOutput: compactDaemonOutput(job.result_json),
      }
    }
    if (job.status === 'failed' || job.status === 'canceled' || job.status === 'timed_out') {
      return {
        ok: false,
        status: job.status,
        job,
        error: job.error_json ?? {
          code: job.status === 'canceled' ? 'job_canceled' : 'daemon_job_timed_out',
          message: `Daemon job ended with status ${job.status}.`,
          retryable: job.status === 'timed_out',
        },
      }
    }
    if (job.status === 'waiting_for_user') {
      return {
        ok: null,
        status: job.status,
        job,
        blocker: job.blocker_json,
        userAction: userHandoverAction(job),
      }
    }
    await delay(pollMs, signal)
  }
  try {
    const canceled = await cancelDaemonJob({
      daemonUrl: explicitDaemonUrl,
      homeDir,
      jobId,
      reason: { code: 'client_timeout' },
      requestTimeoutMs,
      signal,
    })
    if (canceled.status !== 'canceled') {
      throw new Error(`daemon returned status ${canceled.status}`)
    }
  } catch (cancelError) {
    throw daemonClientError(
      'daemon_job_timeout_cancel_failed',
      `Timed out waiting for daemon job ${jobId}, and cancellation was not confirmed; the job may still be running. ${errorText(cancelError)}`,
      true
    )
  }
  throw daemonClientError(
    'daemon_job_timeout',
    `Timed out waiting for daemon job ${jobId}; cancellation was confirmed.`,
    true
  )
}

function userHandoverAction(job: DaemonJob) {
  const blocker = jsonRecord(job.blocker_json)
  const browser = jsonRecord(blocker.browser)
  const windowOpen = browser.windowOpen !== false
  return {
    message: windowOpen
      ? 'The visible managed browser is open. Manually complete the provider verification or sign-in there, then query the same Tokenless task again.'
      : 'This headless job requires user interaction and no browser window is open. Resume the same job with headed visibility.',
    resumeCommand: windowOpen ? jobIdStateCommand(job) : jobIdHeadedResumeCommand(job),
    queryGuidance: windowOpen
      ? 'Run tokenless state --job-id <jobId> --json after the user confirms completion.'
      : 'Do not submit a replacement job; resume this exact job with headed visibility.',
  }
}

function jobIdStateCommand(job: DaemonJob) {
  return `tokenless state --job-id ${shellQuote(job.job_id)} --json`
}

function jobIdHeadedResumeCommand(job: DaemonJob) {
  return `tokenless resume --job-id ${shellQuote(job.job_id)} --browser-visibility headed --json`
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function daemonRequest<T>({
  daemonUrl: explicitDaemonUrl,
  method = 'POST',
  path: requestPath,
  body,
  token,
  timeoutMs = DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
  signal,
}: {
  daemonUrl?: string | undefined
  method?: 'GET' | 'POST'
  path: string
  body?: Record<string, unknown>
  token?: string | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}) {
  const headers: Record<string, string> = {
    accept: 'application/json',
  }
  let payload: string | undefined
  if (body) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(stripUndefined(body))
  }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  const requestSignal = combinedRequestSignal(timeoutMs, signal)
  const requestInit: RequestInit = {
    method,
    headers,
    signal: requestSignal,
  }
  if (payload !== undefined) {
    requestInit.body = payload
  }

  let response: Response
  let responseBody: unknown
  try {
    response = await fetch(`${daemonUrl(explicitDaemonUrl)}${requestPath}`, requestInit)
    responseBody = await readJsonResponse(response)
  } catch (error) {
    if ((error as DaemonError)?.code === 'daemon_invalid_response') throw error
    if (signal?.aborted) {
      throw daemonClientError('daemon_request_aborted', 'Tokenless daemon request was aborted.', true)
    }
    if (requestSignal.aborted) {
      throw daemonClientError(
        'daemon_request_timeout',
        `Tokenless daemon did not respond within ${normalizedTimeoutMs(timeoutMs)} ms.`,
        true
      )
    }
    throw daemonClientError('daemon_unavailable', 'Tokenless daemon is not reachable on the configured loopback URL.', true)
  }
  if (!response.ok) {
    const message = errorMessageFromBody(responseBody) || `Tokenless daemon request failed with HTTP ${response.status}.`
    throw daemonClientError('daemon_request_failed', message, response.status >= 500, response.status)
  }
  return responseBody as T
}

async function readJsonResponse(response: Response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw daemonClientError('daemon_invalid_response', 'Tokenless daemon returned invalid JSON.', true, response.status)
  }
}

function errorMessageFromBody(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message : null
}

function daemonClientError(code: string, message: string, retryable: boolean, status?: number) {
  const error = new Error(message) as DaemonError
  error.code = code
  error.retryable = retryable
  if (status !== undefined) error.status = status
  return error
}

function validateDaemonUrl(value: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw daemonClientError('invalid_daemon_url', 'Tokenless daemon URL must be a valid loopback HTTP URL.', false)
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) {
    throw daemonClientError('invalid_daemon_url', 'Tokenless daemon URL must be a loopback HTTP URL.', false)
  }
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function stripUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined))
}

function assertNativeMessageSize(value: unknown) {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw daemonClientError('invalid_daemon_request', 'Tokenless request must be JSON serializable.', false)
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > MAX_NATIVE_MESSAGE_BYTES) {
    throw daemonClientError(
      'native_message_too_large',
      `Tokenless request is ${bytes} bytes; keep it below ${MAX_NATIVE_MESSAGE_BYTES} bytes. Attach fewer or smaller files.`,
      false
    )
  }
}

function compactDaemonOutput(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const result = value as { text?: unknown; read?: unknown; sources?: unknown }
  const playwrightText = compactPlaywrightResponseText(result)
  if (playwrightText) return playwrightText
  const text = result.text
  if (typeof text !== 'string' || !text.trim()) return undefined
  const sources = compactSources(result.read) ?? compactSources(result)
  if (sources.length === 0) return text
  return `${text.trimEnd()}\n\nSources:\n${sources.map((source) => (
    `- ${source.title ? `${source.title}: ` : ''}${source.url}`
  )).join('\n')}`
}

function compactPlaywrightResponseText(value: Record<string, unknown>) {
  const responses = value.responses
  if (!Array.isArray(responses)) return undefined
  const readResponse = [...responses].reverse().find((response) => (
    response &&
    typeof response === 'object' &&
    (response as { action?: unknown }).action === 'response.read' &&
    (response as { ok?: unknown }).ok === true
  )) as { result?: unknown } | undefined
  const read = readResponse && typeof readResponse.result === 'object' && readResponse.result
    ? readResponse.result as { text?: unknown; citations?: unknown }
    : null
  if (typeof read?.text !== 'string' || !read.text.trim()) return undefined
  const citations = Array.isArray(read.citations) ? read.citations : []
  const sources = citations
    .map((citation) => {
      if (!citation || typeof citation !== 'object') return null
      const url = (citation as { href?: unknown }).href
      if (typeof url !== 'string' || !isPublicHttpsUrl(url)) return null
      const title = (citation as { label?: unknown }).label
      return {
        url,
        ...(typeof title === 'string' && title.trim() ? { title: terminalText(title).slice(0, 240) } : {}),
      }
    })
    .filter((source): source is { url: string; title?: string } => source !== null)
  if (sources.length === 0) return read.text
  return `${read.text.trimEnd()}\n\nSources:\n${sources.map((source) => (
    `- ${source.title ? `${source.title}: ` : ''}${source.url}`
  )).join('\n')}`
}

function compactSources(value: unknown) {
  if (!value || typeof value !== 'object') return []
  const sources = (value as { sources?: unknown }).sources
  if (!Array.isArray(sources)) return []
  const seen = new Set<string>()
  const compact: Array<{ url: string; title?: string }> = []
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    const url = (source as { url?: unknown }).url
    if (typeof url !== 'string' || !isPublicHttpsUrl(url) || seen.has(url)) continue
    seen.add(url)
    const candidateTitle = (source as { title?: unknown }).title
    const title = typeof candidateTitle === 'string' ? terminalText(candidateTitle).slice(0, 240) : ''
    compact.push({ url, ...(title ? { title } : {}) })
  }
  return compact
}

function isPublicHttpsUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === ''
  } catch {
    return false
  }
}

function terminalText(value: string) {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error)
}

async function authenticatedDaemonToken({
  daemonUrl: explicitDaemonUrl,
  homeDir = tokenlessHome(),
  requestTimeoutMs,
}: DaemonClientOptions) {
  const token = await readDaemonToken({ homeDir })
  const { probeDaemonReady } = await import('./runtime.js')
  const ready = await probeDaemonReady({
    daemonUrl: explicitDaemonUrl,
    homeDir,
    daemonToken: token,
    timeoutMs: Math.min(normalizedTimeoutMs(requestTimeoutMs), 1_000),
  })
  if (!ready.ok) {
    throw daemonClientError(
      ready.code ?? 'daemon_identity_unverified',
      ready.message ?? 'Tokenless daemon identity could not be verified; refusing to send its control token.',
      ready.code === 'daemon_unavailable'
    )
  }
  return token
}

function combinedRequestSignal(timeoutMs: number | undefined, signal?: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(normalizedTimeoutMs(timeoutMs))
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function normalizedTimeoutMs(value: number | undefined) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0
    ? Math.max(1, Math.floor(numeric))
    : DEFAULT_DAEMON_REQUEST_TIMEOUT_MS
}

function delay(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(daemonClientError('daemon_request_aborted', 'Tokenless daemon request was aborted.', true))
      return
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(daemonClientError('daemon_request_aborted', 'Tokenless daemon request was aborted.', true))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
