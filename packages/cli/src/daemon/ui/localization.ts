import type { JsonRecord, Language } from './types.js'

const messages = {
  en: {
    overview: 'Overview', profiles: 'Profiles', providers: 'Providers', capabilities: 'Capabilities', jobs: 'Jobs', system: 'System',
    localConsole: 'Local console', operationalSummary: 'Operational summary', overviewLede: 'The exact daemon, browser, provider, and job state on this machine.',
    daemon: 'Daemon', browser: 'Browser runtime', activeProfiles: 'Active profiles', waitingJobs: 'Waiting jobs', healthy: 'Healthy',
    actionRequired: 'Action required', recentJobs: 'Recent jobs', providerReadiness: 'Provider readiness', noJobs: 'No jobs yet', noJobsBody: 'Durable jobs will appear here when Tokenless starts work.',
    profileManagement: 'Browser identities', profilesLede: 'Manage isolated browser identities, their purpose, provider scope, and runtime behavior.',
    cleanProfileNote: 'New profiles start clean unless the user explicitly consents to an opaque local profile copy; sign in through the visible managed browser.',
    createProfile: 'Create profile', label: 'Display label', slug: 'Profile slug', role: 'Purpose or role', visibility: 'Visibility', enabledProviders: 'Enabled providers',
    save: 'Save', cancel: 'Cancel', open: 'Open', remove: 'Remove', setDefault: 'Set default', default: 'Default', imported: 'Legacy imported', clean: 'Clean',
    providerConfiguration: 'Provider configuration', providersLede: 'Intent, observed access, evidence, and routing eligibility stay separate.', selectProfile: 'Profile',
    enabled: 'Enabled', disabled: 'Disabled', neverChecked: 'Never checked', checkNow: 'Check readiness', inspectControls: 'Inspect controls',
    capabilityCatalog: 'Capability catalog', capabilitiesLede: 'Start from caller outcomes, then see which evidence-backed provider routes can satisfy them.', noRoute: 'No evidenced route',
    durableJobs: 'Durable jobs', jobsLede: 'Inspect exact state transitions, blockers, normalized results, and recovery actions.', allStatuses: 'All statuses', allProviders: 'All providers', allProfiles: 'All profiles', searchJobs: 'Search task or job', details: 'Details', resume: 'Resume headed',
    settingsDiagnostics: 'System and diagnostics', systemLede: 'Shared preferences, runtime controls, compatibility, and redacted repair information.', language: 'Language', quiesce: 'Quiesce runtime', copyDiagnostics: 'Copy diagnostics', diagnostics: 'Diagnostics',
    updateSaved: 'Changes saved.', requestFailed: 'Request failed.', offline: 'Console is offline', offlineBody: 'The daemon stopped responding. Polling will resume automatically.', sessionExpired: 'Dashboard session expired', reopen: 'Run tokenless dashboard again to reauthenticate.',
    loading: 'Loading current state', empty: 'Nothing to show', confirmRemove: 'Type the profile slug to confirm permanent removal:', create: 'Create', browserSelection: 'Browser for new profiles', defaultVisibility: 'Default visibility', proxy: 'Proxy server', proxyBypass: 'Proxy bypass (comma separated)', proxyRestartNote: 'Changing the proxy first quiesces active browser ownership and recreates this profile context.', none: 'None', openBrowser: 'Open browser', savedAt: 'Saved',
    stage: 'Stage', lifecycle: 'Lifecycle', evidence: 'Evidence', result: 'Result', error: 'Error', attempts: 'Provider attempts', created: 'Created', updated: 'Updated',
    primaryNavigation: 'Primary navigation', uptimeUnit: 'min uptime', activeUnit: 'active', configuredUnit: 'configured', durableUnit: 'durable',
    documentTitle: 'Tokenless local console', skipToContent: 'Skip to content',
    configPersisted: 'Configuration is persisted.', setupIncomplete: 'Setup has not persisted configuration yet.', browserReady: 'The browser runtime is available.', browserUnavailable: 'The browser runtime is unavailable.', noManagedProfiles: 'No managed profile is configured.', profilesRegistered: 'managed profile(s) registered.', activeBrowserJobs: 'active browser job(s).',
    setup: 'Setup', setupTitle: 'Set up Tokenless', setupBody: 'Choose a local browser identity. You can change this later.', continue: 'Continue', finishSetup: 'Finish setup', back: 'Back',
    appearance: 'Appearance', profile: 'Profile', connection: 'Connection', advanced: 'Advanced', edit: 'Edit', more: 'More', close: 'Close',
    profileBrowser: 'Browser', providersShort: 'Providers', profileReady: 'Ready', lastChecked: 'Last checked', openMenu: 'Open menu',
    addProfile: 'Add profile', noProfiles: 'No profiles', required: 'Required', optional: 'Optional', profileCreated: 'Profile created.',
    proxySettings: 'Proxy settings', providerAccess: 'Provider access', deleteProfile: 'Delete profile', deleteWarning: 'This removes the managed local browser identity.',
    status: 'Status', version: 'Version', runtime: 'Runtime', ready: 'Ready', stopped: 'Stopped', selected: 'Selected',
    refresh: 'Refresh', search: 'Search', queued: 'Queued', succeeded: 'Succeeded', failed: 'Failed', waiting: 'Waiting',
    noResults: 'No matching results', copy: 'Copy', copied: 'Copied.', account: 'Account', model: 'Model', effort: 'Effort',
    useBrowser: 'Use browser', chooseProviders: 'Choose providers', setupProfileHelp: 'A profile keeps provider sessions isolated on this machine.',
    languageHelp: 'Used by the local console and CLI.', confirmDelete: 'Enter the profile slug to remove it permanently.', unknown: 'Unknown',
    offlineShort: 'Offline', menu: 'Menu', mainContent: 'Main content', profileList: 'Profile list', navigation: 'Navigation',
  },
  'zh-CN': {
    overview: '概览', profiles: 'Profile', providers: 'Provider', capabilities: '能力', jobs: '任务', system: '系统',
    localConsole: '本地控制台', operationalSummary: '运行概览', overviewLede: '查看这台机器上 daemon、浏览器、provider 和任务的真实状态。',
    daemon: 'Daemon', browser: '浏览器运行时', activeProfiles: '活跃 profile', waitingJobs: '等待任务', healthy: '健康',
    actionRequired: '需要处理', recentJobs: '最近任务', providerReadiness: 'Provider 就绪状态', noJobs: '还没有任务', noJobsBody: 'Tokenless 开始工作后，持久任务会显示在这里。',
    profileManagement: '浏览器身份', profilesLede: '管理隔离的浏览器身份、用途、provider 范围和运行方式。',
    cleanProfileNote: '新 profile 默认从 clean 状态开始；只有在用户明确同意后，Tokenless 才会把选定的本地 profile 作为 opaque 文件树复制。也可以直接在可见的 managed browser 中登录。',
    createProfile: '创建 profile', label: '显示名称', slug: 'Profile slug', role: '用途或角色', visibility: '可见性', enabledProviders: '启用的 provider',
    save: '保存', cancel: '取消', open: '打开', remove: '移除', setDefault: '设为默认', default: '默认', imported: '旧版导入', clean: '全新',
    providerConfiguration: 'Provider 配置', providersLede: '用户意图、实际观测、证据和路由资格分别展示，不混成一个状态。', selectProfile: 'Profile',
    enabled: '已启用', disabled: '已停用', neverChecked: '从未检查', checkNow: '检查就绪状态', inspectControls: '检查控件',
    capabilityCatalog: '能力目录', capabilitiesLede: '先看调用方需要的结果，再看哪些 provider 路由已有真实证据。', noRoute: '暂无证据路由',
    durableJobs: '持久任务', jobsLede: '检查精确状态、阻塞原因、标准化结果和恢复操作。', allStatuses: '全部状态', allProviders: '全部 provider', allProfiles: '全部 profile', searchJobs: '搜索 task 或 job', details: '详情', resume: '以 headed 恢复',
    settingsDiagnostics: '系统与诊断', systemLede: '管理共享偏好、运行时控制、兼容性和已脱敏的修复信息。', language: '语言', quiesce: '静默浏览器运行时', copyDiagnostics: '复制诊断信息', diagnostics: '诊断',
    updateSaved: '更改已保存。', requestFailed: '请求失败。', offline: '控制台已离线', offlineBody: 'Daemon 暂时没有响应；连接恢复后会自动继续轮询。', sessionExpired: '控制台会话已过期', reopen: '请重新运行 tokenless dashboard 完成认证。',
    loading: '正在读取当前状态', empty: '暂无内容', confirmRemove: '输入 profile slug 以确认永久移除：', create: '创建', browserSelection: '新 profile 使用的浏览器', defaultVisibility: '默认可见性', proxy: 'Proxy server', proxyBypass: 'Proxy bypass（逗号分隔）', proxyRestartNote: '更改 proxy 会先让浏览器运行时进入静默状态，再重建该 profile 的 context。', none: '无', openBrowser: '打开浏览器', savedAt: '保存时间',
    stage: '阶段', lifecycle: '生命周期', evidence: '证据', result: '结果', error: '错误', attempts: 'Provider 尝试', created: '创建时间', updated: '更新时间',
    primaryNavigation: '主要导航', uptimeUnit: '分钟运行时间', activeUnit: '活跃', configuredUnit: '已配置', durableUnit: '持久任务',
    documentTitle: 'Tokenless 本地控制台', skipToContent: '跳到主要内容',
    configPersisted: '配置已持久化。', setupIncomplete: 'Setup 尚未保存配置。', browserReady: '浏览器运行时可用。', browserUnavailable: '浏览器运行时不可用。', noManagedProfiles: '尚未配置 managed profile。', profilesRegistered: '个 managed profile 已注册。', activeBrowserJobs: '个浏览器任务正在运行。',
    setup: '设置', setupTitle: '设置 Tokenless', setupBody: '选择一个本地浏览器身份，稍后仍可修改。', continue: '继续', finishSetup: '完成设置', back: '返回',
    appearance: '外观', profile: 'Profile', connection: '连接', advanced: '高级', edit: '编辑', more: '更多', close: '关闭',
    profileBrowser: '浏览器', providersShort: 'Provider', profileReady: '就绪', lastChecked: '上次检查', openMenu: '打开菜单',
    addProfile: '添加 profile', noProfiles: '暂无 profile', required: '必填', optional: '选填', profileCreated: 'Profile 已创建。',
    proxySettings: 'Proxy 设置', providerAccess: 'Provider 访问', deleteProfile: '删除 profile', deleteWarning: '这会移除本机的 managed browser 身份。',
    status: '状态', version: '版本', runtime: '运行时', ready: '就绪', stopped: '已停止', selected: '已选择',
    refresh: '刷新', search: '搜索', queued: '排队中', succeeded: '已完成', failed: '失败', waiting: '等待中',
    noResults: '没有匹配结果', copy: '复制', copied: '已复制。', account: '账号', model: '模型', effort: '推理强度',
    useBrowser: '使用浏览器', chooseProviders: '选择 provider', setupProfileHelp: 'Profile 会在这台机器上隔离不同的 provider 会话。',
    languageHelp: '用于本地控制台和 CLI。', confirmDelete: '输入 profile slug 以永久移除。', unknown: '未知',
    offlineShort: '离线', menu: '菜单', mainContent: '主要内容', profileList: 'Profile 列表', navigation: '导航',
  },
} as const

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

const uiErrorZh: Record<string, string> = {
  ui_session_required: '请从 Tokenless CLI 重新打开控制台。',
  ui_origin_rejected: '请求来源不受允许。',
  ui_csrf_rejected: '请求安全令牌无效。',
  ui_ticket_invalid: '控制台启动 ticket 无效或已过期。',
  ui_host_rejected: '请求 Host 不受允许。',
  ui_body_too_large: '请求内容过大。',
  ui_json_invalid: '请求内容必须是有效的 JSON object。',
  invalid_browser: '浏览器选择无效。',
  invalid_browser_visibility: '浏览器可见性无效。',
  invalid_language: '语言必须是 en 或 zh-CN。',
  browser_mutation_unsafe: '仍有浏览器任务运行，暂时不能更改浏览器选择。',
  browser_runtime_unavailable: '浏览器运行时不可用。',
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
}

export function translate(language: Language, key: MessageKey) {
  return messages[language][key]
}

export function translateError(language: Language, code: string, fallback?: string) {
  if (language === 'zh-CN') return uiErrorZh[code] ?? `${translate(language, 'requestFailed')}${code ? ` (${code})` : ''}`
  return fallback ?? translate(language, 'requestFailed')
}

export function capabilityText(language: Language, capability: JsonRecord) {
  const localized = language === 'zh-CN' ? capabilityZh[String(capability.id)] : undefined
  return localized ? { title: localized[0], description: localized[1] } : capability
}

export function capabilityFamilyLabel(language: Language, family: string) {
  return language === 'zh-CN' ? capabilityFamilyZh[family] ?? family : family.replaceAll('_', ' ')
}
