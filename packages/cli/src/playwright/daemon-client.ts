import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { tokenlessError } from './errors.js'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7331' as const
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 5_000

export type DaemonJobStatus = 'queued' | 'claimed' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'canceled' | 'timed_out'
export type DaemonExecutionBackend = 'legacy_extension' | 'playwright'

export type DaemonJob = {
  job_id: string
  execution_backend: DaemonExecutionBackend
  profile_id: string | null
  provider: string
  action: string
  status: DaemonJobStatus
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

export type DaemonClientOptions = {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  requestTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  token?: string | undefined
  fetchImpl?: typeof fetch | undefined
}

export type CreateDaemonJobOptions = DaemonClientOptions & {
  provider: string
  action: string
  requestJson: unknown
  executionBackend?: DaemonExecutionBackend | undefined
  profileId?: string | undefined
  jobId?: string | undefined
  claimToken?: string | undefined
}

export type ListDaemonJobsOptions = DaemonClientOptions & {
  status?: DaemonJobStatus | undefined
  executionBackend?: DaemonExecutionBackend | undefined
  profileId?: string | undefined
  provider?: string | undefined
  taskId?: string | undefined
  limit?: number | undefined
}

export type GetDaemonJobOptions = DaemonClientOptions & {
  jobId: string
}

export type ClaimNextDaemonJobOptions = DaemonClientOptions & {
  executionBackend: DaemonExecutionBackend
  profileId?: string | undefined
  provider?: string | undefined
  action?: string | undefined
}

export type ClaimLifecycleDaemonJobOptions = GetDaemonJobOptions & {
  claimToken: string
}

export type WaitingForUserDaemonJobOptions = ClaimLifecycleDaemonJobOptions & {
  blocker: unknown
}

export type CompleteDaemonJobOptions = ClaimLifecycleDaemonJobOptions & {
  result?: unknown
  error?: unknown
}

export type CancelDaemonJobOptions = GetDaemonJobOptions & {
  reason?: unknown
}

export type ManagedDaemonClient = {
  createJob(options: CreateDaemonJobOptions): Promise<DaemonClaimedJob>
  listJobs(options?: ListDaemonJobsOptions): Promise<DaemonJob[]>
  getJob(options: GetDaemonJobOptions): Promise<DaemonJob>
  claimNextJob(options: ClaimNextDaemonJobOptions): Promise<{ job: DaemonClaimedJob | null }>
  markJobRunning(options: ClaimLifecycleDaemonJobOptions): Promise<DaemonJob>
  markJobWaitingForUser(options: WaitingForUserDaemonJobOptions): Promise<DaemonJob>
  renewJobClaim(options: ClaimLifecycleDaemonJobOptions): Promise<DaemonJob>
  completeJob(options: CompleteDaemonJobOptions): Promise<DaemonJob>
  cancelJob(options: CancelDaemonJobOptions): Promise<DaemonJob>
}

export function tokenlessHome(explicitHome = process.env.TOKENLESS_HOME) {
  return path.resolve(explicitHome || path.join(os.homedir(), '.tokenless'))
}

export function daemonUrl(explicitUrl?: string | undefined) {
  const value = explicitUrl || process.env.TOKENLESS_DAEMON_URL || DEFAULT_DAEMON_URL
  const normalized = value.replace(/\/+$/, '')
  validateDaemonUrl(normalized)
  return normalized
}

export async function readDaemonToken({ homeDir = tokenlessHome() }: Pick<DaemonClientOptions, 'homeDir'> = {}) {
  let token: string
  try {
    token = (await fs.readFile(path.join(homeDir, 'daemon.token'), 'utf8')).trim()
  } catch (error) {
    throw tokenlessError('daemon_token_unavailable', 'Tokenless daemon control token is unavailable.', { retryable: true, cause: error })
  }
  if (!token) throw tokenlessError('daemon_token_unavailable', 'Tokenless daemon control token is empty.', { retryable: true })
  return token
}

export function createDaemonClient(defaults: DaemonClientOptions = {}): ManagedDaemonClient {
  return {
    createJob: (options) => createDaemonJob({ ...defaults, ...options }),
    listJobs: (options = {}) => listDaemonJobs({ ...defaults, ...options }),
    getJob: (options) => getDaemonJob({ ...defaults, ...options }),
    claimNextJob: (options) => claimNextDaemonJob({ ...defaults, ...options }),
    markJobRunning: (options) => markDaemonJobRunning({ ...defaults, ...options }),
    markJobWaitingForUser: (options) => markDaemonJobWaitingForUser({ ...defaults, ...options }),
    renewJobClaim: (options) => renewDaemonJobClaim({ ...defaults, ...options }),
    completeJob: (options) => completeDaemonJob({ ...defaults, ...options }),
    cancelJob: (options) => cancelDaemonJob({ ...defaults, ...options }),
  }
}

export async function createDaemonJob({
  provider,
  action,
  requestJson,
  executionBackend,
  profileId,
  jobId,
  claimToken,
  ...options
}: CreateDaemonJobOptions) {
  return daemonRequest<DaemonClaimedJob>({
    ...options,
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
  })
}

export async function listDaemonJobs({
  status,
  executionBackend,
  profileId,
  provider,
  taskId,
  limit = 100,
  ...options
}: ListDaemonJobsOptions = {}) {
  const query = new URLSearchParams()
  if (status) query.set('status', status)
  if (executionBackend) query.set('execution_backend', executionBackend)
  if (profileId) query.set('profile_id', profileId)
  if (provider) query.set('provider', provider)
  if (taskId) query.set('task_id', taskId)
  query.set('limit', String(Math.max(1, Math.min(1000, Number(limit) || 100))))
  return daemonRequest<DaemonJob[]>({
    ...options,
    method: 'GET',
    path: `/jobs?${query.toString()}`,
  })
}

export async function getDaemonJob({ jobId, ...options }: GetDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    ...options,
    method: 'GET',
    path: `/jobs/${encodeURIComponent(jobId)}`,
  })
}

export async function claimNextDaemonJob({
  executionBackend,
  profileId,
  provider,
  action,
  ...options
}: ClaimNextDaemonJobOptions) {
  const query = new URLSearchParams()
  query.set('execution_backend', executionBackend)
  if (profileId) query.set('profile_id', profileId)
  if (provider) query.set('provider', provider)
  if (action) query.set('action', action)
  return daemonRequest<{ job: DaemonClaimedJob | null }>({
    ...options,
    path: `/control/jobs/claim-next?${query.toString()}`,
  })
}

export async function markDaemonJobRunning({ jobId, claimToken, ...options }: ClaimLifecycleDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    ...options,
    path: `/control/jobs/${encodeURIComponent(jobId)}/running`,
    body: { claim_token: claimToken },
  })
}

export async function markDaemonJobWaitingForUser({ jobId, claimToken, blocker, ...options }: WaitingForUserDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    ...options,
    path: `/control/jobs/${encodeURIComponent(jobId)}/waiting-for-user`,
    body: { claim_token: claimToken, blocker_json: blocker },
  })
}

export async function renewDaemonJobClaim({ jobId, claimToken, ...options }: ClaimLifecycleDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    ...options,
    path: `/control/jobs/${encodeURIComponent(jobId)}/renew`,
    body: { claim_token: claimToken },
  })
}

export async function completeDaemonJob({
  jobId,
  claimToken,
  result,
  error,
  ...options
}: CompleteDaemonJobOptions) {
  const hasResult = result !== undefined
  const hasError = error !== undefined
  if (hasResult === hasError) {
    throw tokenlessError('invalid_daemon_completion', 'Pass exactly one of result or error when completing a daemon job.')
  }
  return daemonRequest<DaemonJob>({
    ...options,
    path: `/jobs/${encodeURIComponent(jobId)}/complete`,
    body: {
      claim_token: claimToken,
      result_json: hasResult ? result : undefined,
      error_json: hasError ? error : undefined,
    },
  })
}

export async function cancelDaemonJob({ jobId, reason, ...options }: CancelDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    ...options,
    path: `/control/jobs/${encodeURIComponent(jobId)}/cancel`,
    ...(reason === undefined ? {} : { body: { reason } }),
  })
}

async function daemonRequest<T>({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs = DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
  signal,
  token,
  fetchImpl = fetch,
  method = 'POST',
  path: requestPath,
  body,
}: DaemonClientOptions & {
  method?: 'GET' | 'POST'
  path: string
  body?: Record<string, unknown> | undefined
}) {
  const bearer = token ?? await readDaemonToken({ homeDir })
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${bearer}`,
  }
  const init: RequestInit = {
    method,
    headers,
    signal: combinedRequestSignal(requestTimeoutMs, signal),
  }
  if (body) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(stripUndefined(body))
  }

  let response: Response
  let responseBody: unknown
  try {
    response = await fetchImpl(`${daemonUrl(explicitDaemonUrl)}${requestPath}`, init)
    responseBody = await readJsonResponse(response)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw tokenlessError('daemon_request_timeout', 'Tokenless daemon request timed out or was aborted.', { retryable: true, cause: error })
    }
    if (error instanceof Error && error.name === 'TokenlessPlaywrightError') throw error
    throw tokenlessError('daemon_unavailable', 'Tokenless daemon is not reachable on the configured loopback URL.', { retryable: true, cause: error })
  }
  if (!response.ok) {
    throw tokenlessError(
      'daemon_request_failed',
      errorMessageFromBody(responseBody) ?? `Tokenless daemon request failed with HTTP ${response.status}.`,
      { retryable: response.status >= 500 }
    )
  }
  return responseBody as T
}

async function readJsonResponse(response: Response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw tokenlessError('daemon_invalid_response', 'Tokenless daemon returned invalid JSON.', { retryable: true, cause: error })
  }
}

function errorMessageFromBody(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message : null
}

function validateDaemonUrl(value: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw tokenlessError('invalid_daemon_url', 'Tokenless daemon URL must be a valid loopback HTTP URL.')
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) {
    throw tokenlessError('invalid_daemon_url', 'Tokenless daemon URL must be a loopback HTTP URL.')
  }
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function combinedRequestSignal(timeoutMs: number, signal?: AbortSignal | undefined) {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function stripUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined))
}
