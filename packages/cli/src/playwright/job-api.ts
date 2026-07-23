import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  PLAYWRIGHT_EXECUTION_BACKEND,
  createManagedPlaywrightJobRequest,
  validateManagedPlaywrightJobRequest,
} from './job-contract.js'
import { createDaemonClient } from './daemon-client.js'
import { tokenlessError } from './errors.js'
import type { DaemonJob, DaemonJobStatus, ManagedDaemonClient } from './daemon-client.js'
import type { CreateManagedPlaywrightJobRequestInput, ManagedPlaywrightJobRequest } from './job-contract.js'
import type { ProviderId } from './providers.js'

export type ManagedPlaywrightJobApiOptions = {
  daemonClient?: ManagedDaemonClient | undefined
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  token?: string | undefined
  fetchImpl?: typeof fetch | undefined
  requestTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export type SubmitManagedPlaywrightJobOptions = ManagedPlaywrightJobApiOptions & {
  profileId: string
  request: ManagedPlaywrightJobRequest | CreateManagedPlaywrightJobRequestInput
  jobId?: string | undefined
  claimToken?: string | undefined
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
  const request = normalizeJobRequest(options.request)
  return daemonClient(options).createJob({
    ...daemonOptions(options),
    provider: request.provider,
    action: MANAGED_PLAYWRIGHT_JOB_ACTION,
    requestJson: request,
    executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
    profileId: options.profileId,
    jobId: options.jobId,
    claimToken: options.claimToken,
  })
}

export async function listManagedPlaywrightJobs(options: ListManagedPlaywrightJobsOptions = {}) {
  return daemonClient(options).listJobs({
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
  const job = await daemonClient(options).getJob({
    ...daemonOptions(options),
    jobId: options.jobId,
  })
  validateManagedDaemonJob(job, options.profileId)
  return job
}

export async function cancelManagedPlaywrightJob(options: CancelManagedPlaywrightJobOptions): Promise<DaemonJob> {
  await getManagedPlaywrightJob(options)
  return daemonClient(options).cancelJob({
    ...daemonOptions(options),
    jobId: options.jobId,
    reason: options.reason,
  })
}

export async function resumeManagedPlaywrightJob(options: ResumeManagedPlaywrightJobOptions): Promise<DaemonJob> {
  await getManagedPlaywrightJob(options)
  const job = await daemonClient(options).resumeJob({
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

function daemonClient(options: ManagedPlaywrightJobApiOptions) {
  return options.daemonClient ?? createDaemonClient(daemonOptions(options))
}

function daemonOptions(options: ManagedPlaywrightJobApiOptions) {
  return {
    daemonUrl: options.daemonUrl,
    homeDir: options.homeDir,
    token: options.token,
    fetchImpl: options.fetchImpl,
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
