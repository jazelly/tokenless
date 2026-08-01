import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  PLAYWRIGHT_EXECUTION_BACKEND,
  createManagedPlaywrightJobRequest,
  validateManagedPlaywrightJobRequest,
} from './job-contract.js'
import {
  cancelDaemonJob,
  createDaemonJob,
  getDaemonJob,
  listDaemonJobs,
  resumeDaemonJob,
} from '../daemon-client.js'
import { tokenlessError } from './errors.js'
import type { DaemonJob, DaemonJobStatus } from '../daemon-client.js'
import type { CreateManagedPlaywrightJobRequestInput, ManagedPlaywrightJobRequest } from './job-contract.js'
import type { ProviderId } from '../providers/registry.js'

export type ManagedPlaywrightJobApiOptions = {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  requestTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export type SubmitManagedPlaywrightJobOptions = ManagedPlaywrightJobApiOptions & {
  profileId: string
  request: ManagedPlaywrightJobRequest | CreateManagedPlaywrightJobRequestInput
  agentKind?: string | undefined
  agentSessionId?: string | undefined
  upstreamState?: Readonly<Record<string, unknown>> | undefined
  jobId?: string | undefined
}

export type ListManagedPlaywrightJobsOptions = ManagedPlaywrightJobApiOptions & {
  profileId?: string | undefined
  provider?: ProviderId | undefined
  status?: DaemonJobStatus | undefined
  taskId?: string | undefined
  limit?: number | undefined
}

export type GetManagedPlaywrightJobOptions = ManagedPlaywrightJobApiOptions & {
  jobId: string
  profileId: string
}

export type CancelManagedPlaywrightJobOptions = GetManagedPlaywrightJobOptions & {
  reason?: unknown
}

export type ResumeManagedPlaywrightJobOptions = GetManagedPlaywrightJobOptions

export async function submitManagedPlaywrightJob(options: SubmitManagedPlaywrightJobOptions) {
  const normalized = normalizeJobRequest(options.request)
  const request = options.agentKind === undefined && options.agentSessionId === undefined && options.upstreamState === undefined
    ? normalized
    : validateManagedPlaywrightJobRequest({
        ...normalized,
        context: {
          ...normalized.context,
          upstream: {
            agentKind: options.agentKind ?? null,
            sessionId: options.agentSessionId ?? null,
            state: options.upstreamState ?? null,
          },
        },
      })
  return createDaemonJob({
    ...daemonOptions(options),
    provider: request.provider,
    action: MANAGED_PLAYWRIGHT_JOB_ACTION,
    requestJson: request,
    executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
    profileId: options.profileId,
    agentKind: options.agentKind,
    agentSessionId: options.agentSessionId,
    jobId: options.jobId,
  })
}

export async function listManagedPlaywrightJobs(options: ListManagedPlaywrightJobsOptions = {}) {
  return listDaemonJobs({
    ...daemonOptions(options),
    executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
    profileId: options.profileId,
    provider: options.provider,
    status: options.status,
    taskId: options.taskId,
    limit: options.limit,
  })
}

export async function getManagedPlaywrightJob(options: GetManagedPlaywrightJobOptions): Promise<DaemonJob> {
  const job = await getDaemonJob({
    ...daemonOptions(options),
    jobId: options.jobId,
  })
  validateManagedDaemonJob(job, options.profileId)
  return job
}

export async function cancelManagedPlaywrightJob(options: CancelManagedPlaywrightJobOptions): Promise<DaemonJob> {
  await getManagedPlaywrightJob(options)
  return cancelDaemonJob({
    ...daemonOptions(options),
    jobId: options.jobId,
    reason: options.reason,
  })
}

export async function resumeManagedPlaywrightJob(options: ResumeManagedPlaywrightJobOptions): Promise<DaemonJob> {
  await getManagedPlaywrightJob(options)
  const job = await resumeDaemonJob({
    ...daemonOptions(options),
    jobId: options.jobId,
    browserVisibility: 'headed',
  })
  validateManagedDaemonJob(job, options.profileId)
  return job
}

function normalizeJobRequest(
  request: ManagedPlaywrightJobRequest | CreateManagedPlaywrightJobRequestInput
): ManagedPlaywrightJobRequest {
  if (request && typeof request === 'object' && 'protocol' in request) {
    return validateManagedPlaywrightJobRequest(request)
  }
  return createManagedPlaywrightJobRequest(request)
}

function daemonOptions(options: ManagedPlaywrightJobApiOptions) {
  return {
    daemonUrl: options.daemonUrl,
    homeDir: options.homeDir,
    requestTimeoutMs: options.requestTimeoutMs,
    signal: options.signal,
  }
}

function validateManagedDaemonJob(job: DaemonJob, profileId: string) {
  if (job.execution_backend !== PLAYWRIGHT_EXECUTION_BACKEND) {
    throw tokenlessError('invalid_playwright_job_backend', 'Managed Playwright job lookup returned a non-Playwright job.')
  }
  if (job.profile_id !== profileId) {
    throw tokenlessError('invalid_playwright_job_profile', 'Managed Playwright job lookup returned a job for a different profile.')
  }
  if (job.action !== MANAGED_PLAYWRIGHT_JOB_ACTION) {
    throw tokenlessError('invalid_playwright_job_action', 'Managed Playwright job lookup returned an unsupported action.')
  }
  validateManagedPlaywrightJobRequest(job.request_json)
}
