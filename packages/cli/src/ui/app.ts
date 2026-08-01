type Json = Record<string, any>

const root = document.querySelector<HTMLElement>('#app')!
const initialLanguage = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en'

const messages = {
  en: {
    overview: 'Overview', profiles: 'Profiles', providers: 'Providers', capabilities: 'Capabilities', jobs: 'Jobs', system: 'System',
    localConsole: 'Local console', operationalSummary: 'Operational summary', overviewLede: 'The exact daemon, browser, provider, and job state on this machine.',
    daemon: 'Daemon', browser: 'Browser runtime', activeProfiles: 'Active profiles', waitingJobs: 'Waiting jobs', healthy: 'Healthy',
    actionRequired: 'Action required', recentJobs: 'Recent jobs', providerReadiness: 'Provider readiness', noJobs: 'No jobs yet', noJobsBody: 'Durable jobs will appear here when Tokenless starts work.',
    profileManagement: 'Browser identities', profilesLede: 'Manage isolated browser identities, their purpose, provider scope, and runtime behavior.',
    cleanProfileNote: 'New profiles start clean. Tokenless never copies another browser profile or its authentication state; sign in through the visible managed browser.',
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
  },
  'zh-CN': {
    overview: '概览', profiles: 'Profile', providers: 'Provider', capabilities: '能力', jobs: '任务', system: '系统',
    localConsole: '本地控制台', operationalSummary: '运行概览', overviewLede: '查看这台机器上 daemon、浏览器、provider 和任务的真实状态。',
    daemon: 'Daemon', browser: '浏览器运行时', activeProfiles: '活跃 profile', waitingJobs: '等待任务', healthy: '健康',
    actionRequired: '需要处理', recentJobs: '最近任务', providerReadiness: 'Provider 就绪状态', noJobs: '还没有任务', noJobsBody: 'Tokenless 开始工作后，持久任务会显示在这里。',
    profileManagement: '浏览器身份', profilesLede: '管理隔离的浏览器身份、用途、provider 范围和运行方式。',
    cleanProfileNote: '新 profile 从 clean 状态开始。Tokenless 不会复制其他浏览器 profile 或认证状态；请通过可见的 managed browser 登录。',
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
  },
} as const

const capabilityZh: Record<string, readonly [string, string]> = {
  'conversation.chat': ['对话', '提交 prompt，并读取与本次提交对应的可见 provider 响应。'],
  'conversation.continue': ['继续对话', '继续由 Tokenless 精确选中的持久 provider 对话。'],
  'file.upload': ['上传文件', '附加调用方选择的文件，并证明 provider 已在可见界面接收。'],
  'image.input': ['图片输入', '把图片作为 provider 输入。'],
  'audio.input': ['音频输入', '把音频作为 provider 输入。'],
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
  conversation: '对话', input: '输入', retrieval_reasoning: '检索与推理', media_generation: '媒体生成', artifact_generation: '产物生成', workspace_knowledge: 'Workspace 与知识', evidence_lifecycle: '证据与生命周期',
}

const uiErrorZh: Record<string, string> = {
  ui_session_required: '请从 Tokenless CLI 重新打开控制台。', ui_origin_rejected: '请求来源不受允许。', ui_csrf_rejected: '请求安全令牌无效。', ui_ticket_invalid: '控制台启动 ticket 无效或已过期。', ui_host_rejected: '请求 Host 不受允许。', ui_body_too_large: '请求内容过大。', ui_json_invalid: '请求内容必须是有效的 JSON object。',
  invalid_browser: '浏览器选择无效。', invalid_browser_visibility: '浏览器可见性无效。', invalid_language: '语言必须是 en 或 zh-CN。', browser_mutation_unsafe: '仍有浏览器任务运行，暂时不能更改浏览器选择。', browser_runtime_unavailable: '浏览器运行时不可用。',
  invalid_profile_slug: 'Profile slug 只能使用小写字母、数字和连字符。', invalid_profile_label: 'Profile 名称必须为 1 到 80 个字符。', invalid_role_label: '角色标签不能超过 80 个字符。', profile_mutation_unsafe: '仍有浏览器任务运行，暂时不能移除 profile。', profile_proxy_mutation_unsafe: '仍有浏览器任务运行，暂时不能更改 proxy。', browser_profile_copy_disabled: 'Tokenless 不复制本地浏览器 profile 或认证状态；请创建全新 managed profile，并在其中手动登录。',
  invalid_provider_list: '启用的 provider 列表无效。', provider_not_enabled: '请先为该 profile 启用 provider。', provider_not_supported: '该 provider 暂不受支持。', provider_selection_invalid: '选择类型必须是 model 或 effort。', invalid_proxy: 'Proxy 必须使用不含嵌入凭据的 HTTP、HTTPS 或 SOCKS5 地址。',
  invalid_fields: '请求包含不受支持的字段。',
}

let language: keyof typeof messages = initialLanguage
let section = location.hash.slice(1) || 'overview'
let csrf = ''
let snapshot: Json | null = null
let offline = false
let busy = false
let selectedProfile = ''
let pollTimer = 0
let toastTimer = 0
let snapshotEtag = ''
let pendingRender = false

const t = (key: keyof typeof messages.en) => messages[language][key]
const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)
const fmtTime = (value: unknown) => value ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(String(value))) : '—'
const age = (value: unknown) => {
  if (!value) return t('neverChecked')
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(String(value))) / 1000))
  const unit: Intl.RelativeTimeFormatUnit = seconds < 60 ? 'second' : seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : 'day'
  const amount = unit === 'second' ? seconds : unit === 'minute' ? Math.floor(seconds / 60) : unit === 'hour' ? Math.floor(seconds / 3600) : Math.floor(seconds / 86400)
  return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-amount, unit)
}

async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(`/ui-api/v1${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.method && options.method !== 'GET' ? { 'x-tokenless-csrf': csrf } : {}),
      ...(path === '/snapshot' && snapshotEtag ? { 'if-none-match': snapshotEtag } : {}),
      ...(options.headers ?? {}),
    },
  })
  if (response.status === 401) throw Object.assign(new Error(t('reopen')), { sessionExpired: true })
  if (response.status === 304) return null
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = typeof body?.error?.code === 'string' ? body.error.code : ''
    const message = language === 'zh-CN'
      ? uiErrorZh[code] ?? `${t('requestFailed')}${code ? ` (${code})` : ''}`
      : body?.error?.message ?? t('requestFailed')
    throw Object.assign(new Error(message), { status: response.status, code })
  }
  if (path === '/snapshot') snapshotEtag = response.headers.get('etag') ?? ''
  return body
}

async function initialize() {
  try {
    const session = await api('/session', { method: 'GET' })
    csrf = session.csrf
    document.querySelector<HTMLSelectElement>('[data-language-switch]')?.removeAttribute('disabled')
    await refresh(true)
    schedulePoll()
  } catch (error) {
    renderFatal(error)
  }
}

async function refresh(initial = false) {
  const wasOffline = offline
  try {
    const next = await api('/snapshot', { method: 'GET' })
    if (next) snapshot = next
    offline = false
    if (!selectedProfile || !snapshot?.profiles?.some((profile: Json) => profile.slug === selectedProfile)) {
      selectedProfile = snapshot?.profiles?.find((profile: Json) => profile.isDefault)?.slug ?? snapshot?.profiles?.[0]?.slug ?? ''
    }
    if (snapshot?.config?.language && snapshot.config.language !== language) {
      language = snapshot.config.language
    }
    document.title = t('documentTitle')
    const skipLink = document.querySelector<HTMLAnchorElement>('.skip-link')
    if (skipLink) skipLink.textContent = t('skipToContent')
    if (next || initial || wasOffline || pendingRender) {
      if (hasUncommittedUiInput()) pendingRender = true
      else { pendingRender = false; render() }
    }
    document.documentElement.lang = language
  } catch (error: any) {
    if (error?.sessionExpired) return renderFatal(error)
    offline = true
    if (initial || !snapshot) renderFatal(error)
    else if (hasUncommittedUiInput()) pendingRender = true
    else render()
  }
}

function schedulePoll() {
  window.clearTimeout(pollTimer)
  pollTimer = window.setTimeout(async () => {
    if (!document.hidden && !busy) await refresh()
    schedulePoll()
  }, 3000)
}

function render() {
  if (!snapshot) return
  const nav = ['overview', 'profiles', 'providers', 'capabilities', 'jobs', 'system'] as const
  root.innerHTML = `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><img src="/ui/mark.png" alt=""><div><strong>Tokenless</strong><span>${esc(t('localConsole'))}</span></div></div>
      <nav class="nav" aria-label="${esc(t('primaryNavigation'))}">${nav.map((item) => `<button data-nav="${item}" ${section === item ? 'aria-current="page"' : ''}><span>${esc(t(item))}</span></button>`).join('')}</nav>
      <label class="sidebar-language"><span>${esc(t('language'))}</span><select data-language-switch aria-label="${esc(t('language'))}"><option value="en" ${language === 'en' ? 'selected' : ''}>EN</option><option value="zh-CN" ${language === 'zh-CN' ? 'selected' : ''}>中文</option></select></label>
      <div class="sidebar-foot"><strong>${esc(snapshot.daemon.version)}</strong>${esc(snapshot.daemon.origin)}</div>
    </aside>
    <main class="workspace" id="main" tabindex="-1">
      ${offline ? `<div class="notice error"><div><strong>${esc(t('offline'))}</strong><br>${esc(t('offlineBody'))}</div></div>` : ''}
      ${renderSection()}
    </main>
  </div><div id="toast-region" aria-live="assertive"></div>`
  bindForms()
}

function renderSection() {
  if (section === 'profiles') return profilesView()
  if (section === 'providers') return providersView()
  if (section === 'capabilities') return capabilitiesView()
  if (section === 'jobs') return jobsView()
  if (section === 'system') return systemView()
  return overviewView()
}

function header(title: string, lede: string, tools = '') {
  return `<header class="page-head"><div><p class="eyebrow">Tokenless / ${esc(t('localConsole'))}</p><h1>${esc(title)}</h1><p class="lede">${esc(lede)}</p></div>${tools ? `<div class="toolbar">${tools}</div>` : ''}</header>`
}

function overviewView() {
  const waiting = snapshot!.jobs.filter((job: Json) => job.status === 'waiting_for_user')
  const defaultProfile = snapshot!.profiles.find((profile: Json) => profile.isDefault) ?? snapshot!.profiles[0]
  const readyProviders = snapshot!.providers.filter((provider: Json) => provider.profiles.some((profile: Json) => profile.profileId === defaultProfile?.slug && profile.enabled && profile.runtimeEligibility === 'eligible'))
  const action = snapshot!.diagnostics.find((item: Json) => item.state !== 'ok') ?? waiting[0]
  const profileNote = defaultProfile
    ? `${t('default')}: ${defaultProfile.label}${defaultProfile.preferences.roleLabel ? ` · ${defaultProfile.preferences.roleLabel}` : ''}`
    : `0 ${t('configuredUnit')}`
  return `<section class="page">${header(t('operationalSummary'), t('overviewLede'), defaultProfile ? `<button class="button primary" data-action="open-profile" data-profile="${esc(defaultProfile.slug)}">${esc(t('openBrowser'))}</button>` : '')}
    ${action ? `<div class="notice"><div><strong>${esc(t('actionRequired'))}</strong><br>${esc(action.message ?? action.blocker?.message ?? action.status)}</div></div>` : ''}
    <div class="grid metrics">
      ${metric(t('daemon'), snapshot!.daemon.version, `${Math.floor(snapshot!.daemon.uptimeMs / 60000)} ${t('uptimeUnit')}`)}
      ${metric(t('browser'), snapshot!.runtime.status, `${snapshot!.runtime.activeJobCount} ${t('activeUnit')}`)}
      ${metric(t('activeProfiles'), snapshot!.runtime.activeProfileCount, profileNote)}
      ${metric(t('waitingJobs'), waiting.length, `${snapshot!.jobs.length} ${t('durableUnit')}`)}
    </div>
    <div class="section grid two">
      <section class="panel"><div class="panel-head"><h2>${esc(t('providerReadiness'))}</h2><span class="badge supported">${readyProviders.length}/${snapshot!.providers.length}</span></div>${providerRows()}</section>
      <section class="panel"><div class="panel-head"><h2>${esc(t('recentJobs'))}</h2></div>${jobRows(snapshot!.jobs.slice(0, 6), true)}</section>
    </div>
  </section>`
}

function metric(label: string, value: unknown, note: string) {
  return `<article class="panel metric"><span class="metric-label">${esc(label)}</span><div><div class="metric-value">${esc(value)}</div><div class="metric-note">${esc(note)}</div></div></article>`
}

function providerRows() {
  const profile = selectedProfile || snapshot!.profiles[0]?.slug
  const rows = snapshot!.providers.map((provider: Json) => {
    const state = provider.profiles.find((entry: Json) => entry.profileId === profile)
    return `<li class="list-row"><div class="row-title"><strong>${esc(provider.label)}</strong><span>${esc(provider.stage)}</span></div><span class="status ${esc(state?.runtimeEligibility ?? 'ineligible')}">${esc(state?.runtimeEligibility ?? 'ineligible')}</span><span class="secondary">${esc(age(state?.observation?.checkedAt))}</span><button class="button" data-nav="providers">${esc(t('details'))}</button></li>`
  }).join('')
  return `<ul class="list">${rows}</ul>`
}

function profilesView() {
  const cards = snapshot!.profiles.map((profile: Json) => `<article class="panel pad">
    <div class="provider-top"><div><h3>${esc(profile.label)}</h3><p>${esc(profile.slug)} · ${esc(profile.preferences.roleLabel || (profile.import ? t('imported') : t('clean')))}</p></div>${profile.isDefault ? `<span class="badge supported">${esc(t('default'))}</span>` : ''}</div>
    <div class="section-title"><p><span class="status ${profile.lifecycle === 'ready' ? 'ok' : 'warn'}">${esc(profile.lifecycle)}</span></p><p>${esc(profile.preferences.enabledProviders.join(', ') || t('none'))}</p></div>
    <div class="button-row"><button class="button primary" data-action="open-profile" data-profile="${esc(profile.slug)}">${esc(t('open'))}</button><button class="button" data-action="edit-profile" data-profile="${esc(profile.slug)}">${esc(t('save'))}</button>${!profile.isDefault ? `<button class="button" data-action="default-profile" data-profile="${esc(profile.slug)}">${esc(t('setDefault'))}</button>` : ''}<button class="button danger" data-action="remove-profile" data-profile="${esc(profile.slug)}">${esc(t('remove'))}</button></div>
  </article>`).join('')
  return `<section class="page">${header(t('profileManagement'), t('profilesLede'), `<button class="button primary" data-action="show-create-profile">${esc(t('createProfile'))}</button>`)}
    <div class="notice"><div>${esc(t('cleanProfileNote'))}</div></div>
    ${snapshot!.profiles.length ? `<div class="grid two">${cards}</div>` : empty(t('empty'), t('profilesLede'))}
    <dialog id="profile-dialog"><div class="dialog-head"><h2>${esc(t('createProfile'))}</h2><button class="button" data-action="close-dialog">${esc(t('cancel'))}</button></div><div class="dialog-body">${profileForm()}</div></dialog>
  </section>`
}

function profileForm(profile?: Json) {
  const prefs = profile?.preferences ?? {}
  return `<form id="profile-form" class="form-grid" data-profile="${esc(profile?.slug ?? '')}">
    <div class="field"><label for="profile-slug">${esc(t('slug'))}</label><input id="profile-slug" name="slug" required pattern="[a-z0-9][a-z0-9-]{0,63}" value="${esc(profile?.slug ?? '')}" ${profile ? 'disabled' : ''}></div>
    <div class="field"><label for="profile-label">${esc(t('label'))}</label><input id="profile-label" name="label" required maxlength="80" value="${esc(profile?.label ?? '')}"></div>
    <div class="field"><label for="profile-role">${esc(t('role'))}</label><input id="profile-role" name="roleLabel" maxlength="80" value="${esc(prefs.roleLabel ?? '')}"></div>
    <div class="field"><label for="profile-visibility">${esc(t('visibility'))}</label><select id="profile-visibility" name="browserVisibility">${['auto','headed','headless'].map((value) => `<option ${prefs.browserVisibility === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
    <fieldset class="field full"><legend>${esc(t('enabledProviders'))}</legend><div class="checks">${snapshot!.providers.map((provider: Json) => `<label><input type="checkbox" name="enabledProviders" value="${esc(provider.id)}" ${!profile || prefs.enabledProviders?.includes(provider.id) ? 'checked' : ''}>${esc(provider.label)}</label>`).join('')}</div></fieldset>
    <div class="field full"><label for="profile-proxy">${esc(t('proxy'))}</label><input id="profile-proxy" name="proxy" placeholder="socks5://127.0.0.1:1080" value="${esc(prefs.proxy?.server ?? '')}"></div>
    <div class="field full"><label for="profile-bypass">${esc(t('proxyBypass'))}</label><input id="profile-bypass" name="proxyBypass" value="${esc(prefs.proxy?.bypass?.join(', ') ?? '')}"></div>
    <p class="secondary full">${esc(t('proxyRestartNote'))}</p>
    <div class="form-actions"><button class="button primary" type="submit">${esc(profile ? t('save') : t('create'))}</button></div>
  </form>`
}

function providersView() {
  const profile = snapshot!.profiles.find((entry: Json) => entry.slug === selectedProfile) ?? snapshot!.profiles[0]
  const selector = `<label class="field"><span>${esc(t('selectProfile'))}</span><select id="provider-profile">${snapshot!.profiles.map((entry: Json) => `<option value="${esc(entry.slug)}" ${entry.slug === profile?.slug ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select></label>`
  const cards = snapshot!.providers.map((provider: Json) => {
    const state = provider.profiles.find((entry: Json) => entry.profileId === profile?.slug)
    const observation = state?.observation
    const enabled = state?.enabled === true
    return `<article class="panel provider-card">
      <div class="provider-top"><div><h3>${esc(provider.label)}</h3><p>${esc(provider.id)}</p></div><span class="badge ${esc(provider.stage)}">${esc(provider.stage)}</span></div>
      <label class="toggle"><input type="checkbox" data-action="toggle-provider" data-provider="${esc(provider.id)}" data-profile="${esc(profile?.slug)}" ${enabled ? 'checked' : ''}>${esc(enabled ? t('enabled') : t('disabled'))}</label>
      <div class="account"><strong>${esc(observation?.account?.name ?? observation?.access ?? t('neverChecked'))}</strong><span>${esc(observation?.account?.subscription ?? age(observation?.checkedAt))}</span></div>
      ${choiceControl('model', 'Model', state?.controls?.model, provider.id, profile?.slug)}
      ${choiceControl('effort', 'Effort', state?.controls?.effort, provider.id, profile?.slug)}
      <span class="status ${esc(state?.runtimeEligibility ?? 'ineligible')}">${esc(state?.runtimeEligibility ?? 'ineligible')}</span>
      <div class="button-row"><button class="button primary" data-provider-action="open" data-provider="${esc(provider.id)}" data-profile="${esc(profile?.slug)}" ${!enabled ? 'disabled' : ''}>${esc(t('open'))}</button><button class="button" data-provider-action="readiness" data-provider="${esc(provider.id)}" data-profile="${esc(profile?.slug)}" ${!enabled ? 'disabled' : ''}>${esc(t('checkNow'))}</button><button class="button" data-provider-action="controls" data-provider="${esc(provider.id)}" data-profile="${esc(profile?.slug)}" ${!enabled ? 'disabled' : ''}>${esc(t('inspectControls'))}</button></div>
    </article>`
  }).join('')
  return `<section class="page">${header(t('providerConfiguration'), t('providersLede'), selector)}${profile ? `<div class="grid three">${cards}</div>` : empty(t('empty'), t('profilesLede'))}</section>`
}

function choiceControl(kind: string, label: string, choices: Json[] | null | undefined, provider: string, profile: string) {
  if (!choices?.length) return ''
  return `<div class="field"><label>${esc(label)}</label><select data-choice-kind="${esc(kind)}" data-provider="${esc(provider)}" data-profile="${esc(profile)}"><option value="">—</option>${choices.map((choice) => `<option value="${esc(choice.label)}" ${choice.selected ? 'selected' : ''} ${choice.enabled ? '' : 'disabled'}>${esc(choice.label)}</option>`).join('')}</select></div>`
}

function capabilitiesView() {
  const profile = snapshot!.profiles.find((entry: Json) => entry.slug === selectedProfile) ?? snapshot!.profiles[0]
  const groups: Record<string, Json[]> = snapshot!.capabilities.reduce((result: Record<string, Json[]>, capability: Json) => {
    ;(result[capability.family] ??= []).push(capability)
    return result
  }, {})
  const content = Object.entries(groups).map(([family, capabilities]) => `<section class="section"><div class="section-title"><h2>${esc(language === 'zh-CN' ? capabilityFamilyZh[family] ?? family : family.replaceAll('_', ' '))}</h2><p>${capabilities.length}</p></div><div class="panel"><ul class="list">${capabilities.map((capability) => { const copy = capabilityText(capability); return `<li class="list-row"><div class="row-title"><strong>${esc(copy.title)}</strong><span>${esc(copy.description)}</span></div><span class="badge ${esc(capability.stability)}">${esc(capability.stability)}</span><span class="secondary">${esc(capabilityProviderSummary(capability, profile))}</span><button class="button" data-action="capability-detail" data-capability="${esc(capability.id)}">${esc(t('details'))}</button></li>` }).join('')}</ul></div></section>`).join('')
  const selector = profile ? `<label class="field"><span>${esc(t('selectProfile'))}</span><select id="capability-profile">${snapshot!.profiles.map((entry: Json) => `<option value="${esc(entry.slug)}" ${entry.slug === profile.slug ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select></label>` : ''
  return `<section class="page">${header(t('capabilityCatalog'), t('capabilitiesLede'), selector)}${content}<dialog id="detail-dialog"></dialog></section>`
}

function jobsView() {
  return `<section class="page">${header(t('durableJobs'), t('jobsLede'))}<div class="filters"><select id="job-status"><option value="">${esc(t('allStatuses'))}</option>${['queued','claimed','running','waiting_for_user','succeeded','failed','canceled','timed_out'].map((value) => `<option>${value}</option>`).join('')}</select><select id="job-provider"><option value="">${esc(t('allProviders'))}</option>${snapshot!.providers.map((provider: Json) => `<option value="${esc(provider.id)}">${esc(provider.label)}</option>`).join('')}</select><select id="job-profile"><option value="">${esc(t('allProfiles'))}</option>${snapshot!.profiles.map((profile: Json) => `<option value="${esc(profile.id)}">${esc(profile.label)}</option>`).join('')}</select><input id="job-search" type="search" placeholder="${esc(t('searchJobs'))}"></div><div class="panel" id="job-list">${jobRows(snapshot!.jobs)}</div><dialog id="detail-dialog"></dialog></section>`
}

function jobRows(jobs: Json[], compact = false) {
  if (!jobs.length) return empty(t('noJobs'), t('noJobsBody'))
  return `<ul class="list">${jobs.map((job) => `<li class="list-row" data-job-row data-status="${esc(job.status)}" data-provider="${esc(job.provider)}" data-profile="${esc(job.profileId)}" data-search="${esc(`${job.jobId} ${job.taskId ?? ''} ${job.agent?.sessionId ?? ''}`.toLowerCase())}"><div class="row-title"><strong>${esc(job.taskId ?? job.action)}</strong><span>${esc(job.jobId)}</span></div><span class="status ${esc(job.status)}">${esc(job.status)}</span><span class="secondary">${esc(age(job.updatedAt))}</span>${compact ? `<button class="button" data-nav="jobs">${esc(t('details'))}</button>` : `<button class="button" data-action="job-detail" data-job="${esc(job.jobId)}">${esc(t('details'))}</button>`}</li>`).join('')}</ul>`
}

function systemView() {
  const config = snapshot!.config
  return `<section class="page">${header(t('settingsDiagnostics'), t('systemLede'), `<button class="button" data-action="copy-diagnostics">${esc(t('copyDiagnostics'))}</button>`)}
    <section class="panel pad"><form id="config-form" class="form-grid"><div class="field"><label for="language">${esc(t('language'))}</label><select id="language" name="language"><option value="en" ${config.language === 'en' ? 'selected' : ''}>English</option><option value="zh-CN" ${config.language === 'zh-CN' ? 'selected' : ''}>简体中文</option></select></div><div class="field"><label for="browser">${esc(t('browserSelection'))}</label><select id="browser" name="browser">${['auto','chrome','brave','edge','arc','chromium','chrome-for-testing','managed-chromium','cloak'].map((value) => `<option ${config.browser === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div><div class="field"><label for="visibility">${esc(t('defaultVisibility'))}</label><select id="visibility" name="browserVisibility">${['auto','headed','headless'].map((value) => `<option ${config.browserVisibility === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div><div class="field"><span>${esc(t('savedAt'))}</span><strong>${esc(fmtTime(config.updatedAt))}</strong></div><div class="form-actions"><button class="button" type="button" data-action="quiesce-runtime">${esc(t('quiesce'))}</button><button class="button primary" type="submit">${esc(t('save'))}</button></div></form></section>
    <section class="section"><div class="section-title"><h2>${esc(t('diagnostics'))}</h2><p>${esc(fmtTime(snapshot!.generatedAt))}</p></div><div class="panel"><ul class="list">${snapshot!.diagnostics.map((item: Json) => `<li class="list-row"><div class="row-title"><strong>${esc(item.id)}</strong><span>${esc(diagnosticMessage(item))}</span></div><span class="status ${item.state === 'ok' ? 'ok' : item.state === 'error' ? 'error' : 'warn'}">${esc(item.state)}</span><span></span><span></span></li>`).join('')}</ul></div></section>
  </section>`
}

function empty(title: string, body: string) { return `<div class="empty"><strong>${esc(title)}</strong>${esc(body)}</div>` }

function hasUncommittedUiInput() {
  return Boolean(document.querySelector('dialog[open], form:focus-within'))
}

function flushPendingRender() {
  if (!pendingRender || hasUncommittedUiInput()) return
  pendingRender = false
  render()
}

function capabilityText(capability: Json) {
  const localized = language === 'zh-CN' ? capabilityZh[capability.id] : undefined
  return localized ? { title: localized[0], description: localized[1] } : capability
}

function capabilityProviderSummary(capability: Json, profile: Json | undefined) {
  if (!capability.providers.length) return t('noRoute')
  return capability.providers.map((route: Json) => {
    const provider = snapshot!.providers.find((entry: Json) => entry.id === route.provider)
    const state = provider?.profiles.find((entry: Json) => entry.profileId === profile?.slug)
    return `${route.provider} · ${state?.runtimeEligibility ?? 'ineligible'}`
  }).join(', ')
}

function diagnosticMessage(item: Json) {
  if (language !== 'zh-CN') return item.message
  if (item.id === 'configuration') return item.state === 'ok' ? t('configPersisted') : t('setupIncomplete')
  if (item.id === 'browser-runtime') return item.state === 'ok' ? t('browserReady') : t('browserUnavailable')
  if (item.id === 'profiles') return snapshot!.profiles.length === 0 ? t('noManagedProfiles') : `${snapshot!.profiles.length} ${t('profilesRegistered')}`
  if (item.id === 'scheduler') return `${snapshot!.runtime.activeJobCount} ${t('activeBrowserJobs')}`
  return t('requestFailed')
}

function bindForms() {
  document.querySelectorAll('#provider-profile,#capability-profile').forEach((element) => element.addEventListener('change', (event) => { selectedProfile = (event.target as HTMLSelectElement).value; render() }))
  document.querySelectorAll('#job-status,#job-provider,#job-profile,#job-search').forEach((element) => element.addEventListener('input', filterJobs))
  document.querySelector<HTMLFormElement>('#profile-form')?.addEventListener('submit', submitProfile)
  document.querySelector<HTMLFormElement>('#config-form')?.addEventListener('submit', submitConfig)
}

function filterJobs() {
  const status = (document.querySelector<HTMLSelectElement>('#job-status')?.value ?? '')
  const provider = (document.querySelector<HTMLSelectElement>('#job-provider')?.value ?? '')
  const profile = (document.querySelector<HTMLSelectElement>('#job-profile')?.value ?? '')
  const search = (document.querySelector<HTMLInputElement>('#job-search')?.value ?? '').trim().toLowerCase()
  document.querySelectorAll<HTMLElement>('[data-job-row]').forEach((row) => {
    row.hidden = Boolean((status && row.dataset.status !== status) || (provider && row.dataset.provider !== provider) || (profile && row.dataset.profile !== profile) || (search && !row.dataset.search?.includes(search)))
  })
}

document.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
  if (!target) return
  const nav = target.dataset.nav
  if (nav) { section = nav; location.hash = nav; render(); document.querySelector<HTMLElement>('#main')?.focus(); return }
  const action = target.dataset.action
  try {
    if (action === 'show-create-profile') openProfileDialog()
    if (action === 'close-dialog') target.closest('dialog')?.close()
    if (action === 'edit-profile') openProfileDialog(snapshot!.profiles.find((profile: Json) => profile.slug === target.dataset.profile))
    if (action === 'open-profile') await mutate(`/profiles/${encodeURIComponent(target.dataset.profile!)}/open`, undefined)
    if (action === 'default-profile') await mutate(`/profiles/${encodeURIComponent(target.dataset.profile!)}`, { setDefault: true }, 'PATCH')
    if (action === 'remove-profile') await removeProfile(target.dataset.profile!)
    if (action === 'job-detail') await showJob(target.dataset.job!)
    if (action === 'capability-detail') showCapability(target.dataset.capability!)
    if (action === 'copy-diagnostics') await navigator.clipboard.writeText(JSON.stringify(snapshot!.diagnostics, null, 2)).then(() => showToast(t('updateSaved')))
    if (action === 'quiesce-runtime') await mutate('/runtime/quiesce', undefined)
  } catch (error) { showError(error) }
})

document.addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement
  if (input.matches('[data-language-switch]')) {
    if (!csrf) return
    try { await mutate('/config', { language: input.value }, 'PATCH') } catch (error) { showError(error) }
    return
  }
  if (input.dataset.action === 'toggle-provider') {
    try { await toggleProvider(input) } catch (error) { input.checked = !input.checked; showError(error) }
  }
  const select = event.target as HTMLSelectElement
  if (select.dataset.choiceKind && select.value) {
    try {
      await mutate(`/profiles/${encodeURIComponent(select.dataset.profile!)}/providers/${encodeURIComponent(select.dataset.provider!)}/selection`, {
        kind: select.dataset.choiceKind,
        label: select.value,
      }, 'POST', false)
      showToast(`${select.dataset.choiceKind}: ${select.value}`)
    } catch (error) { showError(error) }
  }
})

document.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-provider-action]')
  if (!button) return
  try {
    const result = await mutate(`/profiles/${encodeURIComponent(button.dataset.profile!)}/providers/${encodeURIComponent(button.dataset.provider!)}/actions/${button.dataset.providerAction}`, undefined, 'POST', false)
    showToast(`${result.provider}: ${result.status}`)
  } catch (error) { showError(error) }
})

function openProfileDialog(profile?: Json) {
  const dialog = document.querySelector<HTMLDialogElement>('#profile-dialog')!
  dialog.querySelector('.dialog-body')!.innerHTML = profileForm(profile)
  dialog.querySelector('h2')!.textContent = profile ? profile.label : t('createProfile')
  dialog.querySelector<HTMLFormElement>('#profile-form')?.addEventListener('submit', submitProfile)
  dialog.showModal()
}

async function submitProfile(event: SubmitEvent) {
  event.preventDefault()
  const form = event.currentTarget as HTMLFormElement
  const data = new FormData(form)
  const profile = form.dataset.profile
  const proxyServer = String(data.get('proxy') ?? '').trim()
  const body = {
    slug: String(data.get('slug') ?? profile),
    label: String(data.get('label') ?? ''),
    roleLabel: String(data.get('roleLabel') ?? ''),
    browserVisibility: String(data.get('browserVisibility') ?? 'auto'),
    enabledProviders: data.getAll('enabledProviders').map(String),
    proxy: proxyServer ? { server: proxyServer, bypass: String(data.get('proxyBypass') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean) } : null,
  }
  try { await mutate(profile ? `/profiles/${encodeURIComponent(profile)}` : '/profiles', body, profile ? 'PATCH' : 'POST'); form.closest('dialog')?.close() } catch (error) { showError(error) }
}

async function submitConfig(event: SubmitEvent) {
  event.preventDefault()
  const data = new FormData(event.currentTarget as HTMLFormElement)
  try { await mutate('/config', { language: data.get('language'), browser: data.get('browser'), browserVisibility: data.get('browserVisibility') }, 'PATCH') } catch (error) { showError(error) }
}

async function toggleProvider(input: HTMLInputElement) {
  const profile = snapshot!.profiles.find((entry: Json) => entry.slug === input.dataset.profile)
  const enabled = new Set<string>(profile.preferences.enabledProviders)
  if (input.checked) enabled.add(input.dataset.provider!)
  else enabled.delete(input.dataset.provider!)
  await mutate(`/profiles/${encodeURIComponent(profile.slug)}`, { enabledProviders: [...enabled] }, 'PATCH')
}

async function removeProfile(profile: string) {
  if (prompt(t('confirmRemove')) !== profile) return
  await mutate(`/profiles/${encodeURIComponent(profile)}`, undefined, 'DELETE')
}

async function showJob(jobId: string) {
  const job = await api(`/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' })
  const dialog = document.querySelector<HTMLDialogElement>('#detail-dialog')!
  const actions = `${job.profileSlug && job.provider ? `<button class="button" data-job-provider-open>${esc(t('openBrowser'))}</button>` : ''}${job.status === 'waiting_for_user' ? `<button class="button primary" data-job-action="resume">${esc(t('resume'))}</button>` : ['queued','claimed','running'].includes(job.status) ? `<button class="button danger" data-job-action="cancel">${esc(t('cancel'))}</button>` : ''}`
  dialog.innerHTML = `<div class="dialog-head"><h2>${esc(job.taskId ?? job.jobId)}</h2><button class="button" data-close-detail>${esc(t('cancel'))}</button></div><div class="dialog-body"><p><span class="status ${esc(job.status)}">${esc(job.status)}</span></p><p class="secondary">${esc(t('created'))}: ${esc(fmtTime(job.createdAt))}<br>${esc(t('updated'))}: ${esc(fmtTime(job.updatedAt))}<br>${esc(job.profileSlug ?? job.profileId ?? '')} · ${esc(job.provider ?? '')}${job.agent ? `<br>${esc(job.agent.kind)} · ${esc(job.agent.sessionId)}` : ''}</p><div class="button-row">${actions}</div><section class="section"><h3>${esc(t('result'))}</h3><pre class="code-block">${esc(JSON.stringify(job.result, null, 2))}</pre></section><section class="section"><h3>${esc(t('error'))}</h3><pre class="code-block">${esc(JSON.stringify(job.error ?? job.blocker, null, 2))}</pre></section><section class="section"><h3>${esc(t('attempts'))}</h3><pre class="code-block">${esc(JSON.stringify(job.providerAttempts, null, 2))}</pre></section></div>`
  dialog.querySelector('[data-close-detail]')?.addEventListener('click', () => dialog.close())
  dialog.querySelector('[data-job-provider-open]')?.addEventListener('click', async () => { try { await mutate(`/profiles/${encodeURIComponent(job.profileSlug)}/providers/${encodeURIComponent(job.provider)}/actions/open`, undefined, 'POST', false) } catch (error) { showError(error) } })
  dialog.querySelector('[data-job-action]')?.addEventListener('click', async (event) => { const action = (event.currentTarget as HTMLElement).dataset.jobAction!; try { await mutate(`/jobs/${encodeURIComponent(jobId)}/${action}`, undefined); dialog.close() } catch (error) { showError(error) } })
  dialog.showModal()
}

function showCapability(id: string) {
  const capability = snapshot!.capabilities.find((entry: Json) => entry.id === id)
  const copy = capabilityText(capability)
  const dialog = document.querySelector<HTMLDialogElement>('#detail-dialog')!
  dialog.innerHTML = `<div class="dialog-head"><h2>${esc(copy.title)}</h2><button class="button" data-close-detail>${esc(t('cancel'))}</button></div><div class="dialog-body"><p>${esc(copy.description)}</p><p><span class="badge ${esc(capability.stability)}">${esc(capability.stability)}</span></p><h3>${esc(t('evidence'))}</h3><pre class="code-block">${esc(JSON.stringify({ required: capability.requiredEvidence, providers: capability.providers }, null, 2))}</pre></div>`
  dialog.querySelector('[data-close-detail]')?.addEventListener('click', () => dialog.close())
  dialog.showModal()
}

async function mutate(path: string, body: unknown, method = 'POST', announce = true) {
  busy = true
  try {
    const result = await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    await refresh()
    if (announce) showToast(t('updateSaved'))
    return result
  } finally { busy = false }
}

function showToast(message: string) {
  const region = document.querySelector<HTMLElement>('#toast-region')
  if (!region) return
  region.innerHTML = `<div class="toast" role="status">${esc(message)}</div>`
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { region.innerHTML = '' }, 3200)
}

function showError(error: unknown) { showToast(error instanceof Error ? error.message : t('requestFailed')) }

function renderFatal(error: any) {
  const expired = error?.sessionExpired === true
  root.innerHTML = `<main class="boot-state"><img src="/ui/mark.png" alt=""><p>${esc(expired ? t('sessionExpired') : t('offline'))}</p><span>${esc(expired ? t('reopen') : error instanceof Error ? error.message : t('offlineBody'))}</span></main>`
}

window.addEventListener('hashchange', () => { section = location.hash.slice(1) || 'overview'; render() })
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() })
document.addEventListener('close', flushPendingRender, true)
document.addEventListener('focusout', () => queueMicrotask(flushPendingRender))
void initialize()
