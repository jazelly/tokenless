<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { MessageKey } from '../localization.js'
  import type { JsonRecord } from '../types.js'

  let {
    snapshot,
    profile,
    t,
    busy,
    oncancel,
    onsubmit,
  }: {
    snapshot: JsonRecord
    profile?: JsonRecord
    t: (key: MessageKey) => string
    busy: boolean
    oncancel: () => void
    onsubmit: (value: JsonRecord) => Promise<void>
  } = $props()

  let slug = $state(untrack(() => profile?.slug ?? ''))
  let label = $state(untrack(() => profile?.label ?? ''))
  let roleLabel = $state(untrack(() => profile?.roleLabel ?? ''))
  let enabledProviders = $state<string[]>(untrack(() => Array.isArray(profile?.enabledProviders)
    ? [...profile.enabledProviders]
    : snapshot.providers.filter((provider: JsonRecord) => provider.stage !== 'disabled').map((provider: JsonRecord) => provider.id)))
  let error = $state('')
  let errorElement = $state<HTMLDivElement>()

  function toggleProvider(provider: string, checked: boolean) {
    enabledProviders = checked
      ? [...new Set([...enabledProviders, provider])]
      : enabledProviders.filter((entry) => entry !== provider)
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    error = ''
    try {
      await onsubmit({
        ...(!profile ? { slug } : {}),
        label,
        roleLabel,
        browserVisibility: 'headed',
        enabledProviders,
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : t('requestFailed')
      await tick()
      errorElement?.focus()
    }
  }
</script>

<form class="form-stack" onsubmit={submit} data-testid="profile-form">
  {#if !profile}
    <label class="field">
      <span>{t('slug')} <small>{t('required')}</small></span>
      <input name="slug" bind:value={slug} required pattern={'[a-z0-9](?:[a-z0-9]|-){0,63}'} autocomplete="off" data-testid="profile-slug" />
    </label>
  {/if}
  <label class="field">
    <span>{t('label')} <small>{t('required')}</small></span>
    <input name="label" bind:value={label} required maxlength="80" autocomplete="off" data-testid="profile-label" />
  </label>
  <label class="field">
    <span>{t('role')} <small>{t('optional')}</small></span>
    <input name="roleLabel" bind:value={roleLabel} maxlength="80" autocomplete="off" data-testid="profile-role" />
  </label>

  <div class="field read-only-field"><span>{t('profileBrowser')}</span><strong>Native {snapshot.config.browser === 'brave' ? t('braveBrowser') : t('googleChrome')} · headed</strong></div>

  <fieldset class="fieldset">
    <legend>{t('providerAccess')}</legend>
    <div class="provider-pills" data-testid="profile-providers">
      {#each snapshot.providers as provider (provider.id)}
        <label class:checked={enabledProviders.includes(provider.id)} class="provider-pill">
          <input
            type="checkbox"
            name="enabledProviders"
            value={provider.id}
            checked={enabledProviders.includes(provider.id)}
            onchange={(event) => toggleProvider(provider.id, event.currentTarget.checked)}
          />
          <span>{provider.label}</span>
        </label>
      {/each}
    </div>
  </fieldset>

  {#if error}<div bind:this={errorElement} class="inline-feedback error" role="alert" tabindex="-1" data-testid="profile-form-error"><span>{error}</span></div>{/if}

  <div class="form-actions">
    <button class="button secondary" type="button" onclick={oncancel}>{t('cancel')}</button>
    <button class="button primary" type="submit" disabled={busy} data-testid="profile-submit">
      {#if busy}<span class="spinner mini"></span>{/if}{profile ? t('save') : t('create')}
    </button>
  </div>
</form>
