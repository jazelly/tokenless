<script lang="ts">
  import { ExternalLink, RefreshCw, ScanSearch } from '@lucide/svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { stateLabel, type MessageKey } from '../localization.js'
  import type { JsonRecord, Language } from '../types.js'

  let { snapshot, selectedProfile, language, t, busy, onselect, onmutate }: {
    snapshot: JsonRecord
    selectedProfile: string
    language: Language
    t: (key: MessageKey) => string
    busy: boolean
    onselect: (slug: string) => void
    onmutate: (path: string, body?: unknown, method?: string, announce?: boolean) => Promise<unknown>
  } = $props()

  let profile = $derived(snapshot.profiles.find((entry: JsonRecord) => entry.slug === selectedProfile) ?? snapshot.profiles[0])

  function stateFor(provider: JsonRecord) {
    return provider.profiles?.find((entry: JsonRecord) => entry.profileId === profile?.slug)
  }

  async function toggle(provider: JsonRecord, input: HTMLInputElement) {
    const enabled = input.checked
    const next = new Set<string>(profile.enabledProviders)
    if (enabled) next.add(provider.id)
    else next.delete(provider.id)
    try {
      await onmutate(`/profiles/${encodeURIComponent(profile.slug)}`, { enabledProviders: [...next] }, 'PATCH')
    } catch {
      input.checked = !enabled
    }
  }

  async function choose(provider: JsonRecord, kind: 'model' | 'effort', label: string) {
    if (!label) return
    try {
      await onmutate(`/profiles/${encodeURIComponent(profile.slug)}/providers/${encodeURIComponent(provider.id)}/selection`, { kind, label }, 'POST', false)
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function action(provider: JsonRecord, value: 'open' | 'readiness' | 'controls') {
    try {
      await onmutate(`/profiles/${encodeURIComponent(profile.slug)}/providers/${encodeURIComponent(provider.id)}/actions/${value}`, undefined, 'POST', false)
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }
</script>

<section class="page" data-testid="providers-view">
  <PageHeader title={t('providers')} description={t('providersLede')}>
    {#snippet actions()}
      <label class="inline-select">
        <span class="sr-only">{t('selectProfile')}</span>
        <select name="providerProfile" value={profile?.slug} onchange={(event) => onselect(event.currentTarget.value)} data-testid="provider-profile">
          {#each snapshot.profiles as entry}<option value={entry.slug}>{entry.label}</option>{/each}
        </select>
      </label>
    {/snippet}
  </PageHeader>

  <div class="provider-card-grid">
    {#each snapshot.providers as provider (provider.id)}
      {@const state = stateFor(provider)}
      <article class:disabled={!state?.enabled} class="provider-card">
        <header>
          <span class="provider-glyph large">{provider.label.slice(0, 1)}</span>
          <div><h2>{provider.label}</h2><p translate="no">{provider.id}</p></div>
          <label class="switch" title={state?.enabled ? t('enabled') : t('disabled')}>
            <input name={`provider-${provider.id}`} type="checkbox" checked={state?.enabled === true} disabled={busy} onchange={(event) => toggle(provider, event.currentTarget)} data-testid={`provider-toggle-${provider.id}`} />
            <span></span>
          </label>
        </header>
        <div class="provider-account">
          <span>{t('account')}</span>
          <strong>{state?.observation?.account?.name ?? (state?.observation?.access ? stateLabel(language, state.observation.access) : t('neverChecked'))}</strong>
        </div>
        {#if state?.controls?.model?.length}
          <label class="field compact-field"><span>{t('model')}</span><select name={`${provider.id}-model`} disabled={!state.enabled || busy} onchange={(event) => choose(provider, 'model', event.currentTarget.value)}>{#each state.controls.model as choice}<option value={choice.label} selected={choice.selected} disabled={!choice.enabled} translate="no">{choice.label}</option>{/each}</select></label>
        {/if}
        {#if state?.controls?.effort?.length}
          <label class="field compact-field"><span>{t('effort')}</span><select name={`${provider.id}-effort`} disabled={!state.enabled || busy} onchange={(event) => choose(provider, 'effort', event.currentTarget.value)}>{#each state.controls.effort as choice}<option value={choice.label} selected={choice.selected} disabled={!choice.enabled} translate="no">{choice.label}</option>{/each}</select></label>
        {/if}
        <div class="provider-meta"><span class:ok={state?.runtimeEligibility === 'eligible'} class="status-dot"></span><span>{stateLabel(language, state?.runtimeEligibility ?? 'ineligible')}</span><span class="spacer"></span><span>{stateLabel(language, provider.stage)}</span></div>
        <footer>
          <button class="icon-button" type="button" disabled={!state?.enabled || busy} aria-label={t('open')} title={t('open')} onclick={() => action(provider, 'open')}><ExternalLink size={16} /></button>
          <button class="icon-button" type="button" disabled={!state?.enabled || busy} aria-label={t('checkNow')} title={t('checkNow')} onclick={() => action(provider, 'readiness')}><RefreshCw size={16} /></button>
          <button class="icon-button" type="button" disabled={!state?.enabled || busy} aria-label={t('inspectControls')} title={t('inspectControls')} onclick={() => action(provider, 'controls')}><ScanSearch size={16} /></button>
        </footer>
      </article>
    {/each}
  </div>
</section>
