import { daemonErrorBody, invalidInput, toDaemonError } from './errors.js'
import { JobStore, publicView, withClaimToken } from './job-store.js'
import { claimRecoveryError, tokenlessError } from '../playwright/errors.js'
import { listProviderInstances } from '../providers/registry.js'
import type { Job } from './job-store.js'
import type {
  CancelDaemonJobOptions,
  CheckpointDaemonJobOptions,
  ClaimLifecycleDaemonJobOptions,
  CompleteDaemonJobOptions,
  DaemonClaimedJob,
  DaemonJob,
  ManagedDaemonClient,
  ParkDaemonJobOptions,
  ResumeDaemonJobOptions,
  WaitingForUserDaemonJobOptions,
} from '../playwright/daemon-client.js'

export function createInProcessDaemonClient(store: JobStore): ManagedDaemonClient {
  return {
    ready: (options = {}) => inProcessDaemonRequest(options.signal, () => ({
      ready: true as const,
    })),
    createJob: (options) => inProcessDaemonRequest(options.signal, () => {
      if (options.executionBackend === 'playwright' && !supportedProviderSet().has(options.provider)) {
        throw invalidInput(`unsupported playwright provider: ${options.provider}`)
      }
      return claimedView(store.createJob({
        provider: options.provider,
        action: options.action,
        request_json: options.requestJson,
        execution_backend: options.executionBackend,
        profile_id: options.profileId,
        job_id: options.jobId,
        claim_token: options.claimToken,
      }))
    }),
    listJobs: (options = {}) => inProcessDaemonRequest(options.signal, () => store.listJobs({
      status: options.status,
      execution_backend: options.executionBackend,
      profile_id: options.profileId,
      provider: options.provider,
      task_id: options.taskId,
      limit: options.limit,
    }).map(publicJobView)),
    getJob: (options) => inProcessDaemonRequest(options.signal, () => publicJobView(store.getJob(options.jobId))),
    claimNextJob: (options) => inProcessClaimNextRequest(store, options.signal, () => store.claimNextJob(
        {
          provider: options.provider,
          action: options.action,
        },
        options.executionBackend,
        options.profileId ?? null
    )),
    markJobRunning: (options) => claimRequest(options, () => publicJobView(store.markRunning(options.jobId, options.claimToken))),
    markJobWaitingForUser: (options) => waitingForUserRequest(options, () => publicJobView(
      store.markWaitingForUser(options.jobId, options.claimToken, options.blocker)
    )),
    checkpointJob: (options) => checkpointRequest(options, () => publicJobView(
      store.checkpointJob(options.jobId, options.claimToken, options.checkpoint)
    )),
    parkJob: (options) => parkRequest(options, () => publicJobView(
      store.parkJob(options.jobId, options.claimToken, options.blocker, options.checkpoint)
    )),
    resumeJob: (options) => resumeRequest(options, () => publicJobView(
      store.resumeJob(options.jobId, { browser_visibility: options.browserVisibility })
    )),
    renewJobClaim: (options) => claimRequest(options, () => publicJobView(store.renewClaim(options.jobId, options.claimToken))),
    completeJob: (options) => completeRequest(options, () => {
      const hasResult = options.result !== undefined && options.result !== null
      const hasError = options.error !== undefined && options.error !== null
      if (hasResult === hasError) {
        throw tokenlessError('invalid_daemon_completion', 'Pass exactly one of result or error when completing a daemon job.')
      }
      return publicJobView(store.completeJob(
        options.jobId,
        options.claimToken,
        hasResult ? { result_json: options.result } : { error_json: options.error }
      ))
    }),
    cancelJob: (options) => cancelRequest(options, async () => publicJobView(await store.cancelJob(options.jobId, options.reason))),
  }
}

function supportedProviders() {
  return listProviderInstances()
    .filter((provider) => provider.descriptor.stage !== 'disabled')
    .map((provider) => String(provider.id))
}

function supportedProviderSet() {
  return new Set(supportedProviders())
}

function claimRequest<T>(options: ClaimLifecycleDaemonJobOptions, operation: () => T): Promise<T> {
  return inProcessDaemonRequest(options.signal, operation)
}

function waitingForUserRequest<T>(options: WaitingForUserDaemonJobOptions, operation: () => T): Promise<T> {
  return inProcessDaemonRequest(options.signal, operation)
}

function checkpointRequest<T>(options: CheckpointDaemonJobOptions, operation: () => T): Promise<T> {
  return inProcessDaemonRequest(options.signal, operation)
}

function parkRequest<T>(options: ParkDaemonJobOptions, operation: () => T): Promise<T> {
  return inProcessDaemonRequest(options.signal, operation)
}

function resumeRequest<T>(options: ResumeDaemonJobOptions, operation: () => T): Promise<T> {
  return inProcessDaemonRequest(options.signal, operation)
}

function completeRequest<T>(options: CompleteDaemonJobOptions, operation: () => T): Promise<T> {
  return inProcessDaemonRequest(options.signal, operation)
}

function cancelRequest<T>(options: CancelDaemonJobOptions, operation: () => T | Promise<T>): Promise<T> {
  return inProcessDaemonRequest(options.signal, operation)
}

async function inProcessDaemonRequest<T>(signal: AbortSignal | undefined, operation: () => T | Promise<T>): Promise<T> {
  if (signal?.aborted) throw daemonRequestAbortedError()
  try {
    const result = await operation()
    if (signal?.aborted) throw daemonRequestAbortedError()
    return result
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenlessPlaywrightError') throw error
    throw daemonStoreError(error)
  }
}

async function inProcessClaimNextRequest(
  store: JobStore,
  signal: AbortSignal | undefined,
  operation: () => Job | null
): Promise<{ job: DaemonClaimedJob | null }> {
  if (signal?.aborted) throw daemonRequestAbortedError()
  let job: Job | null = null
  try {
    job = operation()
    if (signal?.aborted) {
      if (job) {
        try {
          store.recoverActiveClaim(job.job_id, job.claim_token)
        } catch (error) {
          throw claimRecoveryError(error)
        }
      }
      throw daemonRequestAbortedError()
    }
    return { job: nullableClaimedView(job) }
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenlessPlaywrightError') throw error
    throw daemonStoreError(error)
  }
}

function nullableClaimedView(job: Job | null): DaemonClaimedJob | null {
  return job ? claimedView(job) : null
}

function publicJobView(job: Job): DaemonJob {
  return publicView(job)
}

function claimedView(job: Job): DaemonClaimedJob {
  return withClaimToken(job)
}

function daemonStoreError(error: unknown) {
  const envelope = daemonErrorBody(toDaemonError(error)).error
  const code = typeof envelope.code === 'string' ? envelope.code : 'daemon_request_failed'
  const message = typeof envelope.message === 'string' ? envelope.message : 'Tokenless daemon request failed.'
  const retryable = typeof envelope.retryable === 'boolean' ? envelope.retryable : false
  return tokenlessError(
    code,
    message,
    {
      retryable,
      ...(envelope.details === undefined ? {} : { details: envelope.details }),
      cause: error,
    }
  )
}

function daemonRequestAbortedError() {
  return tokenlessError('daemon_request_timeout', 'Tokenless daemon request timed out or was aborted.', { retryable: true })
}
