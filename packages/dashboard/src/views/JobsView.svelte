<script lang="ts">
  import { ArrowLeft, Clock3, ExternalLink, Search, SlidersHorizontal, X } from '@lucide/svelte'
  import { onMount, tick } from 'svelte'
  import ProviderIdentity from '../components/ProviderIdentity.svelte'
  import { formatChatTitle, formatNumber, formatTime, isConversationJob } from '../formatting.js'
  import { stateLabel, translateError, type MessageKey } from '../i18n/index.js'
  import { createRouterEngine } from '../router-engine.js'
  import type { DashboardActions, Language, DashboardJobDetail, DashboardJobSummary, DashboardSnapshot } from '../types.js'

  let { snapshot, language, t, busy, actions }: {
    snapshot: DashboardSnapshot
    language: Language
    t: (key: MessageKey) => string
    busy: boolean
    actions: DashboardActions
  } = $props()

  let status = $state('')
  let provider = $state('')
  let profile = $state('')
  let search = $state('')
  let detail = $state<DashboardJobDetail | null>(null)
  let error = $state('')
  let errorElement = $state<HTMLDivElement>()
  let filtersReady = $state(false)
  let generatedTitles = $state<Record<string, string>>({})
  let detailPage = $state<HTMLElement>()
  const titleRequests = new Set<string>()
  let chatJobs = $derived(snapshot.jobs.filter(isConversationJob))
  let filtered = $derived(chatJobs.filter((job) => {
    const query = search.trim().toLowerCase()
    return (!status || job.status === status)
      && (!provider || job.provider === provider)
      && (!profile || job.profileSlug === profile || job.profileId === profile)
      && (!query || JSON.stringify([job.jobId, job.taskId, job.chatTitle, job.titlePrompt, job.providers, job.profileSlug]).toLowerCase().includes(query))
  }))
  let activeFilterCount = $derived([status, provider, profile].filter(Boolean).length)

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
    const requestedJobId = query.get('job')
    if (requestedJobId) void showDetail(requestedJobId)
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
    if (detail?.jobId === jobId) return
    error = ''
    try {
      detail = await actions.getJob(jobId)
      const url = new URL(location.href)
      url.searchParams.set('job', jobId)
      history.replaceState(history.state, '', url)
      await tick()
      detailPage?.focus({ preventScroll: true })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : t('requestFailed')
      await tick()
      errorElement?.focus()
    }
  }

  async function closeDetail() {
    detail = null
    error = ''
    const url = new URL(location.href)
    url.searchParams.delete('job')
    history.replaceState(history.state, '', url)
    await tick()
    document.querySelector<HTMLInputElement>('[data-testid="job-search"]')?.focus()
  }

  async function jobAction() {
    if (!detail) return
    error = ''
    try {
      await actions.cancelJob(detail.jobId)
      await closeDetail()
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

  function titleFor(job: DashboardJobSummary) {
    return formatChatTitle(job.chatTitle ?? generatedTitles[job.jobId], job.titlePrompt, t('untitledChat'))
  }

  async function generateTitle(job: DashboardJobSummary) {
    if (job.chatTitle || generatedTitles[job.jobId] || !job.titlePrompt || titleRequests.has(job.jobId)) return
    const profile = snapshot.profiles.find((entry) => entry.slug === job.profileId)
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

<section class:conversation-open={detail !== null} class="chat-history-page" data-testid="jobs-view" aria-label={t('jobs')}>
  <aside class="chat-history-sidebar" aria-labelledby="chat-history-title">
    <header class="chat-history-sidebar-header">
      <div>
        <h1 id="chat-history-title">{t('jobs')}</h1>
        <p>{t('jobsLede')}</p>
      </div>
      <span class="chat-history-count" aria-live="polite">{formatNumber(filtered.length, language)}</span>
    </header>

    <div class="chat-history-controls">
      <label class="search-field chat-history-search">
        <Search size={16} />
        <input name="jobSearch" type="search" bind:value={search} placeholder={t('searchJobs')} autocomplete="off" data-testid="job-search" />
        {#if search}<button type="button" aria-label={t('close')} onclick={() => search = ''}><X size={14} /></button>{/if}
      </label>

      <details class="chat-history-filters" open={activeFilterCount > 0}>
        <summary data-testid="job-filters-toggle"><SlidersHorizontal size={14} />{t('filters')}{#if activeFilterCount}<span>{activeFilterCount}</span>{/if}</summary>
        <div>
          <select name="jobStatus" bind:value={status} aria-label={t('allStatuses')} data-testid="job-status"><option value="">{t('allStatuses')}</option>{#each ['queued', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled'] as value}<option value={value}>{stateLabel(language, value)}</option>{/each}</select>
          <select name="jobProvider" bind:value={provider} aria-label={t('allProviders')}><option value="">{t('allProviders')}</option>{#each snapshot.providers as entry}<option value={entry.id}>{entry.label}</option>{/each}</select>
          <select name="jobProfile" bind:value={profile} aria-label={t('allProfiles')}><option value="">{t('allProfiles')}</option>{#each snapshot.profiles as entry}<option value={entry.slug}>{entry.slug}</option>{/each}</select>
        </div>
      </details>
    </div>

    {#if error}<div bind:this={errorElement} class="inline-feedback error chat-history-error" role="alert" tabindex="-1"><span>{error}</span></div>{/if}

    <nav class="chat-history-list" aria-label={t('conversationList')} data-testid="job-list">
      {#each filtered as job (job.jobId)}
        <div class:active={detail?.jobId === job.jobId} class="chat-history-item">
          <button
            class="chat-history-select"
            type="button"
            onclick={() => showDetail(job.jobId)}
            aria-current={detail?.jobId === job.jobId ? 'page' : undefined}
            aria-label={`${t('selectConversation')}: ${titleFor(job)}`}
            data-testid={`job-${job.jobId}`}
          >
            <strong>{titleFor(job)}</strong>
            <span class="chat-history-item-meta">
              <span><span class={`job-state ${job.status}`}></span>{stateLabel(language, job.status)}</span>
              <time>{formatTime(job.updatedAt, language)}</time>
            </span>
          </button>
          {#if job.conversationUrl}
            <a class="chat-history-item-action" href={job.conversationUrl} target="_blank" rel="noreferrer" aria-label={`${t('openProviderChat')}: ${titleFor(job)}`} title={t('openProviderChat')}><ExternalLink size={14} /></a>
          {/if}
        </div>
      {:else}
        <div class="empty-state chat-history-list-empty"><Clock3 size={22} /><strong>{t('noResults')}</strong></div>
      {/each}
    </nav>
  </aside>

  <section class="chat-workspace" aria-live="polite">
    {#if detail}
      <article bind:this={detailPage} class="chat-detail-page" data-testid="job-detail-page" tabindex="-1" aria-labelledby="chat-detail-title">
        <header class="chat-conversation-header">
          <button class="icon-button chat-detail-back" type="button" onclick={closeDetail} data-testid="job-detail-back" aria-label={t('backToChatHistory')} title={t('backToChatHistory')}><ArrowLeft size={17} /></button>
          <div class="chat-conversation-heading">
            <h1 id="chat-detail-title">{titleFor(detail)}</h1>
            <div class="chat-conversation-meta">
              <span><span class={`job-state ${detail.status}`}></span>{stateLabel(language, detail.status)}</span>
              {#each detail.providers ?? [detail.provider] as providerId}<ProviderIdentity provider={providerId} label={providerLabel(providerId)} />{/each}
              <span>{detail.executionMode === 'browser' ? t('browserMode') : detail.executionMode === 'direct' ? t('directMode') : '—'}</span>
              {#if typeof detail.estimatedTokens === 'number'}<span>≈{formatNumber(detail.estimatedTokens, language)} {t('estimatedTokensShort')}</span>{/if}
            </div>
          </div>
          <div class="chat-conversation-actions">
            {#if ['queued', 'running', 'waiting_for_user'].includes(detail.status)}<button class="button danger" type="button" disabled={busy} onclick={jobAction}>{t('cancel')}</button>{/if}
            {#if detail.conversationUrl}<a class="button secondary icon-label" href={detail.conversationUrl} target="_blank" rel="noreferrer">{t('openProviderChat')} <ExternalLink size={14} /></a>{/if}
          </div>
        </header>

        <div class="chat-conversation-scroll" data-testid="job-detail">
          <div class="chat-thread">
            <div class="chat-transcript">
              {#each detail.transcript as message}
                <article class={`chat-message ${message.role}`}>
                  <h2 class="sr-only">{message.role === 'user' ? t('userPrompt') : t('assistantReply')}</h2>
                  <div class="chat-message-body"><p>{message.content}</p></div>
                </article>
              {:else}
                <div class="empty-state chat-conversation-empty"><Clock3 size={22} /><strong>{t('noConversation')}</strong></div>
              {/each}
            </div>

            {#if detail.error || detail.blocker}
              <section class="chat-error-section">
                <h2>{t('error')}</h2>
                <p class="inline-feedback error" data-testid="job-error-summary">{jobErrorSummary(detail.error ?? detail.blocker)}</p>
              </section>
            {/if}

            <details class="chat-record-details">
              <summary>{t('conversationDetails')}</summary>
              <div class="chat-record-body">
                <dl>
                  <div><dt>{t('provider')}</dt><dd>{#each detail.providers ?? [detail.provider] as providerId}<ProviderIdentity provider={providerId} label={providerLabel(providerId)} />{/each}</dd></div>
                  <div><dt>{t('executionMode')}</dt><dd>{detail.executionMode === 'browser' ? t('browserMode') : detail.executionMode === 'direct' ? t('directMode') : '—'}</dd></div>
                  <div><dt>{t('status')}</dt><dd><span class={`job-state ${detail.status}`}></span>{stateLabel(language, detail.status)}</dd></div>
                  <div><dt>{t('estimatedTokens')}</dt><dd>{typeof detail.estimatedTokens === 'number' ? `≈${formatNumber(detail.estimatedTokens, language)}` : '—'}</dd></div>
                  <div><dt>{t('created')}</dt><dd>{formatTime(detail.createdAt, language)}</dd></div>
                  <div><dt>{t('updated')}</dt><dd>{formatTime(detail.updatedAt, language)}</dd></div>
                  <div><dt>{t('jobId')}</dt><dd class="mono-label">{detail.jobId}</dd></div>
                </dl>

                <details class="chat-technical-details">
                  <summary>{t('technicalDetails')}</summary>
                  <div><section><h3>{t('result')}</h3><pre>{JSON.stringify(detail.result, null, 2)}</pre></section></div>
                </details>
              </div>
            </details>
          </div>
        </div>
      </article>
    {:else}
      <div class="chat-workspace-empty">
        <Clock3 size={24} />
        <h2>{t('selectConversation')}</h2>
        <p>{t('selectConversationHint')}</p>
      </div>
    {/if}
  </section>
</section>
