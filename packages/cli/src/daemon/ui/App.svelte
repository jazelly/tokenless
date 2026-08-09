<script lang="ts">
  import { onMount } from 'svelte'
  import { Blocks, LayoutDashboard, ListChecks, PanelsTopLeft, Settings, UsersRound } from '@lucide/svelte'
  import { DashboardClient } from './dashboard-client.js'
  import { translate } from './localization.js'
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
  let offline = $state(false)
  let busy = $state(false)
  let readinessBusy = $state(false)
  let fatal = $state('')
  let toast = $state('')
  let selectedProfile = $state(new URL(location.href).searchParams.get('profile') ?? '')
  let section = $state<Section>(parseSection(location.hash))
  let toastTimer = 0
  let pollTimer = 0
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
    const visibilityChange = () => { if (!document.hidden) void refresh() }
    window.addEventListener('hashchange', hashChange)
    document.addEventListener('visibilitychange', visibilityChange)
    skipLink?.addEventListener('click', skipToContent)
    void initialize()
    return () => {
      window.removeEventListener('hashchange', hashChange)
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
      if (!document.hidden && !busy) await refresh()
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
    const requestedProfile = snapshot.profiles.find((profile: JsonRecord) => profile.slug === selectedProfile || profile.id === selectedProfile)
    if (requestedProfile && requestedProfile.slug !== selectedProfile) {
      selectProfile(requestedProfile.slug)
    } else if (!requestedProfile) {
      selectProfile(snapshot.profiles.find((profile: JsonRecord) => profile.isDefault)?.slug
        ?? snapshot.profiles[0]?.slug
        ?? '')
    }
  }

  function selectProfile(slug: string) {
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

  async function mutate(path: string, body?: unknown, method = 'POST', announce = true) {
    busy = true
    try {
      const result = await client.mutate(path, body, method)
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

  async function refreshProviderReadiness(profileSlug: string) {
    if (readinessBusy) return
    readinessBusy = true
    try {
      const result = await client.mutate(`/profiles/${encodeURIComponent(profileSlug)}/providers/actions/readiness`, {}) ?? {}
      const jobIds = Array.isArray(result.jobs)
        ? result.jobs.flatMap((job: JsonRecord) => typeof job.jobId === 'string' ? [job.jobId] : [])
        : []
      if (jobIds.length === 0) {
        showToast(t('noEnabledProviders'))
        return
      }
      const jobs = await waitForReadinessJobs(jobIds)
      showToast(t(jobs.some((job) => job.status !== 'succeeded')
        ? 'providerReadinessPartiallyRefreshed'
        : 'providerReadinessRefreshed'))
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      readinessBusy = false
      await refresh()
    }
  }

  async function waitForReadinessJobs(jobIds: string[]) {
    const expected = new Set(jobIds)
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 750))
      await refresh()
      const jobs = snapshot?.jobs?.filter((job: JsonRecord) => expected.has(job.jobId)) ?? []
      if (jobs.length === expected.size && jobs.every((job: JsonRecord) => !['queued', 'claimed', 'running'].includes(job.status))) {
        return jobs as JsonRecord[]
      }
    }
    throw new Error(t('providerReadinessRefreshTimedOut'))
  }

  async function setup(config: JsonRecord, profile: JsonRecord) {
    await mutate('/config', config, 'PATCH', false)
    await mutate('/profiles', profile, 'POST', false)
    showToast(t('profileCreated'))
    navigate('profiles')
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
{:else if snapshot.profiles.length === 0}
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
        <OverviewView {snapshot} {selectedProfile} {language} {t} {readinessBusy} onrefreshreadiness={refreshProviderReadiness} />
      {:else if section === 'profiles'}
        <ProfilesView {snapshot} {selectedProfile} {language} {t} {busy} onselect={selectProfile} onmutate={mutate} />
      {:else if section === 'providers'}
        <ProvidersView {snapshot} {selectedProfile} {language} {t} {busy} onselect={selectProfile} onmutate={mutate} />
      {:else if section === 'capabilities'}
        <CapabilitiesView {snapshot} {selectedProfile} {language} {t} onselect={selectProfile} />
      {:else if section === 'jobs'}
        <JobsView {snapshot} {language} {t} {busy} onget={(path) => client.get(path)} onmutate={mutate} />
      {:else}
        <SystemView
          {snapshot}
          {language}
          {t}
          {busy}
          onmutate={mutate}
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
