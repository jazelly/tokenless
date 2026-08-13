<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { Plus, RefreshCw, Trash2 } from '@lucide/svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import {
    CHROME_PROMPT_API_MIN_MAJOR,
    createRouterEngine,
    RouterEngineError,
    type RouterBrowserBinding,
    type RouterEngineId,
    type RouterEngineObservation,
    type RouterModel,
    type RouterResult,
  } from '../router-engine.js'
  import type { JsonRecord } from '../types.js'
  import type { MessageKey } from '../localization.js'

  let {
    snapshot,
    selectedProfile,
    t,
    busy,
    onmutate,
  }: {
    snapshot: JsonRecord
    selectedProfile: string
    t: (key: MessageKey) => string
    busy: boolean
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
  } = $props()

  const initialRouter = untrack(() => snapshot.config.router ?? {})
  const initialEnabled = initialRouter.enabled === true
  let enabled = $state(initialEnabled)
  let engine = $state<RouterEngineId>(initialRouter.engine === 'chrome-prompt-api' ? initialRouter.engine : 'chrome-prompt-api')
  let models = $state<RouterModel[]>(initialRouter.models?.map((model: RouterModel) => ({ ...model })) ?? [])
  let task = $state('')
  let availability = $state(initialEnabled ? 'checking' : 'disabled')
  let downloadProgress = $state<number | null>(null)
  let availabilityError = $state('')
  let formError = $state('')
  let running = $state(false)
  let result = $state<RouterResult | null>(null)
  let observation = $state<RouterEngineObservation | null>(null)
  const browserBinding = $derived(selectedBrowserBinding())

  onMount(() => { void refreshAvailability() })

  async function refreshAvailability() {
    availabilityError = ''
    downloadProgress = null
    if (!enabled) {
      availability = 'disabled'
      try {
        observation = await createRouterEngine(engine).inspect(selectedBrowserBinding())
        if (!observation.supported) availabilityError = observationMessage(observation)
      } catch (error) {
        availabilityError = error instanceof Error ? error.message : t('requestFailed')
      }
      return
    }
    availability = 'checking'
    try {
      const inspected = await createRouterEngine(engine).availability(selectedBrowserBinding())
      observation = inspected.observation
      availability = inspected.status
    } catch (error) {
      if (error instanceof RouterEngineError) {
        if (error.observation) observation = error.observation
        availability = isBrowserBlock(error.code) ? 'blocked' : 'unsupported'
        availabilityError = engineErrorMessage(error)
      } else {
        availability = 'unavailable'
        availabilityError = error instanceof Error ? error.message : t('requestFailed')
      }
    }
  }

  function selectedBrowserBinding(): RouterBrowserBinding {
    const profile = snapshot.profiles?.find((candidate: JsonRecord) => (
      candidate.slug === selectedProfile || candidate.id === selectedProfile
    ))
    const binding = profile?.browserBinding
    return {
      browserId: typeof binding?.browserId === 'string' ? binding.browserId : String(snapshot.config.browser ?? ''),
      family: typeof binding?.family === 'string' ? binding.family : 'system',
      version: typeof binding?.version === 'string' ? binding.version : null,
    }
  }

  function isBrowserBlock(code: RouterEngineError['code']) {
    return code === 'unsupported-browser-mode' || code === 'unsupported-browser' || code === 'unsupported-version'
  }

  function observationMessage(value: RouterEngineObservation) {
    if (value.code === 'unsupported-browser-mode') return t('routerBrowserModeUnsupported')
    if (value.code === 'unsupported-browser') return t('routerBrowserUnsupported')
    if (value.code === 'unsupported-version') {
      return `${t('routerBrowserVersionUnsupported')} ${value.browserVersion ?? t('unknown')}.`
    }
    if (value.code === 'api-missing') return t('routerApiUnsupported')
    return ''
  }

  function engineErrorMessage(error: RouterEngineError) {
    if (error.observation) {
      const message = observationMessage(error.observation)
      if (message) return message
    }
    if (error.code === 'unavailable') return t('routerApiUnavailable')
    if (error.code === 'invalid-result') return t('routerInvalidResult')
    return t('routerApiUnsupported')
  }

  function toggleEnabled(checked: boolean) {
    enabled = checked
    if (checked) void refreshAvailability()
    else {
      availability = 'disabled'
      availabilityError = ''
      downloadProgress = null
    }
  }

  function addModel() {
    if (models.length >= 20) return
    models = [...models, { id: '', label: '', suitableTasks: '' }]
  }

  function removeModel(index: number) {
    models = models.filter((_, candidate) => candidate !== index)
  }

  function normalizedModels() {
    return models.map((model) => ({
      id: model.id.trim(),
      label: model.label.trim(),
      suitableTasks: model.suitableTasks.trim(),
    }))
  }

  function validateModels(requireCandidate = false) {
    const normalized = normalizedModels()
    if (requireCandidate && normalized.length === 0) return t('routerNeedsModels')
    const ids = new Set<string>()
    for (const model of normalized) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(model.id) || !model.label || !model.suitableTasks || ids.has(model.id)) {
        return t('routerConfigInvalid')
      }
      ids.add(model.id)
    }
    return ''
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    formError = validateModels()
    if (formError) return
    try {
      const normalized = normalizedModels()
      await onmutate('/config', { router: { enabled, engine, models: normalized } }, 'PATCH')
      models = normalized
    } catch (error) {
      formError = error instanceof Error ? error.message : t('requestFailed')
    }
  }

  async function run() {
    if (!enabled) {
      formError = t('routerDisabledError')
      return
    }
    formError = validateModels(true)
    if (formError) return
    if (!task.trim()) {
      formError = t('routerTaskRequired')
      return
    }
    result = null
    running = true
    downloadProgress = null
    try {
      const candidates = normalizedModels()
      result = await createRouterEngine(engine).route(task.trim(), candidates, selectedBrowserBinding(), {
        onObservation(value) { observation = value },
        onAvailability(value) { availability = value },
        onDownloadProgress(value) { downloadProgress = value },
      })
    } catch (error) {
      if (error instanceof RouterEngineError) {
        if (error.observation) observation = error.observation
        availability = isBrowserBlock(error.code) ? 'blocked' : error.code === 'unavailable' ? 'unavailable' : 'unsupported'
        formError = engineErrorMessage(error)
      } else {
        formError = error instanceof Error ? error.message : t('requestFailed')
      }
    } finally {
      running = false
    }
  }
</script>

<section class="page routing-page" data-testid="routing-view">
  <PageHeader title={t('experimentalRouter')} description={t('routingLede')} />

  <section class="settings-section system-card routing-api-card">
    <div class="settings-section-title">
      <div><h2>{t('routerEngine')}</h2><p>{t('routerExperimentNote')}</p></div>
      <label class="switch" title={enabled ? t('enabled') : t('disabled')} data-testid="router-enabled-control">
        <input type="checkbox" checked={enabled} disabled={busy} onchange={(event) => toggleEnabled(event.currentTarget.checked)} data-testid="router-enabled" />
        <span></span>
      </label>
    </div>
    <label class="field compact-field router-engine-field">
      <span>{t('routerEngine')}</span>
      <select bind:value={engine} disabled={busy} data-testid="router-engine">
        <option value="chrome-prompt-api">{t('chromePromptApiEngine')}</option>
      </select>
      <small>{t('routerEngineHelp')}</small>
    </label>
    <div class="router-compatibility" data-testid="router-compatibility">
      <div><small>{t('selectedBrowser')}</small><strong>{browserBinding.family} · {browserBinding.browserId}</strong></div>
      <div><small>{t('browserVersion')}</small><strong>{observation?.browserVersion ?? browserBinding.version ?? t('unknown')}</strong></div>
      <div><small>{t('routerRequirement')}</small><strong>Google Chrome {CHROME_PROMPT_API_MIN_MAJOR}+</strong></div>
    </div>
    <div class="router-status-row">
      <div class="router-availability" data-testid="router-availability">
        <span class:ok={availability === 'available'} class:warning={availability === 'downloadable' || availability === 'downloading'} class:error={availability === 'unavailable' || availability === 'unsupported' || availability === 'blocked'} class="status-dot"></span>
        <span><small>{t('availability')}</small><strong>{availability}</strong>{#if downloadProgress !== null}<small>{t('downloadProgress')}: {downloadProgress}%</small>{/if}</span>
      </div>
      <button class="icon-button subtle" type="button" disabled={!enabled} aria-label={t('refresh')} title={t('refresh')} onclick={refreshAvailability}>
        <RefreshCw size={15} />
      </button>
    </div>
    {#if downloadProgress === 0}<div class="inline-feedback warning" data-testid="router-download-zero">{t('downloadZeroHelp')}</div>{/if}
    {#if availabilityError}<div class="inline-feedback error" role="alert">{availabilityError}</div>{/if}
  </section>

  <section class="settings-section system-card router-setup" data-testid="router-chrome-setup">
    <div class="settings-section-title"><div><h2>{t('chromeSetup')}</h2><p>{t('chromeSetupIntro')}</p></div></div>
    <ol>
      <li>{t('chromeSetupOptimization')} <code>chrome://flags/#optimization-guide-on-device-model</code></li>
      <li>{t('chromeSetupPrompt')} <code>chrome://flags/#prompt-api-for-gemini-nano</code></li>
      <li>{t('chromeSetupRelaunch')}</li>
      <li>{t('chromeSetupInspect')} <code>chrome://on-device-internals</code></li>
    </ol>
    <p>{t('chromeModelVersionHelp')}</p>
  </section>

  <form class="settings-section system-card router-config" onsubmit={save} data-testid="router-config-form">
    <div class="settings-section-title">
      <div><h2>{t('routerModels')}</h2><p>{t('routerModelsHelp')}</p></div>
      <button class="button secondary icon-label" type="button" disabled={models.length >= 20 || busy} onclick={addModel} data-testid="router-add-model"><Plus size={15} />{t('addModel')}</button>
    </div>
    <div class="router-model-list">
      {#each models as model, index}
        <div class="router-model-row" data-testid={`router-model-${index}`}>
          <label class="field"><span>{t('modelId')}</span><input bind:value={model.id} required maxlength="64" autocomplete="off" spellcheck="false" /></label>
          <label class="field"><span>{t('modelLabel')}</span><input bind:value={model.label} required maxlength="80" autocomplete="off" /></label>
          <label class="field router-tasks-field"><span>{t('suitableTasks')}</span><input bind:value={model.suitableTasks} required maxlength="500" placeholder={t('suitableTasksPlaceholder')} autocomplete="off" /></label>
          <button class="icon-button subtle router-remove" type="button" aria-label={t('remove')} title={t('remove')} onclick={() => removeModel(index)}><Trash2 size={15} /></button>
        </div>
      {:else}
        <p class="router-empty">{t('routerNeedsModels')}</p>
      {/each}
    </div>
    <div class="form-actions"><button class="button primary" type="submit" disabled={busy} data-testid="router-save">{t('save')}</button></div>
  </form>

  <section class="settings-section system-card router-run-card">
    <div class="settings-section-title"><div><h2>{t('routerTest')}</h2><p>{t('routerTestHelp')}</p></div></div>
    <label class="field"><span>{t('taskPrompt')}</span><textarea bind:value={task} maxlength="4000" placeholder={t('taskPromptPlaceholder')} data-testid="router-prompt"></textarea></label>
    <div class="form-actions"><button class="button primary" type="button" disabled={!enabled || running || busy || availability === 'checking' || observation?.supported === false} onclick={run} data-testid="router-run">{running ? t('routerRunning') : t('runSemanticRouter')}</button></div>
    {#if formError}<div class="inline-feedback error" role="alert" data-testid="router-error">{formError}</div>{/if}
    {#if result}<div class="router-result" data-testid="router-result"><h3>{t('routerResult')}</h3><pre>{JSON.stringify(result, null, 2)}</pre></div>{/if}
  </section>
</section>
