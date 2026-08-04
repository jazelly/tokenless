<script lang="ts">
  import { untrack } from 'svelte'
  import BrowserProfileSourcePicker from './BrowserProfileSourcePicker.svelte'
  import type { JsonRecord } from '../types.js'

  let {
    snapshot,
    profile,
    t,
    busy,
    oncancel,
    onsubmit,
    ondiscoverprofiles,
  }: {
    snapshot: JsonRecord
    profile?: JsonRecord
    t: (key: any) => string
    busy: boolean
    oncancel: () => void
    onsubmit: (value: JsonRecord) => Promise<void>
    ondiscoverprofiles: (input: JsonRecord) => Promise<JsonRecord>
  } = $props()

  let slug = $state(untrack(() => profile?.slug ?? ''))
  let label = $state(untrack(() => profile?.label ?? ''))
  let roleLabel = $state(untrack(() => profile?.preferences?.roleLabel ?? ''))
  let browserVisibility = $state(untrack(() => profile?.preferences?.browserVisibility ?? snapshot.config.browserVisibility ?? 'auto'))
  let enabledProviders = $state<string[]>(untrack(() => profile?.preferences?.enabledProviders
    ? [...profile.preferences.enabledProviders]
    : Array.isArray(snapshot.config.providerWhitelist)
      ? [...snapshot.config.providerWhitelist]
      : snapshot.providers.filter((provider: JsonRecord) => provider.stage !== 'disabled').map((provider: JsonRecord) => provider.id)))
  let proxy = $state(untrack(() => profile?.preferences?.proxy?.server ?? ''))
  let proxyBypass = $state(untrack(() => profile?.preferences?.proxy?.bypass?.join(', ') ?? ''))
  let importSourceId = $state('')
  let consentLocalProfileCopy = $state(false)

  function toggleProvider(provider: string, checked: boolean) {
    enabledProviders = checked
      ? [...new Set([...enabledProviders, provider])]
      : enabledProviders.filter((entry) => entry !== provider)
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    await onsubmit({
      ...(!profile ? { slug } : {}),
      label,
      roleLabel,
      browserVisibility,
      enabledProviders,
      ...(!profile && importSourceId ? { importSourceId, consentLocalProfileCopy } : {}),
      proxy: proxy.trim()
        ? {
            server: proxy.trim(),
            bypass: proxyBypass.split(',').map((entry: string) => entry.trim()).filter(Boolean),
          }
        : null,
    })
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

  <div class="form-grid compact">
    <label class="field">
      <span>{t('visibility')}</span>
      <select bind:value={browserVisibility} data-testid="profile-visibility">
        <option value="auto">auto</option>
        <option value="headed">headed</option>
        <option value="headless">headless</option>
      </select>
    </label>
    <div class="field read-only-field">
      <span>{t('profileBrowser')}</span>
      <strong>{profile?.runtimeBinding?.browserId ?? snapshot.config.browser}</strong>
    </div>
  </div>

  {#if !profile}
    <BrowserProfileSourcePicker
      bind:sourceId={importSourceId}
      bind:consent={consentLocalProfileCopy}
      {t}
      {busy}
      testId="profile"
      ondiscover={ondiscoverprofiles}
    />
  {/if}

  <fieldset class="fieldset">
    <legend>{t('providerAccess')}</legend>
    <div class="provider-pills" data-testid="profile-providers">
      {#each snapshot.providers as provider (provider.id)}
        <label class:checked={enabledProviders.includes(provider.id)} class="provider-pill">
          <input
            type="checkbox"
            value={provider.id}
            checked={enabledProviders.includes(provider.id)}
            onchange={(event) => toggleProvider(provider.id, event.currentTarget.checked)}
          />
          <span>{provider.label}</span>
        </label>
      {/each}
    </div>
  </fieldset>

  <details class="details-block">
    <summary>{t('proxySettings')}</summary>
    <div class="details-content">
      <label class="field">
        <span>{t('proxy')}</span>
        <input bind:value={proxy} placeholder="socks5://127.0.0.1:1080" autocomplete="off" data-testid="profile-proxy" />
      </label>
      <label class="field">
        <span>{t('proxyBypass')}</span>
        <input bind:value={proxyBypass} autocomplete="off" data-testid="profile-proxy-bypass" />
      </label>
      <p class="form-note">{t('proxyRestartNote')}</p>
    </div>
  </details>

  <div class="form-actions">
    <button class="button secondary" type="button" onclick={oncancel}>{t('cancel')}</button>
    <button class="button primary" type="submit" disabled={busy || (importSourceId !== '' && !consentLocalProfileCopy)} data-testid="profile-submit">
      {profile ? t('save') : t('create')}
    </button>
  </div>
</form>
