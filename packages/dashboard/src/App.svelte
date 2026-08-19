<script lang="ts">
  import { onMount } from 'svelte'
  import { Blocks, LayoutDashboard, ListChecks, PanelsTopLeft, Settings, UsersRound } from '@lucide/svelte'
  import { DashboardClient } from './dashboard-client.js'
  import { translate } from './localization.js'
  import { createReadinessState } from './readiness-state.svelte.js'
  import CapabilitiesView from './views/CapabilitiesView.svelte'
  import JobsView from './views/JobsView.svelte'
  import OverviewView from './views/OverviewView.svelte'
  import ProfilesView from './views/ProfilesView.svelte'
  import ProvidersView from './views/ProvidersView.svelte'
  import SetupView from './views/SetupView.svelte'
  import SystemView from './views/SystemView.svelte'
  import type {
    DashboardActions,
    DashboardOperation,
    Language,
    Section,
    UiSetupInput,
    UiSnapshot,
  } from './types.js'

  const sections = new Set<Section>(['overview', 'profiles', 'providers', 'capabilities', 'jobs', 'system'])
  const initialLanguage: Language = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en'

  function parseSection(hash: string): Section {
    const candidate = hash.replace(/^#/, '') as Section
    return sections.has(candidate) ? candidate : 'overview'
  }

  let language = $state<Language>(initialLanguage)
  let snapshot = $state<UiSnapshot | null>(null)
  let offline = $state(false)
  let busy = $state(false)
  let fatal = $state('')
  let toast = $state('')
  let setupRoute = $state(isSetupPath(location.pathname))
  let selectedProfile = $state(new URL(location.href).searchParams.get('profile') ?? '')
  let section = $state<Section>(parseSection(location.hash))
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
    updateConfig: (input, announce = true) => perform(() => client.updateConfig(input), announce),
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
    resumeJob: (jobId, announce = true) => perform(() => client.resumeJob(jobId), announce),
    quiesceRuntime: (announce = true) => perform(() => client.quiesceRuntime(), announce),
    enableOutputSavings: (announce = true) => perform(() => client.enableOutputSavings(), announce),
    disableOutputSavings: (announce = true) => perform(() => client.disableOutputSavings(), announce),
    clearOutputSavings: (announce = true) => perform(() => client.clearOutputSavings(), announce),
    uninstallOutputSavings: (announce = true) => perform(() => client.uninstallOutputSavings(), announce),
  }

  const navigation = $derived([
    { id: 'overview' as const, label: t('overview'), icon: LayoutDashboard },
    { id: 'profiles' as const, label: t('profiles'), icon: UsersRound },
    { id: 'providers' as const, label: t('providers'), icon: PanelsTopLeft },
    { id: 'capabilities' as const, label: t('capabilities'), icon: Blocks },
    { id: 'jobs' as const, label: t('jobs'), icon: ListChecks },
    { id: 'system' as const, label: t('system'), icon: Settings },
  ])

  $effect(() => {
    document.documentElement.lang = language
    document.title = t('documentTitle')
    const skipLink = document.querySelector<HTMLAnchorElement>('.skip-link')
    if (skipLink) skipLink.textContent = t('skipToContent')
  })

  onMount(() => {
    const skipLink = document.querySelector<HTMLAnchorElement>('.skip-link')
    const skipToContent = (event: MouseEvent) => {
      event.preventDefault()
      const main = document.querySelector<HTMLElement>('#main')
      main?.focus()
      main?.scrollIntoView({ block: 'start' })
    }
    const hashChange = () => {
      section = parseSection(location.hash)
      queueMicrotask(() => document.querySelector<HTMLElement>('#main')?.focus())
    }
    const popState = () => { setupRoute = isSetupPath(location.pathname) }
    const visibilityChange = () => { if (!document.hidden) void refresh() }
    window.addEventListener('hashchange', hashChange)
    window.addEventListener('popstate', popState)
    document.addEventListener('visibilitychange', visibilityChange)
    skipLink?.addEventListener('click', skipToContent)
    void initialize()
    return () => {
      window.removeEventListener('hashchange', hashChange)
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
    if (snapshot.profiles.length === 0 && !setupRoute && isConsolePath(location.pathname)) {
      const url = new URL(location.href)
      url.pathname = '/ui/setup/'
      url.hash = ''
      history.replaceState(history.state, '', url)
      setupRoute = true
    }
    if (snapshot.config?.language === 'en' || snapshot.config?.language === 'zh-CN') language = snapshot.config.language
    const requestedProfile = snapshot.profiles.find((profile) => profile.slug === selectedProfile || profile.id === selectedProfile)
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

  function navigate(next: string) {
    if (!sections.has(next as Section)) return
    section = next as Section
    location.hash = next
    queueMicrotask(() => document.querySelector<HTMLElement>('#main')?.focus())
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

  async function setup(input: UiSetupInput) {
    const profile = await perform(() => client.setup(input), false)
    selectedProfile = profile.slug
    readiness.reset(profile.slug)
    setupRoute = false
    section = 'profiles'
    const url = new URL(location.href)
    url.pathname = '/ui/'
    url.searchParams.set('profile', profile.slug)
    url.hash = '#profiles'
    history.replaceState(history.state, '', url)
    showToast(t('updateSaved'))
  }

  function showToast(message: string) {
    toast = message
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => toast = '', 3200)
  }

  function t(key: Parameters<typeof translate>[1]) {
    return translate(language, key)
  }

  function isSetupPath(pathname: string) {
    return pathname === '/ui/setup' || pathname === '/ui/setup/'
  }

  function isConsolePath(pathname: string) {
    return pathname === '/ui' || pathname === '/ui/'
  }
</script>

{#if fatal}
  <main id="main" tabindex="-1" class="fatal-state" data-testid="fatal-state">
    <img src="/ui/mark.png" alt="" width="42" height="42" />
    <h1>{t('sessionExpired')}</h1>
    <p>{fatal}</p>
    <p>{t('reopen')}</p>
  </main>
{:else if !snapshot}
  <main id="main" tabindex="-1" class="loading-state" aria-live="polite">
    <img src="/ui/mark.png" alt="" width="42" height="42" />
    <span class="spinner"></span>
    <p>{t('loading')}</p>
  </main>
{:else if setupRoute || snapshot.profiles.length === 0}
  <SetupView
    {snapshot}
    {language}
    {t}
    {busy}
    onsetup={setup}
  />
{:else}
  <div class:profiles-active={section === 'profiles'} class="app-shell" data-testid="app-shell">
    <aside class="rail">
      <div class="rail-brand"><img src="/ui/mark.png" alt="Tokenless" width="28" height="28" translate="no" /></div>
      <nav aria-label={t('primaryNavigation')}>
        {#each navigation as item (item.id)}
          {@const Icon = item.icon}
          <a
            class:active={section === item.id}
            class="rail-button"
            href={`#${item.id}`}
            aria-label={item.label}
            aria-current={section === item.id ? 'page' : undefined}
            title={item.label}
            data-tooltip={item.label}
            data-nav={item.id}
          ><Icon size={19} strokeWidth={1.8} /></a>
        {/each}
      </nav>
      <div class="rail-status" class:offline aria-label={offline ? t('offline') : t('healthy')} title={offline ? t('offline') : t('healthy')}>
        <span></span>
      </div>
    </aside>

    <header class="mobile-header">
      <div><img src="/ui/mark.png" alt="" width="24" height="24" /><strong translate="no">Tokenless</strong></div>
      <label class="mobile-profile-select">
        <span class="sr-only">{t('selectProfile')}</span>
        <select name="activeProfile" value={selectedProfile} onchange={(event) => selectProfile(event.currentTarget.value)}>{#each snapshot.profiles as profile}<option value={profile.slug}>{profile.slug}</option>{/each}</select>
      </label>
    </header>

    {#if offline}<div class="offline-banner" role="status">{t('offlineShort')}</div>{/if}

    <main id="main" tabindex="-1" class:profile-main={section === 'profiles'}>
      {#if section === 'overview'}
        <OverviewView
          {snapshot}
          {selectedProfile}
          {language}
          {t}
          readinessBusy={readiness.state.busy}
          readinessJobs={readiness.state.jobs}
          onrefreshreadiness={readiness.refresh}
        />
      {:else if section === 'profiles'}
        <ProfilesView {snapshot} {selectedProfile} {language} {t} {busy} {actions} onselect={selectProfile} />
      {:else if section === 'providers'}
        <ProvidersView {snapshot} {selectedProfile} {language} {t} {busy} {actions} onselect={selectProfile} />
      {:else if section === 'capabilities'}
        <CapabilitiesView {snapshot} {selectedProfile} {language} {t} onselect={selectProfile} />
      {:else if section === 'jobs'}
        <JobsView {snapshot} {language} {t} {busy} {actions} />
      {:else}
        <SystemView
          {snapshot}
          {language}
          {t}
          {busy}
          {actions}
          ontoast={showToast}
        />
      {/if}
    </main>

    <nav class="mobile-nav" aria-label={t('primaryNavigation')}>
      {#each navigation as item (item.id)}
        {@const Icon = item.icon}
        <a class:active={section === item.id} href={`#${item.id}`} aria-label={item.label} aria-current={section === item.id ? 'page' : undefined} data-nav={item.id}>
          <Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>
        </a>
      {/each}
    </nav>
  </div>
{/if}

<div class="toast-region" aria-live="polite" aria-atomic="true">{#if toast}<div class="toast" role="status">{toast}</div>{/if}</div>

<svelte:head><meta name="theme-color" content="#f6f5f2" /></svelte:head>
