<script lang="ts">
  import { ArrowUpRight, Clock3, RefreshCw } from '@lucide/svelte'
  import { onDestroy, onMount } from 'svelte'
  import ProviderAccessIndicators from '../components/ProviderAccessIndicators.svelte'
  import ProviderModeBadges from '../components/ProviderModeBadges.svelte'
  import { formatAge, formatChatTitle, formatNumber, isConversationJob } from '../formatting.js'
  import { stateLabel, type MessageKey } from '../i18n/index.js'
  import type {
    Language,
    ReadinessJobs,
    DashboardProvider,
    DashboardSnapshot,
  } from '../types.js'

  let { snapshot, selectedProfile, language, t, readinessBusy, readinessJobs, onrefreshreadiness, onrefreshproviderreadiness }: {
    snapshot: DashboardSnapshot
    selectedProfile: string
    language: Language
    t: (key: MessageKey) => string
    readinessBusy: boolean
    readinessJobs: ReadinessJobs
    onrefreshreadiness: (profileSlug: string) => Promise<void>
    onrefreshproviderreadiness: (profileSlug: string, providerId: string) => Promise<void>
  } = $props()

  let profile = $derived(snapshot.profiles.find((entry) => entry.slug === selectedProfile) ?? snapshot.profiles[0])
  let enabledProviders = $derived(snapshot.providers.filter((provider) => profileState(provider)?.enabled))
  let authenticatedProviders = $derived(enabledProviders.filter((provider) => profileState(provider)?.observation?.auth === 'authenticated'))
  let recentJobs = $derived(snapshot.jobs.filter(isConversationJob).slice(0, 6))
  let now = $state(Date.now())
  let nowTimer = 0

  onMount(() => {
    nowTimer = window.setInterval(() => { now = Date.now() }, 60_000)
  })

  onDestroy(() => {
    window.clearInterval(nowTimer)
  })

  function profileState(provider: DashboardProvider) {
    return provider.profiles.find((entry) => entry.profileId === profile?.slug)
  }

  function readinessStatus(provider: DashboardProvider) {
    const readiness = readinessJobs[provider.id]
    return readiness?.status ?? ''
  }

  function jobsHref(jobId?: string) {
    const url = new URL('/dashboard/jobs/', location.origin)
    if (selectedProfile) url.searchParams.set('profile', selectedProfile)
    if (jobId) url.searchParams.set('job', jobId)
    return `${url.pathname}${url.search}`
  }

</script>

<section class="page" data-testid="overview-view">
  <div class="overview-grid">
    <section class="content-panel">
      <header class="panel-title">
        <div><h2>{t('providerReadiness')}</h2><p>{profile?.slug}</p></div>
        <div class="panel-title-actions">
          {#if readinessBusy}<span class="mono-label" aria-live="polite" data-testid="overview-readiness-status">{t('checkingProviderReadiness')}</span>{/if}
          <span
            class="badge neutral hover-tooltip tooltip-below tooltip-right"
            aria-label={`${formatNumber(authenticatedProviders.length, language)}/${formatNumber(enabledProviders.length, language)} · ${t('providerReadinessSummaryHelp')}`}
            data-testid="overview-readiness-summary"
          >{formatNumber(authenticatedProviders.length, language)}/{formatNumber(enabledProviders.length, language)} {t('signedIn')}<span class="hover-tooltip-content" aria-hidden="true">{formatNumber(authenticatedProviders.length, language)}/{formatNumber(enabledProviders.length, language)} · {t('providerReadinessSummaryHelp')}</span></span>
          <span class="hover-tooltip tooltip-below tooltip-right">
            <button
              class="icon-button"
              type="button"
              disabled={readinessBusy || enabledProviders.length === 0}
              aria-label={t(readinessBusy ? 'checkingProviderReadiness' : 'refreshProviderReadiness')}
              aria-busy={readinessBusy}
              data-testid="overview-readiness-refresh"
              onclick={() => profile?.slug && onrefreshreadiness(profile.slug)}
            ><RefreshCw size={16} /></button>
            <span class="hover-tooltip-content" aria-hidden="true">{t(readinessBusy ? 'checkingProviderReadiness' : 'refreshProviderReadiness')}</span>
          </span>
        </div>
      </header>
      <div class="row-list">
        {#each snapshot.providers as provider (provider.id)}
          {@const state = profileState(provider)}
          {@const readiness = readinessJobs[provider.id]}
          {@const checkedAt = state?.observation?.checkedAt}
          <div class="data-row" data-testid={`overview-provider-${provider.id}`}>
            <span class="provider-glyph">{provider.label.slice(0, 1)}</span>
            <span class="data-row-main"><span class="provider-name-line"><strong>{provider.label}</strong><ProviderModeBadges {provider} {state} {t} /></span><ProviderAccessIndicators providerId={provider.id} providerLabel={provider.label} subscriptionSupport={provider.subscriptionSupport} observation={state?.observation} {t} /></span>
            <span class="overview-status-meta">
              {#if readiness && readiness.status !== 'succeeded'}<span class={`job-state ${readinessStatus(provider)} hover-tooltip`} aria-label={stateLabel(language, readiness.status)}><span class="hover-tooltip-content" aria-hidden="true">{stateLabel(language, readiness.status)}</span></span>{/if}
              <time datetime={checkedAt ?? undefined}>{formatAge(checkedAt, language, t('neverChecked'), now)}</time>
            </span>
            <span class="hover-tooltip tooltip-right">
              <button
                class="icon-button"
                type="button"
                disabled={!state?.enabled || readinessBusy}
                aria-label={`${t('checkNow')}: ${provider.label}`}
                aria-busy={readiness?.status === 'queued' || readiness?.status === 'running' || readiness?.status === 'waiting_for_user'}
                onclick={() => profile?.slug && onrefreshproviderreadiness(profile.slug, provider.id)}
                data-testid={`overview-provider-readiness-${provider.id}`}
              ><RefreshCw size={15} /></button>
              <span class="hover-tooltip-content" aria-hidden="true">{t('checkNow')}: {provider.label}</span>
            </span>
          </div>
        {/each}
      </div>
    </section>

    <section class="content-panel">
      <header class="panel-title"><div><h2>{t('recentJobs')}</h2><p data-testid="overview-recent-jobs-summary">{t('showingLatest')} {formatNumber(recentJobs.length, language)} {t('recentConversations')}</p></div><a class="text-button" href={jobsHref()} data-dashboard-section="jobs">{t('moreChats')}</a></header>
      <div class="row-list">
        {#each recentJobs as job (job.jobId)}
          <a class="data-row" href={jobsHref(job.jobId)} data-dashboard-section="jobs" data-testid={`overview-job-${job.jobId}`}>
            <span class={`job-state ${job.status}`}></span>
            <span class="data-row-main"><strong>{formatChatTitle(job.chatTitle, job.titlePrompt, t('untitledChat'))}</strong><small>{job.provider ?? '—'} · {job.profileSlug ?? '—'}</small></span>
            <span class="mono-label">{stateLabel(language, job.status)}</span>
            <time datetime={job.updatedAt}>{formatAge(job.updatedAt, language, t('neverChecked'), now)}</time>
            <ArrowUpRight size={15} />
          </a>
        {:else}
          <div class="empty-state"><Clock3 size={22} /><strong>{t('noJobs')}</strong><p>{t('noJobsBody')}</p></div>
        {/each}
      </div>
    </section>
  </div>
</section>
