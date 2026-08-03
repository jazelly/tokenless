import fs from 'node:fs/promises'
import path from 'node:path'

import { tokenlessHome } from './job-store.js'
import { DaemonRuntimeState } from './daemon/runtime-state.js'
import type { ProviderCapacityProjection } from './providers/rate-limit-policy.js'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7331'
export const MAX_DAEMON_REQUEST_BYTES = 900 * 1024
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_CANCEL_REQUEST_TIMEOUT_MS = 3_000

export type DaemonClientOptions = {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  requestTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export type DaemonJobStatus = 'queued' | 'claimed' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'canceled' | 'timed_out'

export type DaemonJob = {
  job_id: string
  execution_backend?: 'playwright'
  profile_id?: string | null
  provider: string
  action: string
  status: DaemonJobStatus
  request_json: unknown
  result_json: unknown | null
  error_json: unknown | null
  blocker_json: unknown | null
  provider_attempts_json: unknown
  provider_submitted_at: string | null
  eligible_at: string | null
  created_at: string
  updated_at: string
}

export type CreateDaemonJobOptions = DaemonClientOptions & {
  provider: string
  action: string
  requestJson?: unknown
  executionBackend?: 'playwright' | undefined
  profileId?: string | undefined
  agentKind?: string | undefined
  agentSessionId?: string | undefined
  jobId?: string | undefined
}

export type AgentRecipientOptions = {
  agentKind: string
  agentSessionId: string
}

export type DaemonReplaySummary = {
  job_id: string
  provider: string
  action: string
  status: 'waiting_for_user' | 'succeeded' | 'failed' | 'canceled' | 'timed_out'
  task_id: string | null
  updated_at: string
  reported_at: string
  outcome_kind: 'result' | 'error' | 'blocker' | 'none'
  has_result: boolean
  has_error: boolean
  has_blocker: boolean
}

export type DrainDaemonReplayOptions = DaemonClientOptions & AgentRecipientOptions & {
  limit?: number | undefined
}

export type MarkDaemonJobReportedOptions = GetDaemonJobOptions & AgentRecipientOptions

export type GetDaemonJobOptions = DaemonClientOptions & {
  jobId: string
}

export type ListDaemonJobsOptions = DaemonClientOptions & {
  status?: string | undefined
  executionBackend?: 'playwright' | undefined
  profileId?: string | undefined
  provider?: string | undefined
  taskId?: string | undefined
  limit?: number | undefined
}

export type ResolveProviderMappingOptions = DaemonClientOptions & {
  provider: string
  profileId: string
  projectName: string
  taskId?: string | undefined
}

export type ResolveProviderConversationOptions = DaemonClientOptions & {
  provider: string
  profileId: string
  taskId: string
}

export type GetProviderCapacityOptions = DaemonClientOptions & {
  provider: string
  profileId: string
  accessClass: string
  tierLabel?: string | null | undefined
  subscriptionLabel?: string | null | undefined
}

export type CancelDaemonJobOptions = GetDaemonJobOptions & {
  reason?: unknown
}

export type ResumeDaemonJobOptions = GetDaemonJobOptions & {
  browserVisibility: 'headed'
}

export type WaitDaemonJobResultOptions = GetDaemonJobOptions & {
  timeoutMs?: number | undefined
  pollMs?: number | undefined
  heartbeatMs?: number | undefined
  onStatus?: ((event: Record<string, unknown>) => unknown) | undefined
  agentKind?: string | undefined
  agentSessionId?: string | undefined
}

export type ShutdownDaemonOptions = {
  daemonUrl?: string | undefined
  requestTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  controlToken: string
}

export type ShutdownDaemonResponse = {
  ok: boolean
  status: 'shutting_down'
  pid?: number | undefined
}

export type BrowserRuntimeStatus = {
  status: 'running' | 'quiescing' | 'quiesced' | 'stopped'
  activeProfileCount: number
  activeJobCount: number
  pid: number
}

export type BrowserRuntimeOpenProfileOptions = DaemonClientOptions & {
  profileId: string
  browserVisibility: 'auto' | 'headed' | 'headless'
}

export type BrowserRuntimeOpenProfileResponse = {
  profileId: string
  browserVisibility: 'auto' | 'headed' | 'headless'
  effectiveBrowserVisibility: 'headed' | 'headless'
  pageCount: number
  status: BrowserRuntimeStatus
}

export type BrowserRuntimeOpenProviderTabsOptions = DaemonClientOptions & {
  profileId: string
  providers: readonly string[]
  browserVisibility: 'auto' | 'headed' | 'headless'
}

export type BrowserRuntimeOpenProviderTabsResponse = BrowserRuntimeOpenProfileResponse & {
  tabs: readonly {
    provider: string
    url: string
    reused: boolean
  }[]
  failures: readonly {
    provider: string
    code: 'provider_tab_open_failed'
    message: string
  }[]
}

export type OpenDashboardOptions = DaemonClientOptions & {
  profileId?: string | undefined
  open?: boolean | undefined
}

export type OpenDashboardResponse = {
  ticket: string
  bootstrapUrl: string
  expiresAt: string
  opened: null | (BrowserRuntimeOpenProfileResponse & { url: string, reused: boolean })
}

type DaemonError = Error & {
  code?: string
  retryable?: boolean
  status?: number
  details?: unknown
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
  agentKind,
  agentSessionId,
  jobId,
}: CreateDaemonJobOptions) {
  assertAgentRecipientPair(agentKind, agentSessionId)
  assertDaemonRequestSize({
    provider,
    action,
    request_json: requestJson,
    agent_kind: agentKind,
    agent_session_id: agentSessionId,
  })
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: daemon.daemonUrl,
    path: '/jobs',
    body: {
      provider,
      action,
      request_json: requestJson,
      execution_backend: executionBackend,
      profile_id: profileId,
      agent_kind: agentKind,
      agent_session_id: agentSessionId,
      job_id: jobId,
    },
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function drainDaemonReplay({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  agentKind,
  agentSessionId,
  limit,
}: DrainDaemonReplayOptions) {
  assertAgentRecipientPair(agentKind, agentSessionId)
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<{ jobs: DaemonReplaySummary[] }>({
    daemonUrl: daemon.daemonUrl,
    path: '/replay/drain',
    body: {
      agent_kind: agentKind,
      agent_session_id: agentSessionId,
      limit,
    },
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function markDaemonJobReported({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  jobId,
  agentKind,
  agentSessionId,
}: MarkDaemonJobReportedOptions) {
  assertAgentRecipientPair(agentKind, agentSessionId)
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<{ reported: boolean; job: DaemonJob }>({
    daemonUrl: daemon.daemonUrl,
    path: `/jobs/${encodeURIComponent(jobId)}/report`,
    body: {
      agent_kind: agentKind,
      agent_session_id: agentSessionId,
    },
    token: daemon.token,
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
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  const query = new URLSearchParams()
  if (status) query.set('status', status)
  if (executionBackend) query.set('execution_backend', executionBackend)
  if (profileId) query.set('profile_id', profileId)
  if (provider) query.set('provider', provider)
  if (taskId) query.set('task_id', taskId)
  query.set('limit', String(Math.max(1, Math.min(1000, Number(limit) || 100))))
  return daemonRequest<DaemonJob[]>({
    daemonUrl: daemon.daemonUrl,
    method: 'GET',
    path: `/jobs?${query.toString()}`,
    token: daemon.token,
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
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: daemon.daemonUrl,
    method: 'GET',
    path: `/jobs/${encodeURIComponent(jobId)}`,
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function getProviderCapacity({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  provider,
  profileId,
  accessClass,
  tierLabel,
  subscriptionLabel,
}: GetProviderCapacityOptions) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  const query = new URLSearchParams({
    provider,
    profile_id: profileId,
    access_class: accessClass,
  })
  if (tierLabel) query.set('tier_label', tierLabel)
  if (subscriptionLabel) query.set('subscription_label', subscriptionLabel)
  return daemonRequest<ProviderCapacityProjection>({
    daemonUrl: daemon.daemonUrl,
    method: 'GET',
    path: `/provider-capacity?${query.toString()}`,
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function resolveProviderMapping({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  provider,
  profileId,
  projectName,
  taskId,
}: ResolveProviderMappingOptions) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  const query = new URLSearchParams({
    provider,
    profile_id: profileId,
    project_name: projectName,
  })
  if (taskId) query.set('task_id', taskId)
  return daemonRequest<{
    mapping: {
      project: {
        provider: string
        profile_id: string
        resource_id: string
        name: string
        canonical_url: string
      }
      conversation: {
        provider: string
        profile_id: string
        project_resource_id: string
        task_id: string
        canonical_url: string
      } | null
    } | null
  }>({
    daemonUrl: daemon.daemonUrl,
    method: 'GET',
    path: `/provider-mappings/resolve?${query.toString()}`,
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function resolveProviderConversation({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  provider,
  profileId,
  taskId,
}: ResolveProviderConversationOptions) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  const query = new URLSearchParams({
    provider,
    profile_id: profileId,
    task_id: taskId,
  })
  return daemonRequest<{
    mapping: {
      provider: string
      profile_id: string
      task_id: string
      canonical_url: string
      proved_job_id: string
      observed_at: string
    } | null
  }>({
    daemonUrl: daemon.daemonUrl,
    method: 'GET',
    path: `/provider-conversations/resolve?${query.toString()}`,
    token: daemon.token,
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
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: daemon.daemonUrl,
    path: `/jobs/${encodeURIComponent(jobId)}/cancel`,
    ...(reason === undefined ? {} : { body: { reason } }),
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function shutdownDaemon({
  daemonUrl: explicitDaemonUrl,
  requestTimeoutMs,
  signal,
  controlToken,
}: ShutdownDaemonOptions) {
  if (typeof controlToken !== 'string' || !controlToken) {
    throw daemonClientError(
      'daemon_shutdown_token_invalid',
      'A non-empty daemon control token is required to stop the daemon.',
      false
    )
  }
  return daemonRequest<ShutdownDaemonResponse>({
    daemonUrl: explicitDaemonUrl,
    path: '/control/shutdown',
    token: controlToken,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function browserRuntimeStatus({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
}: DaemonClientOptions = {}) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<BrowserRuntimeStatus>({
    daemonUrl: daemon.daemonUrl,
    method: 'GET',
    path: '/control/browser-runtime/status',
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function quiesceBrowserRuntime({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
}: DaemonClientOptions = {}) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<BrowserRuntimeStatus>({
    daemonUrl: daemon.daemonUrl,
    path: '/control/browser-runtime/quiesce',
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function openBrowserRuntimeProfile({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  profileId,
  browserVisibility,
}: BrowserRuntimeOpenProfileOptions) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<BrowserRuntimeOpenProfileResponse>({
    daemonUrl: daemon.daemonUrl,
    path: '/control/browser-runtime/open-profile',
    body: {
      profile_id: profileId,
      browser_visibility: browserVisibility,
    },
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function openBrowserRuntimeProviderTabs({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  profileId,
  providers,
  browserVisibility,
}: BrowserRuntimeOpenProviderTabsOptions) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<BrowserRuntimeOpenProviderTabsResponse>({
    daemonUrl: daemon.daemonUrl,
    path: '/control/browser-runtime/open-provider-tabs',
    body: {
      profile_id: profileId,
      providers,
      browser_visibility: browserVisibility,
    },
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function openTokenlessDashboard({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  profileId,
  open = true,
}: OpenDashboardOptions = {}) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<OpenDashboardResponse>({
    daemonUrl: daemon.daemonUrl,
    path: '/control/ui-bootstrap',
    body: {
      ...(profileId ? { profile_id: profileId } : {}),
      open,
    },
    token: daemon.token,
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
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: daemon.daemonUrl,
    path: `/jobs/${encodeURIComponent(jobId)}/resume`,
    body: { browser_visibility: browserVisibility },
    token: daemon.token,
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
  agentKind,
  agentSessionId,
}: WaitDaemonJobResultOptions) {
  assertAgentRecipientPair(agentKind, agentSessionId)
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
      await markOutcomeReportedIfAddressed({
        daemonUrl: explicitDaemonUrl,
        homeDir,
        requestTimeoutMs,
        signal,
        jobId,
        agentKind,
        agentSessionId,
      })
      return {
        ok: true,
        status: job.status,
        job,
        result: job.result_json,
        compactOutput: compactDaemonOutput(job.result_json),
      }
    }
    if (job.status === 'failed' || job.status === 'canceled' || job.status === 'timed_out') {
      await markOutcomeReportedIfAddressed({
        daemonUrl: explicitDaemonUrl,
        homeDir,
        requestTimeoutMs,
        signal,
        jobId,
        agentKind,
        agentSessionId,
      })
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
      await markOutcomeReportedIfAddressed({
        daemonUrl: explicitDaemonUrl,
        homeDir,
        requestTimeoutMs,
        signal,
        jobId,
        agentKind,
        agentSessionId,
      })
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

async function markOutcomeReportedIfAddressed({
  agentKind,
  agentSessionId,
  ...options
}: GetDaemonJobOptions & {
  agentKind?: string | undefined
  agentSessionId?: string | undefined
}) {
  if (agentKind === undefined || agentSessionId === undefined) return
  await markDaemonJobReported({
    ...options,
    agentKind,
    agentSessionId,
  })
}

function assertAgentRecipientPair(agentKind: string | undefined, agentSessionId: string | undefined) {
  if ((agentKind === undefined) !== (agentSessionId === undefined)) {
    throw daemonClientError(
      'agent_recipient_incomplete',
      'agentKind and agentSessionId must be provided together.',
      false
    )
  }
  if (agentKind !== undefined && agentKind.trim() === '') {
    throw daemonClientError('agent_kind_invalid', 'agentKind must be a non-empty string.', false)
  }
  if (agentSessionId !== undefined && agentSessionId.trim() === '') {
    throw daemonClientError('agent_session_id_invalid', 'agentSessionId must be a non-empty string.', false)
  }
}

function userHandoverAction(job: DaemonJob) {
  const blocker = jsonRecord(job.blocker_json)
  const browser = jsonRecord(blocker.browser)
  const windowOpen = browser.windowOpen !== false
  return {
    message: windowOpen
      ? 'Your help is needed: complete provider sign-in or verification in the visible browser. Tokenless will preserve this job and continue afterward.'
      : 'Your help is needed, but no browser window is open. Resume this same job in headed mode; do not create a replacement job.',
    resumeCommand: windowOpen ? jobIdStateCommand(job) : jobIdHeadedResumeCommand(job),
    queryGuidance: windowOpen
      ? 'After completing sign-in or verification, query this same job; Tokenless will continue from its saved checkpoint.'
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
    const serverError = daemonServerErrorFromBody(responseBody)
    throw daemonClientError(
      serverError?.code ?? 'daemon_request_failed',
      serverError?.message ?? `Tokenless daemon request failed with HTTP ${response.status}.`,
      serverError?.retryable ?? response.status >= 500,
      response.status,
      serverError?.details
    )
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

function daemonServerErrorFromBody(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const envelope = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown }
  if (
    typeof envelope.code === 'string' &&
    envelope.code.trim() &&
    typeof envelope.message === 'string' &&
    envelope.message.trim() &&
    typeof envelope.retryable === 'boolean'
  ) {
    return {
      code: envelope.code,
      message: envelope.message,
      retryable: envelope.retryable,
      details: envelope.details,
    }
  }
  return null
}

function daemonClientError(code: string, message: string, retryable: boolean, status?: number, details?: unknown) {
  const error = new Error(message) as DaemonError
  error.code = code
  error.retryable = retryable
  if (status !== undefined) error.status = status
  if (details !== undefined) error.details = details
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

function assertDaemonRequestSize(value: unknown) {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw daemonClientError('invalid_daemon_request', 'Tokenless request must be JSON serializable.', false)
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > MAX_DAEMON_REQUEST_BYTES) {
    throw daemonClientError(
      'daemon_request_too_large',
      `Tokenless request is ${bytes} bytes; keep it below ${MAX_DAEMON_REQUEST_BYTES} bytes. Attach fewer or smaller files.`,
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

async function authenticatedDaemonAccess({
  daemonUrl: explicitDaemonUrl,
  homeDir = tokenlessHome(),
  requestTimeoutMs,
}: DaemonClientOptions) {
  const token = await readDaemonToken({ homeDir })
  const { ensureDaemonReady, probeDaemonReady } = await import('./runtime.js')
  const timeoutMs = Math.min(normalizedTimeoutMs(requestTimeoutMs), 1_000)
  let lastReady: Awaited<ReturnType<typeof probeDaemonReady>> | null = null
  for (const candidateUrl of await daemonEndpointCandidates({ explicitDaemonUrl, homeDir })) {
    const ready = await probeDaemonReady({
      daemonUrl: candidateUrl,
      homeDir,
      daemonToken: token,
      timeoutMs,
    })
    lastReady = ready
    if (ready.ok) return { token, daemonUrl: ready.url }
    if (
      ready.identityVerified === true &&
      ready.sameHomeVerified === true &&
      (ready.code === 'daemon_version_mismatch' || ready.code === 'daemon_control_api_revision_mismatch')
    ) {
      const replacement = await ensureDaemonReady({
        homeDir,
        daemonUrl: ready.url,
        timeoutMs: Math.max(10_000, normalizedTimeoutMs(requestTimeoutMs)),
      })
      return {
        token: await readDaemonToken({ homeDir }),
        daemonUrl: replacement.url,
      }
    }
  }
  const failedReady = lastReady && !lastReady.ok ? lastReady : null
  throw daemonClientError(
    failedReady?.code ?? 'daemon_identity_unverified',
    failedReady?.message ?? 'Tokenless daemon identity could not be verified; refusing to send its control token.',
    failedReady?.code === 'daemon_unavailable'
  )
}

async function daemonEndpointCandidates({
  explicitDaemonUrl,
  homeDir,
}: {
  explicitDaemonUrl?: string | undefined
  homeDir: string
}) {
  const preferredUrl = daemonUrl(explicitDaemonUrl)
  const urls: string[] = []
  const state = await DaemonRuntimeState.openIfExists(homeDir)
  try {
    const endpoint = state?.endpoint()
    if (endpoint?.origin) urls.push(endpoint.origin)
  } finally {
    state?.close()
  }
  urls.push(preferredUrl)
  return [...new Set(urls)]
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
