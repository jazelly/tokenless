<script lang="ts">
  import markUrl from '../../../assets/tokenless-mark.png'
  import { Blocks, Gauge, LayoutDashboard, MessageSquareText, PanelsTopLeft, Settings, UsersRound } from '@lucide/svelte'
  import TopHeader from './components/TopHeader.svelte'
  import CapabilitiesView from './views/CapabilitiesView.svelte'
  import RateLimitsView from './views/RateLimitsView.svelte'
  import JobsView from './views/JobsView.svelte'
  import OverviewView from './views/OverviewView.svelte'
  import ProfilesView from './views/ProfilesView.svelte'
  import ProvidersView from './views/ProvidersView.svelte'
  import SetupView from './views/SetupView.svelte'
  import SystemView from './views/SystemView.svelte'
  import { translate, type MessageKey } from './i18n/index.js'
  import type { DashboardActions, DashboardSetupInput, DashboardSnapshot, Language, Section } from './types.js'

  let {
    snapshot, language, section, selectedProfile, actions, busy = false,
    offline = false, fatal = '', setupRoute = false, toast = '',
    sectionHref, onselect, onsetup, ontoast,
  }: {
    snapshot: DashboardSnapshot | null
    language: Language
    section: Section
    selectedProfile: string
    actions: DashboardActions
    busy?: boolean
    offline?: boolean
    fatal?: string
    setupRoute?: boolean
    toast?: string
    sectionHref: (section: Section) => string
    onselect: (slug: string) => void
    onsetup: (input: DashboardSetupInput) => Promise<void>
    ontoast: (message: string) => void
  } = $props()

  function t(key: MessageKey, params: Readonly<Record<string, string | number>> = {}) {
    return translate(language, key, params)
  }

  const navigation = $derived([
    { id: 'overview' as const, label: t('overview'), icon: LayoutDashboard },
    { id: 'profiles' as const, label: t('profiles'), icon: UsersRound },
    { id: 'providers' as const, label: t('providers'), icon: PanelsTopLeft },
    { id: 'capabilities' as const, label: t('capabilities'), icon: Blocks },
    { id: 'rate-limits' as const, label: t('rateLimits'), icon: Gauge },
    { id: 'jobs' as const, label: t('jobs'), icon: MessageSquareText },
    { id: 'system' as const, label: t('system'), icon: Settings },
  ])
  const primaryNavigation = $derived(navigation.filter((item) => item.id !== 'system'))

</script>

{#if fatal}
  <main id="main" tabindex="-1" class="fatal-state" data-testid="fatal-state">
    <img src={markUrl} alt="" width="42" height="42" />
    <h1>{t('sessionExpired')}</h1>
    <p>{fatal}</p>
    <p>{t('reopen')}</p>
  </main>
{:else if !snapshot}
  <main id="main" tabindex="-1" class="loading-state" aria-live="polite">
    <img src={markUrl} alt="" width="42" height="42" />
    <span class="spinner"></span>
    <p>{t('loading')}</p>
  </main>
{:else if setupRoute || snapshot.profiles.length === 0}
  <SetupView
    {snapshot}
    {language}
    {t}
    {busy}
    onsetup={onsetup}
  />
{:else}
  <div class:profiles-active={section === 'profiles'} class="app-shell" data-testid="app-shell">
    <aside class="rail">
      <div class="rail-brand"><img src={markUrl} alt="Tokenless" width="28" height="28" translate="no" /></div>
      <nav aria-label={t('primaryNavigation')}>
        {#each primaryNavigation as item (item.id)}
          {@const Icon = item.icon}
          <a
            class:active={section === item.id}
            class="rail-button"
            href={sectionHref(item.id)}
            aria-label={item.label}
            aria-current={section === item.id ? 'page' : undefined}
            title={item.label}
            data-tooltip={item.label}
            data-nav={item.id}
            data-dashboard-section={item.id}
          ><Icon size={19} strokeWidth={1.8} /></a>
        {/each}
      </nav>
      <a
        class:active={section === 'system'}
        class="rail-button rail-system-button"
        href={sectionHref('system')}
        aria-label={t('system')}
        aria-current={section === 'system' ? 'page' : undefined}
        title={t('system')}
        data-tooltip={t('system')}
        data-nav="system"
        data-dashboard-section="system"
      ><Settings size={19} strokeWidth={1.8} /></a>
      <div class="rail-status" class:offline aria-label={offline ? t('offline') : t('healthy')} title={offline ? t('offline') : t('healthy')}>
        <span></span>
      </div>
    </aside>

    <TopHeader {snapshot} {selectedProfile} {language} {busy} {actions} {t} onselect={onselect} />

    {#if offline}<div class="offline-banner" role="status">{t('offlineShort')}</div>{/if}

    <main id="main" tabindex="-1" class:profile-main={section === 'profiles'}>
      {#if section === 'overview'}
        <OverviewView
          {snapshot}
          {selectedProfile}
          {language}
          {t}
          {actions}
        />
      {:else if section === 'profiles'}
        <ProfilesView {snapshot} {selectedProfile} {language} {t} {busy} {actions} onselect={onselect} />
      {:else if section === 'providers'}
        <ProvidersView {snapshot} {selectedProfile} {language} {t} {busy} {actions} onselect={onselect} />
      {:else if section === 'capabilities'}
        <CapabilitiesView {snapshot} {selectedProfile} {language} {t} onselect={onselect} />
      {:else if section === 'rate-limits'}
        <RateLimitsView {snapshot} {language} {t} />
      {:else if section === 'jobs'}
        <JobsView {snapshot} {language} {t} {busy} {actions} />
      {:else}
        <SystemView
          {snapshot}
          {language}
          {t}
          {busy}
          {actions}
          ontoast={ontoast}
        />
      {/if}
    </main>

    <nav class="mobile-nav" aria-label={t('primaryNavigation')}>
      {#each navigation as item (item.id)}
        {@const Icon = item.icon}
        <a class:active={section === item.id} href={sectionHref(item.id)} aria-label={item.label} aria-current={section === item.id ? 'page' : undefined} data-nav={item.id} data-dashboard-section={item.id}>
          <Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>
        </a>
      {/each}
    </nav>
  </div>
{/if}

<div class="toast-region" aria-live="polite" aria-atomic="true">{#if toast}<div class="toast" role="status">{toast}</div>{/if}</div>
