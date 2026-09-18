<script lang="ts">
  import { RefreshCw } from '@lucide/svelte'
  import ProviderIdentity from '../components/ProviderIdentity.svelte'
  import { capabilityText, stateLabel, invocationFailureSummary, type MessageKey } from '../i18n/index.js'
  import { formatTime } from '../formatting.js'
  import type { DashboardActions, DashboardInvocationHistory, DashboardJobDetail, DashboardSnapshot, Language } from '../types.js'

  let { snapshot, selectedProfile, language, t, actions }: {
    snapshot: DashboardSnapshot
    selectedProfile: string
    language: Language
    t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string
    actions: DashboardActions
  } = $props()

  const initial = new URLSearchParams(location.search)
  let provider = $state(initial.get('provider') ?? '')
  let capability = $state(initial.get('capability') ?? '')
  let status = $state(initial.get('status') ?? '')
  let fromDay = $state(initial.get('fromDay') ?? '')
  let toDay = $state(initial.get('toDay') ?? '')
  let offset = $state(Number(initial.get('offset') ?? 0))
  let revision = $state(0)
  let history = $state<DashboardInvocationHistory | null>(null)
  let loading = $state(false)
  let error = $state('')
  let selected = $state('')
  let detail = $state<DashboardJobDetail | null>(null)
  let detailError = $state('')

  let previousProfile: string | undefined
  $effect(() => {
    if (previousProfile !== undefined && previousProfile !== selectedProfile) offset = 0
    previousProfile = selectedProfile
  })

  $effect(() => {
    const query = { profile: selectedProfile, provider, capability, status, fromDay, toDay, offset }
    void revision
    const url = new URL(location.href)
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, String(value))
      else url.searchParams.delete(key)
    }
    window.history.replaceState(window.history.state, '', url)
    let active = true
    loading = true
    error = ''
    selected = ''
    detail = null
    void actions.getInvocations(query).then((result) => {
      if (active) history = result
    }).catch((caught) => {
      if (active) { history = null; error = caught instanceof Error ? caught.message : t('requestFailed') }
    }).finally(() => { if (active) loading = false })
    return () => { active = false }
  })

  function capabilityName(id: string) {
    const entry = snapshot.capabilities.find((entry) => entry.id === id)
    return entry ? capabilityText(language, entry).title : id
  }

  function errorSummary(value: unknown) {
    const entry = value && typeof value === 'object' ? value as { code?: unknown; message?: unknown } : null
    return invocationFailureSummary(language, typeof entry?.code === 'string' ? entry.code : '', typeof entry?.message === 'string' ? entry.message : t('failureReasonMissing'))
  }

  async function showDetail(jobId: string) {
    if (selected === jobId) { selected = ''; return }
    selected = jobId
    detail = null
    detailError = ''
    try {
      const result = await actions.getJob(jobId)
      if (selected === jobId) detail = result
    } catch (caught) {
      if (selected === jobId) detailError = caught instanceof Error ? caught.message : t('requestFailed')
    }
  }
</script>

<section class="page invocation-page" data-testid="invocations-view">
  <header class="analytics-header">
    <h1>{t('invocations')}</h1>
    <button class="button secondary" type="button" disabled={loading} onclick={() => revision++}><RefreshCw size={15} />{t('refresh')}</button>
  </header>

  <div class="invocation-filters" onchange={() => offset = 0}>
    <label><span>{t('provider')}</span><select aria-label={t('provider')} bind:value={provider}><option value="">{t('allProviders')}</option>{#each snapshot.providers as entry}<option value={entry.id}>{entry.label}</option>{/each}</select></label>
    <label><span>{t('capabilities')}</span><select aria-label={t('capabilities')} bind:value={capability}><option value="">{t('allCapabilities')}</option>{#each snapshot.capabilities as entry}<option value={entry.id}>{capabilityName(entry.id)}</option>{/each}</select></label>
    <label><span>{t('status')}</span><select aria-label={t('status')} bind:value={status}><option value="">{t('allStatuses')}</option>{#each ['queued', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled'] as entry}<option value={entry}>{stateLabel(language, entry)}</option>{/each}</select></label>
    <label><span>{t('fromDay')}</span><input aria-label={t('fromDay')} type="date" bind:value={fromDay} /></label>
    <label><span>{t('toDay')}</span><input aria-label={t('toDay')} type="date" bind:value={toDay} /></label>
  </div>

  {#if error}<p class="inline-feedback error" role="alert">{error}</p>{/if}
  {#if loading}<p role="status">{t('loading')}</p>{/if}
  {#if history}
    <div class="invocation-table-scroll" aria-busy={loading}>
      <table class="invocation-table">
        <thead><tr><th>{t('updated')}</th><th>{t('provider')}</th><th>{t('capabilities')}</th><th>{t('status')}</th><th>{t('details')}</th></tr></thead>
        <tbody>
          {#each history.jobs as job (job.jobId)}
            <tr class:expanded={selected === job.jobId}>
              <td><time>{formatTime(job.updatedAt, language)}</time></td>
              <td><ProviderIdentity provider={job.provider} label={snapshot.providers.find((entry) => entry.id === job.provider)?.label ?? job.provider} /></td>
              <td class="invocation-capabilities">{job.requestedCapabilities.length ? job.requestedCapabilities.map(capabilityName).join(' · ') : job.action}</td>
              <td><span class={`job-state ${job.status}`}></span>{stateLabel(language, job.status)}</td>
              <td><button class="button secondary" type="button" aria-expanded={selected === job.jobId} aria-controls={`invocation-${job.jobId}`} onclick={() => showDetail(job.jobId)}>{t('details')}</button></td>
            </tr>
            {#if selected === job.jobId}
              <tr><td colspan="5" class="invocation-expanded-cell">
                <section class="invocation-detail" id={`invocation-${job.jobId}`} aria-label={t('invocationDetails')}>
                  {#if job.status === 'failed'}<div class="invocation-error"><strong>{errorSummary(job.error)}</strong><p>{t('jobOutcomeHelp')}</p></div>{/if}
                  <dl class="invocation-metadata">
                    <div><dt>{t('jobId')}</dt><dd>{job.jobId}</dd></div>
                    <div><dt>{t('profile')}</dt><dd>{job.profileSlug ?? job.profileId ?? '—'}</dd></div>
                    <div><dt>{t('executionMode')}</dt><dd>{job.executionMode === 'browser' ? t('browserMode') : job.executionMode === 'direct' ? t('directMode') : '—'}</dd></div>
                    <div><dt>{t('created')}</dt><dd>{formatTime(job.createdAt, language)}</dd></div>
                    <div><dt>{t('submittedAt')}</dt><dd>{job.submittedAt ? formatTime(job.submittedAt, language) : '—'}</dd></div>
                    <div><dt>{t('updated')}</dt><dd>{formatTime(job.updatedAt, language)}</dd></div>
                  </dl>
                  <details><summary>{t('requestedActions')}</summary><p>{t('invocationRecordHelp')}</p><ol>{#each job.requestedActions as action}<li><code>{action}</code></li>{:else}<li>{job.action}</li>{/each}</ol></details>
                  {#if job.error || job.blocker}<details><summary>{t('error')}</summary><pre>{JSON.stringify(job.error ?? job.blocker, null, 2)}</pre></details>{/if}
                  {#if detailError}<p class="inline-feedback error" role="alert">{detailError}</p>
                  {:else if detail}
                    {#if detail.transcript.length}<details><summary>{t('conversationDetails')}</summary>{#each detail.transcript as message}<h3>{message.role === 'user' ? t('userPrompt') : t('assistantReply')}</h3><p class="invocation-message">{message.content}</p>{/each}</details>{/if}
                    {#if detail.result}<details><summary>{t('savedOutcome')}</summary><pre>{JSON.stringify(detail.result, null, 2)}</pre></details>{/if}
                  {:else}<p role="status">{t('loading')}</p>{/if}
                </section>
              </td></tr>
            {/if}
          {:else}<tr><td colspan="5" class="empty-state">{t('noResults')}</td></tr>{/each}
        </tbody>
      </table>
    </div>
    <nav class="invocation-pagination" aria-label={t('invocations')}>
      <button class="button secondary" type="button" disabled={loading || offset === 0} onclick={() => offset = Math.max(0, offset - 50)}>{t('previousPage')}</button>
      <span>{t('invocationPage', { page: Math.floor(offset / 50) + 1 })}</span>
      <button class="button secondary" type="button" disabled={loading || !history.hasMore} onclick={() => offset += 50}>{t('nextPage')}</button>
    </nav>
  {/if}
</section>
