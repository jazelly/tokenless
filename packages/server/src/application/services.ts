import { createHash, randomUUID } from 'node:crypto'
import {
  configPath,
  readTokenlessConfig,
  upsertTokenlessProfileConfig,
  writeTokenlessConfig,
  type ManagedProfileConfig,
  type TokenlessConfig,
} from '../persistence/config.js'
import { tokenlessPackageVersion } from '../platform-package.js'
import { BrowserRuntimeManager } from '../browser/runtime/manager.js'
import { normalizeBrowserSelection } from '../browser/runtime/types.js'
import { normalizeBrowserVisibility } from '../browser-visibility.js'
import {
  createManagedPlaywrightJobRequest,
  MANAGED_PLAYWRIGHT_JOB_ACTION,
} from '../browser/job-contract.js'
import { VISIBLE_ACTIONS } from '../providers/contracts.js'
import { isG4fDirectOnlyProvider } from '../providers/direct/g4f-map.js'
import {
  listProviderDescriptors,
  listProviderInstances,
  listProviderTaskCapabilityRoutes,
  listTaskCapabilityDefinitions,
  normalizeTaskCapabilityRequirements,
  resolveTaskCapabilityRoutes,
  TASK_CAPABILITY_CATALOG_SCHEMA_ID,
  type ProviderId,
} from '../providers/registry.js'
import {
  ManagedProfileRegistry,
  type ProviderStatus,
  type ManagedProfileRecord,
} from '../browser/profiles/registry.js'
import {
  publicView,
  type Job,
  type JobStore,
  type JobView,
  type OutputSavingsEvent,
  type OutputSavingsSummary,
} from '../jobs/store.js'
import type { BrowserRuntimeController } from '../runtime/browser-controller.js'
import { OUTPUT_SAVINGS_ESTIMATOR } from '../output-savings/catalog.js'
import { OutputSavingsRuntimeManager } from '../output-savings/runtime-manager.js'
import type {
  DashboardConfig,
  DashboardConfigDocument,
  DashboardConfigUpdate,
  DashboardConfirmedDeletion,
  DashboardDiagnostic,
  DashboardJobDetail,
  DashboardJobSummary,
  DashboardOutputSavingsState,
  DashboardProfile,
  DashboardProfileCreate,
  DashboardProfileRemoval,
  DashboardProfileUpdate,
  DashboardProviderAction,
  DashboardProviderExecutionMode,
  DashboardProviderReadinessRefresh,
  DashboardProviderSelection,
  DashboardRuntimeOpenResult,
  DashboardRuntimeStatus,
  DashboardSetupInput,
  DashboardSetupSnapshot,
  DashboardSnapshot,
} from 'tokenless-internal-shared/dashboard'

export type DashboardApplicationServicesOptions = {
  store: JobStore
  runtimeController?: BrowserRuntimeController | undefined
  origin: () => string
  startedAt: number
}

export class TokenlessApplicationServices {
  readonly store: JobStore
  readonly profiles: ManagedProfileRegistry
  readonly runtimeManager: BrowserRuntimeManager
  readonly outputSavingsRuntimeManager: OutputSavingsRuntimeManager

  private readonly runtimeController: BrowserRuntimeController | undefined
  private readonly origin: () => string
  private readonly startedAt: number

  constructor(options: DashboardApplicationServicesOptions) {
    this.store = options.store
    this.profiles = new ManagedProfileRegistry(options.store.homeDir)
    this.runtimeManager = new BrowserRuntimeManager({ homeDir: options.store.homeDir })
    this.outputSavingsRuntimeManager = new OutputSavingsRuntimeManager(options.store.homeDir)
    this.runtimeController = options.runtimeController
    this.origin = options.origin
    this.startedAt = options.startedAt
  }

  async snapshot(): Promise<DashboardSnapshot> {
    const [config, profileData, jobs] = await Promise.all([
      this.readConfig(),
      this.profiles.read(),
      Promise.resolve(this.store.listJobs({ limit: 200 })),
    ])
    const profiles = Object.values(profileData.profiles)
      .sort((left, right) => left.slug.localeCompare(right.slug))
    const runtime = this.runtimeController?.status() ?? {
      status: 'stopped' as const,
      activeProfileCount: 0,
      activeJobCount: 0,
      pid: process.pid,
    }
    const daemonOrigin = this.origin()
    const directEntryUrl = new URL('/v1/chat/completions', daemonOrigin).href
    const providers = listProviderDescriptors()
      .sort((left, right) => left.setupOrder - right.setupOrder)
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        stage: provider.stage,
        executionModes: provider.executionModes,
        subscriptionSupport: provider.subscriptionSupport,
        entryUrls: {
          browser: provider.executionModes.includes('browser') ? provider.navigation.entryUrl : null,
          direct: provider.executionModes.includes('direct') ? directEntryUrl : null,
        },
      }))
    const capabilityRoutes = listProviderTaskCapabilityRoutes()
    const outputSavings = await this.outputSavingsState(config)
    const [nativeBrowser, setup] = await Promise.all([
      this.inspectConfiguredBrowser(config),
      this.setupSnapshot(config, profileData.defaultProfile),
    ])
    const body = {
      schema: 'tokenless.dashboard-snapshot.v1' as const,
      generatedAt: new Date().toISOString(),
      daemon: {
        version: tokenlessPackageVersion(),
        origin: daemonOrigin,
        uptimeMs: Math.max(0, Date.now() - this.startedAt),
        pid: process.pid,
      },
      runtime,
      config: publicConfig(config),
      setup,
      outputSavings,
      profiles: profiles.map((profile) => publicProfile(
        profile,
        profileData.defaultProfile,
        profileConfig(config, profile.slug),
        config.browser,
        nativeBrowser.runtime?.actualVersion ?? null,
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
        publicConversationUrl(this.store, job),
      )),
      diagnostics: await this.diagnostics(config, profiles, runtime, outputSavings, nativeBrowser),
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

  async job(jobId: string): Promise<DashboardJobDetail> {
    const job = this.store.getJob(jobId)
    return publicJobDetail(
      job,
      await this.profiles.listProfiles(),
      this.store.outputSavingsForJob(jobId),
      publicConversationUrl(this.store, job),
    )
  }

  async menuBarSnapshot() {
    const [registry, jobs] = await Promise.all([
      this.profiles.read(),
      Promise.resolve(this.store.listJobs({ limit: 10, order_by: 'updated_at', conversation_only: true })),
    ])
    const profiles = Object.values(registry.profiles)
    const runtime = this.runtimeController?.status() ?? {
      status: 'stopped' as const,
      activeProfileCount: 0,
      activeJobCount: 0,
      pid: process.pid,
    }
    const conversations = jobs
      .map((job) => menuBarConversation(job, profiles))
      .filter((conversation): conversation is NonNullable<typeof conversation> => conversation !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.jobId.localeCompare(left.jobId))
      .slice(0, 10)
    return {
      schema: 'tokenless.menu-bar-snapshot.v1' as const,
      generatedAt: new Date().toISOString(),
      daemon: {
        status: 'running' as const,
        version: tokenlessPackageVersion(),
        origin: this.origin(),
        pid: process.pid,
      },
      runtime,
      activeJobCount: runtime.activeJobCount,
      conversations,
    }
  }

  async controlState() {
    const [config, registry, outputSavings] = await Promise.all([
      this.readConfig(),
      this.profiles.read(),
      this.outputSavingsState(),
    ])
    return {
      config,
      profiles: Object.values(registry.profiles)
        .sort((left, right) => left.slug.localeCompare(right.slug)),
      defaultProfile: registry.defaultProfile,
      profileRegistryPath: configPath(this.store.homeDir),
      runtime: this.runtimeController?.status() ?? {
        status: 'stopped' as const,
        activeProfileCount: 0,
        activeJobCount: 0,
        pid: process.pid,
      },
      outputSavings,
    }
  }

  async configDocument(): Promise<DashboardConfigDocument> {
    return {
      ...await this.readConfig(),
      configPath: configPath(this.store.homeDir),
    }
  }

  async resolveControlProfile(slug?: string) {
    const [profile, registry, config] = await Promise.all([
      this.profiles.resolveProfile(slug),
      this.profiles.read(),
      this.readConfig(),
    ])
    return {
      profile,
      defaultProfile: registry.defaultProfile,
      config,
    }
  }

  controlCapabilities() {
    return {
      schema: TASK_CAPABILITY_CATALOG_SCHEMA_ID,
      capabilities: listTaskCapabilityDefinitions().map((definition) => {
        const routes = listProviderTaskCapabilityRoutes(definition.id)
        return {
          ...definition,
          routeable: routes.length > 0,
          routes,
        }
      }),
    }
  }

  async resolveControlExecution(input: {
    profile?: string
    provider?: string
    requirements: string[]
    executionMode: 'browser' | 'direct'
  }) {
    requireKnownFields(input, ['profile', 'provider', 'requirements', 'executionMode'])
    const requirements = normalizeTaskCapabilityRequirements(input.requirements)
    const profile = await this.profiles.resolveProfile(input.profile)
    const config = await this.readConfig()
    const configured = profileConfig(config, profile.slug)
    const explicitProvider = input.provider === undefined
      ? undefined
      : listProviderDescriptors().find((candidate) => candidate.id === input.provider)?.id
    if (input.provider !== undefined && explicitProvider === undefined) {
      return {
        ok: false as const,
        code: 'provider_not_supported',
        message: `Unsupported provider: ${input.provider}`,
        context: { provider: input.provider },
      }
    }
    if (explicitProvider && !configured.enabledProviders.includes(explicitProvider)) {
      return {
        ok: false as const,
        code: 'provider_not_enabled',
        message: `Provider '${explicitProvider}' is not enabled for profile '${profile.slug}'.`,
        context: { profile: { slug: profile.slug }, provider: explicitProvider },
      }
    }
    const candidates = explicitProvider
      ? [{
          provider: explicitProvider,
          observed: profile.lastObservedAuth[explicitProvider] !== undefined,
          usable: true,
          runtimeEligibility: 'unchecked' as const,
          auth: profile.lastObservedAuth[explicitProvider]?.auth ?? 'unknown',
          access: profile.lastObservedAuth[explicitProvider]?.access ?? 'unknown',
          checkedAt: profile.lastObservedAuth[explicitProvider]?.checkedAt ?? null,
          tier: profile.lastObservedAuth[explicitProvider]?.account?.tier ?? null,
        }]
      : configured.enabledProviders.map((provider) => controlProviderObservation(profile, provider as ProviderId))
    const decision = resolveTaskCapabilityRoutes({
      requirements,
      executionMode: input.executionMode,
      candidates: candidates.map((provider, preferenceRank) => ({
        provider: provider.provider,
        runtimeEligibility: explicitProvider ? 'unchecked' : provider.runtimeEligibility,
        reason: provider.usable ? null : `provider_access_${provider.access}`,
        preferenceRank,
      })),
    })
    if (decision.ok) {
      return { ok: true as const, profile, routes: decision.routes }
    }
    const runtimeProviderUnavailable = !explicitProvider && candidates.every((provider) => provider.runtimeEligibility === 'ineligible')
    const providerUnavailable = requirements.length === 0 || runtimeProviderUnavailable
    return {
      ok: false as const,
      code: providerUnavailable ? 'provider_unavailable' : decision.code,
      message: providerUnavailable
        ? `No configured provider is currently usable for profile '${profile.slug}'. Run "tokenless setup" or sign in to a provider, then rerun the command.`
        : decision.message,
      context: {
        profile: { slug: profile.slug },
        requirements: decision.requirements,
        providers: providerUnavailable ? candidates : decision.evaluated,
        usableProviders: explicitProvider
          ? []
          : candidates.filter((provider) => provider.usable).map((provider) => provider.provider),
        nextAction: providerUnavailable
          ? 'Run "tokenless setup" to refresh provider access observations, or pass --provider to target a provider explicitly.'
          : 'Choose a provider scope with an evidence-backed route, remove unsupported capabilities, or complete the required real-provider E2E closure.',
      },
    }
  }

  async addControlProfile(input: {
    slug: string
    setDefault?: boolean
    browser?: string | null
    providerWhitelist?: string[]
  }) {
    requireKnownFields(input, ['slug', 'setDefault', 'browser', 'providerWhitelist'])
    const browser = input.browser === undefined ? null : input.browser
    let runtimeBinding
    if (browser !== null) {
      const selection = normalizeBrowserSelection(browser)
      if (selection !== 'managed-chromium' && selection !== 'cloak') {
        throw applicationError(
          'profile_managed_browser_required',
          'Profiles add supports managed-chromium or cloak when a browser is specified.',
        )
      }
      const runtime = await this.runtimeManager.ensure(selection, { allowDownload: false })
      runtimeBinding = {
        runtimeId: runtime.runtimeId,
        family: runtime.family,
        browserId: runtime.browserId,
        executablePath: runtime.executablePath,
        createdWithVersion: runtime.actualVersion,
        profileFormat: 1 as const,
      }
    }
    const profile = await this.profiles.addProfile({
      slug: input.slug,
      setDefault: input.setDefault === true,
      ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
    })
    const config = await this.readConfig()
    const configured = config.profiles[profile.slug]
    if (!configured) {
      throw applicationError('profile_not_configured', `Managed profile '${profile.slug}' has no configuration.`)
    }
    if (input.providerWhitelist !== undefined) {
      await upsertTokenlessProfileConfig({
        homeDir: this.store.homeDir,
        slug: profile.slug,
        profile: { ...configured, enabledProviders: input.providerWhitelist },
      })
    }
    return {
      profile,
      defaultProfile: (await this.profiles.read()).defaultProfile,
    }
  }

  async clearControlProfiles(input: { profile?: string; all?: boolean }) {
    requireKnownFields(input, ['profile', 'all'])
    const clearAll = input.all === true
    if (clearAll === (input.profile !== undefined)) {
      throw applicationError('profile_clear_target_required', 'Exactly one profile or all profiles must be selected.')
    }
    const targets = clearAll
      ? await this.profiles.listProfiles()
      : [await this.profiles.resolveProfile(input.profile)]
    this.assertProfilesHaveNoPendingJobs(targets)
    await this.runtimeController?.quiesce()
    try {
      this.assertProfilesHaveNoPendingJobs(targets)
      const cleared = []
      for (const profile of targets) {
        const removed = await this.profiles.removeProfile(profile.slug, { confirmDelete: true })
        cleared.push(removed)
      }
      return {
        cleared,
        defaultProfile: (await this.profiles.read()).defaultProfile,
      }
    } finally {
      await this.runtimeController?.wake()
    }
  }

  async setDefaultControlProfile(slug: string) {
    const profile = await this.profiles.setDefault(slug)
    return { profile, defaultProfile: profile.slug }
  }

  async removeControlProfile(slug: string) {
    const target = await this.profiles.resolveProfile(slug)
    this.assertProfilesHaveNoPendingJobs([target])
    await this.runtimeController?.quiesce()
    try {
      this.assertProfilesHaveNoPendingJobs([target])
      const profile = await this.profiles.removeProfile(slug, { confirmDelete: true })
      return { profile, defaultProfile: (await this.profiles.read()).defaultProfile }
    } finally {
      await this.runtimeController?.wake()
    }
  }

  async updateControlProfileObservation(slug: string, input: ProviderStatus) {
    requireKnownFields(input, ['provider', 'auth', 'access', 'checkedAt', 'account'])
    const profile = await this.profiles.updateProviderStatus(slug, input)
    return { profile, defaultProfile: (await this.profiles.read()).defaultProfile }
  }

  async updateControlProfileConfig(slug: string, input: ManagedProfileConfig) {
    await this.profiles.resolveProfile(slug)
    const config = await upsertTokenlessProfileConfig({
      homeDir: this.store.homeDir,
      slug,
      profile: input,
    })
    return { config, profile: config.profiles[slug] }
  }

  async updateControlConfig(input: Record<string, unknown>) {
    requireKnownFields(input, [
      'browser',
      'browserExecutablePath',
      'browserVisibility',
      'daemonUrl',
      'language',
      'outputSavings',
      'apiProxy',
      'g4f',
      'directProvider',
      'router',
    ])
    let browserExecutablePath = input.browserExecutablePath
    if (typeof browserExecutablePath === 'string') {
      const current = await this.readConfig()
      const browser = normalizeBrowserSelection(input.browser ?? current.browser)
      if (browser !== 'chrome' && browser !== 'brave') {
        throw applicationError('native_chrome_required', 'Tokenless native mode supports Google Chrome or Brave Browser.')
      }
      const runtime = await this.runtimeManager.ensure(browser, {
        allowDownload: false,
        browserExecutablePath,
      })
      browserExecutablePath = runtime.executablePath
    }
    return await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      browser: input.browser,
      browserExecutablePath,
      browserVisibility: input.browserVisibility,
      daemonUrl: input.daemonUrl,
      language: input.language,
      outputSavings: input.outputSavings,
      apiProxy: input.apiProxy,
      g4f: input.g4f,
      directProvider: input.directProvider,
      router: input.router,
    })
  }

  async enableOutputSavings(): Promise<DashboardOutputSavingsState> {
    await this.outputSavingsRuntimeManager.ensureInstalled()
    const config = await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      outputSavings: { enabled: true },
    })
    return await this.outputSavingsState(config)
  }

  async controlOutputSavingsState() {
    const config = await this.readConfig()
    const runtime = await this.outputSavingsRuntimeManager.inspect()
    const state = {
      enabled: config.outputSavings.enabled,
      collection: config.outputSavings.enabled
        ? runtime.state === 'ready' ? 'enabled' as const : 'unavailable' as const
        : 'disabled' as const,
      estimator: OUTPUT_SAVINGS_ESTIMATOR,
      runtime,
      summary: this.store.outputSavingsSummary(),
    }
    return state
  }

  async disableOutputSavings(): Promise<DashboardOutputSavingsState> {
    const config = await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      outputSavings: { enabled: false },
    })
    return await this.outputSavingsState(config)
  }

  async uninstallOutputSavings(input: DashboardConfirmedDeletion): Promise<DashboardOutputSavingsState> {
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
    await this.outputSavingsRuntimeManager.remove()
    return await this.outputSavingsState(config)
  }

  async clearOutputSavings(input: DashboardConfirmedDeletion): Promise<DashboardOutputSavingsState> {
    requireKnownFields(input, ['confirmDelete'])
    if (input.confirmDelete !== true) {
      throw applicationError(
        'output_savings_clear_confirmation_required',
        'Output savings history removal requires explicit confirmation.',
      )
    }
    const cleared = this.store.clearOutputSavings().cleared
    return {
      ...await this.outputSavingsState(),
      cleared,
    }
  }

  async updateConfig(input: DashboardConfigUpdate): Promise<DashboardConfig> {
    requireKnownFields(input, [
      'defaultProfile',
      'browser',
      'browserExecutablePath',
      'browserVisibility',
      'daemonUrl',
      'language',
      'outputSavings',
      'apiProxy',
      'g4f',
      'directProvider',
      'router',
    ])
    const current = await this.readConfig()
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
      defaultProfile: input.defaultProfile,
      browser: requestedBrowser,
      browserExecutablePath: requestedBrowserExecutablePath,
      browserVisibility: 'headed',
      daemonUrl: input.daemonUrl,
      language,
      outputSavings: input.outputSavings,
      apiProxy: input.apiProxy,
      g4f: input.g4f,
      directProvider: input.directProvider,
      router: input.router,
    })
    return publicConfig(saved)
  }

  async setup(input: DashboardSetupInput): Promise<DashboardProfile> {
    requireKnownFields(input, [
      'slug',
      'roleLabel',
      'enabledProviders',
      'browser',
      'browserExecutablePath',
      'language',
      'browserVisibility',
      'setDefault',
    ])
    const slug = requiredSlug(input.slug)
    const browserVisibility = input.browserVisibility === undefined
      ? 'headed'
      : requiredVisibility(input.browserVisibility)
    requireNativeChromeVisibility(browserVisibility)
    const currentConfig = await this.readConfig()
    const language = input.language === undefined ? currentConfig.language : input.language
    if (language !== 'en' && language !== 'zh-CN') {
      throw applicationError('invalid_language', 'Language must be en or zh-CN.')
    }
    const requestedRoleLabel = input.roleLabel === undefined
      ? undefined
      : optionalRoleLabel(input.roleLabel) ?? ''
    const requestedProviders = input.enabledProviders === undefined
      ? configurableProviderIds()
      : providerList(input.enabledProviders)
    const browser = input.browser === 'cloak' || input.browser === 'chrome' || input.browser === 'brave'
      ? input.browser
      : null
    if (!browser) throw applicationError('invalid_browser', 'Setup browser must be chrome, brave, or cloak.')

    const configuredPath = input.browserExecutablePath === undefined || input.browserExecutablePath === null
      ? null
      : String(input.browserExecutablePath).trim()
    if (configuredPath === '') {
      throw applicationError('browser_executable_path_invalid', 'Browser executable path must be empty or an absolute path.')
    }
    const runtime = await this.runtimeManager.ensure(browser, {
      allowDownload: false,
      ...(browser === 'cloak' || configuredPath === null
        ? {}
        : { browserExecutablePath: configuredPath }),
    })
    const runtimeBinding = {
      runtimeId: runtime.runtimeId,
      family: runtime.family,
      browserId: runtime.browserId,
      executablePath: runtime.executablePath,
      createdWithVersion: runtime.actualVersion,
      profileFormat: 1 as const,
    }

    const registry = await this.profiles.read()
    const existing = registry.profiles[slug]
    if (existing?.runtimeBinding && !sameRuntimeIdentity(existing.runtimeBinding, runtimeBinding)) {
      throw applicationError(
        'profile_runtime_rebind_blocked',
        `Managed profile '${slug}' is already bound to ${existing.runtimeBinding.runtimeId}; create a clean profile for ${runtimeBinding.runtimeId}.`,
      )
    }

    const configuredProfile = currentConfig.profiles[slug]
    const profileConfiguration: ManagedProfileConfig = configuredProfile
      ? {
          roleLabel: requestedRoleLabel ?? configuredProfile.roleLabel,
          enabledProviders: input.enabledProviders === undefined
            ? configuredProfile.enabledProviders
            : requestedProviders,
          providerModes: configuredProfile.providerModes,
          browserVisibility: 'headed',
          proxy: configuredProfile.proxy,
        }
      : {
          roleLabel: requestedRoleLabel ?? '',
          enabledProviders: requestedProviders,
          providerModes: defaultProviderModes(),
          browserVisibility: 'headed',
          proxy: null,
        }
    const bindingForProfile = existing?.runtimeBinding ?? runtimeBinding

    if (browser !== 'cloak') {
      await this.updateConfig({
        browser,
        browserExecutablePath: runtime.executablePath,
        language,
      })
    } else if (language !== currentConfig.language) {
      await this.updateConfig({ language })
    }
    let profile = existing
    if (!profile) {
      profile = await this.profiles.addProfile({
        slug,
        runtimeBinding: bindingForProfile,
        setDefault: input.setDefault === true,
      })
    } else if (existing && !existing.runtimeBinding) {
      profile = await this.profiles.bindRuntime(slug, runtimeBinding)
    }
    if (input.setDefault === true) profile = await this.profiles.setDefault(slug)
    await this.updateProfileConfig(profile, profileConfiguration)
    const savedConfig = await this.readConfig()
    const configured = profileConfig(savedConfig, profile.slug)
    return publicProfile(
      profile,
      (await this.profiles.read()).defaultProfile,
      configured,
      savedConfig.browser,
      runtime.actualVersion,
    )
  }

  async createProfile(input: DashboardProfileCreate): Promise<DashboardProfile> {
    requireKnownFields(input, ['slug', 'roleLabel', 'enabledProviders', 'providerModes', 'browserVisibility', 'proxy', 'setDefault'])
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
      providerModes: input.providerModes === undefined ? defaultProviderModes() : providerModes(input.providerModes),
      browserVisibility: 'headed' as const,
      proxy: input.proxy === undefined ? null : input.proxy,
    }
    const profile = await this.profiles.addProfile({
      slug,
      setDefault: input.setDefault === true,
    })
    try {
      await this.updateProfileConfig(profile, profileConfiguration)
      const config = await this.readConfig()
      const browser = await this.inspectConfiguredBrowser(config)
      return publicProfile(profile, (await this.profiles.read()).defaultProfile, profileConfig(config, profile.slug), config.browser, browser.runtime?.actualVersion ?? null)
    } catch (error) {
      await this.profiles.removeProfile(slug, { confirmDelete: true }).catch(() => undefined)
      throw error
    }
  }

  async updateProfile(slug: string, input: DashboardProfileUpdate): Promise<DashboardProfile> {
    requireKnownFields(input, ['roleLabel', 'enabledProviders', 'providerModes', 'browserVisibility', 'proxy', 'setDefault'])
    let profile = await this.profiles.resolveProfile(slug)
    const current = profileConfig(await this.readConfig(), profile.slug)
    const browserVisibility = input.browserVisibility === undefined
      ? current.browserVisibility
      : requiredVisibility(input.browserVisibility)
    requireNativeChromeVisibility(browserVisibility)
    const next = {
      roleLabel: input.roleLabel === undefined ? current.roleLabel : optionalRoleLabel(input.roleLabel) ?? '',
      enabledProviders: input.enabledProviders === undefined
        ? current.enabledProviders
        : providerList(input.enabledProviders),
      providerModes: input.providerModes === undefined ? current.providerModes : providerModes(input.providerModes),
      browserVisibility: 'headed' as const,
      proxy: input.proxy === undefined ? current.proxy : input.proxy,
    }
    if (input.setDefault === true) profile = await this.profiles.setDefault(slug)
    await this.updateProfileConfig(profile, next)
    const config = await this.readConfig()
    const browser = await this.inspectConfiguredBrowser(config)
    return publicProfile(profile, (await this.profiles.read()).defaultProfile, profileConfig(config, profile.slug), config.browser, browser.runtime?.actualVersion ?? null)
  }

  async removeProfile(slug: string): Promise<DashboardProfileRemoval> {
    const target = await this.profiles.resolveProfile(slug)
    this.assertProfilesHaveNoPendingJobs([target])
    await this.runtimeController?.quiesce()
    try {
      this.assertProfilesHaveNoPendingJobs([target])
      const profile = await this.profiles.removeProfile(slug, { confirmDelete: true })
      return { slug: profile.slug, removed: true }
    } finally {
      await this.runtimeController?.wake()
    }
  }

  private assertProfilesHaveNoPendingJobs(profiles: readonly ManagedProfileRecord[]) {
    for (const profile of profiles) {
      const pending = (['queued', 'running', 'waiting_for_user'] as const).some((status) => (
        this.store.listJobs({ profile_id: profile.slug, status, limit: 1 }).length > 0
      ))
      if (pending) {
        throw applicationError(
          'profile_mutation_unsafe',
          `Profile '${profile.slug}' cannot be removed while it has pending browser jobs.`,
        )
      }
    }
  }

  async providerAction(slug: string, providerValue: string, action: DashboardProviderAction): Promise<DashboardJobSummary> {
    const profile = await this.profiles.resolveProfile(slug)
    const provider = listProviderInstances().find((candidate) => candidate.id === providerValue)
    if (!provider || provider.descriptor.stage === 'disabled') {
      throw applicationError('provider_not_supported', 'Provider is not supported.')
    }
    assertBrowserProviderActionAllowed(provider.id)
    const configured = profileConfig(await this.readConfig(), profile.slug)
    if (!configured.enabledProviders.includes(provider.id)) {
      throw applicationError('provider_not_enabled', 'Enable the provider for this profile before opening it.')
    }
    assertProviderModeEnabled(configured, provider.id, 'browser')
    const job = this.createProviderActionJob(profile, provider.id, action)
    await this.runtimeController?.wake()
    return job
  }

  async refreshProviderReadiness(slug: string): Promise<DashboardProviderReadinessRefresh> {
    const profile = await this.profiles.resolveProfile(slug)
    const configured = profileConfig(await this.readConfig(), profile.slug)
    const enabled = new Set(configured.enabledProviders)
    const batchId = randomUUID()
    const jobs = listProviderInstances()
      .filter((provider) => provider.descriptor.stage !== 'disabled' && enabled.has(provider.id))
      .filter((provider) => provider.descriptor.executionModes.includes('browser'))
      .filter((provider) => configured.providerModes[provider.id]?.includes('browser'))
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
      request_json: request,
      profile_id: profile.slug,
      ...(identity === undefined ? {} : { job_id: identity.jobId }),
    })
    return publicJobSummary(publicView(job), [profile])
  }

  async providerSelection(
    slug: string,
    providerValue: string,
    input: DashboardProviderSelection,
  ): Promise<DashboardJobSummary> {
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
    assertBrowserProviderActionAllowed(provider.id)
    const configured = profileConfig(await this.readConfig(), profile.slug)
    if (!configured.enabledProviders.includes(provider.id)) {
      throw applicationError('provider_not_enabled', 'Enable the provider for this profile before changing controls.')
    }
    assertProviderModeEnabled(configured, provider.id, 'browser')
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
      request_json: request,
      profile_id: profile.slug,
    })
    await this.runtimeController?.wake()
    return publicJobSummary(job, [profile])
  }

  async openProfile(slug: string): Promise<DashboardRuntimeOpenResult> {
    const profile = await this.profiles.resolveProfile(slug)
    if (!this.runtimeController) throw applicationError('browser_runtime_unavailable', 'Browser runtime is unavailable.')
    return await this.runtimeController.openProfile(profile.slug, 'headed')
  }

  async quiesceRuntime(): Promise<DashboardRuntimeStatus> {
    return await this.runtimeController?.quiesce() ?? {
      status: 'stopped', activeProfileCount: 0, activeJobCount: 0, pid: process.pid,
    }
  }

  async cancelJob(jobId: string): Promise<DashboardJobDetail> {
    return publicJobDetail(await this.store.cancelJob(jobId, { source: 'ui' }), await this.profiles.listProfiles())
  }

  private async readConfig() {
    return await readTokenlessConfig(this.store.homeDir)
  }

  private async inspectConfiguredBrowser(config: TokenlessConfig) {
    return await this.runtimeManager.inspect(config.browser, {
      browserExecutablePath: config.browserExecutablePath,
    })
  }

  private async setupSnapshot(
    config: TokenlessConfig,
    defaultProfileSlug: string | null,
  ): Promise<DashboardSetupSnapshot> {
    const candidates = await Promise.all((['chrome', 'brave', 'cloak'] as const).map(async (selection) => {
      const inspection = await this.runtimeManager.inspect(selection, {
        allowDownload: false,
        ...(selection === config.browser && config.browserExecutablePath
          ? { browserExecutablePath: config.browserExecutablePath }
          : {}),
      })
      if (!inspection.ok || !inspection.runtime) return null
      const runtime = inspection.runtime
      return {
        browserId: selection,
        runtimeId: runtime.runtimeId,
        family: selection === 'cloak' ? 'cloak' as const : 'system' as const,
        label: runtime.displayName,
        version: runtime.actualVersion,
        source: runtime.source,
        executablePath: runtime.executablePath,
        managed: runtime.managed,
      }
    }))
    return {
      browserCandidates: candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null),
      defaultProfileSlug,
      configuredProfileSlugs: Object.keys(config.profiles),
    }
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
    browser: Awaited<ReturnType<BrowserRuntimeManager['inspect']>>,
  ): Promise<DashboardDiagnostic[]> {
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
        state: profiles.length > 0 ? 'ok' : 'action_required',
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
    const resolvedConfig = config ?? await this.readConfig()
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
    router: config.router,
  }
}

function publicProfile(
  profile: ManagedProfileRecord,
  defaultSlug: string | null,
  configured: ManagedProfileConfig,
  configuredBrowser: string,
  configuredBrowserVersion: string | null,
) {
  const browserBinding = profile.runtimeBinding
    ? {
        browserId: profile.runtimeBinding.browserId,
        runtimeId: profile.runtimeBinding.runtimeId,
        family: profile.runtimeBinding.family,
        version: profile.runtimeBinding.createdWithVersion,
      }
    : {
        browserId: configuredBrowser,
        runtimeId: `native:${configuredBrowser}`,
        family: 'system',
        version: configuredBrowserVersion,
      }
  return {
    slug: profile.slug,
    isDefault: profile.slug === defaultSlug,
    browserMode: browserBinding.family === 'system' ? 'native' as const : 'managed' as const,
    browserBinding,
    roleLabel: configured.roleLabel,
    enabledProviders: configured.enabledProviders,
    providerModes: configured.providerModes,
    browserVisibility: configured.browserVisibility,
    proxy: configured.proxy,
    observations: Object.values(profile.lastObservedAuth).map((status) => status ? {
      provider: status.provider,
      auth: status.auth,
      access: status.access,
      checkedAt: status.checkedAt,
      account: status.auth === 'authenticated' ? status.account ?? null : null,
    } : null).filter((observation): observation is NonNullable<typeof observation> => observation !== null),
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
    enabledModes: configured.providerModes[provider] ?? [],
    observation: observation ? {
      auth: observation.auth,
      access: observation.access,
      checkedAt: observation.checkedAt,
      account: observation.auth === 'authenticated' ? observation.account ?? null : null,
    } : null,
    runtimeEligibility: configured.enabledProviders.includes(provider) && usableAccess(observation?.access)
      ? 'eligible' as const
      : 'ineligible' as const,
    capabilities: routes.filter((route) => route.provider === provider).map((route) => ({
      id: route.capability,
      support: route.support,
    })),
    controls: latestProviderControls(jobs, profile.slug, provider),
  }
}

function controlProviderObservation(profile: ManagedProfileRecord, provider: ProviderId) {
  const observed = profile.lastObservedAuth[provider]
  const access = observed?.access ?? (observed?.auth === 'authenticated' ? 'signed_in_unknown' : 'unknown')
  const usable = access === 'guest' || access.startsWith('signed_in_')
  const checkedAt = observed?.checkedAt ?? null
  const checkedAtMs = checkedAt === null ? Number.NaN : Date.parse(checkedAt)
  const fresh = Number.isFinite(checkedAtMs) && Date.now() - checkedAtMs <= 5 * 60 * 1000
  return {
    provider,
    observed: observed !== undefined,
    usable,
    runtimeEligibility: usable ? (fresh ? 'eligible' as const : 'unchecked' as const) : 'ineligible' as const,
    auth: observed?.auth ?? 'unknown',
    access,
    checkedAt,
    tier: observed?.account?.tier ?? null,
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
  conversationUrl: string | null = null,
) {
  const request = record(job.request_json)
  const prompt = publicPrompt(request)
  const response = publicResponse(job.result_json)
  const measuredOutputTokens = publicJobOutputSavings(outputSavings).estimatedOutputTokens
  const outputTokens = measuredOutputTokens > 0
    ? measuredOutputTokens
    : response ? estimatedTextTokens(response) : 0
  const titlePrompt = promptTitle(prompt)
  const executionMode = request?.executionMode === 'browser' || request?.executionMode === 'direct'
    ? request.executionMode as 'browser' | 'direct'
    : null
  return {
    jobId: job.job_id,
    profileId: job.profile_id,
    profileSlug: profiles.find((profile) => profile.slug === job.profile_id)?.slug ?? null,
    provider: job.provider,
    action: MANAGED_PLAYWRIGHT_JOB_ACTION,
    status: job.status,
    taskId: typeof request?.taskId === 'string' ? request.taskId : null,
    chatTitle: publicChatTitle(request),
    titlePrompt,
    executionMode,
    providers: publicProviders(job),
    conversationUrl,
    estimatedTokens: prompt === null
      ? (response === null ? null : outputTokens)
      : estimatedTextTokens(prompt) + outputTokens,
    capabilityRoute: record(request?.capabilityRoute),
    blocker: publicError(job.blocker_json),
    outputSavings: publicJobOutputSavings(outputSavings),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  }
}

function menuBarConversation(job: JobView | Job, profiles: ManagedProfileRecord[]) {
  const request = record(job.request_json)
  const prompt = publicPrompt(request)
  const title = menuBarTitle(request, prompt)
  if (!title) return null
  const profile = profiles.find((candidate) => candidate.slug === job.profile_id)
  const providers = publicProviders(job)
  return {
    jobId: job.job_id,
    title,
    provider: job.provider,
    providers,
    status: job.status,
    updatedAt: job.updated_at,
    profileId: job.profile_id,
    profileSlug: profile?.slug ?? null,
  }
}

function menuBarTitle(request: Record<string, unknown> | null, prompt: string | null) {
  const explicit = publicChatTitle(request)
  const source = explicit ?? (prompt ? publicUserPrompt(prompt) : '')
  const normalized = source
    .replace(/\[(?:System|Developer|Assistant|Tool|User)\]\s*/giu, ' ')
    .replace(/(?:bearer\s+|(?:api[_ -]?key|token|password|secret)\s*[:=]\s*)\S+/giu, '[redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/giu, '[redacted]')
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const safe = redactPrivatePaths(normalized)
  if (!safe) return null
  return safe.length > 80 ? `${safe.slice(0, 77).trimEnd()}…` : safe
}

function publicJobDetail(
  job: JobView | Job,
  profiles: ManagedProfileRecord[] = [],
  outputSavings: OutputSavingsEvent[] = [],
  conversationUrl: string | null = null,
) {
  const prompt = publicPrompt(record(job.request_json))
  const response = publicResponse(job.result_json)
  return {
    ...publicJobSummary(job, profiles, outputSavings, conversationUrl),
    transcript: [
      ...(prompt ? [{ role: 'user' as const, content: publicUserPrompt(prompt) }] : []),
      ...(response ? [{ role: 'assistant' as const, content: response }] : []),
    ],
    result: redactPublicValue(job.result_json),
    error: publicError(job.error_json),
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

function publicChatTitle(request: Record<string, unknown> | null) {
  const metadata = record(request?.metadata)
  const value = metadata?.chatName ?? request?.chatName
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null
}

function publicPrompt(request: Record<string, unknown> | null) {
  if (!Array.isArray(request?.actions)) return null
  for (const entry of request.actions) {
    const action = record(entry)
    if (action?.action !== 'prompt.input') continue
    const payload = record(action.payload)
    if (typeof payload?.text === 'string' && payload.text.trim()) return payload.text.trim()
  }
  return null
}

function publicUserPrompt(prompt: string) {
  const turns = [...prompt.matchAll(/\[User\]\s*([\s\S]*?)(?=\n\n\[(?:System|Developer|Assistant|Tool|User)\]|$)/giu)]
  return turns.at(-1)?.[1]?.trim() || prompt
}

function promptTitle(prompt: string | null) {
  if (!prompt) return null
  const publicPrompt = publicUserPrompt(prompt)
  let structured: Record<string, unknown> | null = null
  try {
    structured = record(JSON.parse(publicPrompt))
  } catch {
    return publicPrompt.slice(0, 4_000)
  }
  if (
    structured?.kind === 'action_batch_result_continuation' &&
    typeof structured.runId === 'string' && structured.runId.trim() &&
    typeof structured.turn === 'number' && Number.isSafeInteger(structured.turn) && structured.turn > 0 &&
    typeof structured.nonce === 'string' && structured.nonce.trim() &&
    structured.instruction === 'Read the attached untrusted action_batch_result, keep following the uploaded Harness contract, and return the next framed Harness response.' &&
    typeof structured.attachment === 'string' && structured.attachment.trim() &&
    typeof structured.sha256 === 'string' && structured.sha256.trim()
  ) return null
  if (structured?.protocol !== 'tokenless.web-agent/v1') return publicPrompt.slice(0, 4_000)
  if (structured.kind === 'action_batch_result_continuation') return null
  if (structured.kind === 'bootstrap_turn') {
    const task = record(structured.task)
    return typeof task?.content === 'string' && task.content.trim()
      ? task.content.trim().slice(0, 4_000)
      : null
  }
  return publicPrompt.slice(0, 4_000)
}

function publicResponse(value: unknown) {
  const result = record(value)
  if (!Array.isArray(result?.responses)) return null
  for (const entry of result.responses) {
    const response = record(entry)
    if (response?.action !== 'response.read') continue
    const payload = record(response.result)
    if (typeof payload?.text === 'string' && payload.text.trim()) return payload.text.trim()
  }
  return null
}

function publicProviders(job: JobView | Job) {
  return [job.provider]
}

function publicConversationUrl(store: JobStore, job: JobView | Job) {
  const request = record(job.request_json)
  const taskId = typeof request?.taskId === 'string' ? request.taskId : null
  if (!job.profile_id || !taskId || !publicPrompt(request)) return null
  for (const provider of publicProviders(job)) {
    const mapping = store.resolveProviderTaskConversation({
      provider,
      profile_id: job.profile_id,
      task_id: taskId,
    })
    if (mapping?.canonical_url) return mapping.canonical_url
  }
  return null
}

function estimatedTextTokens(text: string) {
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk += 1
    else other += 1
  }
  return Math.max(1, Math.ceil(cjk + other / 4))
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

function sameRuntimeIdentity(
  left: ManagedProfileRecord['runtimeBinding'],
  right: NonNullable<ManagedProfileRecord['runtimeBinding']>,
) {
  if (!left) return false
  return left.runtimeId === right.runtimeId &&
    left.family === right.family &&
    left.browserId === right.browserId &&
    left.executablePath === right.executablePath
}

function configurableProviderIds(): ProviderId[] {
  return listProviderDescriptors()
    .filter((provider) => provider.stage !== 'disabled')
    .sort((left, right) => left.setupOrder - right.setupOrder)
    .map((provider) => provider.id)
}

function defaultProviderModes(): Record<string, DashboardProviderExecutionMode[]> {
  return Object.fromEntries(listProviderDescriptors()
    .filter((provider) => provider.stage !== 'disabled')
    .map((provider) => [provider.id, [...provider.executionModes]]))
}

function supportedProviderIds() {
  return listProviderDescriptors().filter((provider) => provider.stage !== 'disabled').map((provider) => provider.id)
}

function assertBrowserProviderActionAllowed(provider: ProviderId) {
  if (!isG4fDirectOnlyProvider(provider)) return
  throw applicationError(
    'provider_direct_only',
    'This provider supports direct execution only; browser actions are unavailable.',
  )
}

function assertProviderModeEnabled(configured: ManagedProfileConfig, provider: ProviderId, mode: DashboardProviderExecutionMode) {
  if (configured.providerModes[provider]?.includes(mode)) return
  throw applicationError('provider_mode_disabled', `${mode === 'browser' ? 'Browser' : 'Direct'} mode is disabled for this provider and profile.`)
}

function providerList(value: unknown): string[] {
  if (!Array.isArray(value)) throw applicationError('invalid_provider_list', 'Enabled providers must be an array.')
  if (value.some((entry) => typeof entry !== 'string')) {
    throw applicationError('invalid_provider_list', 'Enabled providers must contain provider ids.')
  }
  const supported = new Set(supportedProviderIds())
  const providers = [...new Set(value.map((entry) => entry.trim().toLowerCase()))]
  if (providers.some((provider) => !supported.has(provider as ProviderId))) {
    throw applicationError('invalid_provider_list', 'Enabled providers include an unsupported provider.')
  }
  return providers
}

function providerModes(value: unknown): Record<string, DashboardProviderExecutionMode[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw applicationError('invalid_provider_modes', 'Provider modes must be an object.')
  }
  const descriptors = new Map(listProviderDescriptors()
    .filter((provider) => provider.stage !== 'disabled')
    .map((provider) => [provider.id, provider]))
  const result = defaultProviderModes()
  for (const [providerId, candidate] of Object.entries(value)) {
    const descriptor = descriptors.get(providerId as ProviderId)
    if (!descriptor || !Array.isArray(candidate)) {
      throw applicationError('invalid_provider_modes', 'Provider modes include an unsupported provider or value.')
    }
    const modes = [...new Set(candidate)]
    if (modes.some((mode) => ((mode !== 'browser' && mode !== 'direct') || !descriptor.executionModes.includes(mode)))) {
      throw applicationError('invalid_provider_modes', 'Provider modes include an unsupported execution mode.')
    }
    result[providerId] = modes as DashboardProviderExecutionMode[]
  }
  return result
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
