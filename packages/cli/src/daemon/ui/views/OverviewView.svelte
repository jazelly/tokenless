<script lang="ts">
  import { ArrowUpRight, Bot, Calculator, Clock3, Monitor, UserRound } from '@lucide/svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatNumber } from '../formatting.js'
  import { stateLabel } from '../localization.js'
  import type { JsonRecord, Language } from '../types.js'

  let { snapshot, selectedProfile, language, t }: {
    snapshot: JsonRecord
    selectedProfile: string
    language: Language
    t: (key: any) => string
  } = $props()

  let profile = $derived(snapshot.profiles.find((entry: JsonRecord) => entry.slug === selectedProfile) ?? snapshot.profiles[0])
  let waiting = $derived(snapshot.jobs.filter((job: JsonRecord) => job.status === 'waiting_for_user'))
  let running = $derived(snapshot.jobs.filter((job: JsonRecord) => ['queued', 'claimed', 'running'].includes(job.status)))
  let readyProviders = $derived(snapshot.providers.filter((provider: JsonRecord) => provider.profiles?.some((entry: JsonRecord) => entry.profileId === profile?.slug && entry.enabled && entry.runtimeEligibility === 'eligible')))

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
    <article class="metric-card"><span class="metric-icon"><UserRound size={18} /></span><div><small>{t('profiles')}</small><strong>{formatNumber(snapshot.profiles.length, language)}</strong><p>{profile?.label ?? t('noProfiles')}</p></div></article>
    <article class="metric-card"><span class="metric-icon"><Clock3 size={18} /></span><div><small>{t('waitingJobs')}</small><strong>{formatNumber(waiting.length, language)}</strong><p>{formatNumber(running.length, language)} {t('activeUnit')}</p></div></article>
    <article class="metric-card"><span class="metric-icon"><Calculator size={18} /></span><div><small>{t('estimatedTokensSaved')}</small><strong>{formatNumber(snapshot.outputSavings.summary.estimatedOutputTokens, language)}</strong><p>{formatNumber(snapshot.outputSavings.summary.responseCount, language)} {t('measuredResponses')}</p></div></article>
  </div>

  <div class="overview-grid">
    <section class="content-panel">
      <header class="panel-title"><div><h2>{t('providerReadiness')}</h2><p>{profile?.label}</p></div><span class="badge neutral">{formatNumber(readyProviders.length, language)}/{formatNumber(snapshot.providers.length, language)}</span></header>
      <div class="row-list">
        {#each snapshot.providers as provider (provider.id)}
          {@const state = profileState(provider)}
          <a class="data-row" href="#providers">
            <span class="provider-glyph">{provider.label.slice(0, 1)}</span>
            <span class="data-row-main"><strong>{provider.label}</strong><small>{state?.observation?.access ?? t('neverChecked')}</small></span>
            <span class:ok={state?.runtimeEligibility === 'eligible'} class="status-dot"></span>
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
