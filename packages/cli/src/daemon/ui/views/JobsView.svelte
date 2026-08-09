<script lang="ts">
  import { ChevronRight, Clock3, Search, X } from '@lucide/svelte'
  import { onMount, tick } from 'svelte'
  import Modal from '../components/Modal.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatNumber, formatTime } from '../formatting.js'
  import { stateLabel, translateError, type MessageKey } from '../localization.js'
  import type { JsonRecord, Language } from '../types.js'

  let { snapshot, language, t, busy, onget, onmutate }: {
    snapshot: JsonRecord
    language: Language
    t: (key: MessageKey) => string
    busy: boolean
    onget: (path: string) => Promise<JsonRecord | null>
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
  } = $props()

  let status = $state('')
  let provider = $state('')
  let profile = $state('')
  let search = $state('')
  let detail = $state<JsonRecord | null>(null)
  let error = $state('')
  let errorElement = $state<HTMLDivElement>()
  let filtersReady = $state(false)
  let filtered = $derived(snapshot.jobs.filter((job: JsonRecord) => {
    const query = search.trim().toLowerCase()
    return (!status || job.status === status)
      && (!provider || job.provider === provider)
      && (!profile || job.profileSlug === profile || job.profileId === profile)
      && (!query || JSON.stringify([job.jobId, job.taskId, job.provider, job.profileSlug]).toLowerCase().includes(query))
  }))

  onMount(() => {
    const query = new URL(location.href).searchParams
    status = query.get('jobStatus') ?? ''
    provider = query.get('jobProvider') ?? ''
    profile = query.get('jobProfile') ?? ''
    search = query.get('jobSearch') ?? ''
    filtersReady = true
  })

  $effect(() => {
    if (!filtersReady) return
    const url = new URL(location.href)
    const filters = { jobStatus: status, jobProvider: provider, jobProfile: profile, jobSearch: search.trim() }
    for (const [key, value] of Object.entries(filters)) {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    history.replaceState(history.state, '', url)
  })

  async function showDetail(jobId: string) {
    error = ''
    try {
      detail = await onget(`/jobs/${encodeURIComponent(jobId)}`)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : t('requestFailed')
      await tick()
      errorElement?.focus()
    }
  }

  async function jobAction(action: 'cancel' | 'resume') {
    if (!detail) return
    error = ''
    try {
      await onmutate(`/jobs/${encodeURIComponent(detail.jobId)}/${action}`)
      detail = null
    } catch (caught) {
      error = caught instanceof Error ? caught.message : t('requestFailed')
      await tick()
      errorElement?.focus()
    }
  }

  function jobErrorSummary(value: JsonRecord | null | undefined) {
    if (!value) return t('none')
    const code = typeof value.code === 'string' ? value.code : ''
    const fallback = typeof value.message === 'string' ? value.message : t('requestFailed')
    return translateError(language, code, fallback)
  }
</script>

<section class="page" data-testid="jobs-view">
  <PageHeader title={t('jobs')} description={t('jobsLede')} />
  <div class="filter-bar">
    <label class="search-field"><Search size={16} /><input name="jobSearch" type="search" bind:value={search} placeholder={t('searchJobs')} autocomplete="off" data-testid="job-search" />{#if search}<button type="button" aria-label={t('close')} onclick={() => search = ''}><X size={14} /></button>{/if}</label>
    <select name="jobStatus" bind:value={status} aria-label={t('allStatuses')} data-testid="job-status"><option value="">{t('allStatuses')}</option>{#each ['queued', 'claimed', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled', 'timed_out'] as value}<option value={value}>{stateLabel(language, value)}</option>{/each}</select>
    <select name="jobProvider" bind:value={provider} aria-label={t('allProviders')}><option value="">{t('allProviders')}</option>{#each snapshot.providers as entry}<option value={entry.id}>{entry.label}</option>{/each}</select>
    <select name="jobProfile" bind:value={profile} aria-label={t('allProfiles')}><option value="">{t('allProfiles')}</option>{#each snapshot.profiles as entry}<option value={entry.slug}>{entry.slug}</option>{/each}</select>
  </div>

  {#if error && !detail}<div bind:this={errorElement} class="inline-feedback error" role="alert" tabindex="-1"><span>{error}</span></div>{/if}

  <div class="content-panel jobs-list" data-testid="job-list">
    {#each filtered as job (job.jobId)}
      <button class="data-row job-row" type="button" onclick={() => showDetail(job.jobId)} data-testid={`job-${job.jobId}`}>
        <span class={`job-state ${job.status}`}></span>
        <span class="data-row-main"><strong>{job.taskId ?? job.jobId}</strong><small>{job.provider ?? '—'} · {job.profileSlug ?? '—'}{#if job.outputSavings.estimatedOutputTokens > 0} · {formatNumber(job.outputSavings.estimatedOutputTokens, language)} {t('tokensSavedShort')}{/if}</small></span>
        <span class="mono-label">{stateLabel(language, job.status)}</span>
        <time>{formatTime(job.updatedAt, language)}</time>
        <ChevronRight size={15} />
      </button>
    {:else}
      <div class="empty-state"><Clock3 size={22} /><strong>{t('noResults')}</strong></div>
    {/each}
  </div>
</section>

{#if detail}
  <Modal title={detail.taskId ?? detail.jobId} closeLabel={t('close')} onclose={() => detail = null} wide>
    <div class="detail-stack" data-testid="job-detail">
      <div class="detail-meta"><span class={`job-state ${detail.status}`}></span><strong>{stateLabel(language, detail.status)}</strong><span translate="no">{detail.provider ?? '—'}</span><span translate="no">{detail.profileSlug ?? detail.profileId ?? '—'}</span></div>
      {#if error}<div bind:this={errorElement} class="inline-feedback error" role="alert" tabindex="-1"><span>{error}</span></div>{/if}
      <p class="muted">{t('created')}: {formatTime(detail.createdAt, language)}<br />{t('updated')}: {formatTime(detail.updatedAt, language)}</p>
      {#if detail.status === 'waiting_for_user'}<button class="button primary" type="button" disabled={busy} onclick={() => jobAction('resume')}>{t('resume')}</button>{:else if ['queued', 'claimed', 'running'].includes(detail.status)}<button class="button danger" type="button" disabled={busy} onclick={() => jobAction('cancel')}>{t('cancel')}</button>{/if}
      {#if detail.outputSavings.responseCount > 0}<section><h3>{t('outputSavings')}</h3><p>{t('estimatedTokensSaved')}: {formatNumber(detail.outputSavings.estimatedOutputTokens, language)}<br />{t('measuredResponses')}: {formatNumber(detail.outputSavings.responseCount, language)}</p></section>{/if}
      <section><h3>{t('result')}</h3><pre>{JSON.stringify(detail.result, null, 2)}</pre></section>
      <section>
        <h3>{t('error')}</h3>
        <p class="inline-feedback error" data-testid="job-error-summary">{jobErrorSummary(detail.error ?? detail.blocker)}</p>
        <details><summary>{t('details')}</summary><pre>{JSON.stringify(detail.error ?? detail.blocker, null, 2)}</pre></details>
      </section>
      <section><h3>{t('attempts')}</h3><pre>{JSON.stringify(detail.providerAttempts, null, 2)}</pre></section>
    </div>
  </Modal>
{/if}
