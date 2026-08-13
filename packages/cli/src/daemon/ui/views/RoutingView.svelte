<script lang="ts">
  import { untrack } from 'svelte'
  import { RefreshCw } from '@lucide/svelte'
  import {
    CHROME_PROMPT_API_MIN_MAJOR,
    createRouterEngine,
    RouterEngineError,
    type RouterBrowserBinding,
    type RouterEngineId,
    type RouterEngineObservation,
    type RouterProviderCandidate,
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

  let pendingEnabled = $state<boolean | null>(null)
  let task = $state('')
  let availability = $state('disabled')
  let downloadProgress = $state<number | null>(null)
  let availabilityError = $state('')
  let formError = $state('')
  let running = $state(false)
  let result = $state<RouterResult | null>(null)
  let observation = $state<RouterEngineObservation | null>(null)
  let observationBindingKey = $state('')
  let observedAvailabilityContext = $state('')
  let availabilityInvocationId = 0
  let routeInvocationId = 0
  let observedSemanticContext = ''
  const configuredRouter = $derived(snapshot.config.router ?? {})
  const configuredEnabled = $derived(configuredRouter.enabled === true)
  const enabled = $derived(pendingEnabled ?? configuredEnabled)
  const engine: RouterEngineId = $derived(configuredRouter.engine === 'chrome-prompt-api' ? configuredRouter.engine : 'chrome-prompt-api')
  const configuredProviderRules = $derived(normalizedProviderRules())
  const browserBinding = $derived(selectedBrowserBinding())
  const browserBindingKey = $derived(bindingKey(browserBinding))
  const availabilityContext = $derived(`${browserBindingKey}\u0000${enabled ? 'enabled' : 'disabled'}`)
  const currentObservation = $derived(observationBindingKey === browserBindingKey ? observation : null)
  const displayedAvailability = $derived(!enabled ? 'disabled' : observedAvailabilityContext === availabilityContext ? availability : 'checking')
  const displayedAvailabilityError = $derived(enabled && observedAvailabilityContext === availabilityContext ? availabilityError : '')
  const displayedDownloadProgress = $derived(enabled && observedAvailabilityContext === availabilityContext ? downloadProgress : null)
  const providers = $derived(snapshot.providers.filter((provider: JsonRecord) => provider.stage !== 'disabled'))
  const candidates = $derived(buildProviderCandidates())
  const enabledProviderCount = $derived(providers.filter((provider: JsonRecord) => providerState(provider)?.enabled === true).length)
  const semanticContext = $derived(semanticContextSignature())

  $effect(() => {
    const context = availabilityContext
    if (context === observedAvailabilityContext) return
    observedAvailabilityContext = context
    untrack(() => {
      observation = null
      observationBindingKey = ''
      availabilityError = ''
      downloadProgress = null
      availability = enabled ? 'checking' : 'disabled'
      void refreshAvailability()
    })
  })

  $effect(() => {
    const context = semanticContext
    if (context === observedSemanticContext) return
    observedSemanticContext = context
    routeInvocationId += 1
    untrack(() => {
      running = false
      result = null
      formError = ''
    })
  })

  async function refreshAvailability() {
    const binding = selectedBrowserBinding()
    const requestedBindingKey = bindingKey(binding)
    const requestedEnabled = enabled
    const requestedContext = availabilityContext
    const invocationId = ++availabilityInvocationId
    availabilityError = ''
    downloadProgress = null
    if (!requestedEnabled) {
      availability = 'disabled'
      try {
        const inspected = await createRouterEngine(engine).inspect(binding)
        if (!availabilityInvocationMatches(invocationId, requestedContext)) return
        observation = inspected
        observationBindingKey = requestedBindingKey
        if (!inspected.supported) availabilityError = observationMessage(inspected)
      } catch (error) {
        if (!availabilityInvocationMatches(invocationId, requestedContext)) return
        availabilityError = error instanceof Error ? error.message : t('requestFailed')
      }
      return
    }
    availability = 'checking'
    try {
      const inspected = await createRouterEngine(engine).availability(binding)
      if (!availabilityInvocationMatches(invocationId, requestedContext)) return
      observation = inspected.observation
      observationBindingKey = requestedBindingKey
      availability = inspected.status
    } catch (error) {
      if (!availabilityInvocationMatches(invocationId, requestedContext)) return
      if (error instanceof RouterEngineError) {
        if (error.observation) {
          observation = error.observation
          observationBindingKey = requestedBindingKey
        }
        availability = isBrowserBlock(error.code) ? 'blocked' : 'unsupported'
        availabilityError = engineErrorMessage(error)
      } else {
        availability = 'unavailable'
        availabilityError = error instanceof Error ? error.message : t('requestFailed')
      }
    }
  }

  function availabilityInvocationMatches(invocationId: number, requestedContext: string) {
    return invocationId === availabilityInvocationId && requestedContext === availabilityContext
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

  function bindingKey(binding: RouterBrowserBinding) {
    return `${binding.family}\u0000${binding.browserId}\u0000${binding.version ?? ''}`
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

  async function toggleEnabled(checked: boolean) {
    pendingEnabled = checked
    formError = ''
    try {
      await onmutate('/config', {
        router: { enabled: checked, engine, providers: normalizedProviderRules() },
      }, 'PATCH')
    } catch (error) {
      formError = error instanceof Error ? error.message : t('requestFailed')
    } finally {
      pendingEnabled = null
    }
  }

  function selectedProfileState() {
    return snapshot.profiles?.find((profile: JsonRecord) => profile.slug === selectedProfile || profile.id === selectedProfile)
  }

  function providerState(provider: JsonRecord) {
    const profile = selectedProfileState()
    return provider.profiles?.find((state: JsonRecord) => state.profileId === profile?.slug)
  }

  function selectedModel(provider: JsonRecord) {
    const choices = providerState(provider)?.controls?.model
    const selected = Array.isArray(choices) ? choices.find((choice: JsonRecord) => choice.selected === true) : null
    return typeof selected?.label === 'string' ? selected.label : null
  }

  function normalizedProviderRules(): Array<{ id: string; suitableTasks: string }> {
    const rules = Array.isArray(configuredRouter.providers) ? configuredRouter.providers : []
    return rules.flatMap((rule: JsonRecord) => {
      const id = typeof rule.id === 'string' ? rule.id : ''
      const suitableTasks = typeof rule.suitableTasks === 'string' ? rule.suitableTasks.trim() : ''
      return id && suitableTasks ? [{ id, suitableTasks }] : []
    })
  }

  function buildProviderCandidates(): RouterProviderCandidate[] {
    return providers.flatMap((provider: JsonRecord) => {
      const suitableTasks = configuredProviderRules.find((rule) => rule.id === provider.id)?.suitableTasks
      if (providerState(provider)?.enabled !== true || !suitableTasks) return []
      return [{ providerId: provider.id, label: provider.label, suitableTasks, model: selectedModel(provider) }]
    })
  }

  function semanticContextSignature() {
    return JSON.stringify([
      selectedProfile,
      enabled,
      browserBindingKey,
      candidates.map((candidate) => [candidate.providerId, candidate.suitableTasks, candidate.model ?? null]),
      task,
    ])
  }

  function routeInvocationMatches(invocationId: number, context: string) {
    return invocationId === routeInvocationId && context === semanticContext
  }

  async function run() {
    if (!enabled) {
      formError = t('routerDisabledError')
      return
    }
    if (enabledProviderCount === 0) {
      formError = t('routerNeedsEnabledProviders')
      return
    }
    if (candidates.length === 0) {
      formError = t('routerNeedsProviderRules')
      return
    }
    if (!task.trim()) {
      formError = t('routerTaskRequired')
      return
    }
    formError = ''
    result = null
    running = true
    downloadProgress = null
    const binding = selectedBrowserBinding()
    const requestedBindingKey = bindingKey(binding)
    const requestedContext = semanticContext
    const requestedAvailabilityContext = availabilityContext
    const invocationId = ++routeInvocationId
    const availabilityId = ++availabilityInvocationId
    try {
      const routedResult = await createRouterEngine(engine).route(task.trim(), candidates, binding, {
        onObservation(value) {
          if (!routeInvocationMatches(invocationId, requestedContext) || !availabilityInvocationMatches(availabilityId, requestedAvailabilityContext)) return
          observation = value
          observationBindingKey = requestedBindingKey
        },
        onAvailability(value) {
          if (routeInvocationMatches(invocationId, requestedContext) && availabilityInvocationMatches(availabilityId, requestedAvailabilityContext)) availability = value
        },
        onDownloadProgress(value) {
          if (routeInvocationMatches(invocationId, requestedContext) && availabilityInvocationMatches(availabilityId, requestedAvailabilityContext)) downloadProgress = value
        },
      })
      if (!routeInvocationMatches(invocationId, requestedContext)) return
      result = routedResult
    } catch (error) {
      if (!routeInvocationMatches(invocationId, requestedContext)) return
      if (error instanceof RouterEngineError) {
        if (availabilityInvocationMatches(availabilityId, requestedAvailabilityContext)) {
          if (error.observation) {
            observation = error.observation
            observationBindingKey = requestedBindingKey
          }
          availability = isBrowserBlock(error.code) ? 'blocked' : error.code === 'unavailable' ? 'unavailable' : 'unsupported'
        }
        formError = engineErrorMessage(error)
      } else {
        formError = error instanceof Error ? error.message : t('requestFailed')
      }
    } finally {
      if (routeInvocationMatches(invocationId, requestedContext)) running = false
    }
  }
</script>

<section class="providers-router" data-testid="routing-view">
  <header class="providers-router-header">
    <h2>{t('experimentalRouter')}</h2>
    <p>{t('routingLede')}</p>
  </header>

  <section class="settings-section system-card routing-api-card">
    <div class="settings-section-title">
      <div><h2>{t('routerEngine')}</h2><p>{t('routerExperimentNote')}</p></div>
      <label class="switch" title={enabled ? t('enabled') : t('disabled')} data-testid="router-enabled-control">
        <input type="checkbox" checked={enabled} disabled={busy} onchange={(event) => void toggleEnabled(event.currentTarget.checked)} data-testid="router-enabled" />
        <span></span>
      </label>
    </div>
    <label class="field compact-field router-engine-field">
      <span>{t('routerEngine')}</span>
      <select value={engine} disabled data-testid="router-engine">
        <option value="chrome-prompt-api">{t('chromePromptApiEngine')}</option>
      </select>
      <small>{t('routerEngineHelp')}</small>
    </label>
    <div class="router-compatibility" data-testid="router-compatibility">
      <div><small>{t('selectedBrowser')}</small><strong>{browserBinding.family} · {browserBinding.browserId}</strong></div>
      <div><small>{t('browserVersion')}</small><strong>{currentObservation?.browserVersion ?? browserBinding.version ?? t('unknown')}</strong></div>
      <div><small>{t('routerRequirement')}</small><strong>Google Chrome {CHROME_PROMPT_API_MIN_MAJOR}+</strong></div>
    </div>
    <div class="router-status-row">
      <div class="router-availability" data-testid="router-availability">
        <span class:ok={displayedAvailability === 'available'} class:warning={displayedAvailability === 'downloadable' || displayedAvailability === 'downloading'} class:error={displayedAvailability === 'unavailable' || displayedAvailability === 'unsupported' || displayedAvailability === 'blocked'} class="status-dot"></span>
        <span><small>{t('availability')}</small><strong>{displayedAvailability}</strong>{#if displayedDownloadProgress !== null}<small>{t('downloadProgress')}: {displayedDownloadProgress}%</small>{/if}</span>
      </div>
      <button class="icon-button subtle" type="button" disabled={!enabled} aria-label={t('refresh')} title={t('refresh')} onclick={refreshAvailability}>
        <RefreshCw size={15} />
      </button>
    </div>
    {#if displayedDownloadProgress === 0}<div class="inline-feedback warning" data-testid="router-download-zero">{t('downloadZeroHelp')}</div>{/if}
    {#if displayedAvailabilityError}<div class="inline-feedback error" role="alert">{displayedAvailabilityError}</div>{/if}
    {#if formError}<div class="inline-feedback error" role="alert" data-testid="router-error">{formError}</div>{/if}
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

  <section class="settings-section system-card router-run-card">
    <div class="settings-section-title"><div><h2>{t('routerTest')}</h2><p>{t('routerTestHelp')}</p></div></div>
    <label class="field"><span>{t('taskPrompt')}</span><textarea bind:value={task} maxlength="4000" placeholder={t('taskPromptPlaceholder')} data-testid="router-prompt"></textarea></label>
    {#if enabledProviderCount === 0}<div class="inline-feedback error" data-testid="router-provider-block">{t('routerNeedsEnabledProviders')}</div>
    {:else if candidates.length === 0}<div class="inline-feedback warning" data-testid="router-provider-block">{t('routerNeedsProviderRules')}</div>{/if}
    <div class="form-actions"><button class="button primary" type="button" disabled={!enabled || running || busy || displayedAvailability === 'checking' || currentObservation?.supported === false || candidates.length === 0} onclick={run} data-testid="router-run">{running ? t('routerRunning') : t('runSemanticRouter')}</button></div>
    {#if result}<div class="router-result" data-testid="router-result"><h3>{t('routerResult')}</h3><pre>{JSON.stringify(result, null, 2)}</pre></div>{/if}
  </section>
</section>
