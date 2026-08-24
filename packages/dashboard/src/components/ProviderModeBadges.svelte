<script lang="ts">
  import { ExternalLink, Link2, Monitor } from '@lucide/svelte'
  import type { MessageKey } from '../i18n/index.js'
  import type { DashboardProvider, DashboardProviderExecutionMode, DashboardProviderProfileState } from '../types.js'

  let { provider, state, t }: {
    provider: DashboardProvider
    state: DashboardProviderProfileState | undefined
    t: (key: MessageKey) => string
  } = $props()

  const modes: readonly DashboardProviderExecutionMode[] = ['browser', 'direct']

  function supported(mode: DashboardProviderExecutionMode) {
    return provider.executionModes.includes(mode)
  }

  function configured(mode: DashboardProviderExecutionMode) {
    return state?.enabled === true && state.enabledModes.includes(mode)
  }

  function status(mode: DashboardProviderExecutionMode) {
    return !supported(mode) ? t('notSupported') : configured(mode) ? t('configured') : t('notConfigured')
  }

  function modeLabel(mode: DashboardProviderExecutionMode) {
    return mode === 'browser' ? t('browserMode') : t('directMode')
  }

  function tooltip(mode: DashboardProviderExecutionMode) {
    const help = !supported(mode)
      ? t('modeUnsupportedHelp')
      : mode === 'browser'
        ? t('browserModeHelp')
        : t('directModeHelp')
    return `${provider.label} · ${modeLabel(mode)} · ${status(mode)} · ${help}`
  }

  function accessibleLabel(mode: DashboardProviderExecutionMode, url: string) {
    return `${tooltip(mode)} · ${t('entryUrl')}: ${url}`
  }
</script>

<span class="provider-mode-badges" data-testid={`provider-mode-badges-${provider.id}`}>
  {#each modes as mode (mode)}
    {@const entryUrl = provider.entryUrls[mode]}
    {#if entryUrl}
      <a
        class="provider-mode-tooltip hover-tooltip"
        href={entryUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={accessibleLabel(mode, entryUrl)}
        data-mode={mode}
        data-testid={`provider-mode-entry-${provider.id}-${mode}`}
      >
        <span class:configured={configured(mode)} class="provider-mode-badge" aria-hidden="true">
          {#if mode === 'browser'}<Monitor size={12} />{:else}<Link2 size={12} />{/if}
          <span>{modeLabel(mode)}</span>
        </span>
        <span class="hover-tooltip-content provider-mode-entry-tooltip" aria-hidden="true">
          <span>{tooltip(mode)}</span>
          <span class="provider-mode-entry-url" translate="no"><ExternalLink size={12} />{entryUrl}</span>
        </span>
      </a>
    {:else}
      <span class="provider-mode-tooltip hover-tooltip">
        <span class:configured={configured(mode)} class:unsupported={!supported(mode)} class="provider-mode-badge" aria-label={tooltip(mode)} data-mode={mode}>
          {#if mode === 'browser'}<Monitor size={12} />{:else}<Link2 size={12} />{/if}
          <span>{modeLabel(mode)}</span>
        </span>
        <span class="hover-tooltip-content" aria-hidden="true">{tooltip(mode)}</span>
      </span>
    {/if}
  {/each}
</span>
