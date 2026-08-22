import { daemonErrorBody, toDaemonError } from '../errors.js'
import { JobStore, publicView } from '../jobs/store.js'
import { tokenlessError } from '../browser/errors.js'
import type { Job } from '../jobs/store.js'
import type { DaemonJob, ManagedDaemonClient } from '../browser/daemon-client.js'
import {
  dropEphemeralProviderBundle,
  hydrateEphemeralProviderJob,
  redactEphemeralProviderResult,
} from './ephemeral-provider-payloads.js'

export function createInProcessDaemonClient(store: JobStore): ManagedDaemonClient {
  return {
    getJob: (options) => inProcessDaemonRequest(options.signal, () => publicView(store.getJob(options.jobId))),
    takeNextJob: (options) => inProcessDaemonRequest(options.signal, () => {
      const job = store.takeNextJob(
        {
          provider: options.provider,
          action: options.action,
          job_id_prefix: options.jobIdPrefix,
        },
        options.executionBackend,
        options.profileId ?? null,
      )
      return { job: job ? jobView(job) : null }
    }),
    projectJobProviderCapacity: (options) => inProcessDaemonRequest(options.signal, () => store.projectJobProviderCapacity(
      options.jobId,
      {
        access_class: options.accessClass,
        tier_label: options.tierLabel,
        subscription_label: options.subscriptionLabel,
      },
    )),
    recordProviderSubmission: (options) => inProcessDaemonRequest(options.signal, () => publicView(
      store.recordProviderSubmission(options.jobId),
    )),
    markJobWaitingForUser: (options) => inProcessDaemonRequest(options.signal, () => publicView(
      store.markWaitingForUser(options.jobId, options.blocker),
    )),
    markJobRunning: (options) => inProcessDaemonRequest(options.signal, () => publicView(
      store.markRunning(options.jobId),
    )),
    fallbackJob: (options) => inProcessDaemonRequest(options.signal, () => publicView(store.fallbackJob({
      job_id: options.jobId,
      provider: options.provider,
      request_json: options.request,
      blocker_json: options.blocker,
    }))),
    completeJob: (options) => inProcessDaemonRequest(options.signal, () => {
      const hasResult = options.result !== undefined && options.result !== null
      const hasError = options.error !== undefined && options.error !== null
      if (hasResult === hasError) {
        throw tokenlessError('invalid_daemon_completion', 'Pass exactly one of result or error when completing a daemon job.')
      }
      const completed = store.completeJob(
        options.jobId,
        hasResult
          ? { result_json: redactEphemeralProviderResult(options.jobId, options.result) }
          : { error_json: options.error },
      )
      dropEphemeralProviderBundle(options.jobId)
      return publicView(completed)
    }),
    upsertProviderProject: (options) => inProcessDaemonRequest(options.signal, () => store.upsertProviderProject({
      provider: options.provider,
      profile_id: options.profileId,
      resource_id: options.resourceId,
      name: options.name,
      canonical_url: options.canonicalUrl,
      visible_proof: options.visibleProof,
      job_id: options.jobId,
      created: options.created,
    })),
    upsertProviderConversation: (options) => inProcessDaemonRequest(options.signal, () => store.upsertProviderConversation({
      provider: options.provider,
      profile_id: options.profileId,
      project_resource_id: options.projectResourceId,
      task_id: options.taskId,
      canonical_url: options.canonicalUrl,
      job_id: options.jobId,
    })),
    upsertProviderTaskConversation: (options) => inProcessDaemonRequest(options.signal, () => store.upsertProviderTaskConversation({
      provider: options.provider,
      profile_id: options.profileId,
      task_id: options.taskId,
      canonical_url: options.canonicalUrl,
      job_id: options.jobId,
    })),
  }
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

function jobView(job: Job): DaemonJob {
  return hydrateEphemeralProviderJob(publicView(job))
}

function daemonStoreError(error: unknown) {
  const envelope = daemonErrorBody(toDaemonError(error)).error
  const code = typeof envelope.code === 'string' ? envelope.code : 'daemon_request_failed'
  const message = typeof envelope.message === 'string' ? envelope.message : 'Tokenless daemon request failed.'
  const retryable = typeof envelope.retryable === 'boolean' ? envelope.retryable : false
  return tokenlessError(code, message, {
    retryable,
    ...(envelope.details === undefined ? {} : { details: envelope.details }),
    cause: error,
  })
}

function daemonRequestAbortedError() {
  return tokenlessError('daemon_request_timeout', 'Tokenless daemon request timed out or was aborted.', { retryable: true })
}
