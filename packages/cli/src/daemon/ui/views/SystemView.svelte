<script lang="ts">
  import { Clipboard, Moon, PauseCircle, ShieldCheck } from '@lucide/svelte'
  import { tick, untrack } from 'svelte'
  import BrowserRuntimePicker from '../components/BrowserRuntimePicker.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatNumber, formatTime } from '../formatting.js'
  import { stateLabel } from '../localization.js'
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
    onmutate,
    ontoast,
  }: {
    snapshot: JsonRecord
    language: Language
    t: (key: any) => string
    busy: boolean
    browserRuntimeCatalog: JsonRecord | null
    oninspectbrowser: (browser: string, executablePath?: string) => Promise<JsonRecord>
    oninstallbrowser: (browser: string, repair?: boolean) => Promise<JsonRecord>
    onclearbrowserpath: (browser: string) => Promise<void>
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
    ontoast: (message: string) => void
  } = $props()

  let selectedLanguage = $state(untrack(() => snapshot.config.language as Language))
  let browser = $state(untrack(() => snapshot.config.browser))
  let browserExecutablePath = $state('')
  let browserVisibility = $state(untrack(() => snapshot.config.browserVisibility))
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
    const body: JsonRecord = { language: selectedLanguage, browser, browserVisibility }
    if (browserExecutablePath.trim()) body.browserExecutablePath = browserExecutablePath.trim()
    try {
      if (browserExecutablePath.trim()) {
        const inspection = await oninspectbrowser(browser, browserExecutablePath.trim())
        if (inspection.ok !== true) {
          await showFormError(String(inspection.message || t('browserUnavailable')))
          return
        }
      }
      await onmutate('/config', body, 'PATCH')
      browserExecutablePath = ''
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
        <BrowserRuntimePicker
          bind:browser
          bind:executablePath={browserExecutablePath}
          catalog={browserRuntimeCatalog}
          {t}
          {busy}
          pathConfigured={snapshot.config.browserExecutablePathConfigured === true}
          configuredBrowser={snapshot.config.browser}
          testId="config"
          allowRepair={true}
          oninspect={oninspectbrowser}
          oninstall={oninstallbrowser}
          onclear={onclearbrowserpath}
        />
        <label class="field"><span>{t('defaultVisibility')}</span><select name="browserVisibility" bind:value={browserVisibility} data-testid="config-visibility"><option value="auto">auto</option><option value="headed">headed</option><option value="headless">headless</option></select></label>
      </div>
    </section>
    <div class="system-actions">
      <button class="button secondary icon-label" type="button" disabled={busy} onclick={quiesceRuntime}><PauseCircle size={15} />{t('quiesce')}</button>
      <button class="button primary" type="submit" disabled={busy} data-testid="config-save">{#if busy}<span class="spinner mini"></span>{/if}{t('save')}</button>
    </div>
    {#if formError}<div bind:this={errorElement} class="inline-feedback error system-form-error" role="alert" tabindex="-1" data-testid="config-error"><span>{formError}</span></div>{/if}
  </form>

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
