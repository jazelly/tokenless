import { ERROR_SUMMARIES_ZH } from 'tokenless-internal-shared/localized-errors'
import { interpolateTokenlessMessage, type TokenlessLanguage } from 'tokenless-internal-shared/i18n'

type JsonRecord = Record<string, any>
type Language = TokenlessLanguage

const enMessages = {
    overview: 'Overview', profiles: 'Profiles', providers: 'Providers', capabilities: 'Capabilities', routing: 'Routing', jobs: 'Chat history', system: 'System',
    localDashboard: 'Local Dashboard', operationalSummary: 'Operational summary', overviewLede: 'The exact daemon, browser, provider, and job state on this machine.',
    daemon: 'Daemon', browser: 'Browser runtime', activeProfiles: 'Active profiles', waitingJobs: 'Waiting jobs', finishedJobs: 'Finished jobs', idle: 'Idle', healthy: 'Healthy',
    actionRequired: 'Action required', recentJobs: 'Recent jobs', showingLatest: 'Showing latest', recentConversations: 'conversations', moreChats: 'More chats', providerReadiness: 'Provider readiness', providerReadinessSummaryHelp: 'Providers currently detected as signed in for this profile.', noJobs: 'No jobs yet', noJobsBody: 'Conversations will appear here when Tokenless starts work.',
    profileManagement: 'Tokenless profiles', profilesLede: 'Manage provider tabs, purpose, and provider scope in your connected Chrome.',
    cleanProfileNote: 'Profiles organize Tokenless-owned tabs in your running Chrome. They do not copy or isolate your Chrome identity.',
    createProfile: 'Create profile', slug: 'Profile slug', role: 'Purpose or role', visibility: 'Visibility', enabledProviders: 'Enabled providers',
    save: 'Save', cancel: 'Cancel', open: 'Open', remove: 'Remove', setDefault: 'Set default', default: 'Default',
    providerConfiguration: 'Provider configuration', providersLede: 'Intent, observed access, evidence, and routing eligibility stay separate.', selectProfile: 'Profile', executionMode: 'Execution mode', browserMode: 'Browser', directMode: 'Direct', directOnlyProvider: 'Direct execution only', configured: 'Configured', notSupported: 'Not supported', browserModeHelp: 'Runs through the signed-in provider website.', directModeHelp: 'Connects directly over the provider protocol.', modeUnsupportedHelp: 'This provider does not support this mode.', entryUrl: 'Entry URL',
    enabled: 'Enabled', disabled: 'Disabled', neverChecked: 'Never checked', checkNow: 'Check readiness', inspectControls: 'Inspect controls',
    refreshProviderReadiness: 'Refresh provider readiness', checkingProviderReadiness: 'Checking provider sign-in…', providerReadinessRefreshed: 'Provider readiness refreshed.', providerReadinessPartiallyRefreshed: 'Provider readiness refreshed; some checks could not complete. Failed providers remain marked below; open Jobs for details.', providerReadinessRefreshTimedOut: 'Provider readiness checks are still running. Review Jobs for progress.', noEnabledProviders: 'No providers are enabled for this profile.',
    capabilityCatalog: 'Capability catalog', capabilitiesLede: 'Start from caller outcomes, then see which evidence-backed provider routes can satisfy them.', noRoute: 'No evidenced route',
    durableJobs: 'Chat history', jobsLede: 'Review conversations handled through the Tokenless API.', allStatuses: 'All statuses', allProviders: 'All providers', allProfiles: 'All profiles', searchJobs: 'Search conversations…', filters: 'Filters', conversationList: 'Conversation list', selectConversation: 'Select a conversation', selectConversationHint: 'Choose a conversation from the history to read it here.', details: 'Details', backToChatHistory: 'Back to chat history', conversationDetails: 'Conversation details', provider: 'Provider', jobId: 'Job ID', messages: 'messages',
    tabGc: 'Tab garbage collection', tabGcHelp: 'Idle work tabs expire after the retention window. When capacity is full, the oldest idle tab is reclaimed first. Busy or retained pages stay open. Counts cover this daemon session.', tabGcIdle: 'Idle retention (seconds)', tabGcSweep: 'Check interval (seconds)', tabGcLimit: 'Work tabs per profile', tabGcReused: 'Idle reuses', tabGcExpired: 'Expired', tabGcCapacity: 'Capacity collections', tabGcReopened: 'Reopened within retention window', tabGcRejected: 'Capacity refusals', tabGcFailures: 'Close failures', tabGcBusy: 'Busy / retained', tabGcTotal: 'Work tabs', settingsDiagnostics: 'System and diagnostics', systemLede: 'Preferences, runtime, and diagnostics.', appearanceHelp: 'Choose the language used by the local Dashboard and CLI.', runtimeConfigHelp: 'Select the system browser and keep its connection in headed mode.', configurationMetadata: 'Configuration metadata', configurationMetadataHelp: 'These values come from the current config.json and are read-only unless a control is shown below.', protocol: 'Protocol', updatedAt: 'Updated at', defaultProfile: 'Default profile', configPath: 'Config path', notAvailable: 'Not available', readOnly: 'Read-only', connectionHelp: 'Configure the local API connection and API proxy behavior.', daemonUrl: 'Daemon URL', daemonUrlHelp: 'Optional loopback URL used by local integrations.', apiProxy: 'API proxy', apiProxyHelp: 'Expose the configured provider proxy behavior to local API callers.', advancedConfigHelp: 'Configure direct provider backends and optional G4F access.', g4f: 'G4F', g4fHelp: 'Allow G4F as a direct provider backend.', defaultBackend: 'Default backend', providerBackends: 'Provider backends', providerBackendsHelp: 'Override the direct backend for individual provider ids.', add: 'Add', profileConfiguration: 'Profile configuration', profileConfigurationHelp: 'Edit every mutable profile field. Runtime bindings and headed visibility remain read-only.', runtimeBinding: 'Runtime binding', browserVisibility: 'Browser visibility', jsonView: 'JSON view', jsonViewHelp: 'Load the complete current config.json through the authenticated server whenever you open or refresh this view.', structuredView: 'Structured view', showJson: 'Show JSON', routerEnableHelp: 'Enable the experimental local semantic router.', language: 'Language', quiesce: 'Quiesce runtime', copyDiagnostics: 'Copy diagnostics', diagnostics: 'Diagnostics',
    updateSaved: 'Changes saved.', requestFailed: 'Request failed.', offline: 'Dashboard is offline', offlineBody: 'The daemon stopped responding. Polling will resume automatically.', sessionExpired: 'Dashboard session expired', reopen: 'Open the local Dashboard again to start a new session.',
    loading: 'Loading current state…', empty: 'Nothing to show', confirmRemove: 'Type the profile slug to confirm permanent removal:', create: 'Create', browserSelection: 'Browser for new profiles', browserExecutablePath: 'Browser executable path', browserExecutablePathPlaceholder: '/absolute/path/to/browser or Browser.app…', browserExecutablePathConfigured: 'A verified path is cached. Leave blank to keep it, or paste a replacement.', browserExecutablePathHelp: 'Paste an absolute executable path. On macOS, an application bundle such as Browser.app is also accepted.', defaultVisibility: 'Default visibility', proxy: 'Proxy server', proxyBypass: 'Proxy bypass (comma separated)', proxyRestartNote: 'Changing the proxy first quiesces active browser ownership and recreates this profile context.', none: 'None', openBrowser: 'Open browser', savedAt: 'Saved',
    stage: 'Stage', lifecycle: 'Lifecycle', evidence: 'Evidence', result: 'Result', error: 'Error', created: 'Created', updated: 'Updated', untitledChat: 'Untitled conversation', estimatedTokensShort: 'estimated tokens', estimatedTokens: 'Estimated total tokens', conversation: 'Conversation', userPrompt: 'User', assistantReply: 'Assistant', noConversation: 'No conversation content is available.', openProviderChat: 'Open provider chat', technicalDetails: 'Technical details',
    primaryNavigation: 'Primary navigation', uptimeUnit: 'min uptime', activeUnit: 'active', configuredUnit: 'configured', durableUnit: 'durable',
    documentTitle: 'Tokenless local Dashboard', skipToContent: 'Skip to content',
    harnessExtensionPairing: 'Pair Tokenless Harness extension', harnessExtensionPairingLede: 'Approve this exact installed extension and freeze the Tokenless API provider route it may use.', harnessExtensionIdentity: 'Extension ID', harnessExtensionOrigin: 'Extension origin', harnessExtensionScope: 'This revocable credential can only attach extension sessions and control their own Harness runs. It cannot change configuration, access other runs, or use daemon control APIs.', harnessExtensionApprove: 'Approve extension', harnessExtensionApproving: 'Approving…', harnessExtensionApproved: 'Extension pairing approved. Return to the Chrome side panel.',
    configPersisted: 'Configuration is persisted.', setupIncomplete: 'Setup has not persisted configuration yet.', browserReady: 'The browser runtime is available.', browserUnavailable: 'The browser runtime is unavailable.', noManagedProfiles: 'No managed profile is configured.', profilesRegistered: 'managed profile(s) registered.', activeBrowserJobs: 'active browser job(s).',
    setup: 'Setup', setupTitle: 'Set up Tokenless', setupBody: 'Choose a detected browser runtime, or add a Chrome or Brave executable path.', nativeChromeConnectionHelp: 'Tokenless does not bundle or download Chrome or Brave. If automatic discovery fails, add an absolute executable path and enable Remote Debugging before the first browser action. CloakBrowser appears when its shipped runtime is installed.', googleChrome: 'My Google Chrome', braveBrowser: 'My Brave Browser', cloakBrowserHelp: 'CloakBrowser is a Tokenless-managed anti-detect runtime. Its verified executable path is shown here and its runtime binding is stored on the profile.', detected: 'Detected', detectedOnComputer: 'Detected on this computer', noBrowsersDetected: 'No supported browser runtime was detected yet.', addBrowser: 'Add browser', hideAddBrowser: 'Hide add browser', continue: 'Continue', finishSetup: 'Finish setup', back: 'Back',
    appearance: 'Appearance', profile: 'Profile', connection: 'Connection', advanced: 'Advanced', edit: 'Edit', more: 'More', close: 'Close',
    profileBrowser: 'Browser', providersShort: 'Providers', profileReady: 'Ready', lastChecked: 'Last checked', openMenu: 'Open menu',
    addProfile: 'Add profile', noProfiles: 'No profiles', required: 'Required', optional: 'Optional', profileCreated: 'Profile created.',
    proxySettings: 'Proxy settings', providerAccess: 'Provider access', deleteProfile: 'Delete profile', deleteWarning: 'This removes the logical Tokenless profile. It does not close Chrome.',
    status: 'Status', version: 'Version', runtime: 'Runtime', ready: 'Ready', stopped: 'Stopped', selected: 'Selected', signedIn: 'Signed in', signedOut: 'Signed out', signInUnknown: 'Sign-in unknown', guestAccess: 'Guest access', freePlan: 'Free plan', paidPlan: 'Paid plan level', planUnknown: 'Plan unknown', subscriptionTier: 'Subscription tier',
    refresh: 'Refresh', search: 'Search', queued: 'Queued', succeeded: 'Succeeded', failed: 'Failed', waiting: 'Waiting',
    noResults: 'No matching results', copy: 'Copy', copied: 'Copied.', copyFailed: 'Could not copy diagnostics.', account: 'Account', model: 'Model', effort: 'Effort',
    useBrowser: 'Use browser', chooseProviders: 'Choose providers', setupProfileHelp: 'A profile groups Tokenless-owned provider tabs and configuration.',
    automatic: 'Automatic', available: 'Available', notFound: 'Not found', downloadRequired: 'Download required', scanningBrowsers: 'Scanning installed browsers…',
    managedByTokenless: 'Managed by Tokenless', systemBrowser: 'System browser', runtimeDownloadHelp: 'Download and verify this runtime before using it.', automaticBrowserHelp: 'Automatic selection resolves to the platform-pinned managed Chrome for Testing.', browserNotDetectedHelp: 'Choose another browser or add its executable path.',
    installRuntime: 'Install', repairRuntime: 'Repair runtime', addExecutablePath: 'Add executable path', replaceExecutablePath: 'Replace executable path', hideExecutablePath: 'Hide custom path', verifiedPathCached: 'Verified path cached', validate: 'Validate', clearExecutablePath: 'Use automatic discovery', browserValidated: 'Executable verified', runtimeInstalled: 'Browser runtime installed.', runtimeRepaired: 'Browser runtime repaired.',
    languageHelp: 'Used by the local Dashboard and CLI.', confirmDelete: 'Enter the profile slug to remove it permanently.', unknown: 'Unknown',
    outputSavings: 'Output savings', outputSavingsLede: 'Estimate visible assistant output locally. Measurement is on by default; disabling pauses future measurements and keeps saved history.',
    estimatedTokensSaved: 'Estimated output tokens saved', measuredResponses: 'Measured responses', tokenizerRuntime: 'Tokenizer runtime', runtimeSize: 'Installed size',
    lazyTokenizerDownload: 'The pinned WASM tokenizer is downloaded only when the first visible response needs measurement or when you install it here. It uses CPU only during short measurements and never requires a GPU.',
    enableOutputSavings: 'Turn on and install', prepareTokenizerNow: 'Install tokenizer now', disableOutputSavings: 'Disable measurement', clearSavingsHistory: 'Clear history', uninstallTokenizer: 'Uninstall tokenizer',
    savingsEnabled: 'Output savings measurement is enabled.', savingsDisabled: 'Output savings measurement is disabled.', tokenizerNotInstalled: 'Not installed', tokenizerReady: 'The output savings tokenizer runtime is ready.', tokenizerUnavailable: 'Output savings is enabled, but its tokenizer runtime is unavailable.',
    savingsSummaryUnavailable: 'Token summary statistics are unavailable.', turnOnToReview: 'Turn it on to review how many output tokens Tokenless has saved.', savingsUnavailableTooltip: 'Token summary statistics are unavailable. Turn it on to review output tokens saved.', tokenizerPreparesOnFirstResponse: 'The tokenizer will be prepared when Tokenless measures the first visible response.', manageOutputSavings: 'Manage in System',
    confirmClearSavings: 'Clear all saved output savings measurements? This cannot be undone.', confirmUninstallTokenizer: 'Disable output savings and remove the local tokenizer runtime?', tokensSavedShort: 'tokens saved',
    tokenUnitHelp: 'Tokens · model text units. The circled T is the Tokenless API unit icon, not a currency symbol. A token is not necessarily a word or character.', jobsCountUnit: 'Unit: jobs', estimatedTokenUnit: 'Unit: tokens · estimated visible output', matrixZeroLegend: 'Unused', matrixAbsentLegend: 'Not connected', matrixCellOutcomes: '{succeeded} succeeded · {failed} failed · {canceled} canceled',
    analyticsTitle: 'Usage analytics', analyticsLoading: 'Loading usage analytics…', analyticsUnavailable: 'Usage analytics could not be loaded.', retryAnalytics: 'Try again',
    range7d: '7D', range30d: '30D', range90d: '90D', range1y: '1Y', rangeAll: 'All', utcDays: 'Daily buckets use UTC.', selectedRange: 'Selected range',
    mostUsedProvider: 'Most used provider', completedJobs: 'Completed jobs', successRate: 'Success rate', capabilityBreadth: 'Capability breadth', capabilityBreadthValue: '{used} of {total} used', noUsageYet: 'No completed usage yet',
    cumulativeSavings: 'Cumulative output savings', cumulativeSavingsHelp: 'Unit: tokens (circled T). A token is a piece of text processed by a model, not a word or character. This chart estimates visible assistant output locally; it is not provider-billed usage or money saved. The cumulative total includes measurements before the selected range; unmeasured output is excluded.', addedInRange: 'added in range', measurementCoverage: 'Measurement coverage',
    dailyOutcomes: 'Daily job outcomes', dailyOutcomesHelp: 'Unit: jobs. Each job counts once on the UTC day it ends, grouped as succeeded, failed, or canceled. Running jobs are excluded.', canceled: 'Canceled',
    capabilityUsageMatrixHelp: 'Each square shows how often one capability was requested from a provider. Darker green means more use. Each capability counts once per finished job, including failed and canceled jobs. Dashed squares have no connected API route or usage.', routedRequirements: 'requests', supportedUnused: 'No requests in this period', unsupportedCapability: 'No connected API route or requests',
    capabilityUsage_7d: 'Capabilities used in the last 7 days', capabilityUsage_30d: 'Capabilities used in the last 30 days', capabilityUsage_90d: 'Capabilities used in the last 90 days', capabilityUsage_1y: 'Capabilities used in the last 1 year', capabilityUsage_all: 'Capabilities used so far',
    matrixLess: 'Less', matrixMore: 'More',
    capabilityMix: 'Daily capability usage', capabilityMixHelp: 'Requests per day, grouped by capability type. A job can use several capabilities. Failed and canceled jobs are included; days use UTC.', topCapabilities: 'Most used capabilities', topCapabilitiesHelp: 'Capabilities ranked by requests in this period. Each counts once per finished job, including failed and canceled jobs.',
    executionMix: 'How jobs ran', unknownMode: 'Unknown mode',
    noMeasuredSavings: 'No measured savings in this range', noCapabilityUsage: 'No capability requirements were recorded in this range', noProviderUsage: 'No provider usage in this range',
    offlineShort: 'Offline', menu: 'Menu', mainContent: 'Main content', profileList: 'Profile list', navigation: 'Navigation',
    semanticRouting: 'Semantic routing', experimentalRouter: 'Experimental Router', routingLede: 'Configure the persistent semantic router separately from the model engine that currently powers it.', routerEngine: 'Router engine', routerExperimentNote: 'The router is a stable Tokenless concept. Its current engine runs in this page and recommends a model without executing a provider route.',
    chromePromptApiEngine: 'Chrome Prompt API · Gemini Nano', sparkX25MlxEngine: 'Spark X2.5-4B · local MLX', routerEngineHelp: 'V1 provides two local engines: Chrome Prompt API · Gemini Nano and the fixed Spark X2.5-4B MLX server.', routerDisabledError: 'Enable Experimental Router before running a test.',
    rendererBrowser: 'Dashboard renderer browser', browserVersion: 'Renderer browser version', routerRequirement: 'Engine requirement', routerBrowserRequirement: 'Google Chrome 148+', sparkServerRequirement: 'MLX server at 127.0.0.1:8080', routerBrowserModeUnsupported: 'The Dashboard renderer cannot use this engine in its current browser mode.', routerBrowserUnsupported: 'The Dashboard renderer is not running in Google Chrome. Open the Dashboard in Google Chrome to use this engine.', routerBrowserVersionUnsupported: 'Chrome Prompt API requires Google Chrome 148 or newer. Observed renderer version:',
    availability: 'API availability', routerProviders: 'Provider routing rules', routerProvidersHelp: 'Describe when to use each integrated AI provider. Only providers enabled for the selected profile become Nano candidates.', suitableTasks: 'Use for', providerSuitableTasksPlaceholder: 'Writing, editing, and tone-sensitive content', providerDefaultModel: 'Provider default / not inspected', routerProviderToggleHelp: 'Provider availability is controlled on the Providers page. Disabled providers remain visible here but cannot be configured or routed.',
    providerDetailLede: 'Provider controls and its role in Experimental Router for the selected profile.', providerRoutingRole: 'Routing role', providerRoutingRoleHelp: 'Describe the tasks this provider should receive when Experimental Router compares enabled candidates.', providerRoleDisabled: 'This provider is disabled for the selected profile. Enable it before editing its routing role; disabled providers are never router candidates.', notConfigured: 'Not configured',
    routerNeedsEnabledProviders: 'Enable at least one AI provider for this profile before routing.', routerNeedsProviderRules: 'Describe a suitable task for at least one enabled provider.', routerTaskRequired: 'Enter a task prompt.', routerApiUnsupported: 'The Dashboard renderer does not expose the selected router engine.', routerApiUnavailable: 'The selected router engine is unavailable in this Dashboard renderer or device.', routerInvalidResult: 'The selected router engine returned an invalid provider selection.',
    routerTest: 'Semantic router test', routerTestHelp: 'The selected local engine receives each remaining provider’s rules, selected model, current profile plan, and known allowance after deterministic exclusions.', taskPrompt: 'Task prompt', taskPromptPlaceholder: 'Draft a product launch announcement with a confident tone.', runSemanticRouter: 'Run semantic router', routerRunning: 'Routing…', routerResult: 'Structured result', startHarnessRun: 'Start Harness run', harnessStarting: 'Starting Harness run…', harnessRun: 'Harness run', harnessProfileRequired: 'Select a managed profile before starting a Harness run.', routerSemanticManifest: 'Terminal-Bench semantic manifest', routerSemanticManifestHelp: 'Classify all 66 pinned instructions through the selected local engine and write a validator-ready external manifest.', routerSemanticManifestTarget: 'Start this Dashboard with tokenless dashboard --semantic-manifest-output <absolute-path>. The target is one-use and expires after 30 minutes.', routerSemanticManifestRun: 'Classify 66 tasks', routerSemanticManifestRunning: 'Classifying…', routerSemanticManifestSaved: 'Semantic manifest saved', routerManifestTargetRequired: 'Open this Dashboard with an explicit semantic manifest output target first.', routerManifestTaskTypeInvalid: 'The selected local engine returned an invalid bounded task type.', downloadProgress: 'Model download', downloadZeroHelp: '0% means Chrome accepted the download request but has not reported further model progress. Check Model Status and Event Logs below.',
    chromeSetup: 'Enable Chrome experimental AI', chromeSetupIntro: 'These local Chrome flags are required before the testing page and Prompt API are available.', chromeSetupOptimization: 'Set On-device model to Enabled:', chromeSetupPrompt: 'Set Prompt API for Gemini Nano to Enabled (or Enabled Multilingual):', chromeSetupRelaunch: 'Relaunch Chrome after changing the flags.', chromeSetupInspect: 'Open Model Status and Event Logs:', chromeModelVersionHelp: 'Chrome exposes the installed component and model details on this internal page; the Prompt API does not provide an exact model version to JavaScript.', sparkSetup: 'Run the local Spark MLX server', sparkSetupIntro: 'Spark X2.5-4B runs locally through the fixed OpenAI-compatible MLX endpoint. Ollama is not required.', sparkSetupCommand: "On Apple Silicon: clone https://github.com/XHToken/Spark-MLX-LLM, cd Spark-MLX-LLM, create .venv, run .venv/bin/python -m pip install -e '.[test]', then run .venv/bin/spark-mlx-server --model XHToken/Spark-X2.5-4B --host 127.0.0.1 --port 8080 --allowed-origins http://127.0.0.1:7331", sparkSetupEndpoint: 'Health: http://127.0.0.1:8080/health · Chat: http://127.0.0.1:8080/v1/chat/completions',
} as const

const zhMessages: Record<keyof typeof enMessages, string> = {
    overview: '概览', profiles: 'Profile', providers: 'Provider', capabilities: '能力', routing: '路由', jobs: '对话历史', system: '系统',
    localDashboard: '本地 Dashboard', operationalSummary: '运行概览', overviewLede: '查看这台机器上 daemon、浏览器、provider 和任务的真实状态。',
    daemon: 'Daemon', browser: '浏览器运行时', activeProfiles: '活跃 profile', waitingJobs: '等待任务', finishedJobs: '已结束任务', idle: '空闲', healthy: '健康',
    actionRequired: '需要处理', recentJobs: '最近任务', showingLatest: '显示最近', recentConversations: '个对话', moreChats: '更多对话', providerReadiness: 'Provider 就绪状态', providerReadinessSummaryHelp: '当前 profile 中已检测为登录状态的 provider。', noJobs: '还没有任务', noJobsBody: 'Tokenless 开始工作后，对话会显示在这里。',
    profileManagement: 'Tokenless profile', profilesLede: '管理已连接 Chrome 中的 provider tab、用途和 provider 范围。',
    cleanProfileNote: 'Profile 用于组织 Chrome 中由 Tokenless 创建的 tab；它不会复制或隔离你的 Chrome identity。',
    createProfile: '创建 profile', slug: 'Profile slug', role: '用途或角色', visibility: '可见性', enabledProviders: '启用的 provider',
    save: '保存', cancel: '取消', open: '打开', remove: '移除', setDefault: '设为默认', default: '默认',
    providerConfiguration: 'Provider 配置', providersLede: '用户意图、实际观测、证据和路由资格分别展示，不混成一个状态。', selectProfile: 'Profile', executionMode: '执行模式', browserMode: '浏览器', directMode: 'Direct', directOnlyProvider: '仅支持 Direct', configured: '已配置', notSupported: '不支持', browserModeHelp: '通过已登录的 provider 网站运行。', directModeHelp: '通过 provider protocol 直接连接。', modeUnsupportedHelp: '此 provider 不支持该模式。', entryUrl: '入口 URL',
    enabled: '已启用', disabled: '已停用', neverChecked: '从未检查', checkNow: '检查就绪状态', inspectControls: '检查控件',
    refreshProviderReadiness: '刷新 Provider 就绪状态', checkingProviderReadiness: '正在检查 Provider 登录状态…', providerReadinessRefreshed: 'Provider 就绪状态已刷新。', providerReadinessPartiallyRefreshed: 'Provider 就绪状态已刷新；下方会保留失败的 Provider 标记；详情请前往任务页面查看。', providerReadinessRefreshTimedOut: 'Provider 就绪检查仍在运行，请前往任务页面查看进度。', noEnabledProviders: '此 Profile 没有已启用的 Provider。',
    capabilityCatalog: '能力目录', capabilitiesLede: '先看调用方需要的结果，再看哪些 provider 路由已有真实证据。', noRoute: '暂无证据路由',
    durableJobs: '对话历史', jobsLede: '查看由 Tokenless API 处理的对话。', allStatuses: '全部状态', allProviders: '全部 provider', allProfiles: '全部 profile', searchJobs: '搜索对话…', filters: '筛选', conversationList: '对话列表', selectConversation: '选择一个对话', selectConversationHint: '从左侧历史记录中选择一个对话，在这里阅读内容。', details: '详情', backToChatHistory: '返回对话历史', conversationDetails: '对话详情', provider: 'Provider', jobId: '任务 ID', messages: '条消息',
    tabGc: 'Tab 空闲回收', tabGcHelp: '工作页持续 idle 超过保留时间后关闭；容量满时优先回收最久 idle 的页面。进行中或需要保留的页面不会关闭。计数范围为本次 daemon 运行。', tabGcIdle: '空闲保留时间（秒）', tabGcSweep: '检查间隔（秒）', tabGcLimit: '每个 profile 的工作页上限', tabGcReused: '空闲复用', tabGcExpired: '到期回收', tabGcCapacity: '容量回收', tabGcReopened: '保留窗口内重开', tabGcRejected: '容量不足', tabGcFailures: '关闭失败', tabGcBusy: '进行中 / 保留', tabGcTotal: '工作页', settingsDiagnostics: '系统与诊断', systemLede: '偏好、运行时和诊断。', appearanceHelp: '选择本地 Dashboard 和 CLI 使用的语言。', runtimeConfigHelp: '选择系统浏览器；当前连接固定为 headed 模式。', configurationMetadata: '配置元数据', configurationMetadataHelp: '这些值来自当前 config.json；除非下面显示控件，否则为只读。', protocol: '协议', updatedAt: '更新时间', defaultProfile: '默认 Profile', configPath: '配置路径', notAvailable: '不可用', readOnly: '只读', connectionHelp: '配置本地 API 连接和 API proxy 行为。', daemonUrl: 'Daemon URL', daemonUrlHelp: '供本地集成使用的可选 loopback URL。', apiProxy: 'API proxy', apiProxyHelp: '为本地 API 调用方启用已配置的 provider proxy 行为。', advancedConfigHelp: '配置 Direct provider backend 和可选的 G4F 访问。', g4f: 'G4F', g4fHelp: '允许 G4F 作为 Direct provider backend。', defaultBackend: '默认 Backend', providerBackends: 'Provider backend', providerBackendsHelp: '为单个 provider id 覆盖 Direct backend。', add: '添加', profileConfiguration: 'Profile 配置', profileConfigurationHelp: '编辑每个可变的 Profile 字段；Runtime binding 和 headed 可见性保持只读。', runtimeBinding: 'Runtime binding', browserVisibility: '浏览器可见性', jsonView: 'JSON 视图', jsonViewHelp: '每次打开或刷新时，都通过已认证的 server 加载当前完整 config.json。', structuredView: '结构化视图', showJson: '查看 JSON', routerEnableHelp: '启用实验性的本地语义 Router。', language: '语言', quiesce: '静默浏览器运行时', copyDiagnostics: '复制诊断信息', diagnostics: '诊断',
    updateSaved: '更改已保存。', requestFailed: '请求失败。', offline: 'Dashboard 已离线', offlineBody: 'Daemon 暂时没有响应；连接恢复后会自动继续轮询。', sessionExpired: 'Dashboard 会话已过期', reopen: '请重新打开本地 Dashboard 以建立新会话。',
    loading: '正在读取当前状态…', empty: '暂无内容', confirmRemove: '输入 profile slug 以确认永久移除：', create: '创建', browserSelection: '新 profile 使用的浏览器', browserExecutablePath: '浏览器 executable path', browserExecutablePathPlaceholder: '/浏览器的绝对路径或 Browser.app…', browserExecutablePathConfigured: '已缓存经过验证的路径。留空会保留，也可以粘贴新路径替换。', browserExecutablePathHelp: '粘贴 executable 的绝对路径；macOS 也可以直接填写 Browser.app 应用路径。', defaultVisibility: '默认可见性', proxy: 'Proxy server', proxyBypass: 'Proxy bypass（逗号分隔）', proxyRestartNote: '更改 proxy 会先让浏览器运行时进入静默状态，再重建该 profile 的 context。', none: '无', openBrowser: '打开浏览器', savedAt: '保存时间',
    stage: '阶段', lifecycle: '生命周期', evidence: '证据', result: '结果', error: '错误', created: '创建时间', updated: '更新时间', untitledChat: '未命名对话', estimatedTokensShort: '估算 token', estimatedTokens: '估算总 token', conversation: '对话内容', userPrompt: '用户', assistantReply: '助手', noConversation: '暂无可显示的对话内容。', openProviderChat: '打开 Provider 对话', technicalDetails: '技术详情',
    primaryNavigation: '主要导航', uptimeUnit: '分钟运行时间', activeUnit: '活跃', configuredUnit: '已配置', durableUnit: '持久任务',
    documentTitle: 'Tokenless 本地 Dashboard', skipToContent: '跳到主要内容',
    harnessExtensionPairing: '配对 Tokenless Harness 扩展', harnessExtensionPairingLede: '批准这个确切的已安装扩展，并固定它可以使用的 Tokenless API provider route。', harnessExtensionIdentity: '扩展 ID', harnessExtensionOrigin: '扩展 origin', harnessExtensionScope: '这个可撤销凭证只能附着 extension session，并控制其自身的 Harness run；它不能修改配置、访问其他 run 或调用 daemon control API。', harnessExtensionApprove: '批准扩展', harnessExtensionApproving: '正在批准…', harnessExtensionApproved: '扩展配对已批准，请返回 Chrome side panel。',
    configPersisted: '配置已持久化。', setupIncomplete: 'Setup 尚未保存配置。', browserReady: '浏览器运行时可用。', browserUnavailable: '浏览器运行时不可用。', noManagedProfiles: '尚未配置 managed profile。', profilesRegistered: '个 managed profile 已注册。', activeBrowserJobs: '个浏览器任务正在运行。',
    setup: '设置', setupTitle: '设置 Tokenless', setupBody: '选择检测到的浏览器 runtime，或添加 Chrome/Brave executable path。', nativeChromeConnectionHelp: 'Tokenless 不会 bundle 或下载 Chrome/Brave。自动发现失败时，请添加浏览器的绝对 executable path，并在首次 browser action 前启用 Remote Debugging。已安装的 CloakBrowser 会显示在这里。', googleChrome: '我的 Google Chrome', braveBrowser: '我的 Brave Browser', cloakBrowserHelp: 'CloakBrowser 是由 Tokenless 管理的 anti-detect runtime。这里会显示经过验证的 executable path，runtime binding 会保存到 profile。', detected: '已检测', detectedOnComputer: '已在此电脑检测到', noBrowsersDetected: '暂未检测到受支持的浏览器 runtime。', addBrowser: '添加浏览器', hideAddBrowser: '收起添加浏览器', continue: '继续', finishSetup: '完成设置', back: '返回',
    appearance: '外观', profile: 'Profile', connection: '连接', advanced: '高级', edit: '编辑', more: '更多', close: '关闭',
    profileBrowser: '浏览器', providersShort: 'Provider', profileReady: '就绪', lastChecked: '上次检查', openMenu: '打开菜单',
    addProfile: '添加 profile', noProfiles: '暂无 profile', required: '必填', optional: '选填', profileCreated: 'Profile 已创建。',
    proxySettings: 'Proxy 设置', providerAccess: 'Provider 访问', deleteProfile: '删除 profile', deleteWarning: '这会移除逻辑 Tokenless profile，但不会关闭 Chrome。',
    status: '状态', version: '版本', runtime: '运行时', ready: '就绪', stopped: '已停止', selected: '已选择', signedIn: '已登录', signedOut: '未登录', signInUnknown: '登录状态未知', guestAccess: '访客访问', freePlan: '免费方案', paidPlan: '付费方案级别', planUnknown: '方案未知', subscriptionTier: '订阅层级',
    refresh: '刷新', search: '搜索', queued: '排队中', succeeded: '已完成', failed: '失败', waiting: '等待中',
    noResults: '没有匹配结果', copy: '复制', copied: '已复制。', copyFailed: '无法复制诊断信息。', account: '账号', model: '模型', effort: '推理强度',
    useBrowser: '使用浏览器', chooseProviders: '选择 provider', setupProfileHelp: 'Profile 用于组织 Tokenless 创建的 provider tab 与配置。',
    automatic: '自动选择', available: '可用', notFound: '未找到', downloadRequired: '需要下载', scanningBrowsers: '正在扫描已安装的浏览器…',
    managedByTokenless: '由 Tokenless 管理', systemBrowser: '系统浏览器', runtimeDownloadHelp: '使用前需要下载并验证这个 runtime。', automaticBrowserHelp: '自动选择会解析为按平台固定版本的 managed Chrome for Testing。', browserNotDetectedHelp: '请选择其他浏览器，或添加它的 executable path。',
    installRuntime: '安装', repairRuntime: '修复 runtime', addExecutablePath: '添加 executable path', replaceExecutablePath: '替换 executable path', hideExecutablePath: '收起自定义路径', verifiedPathCached: '已缓存验证路径', validate: '验证', clearExecutablePath: '恢复自动发现', browserValidated: 'Executable 验证通过', runtimeInstalled: '浏览器 runtime 已安装。', runtimeRepaired: '浏览器 runtime 已修复。',
    languageHelp: '用于本地 Dashboard 和 CLI。', confirmDelete: '输入 profile slug 以永久移除。', unknown: '未知',
    outputSavings: '输出节省', outputSavingsLede: '在本机估算可见 assistant 输出。计量默认开启；停用后会暂停后续计量，但保留已保存的历史。',
    estimatedTokensSaved: '估算节省的 output token', measuredResponses: '已计量响应', tokenizerRuntime: 'Tokenizer 运行时', runtimeSize: '安装大小',
    lazyTokenizerDownload: '固定版本的 WASM tokenizer 只会在首次计量可见响应时，或你在此处主动安装时下载。它仅在短时计量期间使用 CPU，不需要 GPU。',
    enableOutputSavings: '开启并安装', prepareTokenizerNow: '立即安装 tokenizer', disableOutputSavings: '停用计量', clearSavingsHistory: '清空历史', uninstallTokenizer: '卸载 tokenizer',
    savingsEnabled: '输出节省计量已启用。', savingsDisabled: '输出节省计量已停用。', tokenizerNotInstalled: '未安装', tokenizerReady: '输出节省 tokenizer 运行时已就绪。', tokenizerUnavailable: '输出节省已启用，但 tokenizer 运行时不可用。',
    savingsSummaryUnavailable: 'Token 汇总统计不可用。', turnOnToReview: '开启后即可查看 Tokenless 已节省多少 output token。', savingsUnavailableTooltip: 'Token 汇总统计不可用；开启后即可查看已节省的 output token。', tokenizerPreparesOnFirstResponse: 'Tokenless 首次计量可见响应时会准备 tokenizer。', manageOutputSavings: '在系统中管理',
    confirmClearSavings: '清空全部输出节省计量记录？此操作无法撤销。', confirmUninstallTokenizer: '停用输出节省并移除本地 tokenizer 运行时？', tokensSavedShort: 'token 已节省',
    tokenUnitHelp: 'tokens · 模型处理文本的计量单位。圆框 T 是 Tokenless API 的单位图标，不是货币符号。一个 token 不一定对应一个字或一个词。', jobsCountUnit: '单位：任务数', estimatedTokenUnit: '单位：tokens · 按可见输出估算', matrixZeroLegend: '未使用', matrixAbsentLegend: '未接入', matrixCellOutcomes: '{succeeded} 成功 · {failed} 失败 · {canceled} 取消',
    analyticsTitle: '使用分析', analyticsLoading: '正在读取使用分析…', analyticsUnavailable: '无法读取使用分析。', retryAnalytics: '重试',
    range7d: '7 天', range30d: '30 天', range90d: '90 天', range1y: '1 年', rangeAll: '全部', utcDays: '每日数据按 UTC 划分。', selectedRange: '所选范围',
    mostUsedProvider: '最常用 Provider', completedJobs: '已结束任务', successRate: '成功率', capabilityBreadth: 'Capability 广度', capabilityBreadthValue: '已使用 {used}/{total}', noUsageYet: '还没有已完成的使用记录',
    cumulativeSavings: '累计输出节省', cumulativeSavingsHelp: '单位是 tokens（圆框 T 图标），表示模型处理的文本片段，不等于字数或词数。此图按可见回复在本地估算，不是 Provider 账单用量或节省金额。累计值包含所选时间之前的计量，未计量的输出不计入。', addedInRange: '所选范围新增', measurementCoverage: '测量覆盖',
    dailyOutcomes: '每日任务结果', dailyOutcomesHelp: '单位是任务数。每个任务在结束的 UTC 日期计 1 次，分为成功、失败、取消。运行中的任务不计入。', canceled: '已取消',
    capabilityUsageMatrixHelp: '每格表示某个 Provider 的一项能力被请求的次数，绿色越深，次数越多。每个已结束任务的每项能力计一次，失败和取消也计入。虚线格表示没有 API 接入路线，也没有使用记录。', routedRequirements: '次请求', supportedUnused: '这段时间内没有请求', unsupportedCapability: '没有 API 接入路线或请求记录',
    capabilityUsage_7d: '过去 7 天用了哪些能力', capabilityUsage_30d: '过去 30 天用了哪些能力', capabilityUsage_90d: '过去 90 天用了哪些能力', capabilityUsage_1y: '过去 1 年用了哪些能力', capabilityUsage_all: '至今用了哪些能力',
    matrixLess: '少', matrixMore: '多',
    capabilityMix: '每天用了哪些能力', capabilityMixHelp: '按天显示各类能力的请求次数，一个任务可以使用多项能力。包含失败和取消的任务，日期按 UTC 计算。', topCapabilities: '最常用的能力', topCapabilitiesHelp: '按这段时间内的请求次数排序。每个已结束任务的每项能力计一次，失败和取消也计入。',
    executionMix: '任务运行方式', unknownMode: '未知模式',
    noMeasuredSavings: '所选范围内没有已测量输出', noCapabilityUsage: '所选范围内没有记录 capability requirement', noProviderUsage: '所选范围内没有 provider 使用记录',
    offlineShort: '离线', menu: '菜单', mainContent: '主要内容', profileList: 'Profile 列表', navigation: '导航',
    semanticRouting: '语义路由', experimentalRouter: 'Experimental Router', routingLede: '把持久的语义 Router 与当前驱动它的模型 Engine 分开配置。', routerEngine: 'Router Engine', routerExperimentNote: 'Router 是 Tokenless 中持久的概念；当前 Engine 只在本页推荐模型，不会实际执行 provider 路由。',
    chromePromptApiEngine: 'Chrome Prompt API · Gemini Nano', sparkX25MlxEngine: 'Spark X2.5-4B · 本地 MLX', routerEngineHelp: 'V1 提供两个本地 Engine：Chrome Prompt API · Gemini Nano，以及固定的 Spark X2.5-4B MLX server。', routerDisabledError: '请先启用 Experimental Router，再运行实验。',
    rendererBrowser: 'Dashboard 所在浏览器', browserVersion: 'Renderer 浏览器版本', routerRequirement: 'Engine 要求', routerBrowserRequirement: 'Google Chrome 148+', sparkServerRequirement: '127.0.0.1:8080 上的 MLX server', routerBrowserModeUnsupported: 'Dashboard 所在浏览器模式当前不能使用这个 Engine。', routerBrowserUnsupported: 'Dashboard 当前不是运行在 Google Chrome 中；请在 Google Chrome 中打开 Dashboard 后再使用这个 Engine。', routerBrowserVersionUnsupported: 'Chrome Prompt API 要求 Google Chrome 148 或更高版本。检测到的 renderer 版本：',
    availability: 'API 可用性', routerProviders: 'Provider 路由规则', routerProvidersHelp: '描述什么时候该用每个已对接的 AI provider；只有当前 profile 已启用的 provider 才会成为 Nano 候选。', suitableTasks: '适合用于', providerSuitableTasksPlaceholder: '写作、编辑以及对语气敏感的内容', providerDefaultModel: 'Provider 默认 / 尚未检查', routerProviderToggleHelp: 'Provider 是否可用由 Provider 页面控制。已关闭的 provider 仍会显示，但不能配置或参与路由。',
    providerDetailLede: '管理所选 profile 中这个 provider 的控件与 Experimental Router 角色。', providerRoutingRole: '路由角色', providerRoutingRoleHelp: '描述 Experimental Router 比较已启用候选项时，应该交给这个 provider 的任务。', providerRoleDisabled: '当前 profile 已停用这个 provider。启用后才能编辑路由角色；停用的 provider 永远不会成为 Router 候选项。', notConfigured: '尚未配置',
    routerNeedsEnabledProviders: '请先为当前 profile 启用至少一个 AI provider。', routerNeedsProviderRules: '请为至少一个已启用的 provider 描述适合的任务。', routerTaskRequired: '请输入任务 prompt。', routerApiUnsupported: 'Dashboard 所在 renderer 没有暴露所选 Router Engine。', routerApiUnavailable: '当前 Dashboard renderer 或设备无法使用所选 Router Engine。', routerInvalidResult: '所选 Router Engine 返回了无效的 provider 选择。',
    routerTest: '语义路由实验', routerTestHelp: '所选本地 Engine 会在确定性排除之后收到剩余 provider 的规则、所选 model、当前 profile plan 和已知额度。', taskPrompt: '任务 prompt', taskPromptPlaceholder: '用自信的语气起草一份产品发布公告。', runSemanticRouter: '运行语义路由', routerRunning: '路由中…', routerResult: '结构化结果', startHarnessRun: '启动 Harness run', harnessStarting: '正在启动 Harness run…', harnessRun: 'Harness run', harnessProfileRequired: '请先选择一个 managed profile，再启动 Harness run。', routerSemanticManifest: 'Terminal-Bench 语义 manifest', routerSemanticManifestHelp: '通过所选本地 Engine 分类全部 66 个 pinned instruction，并写入可通过 validator 的 external manifest。', routerSemanticManifestTarget: '请使用 tokenless dashboard --semantic-manifest-output <absolute-path> 打开此 Dashboard。这个 target 只能使用一次，并在 30 分钟后过期。', routerSemanticManifestRun: '分类 66 个 task', routerSemanticManifestRunning: '分类中…', routerSemanticManifestSaved: 'Semantic manifest 已保存', routerManifestTargetRequired: '请先使用明确的 semantic manifest output target 打开此 Dashboard。', routerManifestTaskTypeInvalid: '所选本地 Engine 返回了不符合边界的 task type。', downloadProgress: '模型下载', downloadZeroHelp: '0% 表示 Chrome 已接受下载请求，但尚未报告进一步的模型进度。请查看下方的 Model Status 和 Event Logs。',
    chromeSetup: '启用 Chrome 实验性 AI', chromeSetupIntro: '要看到 testing page 并使用 Prompt API，需要先启用以下本机 Chrome flags。', chromeSetupOptimization: '把 On-device model 设为 Enabled：', chromeSetupPrompt: '把 Prompt API for Gemini Nano 设为 Enabled（或 Enabled Multilingual）：', chromeSetupRelaunch: '修改 flags 后重新启动 Chrome。', chromeSetupInspect: '打开 Model Status 和 Event Logs：', chromeModelVersionHelp: 'Chrome 会在这个内部页面展示已安装 component 和模型信息；Prompt API 不会向 JavaScript 暴露精确模型版本。', sparkSetup: '运行本地 Spark MLX server', sparkSetupIntro: 'Spark X2.5-4B 通过固定的 OpenAI 兼容 MLX endpoint 在本机运行，不需要 Ollama。', sparkSetupCommand: "在 Apple Silicon 上：clone https://github.com/XHToken/Spark-MLX-LLM，cd Spark-MLX-LLM，创建 .venv，运行 .venv/bin/python -m pip install -e '.[test]'，然后运行 .venv/bin/spark-mlx-server --model XHToken/Spark-X2.5-4B --host 127.0.0.1 --port 8080 --allowed-origins http://127.0.0.1:7331", sparkSetupEndpoint: 'Health：http://127.0.0.1:8080/health · Chat：http://127.0.0.1:8080/v1/chat/completions',
}

const messages = {
  en: enMessages,
  'zh-CN': zhMessages,
} as const

export type MessageKey = keyof typeof messages.en

const capabilityZh: Record<string, readonly [string, string]> = {
  'conversation.chat': ['对话', '提交 prompt，并读取与本次提交对应的可见 provider 响应。'],
  'conversation.continue': ['继续对话', '继续由 Tokenless 精确选中的持久 provider 对话。'],
  'model.compare': ['比较模型', '对同一个 prompt 返回两份完整可见模型回答，不静默丢弃任一结果。'],
  'file.upload': ['上传文件', '附加调用方选择的文件，并证明 provider 已在可见界面接收。'],
  'document.input': ['文档输入', '把文档作为 provider 输入。'],
  'image.input': ['图片输入', '把图片作为 provider 输入。'],
  'audio.input': ['音频输入', '把音频作为 provider 输入。'],
  'audio.transcription': ['音频转写', '生成与调用方所选音频对应的完整可见文字稿。'],
  'video.input': ['视频输入', '把视频作为 provider 输入。'],
  'url.input': ['URL 输入', '把调用方授权的 URL 作为 provider 输入。'],
  'repository.import': ['导入代码仓库', '通过 provider 原生流程导入已授权的代码仓库。'],
  'search.web': ['网页搜索', '使用 provider 原生网页检索策略返回有依据的结果。'],
  'research.deep': ['深度研究', '完成 provider 原生研究流程，并交付带引用的最终报告。'],
  'reasoning.extended': ['扩展推理', '使用已有证据的 provider 推理策略，而不是直接依赖原始模式标签。'],
  'code.execute': ['执行代码', '在 provider 所有的可见环境中执行代码。'],
  'data.analyze': ['数据分析', '通过 provider 原生工作流分析结构化数据。'],
  'image.generation': ['图片生成', '生成完整的 provider 原生图片产物。'],
  'image.edit': ['图片编辑', '依据提交的源图片和指令生成对应的完整编辑结果。'],
  'video.generation': ['视频生成', '生成完整的 provider 原生视频产物。'],
  'audio.generation': ['音频生成', '生成完整的 provider 原生音频产物。'],
  'document.generation': ['文档生成', '生成完整的 provider 原生文档产物。'],
  'presentation.generation': ['演示文稿生成', '生成完整的 provider 原生演示文稿产物。'],
  'spreadsheet.generation': ['电子表格生成', '生成完整的 provider 原生电子表格产物。'],
  'website.generation': ['网站生成', '生成完整的 provider 原生网站产物。'],
  'workspace.native': ['原生 workspace', '创建或复用精确的 provider 原生 Project 或同类 workspace。'],
  'workspace.instructions': ['Workspace 指令', '通过 provider 原生 workspace 应用指令，并证明其可见效果。'],
  'workspace.knowledge': ['Workspace 知识', '在精确的 provider 原生 workspace 中持久保存已授权知识。'],
  'source.connected': ['已连接来源', '读取明确授权的 provider connector 或已连接来源。'],
  'response.citations': ['响应引用', '要求返回由 provider 响应中可见链接支撑的标准化引用。'],
  'artifact.download': ['可下载产物', '要求 provider 提供已完成且可下载的产物。'],
  'task.background': ['后台任务', '允许持久 provider 任务在页面不处于前台时继续运行。'],
  'task.interactive': ['交互任务', '把 provider 的澄清或确认显示为可恢复的 waiting-for-user 状态。'],
}

const capabilityFamilyZh: Record<string, string> = {
  conversation: '对话',
  input: '输入',
  retrieval_reasoning: '检索与推理',
  media_generation: '媒体生成',
  artifact_generation: '文档与网页',
  workspace_knowledge: '项目与知识',
  evidence_lifecycle: '引用与任务控制',
}

const stateEn: Record<string, string> = {
  guest: 'Guest access',
  account_blocked: 'Account blocked',
  signed_in_free: 'Signed in · free plan',
  signed_in_paid: 'Signed in · paid plan',
  signed_in_unknown: 'Signed in · plan unknown',
}

const stateZh: Record<string, string> = {
  ok: '正常',
  warning: '警告',
  error: '错误',
  ready: '就绪',
  stopped: '已停止',
  idle: '空闲',
  active: '运行中',
  quiescing: '静默中',
  queued: '排队中',
  running: '运行中',
  waiting_for_user: '等待用户',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
  eligible: '可路由',
  ineligible: '不可路由',
  action_required: '需要处理',
  experimental: '实验性',
  beta: '测试版',
  stable: '稳定',
  supported: '支持',
  partial: '部分支持',
  unavailable: '不可用',
  unknown: '未知',
  guest: '访客模式',
  account_blocked: '账号受限',
  signed_in_free: '已登录 · 免费方案',
  signed_in_paid: '已登录 · 付费方案',
  signed_in_unknown: '已登录 · 方案未知',
}

const dashboardErrorZh = {
  ...ERROR_SUMMARIES_ZH,
  dashboard_request_failed: 'Dashboard 请求失败。',
  dashboard_route_not_found: '找不到请求的 Dashboard 接口。',
  dashboard_session_required: '请重新打开本地 Dashboard 以建立新会话。',
  dashboard_origin_rejected: '请求来源不受允许。',
  dashboard_csrf_rejected: '请求安全令牌无效。',
  dashboard_host_rejected: '请求 Host 不受允许。',
  dashboard_body_too_large: '请求内容过大。',
  dashboard_json_invalid: '请求内容必须是有效的 JSON object。',
  terminalbench_manifest_target_required: '请通过 semantic-manifest CLI target 打开 Dashboard。',
  terminalbench_manifest_target_expired: 'Semantic manifest target 已过期，请重新运行 CLI command。',
  terminalbench_tasks_unavailable: '找不到或无法验证 pinned Terminal-Bench instructions。',
  terminalbench_manifest_write_failed: '无法写入 semantic manifest output。',
  terminalbench_manifest_target_exists: 'Semantic manifest output 已存在，请选择新路径。',
  invalid_browser: '浏览器选择无效。',
  invalid_browser_executable_path: '浏览器 executable path 必须为空或使用绝对路径。',
  browser_executable_path_requires_system_browser: '只有明确选择 system browser 后才能设置 executable path。',
  browser_executable_not_found: '找不到浏览器 executable。请粘贴绝对路径，或改选其他浏览器。',
  browser_executable_identity_mismatch: '所选 executable 与浏览器类型不匹配，请选择正确的 Chrome 或 Brave 路径。',
  browser_executable_path_invalid: '浏览器 executable path 必须使用绝对路径。',
  browser_runtime_executable_missing: '该路径不是可运行的浏览器 executable。',
  browser_runtime_version_unreadable: '无法读取这个浏览器的版本。',
  browser_runtime_download_required: '这个 managed browser 尚未安装。',
  browser_runtime_download_failed: '浏览器 runtime 下载失败。',
  browser_runtime_install_requires_managed_browser: '只有 managed-chromium 和 cloak 可以由 Tokenless 安装。',
  browser_runtime_repair_unsafe: '仍有浏览器任务运行，暂时不能修复 runtime。',
  invalid_browser_visibility: '浏览器可见性无效。',
  native_chrome_required: 'Tokenless 原生模式仅支持正在运行的 Google Chrome 或 Brave Browser。',
  native_browser_not_installed: '找不到所选的 Chrome 或 Brave。请在实际使用浏览器前配置 browser executable path。',
  native_chrome_executable_unsupported: '原生 Chrome 会自动发现正在运行的稳定版，不接受 executable path。',
  invalid_language: '语言必须是 en 或 zh-CN。',
  browser_mutation_unsafe: '仍有浏览器任务运行，暂时不能更改浏览器选择。',
  browser_runtime_unavailable: '浏览器运行时不可用。',
  unsafe_managed_profile_destination: 'Managed profile 的目标目录不安全，已停止复制。',
  invalid_profile_slug: 'Profile slug 只能使用小写字母、数字和连字符。',
  invalid_role_label: '角色标签不能超过 80 个字符。',
  profile_mutation_unsafe: '仍有浏览器任务运行，暂时不能移除 profile。',
  profile_proxy_mutation_unsafe: '仍有浏览器任务运行，暂时不能更改 proxy。',
  invalid_provider_list: '启用的 provider 列表无效。',
  provider_not_enabled: '请先为该 profile 启用 provider。',
  provider_not_supported: '该 provider 暂不受支持。',
  provider_direct_only: '该 provider 仅支持 Direct execution，不能执行浏览器操作。',
  profile_runtime_rebind_blocked: '该 profile 已绑定到另一个浏览器 runtime；请保留原绑定，或使用新的 profile slug。',
  provider_selection_invalid: '选择类型必须是 model 或 effort。',
  invalid_proxy: 'Proxy 必须使用不含嵌入凭据的 HTTP、HTTPS 或 SOCKS5 地址。',
  invalid_fields: '请求包含不受支持的字段。',
  output_savings_uninstall_confirmation_required: '移除输出节省运行时前需要明确确认。',
  output_savings_clear_confirmation_required: '清除输出节省历史前需要明确确认。',
} as const

export function translate(language: Language, key: MessageKey, params: Readonly<Record<string, string | number>> = {}) {
  return interpolateTokenlessMessage(messages[language][key], params)
}

export function translateError(language: Language, code: string, fallback?: string) {
  if (language === 'zh-CN') {
    return Object.prototype.hasOwnProperty.call(dashboardErrorZh, code)
      ? dashboardErrorZh[code as keyof typeof dashboardErrorZh]
      : `${translate(language, 'requestFailed')}${code ? ` (${code})` : ''}`
  }
  return fallback ?? translate(language, 'requestFailed')
}

export function capabilityText(language: Language, capability: JsonRecord) {
  const localized = language === 'zh-CN' ? capabilityZh[String(capability.id)] : undefined
  return localized ? { title: localized[0], description: localized[1] } : capability
}

export function capabilityFamilyLabel(language: Language, family: string) {
  const labels: Record<string, string> = { conversation: 'Conversation', input: 'Input', retrieval_reasoning: 'Search & reasoning', media_generation: 'Media creation', artifact_generation: 'Documents & websites', workspace_knowledge: 'Projects & knowledge', evidence_lifecycle: 'Citations & task controls' }
  return language === 'zh-CN' ? capabilityFamilyZh[family] ?? family : labels[family] ?? family.replaceAll('_', ' ')
}

export function stateLabel(language: Language, value: unknown) {
  const state = String(value ?? 'unknown')
  if (language === 'zh-CN') return stateZh[state] ?? state
  if (stateEn[state]) return stateEn[state]
  if (state === 'ok') return 'OK'
  return state
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase())
}
