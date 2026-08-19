<script lang="ts">
  import { ChevronRight, Clock3, ExternalLink, Search, X } from '@lucide/svelte'
  import { onMount, tick } from 'svelte'
  import Modal from '../components/Modal.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import ProviderIdentity from '../components/ProviderIdentity.svelte'
  import { formatNumber, formatTime } from '../formatting.js'
  import { stateLabel, translateError, type MessageKey } from '../localization.js'
  import { createRouterEngine } from '../router-engine.js'
  import type { DashboardActions, Language, UiJobDetail, UiJobSummary, UiSnapshot } from '../types.js'

  let { snapshot, language, t, busy, actions }: {
    snapshot: UiSnapshot
    language: Language
    t: (key: MessageKey) => string
    busy: boolean
    actions: DashboardActions
  } = $props()

  let status = $state('')
  let provider = $state('')
  let profile = $state('')
  let search = $state('')
  let detail = $state<UiJobDetail | null>(null)
  let error = $state('')
  let errorElement = $state<HTMLDivElement>()
  let filtersReady = $state(false)
  let generatedTitles = $state<Record<string, string>>({})
  const titleRequests = new Set<string>()
  let chatJobs = $derived(snapshot.jobs.filter((job) => typeof job.titlePrompt === 'string' && job.titlePrompt.length > 0))
  let filtered = $derived(chatJobs.filter((job) => {
    const query = search.trim().toLowerCase()
    return (!status || job.status === status)
      && (!provider || job.provider === provider)
      && (!profile || job.profileSlug === profile || job.profileId === profile)
      && (!query || JSON.stringify([job.jobId, job.taskId, job.chatTitle, job.titlePrompt, job.providers, job.profileSlug]).toLowerCase().includes(query))
  }))

  onMount(() => {
    const query = new URL(location.href).searchParams
    status = query.get('jobStatus') ?? ''
    provider = query.get('jobProvider') ?? ''
    profile = query.get('jobProfile') ?? ''
    search = query.get('jobSearch') ?? ''
    filtersReady = true
    try {
      generatedTitles = JSON.parse(localStorage.getItem('tokenless.chat-titles.v1') ?? '{}') as Record<string, string>
    } catch {
      generatedTitles = {}
    }
  })

  $effect(() => {
    if (!filtersReady || !snapshot.config.router.enabled) return
    for (const job of filtered.slice(0, 20)) void generateTitle(job)
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
      detail = await actions.getJob(jobId)
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
      await (action === 'cancel' ? actions.cancelJob(detail.jobId) : actions.resumeJob(detail.jobId))
      detail = null
    } catch (caught) {
      error = caught instanceof Error ? caught.message : t('requestFailed')
      await tick()
      errorElement?.focus()
    }
  }

  function jobErrorSummary(value: unknown) {
    if (!value) return t('none')
    const error = publicError(value)
    const code = typeof error?.code === 'string' ? error.code : ''
    const fallback = typeof error?.message === 'string' ? error.message : t('requestFailed')
    return translateError(language, code, fallback)
  }

  function publicError(value: unknown): { code?: unknown; message?: unknown } | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as { code?: unknown; message?: unknown }
      : null
  }

  function providerLabel(providerId: string) {
    return snapshot.providers.find((entry) => entry.id === providerId)?.label ?? providerId
  }

  function titleFor(job: UiJobSummary) {
    return job.chatTitle ?? generatedTitles[job.jobId] ?? fallbackTitle(job.titlePrompt) ?? t('untitledChat')
  }

  function fallbackTitle(value: string | null) {
    if (!value) return null
    const userTurns = [...value.matchAll(/\[User\]\s*([\s\S]*?)(?=\n\n\[(?:System|Developer|Assistant|Tool|User)\]|$)/giu)]
    const source = userTurns.at(-1)?.[1] ?? value
    const normalized = source
      .replace(/\[(?:System|Developer|Assistant|Tool|User)\]\s*/giu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
    return normalized.length > 64 ? `${normalized.slice(0, 61).trimEnd()}…` : normalized
  }

  async function generateTitle(job: UiJobSummary) {
    if (job.chatTitle || generatedTitles[job.jobId] || !job.titlePrompt || titleRequests.has(job.jobId)) return
    const profile = snapshot.profiles.find((entry) => entry.id === job.profileId)
    if (!profile) return
    titleRequests.add(job.jobId)
    try {
      const title = await createRouterEngine(snapshot.config.router.engine).title(job.titlePrompt, profile.browserBinding)
      generatedTitles = { ...generatedTitles, [job.jobId]: title }
      localStorage.setItem('tokenless.chat-titles.v1', JSON.stringify(generatedTitles))
    } catch {
      // The prompt-derived fallback remains visible when Nano is unavailable.
    }
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
        <span class="job-provider-stack">{#each job.providers ?? [job.provider] as providerId}<ProviderIdentity provider={providerId} label={providerLabel(providerId)} compact />{/each}</span>
        <span class="data-row-main"><strong>{titleFor(job)}</strong><small>{job.executionMode === 'browser' ? t('browserMode') : job.executionMode === 'direct' ? t('directMode') : '—'}{#if typeof job.estimatedTokens === 'number'} · ≈{formatNumber(job.estimatedTokens, language)} {t('estimatedTokensShort')}{/if}</small></span>
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
  <Modal title={titleFor(detail)} closeLabel={t('close')} onclose={() => detail = null} wide>
    <div class="detail-stack" data-testid="job-detail">
      <div class="detail-meta"><span class={`job-state ${detail.status}`}></span><strong>{stateLabel(language, detail.status)}</strong>{#each detail.providers ?? [detail.provider] as providerId}<ProviderIdentity provider={providerId} label={providerLabel(providerId)} />{/each}<span class="badge neutral">{detail.executionMode === 'browser' ? t('browserMode') : detail.executionMode === 'direct' ? t('directMode') : '—'}</span>{#if detail.conversationUrl}<a class="text-button" href={detail.conversationUrl} target="_blank" rel="noreferrer">{t('openProviderChat')} <ExternalLink size={13} /></a>{/if}</div>
      {#if error}<div bind:this={errorElement} class="inline-feedback error" role="alert" tabindex="-1"><span>{error}</span></div>{/if}
      <p class="muted">{t('created')}: {formatTime(detail.createdAt, language)}<br />{t('updated')}: {formatTime(detail.updatedAt, language)}</p>
      {#if detail.status === 'waiting_for_user'}<button class="button primary" type="button" disabled={busy} onclick={() => jobAction('resume')}>{t('resume')}</button>{:else if ['queued', 'claimed', 'running'].includes(detail.status)}<button class="button danger" type="button" disabled={busy} onclick={() => jobAction('cancel')}>{t('cancel')}</button>{/if}
      <section><h3>{t('estimatedTokens')}</h3><p class="token-total">{typeof detail.estimatedTokens === 'number' ? `≈${formatNumber(detail.estimatedTokens, language)}` : '—'}</p></section>
      <section><h3>{t('conversation')}</h3><div class="chat-transcript">{#each detail.transcript as message}<article class={`chat-message ${message.role}`}><strong>{message.role === 'user' ? t('userPrompt') : t('assistantReply')}</strong><p>{message.content}</p></article>{:else}<p class="muted">{t('noConversation')}</p>{/each}</div></section>
      {#if detail.error || detail.blocker}<section>
        <h3>{t('error')}</h3>
        <p class="inline-feedback error" data-testid="job-error-summary">{jobErrorSummary(detail.error ?? detail.blocker)}</p>
        <details><summary>{t('details')}</summary><pre>{JSON.stringify(detail.error ?? detail.blocker, null, 2)}</pre></details>
      </section>{/if}
      <details class="technical-details"><summary>{t('technicalDetails')}</summary><section><h3>{t('result')}</h3><pre>{JSON.stringify(detail.result, null, 2)}</pre></section><section><h3>{t('attempts')}</h3><pre>{JSON.stringify(detail.providerAttempts, null, 2)}</pre></section></details>
    </div>
  </Modal>
{/if}
