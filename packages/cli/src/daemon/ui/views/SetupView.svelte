<script lang="ts">
  import { Check, ChevronRight, Globe2, Monitor, UserRound } from '@lucide/svelte'
  import { tick, untrack } from 'svelte'
  import BrowserProfileSourcePicker from '../components/BrowserProfileSourcePicker.svelte'
  import BrowserRuntimePicker from '../components/BrowserRuntimePicker.svelte'
  import type { JsonRecord, Language } from '../types.js'

  let {
    snapshot,
    language,
    t,
    busy,
    browserRuntimeCatalog,
    oninspectbrowser,
    oninstallbrowser,
    onclearbrowserpath,
    ondiscoverprofiles,
    onsetup,
  }: {
    snapshot: JsonRecord
    language: Language
    t: (key: any) => string
    busy: boolean
    browserRuntimeCatalog: JsonRecord | null
    oninspectbrowser: (browser: string, executablePath?: string) => Promise<JsonRecord>
    oninstallbrowser: (browser: string, repair?: boolean) => Promise<JsonRecord>
    onclearbrowserpath: (browser: string) => Promise<void>
    ondiscoverprofiles: (input: JsonRecord) => Promise<JsonRecord>
    onsetup: (config: JsonRecord, profile: JsonRecord) => Promise<void>
  } = $props()

  let selectedLanguage = $state<Language>(untrack(() => language))
  let browser = $state(untrack(() => snapshot.config.browser ?? 'auto'))
  let browserExecutablePath = $state('')
  let browserError = $state('')
  let setupError = $state('')
  let errorElement = $state<HTMLDivElement>()
  let browserVisibility = $state(untrack(() => snapshot.config.browserVisibility ?? 'headed'))
  let slug = $state('default')
  let label = $state(untrack(() => language === 'zh-CN' ? '默认' : 'Default'))
  let roleLabel = $state('')
  let importSourceId = $state('')
  let consentLocalProfileCopy = $state(false)
  let enabledProviders = $state<string[]>(untrack(() => Array.isArray(snapshot.config.providerWhitelist)
    ? snapshot.config.providerWhitelist.filter((provider: string) => snapshot.config.updatedAt || provider !== 'gemini')
    : snapshot.providers
      .filter((provider: JsonRecord) => provider.stage !== 'disabled' && provider.id !== 'gemini')
      .map((provider: JsonRecord) => provider.id)))

  function toggleProvider(provider: string, checked: boolean) {
    enabledProviders = checked
      ? [...new Set([...enabledProviders, provider])]
      : enabledProviders.filter((entry) => entry !== provider)
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    browserError = ''
    setupError = ''
    if (browserExecutablePath.trim()) {
      try {
        const inspection = await oninspectbrowser(browser, browserExecutablePath.trim())
        if (inspection.ok !== true) {
          browserError = String(inspection.message || t('browserUnavailable'))
          await tick()
          errorElement?.focus()
          return
        }
      } catch (error) {
        browserError = error instanceof Error ? error.message : t('requestFailed')
        await tick()
        errorElement?.focus()
        return
      }
    }
    try {
      await onsetup(
        {
          language: selectedLanguage,
          browser,
          browserVisibility,
          ...(browserExecutablePath.trim() ? { browserExecutablePath: browserExecutablePath.trim() } : {}),
        },
        {
          slug,
          label,
          roleLabel,
          enabledProviders,
          browserVisibility,
          setDefault: true,
          ...(browser === 'cloak' && importSourceId ? { importSourceId, consentLocalProfileCopy } : {}),
        },
      )
    } catch (caught) {
      setupError = caught instanceof Error ? caught.message : t('requestFailed')
      await tick()
      errorElement?.focus()
    }
  }
</script>

<main id="main" tabindex="-1" class="setup-shell" data-testid="setup-view">
  <div class="setup-brand">
    <img src="/ui/mark.png" alt="" width="26" height="26" />
    <span translate="no">Tokenless</span>
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
          <select name="language" bind:value={selectedLanguage} data-testid="setup-language">
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
      </div>

      <div class="setup-row">
        <div class="setup-icon"><Monitor size={19} /></div>
        <div class="setup-fields browser-setup-fields">
          <BrowserRuntimePicker
            bind:browser
            bind:executablePath={browserExecutablePath}
            catalog={browserRuntimeCatalog}
            {t}
            {busy}
            pathConfigured={snapshot.config.browserExecutablePathConfigured === true}
            configuredBrowser={snapshot.config.browser}
            testId="setup"
            oninspect={oninspectbrowser}
            oninstall={oninstallbrowser}
            onclear={onclearbrowserpath}
          />
          {#if browserError}<div bind:this={errorElement} class="inline-feedback error" role="alert" tabindex="-1"><span>{browserError}</span></div>{/if}
          <label class="field">
            <span>{t('visibility')}</span>
            <select name="browserVisibility" bind:value={browserVisibility} data-testid="setup-visibility">
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
              <input name="slug" bind:value={slug} required pattern={'[a-z0-9](?:[a-z0-9]|-){0,63}'} autocomplete="off" spellcheck="false" data-testid="setup-slug" />
            </label>
            <label class="field">
              <span>{t('label')}</span>
              <input name="label" bind:value={label} required maxlength="80" autocomplete="off" data-testid="setup-label" />
            </label>
          </div>
          <label class="field">
            <span>{t('role')} <small>{t('optional')}</small></span>
            <input name="roleLabel" bind:value={roleLabel} maxlength="80" autocomplete="off" data-testid="setup-role" />
          </label>
          {#if browser === 'cloak'}
            <BrowserProfileSourcePicker
              bind:sourceId={importSourceId}
              bind:consent={consentLocalProfileCopy}
              {t}
              {busy}
              testId="setup"
              ondiscover={ondiscoverprofiles}
            />
          {/if}
          <fieldset class="fieldset setup-providers">
            <legend>{t('chooseProviders')}</legend>
            <div class="provider-pills">
              {#each snapshot.providers as provider (provider.id)}
                <label class:checked={enabledProviders.includes(provider.id)} class="provider-pill">
                  <input
                    type="checkbox"
                    name="enabledProviders"
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

      {#if setupError}<div bind:this={errorElement} class="inline-feedback error" role="alert" tabindex="-1" data-testid="setup-error"><span>{setupError}</span></div>{/if}

      <div class="setup-actions">
        <span>localhost</span>
        <button class="button primary" type="submit" disabled={busy || !enabledProviders.length || (browser === 'cloak' && importSourceId !== '' && !consentLocalProfileCopy)} data-testid="finish-setup">
          {#if busy}<span class="spinner mini"></span>{/if}{t('finishSetup')} <ChevronRight size={16} />
        </button>
      </div>
    </form>
  </section>
</main>
