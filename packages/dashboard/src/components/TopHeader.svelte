<script lang="ts">
  import { Calculator, Settings, UserRound } from '@lucide/svelte'
  import { formatNumber } from '../formatting.js'
  import { stateLabel, type MessageKey } from '../i18n/index.js'
  import type { DashboardSnapshot, Language } from '../types.js'

  let {
    snapshot,
    selectedProfile,
    language,
    t,
    onselect,
  }: {
    snapshot: DashboardSnapshot
    selectedProfile: string
    language: Language
    t: (key: MessageKey) => string
    onselect: (slug: string) => void
  } = $props()

  let waitingJobs = $derived(snapshot.jobs.filter((job) => job.status === 'waiting_for_user').length)
  let finishedJobs = $derived(snapshot.jobs.filter((job) => ['succeeded', 'failed', 'canceled'].includes(job.status)).length)
  let runtimeState = $derived(snapshot.runtime.status === 'running' && snapshot.runtime.activeJobCount === 0
    ? 'idle'
    : snapshot.runtime.status)
  let runtimeLabel = $derived(runtimeState === 'idle' ? t('idle') : stateLabel(language, runtimeState))
  let savingsEnabled = $derived(snapshot.outputSavings.enabled === true)
  let savingsReady = $derived(savingsEnabled && snapshot.outputSavings.collection === 'enabled')
  let savingsState = $derived(!savingsEnabled ? 'disabled' : savingsReady ? 'ready' : 'pending')
  let savingsTitle = $derived(!savingsEnabled
    ? t('savingsUnavailableTooltip')
    : !savingsReady
      ? t('tokenizerPreparesOnFirstResponse')
      : undefined)
</script>

<header class="top-header" data-testid="top-header">
  <div
    class:disabled={!savingsEnabled}
    class="top-header-savings"
    data-testid="overview-output-savings"
    data-state={savingsState}
    title={savingsTitle}
  >
    <a href={`/dashboard/system/?profile=${encodeURIComponent(selectedProfile)}`} aria-label={t('manageOutputSavings')} data-dashboard-section="system">
      <span class="top-header-icon dark"><Calculator size={17} /></span>
      <span class="top-header-value" data-testid="header-tokens-saved">
        <strong>{savingsReady ? formatNumber(snapshot.outputSavings.summary.estimatedOutputTokens, language) : '—'}</strong>
        <small>{t('tokensSavedShort')}</small>
      </span>
      <span class="top-header-detail">
        {#if !savingsEnabled}
          {t('savingsSummaryUnavailable')} {t('turnOnToReview')}
        {:else if !savingsReady}
          {t('tokenizerPreparesOnFirstResponse')}
        {:else}
          {formatNumber(snapshot.outputSavings.summary.responseCount, language)} {t('measuredResponses')}
        {/if}
      </span>
    </a>
  </div>

  <a class="top-header-jobs" href={`/dashboard/jobs/?profile=${encodeURIComponent(selectedProfile)}`} data-dashboard-section="jobs">
    <span class:ok={snapshot.runtime.status === 'running'} class="status-dot"></span>
    <span class="top-header-runtime">
      <small>{t('runtime')}</small>
      <strong data-testid="header-runtime-status" data-state={runtimeState}>{runtimeLabel}</strong>
    </span>
    <span class="top-header-job-count"><strong>{formatNumber(snapshot.runtime.activeJobCount, language)}</strong><small>{t('activeUnit')}</small></span>
    <span class="top-header-job-count"><strong>{formatNumber(waitingJobs, language)}</strong><small>{t('waitingJobs')}</small></span>
    <span class="top-header-job-count" data-testid="header-finished-jobs"><strong>{formatNumber(finishedJobs, language)}</strong><small>{t('finishedJobs')}</small></span>
  </a>

  <div class="top-header-actions">
    <label class="top-header-profile">
      <span class="top-header-icon"><UserRound size={16} /></span>
      <span class="top-header-control-copy">
        <small>{formatNumber(snapshot.profiles.length, language)} {t('profiles')}</small>
        <select
          name="activeProfile"
          value={selectedProfile}
          aria-label={t('selectProfile')}
          data-testid="header-profile"
          onchange={(event) => onselect(event.currentTarget.value)}
        >
          {#each snapshot.profiles as profile (profile.slug)}
            <option value={profile.slug}>{profile.slug}</option>
          {/each}
        </select>
      </span>
    </label>

    <a class="top-header-settings" href={`/dashboard/system/?profile=${encodeURIComponent(selectedProfile)}`} aria-label={`${t('system')} · ${t('version')} ${snapshot.daemon.version}`} data-dashboard-section="system">
      <span class="top-header-icon"><Settings size={16} /></span>
      <span>
        <small>{t('system')}</small>
        <strong translate="no">v{snapshot.daemon.version}</strong>
      </span>
    </a>
  </div>
</header>
