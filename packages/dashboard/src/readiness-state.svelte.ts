import type { DashboardClient } from './dashboard-client.js'
import type { MessageKey } from './i18n/index.js'
import type {
  ReadinessJobs,
  UiJobStatus,
  UiJobSummary,
  UiSnapshot,
} from './types.js'

const READINESS_TIMEOUT_MS = 120_000
const READINESS_POLL_MS = 750
const ACTIVE_JOB_STATUSES = new Set<UiJobStatus>(['queued', 'claimed', 'running'])

type ReadinessDependencies = {
  client: DashboardClient
  snapshot: () => UiSnapshot | null
  refreshSnapshot: () => Promise<void>
  notify: (message: string) => void
  t: (key: MessageKey) => string
}

export function createReadinessState(dependencies: ReadinessDependencies) {
  const state = $state<{ busy: boolean; jobs: ReadinessJobs }>({
    busy: false,
    jobs: {},
  })
  let activeProfile = ''
  let runId = 0

  function reset(profileSlug: string) {
    activeProfile = profileSlug
    runId += 1
    state.busy = false
    state.jobs = {}
  }

  async function refresh(profileSlug: string) {
    if (state.busy) return
    state.busy = true
    activeProfile = profileSlug
    const currentRun = ++runId
    let submitted = false
    state.jobs = optimisticJobs(dependencies.snapshot(), profileSlug)

    try {
      const result = await dependencies.client.refreshProviderReadiness(profileSlug)
      if (!isCurrent(currentRun, profileSlug)) return
      const jobIds = result.jobs.map((job) => job.jobId)
      if (jobIds.length === 0) {
        state.jobs = {}
        dependencies.notify(dependencies.t('noEnabledProviders'))
        return
      }
      submitted = true
      state.jobs = jobsByProvider(result.jobs)
      const jobs = await waitForJobs(jobIds, currentRun, profileSlug)
      if (!jobs) return
      dependencies.notify(dependencies.t(jobs.some((job) => job.status !== 'succeeded')
        ? 'providerReadinessPartiallyRefreshed'
        : 'providerReadinessRefreshed'))
    } catch (error) {
      if (!isCurrent(currentRun, profileSlug)) return
      if (!submitted) state.jobs = {}
      dependencies.notify(error instanceof Error ? error.message : dependencies.t('requestFailed'))
    } finally {
      if (isCurrent(currentRun, profileSlug)) {
        await dependencies.refreshSnapshot()
        if (isCurrent(currentRun, profileSlug)) state.busy = false
      }
    }
  }

  async function waitForJobs(jobIds: string[], currentRun: number, profileSlug: string) {
    const expected = new Set(jobIds)
    const deadline = Date.now() + READINESS_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, READINESS_POLL_MS))
      if (!isCurrent(currentRun, profileSlug)) return null
      await dependencies.refreshSnapshot()
      if (!isCurrent(currentRun, profileSlug)) return null
      const jobs = dependencies.snapshot()?.jobs.filter((job) => expected.has(job.jobId)) ?? []
      state.jobs = { ...state.jobs, ...jobsByProvider(jobs) }
      if (jobs.length === expected.size && jobs.every((job) => !ACTIVE_JOB_STATUSES.has(job.status))) return jobs
    }
    throw new Error(dependencies.t('providerReadinessRefreshTimedOut'))
  }

  function isCurrent(currentRun: number, profileSlug: string) {
    return currentRun === runId && profileSlug === activeProfile
  }

  return { state, refresh, reset }
}

function optimisticJobs(snapshot: UiSnapshot | null, profileSlug: string): ReadinessJobs {
  const profile = snapshot?.profiles.find((entry) => entry.slug === profileSlug)
  const enabledProviderIds = snapshot?.providers
    .filter((provider) => provider.profiles.find((entry) => entry.profileId === profile?.slug)?.enabled)
    .map((provider) => provider.id) ?? []
  return Object.fromEntries(enabledProviderIds.map((providerId) => [providerId, { status: 'running' as const }]))
}

function jobsByProvider(jobs: UiJobSummary[]): ReadinessJobs {
  return Object.fromEntries(jobs.map((job) => [job.provider, { jobId: job.jobId, status: job.status }]))
}
