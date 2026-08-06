<script lang="ts">
  import { CheckCircle2, Download, FolderCog, RefreshCw, Search, X } from '@lucide/svelte'
  import { tick, untrack } from 'svelte'
  import type { JsonRecord } from '../types.js'

  let {
    browser = $bindable('auto'),
    executablePath = $bindable(''),
    catalog,
    t,
    busy,
    pathConfigured = false,
    configuredBrowser = '',
    testId,
    allowRepair = false,
    oninspect,
    oninstall,
    onclear,
  }: {
    browser: string
    executablePath: string
    catalog: JsonRecord | null
    t: (key: any) => string
    busy: boolean
    pathConfigured?: boolean
    configuredBrowser?: string
    testId: 'setup' | 'config'
    allowRepair?: boolean
    oninspect: (browser: string, executablePath?: string) => Promise<JsonRecord>
    oninstall: (browser: string, repair?: boolean) => Promise<JsonRecord>
    onclear?: (browser: string) => Promise<void>
  } = $props()

  const fallbackSelections = [
    ['auto', 'Automatic'],
    ['chrome', 'Google Chrome'],
    ['edge', 'Microsoft Edge'],
    ['chromium', 'Chromium'],
    ['chrome-for-testing', 'Google Chrome for Testing'],
    ['managed-chromium', 'Managed Chrome for Testing'],
    ['cloak', 'CloakBrowser'],
  ] as const

  let showCustomPath = $state(untrack(() => Boolean(executablePath)))
  let operation = $state<'inspect' | 'install' | 'repair' | 'clear' | ''>('')
  let result = $state<JsonRecord | null>(null)
  let error = $state('')
  let errorElement = $state<HTMLDivElement>()

  async function reportError(message: string) {
    error = message
    await tick()
    errorElement?.focus()
  }

  let options = $derived(Array.isArray(catalog?.options) && catalog.options.length
    ? catalog.options
    : fallbackSelections.map(([selection, displayName]) => ({
        selection,
        displayName,
        available: selection === 'auto',
        installed: selection === 'auto',
        downloadRequired: selection === 'managed-chromium' || selection === 'cloak',
        customPathAllowed: ['chrome', 'edge', 'chromium', 'chrome-for-testing'].includes(selection),
        version: null,
        source: null,
      })))
  let visibleOptions = $derived(testId === 'setup'
    ? options.filter((option: JsonRecord) => (
        option.selection === 'managed-chromium' ||
        option.selection === 'cloak' ||
        option.selection === configuredBrowser ||
        option.selection === browser
      ))
    : options)
  let selected = $derived(options.find((option: JsonRecord) => option.selection === browser))
  let isManaged = $derived(browser === 'managed-chromium' || browser === 'cloak')
  let customPathAllowed = $derived(selected?.customPathAllowed === true)
  let hasConfiguredPath = $derived(pathConfigured && browser === configuredBrowser)

  function optionLabel(option: JsonRecord) {
    const name = option.selection === 'auto' ? t('automatic') : option.displayName
    if (!catalog) return name
    if (option.downloadRequired) return `${name} — ${t('downloadRequired')}`
    if (option.available) return `${name} — ${t('available')}`
    return `${name} — ${t('notFound')}`
  }

  function browserChanged() {
    executablePath = ''
    showCustomPath = false
    result = null
    error = ''
  }

  async function inspect() {
    if (!executablePath.trim()) return
    operation = 'inspect'
    result = null
    error = ''
    try {
      const inspection = await oninspect(browser, executablePath.trim())
      if (inspection.ok === true && inspection.runtime) result = inspection.runtime
      else await reportError(String(inspection.message || t('browserUnavailable')))
    } catch (caught) {
      await reportError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally {
      operation = ''
    }
  }

  async function install(repair: boolean) {
    operation = repair ? 'repair' : 'install'
    result = null
    error = ''
    try {
      result = await oninstall(browser, repair)
    } catch (caught) {
      await reportError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally {
      operation = ''
    }
  }

  async function clearPath() {
    operation = 'clear'
    result = null
    error = ''
    try {
      executablePath = ''
      await onclear?.(browser)
      showCustomPath = false
    } catch (caught) {
      await reportError(caught instanceof Error ? caught.message : t('requestFailed'))
      showCustomPath = true
    } finally {
      operation = ''
    }
  }
</script>

<div class="browser-picker" data-testid={`${testId}-browser-runtime-picker`}>
  <label class="field">
    <span>{t('browserSelection')}</span>
    <select name="browser" bind:value={browser} onchange={browserChanged} disabled={busy} data-testid={`${testId}-browser`}>
      {#each visibleOptions as option (option.selection)}
        <option value={option.selection}>{optionLabel(option)}</option>
      {/each}
    </select>
  </label>

  <div class="browser-runtime-summary" class:warning={!selected?.available && !selected?.downloadRequired}>
    <span class:ok={selected?.available} class:warning={!selected?.available} class="status-dot"></span>
    <span>
      <strong>{selected?.displayName ?? browser}</strong>
      <small>
        {#if !catalog}
          {t('scanningBrowsers')}
        {:else if selected?.version}
          {selected.version} · {selected.source === 'tokenless-cache' ? t('managedByTokenless') : t('systemBrowser')}
        {:else if selected?.downloadRequired}
          {t('runtimeDownloadHelp')}
        {:else if selected?.available}
          {t('automaticBrowserHelp')}
        {:else}
          {t('browserNotDetectedHelp')}
        {/if}
      </small>
    </span>
    {#if isManaged && selected?.downloadRequired}
      <button class="button secondary compact-action" type="button" disabled={busy || operation !== ''} onclick={() => install(false)} data-testid={`${testId}-browser-install`}>
        {#if operation === 'install'}<span class="spinner mini"></span>{:else}<Download size={14} />{/if}
        {t('installRuntime')}
      </button>
    {:else if isManaged && selected?.installed && allowRepair}
      <button class="icon-button subtle" type="button" disabled={busy || operation !== ''} aria-label={t('repairRuntime')} title={t('repairRuntime')} onclick={() => install(true)} data-testid={`${testId}-browser-repair`}>
        {#if operation === 'repair'}<span class="spinner mini"></span>{:else}<RefreshCw size={14} />{/if}
      </button>
    {/if}
  </div>

  {#if customPathAllowed}
    <div class="browser-path-control">
      <button class="text-button path-toggle" type="button" disabled={busy} onclick={() => showCustomPath = !showCustomPath} aria-expanded={showCustomPath} data-testid={`${testId}-browser-path-toggle`}>
        {#if showCustomPath}<X size={13} />{t('hideExecutablePath')}{:else}<FolderCog size={13} />{hasConfiguredPath ? t('replaceExecutablePath') : t('addExecutablePath')}{/if}
      </button>
      {#if hasConfiguredPath && !showCustomPath}
        <span class="verified-chip"><CheckCircle2 size={12} />{t('verifiedPathCached')}</span>
      {/if}
    </div>

    {#if showCustomPath}
      <div class="browser-path-panel">
        <label class="field">
          <span>{t('browserExecutablePath')}</span>
          <div class="input-action-row">
            <input
              bind:value={executablePath}
              name="browserExecutablePath"
              autocomplete="off"
              spellcheck="false"
              placeholder={t('browserExecutablePathPlaceholder')}
              aria-describedby={`${testId}-browser-path-help`}
              data-testid={`${testId}-browser-executable-path`}
            />
            <button class="button secondary" type="button" disabled={busy || operation !== '' || !executablePath.trim()} onclick={inspect} data-testid={`${testId}-browser-path-inspect`}>
              {#if operation === 'inspect'}<span class="spinner mini"></span>{:else}<Search size={14} />{/if}
              {t('validate')}
            </button>
          </div>
          <small id={`${testId}-browser-path-help`}>{t('browserExecutablePathHelp')}</small>
        </label>
        {#if pathConfigured}
          <button class="text-button danger-text" type="button" disabled={busy || operation !== ''} onclick={clearPath} data-testid={`${testId}-browser-path-clear`}>
            {t('clearExecutablePath')}
          </button>
        {/if}
      </div>
    {/if}
  {/if}

  {#if result}
    <div class="inline-feedback success" role="status" data-testid={`${testId}-browser-runtime-result`}>
      <CheckCircle2 size={15} />
      <span><strong>{result.displayName}</strong><small>{result.version} · {t('browserValidated')}</small></span>
    </div>
  {:else if error}
    <div bind:this={errorElement} class="inline-feedback error" role="alert" tabindex="-1" data-testid={`${testId}-browser-runtime-error`}>
      <X size={15} /><span>{error}</span>
    </div>
  {/if}
</div>
