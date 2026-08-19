<script lang="ts">
  import { ArrowLeft, ExternalLink, Link2, Monitor, RefreshCw, ScanSearch } from '@lucide/svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import ProviderModeBadges from '../components/ProviderModeBadges.svelte'
  import { stateLabel, type MessageKey } from '../i18n/index.js'
  import RoutingView from './RoutingView.svelte'
  import type { DashboardActions, Language, UiProvider, UiProviderExecutionMode, UiSnapshot } from '../types.js'

  let { snapshot, selectedProfile, language, t, busy, onselect, actions }: {
    snapshot: UiSnapshot
    selectedProfile: string
    language: Language
    t: (key: MessageKey) => string
    busy: boolean
    onselect: (slug: string) => void
    actions: DashboardActions
  } = $props()

  let selectedProviderId = $state('')
  let routingRole = $state('')
  let roleError = $state('')
  let profile = $derived(snapshot.profiles.find((entry) => entry.slug === selectedProfile) ?? snapshot.profiles[0]!)
  let detailProvider = $derived(snapshot.providers.find((provider) => provider.id === selectedProviderId))

  function stateFor(provider: UiProvider) {
    return provider.profiles.find((entry) => entry.profileId === profile.slug)
  }

  function directOnly(provider: UiProvider) {
    return provider.executionModes.length === 1 && provider.executionModes[0] === 'direct'
  }

  function routingRoleFor(providerId: string) {
    return snapshot.config.router.providers.find((candidate) => candidate.id === providerId)?.suitableTasks ?? ''
  }

  function openDetails(provider: UiProvider) {
    selectedProviderId = provider.id
    routingRole = routingRoleFor(provider.id)
    roleError = ''
  }

  function closeDetails() {
    selectedProviderId = ''
    routingRole = ''
    roleError = ''
  }

  async function toggle(provider: UiProvider, input: HTMLInputElement) {
    const enabled = input.checked
    const next = new Set<string>(profile.enabledProviders)
    if (enabled) next.add(provider.id)
    else next.delete(provider.id)
    try {
      await actions.updateProfile(profile.slug, { enabledProviders: [...next] })
    } catch {
      input.checked = !enabled
    }
  }

  async function toggleMode(provider: UiProvider, mode: UiProviderExecutionMode, input: HTMLInputElement) {
    const enabled = input.checked
    const modes = new Set(profile.providerModes[provider.id] ?? [])
    if (enabled) modes.add(mode)
    else modes.delete(mode)
    try {
      await actions.updateProfile(profile.slug, { providerModes: { ...profile.providerModes, [provider.id]: [...modes] } })
    } catch {
      input.checked = !enabled
    }
  }

  async function choose(provider: UiProvider, kind: 'model' | 'effort', label: string) {
    if (!label) return
    try {
      await actions.selectProviderControl(profile.slug, provider.id, { kind, label }, false)
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function action(provider: UiProvider, value: 'open' | 'readiness' | 'controls') {
    try {
      await actions.runProviderAction(profile.slug, provider.id, value, false)
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function saveRoutingRole(event: SubmitEvent, provider: UiProvider) {
    event.preventDefault()
    if (stateFor(provider)?.enabled !== true) return
    roleError = ''
    const router = snapshot.config.router
    const currentRules = router.providers
    const nextRole = routingRole.trim()
    let replaced = false
    const providers = currentRules.flatMap((rule) => {
      if (rule.id !== provider.id) return [{ id: rule.id, suitableTasks: rule.suitableTasks }]
      replaced = true
      return nextRole ? [{ id: provider.id, suitableTasks: nextRole }] : []
    })
    if (!replaced && nextRole) providers.push({ id: provider.id, suitableTasks: nextRole })
    try {
      await actions.updateConfig({
        router: {
          enabled: router.enabled,
          engine: router.engine,
          providers,
        },
      })
      routingRole = nextRole
    } catch (error) {
      roleError = error instanceof Error ? error.message : t('requestFailed')
    }
  }
</script>

{#if detailProvider}
  {@const state = stateFor(detailProvider)}
  <section class="page provider-detail-page" data-testid={`provider-detail-${detailProvider.id}`}>
    <button class="text-button provider-back" type="button" onclick={closeDetails} data-testid="provider-detail-back"><ArrowLeft size={15} />{t('back')}</button>
    <PageHeader title={detailProvider.label} description={directOnly(detailProvider) ? t('directOnlyProvider') : t('providerDetailLede')}>
      {#snippet actions()}
        <label class="switch" title={state?.enabled ? t('enabled') : t('disabled')}>
          <input name={`provider-detail-${detailProvider.id}`} type="checkbox" checked={state?.enabled === true} disabled={busy} onchange={(event) => toggle(detailProvider, event.currentTarget)} data-testid={`provider-detail-toggle-${detailProvider.id}`} />
          <span></span>
        </label>
      {/snippet}
    </PageHeader>

    <section class:disabled={!state?.enabled} class="settings-section system-card provider-detail-controls" data-testid="provider-detail-controls">
      <div class="settings-section-title"><div><h2>{t('providerConfiguration')}</h2><p translate="no">{detailProvider.id}</p></div></div>
      <div class="provider-mode-settings" data-testid={`provider-detail-modes-${detailProvider.id}`}>
        <div class="provider-mode-setting" class:unsupported={!detailProvider.executionModes.includes('browser')}>
          <span class="provider-mode-icon"><Monitor size={16} /></span>
          <span class="provider-mode-copy"><strong>{t('browserMode')}</strong><small>{detailProvider.executionModes.includes('browser') ? t('browserModeHelp') : t('modeUnsupportedHelp')}</small></span>
          <label class="switch" title={state?.enabledModes.includes('browser') ? t('configured') : t('notConfigured')}><input name={`provider-browser-${detailProvider.id}`} type="checkbox" checked={state?.enabledModes.includes('browser') === true} disabled={busy || state?.enabled !== true || !detailProvider.executionModes.includes('browser')} onchange={(event) => toggleMode(detailProvider, 'browser', event.currentTarget)} data-testid={`provider-mode-toggle-browser-${detailProvider.id}`} /><span></span></label>
        </div>
        <div class="provider-mode-setting" class:unsupported={!detailProvider.executionModes.includes('direct')}>
          <span class="provider-mode-icon"><Link2 size={16} /></span>
          <span class="provider-mode-copy"><strong>{t('directMode')}</strong><small>{detailProvider.executionModes.includes('direct') ? t('directModeHelp') : t('modeUnsupportedHelp')}</small></span>
          <label class="switch" title={state?.enabledModes.includes('direct') ? t('configured') : t('notConfigured')}><input name={`provider-direct-${detailProvider.id}`} type="checkbox" checked={state?.enabledModes.includes('direct') === true} disabled={busy || state?.enabled !== true || !detailProvider.executionModes.includes('direct')} onchange={(event) => toggleMode(detailProvider, 'direct', event.currentTarget)} data-testid={`provider-mode-toggle-direct-${detailProvider.id}`} /><span></span></label>
        </div>
      </div>
      {#if !directOnly(detailProvider)}
        <div class="provider-account">
          <span>{t('account')}</span>
          <strong>{state?.observation?.account?.name ?? (state?.observation?.access ? stateLabel(language, state.observation.access) : t('neverChecked'))}</strong>
        </div>
        <div class="provider-detail-selections">
          {#if state?.controls?.model?.length}
            <label class="field"><span>{t('model')}</span><select name={`${detailProvider.id}-detail-model`} disabled={!state.enabled || busy} onchange={(event) => choose(detailProvider, 'model', event.currentTarget.value)} data-testid={`provider-detail-model-${detailProvider.id}`}>{#each state.controls.model as choice}<option value={choice.label} selected={choice.selected} disabled={!choice.enabled} translate="no">{choice.label}</option>{/each}</select></label>
          {/if}
          {#if state?.controls?.effort?.length}
            <label class="field"><span>{t('effort')}</span><select name={`${detailProvider.id}-detail-effort`} disabled={!state.enabled || busy} onchange={(event) => choose(detailProvider, 'effort', event.currentTarget.value)} data-testid={`provider-detail-effort-${detailProvider.id}`}>{#each state.controls.effort as choice}<option value={choice.label} selected={choice.selected} disabled={!choice.enabled} translate="no">{choice.label}</option>{/each}</select></label>
          {/if}
        </div>
      {/if}
      {#if directOnly(detailProvider)}
        <div class="provider-meta"><span>{stateLabel(language, detailProvider.stage)}</span></div>
      {:else}
        <div class="provider-meta"><span class:ok={state?.runtimeEligibility === 'eligible'} class="status-dot"></span><span>{stateLabel(language, state?.runtimeEligibility ?? 'ineligible')}</span><span class="spacer"></span><span>{stateLabel(language, detailProvider.stage)}</span></div>
      {/if}
      {#if !directOnly(detailProvider)}
        <div class="provider-detail-actions">
          <button class="button secondary icon-label" type="button" disabled={!state?.enabled || busy} onclick={() => action(detailProvider, 'open')} data-testid={`provider-detail-open-${detailProvider.id}`}><ExternalLink size={16} />{t('open')}</button>
          <button class="button secondary icon-label" type="button" disabled={!state?.enabled || busy} onclick={() => action(detailProvider, 'readiness')} data-testid={`provider-detail-readiness-${detailProvider.id}`}><RefreshCw size={16} />{t('checkNow')}</button>
          <button class="button secondary icon-label" type="button" disabled={!state?.enabled || busy} onclick={() => action(detailProvider, 'controls')} data-testid={`provider-detail-controls-${detailProvider.id}`}><ScanSearch size={16} />{t('inspectControls')}</button>
        </div>
      {/if}
    </section>

    {#if !directOnly(detailProvider)}
      <form class="settings-section system-card provider-role-card" onsubmit={(event) => saveRoutingRole(event, detailProvider)} data-testid={`provider-role-form-${detailProvider.id}`}>
        <div class="settings-section-title"><div><h2>{t('providerRoutingRole')}</h2><p>{t('providerRoutingRoleHelp')}</p></div></div>
        <label class="field router-tasks-field"><span>{t('suitableTasks')}</span><textarea bind:value={routingRole} disabled={state?.enabled !== true || busy} maxlength="500" placeholder={t('providerSuitableTasksPlaceholder')} data-testid={`provider-role-${detailProvider.id}`}></textarea></label>
        {#if state?.enabled !== true}<div class="inline-feedback warning" data-testid="provider-role-disabled">{t('providerRoleDisabled')}</div>{/if}
        {#if roleError}<div class="inline-feedback error" role="alert">{roleError}</div>{/if}
        <div class="form-actions"><button class="button primary" type="submit" disabled={state?.enabled !== true || busy} data-testid={`provider-role-save-${detailProvider.id}`}>{t('save')}</button></div>
      </form>
    {/if}
  </section>
{:else}
  <section class="page" data-testid="providers-view">
    <PageHeader title={t('providers')} description={t('providersLede')}>
      {#snippet actions()}
        <label class="inline-select">
          <span class="sr-only">{t('selectProfile')}</span>
          <select name="providerProfile" value={profile?.slug} onchange={(event) => onselect(event.currentTarget.value)} data-testid="provider-profile">
            {#each snapshot.profiles as entry}<option value={entry.slug}>{entry.slug}</option>{/each}
          </select>
        </label>
      {/snippet}
    </PageHeader>

    <div class="provider-card-grid">
      {#each snapshot.providers as provider (provider.id)}
        {@const state = stateFor(provider)}
        <article class:disabled={!state?.enabled} class="provider-card" data-testid={`provider-card-${provider.id}`}>
          <header>
            <span class="provider-glyph large">{provider.label.slice(0, 1)}</span>
            <div><span class="provider-name-line"><h2>{provider.label}</h2><ProviderModeBadges {provider} {state} {t} /></span><p translate="no">{provider.id}</p></div>
            <label class="switch" title={state?.enabled ? t('enabled') : t('disabled')}>
              <input name={`provider-${provider.id}`} type="checkbox" checked={state?.enabled === true} disabled={busy} onchange={(event) => toggle(provider, event.currentTarget)} data-testid={`provider-toggle-${provider.id}`} />
              <span></span>
            </label>
          </header>
          {#if !directOnly(provider)}
            <div class="provider-account">
              <span>{t('account')}</span>
              <strong>{state?.observation?.account?.name ?? (state?.observation?.access ? stateLabel(language, state.observation.access) : t('neverChecked'))}</strong>
            </div>
            {#if state?.controls?.model?.length}
              <label class="field compact-field"><span>{t('model')}</span><select name={`${provider.id}-model`} disabled={!state.enabled || busy} onchange={(event) => choose(provider, 'model', event.currentTarget.value)} data-testid={`provider-model-${provider.id}`}>{#each state.controls.model as choice}<option value={choice.label} selected={choice.selected} disabled={!choice.enabled} translate="no">{choice.label}</option>{/each}</select></label>
            {/if}
            {#if state?.controls?.effort?.length}
              <label class="field compact-field"><span>{t('effort')}</span><select name={`${provider.id}-effort`} disabled={!state.enabled || busy} onchange={(event) => choose(provider, 'effort', event.currentTarget.value)} data-testid={`provider-effort-${provider.id}`}>{#each state.controls.effort as choice}<option value={choice.label} selected={choice.selected} disabled={!choice.enabled} translate="no">{choice.label}</option>{/each}</select></label>
            {/if}
            <div class="provider-routing-summary"><span>{t('providerRoutingRole')}</span><strong>{routingRoleFor(provider.id) || t('notConfigured')}</strong></div>
          {/if}
          {#if directOnly(provider)}
            <div class="provider-meta"><span>{stateLabel(language, provider.stage)}</span></div>
          {:else}
            <div class="provider-meta"><span class:ok={state?.runtimeEligibility === 'eligible'} class="status-dot"></span><span>{stateLabel(language, state?.runtimeEligibility ?? 'ineligible')}</span><span class="spacer"></span><span>{stateLabel(language, provider.stage)}</span></div>
          {/if}
          <footer>
            {#if !directOnly(provider)}
              <button class="icon-button" type="button" disabled={!state?.enabled || busy} aria-label={t('open')} title={t('open')} onclick={() => action(provider, 'open')} data-testid={`provider-open-${provider.id}`}><ExternalLink size={16} /></button>
              <button class="icon-button" type="button" disabled={!state?.enabled || busy} aria-label={t('checkNow')} title={t('checkNow')} onclick={() => action(provider, 'readiness')} data-testid={`provider-readiness-${provider.id}`}><RefreshCw size={16} /></button>
              <button class="icon-button" type="button" disabled={!state?.enabled || busy} aria-label={t('inspectControls')} title={t('inspectControls')} onclick={() => action(provider, 'controls')} data-testid={`provider-controls-${provider.id}`}><ScanSearch size={16} /></button>
            {/if}
            <button class="button secondary" type="button" onclick={() => openDetails(provider)} data-testid={`provider-details-${provider.id}`}>{t('details')}</button>
          </footer>
        </article>
      {/each}
    </div>

    <RoutingView {snapshot} {selectedProfile} {t} {busy} {actions} />
  </section>
{/if}
