<script lang="ts">
  import { untrack } from 'svelte'
  import { RefreshCw } from '@lucide/svelte'
import {
    CHROME_PROMPT_API_MIN_MAJOR,
    createGeminiNanoAiEngine,
    createRouterEngine,
    RouterEngineError,
    type RouterBrowserBinding,
    type RouterEngineId,
    type RouterEngineObservation,
    type RouterProviderCandidate,
    type RouterResult,
  } from '../router-engine.js'
  import {
    createHarnessFrontDoorSidecar,
    HarnessSidecarError,
    type HarnessFrontDoorResult,
  } from 'tokenless-internal-shared/harness-sidecar'
  import type { DashboardActions, DashboardHarnessRunView, DashboardProvider, DashboardSnapshot } from '../types.js'
  import type { MessageKey } from '../i18n/index.js'

  let {
    snapshot,
    selectedProfile,
    t,
    busy,
    actions,
  }: {
    snapshot: DashboardSnapshot
    selectedProfile: string
    t: (key: MessageKey) => string
    busy: boolean
    actions: DashboardActions
  } = $props()

  let pendingEnabled = $state<boolean | null>(null)
  let task = $state('')
  let availability = $state('disabled')
  let downloadProgress = $state<number | null>(null)
  let availabilityError = $state('')
  let formError = $state('')
  let running = $state(false)
  let result = $state<RouterResult | null>(null)
  let frontDoorResult = $state<HarnessFrontDoorResult | null>(null)
  let harnessRun = $state<DashboardHarnessRunView | null>(null)
  let startingHarnessRun = $state(false)
  let observation = $state<RouterEngineObservation | null>(null)
  let observationBindingKey = $state('')
  let observedAvailabilityContext = $state('')
  let availabilityInvocationId = 0
  let routeInvocationId = 0
  let observedSemanticContext = ''
  const configuredRouter = $derived(snapshot.config.router)
  const configuredEnabled = $derived(configuredRouter.enabled)
  const enabled = $derived(pendingEnabled ?? configuredEnabled)
  const engine: RouterEngineId = $derived(configuredRouter.engine)
  const configuredProviderRules = $derived(normalizedProviderRules())
  const browserBinding = $derived(selectedBrowserBinding())
  const browserBindingKey = $derived(bindingKey(browserBinding))
  const availabilityContext = $derived(`${engine}\u0000${enabled ? 'enabled' : 'disabled'}`)
  const currentObservation = $derived(observationBindingKey === availabilityContext ? observation : null)
  const displayedAvailability = $derived(!enabled ? 'disabled' : observedAvailabilityContext === availabilityContext ? availability : 'checking')
  const displayedAvailabilityError = $derived(enabled && observedAvailabilityContext === availabilityContext ? availabilityError : '')
  const displayedDownloadProgress = $derived(enabled && observedAvailabilityContext === availabilityContext ? downloadProgress : null)
  const providers = $derived(snapshot.providers.filter((provider) => provider.stage !== 'disabled' && provider.executionModes.includes('browser')))
  const candidates = $derived(buildProviderCandidates())
  const enabledProviderCount = $derived(providers.filter((provider) => providerState(provider)?.enabled === true).length)
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
      frontDoorResult = null
      harnessRun = null
      formError = ''
    })
  })

  async function refreshAvailability() {
    const binding = selectedBrowserBinding()
    const requestedEnabled = enabled
    const requestedContext = availabilityContext
    const requestedBindingKey = requestedContext
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
    const profile = snapshot.profiles.find((candidate) => (
      candidate.slug === selectedProfile
    ))
    const binding = profile?.browserBinding
    return {
      browserId: binding?.browserId ?? snapshot.config.browser,
      family: binding?.family ?? 'system',
      version: binding?.version ?? null,
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
      await actions.updateConfig({
        router: { enabled: checked, engine, providers: normalizedProviderRules() },
      })
    } catch (error) {
      formError = error instanceof Error ? error.message : t('requestFailed')
    } finally {
      pendingEnabled = null
    }
  }

  function selectedProfileState() {
    return snapshot.profiles.find((profile) => profile.slug === selectedProfile)
  }

  function providerState(provider: DashboardProvider) {
    const profile = selectedProfileState()
    return provider.profiles.find((state) => state.profileId === profile?.slug)
  }

  function selectedModel(provider: DashboardProvider) {
    const choices = providerState(provider)?.controls?.model
    return choices?.find((choice) => choice.selected)?.label ?? null
  }

  function normalizedProviderRules(): Array<{ id: string; suitableTasks: string }> {
    return configuredRouter.providers.flatMap((rule) => {
      const id = rule.id
      const suitableTasks = rule.suitableTasks.trim()
      return id && suitableTasks ? [{ id, suitableTasks }] : []
    })
  }

  function buildProviderCandidates(): RouterProviderCandidate[] {
    return providers.flatMap((provider) => {
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
    frontDoorResult = null
    harnessRun = null
    running = true
    downloadProgress = null
    const binding = selectedBrowserBinding()
    const requestedBindingKey = bindingKey(binding)
    const requestedContext = semanticContext
    const invocationId = ++routeInvocationId
    try {
      const prepared = await createHarnessFrontDoorSidecar(createGeminiNanoAiEngine()).prepare({
        taskPrompt: task.trim(),
        providers: candidates,
        browserBinding: binding,
      })
      if (!routeInvocationMatches(invocationId, requestedContext)) return
      frontDoorResult = prepared
      result = prepared.route
    } catch (error) {
      if (!routeInvocationMatches(invocationId, requestedContext)) return
      if (error instanceof RouterEngineError) {
        if (error.observation) {
          observation = error.observation
          observationBindingKey = requestedBindingKey
        }
        availability = isBrowserBlock(error.code) ? 'blocked' : error.code === 'unavailable' ? 'unavailable' : 'unsupported'
        formError = engineErrorMessage(error)
      } else if (error instanceof HarnessSidecarError) {
        formError = error.message
      } else {
        formError = error instanceof Error ? error.message : t('requestFailed')
      }
    } finally {
      if (routeInvocationMatches(invocationId, requestedContext)) running = false
    }
  }

  async function startHarnessRun() {
    if (!frontDoorResult || startingHarnessRun) return
    const profile = selectedProfileState()
    if (!profile) {
      formError = t('harnessProfileRequired')
      return
    }
    formError = ''
    startingHarnessRun = true
    try {
      const started = await actions.startHarnessRun({
        provider: frontDoorResult.route.providerId,
        profileId: profile.slug,
        taskPrompt: task.trim(),
      })
      harnessRun = await actions.readHarnessRun(started.runId)
    } catch (error) {
      formError = error instanceof Error ? error.message : t('requestFailed')
    } finally {
      startingHarnessRun = false
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
      <div><small>{t('rendererBrowser')}</small><strong>{currentObservation?.browserFamily ?? t('unknown')} · {currentObservation?.browserId ?? t('unknown')}</strong></div>
      <div><small>{t('browserVersion')}</small><strong>{currentObservation?.browserVersion ?? t('unknown')}</strong></div>
      <div><small>{t('routerRequirement')}</small><strong>{t('routerBrowserRequirement')}</strong></div>
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
    {#if result}<div class="router-result" data-testid="router-result"><h3>{t('routerResult')}</h3><pre>{JSON.stringify(result, null, 2)}</pre><button class="button secondary" type="button" disabled={startingHarnessRun || busy} onclick={startHarnessRun} data-testid="harness-run">{startingHarnessRun ? t('harnessStarting') : t('startHarnessRun')}</button>{#if harnessRun}<p class="muted" data-testid="harness-run-status">{t('harnessRun')}: {harnessRun.runId} · {harnessRun.status}</p>{/if}</div>{/if}
  </section>
</section>
