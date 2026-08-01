import type { DaemonJob } from '../daemon-client.js'

export type { DaemonJob } from '../daemon-client.js'

export type DaemonClaimedJob = DaemonJob & {
  claim_token: string
  checkpoint_json: unknown | null
  resume_json: unknown | null
}

type JobOptions = {
  jobId: string
  signal?: AbortSignal | undefined
}

type ClaimedJobOptions = JobOptions & {
  claimToken: string
}

export type ManagedDaemonClient = {
  claimNextJob(options: {
    executionBackend: 'playwright'
    profileId?: string | undefined
    provider?: string | undefined
    action?: string | undefined
    jobIdPrefix?: string | undefined
    signal?: AbortSignal | undefined
  }): Promise<{ job: DaemonClaimedJob | null }>
  getJob(options: JobOptions): Promise<DaemonJob>
  markJobRunning(options: ClaimedJobOptions): Promise<DaemonJob>
  markJobWaitingForUser(options: ClaimedJobOptions & { blocker: unknown }): Promise<DaemonJob>
  checkpointJob(options: ClaimedJobOptions & { checkpoint: unknown }): Promise<DaemonJob>
  parkJob(options: ClaimedJobOptions & { blocker: unknown, checkpoint: unknown }): Promise<DaemonJob>
  fallbackJob(options: ClaimedJobOptions & {
    provider: string
    request: unknown
    blocker: unknown
  }): Promise<DaemonJob>
  renewJobClaim(options: ClaimedJobOptions): Promise<DaemonJob>
  completeJob(options: ClaimedJobOptions & { result?: unknown, error?: unknown }): Promise<DaemonJob>
  upsertProviderProject(options: ClaimedJobOptions & {
    provider: string
    profileId: string
    resourceId: string
    name: string
    canonicalUrl: string
    visibleProof: string
    created: boolean
  }): Promise<unknown>
  upsertProviderConversation(options: ClaimedJobOptions & {
    provider: string
    profileId: string
    projectResourceId: string
    taskId: string
    canonicalUrl: string
  }): Promise<unknown>
  upsertProviderTaskConversation(options: ClaimedJobOptions & {
    provider: string
    profileId: string
    taskId: string
    canonicalUrl: string
  }): Promise<unknown>
}
