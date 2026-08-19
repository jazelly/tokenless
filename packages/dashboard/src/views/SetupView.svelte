<script lang="ts">
  import { Check, ChevronRight, Globe2, Monitor, UserRound } from '@lucide/svelte'
  import { tick, untrack } from 'svelte'
  import type { MessageKey } from '../localization.js'
  import type { Language, UiSetupBrowserId, UiSetupInput, UiSnapshot } from '../types.js'

  let {
    snapshot,
    language,
    t,
    busy,
    onsetup,
  }: {
    snapshot: UiSnapshot
    language: Language
    t: (key: MessageKey) => string
    busy: boolean
    onsetup: (input: UiSetupInput) => Promise<void>
  } = $props()

  const setupSnapshot = untrack(() => snapshot.setup)
  const candidates = setupSnapshot?.browserCandidates ?? []
  const defaultProfile = untrack(() => snapshot.profiles.find((profile) => profile.isDefault)
    ?? snapshot.profiles[0]
    ?? null)
  const configuredSlug = setupSnapshot?.configuredProfileSlugs[0]
  const bindingBrowser = defaultProfile?.browserBinding.browserId
  const initialBrowser = (bindingBrowser === 'chrome' || bindingBrowser === 'brave' || bindingBrowser === 'cloak')
    && candidates.some((candidate) => candidate.browserId === bindingBrowser)
    ? bindingBrowser
    : candidates[0]?.browserId ?? (untrack(() => snapshot.config.browser) === 'brave' ? 'brave' : 'chrome')

  let selectedLanguage = $state<Language>(untrack(() => language))
  let setupError = $state('')
  let errorElement = $state<HTMLDivElement>()
  let slug = $state(setupSnapshot?.defaultProfileSlug ?? configuredSlug ?? 'default')
  let roleLabel = $state(defaultProfile?.roleLabel ?? '')
  let selectedBrowser = $state<UiSetupBrowserId>(initialBrowser)
  let manualBrowser = $state<'chrome' | 'brave'>(untrack(() => selectedBrowser === 'brave' ? 'brave' : 'chrome'))
  let manualMode = $state(candidates.length === 0)
  let browserExecutablePath = $state(candidates.find((candidate) => candidate.browserId === initialBrowser)?.executablePath ?? '')
  let detectedBrowserBeforeManual = $state<UiSetupBrowserId | null>(
    candidates.some((candidate) => candidate.browserId === initialBrowser) ? initialBrowser : null,
  )
  let enabledProviders = $state<string[]>(untrack(() => defaultProfile?.enabledProviders
    ?? snapshot.providers
      .filter((provider) => provider.stage !== 'disabled' && provider.id !== 'gemini')
      .map((provider) => provider.id)))

  function candidateFor(browserId: UiSetupBrowserId) {
    return candidates.find((candidate) => candidate.browserId === browserId) ?? null
  }

  function selectDetectedBrowser(browserId: UiSetupBrowserId) {
    detectedBrowserBeforeManual = browserId
    selectedBrowser = browserId
    manualMode = false
    browserExecutablePath = candidateFor(browserId)?.executablePath ?? ''
  }

  function showManualBrowser() {
    const detected = candidateFor(selectedBrowser)
    if (detected) detectedBrowserBeforeManual = selectedBrowser
    manualMode = true
    selectedBrowser = manualBrowser
    browserExecutablePath = ''
  }

  function toggleManualBrowser() {
    if (!manualMode) {
      showManualBrowser()
      return
    }
    if (candidates.length === 0) return
    const detected = (detectedBrowserBeforeManual
      ? candidateFor(detectedBrowserBeforeManual)
      : null) ?? candidates[0] ?? null
    manualMode = false
    if (detected) {
      selectedBrowser = detected.browserId
      browserExecutablePath = detected.executablePath
    }
  }

  function changeManualBrowser(browserId: 'chrome' | 'brave') {
    manualBrowser = browserId
    selectedBrowser = browserId
    browserExecutablePath = ''
  }

  function toggleProvider(provider: string, checked: boolean) {
    enabledProviders = checked
      ? [...new Set([...enabledProviders, provider])]
      : enabledProviders.filter((entry) => entry !== provider)
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setupError = ''
    try {
      await onsetup({
        slug,
        roleLabel,
        enabledProviders,
        browser: selectedBrowser,
        browserExecutablePath: browserExecutablePath.trim() || null,
        language: selectedLanguage,
        browserVisibility: 'headed',
        setDefault: true,
      })
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

      <div class="setup-row align-start">
        <div class="setup-icon"><Monitor size={19} /></div>
        <div class="setup-fields browser-setup-fields">
          <label class="field">
            <span>{t('profileBrowser')}</span>
            {#if candidates.length > 0}
              <select name="browser" value={selectedBrowser} onchange={(event) => selectDetectedBrowser(event.currentTarget.value as UiSetupBrowserId)} data-testid="setup-browser">
                {#each candidates as candidate (candidate.runtimeId)}
                  <option value={candidate.browserId}>{candidate.label} · {candidate.version}</option>
                {/each}
              </select>
            {:else}
              <div class="setup-empty-browser" data-testid="setup-no-browser">{t('noBrowsersDetected')}</div>
            {/if}
          </label>

          {#if !manualMode && candidateFor(selectedBrowser)}
            {@const candidate = candidateFor(selectedBrowser)}
            <label class="field">
              <span>{t('browserExecutablePath')} <small>{t('detected')}</small></span>
              <input name="browserExecutablePath" value={candidate?.executablePath ?? ''} readonly autocomplete="off" spellcheck="false" data-testid="setup-browser-executable-path" />
              <small class="field-help">{candidate?.label} · v{candidate?.version} · {candidate?.source === 'tokenless-cache' ? t('managedByTokenless') : t('detectedOnComputer')}</small>
            </label>
          {:else}
            <div class="setup-manual-browser" data-testid="setup-manual-browser">
              <label class="field">
                <span>{t('addBrowser')}</span>
                <select name="manualBrowser" value={manualBrowser} onchange={(event) => changeManualBrowser(event.currentTarget.value as 'chrome' | 'brave')}>
                  <option value="chrome">{t('googleChrome')}</option>
                  <option value="brave">{t('braveBrowser')}</option>
                </select>
              </label>
              <label class="field">
                <span>{t('browserExecutablePath')} <small>{t('required')}</small></span>
                <input name="browserExecutablePath" bind:value={browserExecutablePath} placeholder={t('browserExecutablePathPlaceholder')} required autocomplete="off" spellcheck="false" data-testid="setup-browser-executable-path" />
              </label>
            </div>
          {/if}

          <div class="setup-browser-actions">
            <button class="text-button" type="button" onclick={toggleManualBrowser} data-testid="setup-add-browser">{manualMode ? t('hideAddBrowser') : t('addBrowser')}</button>
          </div>
          <p class="form-note">{selectedBrowser === 'cloak' ? t('cloakBrowserHelp') : t('nativeChromeConnectionHelp')}</p>
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
          </div>
          <label class="field">
            <span>{t('role')} <small>{t('optional')}</small></span>
            <input name="roleLabel" bind:value={roleLabel} maxlength="80" autocomplete="off" data-testid="setup-role" />
          </label>
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
        <button class="button primary" type="submit" disabled={busy || !enabledProviders.length} data-testid="finish-setup">
          {#if busy}<span class="spinner mini"></span>{/if}{t('finishSetup')} <ChevronRight size={16} />
        </button>
      </div>
    </form>
  </section>
</main>
