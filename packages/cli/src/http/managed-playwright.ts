import {
  createManagedPlaywrightJobRequest,
  validateManagedPlaywrightJobRequest,
} from '#tokenless-server/browser/job-contract.js'
import {
  cancelDaemonJob,
  createDaemonJob,
  getDaemonJob,
  listDaemonJobs,
} from './daemon-client.js'
import { tokenlessError } from '#tokenless-server/browser/errors.js'
import type { DaemonJob, DaemonJobStatus } from './daemon-client.js'
import type { CreateManagedPlaywrightJobRequestInput, ManagedPlaywrightJobRequest } from '#tokenless-server/browser/job-contract.js'
import type { ProviderId } from '#tokenless-server/providers/registry.js'

export type ManagedPlaywrightJobApiOptions = {
  daemonUrl?: string | undefined
  homeDir?: string | undefined
  requestTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export type SubmitManagedPlaywrightJobOptions = ManagedPlaywrightJobApiOptions & {
  profileId: string
  request: ManagedPlaywrightJobRequest | CreateManagedPlaywrightJobRequestInput
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

export async function submitManagedPlaywrightJob(options: SubmitManagedPlaywrightJobOptions) {
  const normalized = normalizeJobRequest(options.request)
  const request = options.upstreamState === undefined
    ? normalized
    : validateManagedPlaywrightJobRequest({
        ...normalized,
        context: {
          ...normalized.context,
          upstream: {
            agentKind: null,
            sessionId: null,
            state: options.upstreamState ?? null,
          },
        },
      })
  return createDaemonJob({
    ...daemonOptions(options),
    provider: request.provider,
    requestJson: request,
    profileId: options.profileId,
    jobId: options.jobId,
  })
}

export async function listManagedPlaywrightJobs(options: ListManagedPlaywrightJobsOptions = {}) {
  return listDaemonJobs({
    ...daemonOptions(options),
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
  if (job.profile_id !== profileId) {
    throw tokenlessError('invalid_playwright_job_profile', 'Managed Playwright job lookup returned a job for a different profile.')
  }
  validateManagedPlaywrightJobRequest(job.request_json)
}
