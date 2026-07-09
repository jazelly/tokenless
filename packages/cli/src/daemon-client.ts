import fs from 'node:fs/promises'
import path from 'node:path'

import { tokenlessHome } from './job-store.js'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7331'

export type DaemonClientOptions = {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
}

export type DaemonJob = {
  job_id: string
  provider: string
  action: string
  status: string
  request_json: unknown
  result_json: unknown | null
  error_json: unknown | null
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
  jobId?: string | undefined
  claimToken?: string | undefined
}

export type ClaimNextDaemonJobOptions = DaemonClientOptions & {
  provider?: string | undefined
  action?: string | undefined
}

export type GetDaemonJobOptions = DaemonClientOptions & {
  jobId: string
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
  onStatus?: ((event: Record<string, unknown>) => unknown) | undefined
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
  return (await fs.readFile(path.join(homeDir, 'daemon.token'), 'utf8')).trim()
}

export async function createDaemonJob({
  daemonUrl: explicitDaemonUrl,
  provider,
  action,
  requestJson = {},
  jobId,
  claimToken,
}: CreateDaemonJobOptions) {
  return daemonRequest<DaemonClaimedJob>({
    daemonUrl: explicitDaemonUrl,
    path: '/jobs',
    body: {
      provider,
      action,
      request_json: requestJson,
      job_id: jobId,
      claim_token: claimToken,
    },
  })
}

export async function getDaemonJob({
  daemonUrl: explicitDaemonUrl,
  jobId,
}: GetDaemonJobOptions) {
  return daemonRequest<DaemonJob>({
    daemonUrl: explicitDaemonUrl,
    method: 'GET',
    path: `/jobs/${encodeURIComponent(jobId)}`,
  })
}

export async function claimNextDaemonJob({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  provider,
  action,
}: ClaimNextDaemonJobOptions = {}) {
  const token = await readDaemonToken({ homeDir })
  const query = new URLSearchParams()
  if (provider) query.set('provider', provider)
  if (action) query.set('action', action)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''

  return daemonRequest<{ job: DaemonClaimedJob | null }>({
    daemonUrl: explicitDaemonUrl,
    path: `/control/jobs/claim-next${suffix}`,
    token,
  })
}

export async function completeDaemonJob({
  daemonUrl: explicitDaemonUrl,
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

  return daemonRequest<DaemonJob>({
    daemonUrl: explicitDaemonUrl,
    path: `/jobs/${encodeURIComponent(jobId)}/complete`,
    body: {
      claim_token: claimToken,
      result_json: hasResult ? result : undefined,
      error_json: hasError ? error : undefined,
    },
  })
}

export async function waitDaemonJobResult({
  daemonUrl: explicitDaemonUrl,
  jobId,
  timeoutMs = 180000,
  pollMs = 250,
  onStatus,
}: WaitDaemonJobResultOptions) {
  const startedAt = Date.now()
  let lastStatus: string | undefined
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getDaemonJob({ daemonUrl: explicitDaemonUrl, jobId })
    if (job.status !== lastStatus) {
      lastStatus = job.status
      await onStatus?.({
        event: 'daemon_status',
        status: job.status,
        jobId,
        provider: job.provider,
        action: job.action,
        elapsedMs: Date.now() - startedAt,
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
    if (job.status === 'failed') {
      return {
        ok: false,
        status: job.status,
        job,
        error: job.error_json,
      }
    }
    await delay(pollMs)
  }
  const error = daemonClientError('daemon_job_timeout', 'Timed out waiting for daemon job result.', true)
  throw error
}

async function daemonRequest<T>({
  daemonUrl: explicitDaemonUrl,
  method = 'POST',
  path: requestPath,
  body,
  token,
}: {
  daemonUrl?: string | undefined
  method?: 'GET' | 'POST'
  path: string
  body?: Record<string, unknown>
  token?: string | undefined
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

  const requestInit: RequestInit = {
    method,
    headers,
  }
  if (payload !== undefined) {
    requestInit.body = payload
  }

  let response: Response
  try {
    response = await fetch(`${daemonUrl(explicitDaemonUrl)}${requestPath}`, requestInit)
  } catch {
    throw daemonClientError('daemon_unavailable', 'Tokenless daemon is not reachable on the configured loopback URL.', true)
  }
  const responseBody = await readJsonResponse(response)
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

function compactDaemonOutput(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const text = (value as { text?: unknown }).text
  return typeof text === 'string' && text.trim() ? text : undefined
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
