<script lang="ts">
  import { ChevronRight, Clock3, Search, X } from '@lucide/svelte'
  import Modal from '../components/Modal.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatTime } from '../formatting.js'
  import type { JsonRecord, Language } from '../types.js'

  let { snapshot, language, t, busy, onget, onmutate }: {
    snapshot: JsonRecord
    language: Language
    t: (key: any) => string
    busy: boolean
    onget: (path: string) => Promise<JsonRecord | null>
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
  } = $props()

  let status = $state('')
  let provider = $state('')
  let profile = $state('')
  let search = $state('')
  let detail = $state<JsonRecord | null>(null)
  let filtered = $derived(snapshot.jobs.filter((job: JsonRecord) => {
    const query = search.trim().toLowerCase()
    return (!status || job.status === status)
      && (!provider || job.provider === provider)
      && (!profile || job.profileSlug === profile || job.profileId === profile)
      && (!query || JSON.stringify([job.jobId, job.taskId, job.provider, job.profileSlug]).toLowerCase().includes(query))
  }))

  async function showDetail(jobId: string) {
    detail = await onget(`/jobs/${encodeURIComponent(jobId)}`)
  }

  async function jobAction(action: 'cancel' | 'resume') {
    if (!detail) return
    await onmutate(`/jobs/${encodeURIComponent(detail.jobId)}/${action}`)
    detail = null
  }
</script>

<section class="page" data-testid="jobs-view">
  <PageHeader title={t('jobs')} description={t('jobsLede')} />
  <div class="filter-bar">
    <label class="search-field"><Search size={16} /><input type="search" bind:value={search} placeholder={t('searchJobs')} data-testid="job-search" />{#if search}<button type="button" aria-label={t('close')} onclick={() => search = ''}><X size={14} /></button>{/if}</label>
    <select bind:value={status} aria-label={t('allStatuses')} data-testid="job-status"><option value="">{t('allStatuses')}</option>{#each ['queued', 'claimed', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled', 'timed_out'] as value}<option value={value}>{value}</option>{/each}</select>
    <select bind:value={provider} aria-label={t('allProviders')}><option value="">{t('allProviders')}</option>{#each snapshot.providers as entry}<option value={entry.id}>{entry.label}</option>{/each}</select>
    <select bind:value={profile} aria-label={t('allProfiles')}><option value="">{t('allProfiles')}</option>{#each snapshot.profiles as entry}<option value={entry.slug}>{entry.label}</option>{/each}</select>
  </div>

  <div class="content-panel jobs-list" data-testid="job-list">
    {#each filtered as job (job.jobId)}
      <button class="data-row job-row" type="button" onclick={() => showDetail(job.jobId)} data-testid={`job-${job.jobId}`}>
        <span class={`job-state ${job.status}`}></span>
        <span class="data-row-main"><strong>{job.taskId ?? job.jobId}</strong><small>{job.provider ?? '—'} · {job.profileSlug ?? '—'}</small></span>
        <span class="mono-label">{job.status}</span>
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
      <div class="detail-meta"><span class={`job-state ${detail.status}`}></span><strong>{detail.status}</strong><span>{detail.provider ?? '—'}</span><span>{detail.profileSlug ?? detail.profileId ?? '—'}</span></div>
      <p class="muted">{t('created')}: {formatTime(detail.createdAt, language)}<br />{t('updated')}: {formatTime(detail.updatedAt, language)}</p>
      {#if detail.status === 'waiting_for_user'}<button class="button primary" type="button" disabled={busy} onclick={() => jobAction('resume')}>{t('resume')}</button>{:else if ['queued', 'claimed', 'running'].includes(detail.status)}<button class="button danger" type="button" disabled={busy} onclick={() => jobAction('cancel')}>{t('cancel')}</button>{/if}
      <section><h3>{t('result')}</h3><pre>{JSON.stringify(detail.result, null, 2)}</pre></section>
      <section><h3>{t('error')}</h3><pre>{JSON.stringify(detail.error ?? detail.blocker, null, 2)}</pre></section>
      <section><h3>{t('attempts')}</h3><pre>{JSON.stringify(detail.providerAttempts, null, 2)}</pre></section>
    </div>
  </Modal>
{/if}
