<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { Plus, RefreshCw, Trash2 } from '@lucide/svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import type { JsonRecord } from '../types.js'
  import type { MessageKey } from '../localization.js'

  type RouterModel = {
    id: string
    label: string
    suitableTasks: string
  }

  type LanguageModelSession = {
    prompt: (input: string, options: { responseConstraint: JsonRecord }) => Promise<string>
    destroy?: () => void
  }

  type LanguageModelApi = {
    availability: () => Promise<string>
    create: (options: {
      monitor: (monitor: {
        addEventListener: (type: 'downloadprogress', listener: (event: { loaded: number }) => void) => void
      }) => void
    }) => Promise<LanguageModelSession>
  }

  const semanticInstruction = 'Analyze the task. Choose the candidate model whose suitableTasks best matches it. Return the task type, complexity, and a concise reason.'

  let {
    snapshot,
    t,
    busy,
    onmutate,
  }: {
    snapshot: JsonRecord
    t: (key: MessageKey) => string
    busy: boolean
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
  } = $props()

  let models = $state<RouterModel[]>(untrack(() => (
    snapshot.config.semanticRouter?.models?.map((model: RouterModel) => ({ ...model })) ?? []
  )))
  let task = $state('')
  let availability = $state('checking')
  let downloadProgress = $state<number | null>(null)
  let availabilityError = $state('')
  let formError = $state('')
  let running = $state(false)
  let result = $state<JsonRecord | null>(null)

  onMount(() => { void refreshAvailability() })

  function languageModelApi() {
    return (window as Window & { LanguageModel?: LanguageModelApi }).LanguageModel
  }

  async function refreshAvailability() {
    availabilityError = ''
    downloadProgress = null
    const api = languageModelApi()
    if (!api) {
      availability = 'unsupported'
      return
    }
    availability = 'checking'
    try {
      availability = await api.availability()
    } catch (error) {
      availability = 'unavailable'
      availabilityError = error instanceof Error ? error.message : t('requestFailed')
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
      await onmutate('/config', { semanticRouter: { models: normalized } }, 'PATCH')
      models = normalized
    } catch (error) {
      formError = error instanceof Error ? error.message : t('requestFailed')
    }
  }

  async function run() {
    formError = validateModels(true)
    if (formError) return
    if (!task.trim()) {
      formError = t('routerTaskRequired')
      return
    }
    result = null
    running = true
    downloadProgress = null
    let session: LanguageModelSession | undefined
    try {
      const api = languageModelApi()
      if (!api) {
        availability = 'unsupported'
        throw new Error(t('routerApiUnsupported'))
      }
      availability = await api.availability()
      if (availability === 'unavailable') throw new Error(t('routerApiUnavailable'))
      const candidates = normalizedModels()
      if (availability === 'downloadable' || availability === 'downloading') {
        availability = 'downloading'
        downloadProgress = 0
      }
      session = await api.create({
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            availability = 'downloading'
            downloadProgress = Math.round(Math.min(1, Math.max(0, event.loaded)) * 100)
          })
        },
      })
      availability = 'available'
      downloadProgress = null
      const response = await session.prompt(`${semanticInstruction}\n${JSON.stringify({
        task: task.trim(),
        modelConfiguration: candidates,
      })}`, {
        responseConstraint: {
          type: 'object',
          properties: {
            modelId: { type: 'string', enum: candidates.map((model) => model.id) },
            taskType: { type: 'string' },
            complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
            reason: { type: 'string' },
          },
          required: ['modelId', 'taskType', 'complexity', 'reason'],
          additionalProperties: false,
        },
      })
      const parsed = JSON.parse(response) as JsonRecord
      if (!candidates.some((model) => model.id === parsed.modelId)) throw new Error(t('routerInvalidResult'))
      result = parsed
    } catch (error) {
      formError = error instanceof Error ? error.message : t('requestFailed')
    } finally {
      session?.destroy?.()
      running = false
    }
  }
</script>

<section class="page routing-page" data-testid="routing-view">
  <PageHeader title={t('semanticRouting')} description={t('routingLede')} />

  <section class="settings-section system-card routing-api-card">
    <div class="settings-section-title">
      <div><h2>{t('nanoApi')}</h2><p>{t('routerExperimentNote')}</p></div>
      <button class="icon-button subtle" type="button" aria-label={t('refresh')} title={t('refresh')} onclick={refreshAvailability}>
        <RefreshCw size={15} />
      </button>
    </div>
    <div class="router-availability" data-testid="router-availability">
      <span class:ok={availability === 'available'} class:warning={availability === 'downloadable' || availability === 'downloading'} class:error={availability === 'unavailable' || availability === 'unsupported'} class="status-dot"></span>
      <span><small>{t('availability')}</small><strong>{availability}</strong>{#if downloadProgress !== null}<small>{t('downloadProgress')}: {downloadProgress}%</small>{/if}</span>
    </div>
    {#if availabilityError}<div class="inline-feedback error" role="alert">{availabilityError}</div>{/if}
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
    <div class="form-actions"><button class="button primary" type="button" disabled={running || busy} onclick={run} data-testid="router-run">{running ? t('routerRunning') : t('runSemanticRouter')}</button></div>
    {#if formError}<div class="inline-feedback error" role="alert" data-testid="router-error">{formError}</div>{/if}
    {#if result}<div class="router-result" data-testid="router-result"><h3>{t('routerResult')}</h3><pre>{JSON.stringify(result, null, 2)}</pre></div>{/if}
  </section>
</section>
