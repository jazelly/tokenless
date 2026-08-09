import { ERROR_SUMMARIES_ZH } from './catalog.js'

type JsonRecord = Record<string, any>
type Language = 'en' | 'zh-CN'

const enMessages = {
    overview: 'Overview', profiles: 'Profiles', providers: 'Providers', capabilities: 'Capabilities', jobs: 'Jobs', system: 'System',
    localConsole: 'Local console', operationalSummary: 'Operational summary', overviewLede: 'The exact daemon, browser, provider, and job state on this machine.',
    daemon: 'Daemon', browser: 'Browser runtime', activeProfiles: 'Active profiles', waitingJobs: 'Waiting jobs', healthy: 'Healthy',
    actionRequired: 'Action required', recentJobs: 'Recent jobs', providerReadiness: 'Provider readiness', noJobs: 'No jobs yet', noJobsBody: 'Durable jobs will appear here when Tokenless starts work.',
    profileManagement: 'Tokenless profiles', profilesLede: 'Manage provider tabs, purpose, and provider scope in your connected Chrome.',
    cleanProfileNote: 'Profiles organize Tokenless-owned tabs in your running Chrome. They do not copy or isolate your Chrome identity.',
    createProfile: 'Create profile', label: 'Display label', slug: 'Profile slug', role: 'Purpose or role', visibility: 'Visibility', enabledProviders: 'Enabled providers',
    save: 'Save', cancel: 'Cancel', open: 'Open', remove: 'Remove', setDefault: 'Set default', default: 'Default', imported: 'Legacy imported', clean: 'Clean',
    providerConfiguration: 'Provider configuration', providersLede: 'Intent, observed access, evidence, and routing eligibility stay separate.', selectProfile: 'Profile',
    enabled: 'Enabled', disabled: 'Disabled', neverChecked: 'Never checked', checkNow: 'Check readiness', inspectControls: 'Inspect controls',
    refreshProviderReadiness: 'Refresh provider readiness', checkingProviderReadiness: 'Checking provider sign-in…', providerReadinessRefreshed: 'Provider readiness refreshed.', providerReadinessPartiallyRefreshed: 'Provider readiness refreshed; some checks could not complete.', providerReadinessRefreshTimedOut: 'Provider readiness checks are still running. Review Jobs for progress.', noEnabledProviders: 'No providers are enabled for this profile.',
    capabilityCatalog: 'Capability catalog', capabilitiesLede: 'Start from caller outcomes, then see which evidence-backed provider routes can satisfy them.', noRoute: 'No evidenced route',
    durableJobs: 'Durable jobs', jobsLede: 'Inspect exact state transitions, blockers, normalized results, and recovery actions.', allStatuses: 'All statuses', allProviders: 'All providers', allProfiles: 'All profiles', searchJobs: 'Search task or job…', details: 'Details', resume: 'Resume headed',
    settingsDiagnostics: 'System and diagnostics', systemLede: 'Shared preferences, runtime controls, compatibility, and redacted repair information.', language: 'Language', quiesce: 'Quiesce runtime', copyDiagnostics: 'Copy diagnostics', diagnostics: 'Diagnostics',
    updateSaved: 'Changes saved.', requestFailed: 'Request failed.', offline: 'Console is offline', offlineBody: 'The daemon stopped responding. Polling will resume automatically.', sessionExpired: 'Dashboard session expired', reopen: 'Open the local console again to start a new session.',
    loading: 'Loading current state…', empty: 'Nothing to show', confirmRemove: 'Type the profile slug to confirm permanent removal:', create: 'Create', browserSelection: 'Browser for new profiles', browserExecutablePath: 'Browser executable path', browserExecutablePathPlaceholder: '/absolute/path/to/browser or Browser.app…', browserExecutablePathConfigured: 'A verified path is cached. Leave blank to keep it, or paste a replacement.', browserExecutablePathHelp: 'Paste an absolute executable path. On macOS, an application bundle such as Browser.app is also accepted.', defaultVisibility: 'Default visibility', proxy: 'Proxy server', proxyBypass: 'Proxy bypass (comma separated)', proxyRestartNote: 'Changing the proxy first quiesces active browser ownership and recreates this profile context.', none: 'None', openBrowser: 'Open browser', savedAt: 'Saved',
    stage: 'Stage', lifecycle: 'Lifecycle', evidence: 'Evidence', result: 'Result', error: 'Error', attempts: 'Provider attempts', created: 'Created', updated: 'Updated',
    primaryNavigation: 'Primary navigation', uptimeUnit: 'min uptime', activeUnit: 'active', configuredUnit: 'configured', durableUnit: 'durable',
    documentTitle: 'Tokenless local console', skipToContent: 'Skip to content',
    configPersisted: 'Configuration is persisted.', setupIncomplete: 'Setup has not persisted configuration yet.', browserReady: 'The browser runtime is available.', browserUnavailable: 'The browser runtime is unavailable.', noManagedProfiles: 'No managed profile is configured.', profilesRegistered: 'managed profile(s) registered.', activeBrowserJobs: 'active browser job(s).',
    setup: 'Setup', setupTitle: 'Set up Tokenless', setupBody: 'Connect to a Google Chrome or Brave Browser you already installed.', nativeChromeConnectionHelp: 'Tokenless does not bundle or download Chrome or Brave. The selected browser must already be installed; otherwise setup stops. Enable Remote Debugging in it before continuing. Only explicit Anti-Detect setup downloads CloakBrowser.', googleChrome: 'My Google Chrome', braveBrowser: 'My Brave Browser', continue: 'Continue', finishSetup: 'Finish setup', back: 'Back',
    appearance: 'Appearance', profile: 'Profile', connection: 'Connection', advanced: 'Advanced', edit: 'Edit', more: 'More', close: 'Close',
    profileBrowser: 'Browser', providersShort: 'Providers', profileReady: 'Ready', lastChecked: 'Last checked', openMenu: 'Open menu',
    addProfile: 'Add profile', noProfiles: 'No profiles', required: 'Required', optional: 'Optional', profileCreated: 'Profile created.',
    proxySettings: 'Proxy settings', providerAccess: 'Provider access', deleteProfile: 'Delete profile', deleteWarning: 'This removes the logical Tokenless profile. It does not close Chrome.',
    status: 'Status', version: 'Version', runtime: 'Runtime', ready: 'Ready', stopped: 'Stopped', selected: 'Selected', signedIn: 'signed in',
    refresh: 'Refresh', search: 'Search', queued: 'Queued', succeeded: 'Succeeded', failed: 'Failed', waiting: 'Waiting',
    noResults: 'No matching results', copy: 'Copy', copied: 'Copied.', copyFailed: 'Could not copy diagnostics.', account: 'Account', model: 'Model', effort: 'Effort',
    useBrowser: 'Use browser', chooseProviders: 'Choose providers', setupProfileHelp: 'A profile groups Tokenless-owned provider tabs and configuration.',
    automatic: 'Automatic', available: 'Available', notFound: 'Not found', downloadRequired: 'Download required', scanningBrowsers: 'Scanning installed browsers…',
    managedByTokenless: 'Managed by Tokenless', systemBrowser: 'System browser', runtimeDownloadHelp: 'Download and verify this runtime before using it.', automaticBrowserHelp: 'Automatic selection resolves to the platform-pinned managed Chrome for Testing.', browserNotDetectedHelp: 'Choose another browser or add its executable path.',
    installRuntime: 'Install', repairRuntime: 'Repair runtime', addExecutablePath: 'Add executable path', replaceExecutablePath: 'Replace executable path', hideExecutablePath: 'Hide custom path', verifiedPathCached: 'Verified path cached', validate: 'Validate', clearExecutablePath: 'Use automatic discovery', browserValidated: 'Executable verified', runtimeInstalled: 'Browser runtime installed.', runtimeRepaired: 'Browser runtime repaired.',
    languageHelp: 'Used by the local console and CLI.', confirmDelete: 'Enter the profile slug to remove it permanently.', unknown: 'Unknown',
    outputSavings: 'Output savings', outputSavingsLede: 'Estimate visible assistant output locally. Measurement is on by default; disabling pauses future measurements and keeps saved history.',
    estimatedTokensSaved: 'Estimated output tokens saved', measuredResponses: 'Measured responses', tokenizerRuntime: 'Tokenizer runtime', runtimeSize: 'Installed size',
    lazyTokenizerDownload: 'The pinned WASM tokenizer is downloaded only when the first visible response needs measurement or when you install it here. It uses CPU only during short measurements and never requires a GPU.',
    enableOutputSavings: 'Turn on and install', prepareTokenizerNow: 'Install tokenizer now', disableOutputSavings: 'Disable measurement', clearSavingsHistory: 'Clear history', uninstallTokenizer: 'Uninstall tokenizer',
    savingsEnabled: 'Output savings measurement is enabled.', savingsDisabled: 'Output savings measurement is disabled.', tokenizerNotInstalled: 'Not installed', tokenizerReady: 'The output savings tokenizer runtime is ready.', tokenizerUnavailable: 'Output savings is enabled, but its tokenizer runtime is unavailable.',
    savingsSummaryUnavailable: 'Token summary statistics are unavailable.', turnOnToReview: 'Turn it on to review how many output tokens Tokenless has saved.', savingsUnavailableTooltip: 'Token summary statistics are unavailable. Turn it on to review output tokens saved.', tokenizerPreparesOnFirstResponse: 'The tokenizer will be prepared when Tokenless measures the first visible response.', manageOutputSavings: 'Manage in System',
    confirmClearSavings: 'Clear all saved output savings measurements? This cannot be undone.', confirmUninstallTokenizer: 'Disable output savings and remove the local tokenizer runtime?', tokensSavedShort: 'tokens saved',
    offlineShort: 'Offline', menu: 'Menu', mainContent: 'Main content', profileList: 'Profile list', navigation: 'Navigation',
} as const

const zhMessages: Record<keyof typeof enMessages, string> = {
    overview: '概览', profiles: 'Profile', providers: 'Provider', capabilities: '能力', jobs: '任务', system: '系统',
    localConsole: '本地控制台', operationalSummary: '运行概览', overviewLede: '查看这台机器上 daemon、浏览器、provider 和任务的真实状态。',
    daemon: 'Daemon', browser: '浏览器运行时', activeProfiles: '活跃 profile', waitingJobs: '等待任务', healthy: '健康',
    actionRequired: '需要处理', recentJobs: '最近任务', providerReadiness: 'Provider 就绪状态', noJobs: '还没有任务', noJobsBody: 'Tokenless 开始工作后，持久任务会显示在这里。',
    profileManagement: 'Tokenless profile', profilesLede: '管理已连接 Chrome 中的 provider tab、用途和 provider 范围。',
    cleanProfileNote: 'Profile 用于组织 Chrome 中由 Tokenless 创建的 tab；它不会复制或隔离你的 Chrome identity。',
    createProfile: '创建 profile', label: '显示名称', slug: 'Profile slug', role: '用途或角色', visibility: '可见性', enabledProviders: '启用的 provider',
    save: '保存', cancel: '取消', open: '打开', remove: '移除', setDefault: '设为默认', default: '默认', imported: '旧版导入', clean: '全新',
    providerConfiguration: 'Provider 配置', providersLede: '用户意图、实际观测、证据和路由资格分别展示，不混成一个状态。', selectProfile: 'Profile',
    enabled: '已启用', disabled: '已停用', neverChecked: '从未检查', checkNow: '检查就绪状态', inspectControls: '检查控件',
    refreshProviderReadiness: '刷新 Provider 就绪状态', checkingProviderReadiness: '正在检查 Provider 登录状态…', providerReadinessRefreshed: 'Provider 就绪状态已刷新。', providerReadinessPartiallyRefreshed: 'Provider 就绪状态已刷新；部分检查未能完成。', providerReadinessRefreshTimedOut: 'Provider 就绪检查仍在运行，请前往任务页面查看进度。', noEnabledProviders: '此 Profile 没有已启用的 Provider。',
    capabilityCatalog: '能力目录', capabilitiesLede: '先看调用方需要的结果，再看哪些 provider 路由已有真实证据。', noRoute: '暂无证据路由',
    durableJobs: '持久任务', jobsLede: '检查精确状态、阻塞原因、标准化结果和恢复操作。', allStatuses: '全部状态', allProviders: '全部 provider', allProfiles: '全部 profile', searchJobs: '搜索 task 或 job…', details: '详情', resume: '以 headed 恢复',
    settingsDiagnostics: '系统与诊断', systemLede: '管理共享偏好、运行时控制、兼容性和已脱敏的修复信息。', language: '语言', quiesce: '静默浏览器运行时', copyDiagnostics: '复制诊断信息', diagnostics: '诊断',
    updateSaved: '更改已保存。', requestFailed: '请求失败。', offline: '控制台已离线', offlineBody: 'Daemon 暂时没有响应；连接恢复后会自动继续轮询。', sessionExpired: '控制台会话已过期', reopen: '请重新打开本地控制台以建立新会话。',
    loading: '正在读取当前状态…', empty: '暂无内容', confirmRemove: '输入 profile slug 以确认永久移除：', create: '创建', browserSelection: '新 profile 使用的浏览器', browserExecutablePath: '浏览器 executable path', browserExecutablePathPlaceholder: '/浏览器的绝对路径或 Browser.app…', browserExecutablePathConfigured: '已缓存经过验证的路径。留空会保留，也可以粘贴新路径替换。', browserExecutablePathHelp: '粘贴 executable 的绝对路径；macOS 也可以直接填写 Browser.app 应用路径。', defaultVisibility: '默认可见性', proxy: 'Proxy server', proxyBypass: 'Proxy bypass（逗号分隔）', proxyRestartNote: '更改 proxy 会先让浏览器运行时进入静默状态，再重建该 profile 的 context。', none: '无', openBrowser: '打开浏览器', savedAt: '保存时间',
    stage: '阶段', lifecycle: '生命周期', evidence: '证据', result: '结果', error: '错误', attempts: 'Provider 尝试', created: '创建时间', updated: '更新时间',
    primaryNavigation: '主要导航', uptimeUnit: '分钟运行时间', activeUnit: '活跃', configuredUnit: '已配置', durableUnit: '持久任务',
    documentTitle: 'Tokenless 本地控制台', skipToContent: '跳到主要内容',
    configPersisted: '配置已持久化。', setupIncomplete: 'Setup 尚未保存配置。', browserReady: '浏览器运行时可用。', browserUnavailable: '浏览器运行时不可用。', noManagedProfiles: '尚未配置 managed profile。', profilesRegistered: '个 managed profile 已注册。', activeBrowserJobs: '个浏览器任务正在运行。',
    setup: '设置', setupTitle: '设置 Tokenless', setupBody: '连接你已经自行安装的 Google Chrome 或 Brave Browser。', nativeChromeConnectionHelp: 'Tokenless 不会 bundle 或下载 Chrome/Brave；所选浏览器必须已经安装，否则 setup 会停止。继续前请在其中启用 Remote Debugging。只有显式选择 Anti-Detect setup 才会下载 CloakBrowser。', googleChrome: '我的 Google Chrome', braveBrowser: '我的 Brave Browser', continue: '继续', finishSetup: '完成设置', back: '返回',
    appearance: '外观', profile: 'Profile', connection: '连接', advanced: '高级', edit: '编辑', more: '更多', close: '关闭',
    profileBrowser: '浏览器', providersShort: 'Provider', profileReady: '就绪', lastChecked: '上次检查', openMenu: '打开菜单',
    addProfile: '添加 profile', noProfiles: '暂无 profile', required: '必填', optional: '选填', profileCreated: 'Profile 已创建。',
    proxySettings: 'Proxy 设置', providerAccess: 'Provider 访问', deleteProfile: '删除 profile', deleteWarning: '这会移除逻辑 Tokenless profile，但不会关闭 Chrome。',
    status: '状态', version: '版本', runtime: '运行时', ready: '就绪', stopped: '已停止', selected: '已选择', signedIn: '已登录',
    refresh: '刷新', search: '搜索', queued: '排队中', succeeded: '已完成', failed: '失败', waiting: '等待中',
    noResults: '没有匹配结果', copy: '复制', copied: '已复制。', copyFailed: '无法复制诊断信息。', account: '账号', model: '模型', effort: '推理强度',
    useBrowser: '使用浏览器', chooseProviders: '选择 provider', setupProfileHelp: 'Profile 用于组织 Tokenless 创建的 provider tab 与配置。',
    automatic: '自动选择', available: '可用', notFound: '未找到', downloadRequired: '需要下载', scanningBrowsers: '正在扫描已安装的浏览器…',
    managedByTokenless: '由 Tokenless 管理', systemBrowser: '系统浏览器', runtimeDownloadHelp: '使用前需要下载并验证这个 runtime。', automaticBrowserHelp: '自动选择会解析为按平台固定版本的 managed Chrome for Testing。', browserNotDetectedHelp: '请选择其他浏览器，或添加它的 executable path。',
    installRuntime: '安装', repairRuntime: '修复 runtime', addExecutablePath: '添加 executable path', replaceExecutablePath: '替换 executable path', hideExecutablePath: '收起自定义路径', verifiedPathCached: '已缓存验证路径', validate: '验证', clearExecutablePath: '恢复自动发现', browserValidated: 'Executable 验证通过', runtimeInstalled: '浏览器 runtime 已安装。', runtimeRepaired: '浏览器 runtime 已修复。',
    languageHelp: '用于本地控制台和 CLI。', confirmDelete: '输入 profile slug 以永久移除。', unknown: '未知',
    outputSavings: '输出节省', outputSavingsLede: '在本机估算可见 assistant 输出。计量默认开启；停用后会暂停后续计量，但保留已保存的历史。',
    estimatedTokensSaved: '估算节省的 output token', measuredResponses: '已计量响应', tokenizerRuntime: 'Tokenizer 运行时', runtimeSize: '安装大小',
    lazyTokenizerDownload: '固定版本的 WASM tokenizer 只会在首次计量可见响应时，或你在此处主动安装时下载。它仅在短时计量期间使用 CPU，不需要 GPU。',
    enableOutputSavings: '开启并安装', prepareTokenizerNow: '立即安装 tokenizer', disableOutputSavings: '停用计量', clearSavingsHistory: '清空历史', uninstallTokenizer: '卸载 tokenizer',
    savingsEnabled: '输出节省计量已启用。', savingsDisabled: '输出节省计量已停用。', tokenizerNotInstalled: '未安装', tokenizerReady: '输出节省 tokenizer 运行时已就绪。', tokenizerUnavailable: '输出节省已启用，但 tokenizer 运行时不可用。',
    savingsSummaryUnavailable: 'Token 汇总统计不可用。', turnOnToReview: '开启后即可查看 Tokenless 已节省多少 output token。', savingsUnavailableTooltip: 'Token 汇总统计不可用；开启后即可查看已节省的 output token。', tokenizerPreparesOnFirstResponse: 'Tokenless 首次计量可见响应时会准备 tokenizer。', manageOutputSavings: '在系统中管理',
    confirmClearSavings: '清空全部输出节省计量记录？此操作无法撤销。', confirmUninstallTokenizer: '停用输出节省并移除本地 tokenizer 运行时？', tokensSavedShort: 'token 已节省',
    offlineShort: '离线', menu: '菜单', mainContent: '主要内容', profileList: 'Profile 列表', navigation: '导航',
}

const messages = { en: enMessages, 'zh-CN': zhMessages } as const

export type MessageKey = keyof typeof messages.en

const capabilityZh: Record<string, readonly [string, string]> = {
  'conversation.chat': ['对话', '提交 prompt，并读取与本次提交对应的可见 provider 响应。'],
  'conversation.continue': ['继续对话', '继续由 Tokenless 精确选中的持久 provider 对话。'],
  'file.upload': ['上传文件', '附加调用方选择的文件，并证明 provider 已在可见界面接收。'],
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
  artifact_generation: '产物生成',
  workspace_knowledge: 'Workspace 与知识',
  evidence_lifecycle: '证据与生命周期',
}

const stateEn: Record<string, string> = {
  guest: 'Guest access',
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
  claimed: '已领取',
  running: '运行中',
  waiting_for_user: '等待用户',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
  timed_out: '已超时',
  eligible: '可路由',
  ineligible: '不可路由',
  clean: '全新',
  importing: '导入中',
  action_required: '需要处理',
  experimental: '实验性',
  beta: '测试版',
  stable: '稳定',
  supported: '支持',
  partial: '部分支持',
  unavailable: '不可用',
  unknown: '未知',
  guest: '访客模式',
  signed_in_free: '已登录 · 免费方案',
  signed_in_paid: '已登录 · 付费方案',
  signed_in_unknown: '已登录 · 方案未知',
}

const uiErrorZh = {
  ...ERROR_SUMMARIES_ZH,
  ui_request_failed: '控制台请求失败。',
  ui_route_not_found: '找不到请求的控制台接口。',
  ui_session_required: '请重新打开本地控制台以建立新会话。',
  ui_origin_rejected: '请求来源不受允许。',
  ui_csrf_rejected: '请求安全令牌无效。',
  ui_host_rejected: '请求 Host 不受允许。',
  ui_body_too_large: '请求内容过大。',
  ui_json_invalid: '请求内容必须是有效的 JSON object。',
  invalid_browser: '浏览器选择无效。',
  invalid_browser_executable_path: '浏览器 executable path 必须为空或使用绝对路径。',
  browser_executable_path_requires_system_browser: '只有明确选择 system browser 后才能设置 executable path。',
  browser_executable_not_found: '找不到浏览器 executable。请粘贴绝对路径，或改选其他浏览器。',
  browser_executable_path_invalid: '浏览器 executable path 必须使用绝对路径。',
  browser_runtime_executable_missing: '该路径不是可运行的浏览器 executable。',
  browser_runtime_version_unreadable: '无法读取这个浏览器的版本。',
  browser_runtime_download_required: '这个 managed browser 尚未安装。',
  browser_runtime_download_failed: '浏览器 runtime 下载失败。',
  browser_runtime_install_requires_managed_browser: '只有 managed-chromium 和 cloak 可以由 Tokenless 安装。',
  browser_runtime_repair_unsafe: '仍有浏览器任务运行，暂时不能修复 runtime。',
  invalid_browser_visibility: '浏览器可见性无效。',
  native_chrome_required: 'Tokenless 原生模式仅支持正在运行的 Google Chrome 或 Brave Browser。',
  native_browser_not_installed: '找不到所选的 Chrome 或 Brave。请先自行安装该浏览器，或运行 CLI setup 选择 Anti-Detect；Tokenless 不会 bundle 或下载 Chrome/Brave。',
  native_chrome_executable_unsupported: '原生 Chrome 会自动发现正在运行的稳定版，不接受 executable path。',
  invalid_language: '语言必须是 en 或 zh-CN。',
  browser_mutation_unsafe: '仍有浏览器任务运行，暂时不能更改浏览器选择。',
  browser_runtime_unavailable: '浏览器运行时不可用。',
  unsafe_managed_profile_destination: 'Managed profile 的目标目录不安全，已停止复制。',
  invalid_profile_slug: 'Profile slug 只能使用小写字母、数字和连字符。',
  invalid_profile_label: 'Profile 名称必须为 1 到 80 个字符。',
  invalid_role_label: '角色标签不能超过 80 个字符。',
  profile_mutation_unsafe: '仍有浏览器任务运行，暂时不能移除 profile。',
  profile_proxy_mutation_unsafe: '仍有浏览器任务运行，暂时不能更改 proxy。',
  invalid_provider_list: '启用的 provider 列表无效。',
  provider_not_enabled: '请先为该 profile 启用 provider。',
  provider_not_supported: '该 provider 暂不受支持。',
  provider_selection_invalid: '选择类型必须是 model 或 effort。',
  invalid_proxy: 'Proxy 必须使用不含嵌入凭据的 HTTP、HTTPS 或 SOCKS5 地址。',
  invalid_fields: '请求包含不受支持的字段。',
  output_savings_uninstall_confirmation_required: '移除输出节省运行时前需要明确确认。',
  output_savings_clear_confirmation_required: '清除输出节省历史前需要明确确认。',
} as const

export function translate(language: Language, key: MessageKey) {
  return messages[language][key]
}

export function translateError(language: Language, code: string, fallback?: string) {
  if (language === 'zh-CN') {
    return Object.prototype.hasOwnProperty.call(uiErrorZh, code)
      ? uiErrorZh[code as keyof typeof uiErrorZh]
      : `${translate(language, 'requestFailed')}${code ? ` (${code})` : ''}`
  }
  return fallback ?? translate(language, 'requestFailed')
}

export function capabilityText(language: Language, capability: JsonRecord) {
  const localized = language === 'zh-CN' ? capabilityZh[String(capability.id)] : undefined
  return localized ? { title: localized[0], description: localized[1] } : capability
}

export function capabilityFamilyLabel(language: Language, family: string) {
  return language === 'zh-CN' ? capabilityFamilyZh[family] ?? family : family.replaceAll('_', ' ')
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
