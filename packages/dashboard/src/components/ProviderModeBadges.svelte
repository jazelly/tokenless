<script lang="ts">
  import { Link2, Monitor } from '@lucide/svelte'
  import type { MessageKey } from '../i18n/index.js'
  import type { DashboardProvider, DashboardProviderExecutionMode, DashboardProviderProfileState } from '../types.js'

  let { provider, state, t }: {
    provider: DashboardProvider
    state: DashboardProviderProfileState | undefined
    t: (key: MessageKey) => string
  } = $props()

  function supported(mode: DashboardProviderExecutionMode) {
    return provider.executionModes.includes(mode)
  }

  function configured(mode: DashboardProviderExecutionMode) {
    return state?.enabled === true && state.enabledModes.includes(mode)
  }

  function status(mode: DashboardProviderExecutionMode) {
    return !supported(mode) ? t('notSupported') : configured(mode) ? t('configured') : t('notConfigured')
  }

  function tooltip(mode: DashboardProviderExecutionMode) {
    const modeLabel = mode === 'browser' ? t('browserMode') : t('directMode')
    const help = !supported(mode)
      ? t('modeUnsupportedHelp')
      : mode === 'browser'
        ? t('browserModeHelp')
        : t('directModeHelp')
    return `${provider.label} · ${modeLabel} · ${status(mode)} · ${help}`
  }
</script>

<span class="provider-mode-badges" data-testid={`provider-mode-badges-${provider.id}`}>
  <span class="provider-mode-tooltip hover-tooltip">
    <span class:configured={configured('browser')} class:unsupported={!supported('browser')} class="provider-mode-badge" aria-label={tooltip('browser')} data-mode="browser"><Monitor size={12} /><span>{t('browserMode')}</span></span>
    <span class="hover-tooltip-content" aria-hidden="true">{tooltip('browser')}</span>
  </span>
  <span class="provider-mode-tooltip hover-tooltip">
    <span class:configured={configured('direct')} class:unsupported={!supported('direct')} class="provider-mode-badge" aria-label={tooltip('direct')} data-mode="direct"><Link2 size={12} /><span>{t('directMode')}</span></span>
    <span class="hover-tooltip-content" aria-hidden="true">{tooltip('direct')}</span>
  </span>
</span>
