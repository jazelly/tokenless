<script lang="ts">
  import { ArrowUpRight, Bot, Calculator, Clock3, Monitor, RefreshCw, UserRound } from '@lucide/svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatNumber } from '../formatting.js'
  import { stateLabel, type MessageKey } from '../localization.js'
  import type { JsonRecord, Language } from '../types.js'

  let { snapshot, selectedProfile, language, t, readinessBusy, onrefreshreadiness }: {
    snapshot: JsonRecord
    selectedProfile: string
    language: Language
    t: (key: MessageKey) => string
    readinessBusy: boolean
    onrefreshreadiness: (profileSlug: string) => Promise<void>
  } = $props()

  let profile = $derived(snapshot.profiles.find((entry: JsonRecord) => entry.slug === selectedProfile) ?? snapshot.profiles[0])
  let waiting = $derived(snapshot.jobs.filter((job: JsonRecord) => job.status === 'waiting_for_user'))
  let running = $derived(snapshot.jobs.filter((job: JsonRecord) => ['queued', 'claimed', 'running'].includes(job.status)))
  let enabledProviders = $derived(snapshot.providers.filter((provider: JsonRecord) => profileState(provider)?.enabled))
  let authenticatedProviders = $derived(enabledProviders.filter((provider: JsonRecord) => profileState(provider)?.observation?.auth === 'authenticated'))
  let savingsEnabled = $derived(snapshot.outputSavings.enabled === true)
  let savingsReady = $derived(savingsEnabled && snapshot.outputSavings.collection === 'enabled')

  function profileState(provider: JsonRecord) {
    return provider.profiles?.find((entry: JsonRecord) => entry.profileId === profile?.slug)
  }

</script>

<section class="page" data-testid="overview-view">
  <PageHeader eyebrow="localhost" title={t('overview')} description={t('overviewLede')}>
  </PageHeader>

  <div class="metric-grid">
    <article class="metric-card"><span class="metric-icon"><Bot size={18} /></span><div><small>{t('daemon')}</small><strong translate="no">{snapshot.daemon.version}</strong><p>{formatNumber(Math.floor(snapshot.daemon.uptimeMs / 60000), language)} {t('uptimeUnit')}</p></div></article>
    <article class="metric-card"><span class="metric-icon"><Monitor size={18} /></span><div><small>{t('runtime')}</small><strong>{stateLabel(language, snapshot.runtime.status)}</strong><p>{formatNumber(snapshot.runtime.activeJobCount, language)} {t('activeUnit')}</p></div></article>
    <article class="metric-card"><span class="metric-icon"><UserRound size={18} /></span><div><small>{t('profiles')}</small><strong>{formatNumber(snapshot.profiles.length, language)}</strong><p>{profile?.slug ?? t('noProfiles')}</p></div></article>
    <article class="metric-card"><span class="metric-icon"><Clock3 size={18} /></span><div><small>{t('waitingJobs')}</small><strong>{formatNumber(waiting.length, language)}</strong><p>{formatNumber(running.length, language)} {t('activeUnit')}</p></div></article>
  </div>

  <article
    class:disabled={!savingsEnabled}
    class:pending={savingsEnabled && !savingsReady}
    class="overview-output-savings"
    data-testid="overview-output-savings"
    data-state={!savingsEnabled ? 'disabled' : savingsReady ? 'ready' : 'pending'}
    title={!savingsEnabled ? t('savingsUnavailableTooltip') : undefined}
  >
    <div class="overview-savings-value">
      <span class="overview-savings-icon"><Calculator size={23} /></span>
      <div>
        <small>{t('estimatedTokensSaved')}</small>
        <strong>{savingsReady ? formatNumber(snapshot.outputSavings.summary.estimatedOutputTokens, language) : '—'}</strong>
      </div>
    </div>
    <div class="overview-savings-summary">
      {#if !savingsEnabled}
        <strong>{t('savingsSummaryUnavailable')}</strong>
        <p>{t('turnOnToReview')}</p>
      {:else if !savingsReady}
        <strong>{t('savingsEnabled')}</strong>
        <p>{t('tokenizerPreparesOnFirstResponse')}</p>
      {:else}
        <strong>{formatNumber(snapshot.outputSavings.summary.responseCount, language)} {t('measuredResponses')}</strong>
        <p>{formatNumber(snapshot.outputSavings.summary.jobCount, language)} {t('durableUnit')}</p>
      {/if}
    </div>
    <a class="text-button overview-savings-link" href="#system">{t(savingsEnabled && !savingsReady ? 'prepareTokenizerNow' : 'manageOutputSavings')}</a>
  </article>

  <div class="overview-grid">
    <section class="content-panel">
      <header class="panel-title">
        <div><h2>{t('providerReadiness')}</h2><p>{profile?.slug}</p></div>
        <div class="panel-title-actions">
          <span class="badge neutral" data-testid="overview-readiness-summary">{formatNumber(authenticatedProviders.length, language)}/{formatNumber(enabledProviders.length, language)} {t('signedIn')}</span>
          <button
            class:spinning={readinessBusy}
            class="icon-button"
            type="button"
            disabled={readinessBusy || enabledProviders.length === 0}
            aria-label={t(readinessBusy ? 'checkingProviderReadiness' : 'refreshProviderReadiness')}
            aria-busy={readinessBusy}
            title={t(readinessBusy ? 'checkingProviderReadiness' : 'refreshProviderReadiness')}
            data-testid="overview-readiness-refresh"
            onclick={() => profile?.slug && onrefreshreadiness(profile.slug)}
          ><RefreshCw size={16} /></button>
        </div>
      </header>
      <div class="row-list">
        {#each snapshot.providers as provider (provider.id)}
          {@const state = profileState(provider)}
          <a class="data-row" href="#providers">
            <span class="provider-glyph">{provider.label.slice(0, 1)}</span>
            <span class="data-row-main"><strong>{provider.label}</strong><small>{state?.observation?.access ? stateLabel(language, state.observation.access) : t('neverChecked')}</small></span>
            <span class:ok={state?.observation?.auth === 'authenticated'} class="status-dot" aria-label={state?.observation?.access ? stateLabel(language, state.observation.access) : t('neverChecked')}></span>
            <ArrowUpRight size={15} />
          </a>
        {/each}
      </div>
    </section>

    <section class="content-panel">
      <header class="panel-title"><div><h2>{t('recentJobs')}</h2><p>{formatNumber(snapshot.jobs.length, language)} {t('durableUnit')}</p></div><a class="text-button" href="#jobs">{t('details')}</a></header>
      <div class="row-list">
        {#each snapshot.jobs.slice(0, 6) as job (job.jobId)}
          <a class="data-row" href="#jobs">
            <span class={`job-state ${job.status}`}></span>
            <span class="data-row-main"><strong>{job.taskId ?? job.jobId}</strong><small>{job.provider ?? '—'} · {job.profileSlug ?? '—'}</small></span>
            <span class="mono-label">{stateLabel(language, job.status)}</span>
            <ArrowUpRight size={15} />
          </a>
        {:else}
          <div class="empty-state"><Clock3 size={22} /><strong>{t('noJobs')}</strong><p>{t('noJobsBody')}</p></div>
        {/each}
      </div>
    </section>
  </div>
</section>
