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
    signal?: AbortSignal | undefined
  }): Promise<{ job: DaemonClaimedJob | null }>
  getJob(options: JobOptions): Promise<DaemonJob>
  markJobRunning(options: ClaimedJobOptions): Promise<DaemonJob>
  markJobWaitingForUser(options: ClaimedJobOptions & { blocker: unknown }): Promise<DaemonJob>
  checkpointJob(options: ClaimedJobOptions & { checkpoint: unknown }): Promise<DaemonJob>
  parkJob(options: ClaimedJobOptions & { blocker: unknown, checkpoint: unknown }): Promise<DaemonJob>
  renewJobClaim(options: ClaimedJobOptions): Promise<DaemonJob>
  completeJob(options: ClaimedJobOptions & { result?: unknown, error?: unknown }): Promise<DaemonJob>
}
