import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  errorResponse,
  tokenlessError,
} from './errors.js'
import { USER_HANDOVER_SCHEMA_ID } from '../schema-ids.js'
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
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
  validateManagedPlaywrightJobRequest,
} from './job-contract.js'
import { getVisibleActionLifecycle } from '../providers/action-catalog.js'
import {
  classifyProviderFailure,
  classifyVisibleProviderBlocker,
  type ClassifiedProviderFailure,
} from './provider-failure-classification.js'
import {
  createVisibleActionRequest,
  VISIBLE_ACTIONS,
  VISIBLE_ACTION_SCHEMA_ID,
} from './actions.js'
import { ManagedProfileRegistry } from './profiles/registry.js'
import { type BrowserTabGcConfig, readTokenlessConfig } from '../persistence/config.js'
import { PROVIDER_CAPABILITIES, TASK_CAPABILITIES, getProviderInstanceById } from '../providers/registry.js'
import { readChatGptBrowserSession, sendDirectChatGptMessage } from '../providers/direct/chatgpt.js'
import { sendDirectPerplexityMessage } from '../providers/direct/perplexity.js'
import type {
  ManagedBrowserContext,
  ManagedBrowserProfile,
  ManagedProviderPage,
  PersistentContextManager as PersistentContextManagerType,
} from './browser/context-manager.js'
import type { DaemonJob, ManagedDaemonClient, PostSubmissionFallbackProof } from './daemon-client.js'
import type { ManagedPlaywrightJobRequest } from './job-contract.js'
import type { ProviderCapabilityId, ProviderId, TaskCapabilityId, TaskCapabilityRoute } from '../providers/registry.js'
import type { BrowserVisibility } from '../browser-visibility.js'
import type { VisibleActionRequest } from './actions.js'
import type {
  ProviderChoiceObservation,
  ProviderModelObservation,
  ProviderSubmissionObservation,
  PromptSubmitResult,
  VisibleActionMetadata,
  VisibleActionResponse,
} from './actions.js'
import type { ResponseReadResult } from './actions.js'
import type { VisibleActionResult } from './actions.js'
import type { VisibleBlocker } from './actions.js'
import type { NativeWorkspaceEnsureResult } from './actions.js'
import type { ProviderActionPreparation } from '../providers/contracts.js'
import type { ProviderCapacityProjection } from '../providers/rate-limit-policy.js'
import type { BrowserContext, Page } from 'playwright-core'
import type { G4fServiceClient } from '../providers/direct/g4f/client.js'
import { ProviderProtocolRouter } from '../providers/direct/protocol-router.js'
import { g4fProviderName, isG4fDirectOnlyProvider } from '../providers/direct/g4f-map.js'
import { persistDirectImageAsset } from './image-assets.js'
import { OutputSavingsRuntimeManager } from '../output-savings/runtime-manager.js'

export type ManagedPlaywrightRunnerServiceOptions = {
  homeDir?: string | undefined
  profileRegistry?: ManagedProfileSource | undefined
  daemonClient: ManagedDaemonClient
  contextManager?: PersistentContextManagerType | undefined
  browser?: ManagedBrowserLaunchTarget | undefined
  browserResolver?: ManagedBrowserResolver | undefined
  tabGc?: BrowserTabGcConfig
  pollIdleMs?: number | undefined
  cancelPollMs?: number | undefined
  responseWaitPollMs?: number | undefined
  userHandoverTimeoutMs?: number | undefined
  userHandoverPollMs?: number | undefined
  attachmentRootForJob?: ((job: DaemonJob) => string | undefined | Promise<string | undefined>) | undefined
  cleanupAttachmentRoot?: boolean | undefined
  now?: (() => Date) | undefined
  g4fClient?: G4fServiceClient | undefined
}

export type ManagedProfileSource = {
  listProfiles(): Promise<ManagedBrowserProfile[]>
}

export type ManagedPlaywrightRunnerIteration =
  | { taken: false }
  | { taken: true, jobId: string, status: 'succeeded' | 'failed' | 'canceled' | 'waiting_for_user' }

export type ManagedPlaywrightJobResult = {
  protocol: typeof MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID
  provider: string
  responses: readonly VisibleActionResponse[]
}

type ManagedPlaywrightExecutionOutcome = {
  result: ManagedPlaywrightJobResult
  conversationSaved?: boolean
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

type RunnerSubmittedAction = {
  actionIndex: number
  requestId: string
  providerUrl: string
  preparation: ProviderActionPreparation
}

type RunnerExecutionState = {
  actionCursor: number
  responses: VisibleActionResponse[]
  preparation: ProviderActionPreparation | null
  submitted: RunnerSubmittedAction | null
}

type RunnerProvider = NonNullable<ReturnType<typeof getProviderInstanceById>>

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
  private readonly cancelPollMs: number
  private readonly responseWaitPollMs: number
  private readonly userHandoverTimeoutMs: number
  private readonly userHandoverPollMs: number
  private readonly attachmentRootForJob: ((job: DaemonJob) => string | undefined | Promise<string | undefined>) | undefined
  private readonly cleanupAttachmentRoot: boolean
  private readonly now: () => Date
  private readonly e2eInspection: E2EBrowserInspectionConfig | null
  private readonly homeDir: string | undefined
  private readonly protocolRouter: ProviderProtocolRouter
  private readonly g4fClient: G4fServiceClient | undefined
  private readonly outputSavingsRuntimeManager: OutputSavingsRuntimeManager | undefined
  private readonly inFlightJobs = new Set<Promise<void>>()
  private stopped = false

  constructor(options: ManagedPlaywrightRunnerServiceOptions) {
    this.homeDir = options.homeDir === undefined ? undefined : path.resolve(options.homeDir)
    this.g4fClient = options.g4fClient
    this.protocolRouter = new ProviderProtocolRouter(options.g4fClient)
    this.outputSavingsRuntimeManager = this.homeDir === undefined
      ? undefined
      : new OutputSavingsRuntimeManager(this.homeDir)
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
            profileColor: config.profiles[profile.slug]?.profileColor,
            proxy: config.profiles[profile.slug]?.proxy ?? null,
          }))
        },
      }
    }
    this.daemonClient = options.daemonClient
    this.contextManager = options.contextManager ?? new PersistentContextManager({
      supervision: {
        profiles: () => this.profileRegistry.listProfiles(),
        recoverPage: (profile, page) => this.daemonClient.findProviderTaskConversationByUrl(profile.slug, page.url()),
        observePage: async (providerId, page) => {
          const provider = getProviderInstanceById(providerId)
          if (!provider || provider.navigation.classify(page.url()).kind !== 'approved' ||
            provider.navigation.canonicalTarget(page.url())?.href === provider.navigation.homeTarget().href) return null
          return await provider.observeTabActivity(page)
        },
      },
      ...(options.tabGc ? { tabGc: options.tabGc } : {}),
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.browserResolver ? { browserResolver: options.browserResolver } : {}),
    })
    this.pollIdleMs = normalizedPositiveInteger(options.pollIdleMs, DEFAULT_POLL_IDLE_MS)
    this.cancelPollMs = normalizedPositiveInteger(options.cancelPollMs, DEFAULT_CANCEL_POLL_MS)
    this.responseWaitPollMs = normalizedPositiveInteger(options.responseWaitPollMs, DEFAULT_RESPONSE_WAIT_POLL_MS)
    this.userHandoverTimeoutMs = normalizedPositiveInteger(options.userHandoverTimeoutMs, DEFAULT_USER_HANDOVER_TIMEOUT_MS)
    this.userHandoverPollMs = normalizedPositiveInteger(options.userHandoverPollMs, DEFAULT_USER_HANDOVER_POLL_MS)
    const defaultAttachmentHomeDir = options.homeDir
    this.attachmentRootForJob = options.attachmentRootForJob ?? (
      defaultAttachmentHomeDir ? (job) => defaultAttachmentRootForJob(defaultAttachmentHomeDir, job) : undefined
    )
    this.cleanupAttachmentRoot = options.cleanupAttachmentRoot ?? true
    this.now = options.now ?? (() => new Date())
    this.e2eInspection = resolveE2EBrowserInspectionConfig(options.homeDir)
  }

  stop() {
    this.stopped = true
  }

  activeJobCount() {
    return this.inFlightJobs.size
  }

  configureTabGc(config: BrowserTabGcConfig) {
    this.contextManager.configureTabGc(config)
  }

  tabGcStatus() {
    return this.contextManager.tabGcStatus()
  }

  activeProfileCount() {
    return this.contextManager.activeProfileIds().length
  }

  async closeProfile(profileId: string) {
    const profile = (await this.profileRegistry.listProfiles()).find((candidate) => candidate.slug === profileId)
    if (!profile) throw tokenlessError('profile_not_found', `Managed profile '${profileId}' is not registered.`)
    try {
      await this.contextManager.ensureContext(profile, 'auto', true)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'browser_endpoint_unavailable') throw error
    }
    await this.contextManager.closeProfile(profileId)
  }

  async openProfile(profileId: string, browserVisibility: BrowserVisibility): Promise<ManagedProfileOpenResult> {
    const profile = (await this.profileRegistry.listProfiles())
      .find((candidate) => candidate.slug === profileId)
    if (!profile) {
      throw tokenlessError('profile_not_found', 'Managed profile is not registered or is not ready.')
    }
    const managedContext = await this.contextManager.ensureContext(profile, browserVisibility)
    let pages = managedContext.browserContext.pages()
    if (pages.length === 0) {
      await managedContext.acquirePage({ key: `tokenless:profile-open:${profile.slug}` })
      pages = managedContext.browserContext.pages()
    }
    if (pages[0] && managedContext.effectiveBrowserVisibility === 'headed') {
      await bringToFrontForUserHandoff(pages[0])
    }
    return {
      profileId: profile.slug,
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
      .find((candidate) => candidate.slug === profileId)
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
    const tabs: ManagedProviderTabsOpenResult['tabs'][number][] = []
    const failures: ManagedProviderTabsOpenResult['failures'][number][] = []
    for (const provider of providers) {
      if (!provider.descriptor.executionModes.includes('browser')) {
        failures.push({
          provider: provider.id,
          code: 'provider_tab_open_failed',
          message: 'Provider exposes direct execution only and has no browser tab.',
        })
        continue
      }
      let providerPage: ManagedProviderPage | null = null
      try {
        providerPage = await managedContext.acquireProviderPage({
          provider: provider.id,
          pageRef: providerHomePageRef(provider.id),
          purpose: 'user',
          policy: 'preserve',
          matchesExistingPage: (page) => providerOwnsPage(provider, page),
          isAvailablePage: (page) => providerPageAvailable(provider, page),
        })
        const alreadyOnProvider = providerOwnsPage(provider, providerPage.page)
        if (!alreadyOnProvider) {
          await providerPage.page.goto(provider.descriptor.navigation.entryUrl, { waitUntil: 'commit' })
        }
        tabs.push({
          provider: provider.id,
          url: provider.descriptor.navigation.entryUrl,
          reused: providerPage.reused || alreadyOnProvider,
        })
      } catch (error) {
        failures.push(providerTabOpenFailure(provider.id, error))
      }
    }
    const providerOrder = new Map(providerIds.map((provider, index) => [provider, index]))
    tabs.sort((left, right) => (providerOrder.get(left.provider) ?? 0) - (providerOrder.get(right.provider) ?? 0))
    failures.sort((left, right) => (providerOrder.get(left.provider) ?? 0) - (providerOrder.get(right.provider) ?? 0))
    return {
      profileId: profile.slug,
      browserVisibility: managedContext.browserVisibility,
      effectiveBrowserVisibility: managedContext.effectiveBrowserVisibility,
      pageCount: managedContext.browserContext.pages().length,
      tabs,
      failures,
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
      await Promise.allSettled([...this.inFlightJobs])
    }
  }

  async runOnce(signal?: AbortSignal | undefined): Promise<ManagedPlaywrightRunnerIteration> {
    if (this.stopped || signal?.aborted) return { taken: false }
    const profiles = await this.availableProfiles()
    for (const profile of profiles) {
      const selected = await this.daemonClient.takeNextJob({
        profileId: profile.slug,
        jobIdPrefix: this.e2eInspection ? e2eInspectionJobPrefix(this.e2eInspection) : undefined,
        signal,
      })
      if (selected.job) return await this.executeJob(profile, selected.job, signal)
    }
    return { taken: false }
  }

  private async startAvailableJobs(signal?: AbortSignal | undefined) {
    let started = 0
    const profiles = await this.availableProfiles()
    for (const profile of profiles) {
      if (this.stopped || signal?.aborted) break
      const selected = await this.daemonClient.takeNextJob({
        profileId: profile.slug,
        jobIdPrefix: this.e2eInspection ? e2eInspectionJobPrefix(this.e2eInspection) : undefined,
        signal,
      })
      if (!selected.job) continue
      const jobPromise = this.executeJob(profile, selected.job, signal)
        .then(() => undefined)
        .finally(() => {
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

  private async executeJob(
    profile: ManagedBrowserProfile,
    job: DaemonJob,
    outerSignal?: AbortSignal | undefined,
    priorSubmissionResponses: readonly VisibleActionResponse[] = [],
  ): Promise<ManagedPlaywrightRunnerIteration> {
    const controller = new AbortController()
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal
    let canceled = false
    let idle = false
    const pageUses: ManagedProviderPage[] = []
    let attachmentRoot: string | undefined
    let providerAttachmentRoot: string | undefined
    const cancelTimer = setInterval(() => {
      void this.daemonClient.getJob({ jobId: job.job_id }).then((latest) => {
        if (latest.status === 'canceled') {
          canceled = true
          controller.abort()
        }
      }).catch(() => undefined)
    }, this.cancelPollMs)

    try {
      const request = this.validateJob(profile, job)
      if (
        request.executionMode === 'browser' &&
        job.provider_submitted_at === null
      ) {
        const subscription = rateLimitSubscription(profile, job.provider)
        const projection = await this.daemonClient.projectJobProviderCapacity({
          jobId: job.job_id,
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
              provider: fallbackRequest.provider,
              request: fallbackRequest,
              blocker: { code: 'provider_capacity_unavailable', projection, failure },
              signal,
            })
            throw new ProviderFallbackSignal()
          }
          throw tokenlessError(
            'provider_capacity_unavailable',
            'Provider capacity is unavailable for this request and no fallback can run now.',
            { retryable: false, details: projection },
          )
        }
      }
      attachmentRoot = await this.attachmentRootForJob?.(job)
      if (attachmentRoot) {
        assertSafeAttachmentCleanupRoot(attachmentRoot, job.job_id)
        providerAttachmentRoot = path.dirname(attachmentRoot)
      }
      const execution = await this.executeActions(
        profile,
        job,
        request,
        providerAttachmentRoot,
        signal,
        () => canceled,
        pageUses,
      )
      if (canceled || signal.aborted) {
        return { taken: true, jobId: job.job_id, status: 'canceled' }
      }
      const measuredResult = await this.measureOutputSavings(execution.result, signal)
      const result = prependSubmissionEvidenceResponses(measuredResult, priorSubmissionResponses)
      await this.daemonClient.completeJob({
        jobId: job.job_id,
        result,
      })
      const finalWork = request.actions.map((action) => getVisibleActionLifecycle(action.action))
        .filter((lifecycle) => lifecycle.mutating || lifecycle.completion === 'reads_response').at(-1)
      idle = !request.userHandoff && finalWork?.completion === 'reads_response' &&
        (request.executionMode === 'direct' || execution.conversationSaved === true)
      return { taken: true, jobId: job.job_id, status: 'succeeded' }
    } catch (error) {
      if (error instanceof ProviderFallbackSignal) {
        attachmentRoot = undefined
        const fallbackJob = await this.daemonClient.getJob({ jobId: job.job_id, signal })
        return await this.executeJob(
          profile,
          fallbackJob,
          outerSignal,
          [...priorSubmissionResponses, ...error.submissionResponses],
        )
      }
      if (canceled || signal.aborted) {
        return { taken: true, jobId: job.job_id, status: 'canceled' }
      }
      if (signal.aborted) {
        return { taken: true, jobId: job.job_id, status: 'canceled' }
      }
      await this.daemonClient.completeJob({
        jobId: job.job_id,
        error: serializeRunnerError(error),
      }).catch(() => undefined)
      return { taken: true, jobId: job.job_id, status: 'failed' }
    } finally {
      for (const page of pageUses) page.release(idle)
      clearInterval(cancelTimer)
      controller.abort()
      if (attachmentRoot && this.cleanupAttachmentRoot) {
        await fs.rm(attachmentRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  private async measureOutputSavings(
    result: ManagedPlaywrightJobResult,
    signal: AbortSignal,
  ): Promise<ManagedPlaywrightJobResult> {
    const manager = this.outputSavingsRuntimeManager
    if (!manager || !this.homeDir) return result
    let enabled = false
    try {
      enabled = (await readTokenlessConfig(this.homeDir)).outputSavings.enabled
    } catch {
      return result
    }
    if (!enabled) return result

    let changed = false
    const responses: VisibleActionResponse[] = []
    for (const response of result.responses) {
      if (!response.ok || response.action !== VISIBLE_ACTIONS.RESPONSE_READ) {
        responses.push(response)
        continue
      }
      const responseResult = response.result as ResponseReadResult
      if (typeof responseResult.text !== 'string' || responseResult.text.length === 0) {
        responses.push(response)
        continue
      }
      try {
        const measurement = await manager.measure(responseResult.text, { signal, installIfMissing: true })
        if (measurement.state !== 'measured') {
          responses.push(response)
          continue
        }
        changed = true
        responses.push({
          ...response,
          result: { ...responseResult, outputSavings: measurement },
        })
      } catch {
        responses.push(response)
      }
    }
    return changed ? { ...result, responses } : result
  }

  private async availableProfiles(): Promise<ManagedBrowserProfile[]> {
    const profiles = await this.profileRegistry.listProfiles()
    const activeProfileIds = new Set(this.contextManager.activeProfileIds())
    let remainingNewProfileSlots = MAX_ACTIVE_BROWSER_PROFILES - activeProfileIds.size
    const available: ManagedBrowserProfile[] = []
    for (const profile of profiles) {
      if (activeProfileIds.has(profile.slug)) {
        available.push(profile)
        continue
      }
      if (remainingNewProfileSlots <= 0) continue
      remainingNewProfileSlots -= 1
      available.push(profile)
    }
    return available
  }

  private validateJob(profile: ManagedBrowserProfile, job: DaemonJob): ManagedPlaywrightJobRequest {
    if (job.profile_id !== profile.slug) {
      throw tokenlessError('invalid_playwright_job_profile', 'Managed Playwright runner taken a job for a different profile.')
    }
    const request = validateManagedPlaywrightJobRequest(job.request_json)
    if (request.provider !== job.provider) {
      throw tokenlessError('invalid_playwright_job_provider', 'Managed Playwright job provider does not match daemon metadata.')
    }
    return request
  }

  private async executeActions(
    profile: ManagedBrowserProfile,
    job: DaemonJob,
    request: ManagedPlaywrightJobRequest,
    attachmentRoot: string | undefined,
    signal: AbortSignal,
    isCanceled: () => boolean,
    pageUses: ManagedProviderPage[],
  ): Promise<ManagedPlaywrightExecutionOutcome> {
    if (request.executionMode === 'direct') {
      const config = await readTokenlessConfig(this.homeDir)
      const backend = this.protocolRouter.backend(
        config.directProvider,
        request.provider,
        request.providerBackend ?? undefined,
      )
      if (backend === 'g4f') {
        if (request.context.requirements.includes('image.generation')) {
          return await this.executeG4fDirectImageActions(profile, job, request, signal, isCanceled, pageUses)
        }
        return await this.executeG4fDirectChatActions(profile, job, request, signal, isCanceled, pageUses)
      }
      return await this.executeDirectChatActions(profile, job, request, signal, isCanceled, pageUses)
    }
    const requestedBrowserVisibility = request.browserVisibility
    const automaticAuthObservation = isAutomaticAuthObservation(request, requestedBrowserVisibility)
    let conversationSaved = false
    const operation = async (initialManagedContext: ManagedBrowserContext) => {
      const managedContext = initialManagedContext
      const pageRef = managedPageRef(job, request)
      const provider = getProviderInstanceById(request.provider)
      if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
      const temporaryPage = automaticAuthObservation ? await managedContext.acquireTemporaryPage() : null
      const providerPage = temporaryPage === null
        ? await managedContext.acquireProviderPage({
            provider: provider.id,
            pageRef,
            policy: request.pagePolicy,
            matchesExistingPage: (candidate) => providerOwnsPage(provider, candidate),
            isAvailablePage: (candidate) => providerPageAvailable(provider, candidate),
          })
        : null
      if (providerPage) pageUses.push(providerPage)
      const acquiredPage = temporaryPage?.page ?? providerPage?.page
      if (!acquiredPage) {
        throw tokenlessError('playwright_provider_page_unavailable', 'Managed provider page is unavailable.', { retryable: true })
      }
      const page: Page = acquiredPage
      try {
        const state = initialExecutionState()
      if (state.submitted !== null && job.provider_submitted_at === null) {
        await this.daemonClient.recordProviderSubmission({
          jobId: job.job_id,
          signal,
        })
      }
      const failOrFallback = async (failure: ClassifiedProviderFailure): Promise<never> => {
        throwIfStopped(signal, isCanceled)
        const fallbackRequest = safeFallbackRequest(request, state, failure)
        const postSubmissionFallbackProof = providerRejectionFallbackProof(request, state, failure)
        if (!fallbackRequest) {
          throw classifiedFailureError(failure, providerFallbackStopReason(request, state, failure))
        }
        await this.daemonClient.fallbackJob({
          jobId: job.job_id,
          provider: fallbackRequest.provider,
          request: fallbackRequest,
          blocker: providerFailurePayload(job, failure, {
            requestedVisibility: requestedBrowserVisibility,
            effectiveVisibility: managedContext.effectiveBrowserVisibility,
            windowOpen: requestedBrowserVisibility !== 'headless',
          }),
          ...(postSubmissionFallbackProof === null ? {} : { postSubmissionFallbackProof }),
        })
        throw new ProviderFallbackSignal(submissionEvidenceResponses(state.responses))
      }
      const savedConversation = request.pagePolicy !== 'replace' && !request.userHandoff && provider.navigation.canonicalTarget(request.target.url)?.href === provider.navigation.homeTarget().href
        ? await this.daemonClient.resolveProviderTaskConversation({ provider: request.provider, profileId: profile.slug, taskId: request.taskId ?? pageRef, signal })
        : null
      const startUrl = state.submitted?.providerUrl ?? savedConversation?.canonical_url ?? request.target.url
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
          pageRefHash: createHash('sha256').update(JSON.stringify([request.provider, pageRef])).digest('base64url').slice(0, 20),
          reusedPageBinding: providerPage?.reused ?? false,
          profileId: profile.slug,
          profileDirectory: profile.directory,
          provider: request.provider,
          url: page.url(),
          targetId: await chromiumTargetId(managedContext.browserContext, page),
          signal,
        })
      }
      const clearBlocker = async (waitForGuestSurface = false): Promise<number> => {
        return await this.clearUserResolvableBlocker({
          managedContext,
          page,
          job,
          request,
          requestedBrowserVisibility,
          provider,
          state,
          signal,
          isCanceled,
          waitForGuestSurface,
        })
      }
      if (request.capabilityRoute && state.actionCursor === 0 && state.submitted === null) {
        let failure: ClassifiedProviderFailure | null
        try {
          await clearBlocker(true)
          failure = await inspectAttemptCapabilityEligibility(page, provider, request.capabilityRoute)
          throwIfStopped(signal, isCanceled)
        } catch (error) {
          throwRunnerControlFlow(error)
          throwIfStopped(signal, isCanceled)
          failure = classifyProviderFailure({ error, submitted: false })
        }
        if (failure) await failOrFallback(failure)
      }
      for (let actionIndex = state.actionCursor; actionIndex < request.actions.length; actionIndex += 1) {
        const action = request.actions[actionIndex]
        if (!action) throw tokenlessError('invalid_playwright_runner_state', 'Managed Playwright runner action cursor is invalid.')
        const lifecycle = getVisibleActionLifecycle(action.action)
        throwIfStopped(signal, isCanceled)
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
        const providerContext = {
          profileId: profile.slug,
          operationId: job.job_id,
          jobId: job.job_id,
          taskId: request.taskId,
          requirements: request.capabilityRoute?.requirements ?? request.context.requirements,
          ...(lifecycle.completion === 'reads_response' && state.preparation !== null
            ? { responsePreparation: state.preparation }
            : {}),
          ...(request.pagePolicy === 'replace' ? { resetPromptDraft: true } : {}),
          signal,
          now: this.now,
          ...(attachmentRoot === undefined ? {} : { attachmentRoot }),
          ...(this.homeDir === undefined ? {} : { assetRoot: path.join(this.homeDir, 'assets') }),
        }
        const submissionObservation = action.action === VISIBLE_ACTIONS.PROMPT_SUBMIT && isBenchmarkSubmissionEvidenceRequest(request)
          ? await observeProviderSubmission(
              page,
              provider,
              request.actions,
              actionIndex,
              signal,
              this.now,
              profile.slug,
              job.job_id,
            )
          : null
        const actionStartedAt = this.now()
        const admission = await this.daemonClient.admitProviderAction({ jobId: job.job_id, actionIndex, signal })
        if (admission?.decision === 'defer') await failOrFallback(providerCapacityFailure(admission))
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
        const actionCompletedAt = this.now()
        const responseWithMetadata = withVisibleActionMetadata(
          response,
          {
            actionIndex,
            provider: provider.id,
            startedAt: actionStartedAt.toISOString(),
            completedAt: actionCompletedAt.toISOString(),
            durationMs: Math.max(0, actionCompletedAt.getTime() - actionStartedAt.getTime()),
            executionMode: 'browser',
          },
          submissionObservation,
        )
        if (!response.ok) {
          throwIfStopped(signal, isCanceled)
          const error = tokenlessError(response.error.code, response.error.message, {
            retryable: response.error.retryable,
            ...(response.error.details === undefined ? {} : { details: response.error.details }),
          })
          const failure = classifyProviderFailure({
            error,
            submitted: state.submitted !== null,
            actionLifecycle: lifecycle,
          })
          await failOrFallback(failure)
        }
        state.responses.push(responseWithMetadata)
        if (lifecycle.completion === 'records_submission') {
          if (!state.preparation) {
            throw tokenlessError('invalid_playwright_runner_state', 'Managed Playwright runner did not prepare prompt submission completion.')
          }
          state.submitted = {
            actionIndex,
            requestId: action.requestId,
            providerUrl: validatedCurrentProviderUrl(page, provider, request.target.url),
            preparation: state.preparation,
          }
          await this.daemonClient.recordProviderSubmission({
            jobId: job.job_id,
            signal,
          })
        }
        if (lifecycle.completion === 'reads_response') state.preparation = null
        state.actionCursor = actionIndex + 1
        if (action.action === VISIBLE_ACTIONS.WORKSPACE_ENSURE && response.ok && isNativeWorkspaceResult(response.result)) {
          await this.daemonClient.upsertProviderProject({
            provider: request.provider,
            profileId: profile.slug,
            resourceId: response.result.resource.id,
            name: response.result.name,
            canonicalUrl: response.result.resource.canonicalUrl,
            signal,
          })
        }
        const isGrokImagineResult = request.provider === 'grok' &&
          request.context.requirements.includes('image.generation')
        if (lifecycle.completion === 'reads_response' && !isGrokImagineResult) {
          const workspace = latestNativeWorkspaceResult(state.responses)
          const conversationUrl = validatedConversationUrl(
            page.url(),
            provider,
            workspace?.resource.canonicalUrl ?? provider.navigation.homeTarget().href,
          )
          if (conversationUrl) {
            await this.daemonClient.upsertProviderTaskConversation({
              provider: request.provider,
              profileId: profile.slug,
              ...(workspace ? { projectResourceId: workspace.resource.id } : {}),
              taskId: request.taskId ?? pageRef,
              canonicalUrl: conversationUrl,
              signal,
            })
            conversationSaved = true
          }
        }
      }
        return state.responses
      } finally {
        await temporaryPage?.close()
      }
    }
    const responses = await this.contextManager.runWithProfile(profile, requestedBrowserVisibility, operation)
    return {
      conversationSaved,
      result: {
        protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
        provider: request.provider,
        responses,
      },
    }
  }

  private async executeDirectChatActions(
    profile: ManagedBrowserProfile,
    job: DaemonJob,
    request: ManagedPlaywrightJobRequest,
    signal: AbortSignal,
    isCanceled: () => boolean,
    pageUses: ManagedProviderPage[],
  ): Promise<ManagedPlaywrightExecutionOutcome> {
    const state = initialExecutionState()
    const promptAction = request.actions[0]
    if (promptAction?.action !== VISIBLE_ACTIONS.PROMPT_INPUT || typeof promptAction.payload.text !== 'string') {
      throw tokenlessError('direct_action_unsupported', 'Direct execution requires one text prompt.')
    }
    const prompt = promptAction.payload.text
    const requestedBrowserVisibility = request.browserVisibility
    const provider = getProviderInstanceById(request.provider)
    if (!provider || (provider.id !== 'chatgpt' && provider.id !== 'perplexity')) {
      throw tokenlessError('direct_provider_unsupported', 'Direct execution currently supports only the ChatGPT and Perplexity providers.')
    }

    const responses = await this.contextManager.runWithProfile(profile, requestedBrowserVisibility, async (managedContext) => {
      const providerPage = await managedContext.acquireProviderPage({
        provider: provider.id,
        pageRef: managedPageRef(job, request),
        policy: request.pagePolicy,
        matchesExistingPage: (candidate) => providerOwnsPage(provider, candidate),
        isAvailablePage: (candidate) => providerPageAvailable(provider, candidate),
      })
      pageUses.push(providerPage)
      const page = providerPage.page
      let directResult: Awaited<ReturnType<typeof sendDirectChatGptMessage>> | null = null
      await navigateToTarget(page, provider, request.target.url, signal, false)
      for (let actionIndex = state.actionCursor; actionIndex < request.actions.length; actionIndex += 1) {
        const action = request.actions[actionIndex]
        if (!action) throw tokenlessError('invalid_playwright_runner_state', 'Managed Playwright runner action cursor is invalid.')
        throwIfStopped(signal, isCanceled)

        let response: VisibleActionResponse
        if (action.action === VISIBLE_ACTIONS.PROMPT_INPUT) {
          response = directActionSuccess(action, {
            visible: true,
            inputProof: 'direct-protocol-prompt-cached-in-memory',
          })
        } else if (action.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) {
          const preparation = await provider.prepareAction(page, action)
          if (!preparation) {
            throw tokenlessError('direct_response_preparation_failed', 'Direct response preparation is unavailable.')
          }
          state.preparation = preparation
          const sendDirectMessage = provider.id === 'chatgpt'
            ? sendDirectChatGptMessage
            : sendDirectPerplexityMessage
          directResult = await sendDirectMessage({
            page,
            browserContext: managedContext.browserContext,
            prompt,
            ...(profile.proxy?.server ? { proxy: profile.proxy.server } : {}),
            signal,
          })
          response = directActionSuccess(action, {
            visible: true,
            submissionProof: 'direct-protocol-conversation-request-completed',
          })
          state.submitted = {
            actionIndex,
            requestId: action.requestId,
            providerUrl: validatedCurrentProviderUrl(page, provider, request.target.url),
            preparation,
          }
          await this.daemonClient.recordProviderSubmission({
            jobId: job.job_id,
            signal,
          })
        } else if (action.action === VISIBLE_ACTIONS.RESPONSE_READ) {
          if (!directResult) {
            throw tokenlessError('direct_response_unavailable', 'Direct response is unavailable in the current runner process.')
          }
          response = directActionSuccess(action, {
            text: directResult.text,
            citations: directResult.citations,
            visibleProof: 'direct-protocol-sse-response',
            decisionDiagnostics: {
              selected: null,
              visibleAnswerCount: 0,
              visibleBusyCount: 0,
              generationStopVisible: false,
            },
          })
          state.preparation = null
        } else {
          throw tokenlessError('direct_action_unsupported', `Direct execution does not support action '${action.action}'.`)
        }

        state.responses.push(response)
        state.actionCursor = actionIndex + 1
      }
      return state.responses
    })
    return {
      result: {
        protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
        provider: request.provider,
        responses,
      },
    }
  }

  private async executeG4fDirectChatActions(
    profile: ManagedBrowserProfile,
    job: DaemonJob,
    request: ManagedPlaywrightJobRequest,
    signal: AbortSignal,
    isCanceled: () => boolean,
    pageUses: ManagedProviderPage[],
  ): Promise<ManagedPlaywrightExecutionOutcome> {
    const promptAction = request.actions[0]
    const submitAction = request.actions[1]
    const readAction = request.actions[2]
    if (
      promptAction?.action !== VISIBLE_ACTIONS.PROMPT_INPUT ||
      typeof promptAction.payload.text !== 'string' ||
      submitAction?.action !== VISIBLE_ACTIONS.PROMPT_SUBMIT ||
      readAction?.action !== VISIBLE_ACTIONS.RESPONSE_READ
    ) {
      throw tokenlessError('direct_action_unsupported', 'G4F direct execution requires prompt.input, prompt.submit, and response.read.')
    }
    throwIfStopped(signal, isCanceled)
    let ephemeralContextId: string | undefined
    let authContextId = request.authContextId ?? undefined
    try {
      if (!authContextId && !isG4fDirectOnlyProvider(request.provider)) {
        authContextId = await this.createG4fBrowserAuthContext(profile, job, request, signal, pageUses)
        ephemeralContextId = authContextId
      }
      const completion = await this.protocolRouter.completeG4f({
        provider: request.provider,
        messages: [{ role: 'user', content: promptAction.payload.text }],
        ...(authContextId ? { authContextId } : {}),
        signal,
      })
      throwIfStopped(signal, isCanceled)
      await this.daemonClient.recordProviderSubmission({
        jobId: job.job_id,
        signal,
      })
      const responses: VisibleActionResponse[] = [
        directActionSuccess(promptAction, {
          visible: true,
          inputProof: 'g4f-direct-protocol-prompt-cached-in-memory',
        }),
        directActionSuccess(submitAction, {
          visible: true,
          submissionProof: 'g4f-private-service-request-completed',
        }),
        directActionSuccess(readAction, {
          text: completion.text,
          citations: completion.citations.map((citation) => ({
            label: citation.title ?? citation.url,
            href: citation.url,
          })),
          visibleProof: 'g4f-private-service-response',
          decisionDiagnostics: {
            selected: null,
            visibleAnswerCount: 0,
            visibleBusyCount: 0,
            generationStopVisible: false,
          },
        }),
      ]
      return {
        result: {
          protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
          provider: request.provider,
          responses,
        },
      }
    } finally {
      if (ephemeralContextId) await this.deleteG4fAuthContext(ephemeralContextId)
    }
  }

  private async executeG4fDirectImageActions(
    profile: ManagedBrowserProfile,
    job: DaemonJob,
    request: ManagedPlaywrightJobRequest,
    signal: AbortSignal,
    isCanceled: () => boolean,
    pageUses: ManagedProviderPage[],
  ): Promise<ManagedPlaywrightExecutionOutcome> {
    const promptAction = request.actions[0]
    const submitAction = request.actions[1]
    const readAction = request.actions[2]
    if (
      promptAction?.action !== VISIBLE_ACTIONS.PROMPT_INPUT ||
      typeof promptAction.payload.text !== 'string' ||
      submitAction?.action !== VISIBLE_ACTIONS.PROMPT_SUBMIT ||
      readAction?.action !== VISIBLE_ACTIONS.RESPONSE_READ
    ) {
      throw tokenlessError('direct_action_unsupported', 'Direct image execution requires prompt.input, prompt.submit, and response.read.')
    }
    if (!this.homeDir) {
      throw tokenlessError('image_asset_root_unavailable', 'The managed image asset directory is unavailable.')
    }
    throwIfStopped(signal, isCanceled)
    let ephemeralContextId: string | undefined
    let authContextId = request.authContextId ?? undefined
    try {
      if (!authContextId && !isG4fDirectOnlyProvider(request.provider)) {
        authContextId = await this.createG4fBrowserAuthContext(profile, job, request, signal, pageUses)
        ephemeralContextId = authContextId
      }
      let images: Awaited<ReturnType<ProviderProtocolRouter['generateImageG4f']>>
      try {
        images = await this.protocolRouter.generateImageG4f({
          provider: request.provider,
          prompt: promptAction.payload.text,
          model: 'gpt-image',
          ...(authContextId ? { authContextId } : {}),
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        throw tokenlessError('direct_image_generation_failed', 'Direct image generation failed.', {
          retryable: true,
          cause: error,
          details: { diagnostic: directImageFailureDiagnostic(error) },
        })
      }
      throwIfStopped(signal, isCanceled)
      await this.daemonClient.recordProviderSubmission({
        jobId: job.job_id,
        signal,
      })
      const conversationId = `chatgpt-gpt-image-${job.job_id}`
      const artifacts = await Promise.all(images.map((image, index) => persistDirectImageAsset(image.bytes, {
        assetRoot: path.join(this.homeDir!, 'assets'),
        jobId: job.job_id,
        taskId: request.taskId,
        provider: 'chatgpt',
        conversationId,
        signal,
      }, index)))
      const responses: VisibleActionResponse[] = [
        directActionSuccess(promptAction, {
          visible: true,
          inputProof: 'direct-protocol-prompt-cached-in-memory',
        }),
        directActionSuccess(submitAction, {
          visible: true,
          submissionProof: 'direct-image-generation-request-completed',
        }),
        directActionSuccess(readAction, {
          text: '',
          citations: [],
          artifacts,
          visibleProof: 'direct-chatgpt-image-artifacts-read',
          decisionDiagnostics: {
            selected: null,
            visibleAnswerCount: 0,
            visibleBusyCount: 0,
            generationStopVisible: false,
          },
        }),
      ]
      return {
        result: {
          protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
          provider: request.provider,
          responses,
        },
      }
    } finally {
      if (ephemeralContextId) await this.deleteG4fAuthContext(ephemeralContextId)
    }
  }

  private async createG4fBrowserAuthContext(
    profile: ManagedBrowserProfile,
    job: DaemonJob,
    request: ManagedPlaywrightJobRequest,
    signal: AbortSignal,
    pageUses: ManagedProviderPage[],
  ) {
    const client = this.g4fClient
    const provider = getProviderInstanceById(request.provider)
    const upstreamProvider = g4fProviderName(request.provider)
    if (!client || !provider || !upstreamProvider) return undefined
    const requestedBrowserVisibility = request.browserVisibility
    return await this.contextManager.runWithProfile(profile, requestedBrowserVisibility, async (managedContext) => {
      const providerPage = await managedContext.acquireProviderPage({
        provider: provider.id,
        pageRef: `${managedPageRef(job, request)}:g4f-auth`,
        policy: request.pagePolicy,
        matchesExistingPage: (candidate) => providerOwnsPage(provider, candidate),
        isAvailablePage: (candidate) => providerPageAvailable(provider, candidate),
      })
      pageUses.push(providerPage)
      const contextId = `g4f-${job.job_id}-${randomUUID()}`
      let creationAttempted = false
      try {
        await navigateToTarget(providerPage.page, provider, request.target.url, signal, false)
        const providerCookies = await managedContext.browserContext.cookies([request.target.url])
        const cookies: Record<string, Record<string, string>> = {}
        for (const cookie of providerCookies) {
          const domain = cookie.domain.toLowerCase()
          cookies[domain] ??= {}
          cookies[domain]![cookie.name] = cookie.value
        }
        const browserValues = await providerPage.page.evaluate(() => ({
          userAgent: navigator.userAgent,
          language: navigator.language || 'en-US',
        }))
        const headers = {
          [new URL(request.target.url).hostname]: {
            'user-agent': browserValues.userAgent,
            'accept-language': `${browserValues.language},en;q=0.8`,
          },
        }
        let apiKey: string | undefined
        if (provider.id === 'chatgpt') {
          const session = await readChatGptBrowserSession(providerPage.page, managedContext.browserContext)
          apiKey = session.accessToken
        }
        creationAttempted = true
        await client.createAuthContext({
          contextId,
          provider: upstreamProvider,
          profile: profile.slug,
          lifetime: 'ephemeral',
          source: { type: 'manual', cookies, headers, ...(apiKey ? { apiKey } : {}) },
        }, signal)
        return contextId
      } catch (error) {
        if (creationAttempted) await this.deleteG4fAuthContext(contextId, error)
        throw error
      }
    })
  }

  private async deleteG4fAuthContext(contextId: string, operationError?: unknown) {
    try {
      await this.g4fClient?.deleteAuthContext(contextId)
    } catch (cleanupError) {
      throw tokenlessError(
        'direct_auth_context_cleanup_failed',
        'Direct provider auth context cleanup failed.',
        {
          retryable: true,
          cause: operationError === undefined
            ? cleanupError
            : new AggregateError([operationError, cleanupError]),
        },
      )
    }
  }

  private async clearUserResolvableBlocker(options: {
    managedContext: ManagedBrowserContext
    page: Page
    job: DaemonJob
    request: ManagedPlaywrightJobRequest
    requestedBrowserVisibility: BrowserVisibility
    provider: RunnerProvider
    state: RunnerExecutionState
    signal: AbortSignal
    isCanceled: () => boolean
    waitForGuestSurface: boolean
  }): Promise<number> {
    throwIfStopped(options.signal, options.isCanceled)
    const initial = await visibleBlockerState(
      options.page,
      options.provider,
      options.waitForGuestSurface,
      options.state.submitted !== null,
    )
    if (!initial.blocked) {
      return 0
    }
    const failure = classifyVisibleProviderBlocker(initial.primary)
    const fallbackRequest = safeFallbackRequest(options.request, options.state, failure)
    const postSubmissionFallbackProof = providerRejectionFallbackProof(options.request, options.state, failure)
    if (fallbackRequest) {
      await this.daemonClient.fallbackJob({
        jobId: options.job.job_id,
        provider: fallbackRequest.provider,
        request: fallbackRequest,
        blocker: {
          ...blockerPayload(options.job, initial.blockers, {
            requestedVisibility: options.requestedBrowserVisibility,
            effectiveVisibility: options.managedContext.effectiveBrowserVisibility,
            windowOpen: options.managedContext.effectiveBrowserVisibility === 'headed',
          }),
          failure,
        },
        ...(postSubmissionFallbackProof === null ? {} : { postSubmissionFallbackProof }),
      })
      throw new ProviderFallbackSignal(submissionEvidenceResponses(options.state.responses))
    }
    const initialCapacityDelay = options.state.submitted === null
      ? observedCapacityDelaySeconds(initial.primary)
      : null
    if (initialCapacityDelay !== null) {
      throw classifiedFailureError(failure, {
        code: 'provider_capacity_unavailable',
        retryAfterSeconds: initialCapacityDelay,
      })
    }
    if (initial.terminal) {
      throw classifiedFailureError(
        failure,
        providerFallbackStopReason(options.request, options.state, failure),
      )
    }
    if (
      options.requestedBrowserVisibility === 'headless' ||
      options.managedContext.effectiveBrowserVisibility === 'headless' ||
      this.e2eInspection ||
      isAutomaticAuthObservation(options.request, options.requestedBrowserVisibility)
    ) {
      throw classifiedFailureError(failure, providerFallbackStopReason(options.request, options.state, failure))
    }
    await bringToFrontForUserHandoff(options.page)
    const startedAt = Date.now()
    await this.daemonClient.markJobWaitingForUser({
      jobId: options.job.job_id,
      blocker: {
        ...blockerPayload(options.job, initial.blockers, {
          requestedVisibility: options.requestedBrowserVisibility,
          effectiveVisibility: options.managedContext.effectiveBrowserVisibility,
          windowOpen: true,
        }),
        failure,
        fallbackStopped: providerFallbackStopReason(options.request, options.state, failure),
      },
    })
    const deadline = Date.now() + this.userHandoverTimeoutMs
    while (Date.now() <= deadline) {
      throwIfStopped(options.signal, options.isCanceled)
      await delay(Math.min(this.userHandoverPollMs, Math.max(1, deadline - Date.now())), options.signal)
      const latest = await visibleBlockerState(
        options.page,
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
          throw classifiedFailureError(latestFailure, {
            code: 'provider_capacity_unavailable',
            retryAfterSeconds: latestCapacityDelay,
          })
        }
        throw classifiedFailureError(
          latestFailure,
          providerFallbackStopReason(options.request, options.state, latestFailure),
        )
      }
      if (!latest.blocked && await hasStableComposer(
        options.page,
        options.provider,
        this.userHandoverPollMs,
        options.signal,
        options.isCanceled,
      )) {
        await this.daemonClient.markJobRunning({
          jobId: options.job.job_id,
          signal: options.signal,
        })
        return Date.now() - startedAt
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
      clearBlocker: () => Promise<number>
    }
  ) {
    while (true) {
      throwIfStopped(options.signal, options.isCanceled)
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

export function serializeRunnerError(error: unknown) {
  const response = errorResponse(error)
  return {
    code: response.code,
    message: response.message,
    retryable: response.retryable,
    ...(response.details === undefined ? {} : { details: response.details }),
  }
}

const DIRECT_IMAGE_DIAGNOSTIC_CATEGORIES = new Set([
  'authentication',
  'rate_limit',
  'anti_bot',
  'model',
  'timeout',
  'transport',
  'invalid_request',
  'provider',
])

function directImageFailureDiagnostic(error: unknown) {
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null
  const upstream = record?.g4f && typeof record.g4f === 'object' && !Array.isArray(record.g4f)
    ? record.g4f as Record<string, unknown>
    : null
  const code = typeof record?.code === 'string' && /^direct_image_[a-z0-9_]{1,64}$/u.test(record.code)
    ? record.code
    : 'direct_image_upstream_error'
  const status = safeDirectImageStatus(record?.status) ?? safeDirectImageStatus(upstream?.status)
  const category = typeof upstream?.category === 'string' && DIRECT_IMAGE_DIAGNOSTIC_CATEGORIES.has(upstream.category)
    ? upstream.category
    : null
  const type = safeDirectImageType(upstream?.type)
  return {
    code,
    status,
    type,
    category,
  }
}

function safeDirectImageStatus(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : null
}

function safeDirectImageType(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,127}$/u.test(value)) return null
  if (/(?:g4f|openaichat|token|cookie|credential|secret|password|authorization|bearer|session|key)/iu.test(value)) return null
  return value
}

function directActionSuccess(
  action: VisibleActionRequest,
  result: VisibleActionResult,
): VisibleActionResponse {
  return {
    protocol: action.protocol,
    requestId: action.requestId,
    provider: action.provider,
    action: action.action,
    ok: true,
    result,
    error: null,
  }
}

async function observeProviderSubmission(
  page: Page,
  provider: RunnerProvider,
  actions: readonly VisibleActionRequest[],
  actionIndex: number,
  signal: AbortSignal,
  now: () => Date,
  profileId: string,
  operationId: string,
): Promise<ProviderSubmissionObservation> {
  const modelRequestedLabel = requestedChoiceLabel(actions, actionIndex, VISIBLE_ACTIONS.MODEL_SELECT)
  const effortRequestedLabel = requestedChoiceLabel(actions, actionIndex, VISIBLE_ACTIONS.EFFORT_SELECT)
  const pageObservation = await observeProviderPageSurface(page, provider)
  const choiceInspectionAllowed = provider.id !== 'chatgpt' || pageObservation.surface === 'chat'
  const modelResponse = choiceInspectionAllowed
    ? await inspectProviderChoice(page, provider, VISIBLE_ACTIONS.MODEL_INSPECT, 'model', signal, profileId, operationId)
    : null
  const effortResponse = choiceInspectionAllowed
    ? await inspectProviderChoice(page, provider, VISIBLE_ACTIONS.EFFORT_INSPECT, 'effort', signal, profileId, operationId)
    : null
  const skippedReason = choiceInspectionAllowed ? null : 'provider_surface_not_chat'
  return {
    protocol: 'tokenless.provider-submission-observation.v1',
    observedAt: now().toISOString(),
    source: 'visible-provider-controls-before-submit',
    page: pageObservation,
    model: readModelObservation(modelResponse, modelRequestedLabel, skippedReason),
    effort: readChoiceObservation(effortResponse, effortRequestedLabel, skippedReason),
  }
}

async function inspectProviderChoice(
  page: Page,
  provider: RunnerProvider,
  action: typeof VISIBLE_ACTIONS.MODEL_INSPECT | typeof VISIBLE_ACTIONS.EFFORT_INSPECT,
  kind: 'model' | 'effort',
  signal: AbortSignal,
  profileId: string,
  operationId: string,
): Promise<VisibleActionResponse | null> {
  if (signal.aborted) return null
  const request = createVisibleActionRequest({
    protocol: VISIBLE_ACTION_SCHEMA_ID,
    requestId: observationRequestId(provider.id, kind),
    provider: provider.id,
    action,
    payload: {},
  })
  try {
    const response = await provider.executeAction(page, request, { profileId, operationId, signal })
    // Choice inspection is deliberately read-only, but leave any provider menu
    // closed before the real prompt.submit action begins.
    await page.keyboard.press('Escape').catch(() => undefined)
    return response
  } catch {
    await page.keyboard.press('Escape').catch(() => undefined)
    return null
  }
}

function requestedChoiceLabel(
  actions: readonly VisibleActionRequest[],
  actionIndex: number,
  action: typeof VISIBLE_ACTIONS.MODEL_SELECT | typeof VISIBLE_ACTIONS.EFFORT_SELECT,
) {
  for (let index = actionIndex - 1; index >= 0; index -= 1) {
    const candidate = actions[index]
    if (!candidate || candidate.action !== action) continue
    const payload = candidate.payload
    return 'label' in payload && typeof payload.label === 'string' ? payload.label : null
  }
  return null
}

async function observeProviderPageSurface(
  page: Page,
  provider: RunnerProvider,
): Promise<ProviderSubmissionObservation['page']> {
  if (provider.id !== 'chatgpt') {
    return { surface: 'unknown', origin: safePageOrigin(page.url()) }
  }
  const workTrigger = page.locator('button.__composer-pill[class*="WorkTrigger"]').filter({ visible: true })
  if (await workTrigger.count().catch(() => 0) > 0) {
    return { surface: 'work', origin: safePageOrigin(page.url()) }
  }
  const chatTrigger = page.locator('button.__composer-pill[aria-haspopup="menu"]:not([class*="WorkTrigger"])').filter({ visible: true })
  if (await chatTrigger.count().catch(() => 0) > 0) {
    return { surface: 'chat', origin: safePageOrigin(page.url()) }
  }
  const chatRadio = page.getByRole('radio', { name: 'Chat', exact: true }).filter({ visible: true })
  if (await chatRadio.count().catch(() => 0) > 0 && await chatRadio.getAttribute('aria-checked').catch(() => null) === 'true') {
    return { surface: 'chat', origin: safePageOrigin(page.url()) }
  }
  return { surface: 'unknown', origin: safePageOrigin(page.url()) }
}

function isBenchmarkSubmissionEvidenceRequest(request: ManagedPlaywrightJobRequest) {
  return (request as ManagedPlaywrightJobRequest & { submissionEvidence?: unknown }).submissionEvidence === 'benchmark'
}

function readModelObservation(
  response: VisibleActionResponse | null,
  requestedLabel: string | null,
  unavailableReason: string | null = null,
): ProviderModelObservation {
  const observation = readChoiceObservation(response, requestedLabel, unavailableReason)
  return {
    ...observation,
    providerModelId: null,
    identityStatus: observation.status === 'observed' ? 'not-exposed' : 'unknown',
    reason: observation.status === 'observed'
      ? 'visible_model_label_does_not_expose_provider_model_id'
      : observation.reason,
  }
}

function readChoiceObservation(
  response: VisibleActionResponse | null,
  requestedLabel: string | null,
  unavailableReason: string | null = null,
): ProviderChoiceObservation {
  if (response === null) {
    return unknownChoiceObservation(requestedLabel, unavailableReason ?? 'provider_choice_inspection_failed')
  }
  if (!response.ok) {
    return unknownChoiceObservation(requestedLabel, 'provider_choice_inspection_error')
  }
  const result = response.result as unknown
  if (!isRecord(result) || result.supported !== true || !Array.isArray(result.choices)) {
    const reason = isRecord(result) && result.reason === 'unsupported_by_provider'
      ? 'provider_choice_unsupported_by_provider'
      : isRecord(result) && result.reason === 'selector_not_available'
        ? 'provider_choice_selector_not_available'
        : 'provider_choice_selection_not_observed'
    return unknownChoiceObservation(requestedLabel, reason)
  }
  const choices = result.choices as unknown[]
  const selected = choices.find((choice: unknown) => (
    isRecord(choice) && choice.selected === true && typeof choice.label === 'string'
  ))
  if (!isRecord(selected) || typeof selected.label !== 'string') {
    return unknownChoiceObservation(requestedLabel, 'provider_choice_selected_label_not_observed')
  }
  return {
    requestedLabel,
    observedLabel: selected.label,
    status: 'observed',
    source: 'visible-provider-choice-inspect',
    reason: null,
  }
}

function unknownChoiceObservation(
  requestedLabel: string | null,
  reason: string,
): ProviderChoiceObservation {
  return {
    requestedLabel,
    observedLabel: null,
    status: 'unknown',
    source: 'not-observed',
    reason,
  }
}

function withVisibleActionMetadata(
  response: VisibleActionResponse,
  metadata: VisibleActionMetadata,
  submissionObservation: ProviderSubmissionObservation | null,
): VisibleActionResponse {
  if (submissionObservation === null || response.action !== VISIBLE_ACTIONS.PROMPT_SUBMIT) {
    return { ...response, metadata }
  }
  if (!response.ok) return { ...response, metadata, submissionObservation }
  const result = response.result as PromptSubmitResult
  return {
    ...response,
    metadata,
    result: {
      ...result,
      submissionObservation,
    },
  }
}

function observationRequestId(provider: ProviderId, kind: 'model' | 'effort') {
  return `observe:${provider}:${kind}`
}

function safePageOrigin(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

class ProviderFallbackSignal extends Error {
  constructor(readonly submissionResponses: readonly VisibleActionResponse[] = []) {
    super('Managed Playwright execution selected its next provider fallback.')
    this.name = 'ProviderFallbackSignal'
  }
}

function throwRunnerControlFlow(error: unknown): void {
  if (error instanceof ProviderFallbackSignal) throw error
}

function initialExecutionState(): RunnerExecutionState {
  return { actionCursor: 0, responses: [], preparation: null, submitted: null }
}

function prependSubmissionEvidenceResponses(
  result: ManagedPlaywrightJobResult,
  priorResponses: readonly VisibleActionResponse[],
): ManagedPlaywrightJobResult {
  if (priorResponses.length === 0) return result
  return { ...result, responses: [...priorResponses, ...result.responses] }
}

function submissionEvidenceResponses(responses: readonly VisibleActionResponse[]) {
  return responses.filter((response) => {
    if (!response.ok || response.action !== VISIBLE_ACTIONS.PROMPT_SUBMIT) return false
    const result: unknown = response.result
    return isRecord(result) && isRecord(result.submissionObservation)
  })
}

function providerCapacityFailure(projection: ProviderCapacityProjection): ClassifiedProviderFailure {
  return Object.freeze({
    classification: 'safe_pre_submit_provider_failure',
    code: 'provider_capacity_unavailable',
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
  const postSubmissionFallback = providerRejectionFallbackProof(request, state, failure) !== null
  if (!plan || !alternative || (!failure.automaticFallbackEligible && !postSubmissionFallback)) return null
  if (state.submitted !== null && !postSubmissionFallback) return null
  if (!postSubmissionFallback) {
    for (let index = 0; index < state.actionCursor; index += 1) {
      const action = request.actions[index]
      if (!action) return null
      const lifecycle = getVisibleActionLifecycle(action.action)
      if (lifecycle.mutating && !lifecycle.reconstructablePreSubmit) return null
    }
  }
  const remaining = plan.alternatives.slice(1)
  const attempts = [
    ...(request.routingObservation?.attempts ?? []),
    {
      provider: request.provider,
      outcome: 'fallback' as const,
      reason: routingFailureReason(failure),
      observedAt: new Date().toISOString(),
      providerSubmitted: state.submitted !== null,
      ...routingFailureEvidence(failure),
    },
  ]
  return validateManagedPlaywrightJobRequest({
    protocol: request.protocol,
    provider: alternative.provider,
    target: alternative.target,
    taskId: request.taskId,
    pageRef: request.pageRef,
    capabilityRoute: alternative.capabilityRoute,
    fallback: remaining.length === 0 ? null : { ...plan, alternatives: remaining },
    context: request.context,
    browserVisibility: request.browserVisibility,
    userHandoff: request.userHandoff,
    ...(request.semanticPreference === undefined ? {} : { semanticPreference: request.semanticPreference }),
    routingObservation: {
      protocol: 'tokenless.provider-routing-observation.v1',
      ...(request.routingObservation?.exclusions === undefined
        ? {}
        : { exclusions: request.routingObservation.exclusions }),
      attempts,
    },
    ...(request.pagePolicy === undefined ? {} : { pagePolicy: request.pagePolicy }),
    ...(request.submissionEvidence === undefined ? {} : { submissionEvidence: request.submissionEvidence }),
    actions: request.actions.map((action) => ({ ...action, provider: alternative.provider })),
  })
}

function providerRejectionFallbackProof(
  request: ManagedPlaywrightJobRequest,
  state: RunnerExecutionState,
  failure: ClassifiedProviderFailure,
): PostSubmissionFallbackProof | null {
  const plan = request.fallback
  if (
    state.submitted === null ||
    !['provider_rate_limited', 'provider_input_too_long'].includes(failure.code) ||
    !failure.providerScoped ||
    hasVisibleResponse(state) ||
    !plan ||
    plan.protocol !== 'tokenless.provider-fallback.v1' ||
    plan.mode !== 'automatic' ||
    plan.replay !== 'from_start' ||
    plan.alternatives.length === 0
  ) return null
  return failure.code === 'provider_rate_limited' ? {
    protocol: 'tokenless.provider-rate-limit-fallback.v1',
    provider: request.provider,
    code: 'provider_rate_limited',
    providerScoped: true,
    visibleResponse: false,
  } : {
    protocol: 'tokenless.provider-input-limit-fallback.v1',
    provider: request.provider,
    code: 'provider_input_too_long',
    providerScoped: true,
    visibleResponse: false,
  }
}

function hasVisibleResponse(state: RunnerExecutionState) {
  return state.responses.some((response) => {
    if (!response.ok || response.action !== VISIBLE_ACTIONS.RESPONSE_READ) return false
    const result = response.result as Partial<ResponseReadResult>
    return typeof result.text === 'string' && result.text.length > 0
  })
}

function routingFailureReason(failure: ClassifiedProviderFailure) {
  const details = failure.details && typeof failure.details === 'object' && !Array.isArray(failure.details)
    ? failure.details as Record<string, unknown>
    : null
  const values = [
    failure.code,
    details?.family,
    details?.code,
  ].filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase().replace(/-/gu, '_'))
  if (values.some((value) => /(?:provider_sign_in|provider_account_suspended|sign_in_required|authentication|auth|login)/u.test(value))) {
    return 'auth' as const
  }
  if (values.some((value) => /(?:captcha|recaptcha|hcaptcha|cloudflare|turnstile|arkose|funcaptcha)/u.test(value))) {
    return 'captcha' as const
  }
  if (values.some((value) => /(?:rate_limit|rate_limited|too_many_requests|http_429)/u.test(value))) {
    return 'rate_limit' as const
  }
  if (values.some((value) => /(?:provider_plan_limited|provider_input_too_long|plan_limit|input_limit|capacity|quota)/u.test(value))) {
    return 'capacity' as const
  }
  if (values.some((value) => /(?:provider_dns_unavailable|provider_navigation_unavailable|provider_page_unavailable|network_unavailable|dns_resolution|unreachable)/u.test(value))) {
    return 'unreachable' as const
  }
  return 'unavailable' as const
}

function routingFailureEvidence(failure: ClassifiedProviderFailure) {
  const details = failure.details && typeof failure.details === 'object' && !Array.isArray(failure.details)
    ? failure.details as Record<string, unknown>
    : null
  const family = String(details?.family)
  const visibleProof = typeof details?.visibleProof === 'string' && /^[a-z0-9:_-]{1,160}$/u.test(details.visibleProof)
    ? details.visibleProof
    : undefined
  if (routingFailureReason(failure) === 'auth') {
    return family === 'provider_sign_in' && visibleProof !== undefined ? { visibleProof } : {}
  }
  if (!['rate_limit', 'plan_limit', 'input_limit', 'recaptcha', 'cloudflare', 'hcaptcha', 'arkose', 'availability'].includes(family)) return {}
  const limitWindow = typeof details?.limitWindow === 'string' && ['minute', 'hour', 'day', 'week', 'unknown'].includes(details.limitWindow)
    ? details.limitWindow as 'minute' | 'hour' | 'day' | 'week' | 'unknown'
    : undefined
  const retryAfterSeconds = typeof details?.retryAfterSeconds === 'number'
    && Number.isSafeInteger(details.retryAfterSeconds)
    && details.retryAfterSeconds >= 1
    && details.retryAfterSeconds <= 604_800
    ? details.retryAfterSeconds
    : undefined
  return {
    ...(visibleProof === undefined ? {} : { visibleProof }),
    ...(limitWindow === undefined ? {} : { limitWindow }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }
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
  fallbackStopped: { code: string, [key: string]: unknown },
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
  const arenaAgentRoute = provider.id === 'arena' && route.requirements.includes(TASK_CAPABILITIES.AGENT_EXECUTE)
  const observations = route.requirements.map((capability) => {
    const target = liveInspectionTarget(capability, provider.id, arenaAgentRoute)
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

function liveInspectionTarget(capability: TaskCapabilityId, provider: ProviderId, arenaAgentRoute = false): {
  providerCapability: ProviderCapabilityId
  scope: 'overall' | 'native'
} | null {
  if (provider === 'github-copilot' && (capability === TASK_CAPABILITIES.AGENT_EXECUTE || capability === TASK_CAPABILITIES.SEARCH_WEB)) {
    return { providerCapability: PROVIDER_CAPABILITIES.GITHUB_COPILOT_MODE, scope: 'overall' }
  }
  if (provider === 'github-copilot' && capability === TASK_CAPABILITIES.IMAGE_INPUT) {
    return { providerCapability: PROVIDER_CAPABILITIES.FILE_UPLOAD, scope: 'overall' }
  }
  if (
    capability === TASK_CAPABILITIES.CONVERSATION_CHAT ||
    capability === TASK_CAPABILITIES.CONVERSATION_CONTINUE
  ) {
    return { providerCapability: PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE, scope: 'overall' }
  }
  if (
    capability === TASK_CAPABILITIES.FILE_UPLOAD ||
    capability === TASK_CAPABILITIES.DOCUMENT_INPUT
  ) {
    return { providerCapability: PROVIDER_CAPABILITIES.FILE_UPLOAD, scope: 'overall' }
  }
  if (capability === TASK_CAPABILITIES.MODEL_COMPARE) {
    return { providerCapability: PROVIDER_CAPABILITIES.ARENA_SURFACE, scope: 'overall' }
  }
  if (
    provider === 'arena' &&
    (
      capability === TASK_CAPABILITIES.IMAGE_GENERATION ||
      capability === TASK_CAPABILITIES.IMAGE_EDIT ||
      capability === TASK_CAPABILITIES.IMAGE_INPUT
    )
  ) {
    return { providerCapability: PROVIDER_CAPABILITIES.ARENA_SURFACE, scope: 'overall' }
  }
  if (capability === TASK_CAPABILITIES.IMAGE_GENERATION) {
    return { providerCapability: PROVIDER_CAPABILITIES.IMAGE_GENERATION, scope: 'overall' }
  }
  if (provider === 'gemini' && capability === TASK_CAPABILITIES.ARTIFACT_DOWNLOAD) {
    return { providerCapability: PROVIDER_CAPABILITIES.IMAGE_GENERATION, scope: 'overall' }
  }
  if (provider === 'arena' && capability === TASK_CAPABILITIES.WEBSITE_GENERATION) {
    return { providerCapability: PROVIDER_CAPABILITIES.ARENA_SURFACE, scope: 'overall' }
  }
  if (provider === 'arena' && capability === TASK_CAPABILITIES.AGENT_EXECUTE) {
    return { providerCapability: PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE, scope: 'overall' }
  }
  if (provider === 'arena' && capability === TASK_CAPABILITIES.VIDEO_GENERATION) {
    return { providerCapability: PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE, scope: 'overall' }
  }
  if (capability === TASK_CAPABILITIES.WORKSPACE_NATIVE) {
    return { providerCapability: PROVIDER_CAPABILITIES.WORKSPACE_ENSURE, scope: 'native' }
  }
  if (capability === TASK_CAPABILITIES.WORKSPACE_INSTRUCTIONS || capability === TASK_CAPABILITIES.WORKSPACE_KNOWLEDGE) {
    return { providerCapability: PROVIDER_CAPABILITIES.WORKSPACE_ENSURE, scope: 'native' }
  }
  if (capability === TASK_CAPABILITIES.SEARCH_WEB) {
    return {
      providerCapability: provider === 'arena' && !arenaAgentRoute
        ? PROVIDER_CAPABILITIES.ARENA_SURFACE
        : arenaAgentRoute
          ? PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE
          : PROVIDER_CAPABILITIES.KIMI_SEARCH,
      scope: 'overall',
    }
  }
  if (capability === TASK_CAPABILITIES.RESPONSE_CITATIONS && provider === 'arena') {
    return {
      providerCapability: arenaAgentRoute
        ? PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE
        : PROVIDER_CAPABILITIES.ARENA_SURFACE,
      scope: 'overall',
    }
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

function isAutomaticAuthObservation(
  request: ManagedPlaywrightJobRequest,
  requestedBrowserVisibility: BrowserVisibility,
) {
  return requestedBrowserVisibility === 'auto' && request.actions.every((action) => (
    action.action === VISIBLE_ACTIONS.AUTH_STATUS
  ))
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
  if (!target) throw tokenlessError('invalid_playwright_runner_state', 'Managed Playwright runner URL is not a trusted provider URL.')
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

function throwIfStopped(signal: AbortSignal, isCanceled: () => boolean) {
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
) {
  if (!await provider.hasVisibleComposer(page)) return false
  await delay(Math.min(Math.max(pollMs, 50), 500), signal)
  throwIfStopped(signal, isCanceled)
  return await provider.hasVisibleComposer(page)
}

function blockerPayload(
  job: DaemonJob,
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
        ? 'Your help is needed: complete provider sign-in or verification in the visible browser. The current execution will continue after the composer is stable.'
        : 'Your help is needed, but no browser window is open. Start a new job in headed mode to complete provider verification.',
    },
  }
}

function providerFailurePayload(
  job: DaemonJob,
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

function managedPageRef(job: DaemonJob, request: ManagedPlaywrightJobRequest) {
  return request.pageRef ?? `job:${job.job_id}`
}

function providerHomePageRef(provider: string) {
  return `provider:${provider}:home`
}

function providerOwnsPage(
  provider: NonNullable<ReturnType<typeof getProviderInstanceById>>,
  page: Page,
) {
  const classification = provider.navigation.classify(page.url())
  return classification.kind === 'approved' || classification.kind === 'trusted_sign_in'
}

async function providerPageAvailable(provider: RunnerProvider, page: Page) {
  try {
    return !(await provider.observeResponse(page)).busy
  } catch {
    return false
  }
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
