import type { JobView as DaemonJob } from '../jobs/store.js'
import type { ProviderCapacityProjection } from '../providers/rate-limit-policy.js'

export type { JobView as DaemonJob } from '../jobs/store.js'

type JobOptions = {
  jobId: string
  signal?: AbortSignal | undefined
}

export type ManagedDaemonClient = {
  takeNextJob(options: {
    profileId: string
    provider?: string | undefined
    jobIdPrefix?: string | undefined
    signal?: AbortSignal | undefined
  }): Promise<{ job: DaemonJob | null }>
  getJob(options: JobOptions): Promise<DaemonJob>
  projectJobProviderCapacity(options: JobOptions & {
    accessClass: string
    tierLabel?: string | null | undefined
    subscriptionLabel?: string | null | undefined
  }): Promise<ProviderCapacityProjection>
  recordProviderSubmission(options: JobOptions): Promise<DaemonJob>
  markJobWaitingForUser(options: JobOptions & { blocker: unknown }): Promise<DaemonJob>
  markJobRunning(options: JobOptions): Promise<DaemonJob>
  fallbackJob(options: JobOptions & {
    provider: string
    request: unknown
    blocker: unknown
  }): Promise<DaemonJob>
  completeJob(options: JobOptions & {
    result?: unknown
    error?: unknown
  }): Promise<DaemonJob>
  upsertProviderProject(options: JobOptions & {
    provider: string
    profileId: string
    resourceId: string
    name: string
    canonicalUrl: string
    visibleProof: string
    created: boolean
  }): Promise<unknown>
  upsertProviderConversation(options: JobOptions & {
    provider: string
    profileId: string
    projectResourceId: string
    taskId: string
    canonicalUrl: string
  }): Promise<unknown>
  upsertProviderTaskConversation(options: JobOptions & {
    provider: string
    profileId: string
    taskId: string
    canonicalUrl: string
  }): Promise<unknown>
}
