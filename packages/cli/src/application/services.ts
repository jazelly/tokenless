import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  readTokenlessConfig,
  normalizeManagedProfileProxy,
  writeTokenlessConfig,
  type ManagedProfilePreferences,
  type TokenlessConfig,
} from '../job-store.js'
import { tokenlessPackageVersion } from '../platform-package.js'
import { BrowserRuntimeManager } from '../browser-runtime/manager.js'
import {
  SYSTEM_BROWSER_IDS,
  isSystemBrowserId,
  normalizeBrowserSelection,
  type BrowserCandidate,
  type BrowserSelection,
  type ResolvedBrowserRuntime,
  type SystemBrowserId,
} from '../browser-runtime/types.js'
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
  MANAGED_CHROMIUM_BROWSER_IDS,
  discoverChromiumProfiles,
  discoverKnownChromiumProfiles,
  type ManagedChromiumBrowserId,
} from '../playwright/profiles/chrome-discovery.js'
import {
  SUPPORTED_PROFILE_IMPORT_BROWSER,
  classifyCloakProfileCompatibility,
  isSupportedProfileImportBrowser,
} from '../playwright/profiles/import-policy.js'
import { copyOpaqueChromiumProfile } from '../playwright/profiles/opaque-copy.js'
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
import { OutputSavingsRuntimeManager } from '../output-savings/runtime-manager.js'

export type UiApplicationServicesOptions = {
  store: JobStore
  runtimeController?: BrowserRuntimeController | undefined
  origin: () => string
  startedAt: number
}

const WEB_BROWSER_SELECTIONS = [
  'auto',
  ...SYSTEM_BROWSER_IDS,
  'managed-chromium',
  'cloak',
] as const satisfies readonly BrowserSelection[]

const WEB_BROWSER_LABELS: Record<(typeof WEB_BROWSER_SELECTIONS)[number], string> = {
  auto: 'Automatic',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  chromium: 'Chromium',
  'chrome-for-testing': 'Google Chrome for Testing',
  'managed-chromium': 'Managed Chrome for Testing',
  cloak: 'CloakBrowser',
}

const WEB_PROFILE_SOURCE_TTL_MS = 5 * 60 * 1000

type UiBrowserProfileSource = {
  browser: ManagedChromiumBrowserId
  userDataDir: string
  directoryKey: string
  name: string
  browserVersion: string | null
  expiresAt: number
}

export class TokenlessApplicationServices {
  readonly store: JobStore
  readonly profiles: ManagedProfileRegistry
  readonly runtimeManager: BrowserRuntimeManager
  readonly outputSavingsRuntimeManager: OutputSavingsRuntimeManager

  private readonly runtimeController: BrowserRuntimeController | undefined
  private readonly origin: () => string
  private readonly startedAt: number
  private browserDiscoveryCache: { expiresAt: number, candidates: BrowserCandidate[] } | undefined
  private readonly browserProfileSources = new Map<string, UiBrowserProfileSource>()

  constructor(options: UiApplicationServicesOptions) {
    this.store = options.store
    this.profiles = new ManagedProfileRegistry(options.store.homeDir)
    this.runtimeManager = new BrowserRuntimeManager({ homeDir: options.store.homeDir })
    this.outputSavingsRuntimeManager = new OutputSavingsRuntimeManager(options.store.homeDir)
    this.runtimeController = options.runtimeController
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
        profilePreferences(config, profile),
      )),
      providers: providers.map((provider) => ({
        ...provider,
        profiles: profiles.map((profile) => providerProfileState(
          provider.id,
          profile,
          profilePreferences(config, profile),
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
    const cleared = this.store.clearOutputSavings().cleared
    return {
      ...await this.outputSavingsState(),
      cleared,
    }
  }

  async browserRuntimes() {
    const config = await this.migratedConfig()
    const discovered = this.browserDiscoveryCache && this.browserDiscoveryCache.expiresAt > Date.now()
      ? this.browserDiscoveryCache.candidates
      : await this.runtimeManager.discover()
    this.browserDiscoveryCache = {
      expiresAt: Date.now() + 30_000,
      candidates: discovered,
    }
    const candidates = new Map(discovered.map((candidate) => [candidate.selection, candidate]))
    const configured = await this.runtimeManager.inspect(config.browser, {
      browserExecutablePath: config.browserExecutablePath,
    })
    if (configured.ok && configured.runtime && !candidates.has(configured.runtime.selection)) {
      candidates.set(configured.runtime.selection, runtimeCandidate(configured.runtime))
    }
    return {
      selected: config.browser,
      browserExecutablePathConfigured: config.browserExecutablePath !== null,
      options: WEB_BROWSER_SELECTIONS.map((selection) => publicBrowserOption(
        selection,
        candidates.get(selection),
        config.browser === selection,
      )),
    }
  }

  async inspectBrowserRuntime(input: Record<string, unknown>) {
    try {
      requireKnownFields(input, ['browser', 'browserExecutablePath'])
      const browser = normalizeBrowserSelection(input.browser)
      if (!browser || !WEB_BROWSER_SELECTIONS.includes(browser as (typeof WEB_BROWSER_SELECTIONS)[number])) {
        throw applicationError('invalid_browser', 'Browser selection is invalid.')
      }
      const executablePath = Object.hasOwn(input, 'browserExecutablePath')
        ? applicationBrowserExecutablePath(input.browserExecutablePath, browser)
        : null
      if (executablePath && !isSystemBrowserId(browser)) {
        throw applicationError(
          'browser_executable_path_requires_system_browser',
          'Browser executable path requires an explicit system browser selection.',
        )
      }
      const inspection = await this.runtimeManager.inspect(browser, {
        browserExecutablePath: executablePath,
      })
      if (!inspection.ok || !inspection.runtime) {
        return {
          ok: false,
          runtime: null,
          code: inspection.code ?? 'browser_runtime_unavailable',
          message: inspection.message ?? 'Browser runtime is unavailable.',
        }
      }
      requireExactExecutablePath(executablePath, inspection.runtime)
      return {
        ok: true,
        runtime: publicBrowserRuntime(inspection.runtime),
        code: null,
        message: null,
      }
    } catch (error) {
      const value = error as { code?: string, message?: string }
      return {
        ok: false,
        runtime: null,
        code: value.code ?? 'browser_runtime_unavailable',
        message: value.message ?? 'Browser runtime is unavailable.',
      }
    }
  }

  async installBrowserRuntime(input: Record<string, unknown>) {
    requireKnownFields(input, ['browser', 'repair'])
    const browser = normalizeBrowserSelection(input.browser)
    if (browser !== 'managed-chromium' && browser !== 'cloak') {
      throw applicationError(
        'browser_runtime_install_requires_managed_browser',
        'Only managed-chromium and cloak can be installed by Tokenless.',
      )
    }
    const repair = input.repair === true
    if (repair && this.runtimeController?.status().activeJobCount) {
      throw applicationError(
        'browser_runtime_repair_unsafe',
        'Browser runtime repair cannot start while browser jobs are active.',
      )
    }
    if (repair) await this.runtimeController?.quiesce()
    const runtime = await this.runtimeManager.ensure(browser, {
      allowDownload: true,
      repair,
    })
    this.browserDiscoveryCache = undefined
    const config = await this.migratedConfig()
    if (config.browser === browser) {
      await writeTokenlessConfig({
        homeDir: this.store.homeDir,
        browserExecutablePath: runtime.executablePath,
      })
    }
    return publicBrowserRuntime(runtime)
  }

  async discoverBrowserProfileSources(input: Record<string, unknown>) {
    requireKnownFields(input, ['browser', 'userDataDir'])
    const browser = input.browser === undefined
      ? SUPPORTED_PROFILE_IMPORT_BROWSER
      : MANAGED_CHROMIUM_BROWSER_IDS.includes(input.browser as ManagedChromiumBrowserId)
      ? input.browser as ManagedChromiumBrowserId
      : null
    if (!browser) {
      throw applicationError('invalid_browser_profile_source', 'Browser profile source is invalid.')
    }
    if (!isSupportedProfileImportBrowser(browser)) {
      throw applicationError(
        'profile_import_browser_unsupported',
        'Profile import supports only Google Chrome.',
      )
    }
    const userDataDir = typeof input.userDataDir === 'string' ? input.userDataDir.trim() : ''
    if (userDataDir && !path.isAbsolute(userDataDir)) {
      throw applicationError(
        'invalid_browser_profile_source',
        'A custom Google Chrome profile root requires an absolute user data directory.',
      )
    }
    const roots = userDataDir
      ? await discoverChromiumProfiles({ browser: SUPPORTED_PROFILE_IMPORT_BROWSER, userDataDirs: [userDataDir] })
      : await discoverKnownChromiumProfiles({ browsers: [SUPPORTED_PROFILE_IMPORT_BROWSER] })
    const config = await this.migratedConfig()
    const runtime = config.browser === 'cloak'
      ? (await this.runtimeManager.inspect(config.browser, {
          browserExecutablePath: config.browserExecutablePath,
        })).runtime
      : null
    this.browserProfileSources.clear()
    const candidates = roots.flatMap((root) => root.profiles.map((profile) => ({ root, profile }))).slice(0, 100)
    const sources = candidates.map(({ root, profile }) => {
      const id = randomUUID()
      const source: UiBrowserProfileSource = {
        browser: root.browser,
        userDataDir: root.userDataDir,
        directoryKey: profile.directoryKey,
        name: profile.name,
        browserVersion: profile.browserVersion,
        expiresAt: Date.now() + WEB_PROFILE_SOURCE_TTL_MS,
      }
      this.browserProfileSources.set(id, source)
      const compatible = runtime?.family !== 'cloak' || classifyCloakProfileCompatibility({
        browser: source.browser,
        sourceVersion: source.browserVersion,
        cloakVersion: runtime.actualVersion,
      }) === 'aligned'
      return {
        id,
        browser: source.browser,
        browserLabel: WEB_BROWSER_LABELS[source.browser],
        directoryKey: source.directoryKey,
        name: source.name,
        browserVersion: source.browserVersion,
        compatible,
      }
    })
    return { sources }
  }

  async updateConfig(input: Record<string, unknown>) {
    requireKnownFields(input, ['browser', 'browserExecutablePath', 'browserVisibility', 'language'])
    const current = await this.migratedConfig()
    let browser = input.browser === undefined
      ? current.browser
      : normalizeBrowserSelection(input.browser)
    if (!browser) throw applicationError('invalid_browser', 'Browser selection is invalid.')
    const executablePathProvided = Object.hasOwn(input, 'browserExecutablePath')
    let browserExecutablePath = executablePathProvided
      ? applicationBrowserExecutablePath(input.browserExecutablePath, browser)
      : browser === current.browser ? current.browserExecutablePath : null
    if (executablePathProvided && browserExecutablePath && !isSystemBrowserId(browser)) {
      throw applicationError(
        'browser_executable_path_requires_system_browser',
        'Browser executable path requires an explicit system browser selection.',
      )
    }
    const browserVisibility = input.browserVisibility === undefined
      ? current.browserVisibility
      : normalizeBrowserVisibility(input.browserVisibility)
    if (!browserVisibility) throw applicationError('invalid_browser_visibility', 'Browser visibility is invalid.')
    const language = input.language === undefined ? current.language : input.language
    if (language !== 'en' && language !== 'zh-CN') {
      throw applicationError('invalid_language', 'Language must be en or zh-CN.')
    }
    const clearingExecutablePath = executablePathProvided && browserExecutablePath === null
    const shouldResolveBrowser = executablePathProvided || browser !== current.browser
    if (shouldResolveBrowser) {
      const inspection = await this.runtimeManager.inspect(browser, {
        allowDownload: false,
        browserExecutablePath,
      })
      if (!inspection.ok || !inspection.runtime) {
        throw applicationError(
          inspection.code ?? 'browser_runtime_unavailable',
          inspection.message ?? 'Browser runtime is unavailable.',
        )
      }
      const runtime = inspection.runtime
      if (executablePathProvided) requireExactExecutablePath(browserExecutablePath, runtime)
      browser = runtime.selection
      browserExecutablePath = clearingExecutablePath ? null : runtime.executablePath
    }
    const browserRuntimeChanged = browser !== current.browser ||
      browserExecutablePath !== current.browserExecutablePath
    if (browserRuntimeChanged && this.runtimeController?.status().activeJobCount) {
      throw applicationError('browser_mutation_unsafe', 'Browser selection cannot change while browser jobs are active.')
    }
    if (browserRuntimeChanged) await this.runtimeController?.quiesce()
    const saved = await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      browser,
      browserExecutablePath,
      browserVisibility,
      language,
    })
    this.browserDiscoveryCache = undefined
    return publicConfig(saved)
  }

  async createProfile(input: Record<string, unknown>) {
    requireKnownFields(input, ['slug', 'label', 'roleLabel', 'enabledProviders', 'browserVisibility', 'proxy', 'setDefault', 'importSourceId', 'consentLocalProfileCopy'])
    const slug = requiredSlug(input.slug)
    const config = await this.migratedConfig()
    const label = optionalLabel(input.label)
    const importSourceId = typeof input.importSourceId === 'string' ? input.importSourceId.trim() : ''
    let importSource = importSourceId ? this.browserProfileSources.get(importSourceId) : undefined
    if (importSource && importSource.expiresAt <= Date.now()) {
      this.browserProfileSources.delete(importSourceId)
      importSource = undefined
    }
    if (importSourceId && !importSource) {
      throw applicationError('browser_profile_source_expired', 'Discover and select the browser profile again.')
    }
    if (importSource && input.consentLocalProfileCopy !== true) {
      throw applicationError('browser_profile_copy_consent_required', 'Browser profile copy requires explicit consent.')
    }
    const preferences = {
      roleLabel: optionalRoleLabel(input.roleLabel) ?? '',
      enabledProviders: input.enabledProviders === undefined
        ? config.providerWhitelist
        : providerList(input.enabledProviders),
      browserVisibility: input.browserVisibility === undefined
        ? config.browserVisibility
        : requiredVisibility(input.browserVisibility),
      proxy: input.proxy === undefined ? null : validateProxy(input.proxy),
    }
    const runtime = await this.runtimeManager.ensure(config.browser, {
      allowDownload: false,
      browserExecutablePath: config.browserExecutablePath,
    })
    if (importSource) {
      if (runtime.family !== 'cloak') {
        throw applicationError(
          'profile_import_runtime_unsupported',
          'Experimental profile import is available only when setting up CloakBrowser; managed Chrome for Testing starts clean.',
        )
      }
      assertProfileImportCompatible(importSource, runtime)
    }
    if (
      config.browser !== runtime.selection ||
      config.browserExecutablePath !== runtime.executablePath
    ) {
      await writeTokenlessConfig({
        homeDir: this.store.homeDir,
        browser: runtime.selection,
        browserExecutablePath: runtime.executablePath,
      })
    }
    let profile = await this.profiles.addProfile({
      slug,
      label: label ?? slug,
      labelOrigin: label === undefined ? 'slug' : 'user',
      lifecycle: importSource ? 'importing' : 'ready',
      setDefault: input.setDefault === true,
      runtimeBinding: runtimeBinding(runtime),
    })
    try {
      if (importSource) {
        await copyOpaqueChromiumProfile({
          sourceUserDataDir: importSource.userDataDir,
          profileDirectoryKey: importSource.directoryKey,
          destinationDir: profile.directory,
          tokenlessHome: this.store.homeDir,
        })
        profile = await this.profiles.markImported(profile.slug, {
          source: importSource.userDataDir,
          profileDirectoryKey: importSource.directoryKey,
          profileName: importSource.name,
          browser: importSource.browser,
          browserVersion: importSource.browserVersion,
        })
        this.browserProfileSources.delete(importSourceId)
      }
      await this.updateProfilePreferences(profile, preferences)
      return publicProfile(profile, (await this.profiles.read()).defaultProfile, profilePreferences(await this.migratedConfig(), profile))
    } catch (error) {
      await this.profiles.removeProfile(slug, { confirmDelete: true }).catch(() => undefined)
      if (importSource) {
        const value = error as { code?: string }
        throw applicationError(value.code ?? 'browser_profile_import_failed', 'Browser profile copy failed.')
      }
      throw error
    }
  }

  async updateProfile(slug: string, input: Record<string, unknown>) {
    requireKnownFields(input, ['label', 'roleLabel', 'enabledProviders', 'browserVisibility', 'proxy', 'setDefault'])
    let profile = await this.profiles.resolveProfile(slug)
    const label = input.label === undefined ? undefined : requiredLabel(input.label)
    const current = profilePreferences(await this.migratedConfig(), profile)
    const next = {
      roleLabel: input.roleLabel === undefined ? current.roleLabel : optionalRoleLabel(input.roleLabel) ?? '',
      enabledProviders: input.enabledProviders === undefined
        ? current.enabledProviders
        : providerList(input.enabledProviders),
      browserVisibility: input.browserVisibility === undefined
        ? current.browserVisibility
        : requiredVisibility(input.browserVisibility),
      proxy: input.proxy === undefined ? current.proxy : validateProxy(input.proxy),
    }
    if (JSON.stringify(next.proxy) !== JSON.stringify(current.proxy)) {
      if (this.runtimeController?.status().activeJobCount) {
        throw applicationError('profile_proxy_mutation_unsafe', 'Proxy settings cannot change while browser jobs are active.')
      }
      await this.runtimeController?.quiesce()
    }
    if (label !== undefined) profile = await this.profiles.updateLabel(slug, label)
    if (input.setDefault === true) profile = await this.profiles.setDefault(slug)
    await this.updateProfilePreferences(profile, next)
    return publicProfile(profile, (await this.profiles.read()).defaultProfile, profilePreferences(await this.migratedConfig(), profile))
  }

  async removeProfile(slug: string) {
    const status = this.runtimeController?.status()
    if (status?.activeJobCount) {
      throw applicationError('profile_mutation_unsafe', 'A profile cannot be removed while browser jobs are active.')
    }
    await this.runtimeController?.quiesce()
    const profile = await this.profiles.removeProfile(slug, { confirmDelete: true })
    const config = await this.migratedConfig()
    const profilePreferences = { ...config.profilePreferences }
    delete profilePreferences[slug]
    await writeTokenlessConfig({ homeDir: this.store.homeDir, profilePreferences })
    return { slug: profile.slug, removed: true }
  }

  async reimportProfile(slug: string, input: Record<string, unknown>) {
    requireKnownFields(input, ['consentLocalProfileCopy'])
    if (input.consentLocalProfileCopy !== true) {
      throw applicationError('browser_profile_copy_consent_required', 'Browser profile copy requires explicit consent.')
    }
    if (this.runtimeController?.status().activeJobCount) {
      throw applicationError('profile_mutation_unsafe', 'A profile cannot be re-imported while browser jobs are active.')
    }
    const profile = await this.profiles.resolveProfile(slug)
    if (!profile.import) {
      throw applicationError('profile_reimport_source_required', 'This managed profile has no recorded import source.')
    }
    const config = await this.migratedConfig()
    let runtime: ResolvedBrowserRuntime
    try {
      runtime = await this.runtimeManager.resolveForProfile(profile, {
        browserExecutablePath: profile.runtimeBinding?.browserId === config.browser
          ? config.browserExecutablePath
          : null,
      })
    } catch (error) {
      const value = error as { code?: string, message?: string }
      throw applicationError(value.code ?? 'browser_runtime_unavailable', value.message ?? 'Browser runtime is unavailable.')
    }
    assertProfileImportCompatible({
      browser: profile.import.browser ?? SUPPORTED_PROFILE_IMPORT_BROWSER,
      browserVersion: profile.import.browserVersion ?? null,
    }, runtime)
    await this.runtimeController?.quiesce()
    await this.profiles.updateLifecycle(profile.slug, 'importing')
    try {
      await copyOpaqueChromiumProfile({
        sourceUserDataDir: profile.import.source,
        profileDirectoryKey: profile.import.profileDirectoryKey,
        destinationDir: profile.directory,
        tokenlessHome: this.store.homeDir,
      })
      const updated = await this.profiles.markImported(profile.slug, {
        source: profile.import.source,
        profileDirectoryKey: profile.import.profileDirectoryKey,
        ...(profile.import.browser ? { browser: profile.import.browser } : {}),
        ...(profile.import.browserVersion ? { browserVersion: profile.import.browserVersion } : {}),
      })
      return publicProfile(
        updated,
        (await this.profiles.read()).defaultProfile,
        profilePreferences(await this.migratedConfig(), updated),
      )
    } catch (error) {
      await this.profiles.updateLifecycle(profile.slug, 'failed').catch(() => undefined)
      const value = error as { code?: string }
      throw applicationError(value.code ?? 'browser_profile_import_failed', 'Browser profile copy failed.')
    }
  }

  async providerAction(slug: string, providerValue: string, action: 'open' | 'readiness' | 'controls') {
    const profile = await this.profiles.resolveProfile(slug)
    const provider = listProviderInstances().find((candidate) => candidate.id === providerValue)
    if (!provider || provider.descriptor.stage === 'disabled') {
      throw applicationError('provider_not_supported', 'Provider is not supported.')
    }
    const preferences = profilePreferences(await this.migratedConfig(), profile)
    if (!preferences.enabledProviders.includes(provider.id)) {
      throw applicationError('provider_not_enabled', 'Enable the provider for this profile before opening it.')
    }
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
      provider: provider.id,
      browserVisibility: action === 'readiness' ? preferences.browserVisibility : 'headed',
      userHandoff: action === 'open',
      taskId: `ui:${action}:${randomUUID()}`,
      actions,
    })
    const job = this.store.createJob({
      provider: provider.id,
      action: MANAGED_PLAYWRIGHT_JOB_ACTION,
      request_json: request,
      execution_backend: PLAYWRIGHT_EXECUTION_BACKEND,
      profile_id: profile.id,
    })
    await this.runtimeController?.wake()
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
    const preferences = profilePreferences(await this.migratedConfig(), profile)
    if (!preferences.enabledProviders.includes(provider.id)) {
      throw applicationError('provider_not_enabled', 'Enable the provider for this profile before changing controls.')
    }
    const request = createManagedPlaywrightJobRequest({
      provider: provider.id,
      browserVisibility: 'headed',
      taskId: `ui:${kind}-select:${randomUUID()}`,
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
    const config = await readTokenlessConfig(this.store.homeDir)
    const profiles = await this.profiles.listProfiles()
    const missing = profiles.filter((profile) => !config.profilePreferences[profile.slug])
    if (missing.length === 0) return config
    const enabledProviders = config.providerWhitelist
    const profilePreferences = { ...config.profilePreferences }
    for (const profile of missing) {
      profilePreferences[profile.slug] = {
        profileId: profile.slug,
        roleLabel: '',
        enabledProviders,
        browserVisibility: config.browserVisibility,
        proxy: null,
      }
    }
    return await writeTokenlessConfig({ homeDir: this.store.homeDir, profilePreferences })
  }

  private async updateProfilePreferences(
    profile: ManagedProfileRecord,
    next: Omit<ManagedProfilePreferences, 'profileId'>,
  ) {
    const config = await this.migratedConfig()
    const profilePreferences = {
      ...config.profilePreferences,
      [profile.slug]: { profileId: profile.slug, ...next },
    }
    const providerWhitelist = [...new Set(Object.values(profilePreferences)
      .flatMap((preferences) => preferences.enabledProviders))]
    await writeTokenlessConfig({
      homeDir: this.store.homeDir,
      profilePreferences,
      providerWhitelist,
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
    providerWhitelist: config.providerWhitelist,
    browser: config.browser,
    browserExecutablePathConfigured: config.browserExecutablePath !== null,
    browserConnectionMode: config.browserConnectionMode,
    browserVisibility: config.browserVisibility,
    daemonUrl: config.daemonUrl,
    language: config.language,
    outputSavings: config.outputSavings,
  }
}

function publicBrowserOption(
  selection: (typeof WEB_BROWSER_SELECTIONS)[number],
  candidate: BrowserCandidate | undefined,
  selected: boolean,
) {
  const managed = selection === 'managed-chromium' || selection === 'cloak'
  return {
    selection,
    displayName: candidate?.displayName ?? WEB_BROWSER_LABELS[selection],
    family: candidate?.family ?? (managed ? selection : selection === 'auto' ? 'automatic' : 'system'),
    version: candidate?.version ?? null,
    source: candidate?.source ?? null,
    installed: selection === 'auto' || candidate !== undefined,
    available: selection === 'auto' || candidate !== undefined,
    downloadRequired: managed && candidate === undefined,
    customPathAllowed: isSystemBrowserId(selection),
    selected,
  }
}

function publicBrowserRuntime(runtime: ResolvedBrowserRuntime) {
  return {
    selection: runtime.selection,
    runtimeId: runtime.runtimeId,
    family: runtime.family,
    browserId: runtime.browserId,
    displayName: runtime.displayName,
    platform: runtime.platform,
    version: runtime.actualVersion,
    source: runtime.source,
    managed: runtime.managed,
    checksumVerified: runtime.checksumVerified,
  }
}

function runtimeCandidate(runtime: ResolvedBrowserRuntime): BrowserCandidate {
  return {
    selection: runtime.selection,
    runtimeId: runtime.runtimeId,
    family: runtime.family,
    browserId: runtime.browserId,
    displayName: runtime.displayName,
    platform: runtime.platform,
    version: runtime.actualVersion,
    source: runtime.source,
    executablePath: runtime.executablePath,
    managed: runtime.managed,
    installed: true,
    downloadRequired: false,
  }
}

function requireExactExecutablePath(
  requestedPath: string | null,
  runtime: ResolvedBrowserRuntime,
) {
  if (!requestedPath || path.normalize(runtime.executablePath) === path.normalize(requestedPath)) return
  throw applicationError(
    'browser_executable_not_found',
    'The selected executable could not be verified. Tokenless did not replace it with another browser.',
  )
}

function applicationBrowserExecutablePath(value: unknown, browser: BrowserSelection) {
  if (value === null) return null
  const executablePath = typeof value === 'string' ? value.trim() : ''
  if (!executablePath || !path.isAbsolute(executablePath)) {
    throw applicationError(
      'invalid_browser_executable_path',
      'Browser executable path must be null or an absolute path.',
    )
  }
  const normalized = path.normalize(executablePath)
  if (process.platform !== 'darwin' || !normalized.toLowerCase().endsWith('.app') || !isSystemBrowserId(browser)) {
    return normalized
  }
  return path.join(normalized, 'Contents', 'MacOS', macOsBrowserExecutableName(browser))
}

function macOsBrowserExecutableName(browser: SystemBrowserId) {
  const names: Record<SystemBrowserId, string> = {
    chrome: 'Google Chrome',
    edge: 'Microsoft Edge',
    chromium: 'Chromium',
    'chrome-for-testing': 'Google Chrome for Testing',
  }
  return names[browser]
}

function publicProfile(
  profile: ManagedProfileRecord,
  defaultSlug: string | null,
  preferences: ManagedProfilePreferences,
) {
  return {
    slug: profile.slug,
    id: profile.id,
    label: profile.label,
    lifecycle: profile.lifecycle,
    isDefault: profile.slug === defaultSlug,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    runtimeBinding: profile.runtimeBinding ?? null,
    import: profile.import ? {
      browser: profile.import.browser ?? null,
      importedAt: profile.import.importedAt,
    } : null,
    preferences,
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
  preferences: ManagedProfilePreferences,
  routes: ReturnType<typeof listProviderTaskCapabilityRoutes>,
  jobs: Job[],
) {
  const observation = profile.lastObservedAuth[provider]
  return {
    profileId: profile.slug,
    enabled: preferences.enabledProviders.includes(provider),
    observation: observation ? {
      auth: observation.auth,
      access: observation.access,
      checkedAt: observation.checkedAt,
      account: observation.auth === 'authenticated' ? observation.account ?? null : null,
    } : null,
    runtimeEligibility: preferences.enabledProviders.includes(provider) && usableAccess(observation?.access)
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

function profilePreferences(config: TokenlessConfig, profile: ManagedProfileRecord): ManagedProfilePreferences {
  return config.profilePreferences[profile.slug] ?? {
    profileId: profile.slug,
    roleLabel: '',
    enabledProviders: config.providerWhitelist,
    browserVisibility: config.browserVisibility,
    proxy: null,
  }
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

function validateProxy(value: unknown): ManagedProfilePreferences['proxy'] {
  const proxy = normalizeManagedProfileProxy(value)
  if (proxy === undefined) {
    throw applicationError('invalid_proxy', 'Proxy must use HTTP, HTTPS, or SOCKS5 without embedded credentials.')
  }
  return proxy
}

function requiredVisibility(value: unknown) {
  const visibility = normalizeBrowserVisibility(value)
  if (!visibility) throw applicationError('invalid_browser_visibility', 'Browser visibility is invalid.')
  return visibility
}

function requiredSlug(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw applicationError('invalid_profile_slug', 'Profile slug must use lowercase letters, numbers, and hyphens.')
  }
  return value
}

function optionalLabel(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  return requiredLabel(value)
}

function requiredLabel(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw applicationError('invalid_profile_label', 'Profile label must be between 1 and 80 characters.')
  }
  return value.trim().replace(/\s+/g, ' ')
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

function assertProfileImportCompatible(
  source: { browser: string; browserVersion: string | null },
  runtime: ResolvedBrowserRuntime,
) {
  if (!isSupportedProfileImportBrowser(source.browser)) {
    throw applicationError(
      'profile_import_browser_unsupported',
      'Profile import supports only Google Chrome.',
    )
  }
  if (runtime.family !== 'cloak' || source.browserVersion === runtime.actualVersion) return
  throw applicationError(
    'browser_profile_version_incompatible',
    'The Google Chrome profile version is not compatible with this CloakBrowser runtime.',
  )
}

function runtimeBinding(runtime: Awaited<ReturnType<BrowserRuntimeManager['ensure']>>) {
  return {
    runtimeId: runtime.runtimeId,
    family: runtime.family,
    browserId: runtime.browserId,
    createdWithVersion: runtime.actualVersion,
    profileFormat: 1 as const,
  }
}

function revisionFor(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 24)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function applicationError(code: string, message: string) {
  return Object.assign(new Error(message), { code, status: 400 })
}
