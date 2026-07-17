import fs from 'node:fs/promises'
import path from 'node:path'
import { errorResponse, tokenlessError } from './errors.js'
import { createProviderAdapterRegistry } from './adapters/index.js'
import { PersistentContextManager } from './browser/context-manager.js'
import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
  PLAYWRIGHT_EXECUTION_BACKEND,
  validateManagedPlaywrightJobRequest,
} from './job-contract.js'
import { VISIBLE_ACTIONS } from './actions.js'
import { createDaemonClient } from './daemon-client.js'
import { ManagedProfileRegistry } from './profiles/registry.js'
import { getProviderById } from './providers.js'
import type { ProviderAdapterRegistry } from './adapters/index.js'
import type { ManagedBrowserProfile, PersistentContextManager as PersistentContextManagerType } from './browser/context-manager.js'
import type { DaemonClaimedJob, DaemonJob, ManagedDaemonClient } from './daemon-client.js'
import type { ManagedPlaywrightJobRequest } from './job-contract.js'
import type { VisibleActionResponse } from './actions.js'
import type { Page } from 'playwright-core'

export type ManagedPlaywrightRunnerServiceOptions = {
  homeDir?: string | undefined
  profileRegistry?: ManagedProfileSource | undefined
  daemonClient?: ManagedDaemonClient | undefined
  contextManager?: PersistentContextManagerType | undefined
  adapterRegistry?: ProviderAdapterRegistry | undefined
  pollIdleMs?: number | undefined
  renewIntervalMs?: number | undefined
  cancelPollMs?: number | undefined
  responseWaitTimeoutMs?: number | undefined
  responseWaitPollMs?: number | undefined
  attachmentRootForJob?: ((job: DaemonJob) => string | undefined | Promise<string | undefined>) | undefined
  cleanupAttachmentRoot?: boolean | undefined
  now?: (() => Date) | undefined
}

export type ManagedProfileSource = {
  listProfiles(): Promise<ManagedBrowserProfile[]>
}

export type ManagedPlaywrightRunnerIteration =
  | { claimed: false }
  | { claimed: true, jobId: string, status: 'succeeded' | 'failed' | 'canceled' }

export type ManagedPlaywrightJobResult = {
  protocol: typeof MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION
  provider: string
  responses: readonly VisibleActionResponse[]
}

const DEFAULT_RENEW_INTERVAL_MS = 10_000
const DEFAULT_CANCEL_POLL_MS = 500
const DEFAULT_POLL_IDLE_MS = 1_000
const DEFAULT_RESPONSE_WAIT_TIMEOUT_MS = 120_000
const DEFAULT_RESPONSE_WAIT_POLL_MS = 250
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class ManagedPlaywrightRunnerService {
  private readonly profileRegistry: ManagedProfileSource
  private readonly daemonClient: ManagedDaemonClient
  private readonly contextManager: PersistentContextManagerType
  private readonly adapterRegistry: ProviderAdapterRegistry
  private readonly pollIdleMs: number
  private readonly renewIntervalMs: number
  private readonly cancelPollMs: number
  private readonly responseWaitTimeoutMs: number
  private readonly responseWaitPollMs: number
  private readonly attachmentRootForJob: ((job: DaemonJob) => string | undefined | Promise<string | undefined>) | undefined
  private readonly cleanupAttachmentRoot: boolean
  private readonly now: () => Date
  private readonly inFlightProfiles = new Set<string>()
  private readonly inFlightJobs = new Set<Promise<void>>()
  private stopped = false

  constructor(options: ManagedPlaywrightRunnerServiceOptions) {
    this.profileRegistry = options.profileRegistry ?? new ManagedProfileRegistry(options.homeDir)
    this.daemonClient = options.daemonClient ?? createDaemonClient()
    this.contextManager = options.contextManager ?? new PersistentContextManager()
    this.adapterRegistry = options.adapterRegistry ?? createProviderAdapterRegistry()
    this.pollIdleMs = normalizedPositiveInteger(options.pollIdleMs, DEFAULT_POLL_IDLE_MS)
    this.renewIntervalMs = normalizedPositiveInteger(options.renewIntervalMs, DEFAULT_RENEW_INTERVAL_MS)
    this.cancelPollMs = normalizedPositiveInteger(options.cancelPollMs, DEFAULT_CANCEL_POLL_MS)
    this.responseWaitTimeoutMs = normalizedPositiveInteger(options.responseWaitTimeoutMs, DEFAULT_RESPONSE_WAIT_TIMEOUT_MS)
    this.responseWaitPollMs = normalizedPositiveInteger(options.responseWaitPollMs, DEFAULT_RESPONSE_WAIT_POLL_MS)
    const defaultAttachmentHomeDir = options.homeDir
    this.attachmentRootForJob = options.attachmentRootForJob ?? (
      defaultAttachmentHomeDir ? (job) => defaultAttachmentRootForJob(defaultAttachmentHomeDir, job) : undefined
    )
    this.cleanupAttachmentRoot = options.cleanupAttachmentRoot ?? true
    this.now = options.now ?? (() => new Date())
  }

  stop() {
    this.stopped = true
  }

  async shutdown() {
    this.stop()
    await this.contextManager.shutdown()
  }

  async runUntilStopped(signal?: AbortSignal | undefined) {
    try {
      while (!this.stopped && !signal?.aborted) {
        const started = await this.startAvailableJobs(signal)
        if (started === 0) {
          await this.waitForSchedulerProgress(signal)
        }
      }
    } finally {
      await Promise.allSettled([...this.inFlightJobs])
    }
  }

  async runOnce(signal?: AbortSignal | undefined): Promise<ManagedPlaywrightRunnerIteration> {
    if (this.stopped || signal?.aborted) return { claimed: false }
    const profiles = await this.claimableProfiles(new Set())
    for (const profile of profiles) {
      const claimed = await this.daemonClient.claimNextJob({
        executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
        profileId: profile.id,
        action: MANAGED_PLAYWRIGHT_JOB_ACTION,
        signal,
      })
      if (claimed.job) return await this.executeClaimedJob(profile, claimed.job, signal)
    }
    return { claimed: false }
  }

  private async startAvailableJobs(signal?: AbortSignal | undefined) {
    if (this.inFlightProfiles.size >= 4) return 0
    let started = 0
    const profiles = await this.claimableProfiles(this.inFlightProfiles)
    for (const profile of profiles) {
      if (this.stopped || signal?.aborted || this.inFlightProfiles.size >= 4) break
      if (this.inFlightProfiles.has(profile.id)) continue
      const claimed = await this.daemonClient.claimNextJob({
        executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
        profileId: profile.id,
        action: MANAGED_PLAYWRIGHT_JOB_ACTION,
        signal,
      })
      if (!claimed.job) continue
      this.inFlightProfiles.add(profile.id)
      const jobPromise = this.executeClaimedJob(profile, claimed.job, signal)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.inFlightProfiles.delete(profile.id)
          this.inFlightJobs.delete(jobPromise)
        })
      this.inFlightJobs.add(jobPromise)
      started += 1
    }
    return started
  }

  private async waitForSchedulerProgress(signal?: AbortSignal | undefined) {
    if (this.inFlightJobs.size === 0) {
      await delay(this.pollIdleMs, signal)
      return
    }
    await Promise.race([
      ...this.inFlightJobs,
      delay(this.pollIdleMs, signal).catch(() => undefined),
    ])
  }

  private async executeClaimedJob(
    profile: ManagedBrowserProfile,
    job: DaemonClaimedJob,
    outerSignal?: AbortSignal | undefined
  ): Promise<ManagedPlaywrightRunnerIteration> {
    const controller = new AbortController()
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal
    let canceled = false
    let renewError: unknown
    let attachmentRoot: string | undefined
    const renewTimer = setInterval(() => {
      void this.daemonClient.renewJobClaim({
        jobId: job.job_id,
        claimToken: job.claim_token,
      }).catch((error) => {
        renewError = error
        controller.abort()
      })
    }, this.renewIntervalMs)
    const cancelTimer = setInterval(() => {
      void this.daemonClient.getJob({ jobId: job.job_id }).then((latest) => {
        if (latest.status === 'canceled' || latest.status === 'timed_out') {
          canceled = true
          controller.abort()
        }
      }).catch(() => undefined)
    }, this.cancelPollMs)

    try {
      const request = this.validateClaimedJob(profile, job)
      attachmentRoot = await this.attachmentRootForJob?.(job)
      if (attachmentRoot) assertSafeAttachmentCleanupRoot(attachmentRoot, job.job_id)
      await this.daemonClient.markJobRunning({
        jobId: job.job_id,
        claimToken: job.claim_token,
        signal,
      })
      const result = await this.executeActions(profile, job, request, attachmentRoot, signal, () => canceled, () => renewError)
      if (canceled || signal.aborted) {
        return { claimed: true, jobId: job.job_id, status: 'canceled' }
      }
      await this.daemonClient.completeJob({
        jobId: job.job_id,
        claimToken: job.claim_token,
        result,
      })
      return { claimed: true, jobId: job.job_id, status: 'succeeded' }
    } catch (error) {
      if (canceled || signal.aborted) {
        if (!renewError) {
          return { claimed: true, jobId: job.job_id, status: 'canceled' }
        }
      }
      const completionError = renewError ?? error
      if (renewError) {
        await this.daemonClient.completeJob({
          jobId: job.job_id,
          claimToken: job.claim_token,
          error: serializeRunnerError(completionError),
        }).catch(() => undefined)
        return { claimed: true, jobId: job.job_id, status: 'failed' }
      }
      if (signal.aborted) {
        return { claimed: true, jobId: job.job_id, status: 'canceled' }
      }
      await this.daemonClient.completeJob({
        jobId: job.job_id,
        claimToken: job.claim_token,
        error: serializeRunnerError(completionError),
      }).catch(() => undefined)
      return { claimed: true, jobId: job.job_id, status: 'failed' }
    } finally {
      clearInterval(renewTimer)
      clearInterval(cancelTimer)
      controller.abort()
      if (attachmentRoot && this.cleanupAttachmentRoot) {
        await fs.rm(attachmentRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  private async claimableProfiles(inFlightProfiles: ReadonlySet<string>): Promise<ManagedBrowserProfile[]> {
    const profiles = await this.profileRegistry.listProfiles()
    const activeProfileIds = new Set(this.contextManager.activeProfileIds())
    if (activeProfileIds.size >= 4) {
      return profiles.filter((profile) => activeProfileIds.has(profile.id) && !inFlightProfiles.has(profile.id))
    }
    const remainingNewProfileSlots = 4 - activeProfileIds.size - [...inFlightProfiles].filter((profileId) => !activeProfileIds.has(profileId)).length
    let newProfiles = 0
    const claimable: ManagedBrowserProfile[] = []
    for (const profile of profiles) {
      if (inFlightProfiles.has(profile.id)) continue
      if (activeProfileIds.has(profile.id)) {
        claimable.push(profile)
        continue
      }
      if (newProfiles >= remainingNewProfileSlots) continue
      newProfiles += 1
      claimable.push(profile)
    }
    return claimable
  }

  private validateClaimedJob(profile: ManagedBrowserProfile, job: DaemonClaimedJob): ManagedPlaywrightJobRequest {
    if (job.execution_backend !== PLAYWRIGHT_EXECUTION_BACKEND) {
      throw tokenlessError('invalid_playwright_job_backend', 'Managed Playwright runner claimed a non-Playwright job.')
    }
    if (job.profile_id !== profile.id) {
      throw tokenlessError('invalid_playwright_job_profile', 'Managed Playwright runner claimed a job for a different profile.')
    }
    if (job.action !== MANAGED_PLAYWRIGHT_JOB_ACTION) {
      throw tokenlessError('invalid_playwright_job_action', 'Managed Playwright runner claimed an unsupported job action.')
    }
    const request = validateManagedPlaywrightJobRequest(job.request_json)
    if (request.provider !== job.provider) {
      throw tokenlessError('invalid_playwright_job_provider', 'Managed Playwright job provider does not match daemon metadata.')
    }
    return request
  }

  private async executeActions(
    profile: ManagedBrowserProfile,
    job: DaemonClaimedJob,
    request: ManagedPlaywrightJobRequest,
    attachmentRoot: string | undefined,
    signal: AbortSignal,
    isCanceled: () => boolean,
    renewalError: () => unknown
  ): Promise<ManagedPlaywrightJobResult> {
    const responses = await this.contextManager.runWithProfile(profile, async (managedContext) => {
      const page = await managedContext.page()
      await navigateToTarget(page, request.target.url, signal)
      const visibleResponses: VisibleActionResponse[] = []
      const provider = getProviderById(request.provider)
      if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
      let responseBaseline: number | null = null
      for (const action of request.actions) {
        throwIfStopped(signal, isCanceled, renewalError)
        if (action.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) {
          responseBaseline = await countVisibleAnswers(page, provider.answerSelectors)
        }
        if (action.action === VISIBLE_ACTIONS.RESPONSE_READ && responseBaseline !== null) {
          await waitForNewResponseReady(page, {
            answerSelectors: provider.answerSelectors,
            busySelectors: provider.busySelectors,
            baseline: responseBaseline,
            timeoutMs: this.responseWaitTimeoutMs,
            pollMs: this.responseWaitPollMs,
            signal,
            isCanceled,
            renewalError,
          })
        }
        const adapterContext = {
          profileId: profile.id,
          operationId: job.job_id,
          signal,
          now: this.now,
          ...(attachmentRoot === undefined ? {} : { attachmentRoot }),
        }
        const response = await this.adapterRegistry.execute(page, action, adapterContext)
        visibleResponses.push(response)
        if (!response.ok) {
          throw tokenlessError(response.error.code, response.error.message, { retryable: response.error.retryable })
        }
        if (action.action === VISIBLE_ACTIONS.RESPONSE_READ) responseBaseline = null
      }
      return visibleResponses
    })
    return {
      protocol: MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
      provider: request.provider,
      responses,
    }
  }
}

export function serializeRunnerError(error: unknown) {
  const response = errorResponse(error)
  return {
    code: response.code,
    message: response.message,
    retryable: response.retryable,
  }
}

async function navigateToTarget(page: unknown, url: string, signal: AbortSignal) {
  throwIfStopped(signal, () => false)
  const maybePage = page as { goto?: (url: string, options?: Record<string, unknown>) => Promise<unknown> }
  if (typeof maybePage.goto === 'function') {
    await maybePage.goto(url, { waitUntil: 'domcontentloaded' })
  }
}

function throwIfStopped(signal: AbortSignal, isCanceled: () => boolean, renewalError?: () => unknown) {
  const renewError = renewalError?.()
  if (renewError) throw renewError
  if (signal.aborted || isCanceled()) {
    throw tokenlessError('playwright_job_canceled', 'Managed Playwright job was canceled.', { retryable: false })
  }
}

function assertSafeAttachmentCleanupRoot(root: string, jobId: string) {
  assertSafeJobId(jobId)
  const resolved = path.resolve(root)
  if (path.basename(resolved) !== jobId) {
    throw tokenlessError('unsafe_attachment_cleanup_root', 'Managed Playwright attachment cleanup root must be the exact job directory.')
  }
}

async function defaultAttachmentRootForJob(homeDir: string, job: DaemonJob) {
  assertSafeJobId(job.job_id)
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  const canonicalHome = await fs.realpath(homeDir)
  const attachmentsDir = path.join(canonicalHome, 'attachments')
  await fs.mkdir(attachmentsDir, { recursive: true, mode: 0o700 })
  const attachmentsStat = await fs.lstat(attachmentsDir)
  if (!attachmentsStat.isDirectory() || attachmentsStat.isSymbolicLink()) {
    throw tokenlessError('unsafe_attachment_cleanup_root', 'Managed Playwright attachment directory must be a real directory under the Tokenless home.')
  }
  const jobRoot = path.join(attachmentsDir, job.job_id)
  if (path.dirname(jobRoot) !== attachmentsDir || path.basename(jobRoot) !== job.job_id) {
    throw tokenlessError('unsafe_attachment_cleanup_root', 'Managed Playwright attachment root must be the exact job directory.')
  }
  return jobRoot
}

function assertSafeJobId(jobId: string) {
  if (!SAFE_JOB_ID_PATTERN.test(jobId)) {
    throw tokenlessError('invalid_playwright_job_id', 'Managed Playwright job id is not safe for attachment paths.')
  }
}

async function waitForNewResponseReady(
  page: Page,
  options: {
    answerSelectors: readonly string[]
    busySelectors: readonly string[]
    baseline: number
    timeoutMs: number
    pollMs: number
    signal: AbortSignal
    isCanceled: () => boolean
    renewalError: () => unknown
  }
) {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() <= deadline) {
    throwIfStopped(options.signal, options.isCanceled, options.renewalError)
    const answerCount = await countVisibleAnswers(page, options.answerSelectors)
    const busy = await hasVisibleBusyIndicator(page, options.busySelectors)
    if (answerCount > options.baseline && !busy) return
    await delay(Math.min(options.pollMs, Math.max(1, deadline - Date.now())), options.signal)
  }
  throw tokenlessError('playwright_response_timeout', 'Timed out waiting for a new visible provider response.', { retryable: true })
}

async function countVisibleAnswers(page: Page, selectors: readonly string[]) {
  let total = 0
  for (const selector of selectors) {
    const locator = page.locator(selector)
    const count = await locator.count()
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible({ timeout: 50 }).catch(() => false)) total += 1
    }
  }
  return total
}

async function hasVisibleBusyIndicator(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector)
    const count = await locator.count()
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible({ timeout: 50 }).catch(() => false)) return true
    }
  }
  return false
}

function normalizedPositiveInteger(value: number | undefined, fallback: number) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback
}

function delay(ms: number, signal?: AbortSignal | undefined) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(tokenlessError('playwright_runner_stopped', 'Managed Playwright runner was stopped.', { retryable: true }))
      return
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(tokenlessError('playwright_runner_stopped', 'Managed Playwright runner was stopped.', { retryable: true }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
