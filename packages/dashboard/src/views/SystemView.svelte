<script lang="ts">
  import { Calculator, Clipboard, Moon, PauseCircle, ShieldCheck } from '@lucide/svelte'
  import { tick, untrack } from 'svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatNumber, formatTime } from '../formatting.js'
  import { stateLabel, type MessageKey } from '../i18n/index.js'
  import type { DashboardActions, Language, DashboardConfigUpdate, DashboardDiagnostic, DashboardSnapshot } from '../types.js'

  let {
    snapshot,
    language,
    t,
    busy,
    actions,
    ontoast,
  }: {
    snapshot: DashboardSnapshot
    language: Language
    t: (key: MessageKey) => string
    busy: boolean
    actions: DashboardActions
    ontoast: (message: string) => void
  } = $props()

  let selectedLanguage = $state(untrack(() => snapshot.config.language as Language))
  let selectedBrowser = $state<'chrome' | 'brave'>(untrack(() => snapshot.config.browser === 'brave' ? 'brave' : 'chrome'))
  let browserExecutablePath = $state('')
  let formError = $state('')
  let errorElement = $state<HTMLDivElement>()

  async function showFormError(message: string) {
    formError = message
    await tick()
    errorElement?.focus()
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    formError = ''
    const body: DashboardConfigUpdate = {
      language: selectedLanguage,
      browser: selectedBrowser,
      ...(browserExecutablePath.trim() ? { browserExecutablePath: browserExecutablePath.trim() } : {}),
      browserVisibility: 'headed',
    }
    try {
      await actions.updateConfig(body)
    } catch (error) {
      await showFormError(error instanceof Error ? error.message : t('requestFailed'))
    }
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot.diagnostics, null, 2))
      ontoast(t('copied'))
    } catch {
      ontoast(t('copyFailed'))
    }
  }

  async function quiesceRuntime() {
    try {
      await actions.quiesceRuntime()
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function enableOutputSavings() {
    try {
      await actions.enableOutputSavings()
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function disableOutputSavings() {
    try {
      await actions.disableOutputSavings()
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function clearOutputSavings() {
    if (!window.confirm(t('confirmClearSavings'))) return
    try {
      await actions.clearOutputSavings()
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function uninstallOutputSavings() {
    if (!window.confirm(t('confirmUninstallTokenizer'))) return
    try {
      await actions.uninstallOutputSavings()
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  function formatMegabytes(bytes: number) {
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`
  }

  function diagnosticMessage(item: DashboardDiagnostic) {
    if (item.id === 'configuration') return snapshot.config.updatedAt ? t('configPersisted') : t('setupIncomplete')
    if (item.id === 'browser-runtime') return item.state === 'ok' ? t('browserReady') : t('browserUnavailable')
    if (item.id === 'profiles') {
      if (snapshot.profiles.length === 0) return t('noManagedProfiles')
      const count = formatNumber(snapshot.profiles.length, language)
      return `${count} ${t('profilesRegistered')}`
    }
    if (item.id === 'scheduler') {
      const count = formatNumber(snapshot.runtime.activeJobCount, language)
      return `${count} ${t('activeBrowserJobs')}`
    }
    if (item.id === 'output-savings') {
      if (!snapshot.outputSavings.enabled) return t('savingsDisabled')
      if (snapshot.outputSavings.runtime.state === 'ready') return t('tokenizerReady')
      return snapshot.outputSavings.runtime.state === 'not_installed'
        ? t('tokenizerPreparesOnFirstResponse')
        : t('tokenizerUnavailable')
    }
    return item.message ?? ''
  }
</script>

<section class="page" data-testid="system-view">
  <PageHeader title={t('system')} description={t('systemLede')}>
    {#snippet actions()}
      <button class="button secondary icon-label" type="button" onclick={copyDiagnostics}><Clipboard size={15} />{t('copyDiagnostics')}</button>
    {/snippet}
  </PageHeader>

  <form class="system-grid" onsubmit={save} data-testid="config-form">
    <section class="settings-section system-card">
      <div class="settings-section-title"><h2>{t('appearance')}</h2><Moon size={17} /></div>
      <div class="form-stack">
        <label class="field"><span>{t('language')}</span><select name="language" bind:value={selectedLanguage} data-testid="config-language"><option value="en">English</option><option value="zh-CN">简体中文</option></select><small>{t('languageHelp')}</small></label>
      </div>
    </section>
    <section class="settings-section system-card">
      <div class="settings-section-title"><h2>{t('runtime')}</h2><ShieldCheck size={17} /></div>
      <div class="form-stack">
        <label class="field"><span>{t('profileBrowser')}</span><select name="browser" bind:value={selectedBrowser} data-testid="config-browser"><option value="chrome">{t('googleChrome')}</option><option value="brave">{t('braveBrowser')}</option></select></label>
        <label class="field"><span>{t('browserExecutablePath')} <small>{t('optional')}</small></span><input name="browserExecutablePath" bind:value={browserExecutablePath} placeholder={t('browserExecutablePathPlaceholder')} autocomplete="off" spellcheck="false" data-testid="config-browser-executable-path" /><small>{snapshot.config.browserExecutablePathConfigured ? t('browserExecutablePathConfigured') : t('browserExecutablePathHelp')}</small></label>
        <div class="field read-only-field"><span>{t('defaultVisibility')}</span><strong>headed</strong></div>
        <p class="form-note">{selectedBrowser === 'brave' ? 'brave' : 'chrome'}://inspect/#remote-debugging · {t('nativeChromeConnectionHelp')}</p>
      </div>
    </section>
    <div class="system-actions">
      <button class="button secondary icon-label" type="button" disabled={busy} onclick={quiesceRuntime}><PauseCircle size={15} />{t('quiesce')}</button>
      <button class="button primary" type="submit" disabled={busy} data-testid="config-save">{#if busy}<span class="spinner mini"></span>{/if}{t('save')}</button>
    </div>
    {#if formError}<div bind:this={errorElement} class="inline-feedback error system-form-error" role="alert" tabindex="-1" data-testid="config-error"><span>{formError}</span></div>{/if}
  </form>

  <section class="settings-section system-card output-savings-card" data-testid="output-savings-card">
    <div class="settings-section-title"><h2>{t('outputSavings')}</h2><Calculator size={17} /></div>
    <p class="output-savings-lede"><strong>{t(snapshot.outputSavings.enabled ? 'savingsEnabled' : 'savingsDisabled')}</strong> {t('outputSavingsLede')}</p>
    <div class="output-savings-metrics">
      <div><small>{t('estimatedTokensSaved')}</small><strong>{formatNumber(snapshot.outputSavings.summary.estimatedOutputTokens, language)}</strong></div>
      <div><small>{t('measuredResponses')}</small><strong>{formatNumber(snapshot.outputSavings.summary.responseCount, language)}</strong></div>
      <div><small>{t('tokenizerRuntime')}</small><strong>{snapshot.outputSavings.runtime.installed ? stateLabel(language, snapshot.outputSavings.runtime.state) : t('tokenizerNotInstalled')}</strong></div>
      <div><small>{snapshot.outputSavings.runtime.installed ? t('runtimeSize') : t('downloadRequired')}</small><strong>{formatMegabytes(snapshot.outputSavings.runtime.installed ? snapshot.outputSavings.runtime.installedBytes : snapshot.outputSavings.runtime.downloadBytes)}</strong></div>
    </div>
    <p class="output-savings-help">{t('lazyTokenizerDownload')}</p>
    <div class="output-savings-actions">
      {#if snapshot.outputSavings.enabled}
        {#if snapshot.outputSavings.runtime.state !== 'ready'}
          <button class="button primary" type="button" disabled={busy} onclick={enableOutputSavings} data-testid="output-savings-install">{t('prepareTokenizerNow')}</button>
        {/if}
        <button class="button secondary" type="button" disabled={busy} onclick={disableOutputSavings} data-testid="output-savings-disable">{t('disableOutputSavings')}</button>
      {:else}
        <button class="button primary" type="button" disabled={busy} onclick={enableOutputSavings} data-testid="output-savings-enable">{t('enableOutputSavings')}</button>
      {/if}
      <button class="button secondary" type="button" disabled={busy || snapshot.outputSavings.summary.responseCount === 0} onclick={clearOutputSavings}>{t('clearSavingsHistory')}</button>
      {#if snapshot.outputSavings.runtime.installed}
        <button class="button danger" type="button" disabled={busy} onclick={uninstallOutputSavings}>{t('uninstallTokenizer')}</button>
      {/if}
    </div>
  </section>

  <section class="diagnostics-section">
    <header><div><h2>{t('diagnostics')}</h2><p>{formatTime(snapshot.generatedAt, language)}</p></div></header>
    <div class="content-panel row-list">
      {#each snapshot.diagnostics as item (item.id)}
        <div class="data-row diagnostic-row">
          <span class:ok={item.state === 'ok'} class:error={item.state === 'error'} class="status-dot"></span>
          <span class="data-row-main"><strong>{item.id}</strong><small>{diagnosticMessage(item)}</small></span>
          <span class="mono-label">{stateLabel(language, item.state)}</span>
        </div>
      {/each}
    </div>
  </section>
</section>
