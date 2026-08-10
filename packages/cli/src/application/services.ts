import { createHash, randomUUID } from 'node:crypto'
import {
  deleteTokenlessProfileConfig,
  readTokenlessConfig,
  upsertTokenlessProfileConfig,
  writeTokenlessConfig,
  type ManagedProfileConfig,
  type TokenlessConfig,
} from '../job-store.js'
import { tokenlessPackageVersion } from '../platform-package.js'
import { BrowserRuntimeManager } from '../browser-runtime/manager.js'
import { normalizeBrowserSelection } from '../browser-runtime/types.js'
import { normalizeBrowserVisibility } from '../browser-visibility.js'
import {
  createManagedPlaywrightJobRequest,
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  PLAYWRIGHT_EXECUTION_BACKEND,
} from '../playwright/job-contract.js'
import { VISIBLE_ACTIONS } from '../providers/contracts.js'
import {
  listProviderDescriptors,
  listProviderInstances,
  listProviderTaskCapabilityRoutes,
  listTaskCapabilityDefinitions,
  type ProviderAccessClass,
  type ProviderId,
} from '../providers/registry.js'
import {
  ManagedProfileRegistry,
  type ManagedProfileRecord,
} from '../playwright/profiles/registry.js'
import {
  publicView,
  type Job,
  type JobStore,
  type JobView,
  type OutputSavingsEvent,
  type OutputSavingsSummary,
} from '../daemon/job-store.js'
import type { BrowserRuntimeController } from '../daemon/browser-runtime-controller.js'
import { OUTPUT_SAVINGS_ESTIMATOR } from '../output-savings/catalog.js'
import type { OutputSavingsProcessor } from '../output-savings/processor.js'
import { OutputSavingsRuntimeManager } from '../output-savings/runtime-manager.js'

export type UiApplicationServicesOptions = {
  store: JobStore
  runtimeController?: BrowserRuntimeController | undefined
  outputSavingsProcessor?: OutputSavingsProcessor | undefined
  origin: () => string
  startedAt: number
}

export class TokenlessApplicationServices {
  readonly store: JobStore
  readonly profiles: ManagedProfileRegistry
  readonly runtimeManager: BrowserRuntimeManager
  readonly outputSavingsRuntimeManager: OutputSavingsRuntimeManager

  private readonly runtimeController: BrowserRuntimeController | undefined
  private readonly outputSavingsProcessor: OutputSavingsProcessor | undefined
  private readonly origin: () => string
  private readonly startedAt: number

  constructor(options: UiApplicationServicesOptions) {
    this.store = options.store
    this.profiles = new ManagedProfileRegistry(options.store.homeDir)
    this.runtimeManager = new BrowserRuntimeManager({ homeDir: options.store.homeDir })
    this.outputSavingsRuntimeManager = new OutputSavingsRuntimeManager(options.store.homeDir)
    this.runtimeController = options.runtimeController
    this.outputSavingsProcessor = options.outputSavingsProcessor
    this.origin = options.origin
    this.startedAt = options.startedAt
  }

  async snapshot() {
    await this.reconcileProviderObservations()
    const [config, profileData, jobs] = await Promise.all([
      this.migratedConfig(),
      this.profiles.read(),
      Promise.resolve(this.store.listJobs({ limit: 200 })),
    ])
    const profiles = Object.values(profileData.profiles)
      .filter((profile) => profile.lifecycle !== 'removed')
      .sort((left, right) => left.slug.localeCompare(right.slug))
    const runtime = this.runtimeController?.status() ?? {
      status: 'stopped' as const,
      activeProfileCount: 0,
      activeJobCount: 0,
      pid: process.pid,
    }
    const providers = listProviderDescriptors()
      .sort((left, right) => left.setupOrder - right.setupOrder)
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        stage: provider.stage,
        homeUrl: provider.navigation.entryUrl,
      }))
    const capabilityRoutes = listProviderTaskCapabilityRoutes()
    this.store.reconcileOutputSavings()
    const outputSavings = await this.outputSavingsState(config)
    const body = {
      schema: 'tokenless.ui-snapshot.v1',
      generatedAt: new Date().toISOString(),
      daemon: {
        version: tokenlessPackageVersion(),
        origin: this.origin(),
        uptimeMs: Math.max(0, Date.now() - this.startedAt),
        pid: process.pid,
      },
      runtime,
      config: publicConfig(config),
      outputSavings,
      profiles: profiles.map((profile) => publicProfile(
        profile,
        profileData.defaultProfile,
        profileConfig(config, profile.slug),
        config.browser,
      )),
      providers: providers.map((provider) => ({
        ...provider,
        profiles: profiles.map((profile) => providerProfileState(
          provider.id,
          profile,
          profileConfig(config, profile.slug),
          capabilityRoutes,
          jobs,
        )),
      })),
      capabilities: listTaskCapabilityDefinitions().map((capability) => ({
        id: capability.id,
        title: capability.title,
        description: capability.description,
        family: capability.family,
        lifecycle: capability.lifecycle,
        stability: capability.stability,
        requiredEvidence: capability.requiredEvidence,
        providers: capabilityRoutes
          .filter((route) => route.capability === capability.id)
          .map((route) => ({
            provider: route.provider,
            support: route.support,
            strategy: route.strategy,
            evidence: route.evidence,
          })),
      })),
      jobs: jobs.map((job) => publicJobSummary(
        job,
        profiles,
        this.store.outputSavingsForJob(job.job_id),
      )),
      diagnostics: await this.diagnostics(config, profiles, runtime, outputSavings),
    }
    return {
      ...body,
      revision: revisionFor({
        ...body,
        generatedAt: null,
        daemon: { ...body.daemon, uptimeMs: 0 },
      }),
    }
  }

  async job(jobId: string) {
    return publicJobDetail(
      this.store.getJob(jobId),
      await this.profiles.listProfiles(),
      this.store.outputSavingsForJob(jobId),
    )
  }

  async enableOutputSavings() {
    await this.outputSavingsRuntimeManager.ensureInstalled()
    const config = await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      outputSavings: { enabled: true },
    })
    return await this.outputSavingsState(config)
  }

  async disableOutputSavings() {
    const config = await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      outputSavings: { enabled: false },
    })
    await this.discardPendingOutputSavingsWork()
    return await this.outputSavingsState(config)
  }

  async uninstallOutputSavings(input: Record<string, unknown>) {
    requireKnownFields(input, ['confirmDelete'])
    if (input.confirmDelete !== true) {
      throw applicationError(
        'output_savings_uninstall_confirmation_required',
        'Output savings runtime removal requires explicit confirmation.',
      )
    }
    const config = await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      outputSavings: { enabled: false },
    })
    await this.discardPendingOutputSavingsWork()
    await this.outputSavingsRuntimeManager.remove()
    return await this.outputSavingsState(config)
  }

  async clearOutputSavings(input: Record<string, unknown>) {
    requireKnownFields(input, ['confirmDelete'])
    if (input.confirmDelete !== true) {
      throw applicationError(
        'output_savings_clear_confirmation_required',
        'Output savings history removal requires explicit confirmation.',
      )
    }
    await this.discardPendingOutputSavingsWork()
    const cleared = this.store.clearOutputSavings().cleared
    return {
      ...await this.outputSavingsState(),
      cleared,
    }
  }

  private async discardPendingOutputSavingsWork() {
    if (this.outputSavingsProcessor) {
      await this.outputSavingsProcessor.discardPending()
      return
    }
    this.store.discardOutputSavingsWork()
  }

  async updateConfig(input: Record<string, unknown>) {
    requireKnownFields(input, ['browser', 'browserExecutablePath', 'browserVisibility', 'language'])
    const current = await this.migratedConfig()
    const browserVisibility = input.browserVisibility === undefined
      ? 'headed'
      : normalizeBrowserVisibility(input.browserVisibility)
    if (!browserVisibility) throw applicationError('invalid_browser_visibility', 'Browser visibility is invalid.')
    requireNativeChromeVisibility(browserVisibility)
    const requestedBrowser = input.browser === undefined
      ? current.browser
      : normalizeBrowserSelection(input.browser)
    if (requestedBrowser !== 'chrome' && requestedBrowser !== 'brave') {
      throw applicationError('native_chrome_required', 'Tokenless native mode supports a running Google Chrome or Brave Browser.')
    }
    let requestedBrowserExecutablePath = requestedBrowser === current.browser
      ? current.browserExecutablePath
      : null
    if (input.browserExecutablePath === null || input.browserExecutablePath === '') {
      requestedBrowserExecutablePath = null
    } else if (input.browserExecutablePath !== undefined) {
      try {
        const runtime = await this.runtimeManager.ensure(requestedBrowser, {
          allowDownload: false,
          browserExecutablePath: String(input.browserExecutablePath),
        })
        requestedBrowserExecutablePath = runtime.executablePath
      } catch {
        throw applicationError(
          'browser_executable_not_found',
          `Tokenless could not validate the ${requestedBrowser === 'brave' ? 'Brave Browser' : 'Google Chrome'} executable path. Choose the correct browser and provide its absolute executable path.`,
        )
      }
    }
    const language = input.language === undefined ? current.language : input.language
    if (language !== 'en' && language !== 'zh-CN') {
      throw applicationError('invalid_language', 'Language must be en or zh-CN.')
    }
    if (
      requestedBrowser !== current.browser ||
      requestedBrowserExecutablePath !== current.browserExecutablePath
    ) {
      if (this.runtimeController?.status().activeJobCount) {
        throw applicationError('browser_mutation_unsafe', 'The native browser cannot be changed while browser jobs are active.')
      }
      await this.runtimeController?.quiesce()
    }
    const saved = await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      browser: requestedBrowser,
      browserExecutablePath: requestedBrowserExecutablePath,
      browserVisibility: 'headed',
      language,
    })
    return publicConfig(saved)
  }

  async createProfile(input: Record<string, unknown>) {
    requireKnownFields(input, ['slug', 'roleLabel', 'enabledProviders', 'browserVisibility', 'setDefault'])
    const slug = requiredSlug(input.slug)
    const browserVisibility = input.browserVisibility === undefined
      ? 'headed'
      : requiredVisibility(input.browserVisibility)
    requireNativeChromeVisibility(browserVisibility)
    const profileConfiguration = {
      roleLabel: optionalRoleLabel(input.roleLabel) ?? '',
      enabledProviders: input.enabledProviders === undefined
        ? configurableProviderIds()
        : providerList(input.enabledProviders),
      browserVisibility: 'headed' as const,
      proxy: null,
    }
    const profile = await this.profiles.addProfile({
      slug,
      lifecycle: 'ready',
      setDefault: input.setDefault === true,
    })
    try {
      await this.updateProfileConfig(profile, profileConfiguration)
      const config = await this.migratedConfig()
      return publicProfile(profile, (await this.profiles.read()).defaultProfile, profileConfig(config, profile.slug), config.browser)
    } catch (error) {
      await this.profiles.removeProfile(slug, { confirmDelete: true }).catch(() => undefined)
      throw error
    }
  }

  async updateProfile(slug: string, input: Record<string, unknown>) {
    requireKnownFields(input, ['roleLabel', 'enabledProviders', 'browserVisibility', 'setDefault'])
    let profile = await this.profiles.resolveProfile(slug)
    const current = profileConfig(await this.migratedConfig(), profile.slug)
    const browserVisibility = input.browserVisibility === undefined
      ? current.browserVisibility
      : requiredVisibility(input.browserVisibility)
    requireNativeChromeVisibility(browserVisibility)
    const next = {
      roleLabel: input.roleLabel === undefined ? current.roleLabel : optionalRoleLabel(input.roleLabel) ?? '',
      enabledProviders: input.enabledProviders === undefined
        ? current.enabledProviders
        : providerList(input.enabledProviders),
      browserVisibility: 'headed' as const,
      proxy: null,
    }
    if (input.setDefault === true) profile = await this.profiles.setDefault(slug)
    await this.updateProfileConfig(profile, next)
    const config = await this.migratedConfig()
    return publicProfile(profile, (await this.profiles.read()).defaultProfile, profileConfig(config, profile.slug), config.browser)
  }

  async removeProfile(slug: string) {
    const status = this.runtimeController?.status()
    if (status?.activeJobCount) {
      throw applicationError('profile_mutation_unsafe', 'A profile cannot be removed while browser jobs are active.')
    }
    await this.runtimeController?.quiesce()
    const profile = await this.profiles.removeProfile(slug, { confirmDelete: true })
    await deleteTokenlessProfileConfig({ homeDir: this.store.homeDir, slug })
    return { slug: profile.slug, removed: true }
  }

  async providerAction(slug: string, providerValue: string, action: 'open' | 'readiness' | 'controls') {
    const profile = await this.profiles.resolveProfile(slug)
    const provider = listProviderInstances().find((candidate) => candidate.id === providerValue)
    if (!provider || provider.descriptor.stage === 'disabled') {
      throw applicationError('provider_not_supported', 'Provider is not supported.')
    }
    const configured = profileConfig(await this.migratedConfig(), profile.slug)
    if (!configured.enabledProviders.includes(provider.id)) {
      throw applicationError('provider_not_enabled', 'Enable the provider for this profile before opening it.')
    }
    const job = this.createProviderActionJob(profile, provider.id, action)
    await this.runtimeController?.wake()
    return job
  }

  async refreshProviderReadiness(slug: string) {
    const profile = await this.profiles.resolveProfile(slug)
    const configured = profileConfig(await this.migratedConfig(), profile.slug)
    const enabled = new Set(configured.enabledProviders)
    const batchId = randomUUID()
    const jobs = listProviderInstances()
      .filter((provider) => provider.descriptor.stage !== 'disabled' && enabled.has(provider.id))
      .map((provider, index) => this.createProviderActionJob(profile, provider.id, 'readiness', {
        jobId: `ui-readiness-${batchId}-${String(index).padStart(3, '0')}`,
        taskId: `ui:readiness:${batchId}:${provider.id}`,
      }))
    if (jobs.length > 0) await this.runtimeController?.wake()
    return { profileSlug: profile.slug, jobs }
  }

  private createProviderActionJob(
    profile: ManagedProfileRecord,
    provider: ProviderId,
    action: 'open' | 'readiness' | 'controls',
    identity?: { jobId: string; taskId: string },
  ) {
    const visibleAction = action === 'readiness'
      ? VISIBLE_ACTIONS.AUTH_STATUS
      : action === 'controls'
        ? VISIBLE_ACTIONS.CAPABILITY_INSPECT
        : VISIBLE_ACTIONS.NAVIGATION_CHECK
    const actions = action === 'controls'
      ? [
          { action: VISIBLE_ACTIONS.CAPABILITY_INSPECT, payload: {} },
          { action: VISIBLE_ACTIONS.MODEL_INSPECT, payload: {} },
          { action: VISIBLE_ACTIONS.EFFORT_INSPECT, payload: {} },
        ]
      : [{ action: visibleAction, payload: {} }]
    const request = createManagedPlaywrightJobRequest({
      provider,
      browserVisibility: action === 'readiness' ? 'auto' : 'headed',
      userHandoff: action === 'open',
      pageRef: `page:ui:${action}:${randomUUID()}`,
      taskId: identity?.taskId ?? `ui:${action}:${randomUUID()}`,
      actions,
    })
    const job = this.store.createJob({
      provider,
      action: MANAGED_PLAYWRIGHT_JOB_ACTION,
      request_json: request,
      execution_backend: PLAYWRIGHT_EXECUTION_BACKEND,
      profile_id: profile.id,
      ...(identity === undefined ? {} : { job_id: identity.jobId }),
    })
    return publicJobSummary(publicView(job), [profile])
  }

  async providerSelection(
    slug: string,
    providerValue: string,
    input: Record<string, unknown>,
  ) {
    requireKnownFields(input, ['kind', 'label'])
    const kind = input.kind
    if (kind !== 'model' && kind !== 'effort') {
      throw applicationError('provider_selection_invalid', 'Selection kind must be model or effort.')
    }
    const label = requiredText(input.label, 'label', 120)
    const profile = await this.profiles.resolveProfile(slug)
    const provider = listProviderInstances().find((candidate) => candidate.id === providerValue)
    if (!provider || provider.descriptor.stage === 'disabled') {
      throw applicationError('provider_not_supported', 'Provider is not supported.')
    }
    const configured = profileConfig(await this.migratedConfig(), profile.slug)
    if (!configured.enabledProviders.includes(provider.id)) {
      throw applicationError('provider_not_enabled', 'Enable the provider for this profile before changing controls.')
    }
    const request = createManagedPlaywrightJobRequest({
      provider: provider.id,
      browserVisibility: 'headed',
      taskId: `ui:${kind}-select:${randomUUID()}`,
      pageRef: `page:ui:${kind}-select:${randomUUID()}`,
      actions: [{
        action: kind === 'model' ? VISIBLE_ACTIONS.MODEL_SELECT : VISIBLE_ACTIONS.EFFORT_SELECT,
        payload: { label },
      }],
    })
    const job = this.store.createJob({
      provider: provider.id,
      action: MANAGED_PLAYWRIGHT_JOB_ACTION,
      request_json: request,
      execution_backend: PLAYWRIGHT_EXECUTION_BACKEND,
      profile_id: profile.id,
    })
    await this.runtimeController?.wake()
    return publicJobSummary(job, [profile])
  }

  async openProfile(slug: string) {
    const profile = await this.profiles.resolveProfile(slug)
    if (!this.runtimeController) throw applicationError('browser_runtime_unavailable', 'Browser runtime is unavailable.')
    return await this.runtimeController.openProfile(profile.id, 'headed')
  }

  async quiesceRuntime() {
    return await this.runtimeController?.quiesce() ?? {
      status: 'stopped', activeProfileCount: 0, activeJobCount: 0, pid: process.pid,
    }
  }

  async cancelJob(jobId: string) {
    return publicJobDetail(await this.store.cancelJob(jobId, { source: 'ui' }), await this.profiles.listProfiles())
  }

  async resumeJob(jobId: string) {
    const job = this.store.resumeJob(jobId, { browser_visibility: 'headed' })
    await this.runtimeController?.wake()
    return publicJobDetail(job, await this.profiles.listProfiles())
  }

  private async migratedConfig() {
    return await readTokenlessConfig(this.store.homeDir)
  }

  private async updateProfileConfig(
    profile: ManagedProfileRecord,
    next: ManagedProfileConfig,
  ) {
    await upsertTokenlessProfileConfig({
      homeDir: this.store.homeDir,
      slug: profile.slug,
      profile: next,
    })
  }

  private async diagnostics(
    config: TokenlessConfig,
    profiles: ManagedProfileRecord[],
    runtime: ReturnType<BrowserRuntimeController['status']>,
    outputSavings: Awaited<ReturnType<TokenlessApplicationServices['outputSavingsState']>>,
  ) {
    const browser = await this.runtimeManager.inspect(config.browser, {
      browserExecutablePath: config.browserExecutablePath,
    })
    return [
      {
        id: 'configuration',
        state: config.updatedAt ? 'ok' : 'action_required',
        message: config.updatedAt ? 'Configuration is persisted.' : 'Setup has not persisted configuration yet.',
      },
      {
        id: 'browser-runtime',
        state: browser.ok ? 'ok' : 'error',
        message: browser.ok ? `${browser.runtime?.displayName ?? config.browser} is available.` : browser.message,
      },
      {
        id: 'profiles',
        state: profiles.some((profile) => profile.lifecycle === 'ready') ? 'ok' : 'action_required',
        message: profiles.length === 0 ? 'No managed profile is configured.' : `${profiles.length} managed profile(s) registered.`,
      },
      {
        id: 'scheduler',
        state: runtime.status === 'quiescing' ? 'action_required' : 'ok',
        message: `${runtime.activeJobCount} active browser job(s).`,
      },
      {
        id: 'output-savings',
        state: !outputSavings.enabled || outputSavings.runtime.state !== 'invalid' ? 'ok' : 'error',
        message: !outputSavings.enabled
          ? 'Output savings measurement is disabled.'
          : outputSavings.runtime.state === 'ready'
            ? 'The output savings tokenizer runtime is ready.'
            : outputSavings.runtime.state === 'not_installed'
              ? 'The output savings tokenizer will be installed when the first visible response is measured.'
              : 'Output savings is enabled, but its tokenizer runtime is invalid.',
      },
    ]
  }

  private async outputSavingsState(config?: TokenlessConfig) {
    const resolvedConfig = config ?? await this.migratedConfig()
    const runtime = await this.outputSavingsRuntimeManager.inspect()
    return {
      enabled: resolvedConfig.outputSavings.enabled,
      collection: resolvedConfig.outputSavings.enabled
        ? runtime.state === 'ready' ? 'enabled' as const : 'unavailable' as const
        : 'disabled' as const,
      estimator: OUTPUT_SAVINGS_ESTIMATOR,
      basis: 'visible_assistant_text' as const,
      runtime,
      summary: publicOutputSavingsSummary(this.store.outputSavingsSummary()),
    }
  }

  private async reconcileProviderObservations() {
    const profiles = await this.profiles.listProfiles()
    const byId = new Map(profiles.map((profile) => [profile.id, profile]))
    for (const job of this.store.listJobs({ status: 'succeeded', limit: 200 })) {
      const request = record(job.request_json)
      if (!job.profile_id || !request || typeof request.taskId !== 'string' || !request.taskId.startsWith('ui:readiness:')) continue
      const profile = byId.get(job.profile_id)
      if (!profile) continue
      const result = record(job.result_json)
      const responses = Array.isArray(result?.responses) ? result.responses : []
      const response = responses.find((entry) => record(entry)?.action === VISIBLE_ACTIONS.AUTH_STATUS)
      const responseRecord = record(response)
      const observation = responseRecord?.ok === true ? record(responseRecord.result) : null
      if (!observation || !['authenticated', 'unauthenticated', 'unknown'].includes(String(observation.state))) continue
      const current = profile.lastObservedAuth[job.provider as ProviderId]
      if (current && Date.parse(current.checkedAt) >= Date.parse(job.updated_at)) continue
      const account = record(observation.account)
      const tier = record(account?.tier)
      await this.profiles.updateProviderStatus(profile.slug, {
        provider: job.provider as ProviderId,
        auth: observation.state as 'authenticated' | 'unauthenticated' | 'unknown',
        access: observation.access as ProviderAccessClass,
        checkedAt: job.updated_at,
        ...(observation.state === 'authenticated' && account && tier ? {
          account: {
            name: typeof account.name === 'string' ? account.name : null,
            subscription: typeof account.subscription === 'string' ? account.subscription : null,
            tier: {
              class: tier.class as 'signed_in_free' | 'signed_in_paid' | 'signed_in_unknown',
              label: typeof tier.label === 'string' ? tier.label : null,
            },
          },
        } : {}),
      })
    }
  }

}

function publicConfig(config: TokenlessConfig) {
  return {
    updatedAt: config.updatedAt,
    profiles: config.profiles,
    browser: config.browser,
    browserExecutablePathConfigured: config.browserExecutablePath !== null,
    browserVisibility: config.browserVisibility,
    daemonUrl: config.daemonUrl,
    language: config.language,
    outputSavings: config.outputSavings,
    g4f: config.g4f,
    directProvider: config.directProvider,
  }
}

function publicProfile(
  profile: ManagedProfileRecord,
  defaultSlug: string | null,
  configured: ManagedProfileConfig,
  configuredBrowser: string,
) {
  const browserBinding = profile.runtimeBinding
    ? {
        browserId: profile.runtimeBinding.browserId,
        runtimeId: profile.runtimeBinding.runtimeId,
        family: profile.runtimeBinding.family,
      }
    : {
        browserId: configuredBrowser,
        runtimeId: `native:${configuredBrowser}`,
        family: 'system',
      }
  return {
    slug: profile.slug,
    id: profile.id,
    lifecycle: profile.lifecycle,
    isDefault: profile.slug === defaultSlug,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    browserMode: browserBinding.family === 'system' ? 'native' : 'managed',
    browserBinding,
    roleLabel: configured.roleLabel,
    enabledProviders: configured.enabledProviders,
    browserVisibility: configured.browserVisibility,
    proxy: configured.proxy,
    observations: Object.values(profile.lastObservedAuth).map((status) => status ? {
      provider: status.provider,
      auth: status.auth,
      access: status.access,
      checkedAt: status.checkedAt,
      account: status.auth === 'authenticated' ? status.account ?? null : null,
    } : null).filter(Boolean),
  }
}

function providerProfileState(
  provider: ProviderId,
  profile: ManagedProfileRecord,
  configured: ManagedProfileConfig,
  routes: ReturnType<typeof listProviderTaskCapabilityRoutes>,
  jobs: Job[],
) {
  const observation = profile.lastObservedAuth[provider]
  return {
    profileId: profile.slug,
    enabled: configured.enabledProviders.includes(provider),
    observation: observation ? {
      auth: observation.auth,
      access: observation.access,
      checkedAt: observation.checkedAt,
      account: observation.auth === 'authenticated' ? observation.account ?? null : null,
    } : null,
    runtimeEligibility: configured.enabledProviders.includes(provider) && usableAccess(observation?.access)
      ? 'eligible'
      : 'ineligible',
    capabilities: routes.filter((route) => route.provider === provider).map((route) => ({
      id: route.capability,
      support: route.support,
    })),
    controls: latestProviderControls(jobs, profile.id, provider),
  }
}

function latestProviderControls(jobs: Job[], profileId: string, provider: ProviderId) {
  const job = jobs.find((candidate) => {
    const request = record(candidate.request_json)
    return candidate.profile_id === profileId &&
      candidate.provider === provider &&
      candidate.status === 'succeeded' &&
      typeof request?.taskId === 'string' &&
      request.taskId.startsWith('ui:controls:')
  })
  const result = record(job?.result_json)
  const responses = Array.isArray(result?.responses) ? result.responses : []
  const choice = (action: string) => {
    const response = responses.find((entry) => record(entry)?.action === action)
    const envelope = record(response)
    const value = envelope?.ok === true ? record(envelope.result) : null
    if (!value || value.supported !== true || !Array.isArray(value.choices)) return null
    return value.choices.flatMap((entry) => {
      const candidate = record(entry)
      return typeof candidate?.label === 'string'
        ? [{ label: candidate.label, selected: candidate.selected === true, enabled: candidate.enabled === true }]
        : []
    })
  }
  return {
    checkedAt: job?.updated_at ?? null,
    model: choice(VISIBLE_ACTIONS.MODEL_INSPECT),
    effort: choice(VISIBLE_ACTIONS.EFFORT_INSPECT),
  }
}

function publicJobSummary(
  job: JobView | Job,
  profiles: ManagedProfileRecord[] = [],
  outputSavings: OutputSavingsEvent[] = [],
) {
  const request = record(job.request_json)
  return {
    jobId: job.job_id,
    profileId: job.profile_id,
    profileSlug: profiles.find((profile) => profile.id === job.profile_id)?.slug ?? null,
    provider: job.provider,
    action: job.action,
    status: job.status,
    taskId: typeof request?.taskId === 'string' ? request.taskId : null,
    capabilityRoute: record(request?.capabilityRoute),
    agent: 'agent_kind' in job && job.agent_kind && job.agent_session_id
      ? { kind: job.agent_kind, sessionId: job.agent_session_id }
      : null,
    blocker: publicError(job.blocker_json),
    outputSavings: publicJobOutputSavings(outputSavings),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  }
}

function publicJobDetail(
  job: JobView | Job,
  profiles: ManagedProfileRecord[] = [],
  outputSavings: OutputSavingsEvent[] = [],
) {
  return {
    ...publicJobSummary(job, profiles, outputSavings),
    result: redactPublicValue(job.result_json),
    error: publicError(job.error_json),
    providerAttempts: redactPublicValue(job.provider_attempts_json),
    outputSavingsEvents: outputSavings.map((event) => ({
      responseRequestId: event.response_request_id,
      estimatedOutputTokens: event.estimated_output_tokens,
      visibleCharacters: event.visible_characters,
      estimator: event.estimator,
      estimatorRevision: event.estimator_revision,
      basis: event.basis,
      measuredAt: event.measured_at,
    })),
  }
}

function publicOutputSavingsSummary(summary: OutputSavingsSummary) {
  return {
    estimatedOutputTokens: summary.estimated_output_tokens,
    visibleCharacters: summary.visible_characters,
    responseCount: summary.response_count,
    jobCount: summary.job_count,
    firstMeasuredAt: summary.first_measured_at,
    lastMeasuredAt: summary.last_measured_at,
  }
}

function publicJobOutputSavings(events: OutputSavingsEvent[]) {
  return {
    estimatedOutputTokens: events.reduce((sum, event) => sum + event.estimated_output_tokens, 0),
    visibleCharacters: events.reduce((sum, event) => sum + event.visible_characters, 0),
    responseCount: events.length,
  }
}

function publicError(value: unknown) {
  return redactPublicValue(value)
}

function redactPublicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPublicValue)
  if (typeof value === 'string') return redactPrivatePaths(value)
  const object = record(value)
  if (!object) return value
  const redacted: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(object)) {
    if (/token|cookie|authorization|storage|checkpoint|claim|directory|paths?$/i.test(key)) continue
    redacted[key] = redactPublicValue(entry)
  }
  return redacted
}

function redactPrivatePaths(value: string) {
  return value
    .replace(/(^|[\s("'=])\/(?:Users|home|private|var|tmp|opt|Volumes)\/[^\s"'<>]*/g, '$1[redacted path]')
    .replace(/(^|[\s("'=])[A-Za-z]:\\[^\s"'<>]*/g, '$1[redacted path]')
}

function profileConfig(config: TokenlessConfig, slug: string): ManagedProfileConfig {
  const configured = config.profiles[slug]
  if (!configured) throw applicationError('profile_not_configured', `Managed profile '${slug}' has no configuration.`)
  return configured
}

function configurableProviderIds(): ProviderId[] {
  return listProviderDescriptors()
    .filter((provider) => provider.stage !== 'disabled')
    .sort((left, right) => left.setupOrder - right.setupOrder)
    .map((provider) => provider.id)
}

function supportedProviderIds() {
  return listProviderDescriptors().filter((provider) => provider.stage !== 'disabled').map((provider) => provider.id)
}

function providerList(value: unknown): string[] {
  if (!Array.isArray(value)) throw applicationError('invalid_provider_list', 'Enabled providers must be an array.')
  const supported = new Set(supportedProviderIds())
  const providers = [...new Set(value.filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase()))]
  if (providers.some((provider) => !supported.has(provider as ProviderId))) {
    throw applicationError('invalid_provider_list', 'Enabled providers include an unsupported provider.')
  }
  return providers
}

function requiredVisibility(value: unknown) {
  const visibility = normalizeBrowserVisibility(value)
  if (!visibility) throw applicationError('invalid_browser_visibility', 'Browser visibility is invalid.')
  return visibility
}

function requireNativeChromeVisibility(value: ReturnType<typeof requiredVisibility>) {
  if (value !== 'headed') {
    throw applicationError(
      'native_chrome_headless_unsupported',
      'Native Chrome uses the browser already opened by the user and supports headed mode only.',
    )
  }
}

function requiredSlug(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw applicationError('invalid_profile_slug', 'Profile slug must use lowercase letters, numbers, and hyphens.')
  }
  return value
}

function optionalRoleLabel(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim().length > 80) {
    throw applicationError('invalid_role_label', 'Role label must be at most 80 characters.')
  }
  return value.trim().replace(/\s+/g, ' ')
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw applicationError(`invalid_${field}`, `${field} is invalid.`)
  }
  return value.trim()
}

function requireKnownFields(input: Record<string, unknown>, allowed: string[]) {
  const accepted = new Set(allowed)
  const unknown = Object.keys(input).filter((key) => !accepted.has(key))
  if (unknown.length > 0) {
    throw applicationError('invalid_fields', `Unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`)
  }
}

function usableAccess(value: unknown) {
  return value === 'guest' || value === 'signed_in_free' || value === 'signed_in_paid' || value === 'signed_in_unknown'
}

function revisionFor(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 24)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function applicationError(code: string, message: string, params: Record<string, string | number> = {}) {
  return Object.assign(new Error(message), {
    code,
    messageKey: `error.${code}`,
    params,
    status: 400,
  })
}
