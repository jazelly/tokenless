import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { tokenlessHome } from '../bootstrap/home.js'
import { readTokenlessConfig } from '#tokenless-server/persistence/config.js'

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

export type AgentRunClientOptions = DaemonClientOptions & {
  runId?: string | undefined
  body?: Record<string, unknown> | undefined
}

export type DaemonJobStatus = 'queued' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'canceled'

export type DaemonJob = {
  job_id: string
  profile_id: string
  provider: string
  status: DaemonJobStatus
  request_json: unknown
  result_json: unknown | null
  error_json: unknown | null
  blocker_json: unknown | null
  provider_submitted_at: string | null
  created_at: string
  updated_at: string
}

export type CreateDaemonJobOptions = DaemonClientOptions & {
  provider: string
  requestJson?: unknown
  profileId: string
  jobId?: string | undefined
}

export type GetDaemonJobOptions = DaemonClientOptions & {
  jobId: string
}

export type ListDaemonJobsOptions = DaemonClientOptions & {
  status?: string | undefined
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

export type ProviderCapacityProjection = {
  schema: 'tokenless.provider-capacity-projection.v1'
  catalogVersion: number
  catalogRevision: string
  provider: string
  profileId: string
  evaluatedAt: string
  subscription: Record<string, unknown>
  decision: 'admit' | 'defer' | 'unknown'
  reason: string
  rules: readonly Record<string, unknown>[]
}

export type CancelDaemonJobOptions = GetDaemonJobOptions & {
  reason?: unknown
}

export type WaitDaemonJobResultOptions = GetDaemonJobOptions & {
  timeoutMs?: number | undefined
  pollMs?: number | undefined
  heartbeatMs?: number | undefined
  onStatus?: ((event: Record<string, unknown>) => unknown) | undefined
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

export type IssueFeatureBenchChannelOptions = DaemonClientOptions & {
  instanceId: string
  benchmarkRunId: string
  benchmarkCommit: string
  datasetRevision: string
  provider: string
  profile?: string | undefined
  executionMode: 'browser' | 'direct'
  model: string
  effort?: string | undefined
  maxTurns: number
  expiresInMs?: number | undefined
  providerTurnTimeoutMs?: number | undefined
}

export type GenerateImageOptions = DaemonClientOptions & {
  model: string
  prompt: string
  executionMode: 'browser' | 'direct'
  profile?: string | undefined
  taskId?: string | undefined
  pageRef?: string | undefined
  browserVisibility?: 'auto' | 'headed' | 'headless' | undefined
  timeoutMs?: number | undefined
  size?: '768x768' | undefined
  referenceImage?: string | undefined
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
  jobId?: string | undefined
  semanticManifestOutput?: string | undefined
  browserExecutablePath?: string | undefined
  open?: boolean | undefined
}

export type OpenDashboardResponse = {
  url: string
  opened: null | { url: string, reused: boolean }
}

export type MenuBarConversation = {
  jobId: string
  title: string
  provider: string
  providers: string[]
  status: DaemonJobStatus
  updatedAt: string
  profileId: string | null
  profileSlug: string | null
}

export type MenuBarSnapshot = {
  schema: 'tokenless.menu-bar-snapshot.v1'
  generatedAt: string
  daemon: {
    status: 'running'
    version: string
    origin: string
    pid: number
  }
  runtime: BrowserRuntimeStatus
  activeJobCount: number
  dashboardUrl: string
  conversations: MenuBarConversation[]
}

export type ControlProfile = {
  slug: string
  directory: string
  runtimeBinding?: {
    runtimeId: string
    family: string
    browserId: string
    executablePath?: string
    createdWithVersion: string
    profileFormat: 1
  } | undefined
  lastObservedAuth: Record<string, any>
}

export type ControlState = {
  config: Record<string, any> & { profiles: Record<string, any> }
  profiles: ControlProfile[]
  defaultProfile: string | null
  profileRegistryPath: string
  runtime: BrowserRuntimeStatus
  outputSavings: Record<string, any>
}

export type ResolveControlProfileResponse = {
  profile: ControlProfile
  defaultProfile: string | null
  config: Record<string, any> & { profiles: Record<string, any> }
}

export type ControlProfileRemoval = { slug: string; removed: true }

type DaemonError = Error & {
  code?: string
  retryable?: boolean
  status?: number
  details?: unknown
}

export function daemonUrl(explicitUrl?: string) {
  const value = explicitUrl === undefined ? DEFAULT_DAEMON_URL : explicitUrl
  const normalized = value.replace(/\/+$/, '')
  validateDaemonUrl(normalized)
  return normalized
}

export async function resolveDaemonUrl({
  explicitUrl,
  homeDir = tokenlessHome(),
}: {
  explicitUrl?: string | undefined
  homeDir?: string | undefined
} = {}) {
  const configuredUrl = explicitUrl === undefined
    ? (await readTokenlessConfig(homeDir)).daemonUrl
    : explicitUrl
  return daemonUrl(configuredUrl ?? undefined)
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

export async function startAgentRun(options: AgentRunClientOptions) {
  return agentRunRequest(options, '/v1/private/agent/runs', 'POST')
}

export async function readAgentRun(options: AgentRunClientOptions & { runId: string }) {
  return agentRunRequest(options, `/v1/private/agent/runs/${encodeURIComponent(options.runId)}`, 'GET')
}

export async function resumeAgentRun(options: AgentRunClientOptions & { runId: string }) {
  return agentRunRequest(options, `/v1/private/agent/runs/${encodeURIComponent(options.runId)}/resume`, 'POST')
}

export async function cancelAgentRun(options: AgentRunClientOptions & { runId: string }) {
  return agentRunRequest({ ...options, body: {} }, `/v1/private/agent/runs/${encodeURIComponent(options.runId)}/cancel`, 'POST')
}

async function agentRunRequest(options: AgentRunClientOptions, requestPath: string, method: 'GET' | 'POST') {
  const daemon = await authenticatedDaemonAccess({
    daemonUrl: options.daemonUrl,
    homeDir: options.homeDir,
    requestTimeoutMs: options.requestTimeoutMs,
  })
  return daemonRequest<Record<string, unknown>>({
    daemonUrl: daemon.daemonUrl,
    method,
    path: requestPath,
    ...(method === 'POST' ? { body: options.body ?? {} } : {}),
    token: daemon.token,
    timeoutMs: options.requestTimeoutMs,
    signal: options.signal,
  })
}

export async function createDaemonJob({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  provider,
  requestJson = {},
  profileId,
  jobId,
}: CreateDaemonJobOptions) {
  assertDaemonRequestSize({
    provider,
    request_json: requestJson,
  })
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<DaemonJob>({
    daemonUrl: daemon.daemonUrl,
    path: '/v1/private/jobs',
    body: {
      provider,
      request_json: requestJson,
      profile_id: profileId,
      job_id: jobId,
    },
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
}

export async function generateImage({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  model,
  prompt,
  executionMode,
  profile,
  taskId,
  pageRef,
  browserVisibility,
  timeoutMs,
  size,
  referenceImage,
}: GenerateImageOptions) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<{
    created: number
    data: readonly { url: string; asset: Record<string, unknown> }[]
    tokenless: {
      provider: string
      execution_mode: 'browser' | 'direct'
      request_id: string
      task_id: string
      job_id: string | null
      capability_route: unknown
    }
  }>({
    daemonUrl: daemon.daemonUrl,
    path: '/v1/images/generations',
    body: {
      model,
      prompt,
      reference_image: referenceImage,
      size,
      tokenless: {
        execution_mode: executionMode,
        profile,
        task_id: taskId,
        page_ref: pageRef,
        browser_visibility: browserVisibility,
        timeout_ms: timeoutMs,
      },
    },
    token: daemon.token,
    timeoutMs: requestTimeoutMs ?? (timeoutMs === undefined ? 605_000 : timeoutMs + 5_000),
    signal,
  })
}

export async function issueFeatureBenchChannel({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  instanceId,
  benchmarkRunId,
  benchmarkCommit,
  datasetRevision,
  provider,
  profile,
  executionMode,
  model,
  effort,
  maxTurns,
  expiresInMs,
  providerTurnTimeoutMs,
}: IssueFeatureBenchChannelOptions) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  return daemonRequest<{
    protocol: 'tokenless.featurebench-channel.v1'
    channelId: string
    token: string
    bridgePort: number
    instanceId: string
    benchmarkCommit: string
    datasetRevision: string
    provider: string
    profileId: string
    model: string
    executionMode: 'browser' | 'direct'
    maxTurns: number
    providerTurnTimeoutMs: number
    expiresAt: string
  }>({
    daemonUrl: daemon.daemonUrl,
    path: '/v1/private/featurebench/channels',
    body: {
      instanceId,
      benchmarkRunId,
      benchmarkCommit,
      datasetRevision,
      provider,
      profile,
      executionMode,
      model,
      effort,
      maxTurns,
      expiresInMs,
      providerTurnTimeoutMs,
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
  profileId,
  provider,
  taskId,
  limit = 100,
}: ListDaemonJobsOptions = {}) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  const query = new URLSearchParams()
  if (status) query.set('status', status)
  if (profileId) query.set('profile_id', profileId)
  if (provider) query.set('provider', provider)
  if (taskId) query.set('task_id', taskId)
  query.set('limit', String(Math.max(1, Math.min(1000, Number(limit) || 100))))
  return daemonRequest<DaemonJob[]>({
    daemonUrl: daemon.daemonUrl,
    method: 'GET',
    path: `/v1/private/jobs?${query.toString()}`,
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
    path: `/v1/private/jobs/${encodeURIComponent(jobId)}`,
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
    path: `/v1/private/provider-capacity?${query.toString()}`,
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
    path: `/v1/private/provider-mappings/resolve?${query.toString()}`,
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
    } | null
  }>({
    daemonUrl: daemon.daemonUrl,
    method: 'GET',
    path: `/v1/private/provider-conversations/resolve?${query.toString()}`,
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
    path: `/v1/private/jobs/${encodeURIComponent(jobId)}/cancel`,
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
    path: '/v1/private/control/shutdown',
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
    path: '/v1/private/control/browser-runtime/status',
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
    path: '/v1/private/control/browser-runtime/quiesce',
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
    path: '/v1/private/control/browser-runtime/open-profile',
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
    path: '/v1/private/control/browser-runtime/open-provider-tabs',
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
  jobId,
  semanticManifestOutput,
  browserExecutablePath,
  open = true,
}: OpenDashboardOptions = {}) {
  const daemon = await authenticatedDaemonAccess({ daemonUrl: explicitDaemonUrl, homeDir, requestTimeoutMs })
  const dashboard = await daemonRequest<OpenDashboardResponse>({
    daemonUrl: daemon.daemonUrl,
    path: '/v1/private/control/dashboard',
    body: {
      ...(profileId ? { profile_id: profileId } : {}),
      ...(jobId ? { job_id: jobId } : {}),
      ...(semanticManifestOutput ? { semantic_manifest_output: semanticManifestOutput } : {}),
    },
    token: daemon.token,
    timeoutMs: requestTimeoutMs,
    signal,
  })
  if (!open) return { ...dashboard, opened: null }
  await openUrlInBrowser(dashboard.url, browserExecutablePath)
  return {
    ...dashboard,
    opened: { url: dashboard.url, reused: false },
  }
}

async function openUrlInBrowser(url: string, browserExecutablePath?: string) {
  if (browserExecutablePath) {
    await spawnDetached(browserExecutablePath, [url])
    return
  }
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]] as const
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', url]] as const
      : ['xdg-open', [url]] as const
  await spawnDetached(command, args)
}

async function spawnDetached(command: string, args: readonly string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function getMenuBarSnapshot(options: DaemonClientOptions = {}) {
  return controlRequest<MenuBarSnapshot>(options, '/v1/private/control/menu-bar', 'GET')
}

export async function getControlState(options: DaemonClientOptions = {}) {
  return controlRequest<ControlState>(options, '/v1/private/control/state', 'GET')
}

export async function getControlCapabilities(options: DaemonClientOptions = {}) {
  return controlRequest<{
    schema: string
    capabilities: Array<Record<string, any> & { id: string; lifecycle: string; routes: any[] }>
  }>(options, '/v1/private/control/capabilities', 'GET')
}

export async function resolveControlExecution(options: DaemonClientOptions & {
  profile?: string | undefined
  provider?: string | undefined
  requirements: readonly string[]
  executionMode: 'browser' | 'direct'
}) {
  return controlRequest<{
    ok: boolean
    profile?: ControlProfile
    routes?: any[]
    code?: string
    message?: string
    context?: Record<string, any>
  }>(
    options,
    '/v1/private/control/execution-route',
    'POST',
    {
      profile: options.profile,
      provider: options.provider,
      requirements: [...options.requirements],
      execution_mode: options.executionMode,
    },
  )
}

export async function resolveControlProfile(options: DaemonClientOptions & { profile?: string | undefined }) {
  const query = new URLSearchParams()
  if (options.profile !== undefined) query.set('profile', options.profile)
  return controlRequest<ResolveControlProfileResponse>(
    options,
    `/v1/private/control/profiles/resolve${query.size > 0 ? `?${query.toString()}` : ''}`,
    'GET',
  )
}

export async function addControlProfile(options: DaemonClientOptions & {
  profile: string
  setDefault?: boolean | undefined
  browser?: string | null | undefined
  providerWhitelist?: string[] | undefined
}) {
  return controlRequest<{ profile: ControlProfile; defaultProfile: string | null }>(
    options,
    '/v1/private/control/profiles',
    'POST',
    {
      slug: options.profile,
      set_default: options.setDefault,
      browser: options.browser,
      provider_whitelist: options.providerWhitelist,
    },
  )
}

export async function clearControlProfiles(options: DaemonClientOptions & {
  profile?: string | undefined
  all?: boolean | undefined
}) {
  return controlRequest<{ cleared: ControlProfileRemoval[]; defaultProfile: string | null }>(
    options,
    '/v1/private/control/profiles/clear',
    'POST',
    { profile: options.profile, all: options.all },
  )
}

export async function setDefaultControlProfile(options: DaemonClientOptions & { profile: string }) {
  return controlRequest<{ profile: ControlProfile; defaultProfile: string }>(
    options,
    `/v1/private/control/profiles/${encodeURIComponent(options.profile)}/default`,
    'POST',
    {},
  )
}

export async function removeControlProfile(options: DaemonClientOptions & { profile: string }) {
  return controlRequest<{ profile: ControlProfileRemoval; defaultProfile: string | null }>(
    options,
    `/v1/private/control/profiles/${encodeURIComponent(options.profile)}`,
    'DELETE',
  )
}

export async function updateControlProfileConfig(options: DaemonClientOptions & {
  profile: string
  config: Record<string, unknown>
}) {
  return controlRequest<{ config: Record<string, any>; profile: Record<string, any> }>(
    options,
    `/v1/private/control/profiles/${encodeURIComponent(options.profile)}/config`,
    'PATCH',
    options.config,
  )
}

export async function updateControlProfileObservation(options: DaemonClientOptions & {
  profile: string
  observation: Record<string, unknown>
}) {
  return controlRequest<{ profile: ControlProfile; defaultProfile: string | null }>(
    options,
    `/v1/private/control/profiles/${encodeURIComponent(options.profile)}/observation`,
    'POST',
    options.observation,
  )
}

export async function updateControlConfig(options: DaemonClientOptions & {
  config: Record<string, unknown>
}) {
  return controlRequest<Record<string, any> & { profiles: Record<string, any> }>(
    options,
    '/v1/private/control/config',
    'PATCH',
    options.config,
  )
}

export async function updateOutputSavings(options: DaemonClientOptions & {
  action: 'status' | 'enable' | 'disable' | 'uninstall' | 'clear'
}) {
  if (options.action === 'status') {
    return controlRequest<Record<string, any>>(
      options,
      '/v1/private/control/output-savings',
      'GET',
    )
  }
  return controlRequest<Record<string, any>>(
    options,
    `/v1/private/control/output-savings/${options.action}`,
    'POST',
    options.action === 'uninstall' || options.action === 'clear'
      ? { confirmDelete: true }
      : {},
  )
}

async function controlRequest<T>(
  options: DaemonClientOptions,
  requestPath: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: Record<string, unknown>,
) {
  const daemon = await authenticatedDaemonAccess(options)
  try {
    return await daemonRequest<T>({
      daemonUrl: daemon.daemonUrl,
      method,
      path: requestPath,
      ...(body === undefined ? {} : { body }),
      token: daemon.token,
      timeoutMs: options.requestTimeoutMs,
      signal: options.signal,
    })
  } catch (error) {
    preservePreHttpControlErrorShape(error)
    throw error
  }
}

function preservePreHttpControlErrorShape(error: unknown) {
  if (!error || typeof error !== 'object') return
  const controlError = error as DaemonError
  const code = controlError.code
  if (!code || isControlTransportErrorCode(code)) return
  delete controlError.status
}

function isControlTransportErrorCode(code: string) {
  return code.startsWith('daemon_') ||
    code === 'control_auth_missing' ||
    code === 'control_auth_rejected' ||
    code === 'invalid_input' ||
    code === 'non_loopback_bind'
}

export async function waitDaemonJobResult({
  daemonUrl: explicitDaemonUrl,
  homeDir,
  requestTimeoutMs,
  signal,
  jobId,
  timeoutMs,
  pollMs = 250,
  heartbeatMs = 30000,
  onStatus,
}: WaitDaemonJobResultOptions) {
  const startedAt = Date.now()
  let lastStatus: string | undefined
  let lastHeartbeatAt = startedAt
  while (timeoutMs === undefined || Date.now() - startedAt < timeoutMs) {
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
        elapsedMs,
      })
    } else if (heartbeatMs > 0 && Date.now() - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = Date.now()
      await onStatus?.({
        event: 'daemon_waiting',
        status: job.status,
        jobId,
        provider: job.provider,
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
    if (job.status === 'failed' || job.status === 'canceled') {
      return {
        ok: false,
        status: job.status,
        job,
        error: job.error_json ?? {
          code: job.status === 'canceled' ? 'job_canceled' : 'daemon_job_failed',
          message: `Daemon job ended with status ${job.status}.`,
          retryable: false,
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
      ? 'Your help is needed: complete provider sign-in or verification in the visible browser. The current daemon execution will continue afterward.'
      : 'Your help is needed, but no browser window is open. This execution cannot continue without a visible browser.',
    queryGuidance: 'The current daemon execution will continue while it remains alive; a daemon restart fails the job.',
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
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
  if (parsed.port === '0') {
    throw daemonClientError('invalid_daemon_url', 'Tokenless daemon URL must use a positive TCP port.', false)
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
  const { ensureDaemonReady, probeDaemonReady } = await import('../bootstrap/runtime.js')
  const timeoutMs = Math.min(normalizedTimeoutMs(requestTimeoutMs), 1_000)
  let lastReady: Awaited<ReturnType<typeof probeDaemonReady>> | null = null
  const candidateUrl = await resolveDaemonUrl({ explicitUrl: explicitDaemonUrl, homeDir })
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
  const failedReady = lastReady && !lastReady.ok ? lastReady : null
  throw daemonClientError(
    failedReady?.code ?? 'daemon_identity_unverified',
    failedReady?.message ?? 'Tokenless daemon identity could not be verified; refusing to send its control token.',
    failedReady?.code === 'daemon_unavailable'
  )
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
