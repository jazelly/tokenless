import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  claimRecoveryError,
  errorResponse,
  isClaimRecoveryError,
  tokenlessError,
} from './errors.js'
import { RUNNER_CHECKPOINT_SCHEMA_ID, USER_HANDOVER_SCHEMA_ID } from '../schema-ids.js'
import { MAX_ACTIVE_BROWSER_PROFILES, PersistentContextManager } from './browser/context-manager.js'
import {
  e2eInspectionJobPrefix,
  resolveE2EBrowserInspectionConfig,
  waitForE2EBrowserObserver,
} from './e2e-inspection.js'
import type { E2EBrowserInspectionConfig } from './e2e-inspection.js'
import type { ManagedBrowserLaunchTarget } from './browser/context-manager.js'
import type { ManagedBrowserResolver } from './browser/context-manager.js'
import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
  PLAYWRIGHT_EXECUTION_BACKEND,
  validateManagedPlaywrightJobRequest,
} from './job-contract.js'
import { getVisibleActionLifecycle } from '../providers/action-catalog.js'
import {
  classifyProviderFailure,
  classifyVisibleProviderBlocker,
  type ClassifiedProviderFailure,
} from './provider-failure-classification.js'
import { VISIBLE_ACTIONS, VISIBLE_ACTION_SCHEMA_ID, isVisibleActionProtocolVersion } from './actions.js'
import { ManagedProfileRegistry } from './profiles/registry.js'
import { checkpointIndicatesExternalMutation } from './submission-certainty.js'
import { readTokenlessConfig } from '../job-store.js'
import { PROVIDER_CAPABILITIES, TASK_CAPABILITIES, getProviderInstanceById } from '../providers/registry.js'
import type {
  ManagedBrowserContext,
  ManagedBrowserProfile,
  PersistentContextManager as PersistentContextManagerType,
} from './browser/context-manager.js'
import type { DaemonClaimedJob, DaemonJob, ManagedDaemonClient } from './daemon-client.js'
import type { ManagedPlaywrightJobRequest } from './job-contract.js'
import type { ProviderCapabilityId, TaskCapabilityId, TaskCapabilityRoute } from '../providers/registry.js'
import type { BrowserVisibility } from '../browser-visibility.js'
import type { VisibleAction, VisibleActionRequest } from './actions.js'
import type { VisibleActionResponse } from './actions.js'
import type { VisibleBlocker } from './actions.js'
import type { NativeWorkspaceEnsureResult } from './actions.js'
import type { ProviderActionPreparation } from '../providers/contracts.js'
import type { ProviderCapacityProjection } from '../providers/rate-limit-policy.js'
import type { BrowserContext, Page } from 'playwright-core'
import type { OutputSavingsWorkInput } from '../daemon/job-store.js'

export type ManagedPlaywrightRunnerServiceOptions = {
  homeDir?: string | undefined
  profileRegistry?: ManagedProfileSource | undefined
  daemonClient: ManagedDaemonClient
  contextManager?: PersistentContextManagerType | undefined
  browser?: ManagedBrowserLaunchTarget | undefined
  browserResolver?: ManagedBrowserResolver | undefined
  pollIdleMs?: number | undefined
  renewIntervalMs?: number | undefined
  cancelPollMs?: number | undefined
  responseWaitPollMs?: number | undefined
  userHandoverTimeoutMs?: number | undefined
  userHandoverPollMs?: number | undefined
  attachmentRootForJob?: ((job: DaemonJob) => string | undefined | Promise<string | undefined>) | undefined
  recoverAbortedClaim?: ((job: DaemonClaimedJob) => Promise<unknown> | unknown) | undefined
  cleanupAttachmentRoot?: boolean | undefined
  now?: (() => Date) | undefined
}

export type ManagedProfileSource = {
  listProfiles(): Promise<ManagedBrowserProfile[]>
}

export type ManagedPlaywrightRunnerIteration =
  | { claimed: false }
  | { claimed: true, jobId: string, status: 'succeeded' | 'failed' | 'canceled' | 'waiting_for_user' | 'fallback_queued' | 'rate_limit_deferred' }

export type ManagedPlaywrightJobResult = {
  protocol: typeof MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID
  provider: string
  responses: readonly VisibleActionResponse[]
}

type ManagedPlaywrightExecutionOutcome = {
  result: ManagedPlaywrightJobResult
  outputSavingsWork: readonly OutputSavingsWorkInput[]
}

export type ManagedProfileOpenResult = {
  profileId: string
  browserVisibility: BrowserVisibility
  effectiveBrowserVisibility: Exclude<BrowserVisibility, 'auto'>
  pageCount: number
}

export type ManagedProviderTabsOpenResult = ManagedProfileOpenResult & {
  tabs: readonly {
    provider: string
    url: string
    reused: boolean
  }[]
  failures: readonly {
    provider: string
    code: 'provider_tab_open_failed'
    message: string
  }[]
}

export type ManagedControlPlaneOpenResult = ManagedProfileOpenResult & {
  url: string
  reused: boolean
}

type RunnerCheckpointPhase =
  | { state: 'idle' }
  | {
    state: 'started' | 'completed'
    actionIndex: number
    requestId: string
    action: VisibleAction
    mutating: boolean
    providerUrl: string | null
  }

type RunnerSubmittedActionCheckpoint = {
  actionIndex: number
  requestId: string
  providerUrl: string
  preparation: ProviderActionPreparation
}

type RunnerCheckpoint = {
  protocol: typeof RUNNER_CHECKPOINT_SCHEMA_ID
  jobId: string
  profileId: string | null
  provider: string
  targetUrl: string
  browserVisibility: BrowserVisibility
  actionCursor: number
  responses: readonly VisibleActionResponse[]
  preparation: ProviderActionPreparation | null
  submitted: RunnerSubmittedActionCheckpoint | null
  phase: RunnerCheckpointPhase
}

type RunnerExecutionState = {
  actionCursor: number
  responses: VisibleActionResponse[]
  preparation: ProviderActionPreparation | null
  submitted: RunnerSubmittedActionCheckpoint | null
}

type ClearBlockerResult = {
  managedContext: ManagedBrowserContext
  page: Page
  waitedMs: number
}

type RunnerProvider = NonNullable<ReturnType<typeof getProviderInstanceById>>

const DEFAULT_RENEW_INTERVAL_MS = 10_000
const DEFAULT_CANCEL_POLL_MS = 500
const DEFAULT_POLL_IDLE_MS = 1_000
const DEFAULT_RESPONSE_WAIT_POLL_MS = 250
const DEFAULT_USER_HANDOVER_TIMEOUT_MS = 10 * 60_000
const DEFAULT_USER_HANDOVER_POLL_MS = 1_000
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export class ManagedPlaywrightRunnerService {
  private readonly profileRegistry: ManagedProfileSource
  private readonly daemonClient: ManagedDaemonClient
  private readonly contextManager: PersistentContextManagerType
  private readonly pollIdleMs: number
  private readonly renewIntervalMs: number
  private readonly cancelPollMs: number
  private readonly responseWaitPollMs: number
  private readonly userHandoverTimeoutMs: number
  private readonly userHandoverPollMs: number
  private readonly attachmentRootForJob: ((job: DaemonJob) => string | undefined | Promise<string | undefined>) | undefined
  private readonly recoverAbortedClaim: ((job: DaemonClaimedJob) => Promise<unknown> | unknown) | undefined
  private readonly cleanupAttachmentRoot: boolean
  private readonly now: () => Date
  private readonly e2eInspection: E2EBrowserInspectionConfig | null
  private readonly controlPlanePageKey: string
  private readonly homeDir: string | undefined
  private readonly providerTabsByProfile = new Map<string, Map<string, Page>>()
  private readonly pendingProviderTabsByProfile = new Map<string, Set<string>>()
  private readonly inFlightProfiles = new Set<string>()
  private readonly inFlightJobs = new Set<Promise<void>>()
  private stopped = false

  constructor(options: ManagedPlaywrightRunnerServiceOptions) {
    this.homeDir = options.homeDir === undefined ? undefined : path.resolve(options.homeDir)
    if (options.profileRegistry) {
      this.profileRegistry = options.profileRegistry
    } else {
      const registry = new ManagedProfileRegistry(options.homeDir)
      this.profileRegistry = {
        listProfiles: async () => {
          const [profiles, config] = await Promise.all([
            registry.listProfiles(),
            readTokenlessConfig(options.homeDir),
          ])
          return profiles.map((profile) => ({
            ...profile,
            proxy: config.profiles[profile.slug]?.proxy ?? null,
          }))
        },
      }
    }
    this.daemonClient = options.daemonClient
    this.contextManager = options.contextManager ?? new PersistentContextManager({
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.browserResolver ? { browserResolver: options.browserResolver } : {}),
    })
    this.pollIdleMs = normalizedPositiveInteger(options.pollIdleMs, DEFAULT_POLL_IDLE_MS)
    this.renewIntervalMs = normalizedPositiveInteger(options.renewIntervalMs, DEFAULT_RENEW_INTERVAL_MS)
    this.cancelPollMs = normalizedPositiveInteger(options.cancelPollMs, DEFAULT_CANCEL_POLL_MS)
    this.responseWaitPollMs = normalizedPositiveInteger(options.responseWaitPollMs, DEFAULT_RESPONSE_WAIT_POLL_MS)
    this.userHandoverTimeoutMs = normalizedPositiveInteger(options.userHandoverTimeoutMs, DEFAULT_USER_HANDOVER_TIMEOUT_MS)
    this.userHandoverPollMs = normalizedPositiveInteger(options.userHandoverPollMs, DEFAULT_USER_HANDOVER_POLL_MS)
    const defaultAttachmentHomeDir = options.homeDir
    this.attachmentRootForJob = options.attachmentRootForJob ?? (
      defaultAttachmentHomeDir ? (job) => defaultAttachmentRootForJob(defaultAttachmentHomeDir, job) : undefined
    )
    this.recoverAbortedClaim = options.recoverAbortedClaim
    this.cleanupAttachmentRoot = options.cleanupAttachmentRoot ?? true
    this.now = options.now ?? (() => new Date())
    this.e2eInspection = resolveE2EBrowserInspectionConfig(options.homeDir)
    const homeIdentity = createHash('sha256').update(path.resolve(options.homeDir ?? '.')).digest('base64url').slice(0, 20)
    this.controlPlanePageKey = `tokenless:control-plane:${homeIdentity}`
  }

  stop() {
    this.stopped = true
  }

  activeJobCount() {
    return this.inFlightJobs.size
  }

  activeProfileCount() {
    return this.contextManager.activeProfileIds().length
  }

  async openProfile(profileId: string, browserVisibility: BrowserVisibility): Promise<ManagedProfileOpenResult> {
    const profile = (await this.profileRegistry.listProfiles())
      .find((candidate) => candidate.id === profileId && (candidate.lifecycle === undefined || candidate.lifecycle === 'ready'))
    if (!profile) {
      throw tokenlessError('profile_not_found', 'Managed profile is not registered or is not ready.')
    }
    const managedContext = await this.contextManager.ensureContext(profile, browserVisibility)
    const pages = managedContext.browserContext.pages()
    if (pages[0] && managedContext.effectiveBrowserVisibility === 'headed') {
      await bringToFrontForUserHandoff(pages[0])
    }
    return {
      profileId: profile.id,
      browserVisibility: managedContext.browserVisibility,
      effectiveBrowserVisibility: managedContext.effectiveBrowserVisibility,
      pageCount: pages.length,
    }
  }

  async openProviderTabs(
    profileId: string,
    providerIds: readonly string[],
    browserVisibility: BrowserVisibility,
  ): Promise<ManagedProviderTabsOpenResult> {
    const profile = (await this.profileRegistry.listProfiles())
      .find((candidate) => candidate.id === profileId && (candidate.lifecycle === undefined || candidate.lifecycle === 'ready'))
    if (!profile) {
      throw tokenlessError('profile_not_found', 'Managed profile is not registered or is not ready.')
    }
    const providers = providerIds.map((providerId) => {
      const provider = getProviderInstanceById(providerId)
      if (!provider || provider.descriptor.stage === 'disabled') {
        throw tokenlessError('unknown_provider', `Provider '${providerId}' is not supported.`)
      }
      return provider
    })
    const managedContext = await this.contextManager.ensureContext(profile, browserVisibility)
    const existingPages = managedContext.browserContext.pages()
    const claimedPages = new Set<Page>()
    const knownProviderTabs = this.providerTabsByProfile.get(profile.id) ?? new Map<string, Page>()
    const pendingProviderTabs = this.pendingProviderTabsByProfile.get(profile.id) ?? new Set<string>()
    this.providerTabsByProfile.set(profile.id, knownProviderTabs)
    this.pendingProviderTabsByProfile.set(profile.id, pendingProviderTabs)
    const tabs: ManagedProviderTabsOpenResult['tabs'][number][] = []
    const missing: RunnerProvider[] = []
    for (const provider of providers) {
      const known = knownProviderTabs.get(provider.id)
      if (known?.isClosed()) knownProviderTabs.delete(provider.id)
      const existing = known && !known.isClosed()
        ? known
        : existingPages.find((page) => !claimedPages.has(page) && providerOwnsPage(provider, page))
      if (existing) {
        claimedPages.add(existing)
        knownProviderTabs.set(provider.id, existing)
        tabs.push({ provider: provider.id, url: provider.descriptor.navigation.entryUrl, reused: true })
      } else if (pendingProviderTabs.has(provider.id)) {
        tabs.push({ provider: provider.id, url: provider.descriptor.navigation.entryUrl, reused: true })
      } else {
        missing.push(provider)
      }
    }

    const failures: ManagedProviderTabsOpenResult['failures'][number][] = []
    const initialBlankPage = existingPages.find((page) => (
      !page.isClosed() && !claimedPages.has(page) && page.url() === 'about:blank'
    ))
    const initialProvider = initialBlankPage ? missing.shift() : undefined
    if (initialProvider && initialBlankPage) {
      claimedPages.add(initialBlankPage)
      knownProviderTabs.set(initialProvider.id, initialBlankPage)
      pendingProviderTabs.add(initialProvider.id)
      try {
        await initialBlankPage.goto(initialProvider.descriptor.navigation.entryUrl, { waitUntil: 'commit' })
        tabs.push({
          provider: initialProvider.id,
          url: initialProvider.descriptor.navigation.entryUrl,
          reused: false,
        })
      } catch (error) {
        knownProviderTabs.delete(initialProvider.id)
        failures.push(providerTabOpenFailure(initialProvider.id, error))
      } finally {
        pendingProviderTabs.delete(initialProvider.id)
      }
    }
    if (missing.length > 0) {
      const browser = managedContext.browserContext.browser()
      if (!browser) throw tokenlessError('playwright_browser_closed', 'Managed browser is no longer connected.')
      const session = await browser.newBrowserCDPSession()
      const requests = missing.map(async (provider) => {
        pendingProviderTabs.add(provider.id)
        try {
          const created = await session.send('Target.createTarget', {
            url: provider.descriptor.navigation.entryUrl,
            background: true,
            focus: false,
          })
          const createdPages = await waitForChromiumTargetPages(
            managedContext.browserContext,
            new Set([created.targetId]),
            10_000,
          )
          const page = createdPages.get(created.targetId)
          if (!page) {
            throw tokenlessError(
              'playwright_background_page_unavailable',
              `Chromium created the ${provider.id} tab but Playwright did not expose its page.`,
              { retryable: true, details: { provider: provider.id, targetId: created.targetId } },
            )
          }
          knownProviderTabs.set(provider.id, page)
          tabs.push({ provider: provider.id, url: provider.descriptor.navigation.entryUrl, reused: false })
        } catch (error) {
          knownProviderTabs.delete(provider.id)
          failures.push(providerTabOpenFailure(provider.id, error))
        } finally {
          pendingProviderTabs.delete(provider.id)
        }
      })
      await Promise.all(requests)
      await session.detach().catch(() => undefined)
    }
    if (pendingProviderTabs.size === 0) {
      this.pendingProviderTabsByProfile.delete(profile.id)
      if (knownProviderTabs.size === 0) {
        this.providerTabsByProfile.delete(profile.id)
      }
    }
    const providerOrder = new Map(providerIds.map((provider, index) => [provider, index]))
    tabs.sort((left, right) => (providerOrder.get(left.provider) ?? 0) - (providerOrder.get(right.provider) ?? 0))
    failures.sort((left, right) => (providerOrder.get(left.provider) ?? 0) - (providerOrder.get(right.provider) ?? 0))
    return {
      profileId: profile.id,
      browserVisibility: managedContext.browserVisibility,
      effectiveBrowserVisibility: managedContext.effectiveBrowserVisibility,
      pageCount: managedContext.browserContext.pages().length,
      tabs,
      failures,
    }
  }

  async openControlPlane(profileId: string, consoleUrl: string): Promise<ManagedControlPlaneOpenResult> {
    const parsed = new URL(consoleUrl)
    if (
      parsed.protocol !== 'http:' ||
      parsed.username ||
      parsed.password ||
      !(parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname.startsWith('127.'))
    ) {
      throw tokenlessError('invalid_control_plane_url', 'Control-plane URL must use a loopback HTTP origin.')
    }
    const profile = (await this.profileRegistry.listProfiles())
      .find((candidate) => candidate.id === profileId && (candidate.lifecycle === undefined || candidate.lifecycle === 'ready'))
    if (!profile) throw tokenlessError('profile_not_found', 'Managed profile is not registered or is not ready.')
    const managedContext = await this.contextManager.ensureContext(profile, 'headed')
    const page = await managedContext.acquireReservedPage({ key: this.controlPlanePageKey, policy: 'preserve' })
    const reused = page.url() !== 'about:blank'
    await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded' })
    await bringToFrontForUserHandoff(page)
    return {
      profileId: profile.id,
      browserVisibility: managedContext.browserVisibility,
      effectiveBrowserVisibility: managedContext.effectiveBrowserVisibility,
      pageCount: managedContext.browserContext.pages().length,
      url: page.url(),
      reused,
    }
  }

  async shutdown() {
    this.stop()
    await this.contextManager.shutdown()
  }

  async detach() {
    this.stop()
    await this.contextManager.detach()
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
      const results = await Promise.allSettled([...this.inFlightJobs])
      const recoveryFailure = results.find((result) => (
        result.status === 'rejected' &&
        isManagedPlaywrightClaimRecoveryFailure(result.reason)
      ))
      if (recoveryFailure?.status === 'rejected') throw recoveryFailure.reason
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
        jobIdPrefix: this.e2eInspection ? e2eInspectionJobPrefix(this.e2eInspection) : undefined,
        signal,
      })
      if (claimed.job) return await this.executeClaimedJob(profile, claimed.job, signal)
    }
    return { claimed: false }
  }

  private async startAvailableJobs(signal?: AbortSignal | undefined) {
    if (this.inFlightProfiles.size >= MAX_ACTIVE_BROWSER_PROFILES) return 0
    let started = 0
    const profiles = await this.claimableProfiles(this.inFlightProfiles)
    for (const profile of profiles) {
      if (this.stopped || signal?.aborted || this.inFlightProfiles.size >= MAX_ACTIVE_BROWSER_PROFILES) break
      if (this.inFlightProfiles.has(profile.id)) continue
      const claimed = await this.daemonClient.claimNextJob({
        executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
        profileId: profile.id,
        action: MANAGED_PLAYWRIGHT_JOB_ACTION,
        jobIdPrefix: this.e2eInspection ? e2eInspectionJobPrefix(this.e2eInspection) : undefined,
        signal,
      })
      if (!claimed.job) continue
      this.inFlightProfiles.add(profile.id)
      const jobPromise = this.executeClaimedJob(profile, claimed.job, signal)
        .then(() => undefined)
        .catch((error) => {
          if (isClaimRecoveryError(error)) throw error
        })
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
    let providerAttachmentRoot: string | undefined
    let terminalCompletion = false
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
      if (job.provider_submitted_at === null && !checkpointIndicatesExternalMutation(job.checkpoint_json)) {
        const subscription = rateLimitSubscription(profile, job.provider)
        const projection = await this.daemonClient.projectJobProviderCapacity({
          jobId: job.job_id,
          claimToken: job.claim_token,
          accessClass: subscription.accessClass,
          tierLabel: subscription.tierLabel,
          subscriptionLabel: subscription.subscriptionLabel,
          signal,
        })
        if (projection.decision === 'defer') {
          const failure = providerCapacityFailure(projection)
          const fallbackRequest = safeFallbackRequest(request, initialExecutionState(), failure)
          if (fallbackRequest) {
            await this.daemonClient.fallbackJob({
              jobId: job.job_id,
              claimToken: job.claim_token,
              provider: fallbackRequest.provider,
              request: fallbackRequest,
              blocker: { code: 'provider_capacity_deferred', projection, failure },
              signal,
            })
            throw new QueuedProviderFallback()
          }
          if (!projection.eligibleAt) {
            throw tokenlessError(
              'provider_capacity_request_exceeds_known_allowance',
              'The request exceeds a known provider allowance and cannot become eligible by waiting.',
              { retryable: false, details: projection },
            )
          }
          await this.daemonClient.deferJobForProviderCapacity({
            jobId: job.job_id,
            claimToken: job.claim_token,
            projection,
            signal,
          })
          throw new DeferredProviderCapacity()
        }
      }
      attachmentRoot = await this.attachmentRootForJob?.(job)
      if (attachmentRoot) {
        assertSafeAttachmentCleanupRoot(attachmentRoot, job.job_id)
        providerAttachmentRoot = path.dirname(attachmentRoot)
      }
      await this.daemonClient.markJobRunning({
        jobId: job.job_id,
        claimToken: job.claim_token,
        signal,
      })
      const execution = await this.executeActions(
        profile,
        job,
        request,
        providerAttachmentRoot,
        signal,
        () => canceled,
        () => renewError,
      )
      if (canceled || signal.aborted) {
        return { claimed: true, jobId: job.job_id, status: 'canceled' }
      }
      await this.daemonClient.completeJob({
        jobId: job.job_id,
        claimToken: job.claim_token,
        result: execution.result,
        outputSavingsWork: execution.outputSavingsWork,
      })
      terminalCompletion = true
      return { claimed: true, jobId: job.job_id, status: 'succeeded' }
    } catch (error) {
      if (error instanceof ParkedPlaywrightJob) {
        attachmentRoot = undefined
        return { claimed: true, jobId: job.job_id, status: 'waiting_for_user' }
      }
      if (error instanceof QueuedProviderFallback) {
        attachmentRoot = undefined
        return { claimed: true, jobId: job.job_id, status: 'fallback_queued' }
      }
      if (error instanceof DeferredProviderCapacity) {
        attachmentRoot = undefined
        return { claimed: true, jobId: job.job_id, status: 'rate_limit_deferred' }
      }
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
        terminalCompletion = true
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
      terminalCompletion = true
      return { claimed: true, jobId: job.job_id, status: 'failed' }
    } finally {
      clearInterval(renewTimer)
      clearInterval(cancelTimer)
      controller.abort()
      const recoverClaim = outerSignal?.aborted && !terminalCompletion && !canceled && !renewError
      if (attachmentRoot && this.cleanupAttachmentRoot && !recoverClaim) {
        await fs.rm(attachmentRoot, { recursive: true, force: true }).catch(() => undefined)
      }
      if (recoverClaim) {
        try {
          await this.recoverAbortedClaim?.(job)
        } catch (error) {
          throw claimRecoveryError(error)
        }
      }
    }
  }

  private async claimableProfiles(inFlightProfiles: ReadonlySet<string>): Promise<ManagedBrowserProfile[]> {
    const profiles = (await this.profileRegistry.listProfiles())
      .filter((profile) => profile.lifecycle === undefined || profile.lifecycle === 'ready')
    const activeProfileIds = new Set(this.contextManager.activeProfileIds())
    if (activeProfileIds.size >= MAX_ACTIVE_BROWSER_PROFILES) {
      return profiles.filter((profile) => activeProfileIds.has(profile.id) && !inFlightProfiles.has(profile.id))
    }
    const remainingNewProfileSlots = MAX_ACTIVE_BROWSER_PROFILES - activeProfileIds.size - [...inFlightProfiles]
      .filter((profileId) => !activeProfileIds.has(profileId)).length
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
    renewalError: () => unknown,
  ): Promise<ManagedPlaywrightExecutionOutcome> {
    const outputSavingsEnabled = await this.outputSavingsEnabled()
    const outputSavingsWorkByRequestId = new Map<string, string>()
    const resumeVisibility = validateResumeVisibility(job.resume_json)
    const claimBrowserVisibility = requestedVisibilityForClaim(request.browserVisibility, resumeVisibility)
    const restoredCheckpoint = validateRunnerCheckpoint(job.checkpoint_json, profile, job, request)
    const responses = await this.contextManager.runWithProfile(profile, claimBrowserVisibility, async (initialManagedContext) => {
      let managedContext = initialManagedContext
      const pageKey = managedPageKey(job, request)
      let page = await managedContext.acquirePage({ key: pageKey, policy: request.pagePolicy ?? 'preserve' })
      const provider = getProviderInstanceById(request.provider)
      if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
      const state = executionStateFromCheckpoint(restoredCheckpoint)
      if (state.submitted !== null && job.provider_submitted_at === null) {
        await this.daemonClient.recordProviderSubmission({
          jobId: job.job_id,
          claimToken: job.claim_token,
          signal,
        })
      }
      const failOrFallback = async (failure: ClassifiedProviderFailure): Promise<never> => {
        throwIfStopped(signal, isCanceled, renewalError)
        const fallbackRequest = safeFallbackRequest(request, state, failure)
        if (!fallbackRequest) {
          throw classifiedFailureError(failure, providerFallbackStopReason(request, state, failure))
        }
        await this.daemonClient.fallbackJob({
          jobId: job.job_id,
          claimToken: job.claim_token,
          provider: fallbackRequest.provider,
          request: fallbackRequest,
          blocker: providerFailurePayload(job, failure, {
            requestedVisibility: claimBrowserVisibility,
            effectiveVisibility: managedContext.effectiveBrowserVisibility,
            windowOpen: claimBrowserVisibility !== 'headless',
          }),
        })
        throw new QueuedProviderFallback()
      }
      const startUrl = state.submitted?.providerUrl ?? request.target.url
      try {
        await navigateToTarget(
          page,
          provider,
          startUrl,
          signal,
          request.userHandoff,
        )
      } catch (error) {
        const failure = classifyProviderFailure({ error, submitted: state.submitted !== null })
        await failOrFallback(failure)
      }
      if (this.e2eInspection) {
        await waitForE2EBrowserObserver({
          config: this.e2eInspection,
          jobId: job.job_id,
          profileId: profile.id,
          profileDirectory: profile.directory,
          provider: request.provider,
          url: page.url(),
          targetId: await chromiumTargetId(managedContext.browserContext, page),
          signal,
        })
      }
      if (restoredCheckpoint && !state.submitted) {
        await reconstructCompletedPreSubmitActions(page, {
          provider,
          request,
          actionCursor: state.actionCursor,
          profile,
          job,
          attachmentRoot,
          signal,
          now: this.now,
        })
      }
      const clearBlocker = async (waitForGuestSurface = false): Promise<number> => {
        const cleared = await this.clearUserResolvableBlocker({
          managedContext,
          page,
          profile,
          job,
          request,
          pageKey,
          claimBrowserVisibility,
          provider,
          state,
          attachmentRoot,
          signal,
          isCanceled,
          renewalError,
          waitForGuestSurface,
        })
        managedContext = cleared.managedContext
        page = cleared.page
        return cleared.waitedMs
      }
      if (request.capabilityRoute && state.actionCursor === 0 && state.submitted === null) {
        let failure: ClassifiedProviderFailure | null
        try {
          await clearBlocker(true)
          failure = await inspectAttemptCapabilityEligibility(page, provider, request.capabilityRoute)
          throwIfStopped(signal, isCanceled, renewalError)
        } catch (error) {
          throwRunnerControlFlow(error)
          throwIfStopped(signal, isCanceled, renewalError)
          failure = classifyProviderFailure({ error, submitted: false })
        }
        if (failure) await failOrFallback(failure)
      }
      for (let actionIndex = state.actionCursor; actionIndex < request.actions.length; actionIndex += 1) {
        const action = request.actions[actionIndex]
        if (!action) throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner action cursor is invalid.')
        const lifecycle = getVisibleActionLifecycle(action.action)
        throwIfStopped(signal, isCanceled, renewalError)
        if (lifecycle.completion === 'records_submission') {
          try {
            await clearBlocker(true)
            state.preparation = await provider.prepareAction(page, action)
          } catch (error) {
            throwRunnerControlFlow(error)
            await failOrFallback(classifyProviderFailure({
              error,
              submitted: state.submitted !== null,
            }))
          }
        }
        if (lifecycle.completion === 'reads_response' && state.preparation !== null) {
          try {
            await this.waitForPreparedActionReady(() => page, {
              provider,
              action,
              preparation: state.preparation,
              pollMs: this.responseWaitPollMs,
              signal,
              isCanceled,
              renewalError,
              clearBlocker: () => clearBlocker(true),
            })
          } catch (error) {
            throwRunnerControlFlow(error)
            const failure = classifyProviderFailure({ error, submitted: state.submitted !== null, actionLifecycle: lifecycle })
            await failOrFallback(failure)
          }
        }
        if (
          lifecycle.gated &&
          lifecycle.completion !== 'records_submission' &&
          lifecycle.completion !== 'reads_response'
        ) {
          try {
            await clearBlocker(true)
          } catch (error) {
            throwRunnerControlFlow(error)
            await failOrFallback(classifyProviderFailure({
              error,
              submitted: state.submitted !== null,
            }))
          }
        }
        await this.checkpointJob(profile, job, request, state, checkpointPhaseForAction('started', actionIndex, action, page, provider))
        let capturedVisibleOutput: string | undefined
        const providerContext = {
          profileId: profile.id,
          operationId: job.job_id,
          signal,
          now: this.now,
          ...(outputSavingsEnabled
            ? { captureVisibleOutput: (text: string) => {
                capturedVisibleOutput = text
              } }
            : {}),
          ...(attachmentRoot === undefined ? {} : { attachmentRoot }),
        }
        const response = await (async (): Promise<VisibleActionResponse> => {
          try {
            return await provider.executeAction(page, action, providerContext)
          } catch (error) {
            return await failOrFallback(classifyProviderFailure({
              error,
              submitted: state.submitted !== null,
              actionLifecycle: lifecycle,
            }))
          }
        })()
        if (!response.ok) {
          throwIfStopped(signal, isCanceled, renewalError)
          const error = tokenlessError(response.error.code, response.error.message, { retryable: response.error.retryable })
          const failure = classifyProviderFailure({
            error,
            submitted: state.submitted !== null,
            actionLifecycle: lifecycle,
          })
          await failOrFallback(failure)
        }
        if (action.action === VISIBLE_ACTIONS.RESPONSE_READ && capturedVisibleOutput !== undefined) {
          outputSavingsWorkByRequestId.set(action.requestId, capturedVisibleOutput)
        }
        state.responses.push(response)
        if (lifecycle.completion === 'records_submission') {
          if (!state.preparation) {
            throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner did not prepare prompt submission completion.')
          }
          state.submitted = {
            actionIndex,
            requestId: action.requestId,
            providerUrl: validatedCurrentProviderUrl(page, provider, request.target.url),
            preparation: state.preparation,
          }
          await this.daemonClient.recordProviderSubmission({
            jobId: job.job_id,
            claimToken: job.claim_token,
            signal,
          })
        }
        if (lifecycle.completion === 'reads_response') state.preparation = null
        state.actionCursor = actionIndex + 1
        await this.checkpointJob(profile, job, request, state, checkpointPhaseForAction('completed', actionIndex, action, page, provider))
        if (action.action === VISIBLE_ACTIONS.WORKSPACE_ENSURE && isNativeWorkspaceResult(response.result)) {
          await this.daemonClient.upsertProviderProject({
            jobId: job.job_id,
            claimToken: job.claim_token,
            provider: request.provider,
            profileId: profile.id,
            resourceId: response.result.resource.id,
            name: response.result.name,
            canonicalUrl: response.result.resource.canonicalUrl,
            visibleProof: response.result.visibleProof,
            created: response.result.resource.disposition === 'created',
            signal,
          })
        }
        if (lifecycle.completion === 'reads_response' && request.taskId) {
          const workspace = latestNativeWorkspaceResult(state.responses)
          const conversationUrl = validatedConversationUrl(
            page.url(),
            provider,
            workspace?.resource.canonicalUrl ?? request.target.url,
          )
          if (conversationUrl) {
            await this.daemonClient.upsertProviderTaskConversation({
              jobId: job.job_id,
              claimToken: job.claim_token,
              provider: request.provider,
              profileId: profile.id,
              taskId: request.taskId,
              canonicalUrl: conversationUrl,
              signal,
            })
          }
          if (workspace && conversationUrl) {
            await this.daemonClient.upsertProviderConversation({
              jobId: job.job_id,
              claimToken: job.claim_token,
              provider: request.provider,
              profileId: profile.id,
              projectResourceId: workspace.resource.id,
              taskId: request.taskId,
              canonicalUrl: conversationUrl,
              signal,
            })
          }
        }
      }
      return state.responses
    })
    return {
      result: {
        protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
        provider: request.provider,
        responses,
      },
      outputSavingsWork: [...outputSavingsWorkByRequestId].map(([response_request_id, source_text]) => ({
        response_request_id,
        source_text,
      })),
    }
  }

  private async outputSavingsEnabled() {
    if (!this.homeDir) return false
    const config = await readTokenlessConfig(this.homeDir)
    return config.outputSavings.enabled
  }

  private async checkpointJob(
    profile: ManagedBrowserProfile,
    job: DaemonClaimedJob,
    request: ManagedPlaywrightJobRequest,
    state: RunnerExecutionState,
    phase: RunnerCheckpointPhase
  ) {
    await this.daemonClient.checkpointJob({
      jobId: job.job_id,
      claimToken: job.claim_token,
      checkpoint: buildRunnerCheckpoint(profile, job, request, state, phase),
    })
  }

  private async clearUserResolvableBlocker(options: {
    managedContext: ManagedBrowserContext
    page: Page
    profile: ManagedBrowserProfile
    job: DaemonClaimedJob
    request: ManagedPlaywrightJobRequest
    pageKey: string
    claimBrowserVisibility: BrowserVisibility
    provider: RunnerProvider
    state: RunnerExecutionState
    attachmentRoot: string | undefined
    signal: AbortSignal
    isCanceled: () => boolean
    renewalError: () => unknown
    waitForGuestSurface: boolean
  }): Promise<ClearBlockerResult> {
    throwIfStopped(options.signal, options.isCanceled, options.renewalError)
    const initial = await visibleBlockerState(
      options.page,
      options.provider,
      options.waitForGuestSurface,
      options.state.submitted !== null,
    )
    if (!initial.blocked) {
      return { managedContext: options.managedContext, page: options.page, waitedMs: 0 }
    }
    const failure = classifyVisibleProviderBlocker(initial.primary)
    const fallbackRequest = safeFallbackRequest(options.request, options.state, failure)
    if (fallbackRequest) {
      await this.daemonClient.fallbackJob({
        jobId: options.job.job_id,
        claimToken: options.job.claim_token,
        provider: fallbackRequest.provider,
        request: fallbackRequest,
        blocker: {
          ...blockerPayload(options.job, initial.blockers, {
            requestedVisibility: options.claimBrowserVisibility,
            effectiveVisibility: options.managedContext.effectiveBrowserVisibility,
            windowOpen: options.managedContext.effectiveBrowserVisibility === 'headed',
          }),
          failure,
        },
      })
      throw new QueuedProviderFallback()
    }
    const initialCapacityDelay = options.state.submitted === null
      ? observedCapacityDelaySeconds(initial.primary)
      : null
    if (initialCapacityDelay !== null) {
      await this.daemonClient.deferObservedProviderLimit({
        jobId: options.job.job_id,
        claimToken: options.job.claim_token,
        blocker: {
          ...blockerPayload(options.job, initial.blockers, {
            requestedVisibility: options.claimBrowserVisibility,
            effectiveVisibility: options.managedContext.effectiveBrowserVisibility,
            windowOpen: options.managedContext.effectiveBrowserVisibility === 'headed',
          }),
          failure,
          retryAfterSeconds: initialCapacityDelay,
        },
        delaySeconds: initialCapacityDelay,
        signal: options.signal,
      })
      throw new DeferredProviderCapacity()
    }
    if (initial.terminal) {
      throw classifiedFailureError(
        failure,
        providerFallbackStopReason(options.request, options.state, failure),
      )
    }
    const checkpoint = buildRunnerCheckpoint(
      options.profile,
      options.job,
      options.request,
      options.state,
      { state: 'idle' }
    )
    await this.daemonClient.checkpointJob({
      jobId: options.job.job_id,
      claimToken: options.job.claim_token,
      checkpoint,
    })
    if (
      options.claimBrowserVisibility === 'headless' ||
      this.e2eInspection ||
      isAutomaticAuthObservation(options.request, options.claimBrowserVisibility)
    ) {
      await this.daemonClient.parkJob({
        jobId: options.job.job_id,
        claimToken: options.job.claim_token,
        blocker: {
          ...blockerPayload(options.job, initial.blockers, {
            requestedVisibility: options.claimBrowserVisibility,
            effectiveVisibility: options.managedContext.effectiveBrowserVisibility,
            windowOpen: options.managedContext.effectiveBrowserVisibility === 'headed',
          }),
          failure,
          fallbackStopped: providerFallbackStopReason(options.request, options.state, failure),
        },
        checkpoint,
      })
      throw new ParkedPlaywrightJob()
    }
    let managedContext = options.managedContext
    let page = options.page
    if (options.claimBrowserVisibility === 'auto' && managedContext.effectiveBrowserVisibility === 'headless') {
      const url = trustedSwitchUrl(page, options.provider, options.request.target.url)
      managedContext = await managedContext.switchVisibility('headed')
      page = await managedContext.acquirePage({ key: options.pageKey, policy: options.request.pagePolicy ?? 'preserve' })
      await navigateToTarget(page, options.provider, url, options.signal, true)
      if (!options.state.submitted) {
        await reconstructCompletedPreSubmitActions(page, {
          provider: options.provider,
          request: options.request,
          actionCursor: options.state.actionCursor,
          profile: options.profile,
          job: options.job,
          attachmentRoot: options.attachmentRoot,
          signal: options.signal,
          now: this.now,
        })
      }
    } else {
      await bringToFrontForUserHandoff(page)
    }
    const startedAt = Date.now()
    await this.daemonClient.markJobWaitingForUser({
      jobId: options.job.job_id,
      claimToken: options.job.claim_token,
      blocker: {
        ...blockerPayload(options.job, initial.blockers, {
          requestedVisibility: options.claimBrowserVisibility,
          effectiveVisibility: managedContext.effectiveBrowserVisibility,
          windowOpen: true,
        }),
        failure,
        fallbackStopped: providerFallbackStopReason(options.request, options.state, failure),
      },
    })
    const deadline = Date.now() + this.userHandoverTimeoutMs
    while (Date.now() <= deadline) {
      throwIfStopped(options.signal, options.isCanceled, options.renewalError)
      await delay(Math.min(this.userHandoverPollMs, Math.max(1, deadline - Date.now())), options.signal)
      const latest = await visibleBlockerState(
        page,
        options.provider,
        options.waitForGuestSurface,
        options.state.submitted !== null,
      )
      if (latest.terminal) {
        const latestFailure = classifyVisibleProviderBlocker(latest.primary)
        const latestCapacityDelay = options.state.submitted === null
          ? observedCapacityDelaySeconds(latest.primary)
          : null
        if (latestCapacityDelay !== null) {
          await this.daemonClient.deferObservedProviderLimit({
            jobId: options.job.job_id,
            claimToken: options.job.claim_token,
            blocker: {
              ...blockerPayload(options.job, latest.blockers, {
                requestedVisibility: options.claimBrowserVisibility,
                effectiveVisibility: managedContext.effectiveBrowserVisibility,
                windowOpen: true,
              }),
              failure: latestFailure,
              retryAfterSeconds: latestCapacityDelay,
            },
            delaySeconds: latestCapacityDelay,
            signal: options.signal,
          })
          throw new DeferredProviderCapacity()
        }
        throw classifiedFailureError(
          latestFailure,
          providerFallbackStopReason(options.request, options.state, latestFailure),
        )
      }
      if (!latest.blocked && await hasStableComposer(
        page,
        options.provider,
        this.userHandoverPollMs,
        options.signal,
        options.isCanceled,
        options.renewalError
      )) {
        await this.daemonClient.markJobRunning({
          jobId: options.job.job_id,
          claimToken: options.job.claim_token,
        })
        return { managedContext, page, waitedMs: Date.now() - startedAt }
      }
    }
    throw tokenlessError(
      'playwright_user_handover_timeout',
      'Timed out waiting for the user to complete visible provider verification or sign-in in Chrome.',
      { retryable: true }
    )
  }

  private async waitForPreparedActionReady(
    getPage: () => Page,
    options: {
      provider: RunnerProvider
      action: VisibleActionRequest
      preparation: ProviderActionPreparation
      pollMs: number
      signal: AbortSignal
      isCanceled: () => boolean
      renewalError: () => unknown
      clearBlocker: () => Promise<number>
    }
  ) {
    while (true) {
      throwIfStopped(options.signal, options.isCanceled, options.renewalError)
      await options.clearBlocker()
      const page = getPage()
      if ((await options.provider.observeAction(page, options.action, options.preparation)).state === 'ready') return
      await delay(options.pollMs, options.signal)
    }
  }
}

async function chromiumTargetId(browserContext: BrowserContext, page: Page) {
  const session = await browserContext.newCDPSession(page)
  try {
    const result = await session.send('Target.getTargetInfo')
    return result.targetInfo.targetId
  } finally {
    await session.detach().catch(() => undefined)
  }
}

async function waitForChromiumTargetPages(
  browserContext: BrowserContext,
  targetIds: ReadonlySet<string>,
  timeoutMs: number,
) {
  const pagesByTargetId = new Map<string, Page>()
  const inspectedPages = new Set<Page>()
  const deadline = Date.now() + timeoutMs
  while (pagesByTargetId.size < targetIds.size && Date.now() <= deadline) {
    for (const page of browserContext.pages()) {
      if (page.isClosed() || inspectedPages.has(page)) continue
      try {
        const targetId = await chromiumTargetId(browserContext, page)
        inspectedPages.add(page)
        if (targetIds.has(targetId)) pagesByTargetId.set(targetId, page)
      } catch {
        if (page.isClosed()) inspectedPages.add(page)
      }
    }
    if (pagesByTargetId.size < targetIds.size) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())))
    }
  }
  return pagesByTargetId
}

export function serializeRunnerError(error: unknown) {
  const response = errorResponse(error)
  return {
    code: response.code,
    message: response.message,
    retryable: response.retryable,
    ...(response.details === undefined ? {} : { details: response.details }),
  }
}

export function isManagedPlaywrightClaimRecoveryFailure(error: unknown) {
  return isClaimRecoveryError(error)
}

class ParkedPlaywrightJob extends Error {
  constructor() {
    super('Managed Playwright job parked waiting for user.')
  }
}

class QueuedProviderFallback extends Error {
  constructor() {
    super('Managed Playwright job queued a provider fallback attempt.')
    this.name = 'QueuedProviderFallback'
  }
}

class DeferredProviderCapacity extends Error {
  constructor() {
    super('Managed Playwright job deferred until provider capacity is available.')
    this.name = 'DeferredProviderCapacity'
  }
}

function throwRunnerControlFlow(error: unknown): void {
  if (
    error instanceof ParkedPlaywrightJob ||
    error instanceof QueuedProviderFallback ||
    error instanceof DeferredProviderCapacity
  ) {
    throw error
  }
}

function initialExecutionState(): RunnerExecutionState {
  return { actionCursor: 0, responses: [], preparation: null, submitted: null }
}

function providerCapacityFailure(projection: ProviderCapacityProjection): ClassifiedProviderFailure {
  return Object.freeze({
    classification: 'safe_pre_submit_provider_failure',
    code: 'provider_capacity_deferred',
    message: projection.reason,
    retryable: true,
    providerScoped: true,
    automaticFallbackEligible: true,
    details: projection,
  })
}

function rateLimitSubscription(profile: ManagedBrowserProfile, provider: string) {
  const observed = profile.lastObservedAuth?.[provider]
  return {
    accessClass: observed?.account?.tier.class ?? observed?.access ?? 'unknown',
    tierLabel: observed?.account?.tier.label ?? null,
    subscriptionLabel: observed?.account?.subscription ?? null,
  }
}

function observedCapacityDelaySeconds(blocker: VisibleBlocker) {
  if (blocker.family === 'rate_limit') {
    return blocker.retryAfterSeconds === undefined
      ? 300
      : Math.min(3_600, Math.max(60, Math.floor(blocker.retryAfterSeconds)))
  }
  if (blocker.family === 'plan_limit') return 3_600
  return null
}

function safeFallbackRequest(
  request: ManagedPlaywrightJobRequest,
  state: RunnerExecutionState,
  failure: ClassifiedProviderFailure,
): ManagedPlaywrightJobRequest | null {
  const plan = request.fallback
  const alternative = plan?.alternatives[0]
  if (!plan || !alternative || !failure.automaticFallbackEligible || state.submitted !== null) return null
  for (let index = 0; index < state.actionCursor; index += 1) {
    const action = request.actions[index]
    if (!action) return null
    const lifecycle = getVisibleActionLifecycle(action.action)
    if (lifecycle.mutating && !lifecycle.reconstructablePreSubmit) return null
  }
  const remaining = plan.alternatives.slice(1)
  return validateManagedPlaywrightJobRequest({
    protocol: request.protocol,
    provider: alternative.provider,
    target: alternative.target,
    taskId: request.taskId,
    capabilityRoute: alternative.capabilityRoute,
    fallback: remaining.length === 0 ? null : { ...plan, alternatives: remaining },
    context: request.context,
    browserVisibility: request.browserVisibility,
    userHandoff: request.userHandoff,
    ...(request.pagePolicy === undefined ? {} : { pagePolicy: request.pagePolicy }),
    actions: request.actions.map((action) => ({ ...action, provider: alternative.provider })),
  })
}

function providerFallbackStopReason(
  request: ManagedPlaywrightJobRequest,
  state: RunnerExecutionState,
  failure: ClassifiedProviderFailure,
) {
  if (!request.fallback) return { code: 'fallback_plan_unavailable' }
  if (request.fallback.alternatives.length === 0) return { code: 'fallback_alternatives_exhausted' }
  if (state.submitted !== null) {
    return {
      code: 'post_submission_failure',
      provider: request.provider,
      submittedAction: state.submitted.requestId,
    }
  }
  if (!failure.automaticFallbackEligible) {
    return { code: 'unsafe_failure_classification', classification: failure.classification }
  }
  for (let index = 0; index < state.actionCursor; index += 1) {
    const action = request.actions[index]
    if (!action) return { code: 'invalid_action_cursor' }
    const lifecycle = getVisibleActionLifecycle(action.action)
    if (lifecycle.mutating && !lifecycle.reconstructablePreSubmit) {
      const response = state.responses[index]
      return {
        code: 'non_reconstructable_provider_mutation',
        provider: request.provider,
        action: action.action,
        requestId: action.requestId,
        completedResult: response?.ok === true ? response.result : null,
      }
    }
  }
  return { code: 'fallback_not_selected' }
}

function classifiedFailureError(
  failure: ClassifiedProviderFailure,
  fallbackStopped: ReturnType<typeof providerFallbackStopReason>,
) {
  return tokenlessError(failure.code, failure.message, {
    retryable: failure.retryable,
    details: {
      classification: failure.classification,
      providerScoped: failure.providerScoped,
      fallbackStopped,
      ...(failure.details === undefined ? {} : { causeDetails: failure.details }),
    },
  })
}

async function inspectAttemptCapabilityEligibility(
  page: Page,
  provider: RunnerProvider,
  route: TaskCapabilityRoute,
): Promise<ClassifiedProviderFailure | null> {
  const inspection = await provider.inspectCapabilities(page)
  const observations = route.requirements.map((capability) => {
    const target = liveInspectionTarget(capability)
    if (!target) {
      return {
        capability,
        availability: 'unavailable' as const,
        visibleProof: null,
        reason: 'task_capability_live_inspection_unimplemented',
      }
    }
    const providerInspection = inspection.capabilities[target.providerCapability]
    const observed = target.scope === 'native' ? providerInspection?.native : providerInspection
    return {
      capability,
      availability: observed?.availability ?? 'unknown',
      visibleProof: observed?.visibleProof ?? null,
      reason: observed?.reason ?? null,
    }
  })
  const unavailable = observations.filter((observation) => observation.availability === 'unavailable')
  if (unavailable.length === 0) return null
  return classifyProviderFailure({
    error: tokenlessError(
      'provider_capability_unavailable',
      `Provider '${provider.id}' cannot currently satisfy every required task capability.`,
      {
        retryable: true,
        details: {
          provider: provider.id,
          requirements: route.requirements,
          unavailable,
          observations,
        },
      },
    ),
    submitted: false,
  })
}

function liveInspectionTarget(capability: TaskCapabilityId): {
  providerCapability: ProviderCapabilityId
  scope: 'overall' | 'native'
} | null {
  if (capability === TASK_CAPABILITIES.CONVERSATION_CHAT) {
    return { providerCapability: PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE, scope: 'overall' }
  }
  if (capability === TASK_CAPABILITIES.FILE_UPLOAD) {
    return { providerCapability: PROVIDER_CAPABILITIES.FILE_UPLOAD, scope: 'overall' }
  }
  if (capability === TASK_CAPABILITIES.WORKSPACE_NATIVE) {
    return { providerCapability: PROVIDER_CAPABILITIES.WORKSPACE_ENSURE, scope: 'native' }
  }
  if (capability === TASK_CAPABILITIES.WORKSPACE_INSTRUCTIONS || capability === TASK_CAPABILITIES.WORKSPACE_KNOWLEDGE) {
    return { providerCapability: PROVIDER_CAPABILITIES.WORKSPACE_ENSURE, scope: 'native' }
  }
  if (capability === TASK_CAPABILITIES.SEARCH_WEB) {
    return { providerCapability: PROVIDER_CAPABILITIES.KIMI_SEARCH, scope: 'overall' }
  }
  if (capability === TASK_CAPABILITIES.SOURCE_CONNECTED) {
    return { providerCapability: PROVIDER_CAPABILITIES.KIMI_PLUGIN, scope: 'overall' }
  }
  if (new Set<TaskCapabilityId>([
    TASK_CAPABILITIES.RESEARCH_DEEP,
    TASK_CAPABILITIES.DOCUMENT_GENERATION,
    TASK_CAPABILITIES.PRESENTATION_GENERATION,
    TASK_CAPABILITIES.SPREADSHEET_GENERATION,
    TASK_CAPABILITIES.WEBSITE_GENERATION,
    TASK_CAPABILITIES.RESPONSE_CITATIONS,
    TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
    TASK_CAPABILITIES.TASK_BACKGROUND,
    TASK_CAPABILITIES.TASK_INTERACTIVE,
    TASK_CAPABILITIES.TASK_PARALLEL,
  ]).has(capability)) {
    return { providerCapability: PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE, scope: 'overall' }
  }
  return null
}

function validateResumeVisibility(value: unknown): Extract<BrowserVisibility, 'headed'> | null {
  if (value === null || value === undefined) return null
  if (!isPlainRecord(value) || value.browser_visibility !== 'headed') {
    throw tokenlessError('invalid_playwright_job_resume', 'Managed Playwright job resume payload is invalid.')
  }
  return 'headed'
}

function requestedVisibilityForClaim(
  requestVisibility: BrowserVisibility,
  resumeVisibility: Extract<BrowserVisibility, 'headed'> | null
): BrowserVisibility {
  return resumeVisibility === 'headed' ? 'headed' : requestVisibility
}

function isAutomaticAuthObservation(
  request: ManagedPlaywrightJobRequest,
  claimBrowserVisibility: BrowserVisibility,
) {
  return claimBrowserVisibility === 'auto' && request.actions.every((action) => (
    action.action === VISIBLE_ACTIONS.AUTH_STATUS
  ))
}

function validateRunnerCheckpoint(
  value: unknown,
  profile: ManagedBrowserProfile,
  job: DaemonClaimedJob,
  request: ManagedPlaywrightJobRequest
): RunnerCheckpoint | null {
  if (value === null || value === undefined) return null
  if (!isPlainRecord(value) || value.protocol !== RUNNER_CHECKPOINT_SCHEMA_ID) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint is invalid.')
  }
  const expectedKeys = ['protocol', 'jobId', 'profileId', 'provider', 'targetUrl', 'browserVisibility', 'actionCursor', 'responses', 'preparation', 'submitted', 'phase']
  if (!hasExactKeys(value, expectedKeys)) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint fields are invalid.')
  }
  const provider = getProviderInstanceById(request.provider)
  if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
  const rawActionCursor = value.actionCursor
  if (typeof rawActionCursor !== 'number' || !Number.isInteger(rawActionCursor) || rawActionCursor < 0 || rawActionCursor > request.actions.length) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint cursor is invalid.')
  }
  const actionCursor = rawActionCursor as number
  if (
    value.jobId !== job.job_id ||
    value.profileId !== profile.id ||
    value.provider !== request.provider ||
    value.targetUrl !== request.target.url ||
    value.browserVisibility !== request.browserVisibility
  ) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint does not match the claimed job.')
  }
  if (!Array.isArray(value.responses) || value.responses.length !== actionCursor) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint responses are invalid.')
  }
  const responses = value.responses.map((response, index) => validateCheckpointResponse(response, request.actions[index], index))
  const preparation = validateCheckpointPreparation(value.preparation, provider)
  const submitted = validateSubmittedCheckpoint(value.submitted, request, provider)
  const phase = validateCheckpointPhase(value.phase, request)
  if (phase.state === 'started' && phase.mutating) {
    throw tokenlessError(
      'ambiguous_action_outcome',
      'Managed Playwright checkpoint stopped during a mutating action; refusing to replay it.',
      { retryable: false }
    )
  }
  const completedSubmitIndex = responses.findIndex((response) => response.action === VISIBLE_ACTIONS.PROMPT_SUBMIT)
  if (completedSubmitIndex >= 0 && !submitted) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint is missing submit state.')
  }
  const firstSubmitIndex = request.actions.findIndex((action) => action.action === VISIBLE_ACTIONS.PROMPT_SUBMIT)
  if (!submitted && firstSubmitIndex >= 0 && actionCursor > firstSubmitIndex) {
    throw tokenlessError(
      'ambiguous_action_outcome',
      'Managed Playwright checkpoint advanced past prompt.submit without trusted submit state.',
      { retryable: false }
    )
  }
  return {
    protocol: RUNNER_CHECKPOINT_SCHEMA_ID,
    jobId: job.job_id,
    profileId: profile.id,
    provider: request.provider,
    targetUrl: request.target.url,
    browserVisibility: request.browserVisibility,
    actionCursor,
    responses,
    preparation,
    submitted,
    phase,
  }
}

function validateCheckpointResponse(
  value: unknown,
  action: VisibleActionRequest | undefined,
  index: number
): VisibleActionResponse {
  if (
    !action ||
    !isPlainRecord(value) ||
    !isVisibleActionProtocolVersion(value.protocol) ||
    value.ok !== true
  ) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint response is invalid.')
  }
  if (value.requestId !== action.requestId || value.provider !== action.provider || value.action !== action.action || value.error !== null) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', `Managed Playwright runner checkpoint response ${index} does not match the job action.`)
  }
  if (!isPlainRecord(value.result)) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint response result is invalid.')
  }
  return value as VisibleActionResponse
}

function validateSubmittedCheckpoint(
  value: unknown,
  request: ManagedPlaywrightJobRequest,
  provider: RunnerProvider
): RunnerSubmittedActionCheckpoint | null {
  if (value === null) return null
  if (!isPlainRecord(value)) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner submit checkpoint is invalid.')
  }
  if (!hasExactKeys(value, ['actionIndex', 'requestId', 'providerUrl', 'preparation'])) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner submit checkpoint fields are invalid.')
  }
  const rawActionIndex = value.actionIndex
  const actionIndex = typeof rawActionIndex === 'number' && Number.isInteger(rawActionIndex) ? rawActionIndex : -1
  const action = request.actions[actionIndex]
  if (!action || action.action !== VISIBLE_ACTIONS.PROMPT_SUBMIT || value.requestId !== action.requestId) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner submit checkpoint does not match the job action.')
  }
  if (typeof value.providerUrl !== 'string') {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner submit checkpoint URL is invalid.')
  }
  const providerUrl = validateProviderUrl(value.providerUrl, provider)
  const preparation = validateCheckpointPreparation(value.preparation, provider)
  if (!preparation) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner submit checkpoint preparation is invalid.')
  }
  return {
    actionIndex,
    requestId: action.requestId,
    providerUrl,
    preparation,
  }
}

function validateCheckpointPreparation(value: unknown, provider: RunnerProvider): ProviderActionPreparation | null {
  if (value === null) return null
  try {
    return provider.validatePreparation(value as ProviderActionPreparation, { action: VISIBLE_ACTIONS.RESPONSE_READ })
  } catch {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint preparation is invalid.')
  }
}

function validateCheckpointPhase(value: unknown, request: ManagedPlaywrightJobRequest): RunnerCheckpointPhase {
  if (!isPlainRecord(value) || typeof value.state !== 'string') {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint phase is invalid.')
  }
  if (value.state === 'idle') return { state: 'idle' }
  if (value.state !== 'started' && value.state !== 'completed') {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint phase state is invalid.')
  }
  const rawActionIndex = value.actionIndex
  const actionIndex = typeof rawActionIndex === 'number' && Number.isInteger(rawActionIndex) ? rawActionIndex : -1
  const action = request.actions[actionIndex]
  if (!action || value.requestId !== action.requestId || value.action !== action.action || typeof value.mutating !== 'boolean') {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint phase action is invalid.')
  }
  if (value.providerUrl !== null && typeof value.providerUrl !== 'string') {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint phase URL is invalid.')
  }
  return {
    state: value.state,
    actionIndex,
    requestId: action.requestId,
    action: action.action,
    mutating: value.mutating,
    providerUrl: value.providerUrl,
  }
}

function executionStateFromCheckpoint(checkpoint: RunnerCheckpoint | null): RunnerExecutionState {
  return checkpoint
    ? {
      actionCursor: checkpoint.actionCursor,
      responses: [...checkpoint.responses],
      preparation: checkpoint.submitted ? checkpoint.submitted.preparation : checkpoint.preparation,
      submitted: checkpoint.submitted,
    }
    : {
      actionCursor: 0,
      responses: [],
      preparation: null,
      submitted: null,
    }
}

function buildRunnerCheckpoint(
  profile: ManagedBrowserProfile,
  job: DaemonClaimedJob,
  request: ManagedPlaywrightJobRequest,
  state: RunnerExecutionState,
  phase: RunnerCheckpointPhase
): RunnerCheckpoint {
  return {
    protocol: RUNNER_CHECKPOINT_SCHEMA_ID,
    jobId: job.job_id,
    profileId: profile.id,
    provider: request.provider,
    targetUrl: request.target.url,
    browserVisibility: request.browserVisibility,
    actionCursor: state.actionCursor,
    responses: state.responses,
    preparation: state.preparation,
    submitted: state.submitted,
    phase,
  }
}

function checkpointPhaseForAction(
  state: Extract<RunnerCheckpointPhase['state'], 'started' | 'completed'>,
  actionIndex: number,
  action: VisibleActionRequest,
  page: Page,
  provider: RunnerProvider
): RunnerCheckpointPhase {
  return {
    state,
    actionIndex,
    requestId: action.requestId,
    action: action.action,
    mutating: getVisibleActionLifecycle(action.action).mutating,
    providerUrl: maybeProviderUrl(page, provider),
  }
}

async function reconstructCompletedPreSubmitActions(
  page: Page,
  options: {
    provider: RunnerProvider
    request: ManagedPlaywrightJobRequest
    actionCursor: number
    profile: ManagedBrowserProfile
    job: DaemonClaimedJob
    attachmentRoot: string | undefined
    signal: AbortSignal
    now: () => Date
  }
) {
  for (let index = 0; index < options.actionCursor; index += 1) {
    const action = options.request.actions[index]
    if (!action) throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint cursor is invalid.')
    if (action.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) {
      throw tokenlessError(
        'ambiguous_action_outcome',
        'Managed Playwright checkpoint would replay prompt.submit; refusing duplicate submission.',
        { retryable: false }
      )
    }
    if (!getVisibleActionLifecycle(action.action).reconstructablePreSubmit) continue
    const response = await options.provider.executeAction(page, action, {
      profileId: options.profile.id,
      operationId: options.job.job_id,
      signal: options.signal,
      now: options.now,
      ...(options.attachmentRoot === undefined ? {} : { attachmentRoot: options.attachmentRoot }),
    })
    if (!response.ok) {
      throw tokenlessError(response.error.code, response.error.message, { retryable: response.error.retryable })
    }
  }
}

function trustedSwitchUrl(
  page: Page,
  provider: RunnerProvider,
  fallbackUrl: string
) {
  const pageUrl = currentPageUrl(page)
  if (!pageUrl) return validateProviderUrl(fallbackUrl, provider)
  const classification = provider.navigation.classify(pageUrl)
  if (classification.kind === 'approved') return classification.target.href
  if (classification.kind === 'trusted_sign_in') {
    return validateProviderUrl(fallbackUrl, provider)
  }
  throw tokenlessError('unsupported_provider_navigation', 'Cannot resume managed Playwright job from an unsafe provider URL.', { retryable: false })
}

function validatedCurrentProviderUrl(
  page: Page,
  provider: RunnerProvider,
  fallbackUrl: string
) {
  const providerUrl = maybeProviderUrl(page, provider)
  return providerUrl ?? validateProviderUrl(fallbackUrl, provider)
}

function maybeProviderUrl(page: Page, provider: RunnerProvider) {
  const pageUrl = currentPageUrl(page)
  if (!pageUrl) return null
  const classification = provider.navigation.classify(pageUrl)
  return classification.kind === 'approved' ? classification.target.href : null
}

function validateProviderUrl(value: string, provider: RunnerProvider) {
  const target = provider.navigation.canonicalTarget(value)
  if (!target) {
    throw tokenlessError('invalid_playwright_runner_checkpoint', 'Managed Playwright runner checkpoint URL is not a trusted provider URL.')
  }
  return target.href
}

async function bringToFrontForUserHandoff(page: Page) {
  const maybePage = page as { bringToFront?: () => Promise<unknown> }
  if (typeof maybePage.bringToFront === 'function') {
    await maybePage.bringToFront()
  }
}

async function navigateToTarget(
  page: Page,
  provider: RunnerProvider,
  url: string,
  signal: AbortSignal,
  userHandoff: boolean,
) {
  throwIfStopped(signal, () => false)
  if (!canReuseCurrentProviderPage(page, provider, url)) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    } catch (error) {
      if (signal.aborted) throwIfStopped(signal, () => false)
      if (String(error).includes('net::ERR_NAME_NOT_RESOLVED')) {
        throw tokenlessError(
          'provider_dns_unavailable',
          'The provider hostname could not be resolved by the current system DNS configuration.',
          {
            retryable: true,
            cause: error,
            details: dnsUnavailableDetails(url),
          }
        )
      }
      throw tokenlessError(
        'provider_navigation_unavailable',
        'The provider page could not be reached before any provider action started.',
        {
          retryable: true,
          cause: error,
          details: { url: new URL(url).origin, evidence: 'chromium_navigation_failed' },
        },
      )
    }
  }
  if (userHandoff) await bringToFrontForUserHandoff(page)
}

function canReuseCurrentProviderPage(page: Page, provider: RunnerProvider, targetUrl: string) {
  const current = provider.navigation.classify(page.url())
  if (current.kind !== 'approved') return false
  const target = provider.navigation.canonicalTarget(targetUrl)
  if (!target) return false
  if (current.target.href === target.href) return true
  return target.href === provider.navigation.homeTarget().href && provider.navigation.pagePatterns.some((pattern) => {
    const declared = provider.navigation.canonicalTarget(pattern.urlPattern)
    if (!declared || declared.origin.toLowerCase() !== current.target.origin.toLowerCase()) return false
    const currentSegments = current.target.pathname.split('/').filter(Boolean)
    const declaredSegments = declared.pathname.split('/').filter(Boolean)
    return currentSegments.length === declaredSegments.length && declaredSegments.every((segment, index) => (
      segment.startsWith(':') ? currentSegments[index] !== '' : segment === currentSegments[index]
    ))
  })
}

function dnsUnavailableDetails(url: string) {
  const hostname = new URL(url).hostname
  if (hostname === 'chat.qwen.ai') {
    return {
      hostname,
      networkFailure: 'dns_resolution',
      accessClassification: 'suspected_rate_limit',
      rateLimitConfirmed: false,
      evidence: 'chromium_name_not_resolved',
    }
  }
  return {
    hostname,
    networkFailure: 'dns_resolution',
    accessClassification: 'network_unavailable',
    rateLimitConfirmed: false,
    evidence: 'chromium_name_not_resolved',
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

async function visibleBlockerState(
  page: Page,
  provider: RunnerProvider,
  waitForGuestSurface: boolean,
  submissionRecorded: boolean,
) {
  const pageUrl = currentPageUrl(page)
  const classification = provider.navigation.classify(pageUrl)
  const navigationBlocker = blockerFromNavigationClassification(classification, provider)
  if (navigationBlocker) {
    return {
      blocked: true,
      terminal: false,
      primary: navigationBlocker,
      blockers: [navigationBlocker],
    }
  }
  if (classification.kind !== 'approved' || typeof (page as { evaluate?: unknown }).evaluate !== 'function') {
    return {
      blocked: false,
      terminal: false,
      primary: fallbackBlocker(page, provider),
      blockers: [],
    }
  }
  if (submissionRecorded) {
    const inspection = await provider.inspectBlockers(page)
    const terminal = inspection.blockers.find((blocker) => blocker.kind === 'terminal')
    const userResolvable = inspection.blockers.find((blocker) => blocker.kind !== 'terminal')
    return {
      blocked: inspection.blocked,
      terminal: Boolean(terminal),
      primary: terminal ?? userResolvable ?? inspection.blockers[0] ?? fallbackBlocker(page, provider),
      blockers: inspection.blockers,
    }
  }
  const resolution = await provider.resolveSession(page, {
    waitForReadyMs: waitForGuestSurface ? 15_000 : 0,
  })
  const decision = resolution.decision
  const blockers = decision.kind === 'handoff' || decision.kind === 'terminal'
    ? [decision.blocker]
    : []
  const terminal = decision.kind === 'terminal' ? decision.blocker : undefined
  const userResolvable = decision.kind === 'handoff' ? decision.blocker : undefined
  return {
    blocked: Boolean(userResolvable || terminal),
    terminal: Boolean(terminal),
    primary: terminal ?? userResolvable ?? blockers[0] ?? fallbackBlocker(page, provider),
    blockers,
  }
}

async function hasStableComposer(
  page: Page,
  provider: RunnerProvider,
  pollMs: number,
  signal: AbortSignal,
  isCanceled: () => boolean,
  renewalError: () => unknown
) {
  if (!await provider.hasVisibleComposer(page)) return false
  await delay(Math.min(Math.max(pollMs, 50), 500), signal)
  throwIfStopped(signal, isCanceled, renewalError)
  return await provider.hasVisibleComposer(page)
}

function blockerPayload(
  job: DaemonClaimedJob,
  blockers: readonly VisibleBlocker[],
  browser: {
    requestedVisibility: BrowserVisibility
    effectiveVisibility: Exclude<BrowserVisibility, 'auto'>
    windowOpen: boolean
  }
) {
  const primary = blockers.find((blocker) => blocker.userResolvable) ?? blockers[0] ?? null
  return {
    protocol: USER_HANDOVER_SCHEMA_ID,
    jobId: job.job_id,
    taskId: taskIdFromRequest(job.request_json),
    provider: job.provider,
    profileId: job.profile_id,
    browser,
    blocker: primary,
    blockers,
    userAction: {
      message: browser.windowOpen
        ? 'Your help is needed: complete provider sign-in or verification in the visible browser. Tokenless will resume the same unfinished action after the composer is stable.'
        : 'Your help is needed, but no browser window is open. Resume this same job in headed mode to complete provider verification.',
    },
  }
}

function providerFailurePayload(
  job: DaemonClaimedJob,
  failure: ClassifiedProviderFailure,
  browser: {
    requestedVisibility: BrowserVisibility
    effectiveVisibility: Exclude<BrowserVisibility, 'auto'>
    windowOpen: boolean
  },
) {
  return {
    protocol: 'tokenless.provider-attempt-failure.v1',
    jobId: job.job_id,
    taskId: taskIdFromRequest(job.request_json),
    provider: job.provider,
    profileId: job.profile_id,
    browser,
    failure,
    blocker: {
      kind: 'terminal',
      code: failure.code,
      message: failure.message,
      userResolvable: false,
      retryable: failure.retryable,
      visibleProof: 'structured-provider-attempt-failure',
      provider: job.provider,
      url: null,
    },
  }
}

function taskIdFromRequest(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const record = value as { taskId?: unknown }
  return typeof record.taskId === 'string' ? record.taskId : null
}

function managedPageKey(job: DaemonClaimedJob, request: ManagedPlaywrightJobRequest) {
  return JSON.stringify([
    request.provider,
    request.taskId === null ? 'job' : 'task',
    request.taskId ?? job.job_id,
  ])
}

function providerOwnsPage(
  provider: NonNullable<ReturnType<typeof getProviderInstanceById>>,
  page: Page,
) {
  const classification = provider.navigation.classify(page.url())
  return classification.kind === 'approved' || classification.kind === 'trusted_sign_in'
}

function providerTabOpenFailure(provider: string, error: unknown) {
  return {
    provider,
    code: 'provider_tab_open_failed' as const,
    message: errorResponse(error).message,
  }
}

function fallbackBlocker(page: Page, provider: RunnerProvider): VisibleBlocker {
  const pageUrl = currentPageUrl(page)
  return {
    kind: 'auth',
    code: 'provider_user_handover_required',
    message: 'Provider sign-in or verification requires user support.',
    userResolvable: true,
    retryable: true,
    visibleProof: 'visible-page-state',
    provider: provider.id,
    url: sanitizedNavigationOrigin(provider, pageUrl),
  }
}

function blockerFromNavigationClassification(
  classification: ReturnType<RunnerProvider['navigation']['classify']>,
  provider: RunnerProvider
): VisibleBlocker | null {
  if (classification.kind !== 'trusted_sign_in') return null
  return {
    kind: 'auth',
    code: 'provider_sign_in_navigation',
    message: 'Provider sign-in navigation is visible and requires the user.',
    userResolvable: true,
    retryable: true,
    visibleProof: 'visible-provider-sign-in-navigation',
    provider: provider.id,
    url: classification.origin,
    family: 'provider_sign_in',
  }
}

function currentPageUrl(page: Page) {
  try {
    return typeof (page as { url?: unknown }).url === 'function'
      ? (page as { url: () => string }).url()
      : ''
  } catch {
    return ''
  }
}

function sanitizedNavigationOrigin(provider: RunnerProvider, value: string) {
  const classification = provider.navigation.classify(value)
  if (classification.kind === 'approved') return classification.target.origin
  if (classification.kind === 'trusted_sign_in') return classification.origin
  return ''
}

function isNativeWorkspaceResult(value: unknown): value is NativeWorkspaceEnsureResult {
  if (!isPlainRecord(value) || value.mode !== 'native') return false
  const resource = isPlainRecord(value.resource) ? value.resource : null
  return resource?.kind === 'project' &&
    resource.native === true &&
    typeof resource.id === 'string' &&
    typeof resource.canonicalUrl === 'string' &&
    (resource.disposition === 'created' || resource.disposition === 'reused')
}

function latestNativeWorkspaceResult(responses: readonly VisibleActionResponse[]) {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index]
    if (response?.ok && response.action === VISIBLE_ACTIONS.WORKSPACE_ENSURE && isNativeWorkspaceResult(response.result)) {
      return response.result
    }
  }
  return null
}

function validatedConversationUrl(
  value: string,
  provider: RunnerProvider,
  projectUrl: string,
) {
  const target = provider.navigation.assertCurrentPageAllowed(value)
  if (!target) return null
  const canonical = new URL(target.href)
  canonical.search = ''
  canonical.hash = ''
  const href = canonical.toString()
  return href === projectUrl ? null : href
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(input).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
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
