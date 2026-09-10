<script lang="ts">
  import TokenUnit from '../components/TokenUnit.svelte'
  import { onMount, tick, untrack } from 'svelte'
  import {
    CircleHelp,
    Clipboard,
    PauseCircle,
    Plus,
    RefreshCw,
    Save,
    Trash2,
  } from '@lucide/svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatNumber, formatTime } from '../formatting.js'
  import { stateLabel, type MessageKey } from '../i18n/index.js'
  import type {
    DashboardActions,
    DashboardConfigDocument,
    DashboardConfigUpdate,
    DashboardDiagnostic,
    DashboardProfile,
    DashboardProfileConfig,
    DashboardProviderExecutionMode,
    DashboardRouterConfig,
    DashboardSnapshot,
    Language,
  } from '../types.js'

  type ProfileDraft = {
    slug: string
    roleLabel: string
    enabledProviders: string[]
    providerModes: Record<string, DashboardProviderExecutionMode[]>
    proxyEnabled: boolean
    proxyServer: string
    proxyBypass: string
    runtimeBinding: DashboardProfileConfig['runtimeBinding']
  }

  type GlobalDraft = {
    language: Language
    browser: 'chrome' | 'brave'
    browserExecutablePath: string
    daemonUrl: string
    defaultProfile: string
    browserTabGc: DashboardConfigDocument['browserTabGc']
    apiProxy: DashboardConfigDocument['apiProxy']
    g4f: DashboardConfigDocument['g4f']
    directProvider: DashboardConfigDocument['directProvider']
    router: DashboardRouterConfig
  }

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

  const initialDefaultProfile = untrack(() => snapshot.profiles.find((profile) => profile.isDefault)?.slug ?? '')
  let global = $state<GlobalDraft>({
    language: untrack(() => snapshot.config.language as Language),
    browser: untrack(() => snapshot.config.browser === 'brave' ? 'brave' : 'chrome'),
    browserExecutablePath: '',
    daemonUrl: untrack(() => snapshot.config.daemonUrl ?? ''),
    defaultProfile: initialDefaultProfile,
    browserTabGc: untrack(() => ({ ...snapshot.config.browserTabGc })),
    apiProxy: { enabled: false, executionMode: 'direct' },
    g4f: untrack(() => ({ ...snapshot.config.g4f })),
    directProvider: untrack(() => ({
      defaultBackend: snapshot.config.directProvider.defaultBackend,
      providerBackends: { ...snapshot.config.directProvider.providerBackends },
    })),
    router: untrack(() => cloneRouter(snapshot.config.router)),
  })
  const initialProfileDrafts = untrack(() => Object.fromEntries(
    snapshot.profiles.map((profile) => [profile.slug, draftProfile(profile)]),
  ))
  let profileDrafts = $state<Record<string, ProfileDraft>>(initialProfileDrafts)
  let configDocument = $state<DashboardConfigDocument | null>(null)
  let documentLoading = $state(false)
  let documentError = $state('')
  let showJson = $state(false)
  let formError = $state('')
  let errorElement = $state<HTMLDivElement>()
  let directProviderId = $state('')
  let routerProviderId = $state('')

  onMount(() => {
    void loadConfigDocument(true)
  })

  async function fetchConfigDocument() {
    documentLoading = true
    documentError = ''
    try {
      const document = await actions.getConfigDocument()
      configDocument = document
      return document
    } catch (error) {
      documentError = error instanceof Error ? error.message : t('requestFailed')
      return null
    } finally {
      documentLoading = false
    }
  }

  function hydrateDrafts(document: DashboardConfigDocument) {
    global.language = document.language as Language
    global.browser = document.browser === 'brave' ? 'brave' : 'chrome'
    global.browserExecutablePath = document.browserExecutablePath ?? ''
    global.daemonUrl = document.daemonUrl ?? ''
    global.defaultProfile = document.defaultProfile ?? ''
    global.browserTabGc = { ...document.browserTabGc }
    global.apiProxy = { ...document.apiProxy }
    global.g4f = { ...document.g4f }
    global.directProvider = {
      defaultBackend: document.directProvider.defaultBackend,
      providerBackends: { ...document.directProvider.providerBackends },
    }
    global.router = cloneRouter(document.router)
    profileDrafts = Object.fromEntries(
      Object.entries(document.profiles).map(([slug, profile]) => [slug, draftProfileFromConfig(slug, profile)]),
    )
  }

  async function loadConfigDocument(hydrate = false) {
    const document = await fetchConfigDocument()
    if (document && hydrate) hydrateDrafts(document)
  }

  async function toggleJsonView() {
    showJson = !showJson
    if (showJson) await fetchConfigDocument()
  }

  async function refreshConfigDocument() {
    await fetchConfigDocument()
  }

  async function showFormError(message: string) {
    formError = message
    await tick()
    errorElement?.focus()
  }

  async function saveGlobal(event: SubmitEvent) {
    event.preventDefault()
    formError = ''
    const input: DashboardConfigUpdate = {
      defaultProfile: global.defaultProfile || null,
      language: global.language,
      browser: global.browser,
      browserExecutablePath: global.browserExecutablePath.trim() || null,
      browserVisibility: 'headed',
      daemonUrl: global.daemonUrl.trim() || null,
      apiProxy: { ...global.apiProxy },
      g4f: { ...global.g4f },
      directProvider: {
        defaultBackend: global.directProvider.defaultBackend,
        providerBackends: { ...global.directProvider.providerBackends },
      },
      browserTabGc: { ...global.browserTabGc },
      router: cloneRouter(global.router),
    }
    try {
      await actions.updateConfig(input)
      await loadConfigDocument(true)
    } catch (error) {
      await showFormError(error instanceof Error ? error.message : t('requestFailed'))
    }
  }

  async function saveProfile(draft: ProfileDraft) {
    formError = ''
    try {
      await actions.updateProfile(draft.slug, {
        roleLabel: draft.roleLabel,
        enabledProviders: [...draft.enabledProviders],
        providerModes: cloneProviderModes(draft.providerModes),
        browserVisibility: 'headed',
        proxy: draft.proxyEnabled
          ? { server: draft.proxyServer.trim(), bypass: splitBypass(draft.proxyBypass) }
          : null,
      })
      await loadConfigDocument(true)
    } catch (error) {
      await showFormError(error instanceof Error ? error.message : t('requestFailed'))
    }
  }

  function toggleProvider(draft: ProfileDraft, providerId: string, event: Event) {
    const checked = (event.currentTarget as HTMLInputElement).checked
    draft.enabledProviders = checked
      ? [...new Set([...draft.enabledProviders, providerId])]
      : draft.enabledProviders.filter((id) => id !== providerId)
  }

  function toggleProviderMode(draft: ProfileDraft, providerId: string, mode: DashboardProviderExecutionMode, event: Event) {
    const checked = (event.currentTarget as HTMLInputElement).checked
    const modes = new Set(draft.providerModes[providerId] ?? [])
    if (checked) modes.add(mode)
    else modes.delete(mode)
    draft.providerModes[providerId] = [...modes]
  }

  function addDirectProvider() {
    const id = directProviderId.trim().toLowerCase()
    if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return
    global.directProvider.providerBackends[id] ??= global.directProvider.defaultBackend
    directProviderId = ''
  }

  function addRouterProvider() {
    const id = routerProviderId.trim().toLowerCase()
    if (!id || global.router.providers.some((provider) => provider.id === id)) return
    global.router.providers = [...global.router.providers, { id, suitableTasks: '' }]
    routerProviderId = ''
  }

  function removeRouterProvider(index: number) {
    global.router.providers = global.router.providers.filter((_, candidate) => candidate !== index)
  }

  function removeDirectProvider(id: string) {
    const entries = { ...global.directProvider.providerBackends }
    delete entries[id]
    global.directProvider.providerBackends = entries
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

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot.diagnostics, null, 2))
      ontoast(t('copied'))
    } catch {
      ontoast(t('copyFailed'))
    }
  }

  async function quiesceRuntime() {
    try { await actions.quiesceRuntime() } catch { /* shared mutation boundary reports the error */ }
  }

  async function enableOutputSavings() {
    try { await actions.enableOutputSavings() } catch { /* shared mutation boundary reports the error */ }
  }

  async function disableOutputSavings() {
    try { await actions.disableOutputSavings() } catch { /* shared mutation boundary reports the error */ }
  }

  async function clearOutputSavings() {
    if (!window.confirm(t('confirmClearSavings'))) return
    try { await actions.clearOutputSavings() } catch { /* shared mutation boundary reports the error */ }
  }

  async function uninstallOutputSavings() {
    if (!window.confirm(t('confirmUninstallTokenizer'))) return
    try { await actions.uninstallOutputSavings() } catch { /* shared mutation boundary reports the error */ }
  }

  function formatMegabytes(bytes: number) {
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`
  }

  function profileProviderEnabled(draft: ProfileDraft, providerId: string) {
    return draft.enabledProviders.includes(providerId)
  }

  function profileModeEnabled(draft: ProfileDraft, providerId: string, mode: DashboardProviderExecutionMode) {
    return (draft.providerModes[providerId] ?? []).includes(mode)
  }

  function draftProfile(profile: DashboardProfile): ProfileDraft {
    return {
      slug: profile.slug,
      roleLabel: profile.roleLabel,
      enabledProviders: [...profile.enabledProviders],
      providerModes: cloneProviderModes(profile.providerModes),
      proxyEnabled: profile.proxy !== null,
      proxyServer: profile.proxy?.server ?? '',
      proxyBypass: profile.proxy?.bypass.join(', ') ?? '',
      runtimeBinding: profile.browserBinding
        ? {
            runtimeId: profile.browserBinding.runtimeId,
            family: profile.browserBinding.family,
            browserId: profile.browserBinding.browserId,
            executablePath: '',
            createdWithVersion: profile.browserBinding.version ?? '0.0.0.0',
            profileFormat: 1,
          }
        : undefined,
    }
  }

  function draftProfileFromConfig(slug: string, profile: DashboardConfigDocument['profiles'][string]): ProfileDraft {
    return {
      slug,
      roleLabel: profile.roleLabel,
      enabledProviders: [...profile.enabledProviders],
      providerModes: cloneProviderModes(profile.providerModes),
      proxyEnabled: profile.proxy !== null,
      proxyServer: profile.proxy?.server ?? '',
      proxyBypass: profile.proxy?.bypass.join(', ') ?? '',
      runtimeBinding: profile.runtimeBinding,
    }
  }

  function cloneProviderModes(value: Record<string, readonly DashboardProviderExecutionMode[]>) {
    return Object.fromEntries(Object.entries(value).map(([provider, modes]) => [provider, [...modes]])) as Record<string, DashboardProviderExecutionMode[]>
  }

  function cloneRouter(router: DashboardRouterConfig): DashboardRouterConfig {
    return { enabled: router.enabled, engine: router.engine, providers: router.providers.map((provider) => ({ ...provider })) }
  }

  function splitBypass(value: string) {
    return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
  }
</script>

{#snippet helpTooltip(message: string)}
  <button class="icon-button subtle help-trigger hover-tooltip" type="button" aria-label={message}>
    <CircleHelp size={14} aria-hidden="true" />
    <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{message}</span>
  </button>
{/snippet}

<section class="page" data-testid="system-view">
  <PageHeader title={t('system')} description={t('systemLede')}>
    {#snippet actions()}
      <button class="icon-button subtle" type="button" aria-label={t('copyDiagnostics')} title={t('copyDiagnostics')} onclick={copyDiagnostics}><Clipboard size={15} aria-hidden="true" /></button>
    {/snippet}
  </PageHeader>

  <form class="system-grid" onsubmit={saveGlobal} data-testid="config-form">
    <section class="settings-section system-card">
      <div class="settings-section-title"><div><h2>{t('appearance')}</h2></div>{@render helpTooltip(t('appearanceHelp'))}</div>
      <div class="form-stack"><div class="field"><div class="field-label-row"><label for="config-language">{t('language')}</label>{@render helpTooltip(t('languageHelp'))}</div><select id="config-language" name="language" bind:value={global.language} data-testid="config-language"><option value="en">English</option><option value="zh-CN">简体中文</option></select></div></div>
    </section>

    <section class="settings-section system-card">
      <div class="settings-section-title"><div><h2>{t('runtime')}</h2></div>{@render helpTooltip(`${t('runtimeConfigHelp')} ${t('nativeChromeConnectionHelp')}`)}</div>
      <div class="form-stack">
        <div class="field"><div class="field-label-row"><label for="config-browser">{t('profileBrowser')}</label></div><select id="config-browser" name="browser" bind:value={global.browser} data-testid="config-browser"><option value="chrome">{t('googleChrome')}</option><option value="brave">{t('braveBrowser')}</option></select></div>
        <div class="field"><div class="field-label-row"><label for="config-browser-executable-path">{t('browserExecutablePath')} <small>{t('optional')}</small></label>{@render helpTooltip(snapshot.config.browserExecutablePathConfigured ? t('browserExecutablePathConfigured') : t('browserExecutablePathHelp'))}</div><input id="config-browser-executable-path" name="browserExecutablePath" bind:value={global.browserExecutablePath} placeholder={t('browserExecutablePathPlaceholder')} autocomplete="off" spellcheck="false" data-testid="config-browser-executable-path" /></div>
        <div class="field read-only-field"><div class="field-label-row"><span>{t('defaultVisibility')}</span>{@render helpTooltip(t('readOnly'))}</div><strong data-testid="config-browser-visibility">headed</strong></div>
      </div>
    </section>

    <section class="settings-section system-card">
      <div class="settings-section-title"><div><h2>{t('configurationMetadata')}</h2></div>{@render helpTooltip(t('configurationMetadataHelp'))}</div>
      <div class="settings-list config-metadata-list">
        <div class="settings-row"><span>{t('protocol')}</span><strong data-testid="config-protocol">{configDocument?.protocol ?? 'tokenless.config.v1'}</strong></div>
        <div class="settings-row"><span>{t('updatedAt')}</span><strong data-testid="config-updated-at">{configDocument?.updatedAt ?? snapshot.config.updatedAt ?? t('notAvailable')}</strong></div>
        <div class="settings-row"><span>{t('defaultProfile')}</span><strong data-testid="config-default-profile">{global.defaultProfile || t('none')}</strong></div>
        <div class="settings-row"><span>{t('configPath')}</span><strong class="mono-label" data-testid="config-path">{configDocument?.configPath ?? t('loading')}</strong></div>
      </div>
      <div class="field config-default-profile"><div class="field-label-row"><label for="config-default-profile-control">{t('defaultProfile')}</label></div><select id="config-default-profile-control" bind:value={global.defaultProfile} data-testid="config-default-profile-control"><option value="">{t('none')}</option>{#each snapshot.profiles as profile (profile.slug)}<option value={profile.slug}>{profile.slug}</option>{/each}</select></div>
    </section>
      <section class="settings-section system-card" data-testid="browser-tab-gc">
        <div class="settings-section-title"><div><h2>{t('tabGc')}</h2></div>{@render helpTooltip(t('tabGcHelp'))}</div>
        <div class="form-stack">
        <div class="field"><label for="gc-idle">{t('tabGcIdle')}</label><input id="gc-idle" type="number" min="1" step="1" bind:value={global.browserTabGc.idleTimeoutSeconds} /></div>
        <div class="field"><label for="gc-sweep">{t('tabGcSweep')}</label><input id="gc-sweep" type="number" min="1" step="1" bind:value={global.browserTabGc.sweepIntervalSeconds} /></div>
        </div>
        {#if snapshot.runtime.tabGc}
          {@const gc = snapshot.runtime.tabGc}
          <p class="form-note" data-testid="tab-gc-counters">{t('tabGcReused')}: {gc.idleReuses} · {t('tabGcExpired')}: {gc.expired} · {t('tabGcReopened')}: {gc.reopenedSoon} · {t('tabGcFailures')}: {gc.closeFailures}</p>
          {#each gc.profiles as profile (profile.profileId)}
            <div class="settings-row"><span>{profile.profileId} · {profile.status ?? 'attached'}{profile.errorCode ? ` · ${profile.errorCode}` : ''}</span><strong>{t('tabGcObserved')}: {profile.totalPages ?? '—'} · {t('tabGcUntracked')}: {profile.untrackedPages ?? '—'} · {t('tabGcBusy')}: {profile.busyPages} · idle: {profile.idlePages} · {t('tabGcTotal')}: {profile.workPages}</strong></div>
          {/each}
        {/if}
      </section>

    <section class="settings-section system-card">
      <div class="settings-section-title"><div><h2>{t('connection')}</h2></div>{@render helpTooltip(t('connectionHelp'))}</div>
      <div class="form-stack">
        <div class="field"><div class="field-label-row"><label for="config-daemon-url">{t('daemonUrl')}</label>{@render helpTooltip(t('daemonUrlHelp'))}</div><input id="config-daemon-url" bind:value={global.daemonUrl} placeholder="http://127.0.0.1:8787" autocomplete="off" spellcheck="false" data-testid="config-daemon-url" /></div>
        <div class="switch-field"><span><span class="switch-heading"><strong>{t('apiProxy')}</strong>{@render helpTooltip(t('apiProxyHelp'))}</span></span><label class="switch"><input type="checkbox" bind:checked={global.apiProxy.enabled} data-testid="config-api-proxy-enabled" /><span></span></label></div>
        <div class="field"><div class="field-label-row"><label for="config-api-proxy-execution-mode">{t('executionMode')}</label></div><select id="config-api-proxy-execution-mode" bind:value={global.apiProxy.executionMode} data-testid="config-api-proxy-execution-mode"><option value="direct">direct</option><option value="browser">browser</option></select></div>
      </div>
    </section>

    <section class="settings-section system-card">
      <div class="settings-section-title"><div><h2>{t('advanced')}</h2></div>{@render helpTooltip(t('advancedConfigHelp'))}</div>
      <div class="form-stack">
        <div class="switch-field"><span><span class="switch-heading"><strong>{t('g4f')}</strong>{@render helpTooltip(t('g4fHelp'))}</span></span><label class="switch"><input type="checkbox" bind:checked={global.g4f.enabled} data-testid="config-g4f-enabled" /><span></span></label></div>
        <div class="field"><div class="field-label-row"><label for="config-direct-default-backend">{t('defaultBackend')}</label></div><select id="config-direct-default-backend" bind:value={global.directProvider.defaultBackend} data-testid="config-direct-default-backend"><option value="native">native</option><option value="g4f">g4f</option></select></div>
        <div class="field"><div class="field-label-row"><span>{t('providerBackends')}</span>{@render helpTooltip(t('providerBackendsHelp'))}</div></div>
        <div class="config-entry-list" data-testid="config-provider-backends">
          {#each Object.entries(global.directProvider.providerBackends) as [providerId, backend] (providerId)}
            <div class="config-entry-row"><strong>{providerId}</strong><select value={backend} onchange={(event) => global.directProvider.providerBackends[providerId] = (event.currentTarget as HTMLSelectElement).value as 'native' | 'g4f'}><option value="native">native</option><option value="g4f">g4f</option></select><button class="icon-button" type="button" aria-label={t('remove')} title={t('remove')} onclick={() => removeDirectProvider(providerId)}><Trash2 size={14} aria-hidden="true" /></button></div>
          {/each}
          <div class="config-entry-add"><input bind:value={directProviderId} placeholder="provider-id" data-testid="config-provider-backend-id" /><button class="icon-button subtle" type="button" aria-label={t('add')} title={t('add')} onclick={addDirectProvider}><Plus size={15} aria-hidden="true" /></button></div>
        </div>
      </div>
    </section>

    <section class="settings-section system-card system-card-wide">
      <div class="settings-section-title"><div><h2>{t('semanticRouting')}</h2></div>{@render helpTooltip(t('routingLede'))}</div>
      <div class="form-stack">
        <div class="switch-field"><span><span class="switch-heading"><strong>{t('experimentalRouter')}</strong>{@render helpTooltip(t('routerEnableHelp'))}</span></span><label class="switch"><input type="checkbox" bind:checked={global.router.enabled} data-testid="config-router-enabled" /><span></span></label></div>
        <div class="field"><div class="field-label-row"><label for="config-router-engine">{t('routerEngine')}</label></div><select id="config-router-engine" bind:value={global.router.engine} data-testid="config-router-engine"><option value="chrome-prompt-api">{t('chromePromptApiEngine')}</option><option value="spark-x2.5-4b-mlx">{t('sparkX25MlxEngine')}</option></select></div>
        <div class="field"><div class="field-label-row"><span>{t('routerProviders')}</span>{@render helpTooltip(t('routerProvidersHelp'))}</div></div>
        <div class="config-entry-list" data-testid="config-router-providers">
          {#each global.router.providers as provider, index (provider.id)}
            <div class="config-router-row"><input value={provider.id} readonly aria-label={`${t('provider')} ${index + 1}`} /><input bind:value={provider.suitableTasks} placeholder={t('providerSuitableTasksPlaceholder')} /><button class="icon-button" type="button" aria-label={t('remove')} title={t('remove')} onclick={() => removeRouterProvider(index)}><Trash2 size={14} aria-hidden="true" /></button></div>
          {/each}
          <div class="config-entry-add"><input bind:value={routerProviderId} placeholder="provider-id" data-testid="config-router-provider-id" /><button class="icon-button subtle" type="button" aria-label={t('add')} title={t('add')} onclick={addRouterProvider}><Plus size={15} aria-hidden="true" /></button></div>
        </div>
      </div>
    </section>

    <div class="system-actions"><button class="icon-button subtle" type="button" disabled={busy} aria-label={t('quiesce')} title={t('quiesce')} onclick={quiesceRuntime}><PauseCircle size={16} aria-hidden="true" /></button><button class="button primary" type="submit" disabled={busy} data-testid="config-save"><Save size={15} aria-hidden="true" />{#if busy}<span class="spinner mini"></span>{/if}{t('save')}</button></div>
    {#if formError}<div bind:this={errorElement} class="inline-feedback error system-form-error" role="alert" tabindex="-1" data-testid="config-error"><span>{formError}</span></div>{/if}
  </form>

  <section class="settings-section system-card system-card-wide profiles-config-card" data-testid="profiles-config-card">
    <div class="settings-section-title"><div><h2>{t('profileConfiguration')}</h2></div>{@render helpTooltip(t('profileConfigurationHelp'))}</div>
    {#each Object.values(profileDrafts) as draft (draft.slug)}
      <section class="profile-config-block" data-testid={`profile-config-${draft.slug}`}>
        <header><div><h3>{draft.slug}</h3><small>{draft.roleLabel || t('none')}</small></div><button class="button secondary icon-label" type="button" disabled={busy} onclick={() => saveProfile(draft)}><Save size={14} />{t('save')}</button></header>
        <div class="profile-config-grid">
          <div class="field"><div class="field-label-row"><label for={`profile-role-${draft.slug}`}>{t('role')}</label></div><input id={`profile-role-${draft.slug}`} bind:value={draft.roleLabel} data-testid={`profile-role-${draft.slug}`} /></div>
          <div class="field"><span>{t('enabledProviders')}</span><div class="config-check-grid">{#each snapshot.providers as provider (provider.id)}<label><input type="checkbox" checked={profileProviderEnabled(draft, provider.id)} onchange={(event) => toggleProvider(draft, provider.id, event)} />{provider.label}</label>{/each}</div></div>
          <div class="field"><span>{t('executionMode')}</span><div class="config-mode-list">{#each snapshot.providers as provider (provider.id)}<div><strong>{provider.id}</strong>{#each provider.executionModes as mode (mode)}<label><input type="checkbox" checked={profileModeEnabled(draft, provider.id, mode)} onchange={(event) => toggleProviderMode(draft, provider.id, mode, event)} />{mode}</label>{/each}</div>{/each}</div></div>
          <div class="field"><div class="field-label-row"><span>{t('proxySettings')}</span>{@render helpTooltip(t('proxyRestartNote'))}</div><div class="switch-field compact"><span>{t('enabled')}</span><label class="switch"><input type="checkbox" bind:checked={draft.proxyEnabled} data-testid={`profile-proxy-enabled-${draft.slug}`} /><span></span></label></div>{#if draft.proxyEnabled}<input bind:value={draft.proxyServer} placeholder="http://127.0.0.1:8080" data-testid={`profile-proxy-server-${draft.slug}`} /><input bind:value={draft.proxyBypass} placeholder={t('proxyBypass')} data-testid={`profile-proxy-bypass-${draft.slug}`} />{/if}</div>
          <div class="field read-only-field"><div class="field-label-row"><span>{t('browserVisibility')}</span>{@render helpTooltip(t('readOnly'))}</div><strong>headed</strong></div>
          <div class="field read-only-field"><span>{t('runtimeBinding')}</span><strong>{draft.runtimeBinding?.runtimeId ?? t('notConfigured')}</strong><small>{draft.runtimeBinding?.browserId ?? t('notAvailable')}</small></div>
        </div>
      </section>
    {/each}
  </section>

  <section class="settings-section system-card output-savings-card" data-testid="output-savings-card">
    <div class="settings-section-title"><div><h2>{t('outputSavings')}</h2></div>{@render helpTooltip(`${t('outputSavingsLede')} ${t('lazyTokenizerDownload')}`)}</div>
    <p class="output-savings-lede"><strong>{t(snapshot.outputSavings.enabled ? 'savingsEnabled' : 'savingsDisabled')}</strong></p>
    <div class="output-savings-metrics"><div><small>{t('estimatedTokensSaved')}</small><strong class="token-quantity">{formatNumber(snapshot.outputSavings.summary.estimatedOutputTokens, language)}<TokenUnit {language} /></strong></div><div><small>{t('measuredResponses')}</small><strong>{formatNumber(snapshot.outputSavings.summary.responseCount, language)}</strong></div><div><small>{t('tokenizerRuntime')}</small><strong>{snapshot.outputSavings.runtime.installed ? stateLabel(language, snapshot.outputSavings.runtime.state) : t('tokenizerNotInstalled')}</strong></div><div><small>{snapshot.outputSavings.runtime.installed ? t('runtimeSize') : t('downloadRequired')}</small><strong>{formatMegabytes(snapshot.outputSavings.runtime.installed ? snapshot.outputSavings.runtime.installedBytes : snapshot.outputSavings.runtime.downloadBytes)}</strong></div></div>
    <div class="output-savings-actions">{#if snapshot.outputSavings.enabled}{#if snapshot.outputSavings.runtime.state !== 'ready'}<button class="button primary" type="button" disabled={busy} onclick={enableOutputSavings} data-testid="output-savings-install">{t('prepareTokenizerNow')}</button>{/if}<button class="button secondary" type="button" disabled={busy} onclick={disableOutputSavings} data-testid="output-savings-disable">{t('disableOutputSavings')}</button>{:else}<button class="button primary" type="button" disabled={busy} onclick={enableOutputSavings} data-testid="output-savings-enable">{t('enableOutputSavings')}</button>{/if}<button class="button secondary" type="button" disabled={busy || snapshot.outputSavings.summary.responseCount === 0} onclick={clearOutputSavings}>{t('clearSavingsHistory')}</button>{#if snapshot.outputSavings.runtime.installed}<button class="button danger" type="button" disabled={busy} onclick={uninstallOutputSavings}>{t('uninstallTokenizer')}</button>{/if}</div>
  </section>

  <section class="settings-section system-card json-config-card" data-testid="config-json-card">
    <div class="settings-section-title"><div><h2>{t('jsonView')}</h2></div>{@render helpTooltip(t('jsonViewHelp'))}</div>
    <div class="json-view-actions"><button class="button secondary" type="button" onclick={toggleJsonView} data-testid="config-json-toggle">{showJson ? t('structuredView') : t('showJson')}</button><button class="icon-button subtle" type="button" aria-label={t('refresh')} title={t('refresh')} disabled={documentLoading} onclick={refreshConfigDocument} data-testid="config-json-refresh"><RefreshCw size={15} aria-hidden="true" /></button></div>
    {#if showJson}{#if documentError}<div class="inline-feedback error" role="alert">{documentError}</div>{:else if documentLoading && !configDocument}<p class="form-note">{t('loading')}</p>{:else}<pre class="config-json" data-testid="config-json-view">{JSON.stringify(configDocument, null, 2)}</pre>{/if}{/if}
  </section>

  <section class="diagnostics-section"><header><div><h2>{t('diagnostics')}</h2><p>{formatTime(snapshot.generatedAt, language)}</p></div></header><div class="content-panel row-list">{#each snapshot.diagnostics as item (item.id)}<div class="data-row diagnostic-row"><span class:ok={item.state === 'ok'} class:error={item.state === 'error'} class="status-dot"></span><span class="data-row-main"><strong>{item.id}</strong><small>{diagnosticMessage(item)}</small></span><span class="mono-label">{stateLabel(language, item.state)}</span></div>{/each}</div></section>
</section>
