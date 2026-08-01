<script lang="ts">
  import { Check, ChevronRight, Globe2, Monitor, UserRound } from '@lucide/svelte'
  import { untrack } from 'svelte'
  import type { JsonRecord, Language } from '../types.js'

  let {
    snapshot,
    language,
    t,
    busy,
    onsetup,
  }: {
    snapshot: JsonRecord
    language: Language
    t: (key: any) => string
    busy: boolean
    onsetup: (config: JsonRecord, profile: JsonRecord) => Promise<void>
  } = $props()

  let selectedLanguage = $state<Language>(untrack(() => language))
  let browser = $state(untrack(() => snapshot.config.browser ?? 'auto'))
  let browserVisibility = $state(untrack(() => snapshot.config.browserVisibility ?? 'headed'))
  let slug = $state('default')
  let label = $state(untrack(() => language === 'zh-CN' ? '默认' : 'Default'))
  let roleLabel = $state('')
  let enabledProviders = $state<string[]>(untrack(() => snapshot.providers
    .filter((provider: JsonRecord) => provider.stage !== 'disabled')
    .map((provider: JsonRecord) => provider.id)))

  function toggleProvider(provider: string, checked: boolean) {
    enabledProviders = checked
      ? [...new Set([...enabledProviders, provider])]
      : enabledProviders.filter((entry) => entry !== provider)
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    await onsetup(
      { language: selectedLanguage, browser, browserVisibility },
      { slug, label, roleLabel, enabledProviders, browserVisibility, setDefault: true },
    )
  }
</script>

<main class="setup-shell" data-testid="setup-view">
  <div class="setup-brand">
    <img src="/ui/mark.png" alt="" />
    <span>Tokenless</span>
  </div>
  <section class="setup-card">
    <header class="setup-header">
      <p class="eyebrow">{t('setup')}</p>
      <h1>{t('setupTitle')}</h1>
      <p>{t('setupBody')}</p>
    </header>

    <form class="setup-form" onsubmit={submit}>
      <div class="setup-row">
        <div class="setup-icon"><Globe2 size={19} /></div>
        <label class="field">
          <span>{t('language')}</span>
          <select bind:value={selectedLanguage} data-testid="setup-language">
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
      </div>

      <div class="setup-row">
        <div class="setup-icon"><Monitor size={19} /></div>
        <div class="form-grid compact setup-fields">
          <label class="field">
            <span>{t('useBrowser')}</span>
            <select bind:value={browser} data-testid="setup-browser">
              {#each ['auto', 'chrome', 'brave', 'edge', 'arc', 'chromium', 'chrome-for-testing', 'managed-chromium', 'cloak'] as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span>{t('visibility')}</span>
            <select bind:value={browserVisibility} data-testid="setup-visibility">
              <option value="auto">auto</option>
              <option value="headed">headed</option>
              <option value="headless">headless</option>
            </select>
          </label>
        </div>
      </div>

      <div class="setup-row align-start">
        <div class="setup-icon"><UserRound size={19} /></div>
        <div class="setup-fields">
          <div class="form-grid compact">
            <label class="field">
              <span>{t('slug')}</span>
              <input bind:value={slug} required pattern={'[a-z0-9](?:[a-z0-9]|-){0,63}'} autocomplete="off" data-testid="setup-slug" />
            </label>
            <label class="field">
              <span>{t('label')}</span>
              <input bind:value={label} required maxlength="80" autocomplete="off" data-testid="setup-label" />
            </label>
          </div>
          <label class="field">
            <span>{t('role')} <small>{t('optional')}</small></span>
            <input bind:value={roleLabel} maxlength="80" autocomplete="off" data-testid="setup-role" />
          </label>
          <fieldset class="fieldset setup-providers">
            <legend>{t('chooseProviders')}</legend>
            <div class="provider-pills">
              {#each snapshot.providers as provider (provider.id)}
                <label class:checked={enabledProviders.includes(provider.id)} class="provider-pill">
                  <input
                    type="checkbox"
                    checked={enabledProviders.includes(provider.id)}
                    onchange={(event) => toggleProvider(provider.id, event.currentTarget.checked)}
                  />
                  {#if enabledProviders.includes(provider.id)}<Check size={13} />{/if}
                  <span>{provider.label}</span>
                </label>
              {/each}
            </div>
          </fieldset>
          <p class="form-note">{t('setupProfileHelp')}</p>
        </div>
      </div>

      <div class="setup-actions">
        <span>localhost</span>
        <button class="button primary" type="submit" disabled={busy || !enabledProviders.length} data-testid="finish-setup">
          {t('finishSetup')} <ChevronRight size={16} />
        </button>
      </div>
    </form>
  </section>
</main>
