import type { JobView as DaemonJob, PostSubmissionFallbackProof } from '../jobs/store.js'
import type { ProviderCapacityProjection } from '../providers/rate-limit-policy.js'

export type { JobView as DaemonJob, PostSubmissionFallbackProof } from '../jobs/store.js'

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
    postSubmissionFallbackProof?: PostSubmissionFallbackProof | undefined
  }): Promise<DaemonJob>
  completeJob(options: JobOptions & {
    result?: unknown
    error?: unknown
  }): Promise<DaemonJob>
  upsertProviderProject(options: {
    provider: string
    profileId: string
    resourceId: string
    name: string
    canonicalUrl: string
    signal?: AbortSignal | undefined
  }): Promise<unknown>
  findProviderTaskConversationByUrl(profileId: string, url: string): Promise<{ provider: string; pageRef: string } | null>
  resolveProviderTaskConversation(options: {
    provider: string
    profileId: string
    taskId: string
    signal?: AbortSignal | undefined
  }): Promise<{ canonical_url: string } | null>
  upsertProviderTaskConversation(options: {
    provider: string
    profileId: string
    projectResourceId?: string | undefined
    taskId: string
    canonicalUrl: string
    signal?: AbortSignal | undefined
  }): Promise<unknown>
}
