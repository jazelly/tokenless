import { daemonErrorBody, toDaemonError } from './errors.js'
import { JobStore, publicView, withClaimToken } from './job-store.js'
import { claimRecoveryError, tokenlessError } from '../playwright/errors.js'
import type { Job } from './job-store.js'
import type {
  DaemonClaimedJob,
  DaemonJob,
  ManagedDaemonClient,
} from '../playwright/daemon-client.js'

export function createInProcessDaemonClient(store: JobStore): ManagedDaemonClient {
  return {
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
  }
}

type ClaimLifecycleDaemonJobOptions = Parameters<ManagedDaemonClient['markJobRunning']>[0]
type WaitingForUserDaemonJobOptions = Parameters<ManagedDaemonClient['markJobWaitingForUser']>[0]
type CheckpointDaemonJobOptions = Parameters<ManagedDaemonClient['checkpointJob']>[0]
type ParkDaemonJobOptions = Parameters<ManagedDaemonClient['parkJob']>[0]
type CompleteDaemonJobOptions = Parameters<ManagedDaemonClient['completeJob']>[0]

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

function completeRequest<T>(options: CompleteDaemonJobOptions, operation: () => T): Promise<T> {
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
