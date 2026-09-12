import { translate } from '../src/i18n/index.js'
import type { DashboardActions, DashboardConfigDocument, DashboardJobDetail, DashboardProfile, DashboardProfileUpdate, Language } from '../src/types.js'
import type { DesignState } from './atlas-types.js'
import { createPreviewSnapshot, previewAnalytics } from './preview-data.js'

// Storybook-local interaction state; this module is never imported by the application.
export function createPreviewState(language: Language, designState: DesignState, setup: boolean) {
  const initial = createPreviewSnapshot(language)
  if (setup) {
    initial.profiles = []
    initial.config.profiles = {}
    initial.setup.configuredProfileSlugs = []
    initial.setup.defaultProfileSlug = 'default'
  }
  let snapshot = $state(initial)
  let toast = $state('')
  let apiProxy = $state<DashboardConfigDocument['apiProxy']>({ enabled: false, executionMode: 'direct' })

  function notify(message: string) { toast = message }
  const unavailable = async (): Promise<never> => {
    const message = language === 'en'
      ? 'This action requires the running Tokenless API Dashboard. Storybook only changes local design data.'
      : '此操作需要运行中的 Tokenless API Dashboard。Storybook 仅修改本地设计数据。'
    notify(message)
    throw new Error(message)
  }

  function syncProfiles() {
    snapshot.config.profiles = Object.fromEntries(snapshot.profiles.map(profile => [profile.slug, {
      roleLabel: profile.roleLabel, enabledProviders: profile.enabledProviders, providerModes: profile.providerModes,
      browserVisibility: profile.browserVisibility, proxy: profile.proxy,
    }]))
    for (const provider of snapshot.providers) {
      provider.profiles = snapshot.profiles.map(profile => ({
        ...provider.profiles[0]!, profileId: profile.slug,
        enabled: profile.enabledProviders.includes(provider.id),
        enabledModes: profile.providerModes[provider.id] ?? [],
        runtimeEligibility: profile.enabledProviders.includes(provider.id) ? 'eligible' : 'ineligible',
      }))
    }
    notify(translate(language, 'updateSaved'))
  }

  function updateProfile(slug: string, input: DashboardProfileUpdate) {
    const profile = snapshot.profiles.find(profile => profile.slug === slug)!
    const { setDefault, ...values } = input
    Object.assign(profile, values)
    if (setDefault) snapshot.profiles.forEach(profile => profile.isDefault = profile.slug === slug)
    syncProfiles()
    return profile
  }

  function configDocument(): DashboardConfigDocument {
    return {
      ...snapshot.config, protocol: 'tokenless.ui.v1',
      defaultProfile: snapshot.profiles.find(profile => profile.isDefault)?.slug ?? null,
      browserExecutablePath: snapshot.setup.browserCandidates[0]!.executablePath,
      apiProxy,
    }
  }

  const actions: DashboardActions = {
    async getInvocations() { return { jobs: [], hasMore: false, failureReasons: [] } },
    async getAnalytics(profile, range) {
      if (designState === 'busy') return new Promise(() => {})
      if (designState === 'error') throw new Error(translate(language, 'requestFailed'))
      return previewAnalytics(snapshot, profile, range)
    },
    async getConfigDocument() { return configDocument() },
    async updateConfig(input) {
      if (input.router?.enabled) return unavailable()
      const { defaultProfile, browserExecutablePath, apiProxy: nextApiProxy, ...values } = input
      Object.assign(snapshot.config, values)
      if (nextApiProxy) apiProxy = nextApiProxy
      if (defaultProfile) snapshot.profiles.forEach(profile => profile.isDefault = profile.slug === defaultProfile)
      if (browserExecutablePath) snapshot.setup.browserCandidates[0]!.executablePath = browserExecutablePath
      notify(translate(language, 'updateSaved'))
      return snapshot.config
    },
    async createProfile(input) {
      if (snapshot.profiles.some(profile => profile.slug === input.slug)) throw new Error(language === 'en' ? 'This profile already exists.' : '此配置档已存在。')
      const profile: DashboardProfile = {
        slug: input.slug, isDefault: false, browserMode: 'native',
        browserBinding: { browserId: 'chrome', runtimeId: 'design-browser', family: 'system', version: '140.0' },
        roleLabel: '', enabledProviders: [], providerModes: {}, browserVisibility: 'headed', proxy: null, observations: [],
      }
      snapshot.profiles.push(profile)
      return updateProfile(input.slug, input)
    },
    async updateProfile(slug, input) { return updateProfile(slug, input) },
    async removeProfile(slug) {
      snapshot.profiles = snapshot.profiles.filter(profile => profile.slug !== slug)
      syncProfiles()
      return { slug, removed: true }
    },
    async getJob(jobId) {
      const job = snapshot.jobs.find(job => job.jobId === jobId)
      if (!job) throw new Error(language === 'en' ? 'Conversation not found.' : '未找到对话。')
      return job as DashboardJobDetail
    },
    async cancelJob(jobId) {
      const job = await actions.getJob(jobId)
      job.status = 'canceled'
      return job
    },
    openProfile: unavailable,
    runProviderAction: unavailable,
    selectProviderControl: unavailable,
    startHarnessRun: unavailable,
    readHarnessRun: unavailable,
    resumeHarnessRun: unavailable,
    cancelHarnessRun: unavailable,
    readTerminalBenchSemanticTasks: unavailable,
    saveTerminalBenchSemanticManifest: unavailable,
    quiesceRuntime: unavailable,
    enableOutputSavings: unavailable,
    disableOutputSavings: unavailable,
    clearOutputSavings: unavailable,
    uninstallOutputSavings: unavailable,
  }

  return { get snapshot() { return snapshot }, get toast() { return toast }, actions, notify }
}
