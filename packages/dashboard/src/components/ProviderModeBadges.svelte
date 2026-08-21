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
</script>

<span class="provider-mode-badges" data-testid={`provider-mode-badges-${provider.id}`}>
  <span class:configured={configured('browser')} class:unsupported={!supported('browser')} class="provider-mode-badge" title={`${t('browserMode')} · ${status('browser')}`} aria-label={`${t('browserMode')} · ${status('browser')}`} data-mode="browser"><Monitor size={12} /><span>{t('browserMode')}</span></span>
  <span class:configured={configured('direct')} class:unsupported={!supported('direct')} class="provider-mode-badge" title={`${t('directMode')} · ${status('direct')}`} aria-label={`${t('directMode')} · ${status('direct')}`} data-mode="direct"><Link2 size={12} /><span>{t('directMode')}</span></span>
</span>
