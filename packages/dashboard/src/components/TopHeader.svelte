<script lang="ts">
  import { Activity, CircleCheck, Hand, Play } from '@lucide/svelte'
  import TokenIcon from './TokenIcon.svelte'
  import ProfileSwitcher from './ProfileSwitcher.svelte'
  import QuickSettings from './QuickSettings.svelte'
  import { formatNumber } from '../formatting.js'
  import { stateLabel, type MessageKey } from '../i18n/index.js'
  import type { DashboardActions, DashboardSnapshot, Language } from '../types.js'

  let {
    snapshot,
    selectedProfile,
    language,
    busy,
    actions,
    t,
    onselect,
  }: {
    snapshot: DashboardSnapshot
    selectedProfile: string
    language: Language
    busy: boolean
    actions: DashboardActions
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
  let savingsValue = $derived(savingsReady ? formatNumber(snapshot.outputSavings.summary.estimatedOutputTokens, language) : '—')
  let savingsHelp = $derived(!savingsEnabled
    ? t('savingsUnavailableTooltip')
    : !savingsReady
      ? t('tokenizerPreparesOnFirstResponse')
      : `${t('estimatedTokensSaved')}: ${savingsValue} tokens · ${t('measuredResponses')}: ${formatNumber(snapshot.outputSavings.summary.responseCount, language)}`)
  let jobsHelp = $derived(`${t('runtime')}: ${runtimeLabel} · ${formatNumber(snapshot.runtime.activeJobCount, language)} ${t('activeUnit')} · ${t('waitingJobs')}: ${formatNumber(waitingJobs, language)} · ${t('finishedJobs')}: ${formatNumber(finishedJobs, language)}`)

  async function changeLanguage(next: Language) {
    await actions.updateConfig({ language: next })
  }

  async function toggleOutputSavings() {
    if (snapshot.outputSavings.enabled) await actions.disableOutputSavings()
    else await actions.enableOutputSavings()
  }
</script>

<header class="top-header" data-testid="top-header">
  <div
    class:disabled={!savingsEnabled}
    class="top-header-savings"
    data-testid="overview-output-savings"
    data-state={savingsState}
  >
    <a class="top-header-control hover-tooltip tooltip-below" href={`/dashboard/system/?profile=${encodeURIComponent(selectedProfile)}`} aria-label={`${savingsHelp} · ${t('manageOutputSavings')}`} data-dashboard-section="system">
      <TokenIcon size={18} />
      <strong class="top-header-value" data-testid="header-tokens-saved">{savingsValue}</strong>
      <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{savingsHelp}</span>
    </a>
  </div>

  <div class="top-header-jobs">
    <a class="top-header-control top-header-runtime hover-tooltip tooltip-below" class:running={snapshot.runtime.status === 'running'} href={`/dashboard/jobs/?profile=${encodeURIComponent(selectedProfile)}`} aria-label={jobsHelp} data-dashboard-section="jobs">
      <Activity size={16} aria-hidden="true" />
      <strong data-testid="header-runtime-status" data-state={runtimeState}>{runtimeLabel}</strong>
      <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{jobsHelp}</span>
    </a>
    <a class="top-header-control hover-tooltip tooltip-below" href={`/dashboard/jobs/?profile=${encodeURIComponent(selectedProfile)}`} aria-label={`${formatNumber(snapshot.runtime.activeJobCount, language)} ${t('activeUnit')}`} data-dashboard-section="jobs">
      <Play size={16} aria-hidden="true" /><strong>{formatNumber(snapshot.runtime.activeJobCount, language)}</strong>
      <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{formatNumber(snapshot.runtime.activeJobCount, language)} {t('activeUnit')}</span>
    </a>
    <a class="top-header-control top-header-secondary hover-tooltip tooltip-below" href={`/dashboard/jobs/?profile=${encodeURIComponent(selectedProfile)}`} aria-label={`${t('waitingJobs')}: ${formatNumber(waitingJobs, language)}`} data-dashboard-section="jobs">
      <Hand size={16} aria-hidden="true" /><strong>{formatNumber(waitingJobs, language)}</strong>
      <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{t('waitingJobs')}</span>
    </a>
    <a class="top-header-control top-header-secondary hover-tooltip tooltip-below" href={`/dashboard/jobs/?profile=${encodeURIComponent(selectedProfile)}`} aria-label={`${t('finishedJobs')}: ${formatNumber(finishedJobs, language)}`} data-dashboard-section="jobs" data-testid="header-finished-jobs">
      <CircleCheck size={16} aria-hidden="true" /><strong>{formatNumber(finishedJobs, language)}</strong>
      <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{t('finishedJobs')}</span>
    </a>
  </div>

  <div class="top-header-actions">
    <ProfileSwitcher
      profiles={snapshot.profiles.map((profile) => ({ slug: profile.slug, label: profile.slug, description: profile.roleLabel }))}
      value={selectedProfile}
      label={t('selectProfile')}
      countLabel={`${formatNumber(snapshot.profiles.length, language)} ${t('profiles')}`}
      {onselect}
    />

    <QuickSettings
      {language}
      outputSavingsEnabled={snapshot.outputSavings.enabled}
      {busy}
      {t}
      onlanguage={changeLanguage}
      ontoggleoutputsavings={toggleOutputSavings}
    />
  </div>
</header>
