<script lang="ts">
  import { Clipboard, Moon, PauseCircle, ShieldCheck } from '@lucide/svelte'
  import { untrack } from 'svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatTime } from '../formatting.js'
  import type { JsonRecord, Language } from '../types.js'

  let { snapshot, language, t, busy, onmutate, ontoast }: {
    snapshot: JsonRecord
    language: Language
    t: (key: any) => string
    busy: boolean
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
    ontoast: (message: string) => void
  } = $props()

  let selectedLanguage = $state(untrack(() => snapshot.config.language as Language))
  let browser = $state(untrack(() => snapshot.config.browser))
  let browserVisibility = $state(untrack(() => snapshot.config.browserVisibility))

  async function save(event: SubmitEvent) {
    event.preventDefault()
    await onmutate('/config', { language: selectedLanguage, browser, browserVisibility }, 'PATCH')
  }

  async function copyDiagnostics() {
    await navigator.clipboard.writeText(JSON.stringify(snapshot.diagnostics, null, 2))
    ontoast(t('copied'))
  }

  function diagnosticMessage(item: JsonRecord) {
    if (item.id === 'configuration') return snapshot.config.updatedAt ? t('configPersisted') : t('setupIncomplete')
    if (item.id === 'browser-runtime') return item.state === 'ok' ? t('browserReady') : t('browserUnavailable')
    if (item.id === 'profiles') return snapshot.profiles.length === 0 ? t('noManagedProfiles') : `${snapshot.profiles.length} ${t('profilesRegistered')}`
    if (item.id === 'scheduler') return `${snapshot.runtime.activeJobCount} ${t('activeBrowserJobs')}`
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
        <label class="field"><span>{t('language')}</span><select bind:value={selectedLanguage} data-testid="config-language"><option value="en">English</option><option value="zh-CN">简体中文</option></select><small>{t('languageHelp')}</small></label>
      </div>
    </section>
    <section class="settings-section system-card">
      <div class="settings-section-title"><h2>{t('runtime')}</h2><ShieldCheck size={17} /></div>
      <div class="form-stack">
        <label class="field"><span>{t('browserSelection')}</span><select bind:value={browser} data-testid="config-browser">{#each ['auto', 'chrome', 'brave', 'edge', 'arc', 'chromium', 'chrome-for-testing', 'managed-chromium', 'cloak'] as value}<option value={value}>{value}</option>{/each}</select></label>
        <label class="field"><span>{t('defaultVisibility')}</span><select bind:value={browserVisibility} data-testid="config-visibility"><option value="auto">auto</option><option value="headed">headed</option><option value="headless">headless</option></select></label>
      </div>
    </section>
    <div class="system-actions">
      <button class="button secondary icon-label" type="button" disabled={busy} onclick={() => onmutate('/runtime/quiesce')}><PauseCircle size={15} />{t('quiesce')}</button>
      <button class="button primary" type="submit" disabled={busy} data-testid="config-save">{t('save')}</button>
    </div>
  </form>

  <section class="diagnostics-section">
    <header><div><h2>{t('diagnostics')}</h2><p>{formatTime(snapshot.generatedAt, language)}</p></div></header>
    <div class="content-panel row-list">
      {#each snapshot.diagnostics as item (item.id)}
        <div class="data-row diagnostic-row">
          <span class:ok={item.state === 'ok'} class:error={item.state === 'error'} class="status-dot"></span>
          <span class="data-row-main"><strong>{item.id}</strong><small>{diagnosticMessage(item)}</small></span>
          <span class="mono-label">{item.state}</span>
        </div>
      {/each}
    </div>
  </section>
</section>
