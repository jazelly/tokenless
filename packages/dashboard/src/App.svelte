<script lang="ts">
  import { onMount } from 'svelte'
  import Dashboard from './Dashboard.svelte'
  import { DashboardClient } from './dashboard-client.js'
  import { translate } from './i18n/index.js'
  import { DEFAULT_TOKENLESS_LANGUAGE, normalizeTokenlessLanguage } from 'tokenless-internal-shared/i18n'
  import { createReadinessState } from './readiness-state.svelte.js'
  import HarnessExtensionPairing from './components/HarnessExtensionPairing.svelte'
  import type {
    DashboardActions,
    DashboardOperation,
    Language,
    Section,
    DashboardSetupInput,
    DashboardSnapshot,
  } from './types.js'

  const sections = new Set<Section>(['overview', 'profiles', 'providers', 'capabilities', 'rate-limits', 'jobs', 'invocations', 'system'])
  const initialLanguage: Language = normalizeTokenlessLanguage(document.documentElement.lang) ?? DEFAULT_TOKENLESS_LANGUAGE

  function parseSection(pathname: string, hash = ''): Section {
    const pathCandidate = /^\/dashboard\/([^/]+)\/?$/.exec(pathname)?.[1]
    const candidate = (pathname === '/dashboard' || pathname === '/dashboard/'
      ? hash.replace(/^#/, '')
      : pathCandidate) as Section | undefined
    return candidate && sections.has(candidate) ? candidate : 'overview'
  }

  function sectionPath(section: Section) {
    return `/dashboard/${section}/`
  }

  let language = $state<Language>(initialLanguage)
  let snapshot = $state<DashboardSnapshot | null>(null)
  let offline = $state(false)
  let busy = $state(false)
  let fatal = $state('')
  let toast = $state('')
  let setupRoute = $state(isSetupPath(location.pathname))
  let selectedProfile = $state(new URL(location.href).searchParams.get('profile') ?? '')
  let harnessPairingId = $state(new URL(location.href).searchParams.get('harnessPairing') ?? '')
  let section = $state<Section>(parseSection(location.pathname, location.hash))
  let toastTimer = 0
  let pollTimer = 0
  const client = new DashboardClient(() => language)
  const readiness = createReadinessState({
    client,
    snapshot: () => snapshot,
    refreshSnapshot: refresh,
    notify: showToast,
    t,
  })
  const actions: DashboardActions = {
    getInvocations: (query) => client.invocations(query),
    getAnalytics: (profile, range) => client.analytics(profile, range),
    updateConfig: (input, announce = true) => perform(() => client.updateConfig(input), announce),
    getConfigDocument: () => client.getConfigDocument(),
    createProfile: (input, announce = true) => perform(() => client.createProfile(input), announce),
    updateProfile: (slug, input, announce = true) => perform(() => client.updateProfile(slug, input), announce),
    removeProfile: (slug, announce = true) => perform(() => client.removeProfile(slug), announce),
    openProfile: (slug, announce = true) => perform(() => client.openProfile(slug), announce),
    runProviderAction: (profileSlug, providerId, action, announce = true) => perform(
      () => client.runProviderAction(profileSlug, providerId, action),
      announce,
    ),
    selectProviderControl: (profileSlug, providerId, input, announce = true) => perform(
      () => client.selectProviderControl(profileSlug, providerId, input),
      announce,
    ),
    getJob: (jobId) => client.getJob(jobId),
    cancelJob: (jobId, announce = true) => perform(() => client.cancelJob(jobId), announce),
    startHarnessRun: (input, announce = true) => perform(() => client.startHarnessRun(input), announce),
    readHarnessRun: (runId) => client.readHarnessRun(runId),
    resumeHarnessRun: (runId, input, announce = true) => perform(() => client.resumeHarnessRun(runId, input), announce),
    cancelHarnessRun: (runId, announce = true) => perform(() => client.cancelHarnessRun(runId), announce),
    readTerminalBenchSemanticTasks: () => client.readTerminalBenchSemanticTasks(),
    saveTerminalBenchSemanticManifest: (input) => client.saveTerminalBenchSemanticManifest(input),
    quiesceRuntime: (announce = true) => perform(() => client.quiesceRuntime(), announce),
    enableOutputSavings: (announce = true) => perform(() => client.enableOutputSavings(), announce),
    disableOutputSavings: (announce = true) => perform(() => client.disableOutputSavings(), announce),
    clearOutputSavings: (announce = true) => perform(() => client.clearOutputSavings(), announce),
    uninstallOutputSavings: (announce = true) => perform(() => client.uninstallOutputSavings(), announce),
  }

  $effect(() => {
    document.documentElement.lang = language
    document.title = t('documentTitle')
    const skipLink = document.querySelector<HTMLAnchorElement>('.skip-link')
    if (skipLink) skipLink.textContent = t('skipToContent')
  })

  onMount(() => {
    if (!setupRoute) {
      const url = new URL(location.href)
      url.pathname = sectionPath(section)
      url.hash = ''
      if (url.href !== location.href) history.replaceState(history.state, '', url)
    }
    const skipLink = document.querySelector<HTMLAnchorElement>('.skip-link')
    const skipToContent = (event: MouseEvent) => {
      event.preventDefault()
      const main = document.querySelector<HTMLElement>('#main')
      main?.focus()
      main?.scrollIntoView({ block: 'start' })
    }
    const popState = () => {
      setupRoute = isSetupPath(location.pathname)
      section = parseSection(location.pathname, location.hash)
      queueMicrotask(() => document.querySelector<HTMLElement>('#main')?.focus())
    }
    const visibilityChange = () => { if (!document.hidden) void refresh() }
    window.addEventListener('popstate', popState)
    document.addEventListener('visibilitychange', visibilityChange)
    skipLink?.addEventListener('click', skipToContent)
    void initialize()
    return () => {
      window.removeEventListener('popstate', popState)
      document.removeEventListener('visibilitychange', visibilityChange)
      skipLink?.removeEventListener('click', skipToContent)
      window.clearTimeout(pollTimer)
      window.clearTimeout(toastTimer)
    }
  })

  async function initialize() {
    try {
      await client.authenticate()
      await refresh()
      schedulePoll()
    } catch (error) {
      fatal = error instanceof Error ? error.message : t('requestFailed')
    }
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer)
    pollTimer = window.setTimeout(async () => {
      if (!document.hidden && !busy && !readiness.state.busy) await refresh()
      schedulePoll()
    }, 3000)
  }

  async function refresh() {
    const wasOffline = offline
    try {
      const result = await client.snapshot()
      if (result.snapshot) snapshot = result.snapshot
      offline = false
      synchronizeSnapshot()
    } catch (error) {
      if ((error as { sessionExpired?: boolean })?.sessionExpired) {
        fatal = error instanceof Error ? error.message : t('reopen')
        return
      }
      offline = true
      if (!snapshot || !wasOffline) showToast(t('offlineBody'))
    }
  }

  function synchronizeSnapshot() {
    if (!snapshot) return
    if (snapshot.profiles.length === 0 && !setupRoute && isDashboardPath(location.pathname)) {
      const url = new URL(location.href)
      url.pathname = '/dashboard/setup/'
      url.hash = ''
      history.replaceState(history.state, '', url)
      setupRoute = true
    }
    if (snapshot.config?.language === 'en' || snapshot.config?.language === 'zh-CN') language = snapshot.config.language
    const requestedProfile = snapshot.profiles.find((profile) => profile.slug === selectedProfile)
    if (requestedProfile && requestedProfile.slug !== selectedProfile) {
      selectProfile(requestedProfile.slug)
    } else if (!requestedProfile) {
      selectProfile(snapshot.profiles.find((profile) => profile.isDefault)?.slug
        ?? snapshot.profiles[0]?.slug
        ?? '')
    }
  }

  function selectProfile(slug: string) {
    if (slug !== selectedProfile) {
      readiness.reset(slug)
    }
    selectedProfile = slug
    const url = new URL(location.href)
    if (slug) url.searchParams.set('profile', slug)
    else url.searchParams.delete('profile')
    history.replaceState(history.state, '', url)
  }

  function sectionHref(next: Section) {
    const url = new URL(location.href)
    url.pathname = sectionPath(next)
    url.hash = ''
    return `${url.pathname}${url.search}`
  }

  function navigate(next: Section, href: string) {
    const url = new URL(href, location.href)
    if (url.href !== location.href) history.pushState(history.state, '', url)
    section = next
    setupRoute = false
    queueMicrotask(() => document.querySelector<HTMLElement>('#main')?.focus())
  }

  function handleDashboardNavigation(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[data-dashboard-section]')
    const next = anchor?.dataset.dashboardSection as Section | undefined
    if (!anchor || !next || !sections.has(next)) return
    event.preventDefault()
    navigate(next, anchor.href)
  }

  async function perform<Result>(operation: DashboardOperation<Result>, announce = true): Promise<Result> {
    busy = true
    try {
      const result = await operation()
      await refresh()
      if (announce) showToast(t('updateSaved'))
      return result
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('requestFailed'))
      throw error
    } finally {
      busy = false
    }
  }

  async function setup(input: DashboardSetupInput) {
    const profile = await perform(() => client.setup(input), false)
    selectedProfile = profile.slug
    readiness.reset(profile.slug)
    setupRoute = false
    section = 'profiles'
    const url = new URL(location.href)
    url.pathname = sectionPath('profiles')
    url.searchParams.set('profile', profile.slug)
    url.hash = ''
    history.replaceState(history.state, '', url)
    showToast(t('updateSaved'))
  }

  function showToast(message: string) {
    toast = message
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => toast = '', 3200)
  }

  function closeHarnessPairing() {
    harnessPairingId = ''
    const url = new URL(location.href)
    url.searchParams.delete('harnessPairing')
    history.replaceState(history.state, '', url)
  }

  function t(
    key: Parameters<typeof translate>[1],
    params: Readonly<Record<string, string | number>> = {},
  ) {
    return translate(language, key, params)
  }

  function isSetupPath(pathname: string) {
    return pathname === '/dashboard/setup' || pathname === '/dashboard/setup/'
  }

  function isDashboardPath(pathname: string) {
    return pathname === '/dashboard' || pathname === '/dashboard/' || /^\/dashboard\/(?:overview|profiles|providers|capabilities|rate-limits|jobs|invocations|system)\/?$/.test(pathname)
  }
</script>

<Dashboard
  {snapshot} {language} {section} {selectedProfile} {actions} {busy}
  {offline} {fatal} {setupRoute} {toast} {sectionHref}
  onselect={selectProfile} onsetup={setup} ontoast={showToast}
/>

{#if snapshot && harnessPairingId}
  <HarnessExtensionPairing
    {client}
    pairingId={harnessPairingId}
    {snapshot}
    {selectedProfile}
    {t}
    onclose={closeHarnessPairing}
    onapproved={() => showToast(t('harnessExtensionApproved'))}
  />
{/if}

<svelte:head><meta name="theme-color" content="#f6f5f2" /></svelte:head>
<svelte:window onclick={handleDashboardNavigation} />
