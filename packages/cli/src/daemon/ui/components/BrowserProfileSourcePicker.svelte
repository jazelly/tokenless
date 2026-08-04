<script lang="ts">
  import { CheckCircle2, Copy, Search, ShieldCheck, Sparkles, X } from '@lucide/svelte'
  import type { JsonRecord } from '../types.js'

  let {
    sourceId = $bindable(''),
    consent = $bindable(false),
    t,
    busy,
    testId,
    ondiscover,
  }: {
    sourceId: string
    consent: boolean
    t: (key: any) => string
    busy: boolean
    testId: 'setup' | 'profile'
    ondiscover: (input: JsonRecord) => Promise<JsonRecord>
  } = $props()

  const browsers = [
    ['chrome', 'Google Chrome'],
    ['brave', 'Brave Browser'],
    ['edge', 'Microsoft Edge'],
    ['arc', 'Arc'],
    ['chromium', 'Chromium'],
    ['chrome-for-testing', 'Google Chrome for Testing'],
  ] as const

  let mode = $state<'clean' | 'copy'>('clean')
  let sources = $state<JsonRecord[]>([])
  let scanning = $state(false)
  let error = $state('')
  let advanced = $state(false)
  let sourceBrowser = $state('chrome')
  let userDataDir = $state('')
  let selected = $derived(sources.find((source) => source.id === sourceId))

  function setMode(next: 'clean' | 'copy') {
    mode = next
    if (next === 'clean') {
      sourceId = ''
      consent = false
      error = ''
    }
  }

  async function discover() {
    scanning = true
    sourceId = ''
    consent = false
    error = ''
    try {
      const result = await ondiscover(advanced && userDataDir.trim()
        ? { browser: sourceBrowser, userDataDir: userDataDir.trim() }
        : {})
      sources = Array.isArray(result.sources) ? result.sources : []
      const firstCompatible = sources.find((source) => source.compatible === true)
      if (firstCompatible) sourceId = String(firstCompatible.id)
    } catch (caught) {
      sources = []
      error = caught instanceof Error ? caught.message : t('requestFailed')
    } finally {
      scanning = false
    }
  }
</script>

<fieldset class="fieldset profile-source-picker" data-testid={`${testId}-profile-source-picker`}>
  <legend>{t('profileStart')}</legend>
  <div class="source-mode-grid">
    <label class:checked={mode === 'clean'} class="source-mode-card">
      <input type="radio" name={`${testId}-profile-source`} value="clean" checked={mode === 'clean'} onchange={() => setMode('clean')} />
      <Sparkles size={16} />
      <span><strong>{t('cleanProfile')}</strong><small>{t('cleanProfileHelp')}</small></span>
      {#if mode === 'clean'}<CheckCircle2 size={15} />{/if}
    </label>
    <label class:checked={mode === 'copy'} class="source-mode-card" data-testid={`${testId}-profile-source-copy`}>
      <input type="radio" name={`${testId}-profile-source`} value="copy" checked={mode === 'copy'} onchange={() => setMode('copy')} />
      <Copy size={16} />
      <span><strong>{t('copyProfile')}</strong><small>{t('copyProfileHelp')}</small></span>
      {#if mode === 'copy'}<CheckCircle2 size={15} />{/if}
    </label>
  </div>

  {#if mode === 'copy'}
    <div class="profile-source-panel">
      <div class="source-discovery-row">
        <div>
          <strong>{t('browserProfiles')}</strong>
          <small>{t('profileScanPrivacy')}</small>
        </div>
        <button class="button secondary compact-action" type="button" disabled={busy || scanning} onclick={discover} data-testid={`${testId}-profile-source-scan`}>
          {#if scanning}<span class="spinner mini"></span>{:else}<Search size={14} />{/if}
          {t(sources.length ? 'scanAgain' : 'scanProfiles')}
        </button>
      </div>

      {#if sources.length}
        <label class="field">
          <span>{t('sourceProfile')}</span>
          <select bind:value={sourceId} data-testid={`${testId}-profile-source-select`}>
            {#each sources as source (source.id)}
              <option value={source.id} disabled={!source.compatible}>
                {source.browserLabel} · {source.name}{source.browserVersion ? ` · ${source.browserVersion}` : ''}{source.compatible ? '' : ` — ${t('incompatible')}`}
              </option>
            {/each}
          </select>
        </label>
        {#if selected}
          <div class="source-summary">
            <ShieldCheck size={15} />
            <span><strong>{selected.name}</strong><small>{selected.browserLabel} · {selected.directoryKey}</small></span>
          </div>
        {/if}
      {:else if !scanning && !error}
        <p class="form-note">{t('scanProfilesHelp')}</p>
      {/if}

      <details class="source-advanced" bind:open={advanced}>
        <summary>{t('customProfileRoot')}</summary>
        <div class="form-grid compact">
          <label class="field">
            <span>{t('sourceBrowser')}</span>
            <select bind:value={sourceBrowser} data-testid={`${testId}-profile-source-browser`}>
              {#each browsers as option}<option value={option[0]}>{option[1]}</option>{/each}
            </select>
          </label>
          <label class="field">
            <span>{t('profileRootPath')}</span>
            <input bind:value={userDataDir} autocomplete="off" spellcheck="false" placeholder={t('profileRootPathPlaceholder')} data-testid={`${testId}-profile-source-root`} />
          </label>
        </div>
      </details>

      {#if sourceId}
        <label class="consent-row">
          <input type="checkbox" bind:checked={consent} data-testid={`${testId}-profile-source-consent`} />
          <span><strong>{t('profileCopyConsent')}</strong><small>{t('profileCopyConsentHelp')}</small></span>
        </label>
      {/if}

      {#if error}<div class="inline-feedback error" role="alert"><X size={15} /><span>{error}</span></div>{/if}
    </div>
  {/if}
</fieldset>
