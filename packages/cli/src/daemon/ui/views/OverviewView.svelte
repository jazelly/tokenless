<script lang="ts">
  import { ArrowUpRight, Bot, Clock3, ExternalLink, Monitor, UserRound } from '@lucide/svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import type { JsonRecord } from '../types.js'

  let { snapshot, selectedProfile, t, onnavigate, onmutate }: {
    snapshot: JsonRecord
    selectedProfile: string
    t: (key: any) => string
    onnavigate: (section: string) => void
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
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
    {#snippet actions()}
      {#if profile}
        <button class="button primary icon-label" type="button" onclick={() => onmutate(`/profiles/${encodeURIComponent(profile.slug)}/open`)}>
          <ExternalLink size={15} />{t('openBrowser')}
        </button>
      {/if}
    {/snippet}
  </PageHeader>

  <div class="metric-grid">
    <article class="metric-card"><span class="metric-icon"><Bot size={18} /></span><div><small>{t('daemon')}</small><strong>{snapshot.daemon.version}</strong><p>{Math.floor(snapshot.daemon.uptimeMs / 60000)} {t('uptimeUnit')}</p></div></article>
    <article class="metric-card"><span class="metric-icon"><Monitor size={18} /></span><div><small>{t('runtime')}</small><strong>{snapshot.runtime.status}</strong><p>{snapshot.runtime.activeJobCount} {t('activeUnit')}</p></div></article>
    <article class="metric-card"><span class="metric-icon"><UserRound size={18} /></span><div><small>{t('profiles')}</small><strong>{snapshot.profiles.length}</strong><p>{profile?.label ?? t('noProfiles')}</p></div></article>
    <article class="metric-card"><span class="metric-icon"><Clock3 size={18} /></span><div><small>{t('waitingJobs')}</small><strong>{waiting.length}</strong><p>{running.length} {t('activeUnit')}</p></div></article>
  </div>

  <div class="overview-grid">
    <section class="content-panel">
      <header class="panel-title"><div><h2>{t('providerReadiness')}</h2><p>{profile?.label}</p></div><span class="badge neutral">{readyProviders.length}/{snapshot.providers.length}</span></header>
      <div class="row-list">
        {#each snapshot.providers as provider (provider.id)}
          {@const state = profileState(provider)}
          <button class="data-row" type="button" onclick={() => onnavigate('providers')}>
            <span class="provider-glyph">{provider.label.slice(0, 1)}</span>
            <span class="data-row-main"><strong>{provider.label}</strong><small>{state?.observation?.access ?? t('neverChecked')}</small></span>
            <span class:ok={state?.runtimeEligibility === 'eligible'} class="status-dot"></span>
            <ArrowUpRight size={15} />
          </button>
        {/each}
      </div>
    </section>

    <section class="content-panel">
      <header class="panel-title"><div><h2>{t('recentJobs')}</h2><p>{snapshot.jobs.length} {t('durableUnit')}</p></div><button class="text-button" type="button" onclick={() => onnavigate('jobs')}>{t('details')}</button></header>
      <div class="row-list">
        {#each snapshot.jobs.slice(0, 6) as job (job.jobId)}
          <button class="data-row" type="button" onclick={() => onnavigate('jobs')}>
            <span class={`job-state ${job.status}`}></span>
            <span class="data-row-main"><strong>{job.taskId ?? job.jobId}</strong><small>{job.provider ?? '—'} · {job.profileSlug ?? '—'}</small></span>
            <span class="mono-label">{job.status}</span>
            <ArrowUpRight size={15} />
          </button>
        {:else}
          <div class="empty-state"><Clock3 size={22} /><strong>{t('noJobs')}</strong><p>{t('noJobsBody')}</p></div>
        {/each}
      </div>
    </section>
  </div>
</section>
