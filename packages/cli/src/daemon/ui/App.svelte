<script lang="ts">
  import { onMount } from 'svelte'
  import { Blocks, LayoutDashboard, ListChecks, PanelsTopLeft, Settings, UsersRound } from '@lucide/svelte'
  import { DashboardClient } from './dashboard-client.js'
  import { translate, translateError } from './localization.js'
  import CapabilitiesView from './views/CapabilitiesView.svelte'
  import JobsView from './views/JobsView.svelte'
  import OverviewView from './views/OverviewView.svelte'
  import ProfilesView from './views/ProfilesView.svelte'
  import ProvidersView from './views/ProvidersView.svelte'
  import SetupView from './views/SetupView.svelte'
  import SystemView from './views/SystemView.svelte'
  import type { JsonRecord, Language, Section } from './types.js'

  const sections = new Set<Section>(['overview', 'profiles', 'providers', 'capabilities', 'jobs', 'system'])
  const initialLanguage: Language = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en'

  function parseSection(hash: string): Section {
    const candidate = hash.replace(/^#/, '') as Section
    return sections.has(candidate) ? candidate : 'overview'
  }

  let language = $state<Language>(initialLanguage)
  let snapshot = $state<JsonRecord | null>(null)
  let browserRuntimeCatalog = $state<JsonRecord | null>(null)
  let offline = $state(false)
  let busy = $state(false)
  let runtimeBusy = $state(false)
  let fatal = $state('')
  let toast = $state('')
  let selectedProfile = $state('')
  let section = $state<Section>(parseSection(location.hash))
  let toastTimer = 0
  let pollTimer = 0
  let runtimeCatalogTimer = 0
  let runtimeCatalogRequest: Promise<void> | null = null
  const client = new DashboardClient(() => language)

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
    const hashChange = () => section = parseSection(location.hash)
    const visibilityChange = () => { if (!document.hidden) void refresh() }
    window.addEventListener('hashchange', hashChange)
    document.addEventListener('visibilitychange', visibilityChange)
    void initialize()
    return () => {
      window.removeEventListener('hashchange', hashChange)
      document.removeEventListener('visibilitychange', visibilityChange)
      window.clearTimeout(pollTimer)
      window.clearTimeout(toastTimer)
      window.clearTimeout(runtimeCatalogTimer)
    }
  })

  async function initialize() {
    try {
      await client.authenticate()
      await refresh()
      runtimeCatalogTimer = window.setTimeout(() => void refreshBrowserRuntimes(), 700)
      schedulePoll()
    } catch (error) {
      fatal = error instanceof Error ? error.message : t('requestFailed')
    }
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer)
    pollTimer = window.setTimeout(async () => {
      if (!document.hidden && !busy && !runtimeBusy) await refresh()
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
    if (snapshot.config?.language === 'en' || snapshot.config?.language === 'zh-CN') language = snapshot.config.language
    if (!selectedProfile || !snapshot.profiles.some((profile: JsonRecord) => profile.slug === selectedProfile)) {
      selectedProfile = snapshot.profiles.find((profile: JsonRecord) => profile.isDefault)?.slug
        ?? snapshot.profiles[0]?.slug
        ?? ''
    }
  }

  function navigate(next: string) {
    if (!sections.has(next as Section)) return
    section = next as Section
    location.hash = next
    queueMicrotask(() => document.querySelector<HTMLElement>('#main')?.focus())
  }

  async function mutate(path: string, body?: unknown, method = 'POST', announce = true) {
    busy = true
    try {
      const result = await client.mutate(path, body, method)
      await refresh()
      if (path === '/config') void refreshBrowserRuntimes()
      if (announce) showToast(t('updateSaved'))
      return result
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('requestFailed'))
      throw error
    } finally {
      busy = false
    }
  }

  async function refreshBrowserRuntimes() {
    if (runtimeCatalogRequest) return await runtimeCatalogRequest
    runtimeCatalogRequest = (async () => {
      try {
        browserRuntimeCatalog = await client.get('/browser-runtimes')
      } catch (error) {
        if (!browserRuntimeCatalog) showToast(error instanceof Error ? error.message : t('requestFailed'))
      } finally {
        runtimeCatalogRequest = null
      }
    })()
    await runtimeCatalogRequest
  }

  async function inspectBrowserRuntime(browser: string, executablePath?: string) {
    runtimeBusy = true
    try {
      const result = await client.mutate('/browser-runtimes/inspect', {
        browser,
        ...(executablePath ? { browserExecutablePath: executablePath } : {}),
      }) ?? {}
      return result.ok === false && typeof result.code === 'string'
        ? { ...result, message: translateError(language, result.code, String(result.message || '')) }
        : result
    } finally {
      runtimeBusy = false
    }
  }

  async function installBrowserRuntime(browser: string, repair = false) {
    runtimeBusy = true
    try {
      const result = await client.mutate('/browser-runtimes/install', { browser, repair }) ?? {}
      await refreshBrowserRuntimes()
      showToast(t(repair ? 'runtimeRepaired' : 'runtimeInstalled'))
      return result
    } finally {
      runtimeBusy = false
    }
  }

  async function discoverBrowserProfileSources(input: JsonRecord) {
    runtimeBusy = true
    try {
      return await client.mutate('/browser-profile-sources/discover', input) ?? { sources: [] }
    } finally {
      runtimeBusy = false
    }
  }

  async function clearBrowserExecutablePath(browser: string) {
    const inspection = await inspectBrowserRuntime(browser)
    if (inspection.ok !== true) throw new Error(String(inspection.message || t('browserUnavailable')))
    await mutate('/config', { browser, browserExecutablePath: null }, 'PATCH')
  }

  async function setup(config: JsonRecord, profile: JsonRecord) {
    try {
      await mutate('/config', config, 'PATCH', false)
      await mutate('/profiles', profile, 'POST', false)
      showToast(t('profileCreated'))
      navigate('profiles')
    } catch {
      // The mutation already exposes a localized error through the live region.
    }
  }

  function showToast(message: string) {
    toast = message
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => toast = '', 3200)
  }

  function t(key: Parameters<typeof translate>[1]) {
    return translate(language, key)
  }
</script>

{#if fatal}
  <main class="fatal-state" data-testid="fatal-state">
    <img src="/ui/mark.png" alt="" />
    <h1>{t('sessionExpired')}</h1>
    <p>{fatal}</p>
    <p>{t('reopen')}</p>
  </main>
{:else if !snapshot}
  <main class="loading-state" aria-live="polite">
    <img src="/ui/mark.png" alt="" />
    <span class="spinner"></span>
    <p>{t('loading')}</p>
  </main>
{:else if snapshot.profiles.length === 0}
  <SetupView
    {snapshot}
    {language}
    {t}
    busy={busy || runtimeBusy}
    browserRuntimeCatalog={browserRuntimeCatalog}
    oninspectbrowser={inspectBrowserRuntime}
    oninstallbrowser={installBrowserRuntime}
    onclearbrowserpath={clearBrowserExecutablePath}
    ondiscoverprofiles={discoverBrowserProfileSources}
    onsetup={setup}
  />
{:else}
  <div class:profiles-active={section === 'profiles'} class="app-shell" data-testid="app-shell">
    <aside class="rail">
      <div class="rail-brand"><img src="/ui/mark.png" alt="Tokenless" /></div>
      <nav aria-label={t('primaryNavigation')}>
        {#each navigation as item (item.id)}
          {@const Icon = item.icon}
          <button
            class:active={section === item.id}
            class="rail-button"
            type="button"
            aria-label={item.label}
            aria-current={section === item.id ? 'page' : undefined}
            title={item.label}
            data-tooltip={item.label}
            data-nav={item.id}
            onclick={() => navigate(item.id)}
          ><Icon size={19} strokeWidth={1.8} /></button>
        {/each}
      </nav>
      <div class="rail-status" class:offline aria-label={offline ? t('offline') : t('healthy')} title={offline ? t('offline') : t('healthy')}>
        <span></span>
      </div>
    </aside>

    <header class="mobile-header">
      <div><img src="/ui/mark.png" alt="" /><strong>Tokenless</strong></div>
      <label class="mobile-profile-select">
        <span class="sr-only">{t('selectProfile')}</span>
        <select bind:value={selectedProfile}>{#each snapshot.profiles as profile}<option value={profile.slug}>{profile.label}</option>{/each}</select>
      </label>
    </header>

    {#if offline}<div class="offline-banner" role="status">{t('offlineShort')}</div>{/if}

    <main id="main" tabindex="-1" class:profile-main={section === 'profiles'}>
      {#if section === 'overview'}
        <OverviewView {snapshot} {selectedProfile} {t} onnavigate={navigate} onmutate={mutate} />
      {:else if section === 'profiles'}
        <ProfilesView {snapshot} {selectedProfile} {t} {busy} onselect={(slug) => selectedProfile = slug} onmutate={mutate} ondiscoverprofiles={discoverBrowserProfileSources} />
      {:else if section === 'providers'}
        <ProvidersView {snapshot} {selectedProfile} {t} {busy} onselect={(slug) => selectedProfile = slug} onmutate={mutate} />
      {:else if section === 'capabilities'}
        <CapabilitiesView {snapshot} {selectedProfile} {language} {t} onselect={(slug) => selectedProfile = slug} />
      {:else if section === 'jobs'}
        <JobsView {snapshot} {language} {t} {busy} onget={(path) => client.get(path)} onmutate={mutate} />
      {:else}
        <SystemView
          {snapshot}
          {language}
          {t}
          busy={busy || runtimeBusy}
          browserRuntimeCatalog={browserRuntimeCatalog}
          oninspectbrowser={inspectBrowserRuntime}
          oninstallbrowser={installBrowserRuntime}
          onclearbrowserpath={clearBrowserExecutablePath}
          onmutate={mutate}
          ontoast={showToast}
        />
      {/if}
    </main>

    <nav class="mobile-nav" aria-label={t('primaryNavigation')}>
      {#each navigation as item (item.id)}
        {@const Icon = item.icon}
        <button class:active={section === item.id} type="button" aria-label={item.label} aria-current={section === item.id ? 'page' : undefined} data-nav={item.id} onclick={() => navigate(item.id)}>
          <Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>
        </button>
      {/each}
    </nav>
  </div>
{/if}

<div class="toast-region" aria-live="polite" aria-atomic="true">{#if toast}<div class="toast" role="status">{toast}</div>{/if}</div>

<svelte:head><meta name="theme-color" content="#f6f5f2" /></svelte:head>
