import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_ERROR_PROTOCOL } from '../generated/protocol-constants.js'
import { tokenlessError } from './errors.js'
import type { BrowserVisibility } from '../browser-visibility.js'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7331' as const
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 5_000
const LEGACY_DAEMON_SUPPORTED_PROVIDERS = Object.freeze(['chatgpt', 'claude', 'gemini', 'grok'])

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
  checkpoint_json: unknown | null
  resume_json: unknown | null
}

export type DaemonClientOptions = {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  requestTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  token?: string | undefined
  fetchImpl?: typeof fetch | undefined
}

export type DaemonReadyResponse = Record<string, unknown> & {
  ready: true
  supported_providers: string[]
}

export type DaemonReadyOptions = DaemonClientOptions

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

export type CheckpointDaemonJobOptions = ClaimLifecycleDaemonJobOptions & {
  checkpoint: unknown
}

export type ParkDaemonJobOptions = ClaimLifecycleDaemonJobOptions & {
  blocker: unknown
  checkpoint: unknown
}

export type ResumeDaemonJobOptions = GetDaemonJobOptions & {
  browserVisibility: Extract<BrowserVisibility, 'headed'>
}

export type CancelDaemonJobOptions = GetDaemonJobOptions & {
  reason?: unknown
}

export type ManagedDaemonClient = {
  ready(options?: DaemonReadyOptions): Promise<DaemonReadyResponse>
  createJob(options: CreateDaemonJobOptions): Promise<DaemonClaimedJob>
  listJobs(options?: ListDaemonJobsOptions): Promise<DaemonJob[]>
  getJob(options: GetDaemonJobOptions): Promise<DaemonJob>
  claimNextJob(options: ClaimNextDaemonJobOptions): Promise<{ job: DaemonClaimedJob | null }>
  markJobRunning(options: ClaimLifecycleDaemonJobOptions): Promise<DaemonJob>
  markJobWaitingForUser(options: WaitingForUserDaemonJobOptions): Promise<DaemonJob>
  checkpointJob(options: CheckpointDaemonJobOptions): Promise<DaemonJob>
  parkJob(options: ParkDaemonJobOptions): Promise<DaemonJob>
  resumeJob(options: ResumeDaemonJobOptions): Promise<DaemonJob>
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
    ready: (options = {}) => daemonReady({ ...defaults, ...options }),
    createJob: (options) => createDaemonJob({ ...defaults, ...options }),
    listJobs: (options = {}) => listDaemonJobs({ ...defaults, ...options }),
    getJob: (options) => getDaemonJob({ ...defaults, ...options }),
    claimNextJob: (options) => claimNextDaemonJob({ ...defaults, ...options }),
    markJobRunning: (options) => markDaemonJobRunning({ ...defaults, ...options }),
    markJobWaitingForUser: (options) => markDaemonJobWaitingForUser({ ...defaults, ...options }),
    checkpointJob: (options) => checkpointDaemonJob({ ...defaults, ...options }),
    parkJob: (options) => parkDaemonJob({ ...defaults, ...options }),
    resumeJob: (options) => resumeDaemonJob({ ...defaults, ...options }),
    renewJobClaim: (options) => renewDaemonJobClaim({ ...defaults, ...options }),
    completeJob: (options) => completeDaemonJob({ ...defaults, ...options }),
    cancelJob: (options) => cancelDaemonJob({ ...defaults, ...options }),
  }
}

export async function daemonReady(options: DaemonReadyOptions = {}) {
  const challenge = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({ challenge })
  const body = await daemonRequest<Record<string, unknown>>({
    ...options,
    method: 'GET',
    path: `/ready?${query.toString()}`,
  })
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.ready !== true) {
    throw tokenlessError('daemon_not_ready', 'Tokenless daemon /ready did not report ready=true.', { retryable: true })
  }
  return {
    ...body,
    ready: true as const,
    supported_providers: supportedProvidersFromReadyBody(body),
  } satisfies DaemonReadyResponse
}

export function daemonAdvertisesProvider(body: unknown, provider: string) {
  return supportedProvidersFromReadyBody(body).includes(provider)
}

export function supportedProvidersFromReadyBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const value = (body as { supported_providers?: unknown }).supported_providers
  if (value === undefined) return [...LEGACY_DAEMON_SUPPORTED_PROVIDERS]
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return []
  return [...new Set(value)]
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

export async function checkpointDaemonJob({ jobId, claimToken, checkpoint, ...options }: CheckpointDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    ...options,
    path: `/control/jobs/${encodeURIComponent(jobId)}/checkpoint`,
    body: { claim_token: claimToken, checkpoint_json: checkpoint },
  })
}

export async function parkDaemonJob({ jobId, claimToken, blocker, checkpoint, ...options }: ParkDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    ...options,
    path: `/control/jobs/${encodeURIComponent(jobId)}/park`,
    body: {
      claim_token: claimToken,
      blocker_json: blocker,
      checkpoint_json: checkpoint,
    },
  })
}

export async function resumeDaemonJob({ jobId, browserVisibility, ...options }: ResumeDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    ...options,
    path: `/jobs/${encodeURIComponent(jobId)}/resume`,
    body: { browser_visibility: browserVisibility },
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
    const serverError = daemonServerErrorFromBody(responseBody)
    throw tokenlessError(
      serverError?.code ?? 'daemon_request_failed',
      serverError?.message ?? `Tokenless daemon request failed with HTTP ${response.status}.`,
      {
        retryable: serverError?.retryable ?? response.status >= 500,
        ...(serverError?.details === undefined ? {} : { details: serverError.details }),
      }
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

function daemonServerErrorFromBody(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const envelope = error as { protocol?: unknown; code?: unknown; message?: unknown; retryable?: unknown; details?: unknown }
  const message = typeof envelope.message === 'string' && envelope.message.trim() ? envelope.message : null
  if (!message) return null
  if (
    envelope.protocol === DAEMON_ERROR_PROTOCOL &&
    typeof envelope.code === 'string' &&
    envelope.code.trim() &&
    typeof envelope.retryable === 'boolean'
  ) {
    return {
      code: envelope.code,
      message,
      retryable: envelope.retryable,
      details: envelope.details,
    }
  }
  return { code: undefined, message, retryable: undefined, details: undefined }
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
