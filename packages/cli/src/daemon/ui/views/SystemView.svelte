<script lang="ts">
  import { Calculator, Clipboard, Moon, PauseCircle, ShieldCheck } from '@lucide/svelte'
  import { tick, untrack } from 'svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatNumber, formatTime } from '../formatting.js'
  import { stateLabel } from '../localization.js'
  import type { JsonRecord, Language } from '../types.js'

  let {
    snapshot,
    language,
    t,
    busy,
    onmutate,
    ontoast,
  }: {
    snapshot: JsonRecord
    language: Language
    t: (key: any) => string
    busy: boolean
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
    ontoast: (message: string) => void
  } = $props()

  let selectedLanguage = $state(untrack(() => snapshot.config.language as Language))
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
    const body: JsonRecord = { language: selectedLanguage, browser: 'chrome', browserVisibility: 'headed' }
    try {
      await onmutate('/config', body, 'PATCH')
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
      await onmutate('/runtime/quiesce')
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function enableOutputSavings() {
    try {
      await onmutate('/output-savings/enable', {})
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function disableOutputSavings() {
    try {
      await onmutate('/output-savings/disable', {})
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function clearOutputSavings() {
    if (!window.confirm(t('confirmClearSavings'))) return
    try {
      await onmutate('/output-savings/history/clear', { confirmDelete: true })
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function uninstallOutputSavings() {
    if (!window.confirm(t('confirmUninstallTokenizer'))) return
    try {
      await onmutate('/output-savings/runtime/uninstall', { confirmDelete: true })
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  function formatMegabytes(bytes: number) {
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`
  }

  function diagnosticMessage(item: JsonRecord) {
    if (item.id === 'configuration') return snapshot.config.updatedAt ? t('configPersisted') : t('setupIncomplete')
    if (item.id === 'browser-runtime') return item.state === 'ok' ? t('browserReady') : t('browserUnavailable')
    if (item.id === 'profiles') {
      if (snapshot.profiles.length === 0) return t('noManagedProfiles')
      const count = formatNumber(snapshot.profiles.length, language)
      return language === 'zh-CN'
        ? `已注册 ${count} 个 managed profile。`
        : `${count} managed profile${snapshot.profiles.length === 1 ? '' : 's'} registered.`
    }
    if (item.id === 'scheduler') {
      const count = formatNumber(snapshot.runtime.activeJobCount, language)
      return language === 'zh-CN'
        ? `${count} 个浏览器任务正在运行。`
        : `${count} active browser job${snapshot.runtime.activeJobCount === 1 ? '' : 's'}.`
    }
    if (item.id === 'output-savings') {
      if (!snapshot.outputSavings.enabled) return t('savingsDisabled')
      if (snapshot.outputSavings.runtime.state === 'ready') return t('tokenizerReady')
      return snapshot.outputSavings.runtime.state === 'not_installed'
        ? t('tokenizerPreparesOnFirstResponse')
        : t('tokenizerUnavailable')
    }
    return item.message
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
        <div class="field read-only-field"><span>{t('profileBrowser')}</span><strong>Native Google Chrome</strong></div>
        <div class="field read-only-field"><span>{t('defaultVisibility')}</span><strong>headed</strong></div>
        <p class="form-note">Chrome 144+ · chrome://inspect/#remote-debugging · {t('nativeChromeConnectionHelp')}</p>
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
