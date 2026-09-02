<script lang="ts">
  import {
    Activity,
    AlertTriangle,
    ArrowLeft,
    ArrowUpRight,
    Bot,
    Braces,
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    CircleHelp,
    Clock3,
    Cloud,
    Code2,
    Command,
    Cpu,
    Database,
    FileCode2,
    Gauge,
    Globe2,
    HardDrive,
    Info,
    KeyRound,
    Layers3,
    LayoutDashboard,
    ListChecks,
    LockKeyhole,
    Menu,
    MessageSquare,
    MoreHorizontal,
    Network,
    Palette,
    Pause,
    Plus,
    Play,
    PlugZap,
    RefreshCw,
    Save,
    Search,
    Server,
    Settings,
    Settings2,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    Terminal,
    Trash2,
    UserRound,
    WifiOff,
    X,
    Zap,
  } from '@lucide/svelte'
  import markUrl from './mark.png'
  import MonitorIcon from './MonitorIcon.svelte'
  import UsersRoundIcon from './UsersRoundIcon.svelte'
  import type { DesignAtlasArgs, DesignLanguage, DesignModal, DesignScreen, DesignState } from './atlas-types'

  type CopyKey =
    | 'overview' | 'profiles' | 'providers' | 'capabilities' | 'jobs' | 'system' | 'setup'
    | 'foundations' | 'designAtlas' | 'illustrativeData' | 'designSurface'
    | 'runtime' | 'active' | 'waiting' | 'finished' | 'tokensSaved' | 'workspace'
    | 'welcomeBack' | 'overviewDescription' | 'last30Days' | 'last7Days' | 'today' | 'chatHistory'
    | 'mostUsedProvider' | 'completedJobs' | 'successRate' | 'capabilityBreadth'
    | 'completed' | 'failed' | 'providersConnected' | 'ofCatalog' | 'insights'
    | 'providerPanorama' | 'provider' | 'jobShare' | 'capabilitiesShort' | 'mode' | 'lastUsed'
    | 'cumulativeSavings' | 'dailyOutcomes' | 'capabilityUsage' | 'topCapabilities'
    | 'browser' | 'direct' | 'noUsage' | 'viewDetails' | 'viewAll' | 'manage'
    | 'profile' | 'profileDescription' | 'defaultProfile' | 'editProfile' | 'useProfile'
    | 'enabled' | 'inactive' | 'providersDescription' | 'connected' | 'needsSetup' | 'disabled'
    | 'openProvider' | 'routing' | 'providerDescription' | 'route' | 'priority' | 'fallback'
    | 'saveChanges' | 'routeTask' | 'suitableTasks' | 'live' | 'capabilitiesDescription'
    | 'stable' | 'experimental' | 'evidence' | 'openCapability' | 'jobsDescription'
    | 'searchJobs' | 'filters' | 'allJobs' | 'succeeded' | 'running' | 'queued' | 'canceled'
    | 'job' | 'task' | 'status' | 'started' | 'duration' | 'openJob' | 'jobDescription' | 'messages'
    | 'user' | 'assistant' | 'technicalDetails' | 'copyId' | 'cancelJob' | 'openChat'
    | 'sendMessage' | 'messagePlaceholder' | 'settings' | 'settingsDescription' | 'appearance'
    | 'language' | 'theme' | 'light' | 'density' | 'runtimeSettings' | 'browserRuntime'
    | 'connection' | 'daemonUrl' | 'apiProxy' | 'advanced' | 'semanticRouting' | 'save'
    | 'saved' | 'reset' | 'designTokens' | 'colorTokens' | 'spacingTokens' | 'typeTokens'
    | 'radiusTokens' | 'canvas' | 'surface' | 'ink' | 'muted' | 'accent' | 'small'
    | 'medium' | 'large' | 'compact' | 'comfortable' | 'airy' | 'loading' | 'loadingDescription'
    | 'offline' | 'offlineDescription' | 'fatal' | 'fatalDescription' | 'retry' | 'backOverview'
    | 'close' | 'chooseProfile' | 'chooseProvider' | 'commandPalette' | 'commandDescription'
    | 'open' | 'cancel' | 'profileSaved' | 'providerSelected' | 'capabilitySelected'
    | 'jobOpened' | 'messageSent' | 'changesSaved' | 'ready' | 'busy' | 'error'
    | 'systemVersion' | 'currentProfile' | 'localDashboard' | 'allSystemsOperational'
    | 'routeCount' | 'model' | 'latency' | 'requests' | 'todayShort' | 'yesterday'
    | 'providerAccess' | 'executionMode' | 'browserSession' | 'native' | 'available'
    | 'notConfigured' | 'configuration' | 'health' | 'overviewCards'

  const en: Record<CopyKey, string> = {
    overview: 'Overview', profiles: 'Profiles', providers: 'Providers', capabilities: 'Capabilities',
    jobs: 'Jobs', system: 'System', setup: 'Setup', foundations: 'Foundations', designAtlas: 'Design Atlas',
    illustrativeData: 'Illustrative design data', designSurface: 'Independent UI surface', runtime: 'Runtime',
    active: 'active', waiting: 'waiting', finished: 'finished', tokensSaved: 'tokens saved', workspace: 'Workspace',
    welcomeBack: 'Welcome back, Alex', overviewDescription: 'A quiet view of your local AI workspace and routing health.',
    last30Days: 'Last 30 days', last7Days: 'Last 7 days', today: 'Today', mostUsedProvider: 'Most used provider',
    completedJobs: 'Completed jobs', successRate: 'Success rate', capabilityBreadth: 'Capability breadth',
    completed: 'completed', failed: 'failed', providersConnected: 'providers connected', ofCatalog: 'of catalog',
    insights: 'Insights', providerPanorama: 'Provider Panorama', provider: 'Provider', jobShare: 'Job share',
    capabilitiesShort: 'Capabilities', mode: 'Mode', lastUsed: 'Last used', cumulativeSavings: 'Cumulative savings',
    dailyOutcomes: 'Daily outcomes', capabilityUsage: 'Capability usage', topCapabilities: 'Top capabilities', chatHistory: 'Chat history',
    browser: 'Browser', direct: 'Direct', noUsage: 'No usage yet', viewDetails: 'View details', viewAll: 'View all',
    manage: 'Manage', profile: 'Profile', profileDescription: 'A named set of providers and execution preferences.',
    defaultProfile: 'Default profile', editProfile: 'Edit profile', useProfile: 'Use profile', enabled: 'Enabled',
    inactive: 'Inactive', providersDescription: 'Connect and shape the provider surface available to each profile.',
    connected: 'Connected', needsSetup: 'Needs setup', disabled: 'Disabled', openProvider: 'Open provider',
    routing: 'Routing', providerDescription: 'Provider access, model defaults, and routing behavior.', route: 'Route',
    priority: 'Priority', fallback: 'Fallback', saveChanges: 'Save changes', routeTask: 'Route task',
    suitableTasks: 'Suitable tasks', live: 'Live', capabilitiesDescription: 'The local capability catalog and its preferred routes.',
    stable: 'Stable', experimental: 'Experimental', evidence: 'Evidence', openCapability: 'Open capability',
    jobsDescription: 'A local record of tasks sent through the workspace.', searchJobs: 'Search jobs', filters: 'Filters', status: 'Status',
    allJobs: 'All jobs', succeeded: 'Succeeded', running: 'Running', queued: 'Queued', canceled: 'Canceled',
    job: 'Job', task: 'Task', started: 'Started', duration: 'Duration', openJob: 'Open job', jobDescription: 'Conversation and execution details for this design record.',
    messages: 'Messages', user: 'You', assistant: 'Assistant', technicalDetails: 'Technical details', copyId: 'Copy ID',
    cancelJob: 'Cancel job', openChat: 'Open provider chat', sendMessage: 'Send message', messagePlaceholder: 'Write a follow-up…',
    settings: 'System settings', settingsDescription: 'Shape the local workspace without leaving the design surface.', appearance: 'Appearance',
    language: 'Language', theme: 'Theme', light: 'Light', density: 'Density', runtimeSettings: 'Runtime settings',
    browserRuntime: 'Browser runtime', connection: 'Connection', daemonUrl: 'Daemon URL', apiProxy: 'API proxy', advanced: 'Advanced',
    semanticRouting: 'Semantic routing', save: 'Save', saved: 'Saved', reset: 'Reset', designTokens: 'Design tokens',
    colorTokens: 'Color', spacingTokens: 'Spacing', typeTokens: 'Typography', radiusTokens: 'Radius', canvas: 'Canvas',
    surface: 'Surface', ink: 'Ink', muted: 'Muted', accent: 'Accent', small: 'Small', medium: 'Medium', large: 'Large',
    compact: 'Compact', comfortable: 'Comfortable', airy: 'Airy', loading: 'Loading', loadingDescription: 'Preparing the local workspace view…',
    offline: 'Offline', offlineDescription: 'The workspace is not reachable. Your design remains available to inspect.',
    fatal: 'Something went wrong', fatalDescription: 'The local workspace could not render this screen.', retry: 'Try again', backOverview: 'Back to overview',
    close: 'Close', chooseProfile: 'Choose a profile', chooseProvider: 'Choose a provider', commandPalette: 'Command palette', commandDescription: 'Jump to a screen or action.',
    open: 'Open', cancel: 'Cancel', profileSaved: 'Profile changes saved', providerSelected: 'Provider selected', capabilitySelected: 'Capability opened',
    jobOpened: 'Job opened', messageSent: 'Message added to the design record', changesSaved: 'Changes saved', ready: 'Ready', busy: 'Working', error: 'Needs attention',
    systemVersion: 'Version', currentProfile: 'Current profile', localDashboard: 'Local dashboard', allSystemsOperational: 'All systems operational',
    routeCount: 'routes', model: 'Model', latency: 'Latency', requests: 'requests', todayShort: 'today', yesterday: 'yesterday',
    providerAccess: 'Provider access', executionMode: 'Execution mode', browserSession: 'Browser session', native: 'Native', available: 'Available',
    notConfigured: 'Not configured', configuration: 'Configuration', health: 'Health', overviewCards: 'Overview cards',
  }

  const zh: Record<CopyKey, string> = {
    overview: '概览', profiles: '配置档', providers: '服务商', capabilities: '能力', jobs: '作业', system: '系统', setup: '设置', foundations: '基础',
    designAtlas: 'Design Atlas', illustrativeData: '示例设计数据', designSurface: '独立 UI 设计面', runtime: '运行时', active: '活动中', waiting: '等待中', finished: '已完成', tokensSaved: '节省 tokens', workspace: '工作区',
    welcomeBack: '欢迎回来，Alex', overviewDescription: '安静地查看本地 AI 工作区与路由健康状态。', last30Days: '最近 30 天', last7Days: '最近 7 天', today: '今天', chatHistory: '聊天记录', mostUsedProvider: '最常用服务商', completedJobs: '已完成作业', successRate: '成功率', capabilityBreadth: '能力覆盖', completed: '已完成', failed: '失败', providersConnected: '个服务商已连接', ofCatalog: '目录中的', insights: '洞察', providerPanorama: '服务商全景', provider: '服务商', jobShare: '作业占比', capabilitiesShort: '能力', mode: '模式', lastUsed: '最近使用', cumulativeSavings: '累计节省', dailyOutcomes: '每日结果', capabilityUsage: '能力使用', topCapabilities: '热门能力', browser: '浏览器', direct: '直接', noUsage: '暂无使用记录', viewDetails: '查看详情', viewAll: '查看全部', manage: '管理',
    profile: '配置档', profileDescription: '一组命名的服务商与执行偏好。', defaultProfile: '默认配置档', editProfile: '编辑配置档', useProfile: '使用配置档', enabled: '已启用', inactive: '未激活', providersDescription: '连接并调整每个配置档可用的服务商。', connected: '已连接', needsSetup: '需要设置', disabled: '已禁用', openProvider: '打开服务商', routing: '路由', providerDescription: '服务商访问、模型默认值与路由行为。', route: '路由', priority: '优先级', fallback: '回退', saveChanges: '保存更改', routeTask: '路由任务', suitableTasks: '适用任务', live: '在线', capabilitiesDescription: '本地能力目录及其首选路由。', stable: '稳定', experimental: '实验性', evidence: '证据', openCapability: '打开能力',
    jobsDescription: '通过工作区发送的任务本地记录。', searchJobs: '搜索作业', filters: '筛选', status: '状态', allJobs: '全部作业', succeeded: '成功', running: '运行中', queued: '排队中', canceled: '已取消', job: '作业', task: '任务', started: '开始时间', duration: '耗时', openJob: '打开作业', jobDescription: '该设计记录的对话与执行详情。', messages: '消息', user: '你', assistant: '助手', technicalDetails: '技术详情', copyId: '复制 ID', cancelJob: '取消作业', openChat: '打开服务商对话', sendMessage: '发送消息', messagePlaceholder: '写一条跟进消息…',
    settings: '系统设置', settingsDescription: '无需离开设计面即可调整本地工作区。', appearance: '外观', language: '语言', theme: '主题', light: '浅色', density: '密度', runtimeSettings: '运行时设置', browserRuntime: '浏览器运行时', connection: '连接', daemonUrl: 'Daemon URL', apiProxy: 'API 代理', advanced: '高级', semanticRouting: '语义路由', save: '保存', saved: '已保存', reset: '重置', designTokens: '设计 tokens', colorTokens: '颜色', spacingTokens: '间距', typeTokens: '字体', radiusTokens: '圆角', canvas: '画布', surface: '表面', ink: '文字', muted: '弱化', accent: '强调', small: '小', medium: '中', large: '大', compact: '紧凑', comfortable: '舒适', airy: '宽松', loading: '加载中', loadingDescription: '正在准备本地工作区视图…', offline: '离线', offlineDescription: '工作区暂时不可达，仍可继续检查设计。', fatal: '出现问题', fatalDescription: '本地工作区无法渲染此页面。', retry: '重试', backOverview: '返回概览', close: '关闭', chooseProfile: '选择配置档', chooseProvider: '选择服务商', commandPalette: '命令面板', commandDescription: '跳转到页面或执行操作。', open: '打开', cancel: '取消', profileSaved: '配置档更改已保存', providerSelected: '已选择服务商', capabilitySelected: '已打开能力', jobOpened: '已打开作业', messageSent: '消息已加入设计记录', changesSaved: '更改已保存', ready: '就绪', busy: '处理中', error: '需要关注', systemVersion: '版本', currentProfile: '当前配置档', localDashboard: '本地控制台', allSystemsOperational: '所有系统正常', routeCount: '条路由', model: '模型', latency: '延迟', requests: '请求', todayShort: '今天', yesterday: '昨天', providerAccess: '服务商访问', executionMode: '执行模式', browserSession: '浏览器会话', native: '原生', available: '可用', notConfigured: '未配置', configuration: '配置', health: '健康状态', overviewCards: '概览卡片',
  }

  let {
    screen = 'overview',
    language = 'en',
    accentColor = '#171715',
    backgroundColor = '#f6f5f2',
    surfaceColor = '#ffffff',
    textColor = '#171715',
    radius = 10,
    density = 'comfortable',
    designState = 'ready',
    selectedProfile = 'design',
    selectedProvider = 'ChatGPT',
    selectedJob = 'job-4821',
    modal = 'none',
  }: DesignAtlasArgs = $props()

  let activeScreen = $state<DesignScreen>('overview')
  let languageLocal = $state<DesignLanguage>('en')
  let activeProfile = $state('design')
  let activeProvider = $state('ChatGPT')
  let activeJob = $state('job-4821')
  let activeModal = $state<DesignModal>('none')
  let activeState = $state<DesignState>('ready')
  let navOpen = $state(false)
  let toast = $state('')
  let chartMode = $state<'volume' | 'success'>('volume')
  let providerEnabledBySlug = $state<Record<string, boolean>>({
    chatgpt: true,
    claude: true,
    gemini: false,
    grok: true,
    qwen: true,
    deepseek: true,
    perplexity: true,
    zai: true,
    doubao: true,
  })
  let proxyEnabled = $state(false)
  let routerEnabled = $state(true)
  let messageDraft = $state('')

  let previousLanguage: DesignLanguage = 'en'
  let previousProfile = 'design'
  let previousProvider = 'ChatGPT'
  let previousJob = 'job-4821'
  let previousState: DesignState = 'ready'
  let previousModal: DesignModal = 'none'
  let previousModalScreen: DesignScreen = 'overview'
  let previousScreen: DesignScreen | undefined

  $effect(() => {
    const next = screen
    if (next !== previousScreen) {
      previousScreen = next
      activeScreen = next
    }
  })
  $effect(() => {
    const next = language
    if (next !== previousLanguage) {
      previousLanguage = next
      languageLocal = next
    }
  })
  $effect(() => {
    const next = selectedProfile
    if (next !== previousProfile) {
      previousProfile = next
      activeProfile = next
    }
  })
  $effect(() => {
    const next = selectedProvider
    if (next !== previousProvider) {
      previousProvider = next
      activeProvider = next
    }
  })
  $effect(() => {
    const next = selectedJob
    if (next !== previousJob) {
      previousJob = next
      activeJob = next
    }
  })
  $effect(() => {
    const next = designState
    if (next !== previousState) {
      previousState = next
      activeState = next
    }
  })
  $effect(() => {
    const nextModal = modal
    const nextScreen = screen
    if (nextModal !== previousModal || nextScreen !== previousModalScreen) {
      previousModal = nextModal
      previousModalScreen = nextScreen
      activeModal = nextScreen === 'modal' && nextModal === 'none' ? 'provider' : nextModal
    }
  })

  const navItems: Array<{ id: DesignScreen; label: CopyKey; icon: any }> = [
    { id: 'overview', label: 'overview', icon: LayoutDashboard },
    { id: 'profiles', label: 'profiles', icon: UserRound },
    { id: 'providers', label: 'providers', icon: PlugZap },
    { id: 'capabilities', label: 'capabilities', icon: Layers3 },
    { id: 'jobs', label: 'chatHistory', icon: ListChecks },
  ]

  const providers = [
    { name: 'ChatGPT', short: 'C', slug: 'chatgpt', tint: '#7bd5b1', model: 'gpt-5.4', mode: 'Browser', status: 'connected', share: 22, latency: '1.2s', tasks: 'reasoning · writing' },
    { name: 'Claude', short: 'C', slug: 'claude', tint: '#e8b47a', model: 'claude-sonnet-4', mode: 'Direct', status: 'connected', share: 18, latency: '1.5s', tasks: 'analysis · coding' },
    { name: 'Gemini', short: 'G', slug: 'gemini', tint: '#a7b3ec', model: 'gemini-2.5-pro', mode: 'Browser', status: 'needsSetup', share: 12, latency: '2.1s', tasks: 'research · vision' },
    { name: 'Grok', short: 'G', slug: 'grok', tint: '#b1b1b1', model: 'grok-4', mode: 'Browser', status: 'connected', share: 11, latency: '1.7s', tasks: 'reasoning · research' },
    { name: 'Qwen / 千问', short: 'Q', slug: 'qwen', tint: '#c8b7e7', model: 'qwen-max', mode: 'Direct', status: 'connected', share: 9, latency: '1.6s', tasks: 'translation · coding' },
    { name: 'DeepSeek', short: 'D', slug: 'deepseek', tint: '#9bc8e4', model: 'deepseek-chat', mode: 'Browser', status: 'connected', share: 8, latency: '1.8s', tasks: 'coding · translation' },
    { name: 'Perplexity', short: 'P', slug: 'perplexity', tint: '#a7d8c4', model: 'sonar-pro', mode: 'Browser', status: 'connected', share: 7, latency: '2.0s', tasks: 'web search · research' },
    { name: 'Z.ai / GLM', short: 'Z', slug: 'zai', tint: '#c9d4ea', model: 'glm-4.5', mode: 'Direct', status: 'connected', share: 6, latency: '1.9s', tasks: 'reasoning · coding' },
    { name: 'Doubao / 豆包', short: 'D', slug: 'doubao', tint: '#f0c8c0', model: 'doubao-pro', mode: 'Browser', status: 'connected', share: 4, latency: '2.2s', tasks: 'writing · vision' },
  ]

  const capabilities = [
    { family: 'conversation', icon: MessageSquare, items: [['Chat', 'Submit a prompt and read the correlated visible provider response.', 'chatgpt · Ineligible, claude · Ineligible', 'Supported'], ['Continue conversation', 'Continue the exact durable provider conversation selected by Tokenless API.', 'arena · Ineligible', 'Candidate']] },
    { family: 'retrieval reasoning', icon: Layers3, items: [['Compare models', 'Return two complete visible model answers for one prompt without silently dropping either.', 'arena · Ineligible', 'Supported'], ['Agent execution', 'Run a provider-native agent through visible tool steps to one terminal result.', 'No evidenced route', 'Experimental'], ['Audio transcription', 'Produce a completed visible transcript correlated to caller-selected audio.', 'No evidenced route', 'Candidate'], ['Web search', 'Use a provider-native web retrieval strategy and return grounded results.', 'kimi · Ineligible, arena · Ineligible', 'Candidate'], ['Deep research', 'Complete a provider-native research lifecycle through final cited report delivery.', 'No evidenced route', 'Candidate'], ['Extended reasoning', 'Use a proven provider reasoning strategy rather than a raw provider mode label.', 'No evidenced route', 'Candidate'], ['Code execution', 'Execute code in a provider-owned visible environment.', 'No evidenced route', 'Candidate'], ['Data analysis', 'Analyze structured data through a provider-native workflow.', 'No evidenced route', 'Candidate']] },
    { family: 'input', icon: FileCode2, items: [['Text input', 'Send caller-provided text to a visible provider conversation.', 'chatgpt · Eligible', 'Supported'], ['Image input', 'Understand an image attachment in the provider conversation.', 'No evidenced route', 'Candidate'], ['File upload', 'Attach a local document and preserve the visible provider result.', 'No evidenced route', 'Candidate'], ['Audio input', 'Attach caller-selected audio for provider-native processing.', 'No evidenced route', 'Candidate'], ['Video input', 'Attach caller-selected video for provider-native processing.', 'No evidenced route', 'Candidate'], ['Structured output', 'Return a schema-shaped result from the selected route.', 'No evidenced route', 'Candidate'], ['Continuation', 'Continue an existing conversation without losing route context.', 'arena · Ineligible', 'Candidate']] },
  ]

  const jobs = [
    { id: 'job-4821', title: 'Summarise the provider comparison', status: 'running', provider: 'ChatGPT', time: '2 min ago', duration: '01:24', messages: 6 },
    { id: 'job-4818', title: 'Extract headings from syllabus.pdf', status: 'succeeded', provider: 'Claude', time: 'Yesterday', duration: '00:48', messages: 4 },
    { id: 'job-4804', title: 'Draft a concise release note', status: 'succeeded', provider: 'ChatGPT', time: 'Yesterday', duration: '00:36', messages: 3 },
    { id: 'job-4796', title: 'Review routing configuration', status: 'canceled', provider: 'Gemini', time: 'Mon, 18:42', duration: '00:09', messages: 2 },
  ]

  const capabilityZh: Record<string, string> = {
    conversation: '对话',
    'retrieval reasoning': '检索推理',
    input: '输入',
    Chat: '聊天',
    'Continue conversation': '继续对话',
    'Compare models': '比较模型',
    'Agent execution': '代理执行',
    'Audio transcription': '音频转写',
    'Web search': '网络搜索',
    'Deep research': '深度研究',
    'Extended reasoning': '扩展推理',
    'Code execution': '代码执行',
    'Data analysis': '数据分析',
    'Text input': '文本输入',
    'Image input': '图像输入',
    'File upload': '文件上传',
    'Audio input': '音频输入',
    'Video input': '视频输入',
    'Structured output': '结构化输出',
    Continuation: '续接',
    'Submit a prompt and read the correlated visible provider response.': '提交提示词并读取与之关联的可见服务商响应。',
    'Continue the exact durable provider conversation selected by Tokenless API.': '继续由 Tokenless API 选定的准确持久服务商对话。',
    'Return two complete visible model answers for one prompt without silently dropping either.': '针对一个提示词返回两份完整可见的模型答案，不静默丢弃任何一份。',
    'Run a provider-native agent through visible tool steps to one terminal result.': '通过可见工具步骤运行服务商原生代理，直到得到最终结果。',
    'Produce a completed visible transcript correlated to caller-selected audio.': '生成与调用方选定音频关联的完整可见转写稿。',
    'Use a provider-native web retrieval strategy and return grounded results.': '使用服务商原生的网页检索策略并返回有依据的结果。',
    'Complete a provider-native research lifecycle through final cited report delivery.': '完成服务商原生研究流程，直到交付最终带引用的报告。',
    'Use a proven provider reasoning strategy rather than a raw provider mode label.': '使用经过验证的服务商推理策略，而不是原始的服务商模式标签。',
    'Execute code in a provider-owned visible environment.': '在服务商拥有的可见环境中执行代码。',
    'Analyze structured data through a provider-native workflow.': '通过服务商原生工作流分析结构化数据。',
    'Send caller-provided text to a visible provider conversation.': '将调用方提供的文本发送到可见的服务商对话中。',
    'Understand an image attachment in the provider conversation.': '理解服务商对话中的图像附件。',
    'Attach a local document and preserve the visible provider result.': '附加本地文档并保留可见的服务商结果。',
    'Attach caller-selected audio for provider-native processing.': '附加调用方选定的音频，交由服务商原生处理。',
    'Attach caller-selected video for provider-native processing.': '附加调用方选定的视频，交由服务商原生处理。',
    'Return a schema-shaped result from the selected route.': '从选定路由返回符合 schema 的结果。',
    'Continue an existing conversation without losing route context.': '继续现有对话，同时保留路由上下文。',
    Supported: '支持',
    Candidate: '候选',
    Experimental: '实验性',
  }

  const jobTitleZh: Record<string, string> = {
    'job-4821': '总结服务商比较',
    'job-4818': '从 syllabus.pdf 提取标题',
    'job-4804': '起草简洁的发布说明',
    'job-4796': '检查路由配置',
  }

  function capabilityText(value: string) {
    return bi(value, capabilityZh[value] ?? value)
  }

  function capabilityEvidence(value: string) {
    const chinese = value
      .replaceAll('Ineligible', '不符合资格')
      .replaceAll('Eligible', '符合资格')
      .replace('No evidenced route', '暂无证据支持的路由')
    return bi(value, chinese)
  }

  function capabilityStatus(value: string) {
    return bi(value, capabilityZh[value] ?? value)
  }

  function jobTitle(job: { id: string; title: string }) {
    return bi(job.title, jobTitleZh[job.id] ?? job.title)
  }

  const chartBars = [44, 57, 35, 68, 54, 78, 62, 71, 86, 72, 91, 84, 96, 76, 88, 100, 94, 82, 97, 89, 93, 75, 85, 92, 98, 90, 100, 92, 99, 95]

  const themeStyle = $derived(`--da-accent:${accentColor};--da-canvas:${backgroundColor};--da-surface:${surfaceColor};--da-ink:${textColor};--da-radius:${radius}px;`)
  const contentScreen = $derived(activeScreen === 'modal' ? 'overview' : activeScreen)

  function t(key: CopyKey) {
    return (languageLocal === 'zh-CN' ? zh : en)[key] ?? en[key]
  }

  function bi(english: string, chinese: string) {
    return languageLocal === 'zh-CN' ? chinese : english
  }

  function go(next: DesignScreen) {
    activeScreen = next
    activeModal = 'none'
    navOpen = false
    toast = ''
  }

  function notify(message: string) {
    toast = message
  }

  function providerByName(name: string) {
    return providers.find((entry) => entry.name === name) ?? providers[0]
  }

  function statusLabel(status: string) {
    if (status === 'connected' || status === 'succeeded') return t('connected')
    if (status === 'needsSetup') return t('needsSetup')
    if (status === 'disabled' || status === 'canceled') return t('disabled')
    if (status === 'running') return t('running')
    return status
  }

  function openModal(next: DesignModal) {
    activeModal = next
    toast = ''
  }

  function selectProfile(event: Event) {
    activeProfile = (event.currentTarget as HTMLSelectElement).value
    notify(t('profileSaved'))
  }

  function selectProvider(name: string) {
    activeProvider = name
    notify(t('providerSelected'))
  }

  function selectJob(id: string) {
    activeJob = id
    go('job-detail')
    notify(t('jobOpened'))
  }

  function sendMessage(event: SubmitEvent) {
    event.preventDefault()
    if (!messageDraft.trim()) return
    messageDraft = ''
    notify(t('messageSent'))
  }
</script>

<div class={`design-atlas density-${density}`} style={themeStyle} data-screen={activeScreen} data-state={activeState}>
  {#if activeScreen === 'setup'}
    <main class="setup-canvas" aria-label={t('setup')}>
      <div class="setup-brand"><img src={markUrl} alt="" /><span translate="no">Tokenless API</span><span class="design-badge">{t('designSurface')}</span></div>
      <section class="setup-card">
        <div class="setup-card-intro"><p class="eyebrow">{t('setup')}</p><h1>{bi('Shape your local workspace.', '塑造你的本地工作区。')}</h1><p>{languageLocal === 'zh-CN' ? '选择语言、浏览器和配置档，开始探索独立设计。' : 'Choose a language, browser, and profile to start exploring the independent design.'}</p></div>
        <form onsubmit={(event) => { event.preventDefault(); notify(t('changesSaved')) }}>
          <label class="field"><span>{t('language')}</span><select value={languageLocal} onchange={(event) => { languageLocal = (event.currentTarget as HTMLSelectElement).value as DesignLanguage }}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
          <label class="field"><span>{t('browserRuntime')}</span><select><option>Google Chrome · 145</option><option>Brave · 1.84</option></select></label>
          <div class="setup-profile-row"><label class="field"><span>{t('profile')}</span><input value={activeProfile} oninput={(event) => { activeProfile = (event.currentTarget as HTMLInputElement).value }} /></label><label class="field"><span>{t('theme')}</span><select><option>{t('light')}</option><option>{bi('Dim', '暗色')}</option></select></label></div>
          <div class="setup-provider-list"><span class="field-label">{t('providers')}</span>{#each providers.slice(0, 3) as entry}<label class="check-row"><input type="checkbox" checked={entry.name !== 'Gemini'} onchange={() => notify(t('changesSaved'))} /><span class="provider-dot" style={`--provider-tint:${entry.tint}`}></span><span>{entry.name}</span></label>{/each}</div>
          <div class="setup-actions"><span class="muted mono">127.0.0.1</span><button class="button primary" type="submit">{t('open')} <ChevronRight size={16} /></button></div>
        </form>
      </section>
      {#if toast}<div class="toast" role="status"><CheckCircle2 size={15} />{toast}</div>{/if}
    </main>
  {:else}
    <aside class:open={navOpen} class="atlas-rail" aria-label={t('workspace')}>
      <div class="rail-brand"><button type="button" aria-label={t('overview')} onclick={() => go('overview')}><img src={markUrl} alt="" /></button><span class="rail-wordmark" translate="no">Tokenless API</span></div>
      <div class="rail-label">{t('workspace')}</div>
      <nav>
        {#each navItems as item (item.id)}
          <button class:active={contentScreen === item.id} class="rail-link" type="button" onclick={() => go(item.id)} title={t(item.label)}><item.icon size={17} strokeWidth={1.8} /><span>{t(item.label)}</span></button>
        {/each}
      </nav>
      <div class="rail-bottom"><button class:active={contentScreen === 'system'} class="rail-link" type="button" onclick={() => go('system')} title={t('system')}><Settings size={17} strokeWidth={1.8} /><span>{t('system')}</span></button><div class="rail-status"><i></i><span>{t('live')}</span></div></div>
    </aside>

    <div class="atlas-body">
      {#if activeScreen === 'offline'}<div class="offline-banner"><WifiOff size={14} />{t('offline')} · {t('offlineDescription')}</div>{/if}
      <header class="atlas-topbar">
        <div class="mobile-topbar-brand" aria-hidden="true"><img src={markUrl} alt="" /><span>—</span></div>
        <button class="mobile-menu" type="button" aria-label={t('workspace')} onclick={() => { navOpen = !navOpen }}><Menu size={18} /></button>
        <div class="topbar-context"><span class="topbar-kicker">{t('localDashboard')}</span><strong>{t('designAtlas')}</strong><span class="design-badge">{t('illustrativeData')}</span></div>
        <div class="topbar-spacer"></div>
        <button class="topbar-saving" type="button" onclick={() => go('system')}><span class="topbar-icon dark"><Zap size={15} /></span><span><strong>18.4k</strong><small>{t('tokensSaved')}</small></span><em>+12% {t('todayShort')}</em></button>
        <button class="topbar-runtime" type="button" onclick={() => go('jobs')}><span class="status-dot" class:warning={activeState === 'error'}></span><span><small>{t('runtime')}</small><strong>{activeState === 'busy' ? t('busy') : activeState === 'error' ? t('error') : t('ready')}</strong></span><span class="topbar-count"><strong>2</strong><small>{t('active')}</small></span><span class="topbar-count"><strong>4</strong><small>{t('finished')}</small></span></button>
        <div class="topbar-actions"><label class="topbar-profile"><span class="topbar-icon"><UserRound size={15} /></span><span><small>{t('currentProfile')}</small><select aria-label={t('chooseProfile')} value={activeProfile} onchange={selectProfile}><option value="design">design</option><option value="studio">studio</option><option value="research">research</option><option value="personal">personal</option></select></span></label><button class="topbar-settings" type="button" onclick={() => go('system')}><Settings2 size={16} /><span><small>{t('system')}</small><strong>v0.6.0</strong></span></button></div>
        <label class="mobile-topbar-profile"><select aria-label={t('chooseProfile')} value={activeProfile} onchange={selectProfile}><option value="design">design</option><option value="studio">studio</option><option value="research">research</option><option value="personal">personal</option></select></label>
      </header>

      <main class="atlas-main" id="main" tabindex="-1">
        {#if activeScreen === 'loading'}
          <section class="state-screen"><div class="state-card"><span class="state-spinner"><Activity size={23} /></span><p class="eyebrow">{t('localDashboard')}</p><h1>{t('loading')}</h1><p>{t('loadingDescription')}</p><div class="skeleton-line wide"></div><div class="skeleton-line"></div></div></section>
        {:else if activeScreen === 'offline'}
          <section class="state-screen"><div class="state-card"><span class="state-icon warning"><WifiOff size={24} /></span><p class="eyebrow">{t('localDashboard')}</p><h1>{t('offline')}</h1><p>{t('offlineDescription')}</p><button class="button primary" type="button" onclick={() => { activeScreen = 'overview'; notify(t('ready')) }}><RefreshCw size={15} />{t('retry')}</button></div></section>
        {:else if activeScreen === 'fatal'}
          <section class="state-screen"><div class="state-card"><span class="state-icon danger"><AlertTriangle size={24} /></span><p class="eyebrow">{t('localDashboard')}</p><h1>{t('fatal')}</h1><p>{t('fatalDescription')}</p><div class="state-error-code mono">DESIGN_SURFACE_RENDER_ERROR</div><div class="button-row"><button class="button primary" type="button" onclick={() => { activeScreen = 'overview'; notify(t('ready')) }}><RefreshCw size={15} />{t('retry')}</button><button class="button" type="button" onclick={() => go('overview')}>{t('backOverview')}</button></div></div></section>
        {:else if contentScreen === 'foundations'}
          <section class="page foundations-page"><header class="page-header"><div><p class="eyebrow">{t('foundations')} · {t('designAtlas')}</p><h1>{t('designTokens')}</h1><p class="page-description">{bi('The small set of decisions shared by every independent screen. Adjust the Controls panel to make the change visible across this canvas.', '每个独立页面共享的一组小型设计决策。调整 Controls 面板即可在此画布中看到变化。')}</p></div><div class="page-actions"><span class="design-badge">{t('illustrativeData')}</span></div></header><div class="token-grid"><section class="atlas-card token-card"><header><span class="metric-icon"><Palette size={16} /></span><div><h2>{t('colorTokens')}</h2><p>{bi('One canvas, two surfaces, one point of focus.', '一个画布、两种表面，以及一个视觉焦点。')}</p></div></header><div class="swatch-list"><div><i class="swatch canvas"></i><span>{t('canvas')}</span><code>{backgroundColor}</code></div><div><i class="swatch surface"></i><span>{t('surface')}</span><code>{surfaceColor}</code></div><div><i class="swatch ink"></i><span>{t('ink')}</span><code>{textColor}</code></div><div><i class="swatch accent"></i><span>{t('accent')}</span><code>{accentColor}</code></div></div></section><section class="atlas-card token-card"><header><span class="metric-icon"><SlidersHorizontal size={16} /></span><div><h2>{t('spacingTokens')}</h2><p>{bi('Density changes the pace without changing the structure.', '密度改变节奏，但不改变结构。')}</p></div></header><div class="spacing-preview"><div style="--preview-space:8px"><span>8</span><i></i></div><div style="--preview-space:16px"><span>16</span><i></i></div><div style="--preview-space:24px"><span>24</span><i></i></div></div><div class="density-pills"><span class:active={density === 'compact'}>{t('compact')}</span><span class:active={density === 'comfortable'}>{t('comfortable')}</span><span class:active={density === 'airy'}>{t('airy')}</span></div></section><section class="atlas-card token-card"><header><span class="metric-icon"><Braces size={16} /></span><div><h2>{t('typeTokens')}</h2><p>{bi('Quiet headings, compact metadata, readable records.', '克制的标题、紧凑的元数据，以及易读的记录。')}</p></div></header><div class="type-preview"><strong>Heading / 32</strong><span>Body / 14 · Inter</span><code>mono / 12 · ui-monospace</code></div></section><section class="atlas-card token-card"><header><span class="metric-icon"><Code2 size={16} /></span><div><h2>{t('radiusTokens')}</h2><p>{bi('Soft edges keep the workspace approachable.', '柔和的边缘让工作区更亲切。')}</p></div></header><div class="radius-preview"><i style={`--token-radius:${Math.max(radius - 4, 0)}px`}><span>{t('small')}</span></i><i style={`--token-radius:${radius}px`}><span>{t('medium')}</span></i><i style={`--token-radius:${Math.min(radius + 6, 28)}px`}><span>{t('large')}</span></i></div></section></div><div class="token-note"><Info size={15} /><span>{bi('Design tokens are editable inputs for this Atlas; they do not alter the Tokenless API Dashboard.', 'Design tokens 是此 Atlas 中可编辑的输入，不会改变 Tokenless API Dashboard。')}</span></div></section>
        {:else if contentScreen === 'overview'}
          <section class="overview-wrapper">
          <section class="page overview-page analytics-page"><header class="page-header overview-header"><div><p class="eyebrow">{t('localDashboard')}</p><h1>{bi('Usage analytics', '使用分析')}</h1><p class="page-description">{bi('See which providers Tokenless API uses, which capabilities workloads require, and how outcomes change over time.', '查看 Tokenless API 使用哪些服务商、工作负载需要哪些能力，以及结果如何随时间变化。')}</p></div><div class="page-actions"><div class="analytics-range segmented"><button type="button">7D</button><button class="active" type="button">30D</button><button type="button">90D</button><button type="button">1Y</button><button type="button">{bi('All', '全部')}</button></div><button class="icon-button" type="button" aria-label={t('commandPalette')} title={t('commandPalette')} onclick={() => openModal('command')}><Command size={16} /></button></div></header>{#if activeState === 'busy'}<div class="inline-feedback info"><Activity size={15} />{t('loadingDescription')}</div>{:else if activeState === 'error'}<div class="inline-feedback error"><AlertTriangle size={15} />{t('fatalDescription')}<button class="text-button" type="button" onclick={() => { activeState = 'ready'; notify(t('ready')) }}>{t('retry')}</button></div>{/if}<div class="kpi-grid"><article class="atlas-card kpi-card"><span class="kpi-icon"><UsersRoundIcon /></span><small>{t('mostUsedProvider')}</small><strong>—</strong><p>{bi('No completed usage yet', '暂无已完成的使用记录')}</p></article><article class="atlas-card kpi-card"><span class="kpi-icon"><Activity size={17} /></span><small>{t('completedJobs')}</small><strong>0</strong><p>{bi('Selected range · Aug 4–Sep 2', '所选范围 · 8 月 4 日至 9 月 2 日')}</p></article><article class="atlas-card kpi-card"><span class="kpi-icon"><CheckCircle2 size={17} /></span><small>{t('successRate')}</small><strong>—</strong><p>0 {t('succeeded')} · 0 {t('failed')}</p></article><article class="atlas-card kpi-card"><span class="kpi-icon"><Layers3 size={17} /></span><small>{t('capabilityBreadth')}</small><strong>0/34</strong><p>0 {bi('of 34 used', '项已使用')}</p></article></div><section class="insight-strip"><div class="insight-title"><Sparkles size={15} /><strong>{t('insights')}</strong></div><p>{bi('34 catalog capabilities were not requested in this range.', '此范围内未请求目录中的 34 项能力。')}</p></section><section class="atlas-card panorama-card"><header class="card-header"><div><h2>{t('providerPanorama')}</h2><p>{bi('Finished jobs are attributed to the final provider.', '已完成作业归因于最终服务商。')}</p></div><div class="segmented"><button class="active" type="button">{bi('Jobs', '作业')}</button><button type="button">{bi('Measured tokens', '测量 tokens')}</button><button type="button">{t('successRate')}</button></div></header><div class="provider-table-head"><span>{t('provider')}</span><span>{t('jobShare')}</span><span>{t('successRate')}</span><span>{t('capabilitiesShort')}</span><span>{t('executionMode')}</span><span>{t('lastUsed')}</span></div><div class="analytics-empty">{bi('No provider usage in this range', '此范围内没有服务商使用记录')}</div></section><div class="overview-columns"><section class="atlas-card chart-card"><header class="card-header"><div><h2>{bi('Cumulative output savings', '累计输出节省')}</h2><p>{bi('Visible assistant output measured locally; unmeasured periods are excluded.', '本地测量的可见助手输出；未测量时段不计入。')}</p></div><strong class="chart-total">0</strong></header><div class="analytics-chart-empty">{bi('No measured savings in this range', '此范围内没有已测量节省')}</div><footer class="chart-footer"><span><strong>+0</strong> {bi('added in range', '本范围新增')}</span><span>{bi('Measurement coverage: ———', '测量覆盖率：———')}</span><span>{bi('Daily buckets use UTC.', '每日分桶使用 UTC。')}</span></footer></section><section class="atlas-card chart-card outcomes-card"><header class="card-header"><div><h2>{bi('Daily job outcomes', '每日作业结果')}</h2><p>{bi('Succeeded, failed, and canceled jobs by terminal day.', '按终止日期统计成功、失败和取消的作业。')}</p></div></header><div class="outcome-bars placeholder-bars">{#each Array(30) as _, index}<i><span style={`height:${index % 4 === 0 ? 28 : 100}%`}></span></i>{/each}</div><div class="chart-x-axis outcomes-axis"><span>Aug 4</span><span>Sep 2</span></div><div class="chart-legend"><span><i class="legend-success"></i>{t('succeeded')} · 0</span><span><i class="legend-failed"></i>{t('failed')} · 0</span><span><i class="legend-canceled"></i>{t('canceled')} · 0</span></div></section></div></section></section>
        {:else if contentScreen === 'profiles'}
          <section class="profiles-page production-profiles">
            <aside class="profiles-sidebar">
              <header class="profiles-sidebar-header"><div><p class="eyebrow">Tokenless API</p><h1>{t('profiles')}</h1></div><button class="profile-add" type="button" aria-label={t('open')} onclick={() => openModal('profile')}><Plus size={18} /></button></header>
              <div class="profile-sidebar-list"><button class="profile-sidebar-row active" type="button" onclick={() => { activeProfile = 'design'; notify(`${t('useProfile')}: design`) }}><span class="profile-avatar large"><UserRound size={17} /></span><span><strong>design</strong><small>{bi('Design review', '设计评审')}</small></span><span class="profile-star" aria-hidden="true">★</span></button><button class="profile-sidebar-open" type="button" aria-label={t('openProvider')} onclick={() => go('provider-detail')}><ArrowUpRight size={16} /></button></div>
            </aside>
            <section class="profiles-content">
              <header class="profiles-content-header"><div class="profile-hero-title"><span class="profile-avatar hero"><UserRound size={19} /></span><h1>{activeProfile}</h1><span class="status-badge">{t('defaultProfile')}</span></div><button class="icon-button ghost" type="button" aria-label={t('technicalDetails')} onclick={() => openModal('command')}><MoreHorizontal size={17} /></button></header>
              <div class="profiles-content-inner">
                <section class="production-profile-section"><header><h2>{t('profile')}</h2><button class="text-button" type="button" onclick={() => notify(t('changesSaved'))}>{bi('Edit', '编辑')}</button></header><dl class="profile-summary-rows"><div><dt>{bi('Profile slug', '配置档 slug')}</dt><dd>{activeProfile}</dd></div><div><dt>{bi('Purpose or role', '用途或角色')}</dt><dd>{bi('Design review', '设计评审')}</dd></div><div><dt>{t('browser')}</dt><dd>chrome · system:chrome</dd></div><div><dt>{bi('Visibility', '可见性')}</dt><dd>headed</dd></div></dl></section>
                <section class="production-profile-section profile-providers-section"><header><h2>{t('providers')}</h2><button class="text-button" type="button" onclick={() => notify(t('changesSaved'))}>{bi('Edit', '编辑')}</button></header><div class="profile-provider-list">{#each providers as entry (entry.name)}<button class:provider-unavailable={entry.status === 'needsSetup'} class="profile-provider-row" type="button" onclick={() => { activeProvider = entry.name; notify(t('providerSelected')) }}><span class="provider-avatar tiny">{entry.short}</span><span><strong>{entry.name}</strong><small>{bi('Never checked', '从未检查')}</small></span><span class="provider-row-state"><i></i>{#if entry.status !== 'needsSetup'}<Check size={14} />{/if}</span></button>{/each}</div></section>
              </div>
            </section>
          </section>
        {:else if contentScreen === 'providers'}
          <section class="page providers-page production-providers"><header class="page-header"><div><h1>{t('providers')}</h1><p class="page-description">{bi('Intent, observed access, evidence, and routing eligibility stay separate.', '意图、观察到的访问、证据和路由资格彼此分离。')}</p></div><label class="range-select"><select value={activeProfile} onchange={(event) => { activeProfile = (event.currentTarget as HTMLSelectElement).value }}><option value="design">design</option><option value="research">research</option><option value="personal">personal</option></select><ChevronDown size={14} /></label></header><div class="production-provider-grid">{#each providers as entry (entry.name)}<article class:provider-unavailable={entry.status === 'needsSetup'} class="production-provider-card"><header class="production-provider-header"><div class="provider-heading"><i class="provider-avatar large" style={`--provider-tint:${entry.tint}`}>{entry.short}</i><div><div class="provider-name-line"><h2>{entry.name}</h2><span class="provider-pill"><Globe2 size={10} />{t('browser')}</span><span class="provider-pill"><ArrowUpRight size={10} />{t('direct')}</span></div><p>{entry.slug}</p></div></div><button class:active={providerEnabledBySlug[entry.slug]} class="toggle-button" type="button" aria-label={`${entry.name} ${t('enabled')}`} onclick={() => { providerEnabledBySlug = { ...providerEnabledBySlug, [entry.slug]: !providerEnabledBySlug[entry.slug] }; notify(t('changesSaved')) }}><i></i></button></header><div class="provider-info-row"><span>{bi('Account', '账号')}</span><strong>{bi('Never checked', '从未检查')}</strong></div><div class="provider-info-row provider-routing-row"><span>{bi('Routing role', '路由角色')}</span><strong>{t('notConfigured')}</strong></div><div class="production-provider-status"><span><i></i>{bi('Ineligible', '不符合资格')}</span><span>{entry.status === 'needsSetup' ? bi('Experimental', '实验性') : bi('Supported', '支持')}</span></div><footer class="production-provider-actions"><button class="icon-button ghost" type="button" aria-label={t('openProvider')} onclick={() => { activeProvider = entry.name; go('provider-detail') }}><ArrowUpRight size={15} /></button><button class="icon-button ghost" type="button" aria-label={bi('Refresh provider', '刷新服务商')} onclick={() => notify(t('changesSaved'))}><RefreshCw size={15} /></button><button class="icon-button ghost" type="button" aria-label={bi('Inspect provider', '检查服务商')} onclick={() => notify(t('providerSelected'))}><Gauge size={15} /></button><button class="button" type="button" onclick={() => { activeProvider = entry.name; go('provider-detail') }}>{bi('Details', '详情')}</button></footer></article>{/each}</div></section>
        {:else if contentScreen === 'provider-detail'}
          {@const selected = providerByName(activeProvider)}
          <section class="page provider-detail-page"><button class="back-link" type="button" onclick={() => go('providers')}><ArrowLeft size={15} />{t('providers')}</button><header class="detail-hero"><div class="provider-heading"><i class="provider-avatar hero" style={`--provider-tint:${selected.tint}`}>{selected.short}</i><div><p class="eyebrow">{t('providerAccess')} · {t('illustrativeData')}</p><h1>{selected.name}</h1><p class="page-description">{t('providerDescription')}</p></div></div><div class="page-actions"><span class="status-badge success"><Check size={13} />{t('connected')}</span><button class="button primary" type="button" onclick={() => notify(t('changesSaved'))}><Save size={15} />{t('saveChanges')}</button></div></header><div class="detail-tabs"><button class="active" type="button">{t('overview')}</button><button type="button" onclick={() => notify(`${t('routing')}: ${selected.name}`)}>{t('routing')}</button><button type="button" onclick={() => openModal('command')}>{t('technicalDetails')}</button></div><div class="provider-detail-grid"><section class="atlas-card detail-panel"><header class="card-header"><div><h2>{t('overviewCards')}</h2><p>{t('illustrativeData')}</p></div><span class="status-badge success">{t('live')}</span></header><div class="detail-stat-grid"><div><span>{t('model')}</span><strong>{selected.model}</strong></div><div><span>{t('executionMode')}</span><strong>{selected.mode}</strong></div><div><span>{t('latency')}</span><strong>{selected.latency}</strong></div><div><span>{t('routeCount')}</span><strong>8</strong></div></div><div class="detail-callout"><ShieldCheck size={16} /><div><strong>{t('providerAccess')}</strong><p>{bi('Session is ready for illustrative routing.', '会话已准备就绪，可用于示例路由。')}</p></div></div></section><section class="atlas-card detail-panel routing-panel"><header class="card-header"><div><h2>{t('routing')}</h2><p>{t('suitableTasks')}</p></div><button class="icon-button" type="button" aria-label={t('open')} onclick={() => openModal('command')}><MoreHorizontal size={16} /></button></header><div class="route-list"><div><span class="route-priority">01</span><span><strong>reasoning</strong><small>{selected.model}</small></span><span class="route-state">{t('live')}</span></div><div><span class="route-priority">02</span><span><strong>writing</strong><small>{bi('balanced model', '均衡模型')}</small></span><span class="route-state">{t('fallback')}</span></div><div><span class="route-priority">03</span><span><strong>files</strong><small>{bi('browser session', '浏览器会话')}</small></span><span class="route-state">{t('available')}</span></div></div><button class="button secondary full-width" type="button" onclick={() => notify(t('changesSaved'))}>{t('routeTask')} <ArrowUpRight size={14} /></button></section></div></section>
        {:else if contentScreen === 'capabilities'}
          <section class="page capabilities-page production-capabilities">
            <header class="page-header">
              <div><h1>{t('capabilities')}</h1><p class="page-description">{bi('Start from caller outcomes, then see which evidence-backed provider routes can satisfy them.', '从调用者结果出发，查看哪些有证据支持的服务商路由可以满足这些结果。')}</p></div>
              <label class="range-select"><select value={activeProfile} onchange={(event) => { activeProfile = (event.currentTarget as HTMLSelectElement).value }}><option value="design">design</option><option value="research">research</option><option value="personal">personal</option></select><ChevronDown size={14} /></label>
            </header>
            <div class="production-capability-groups">
              {#each capabilities as group}
                <section class="production-capability-group">
                  <header><h2>{capabilityText(group.family)}</h2><span>{group.items.length}</span></header>
                  <div class="production-capability-list">
                    {#each group.items as item}
                      <button class="production-capability-row" type="button" onclick={() => { openModal('capability'); notify(t('capabilitySelected')) }}>
                        <span class="capability-row-icon"><Layers3 size={16} /></span>
                        <span class="production-capability-copy"><strong>{capabilityText(item[0])}</strong><small>{capabilityText(item[1])}</small></span>
                        <span class="production-capability-evidence"><span class:stable={item[3] === 'Supported'} class="status-badge">{capabilityStatus(item[3])}</span><small>{capabilityEvidence(item[2])}</small></span>
                        <ChevronRight size={15} />
                      </button>
                    {/each}
                  </div>
                </section>
              {/each}
            </div>
          </section>
        {:else if contentScreen === 'jobs'}
          <section class="production-jobs">
            <aside class="chat-history-sidebar">
              <header class="chat-history-heading"><div><h1>{t('chatHistory')}</h1><p>{bi('Review conversations handled through the Tokenless API.', '查看通过 Tokenless API 处理的对话。')}</p></div><span class="chat-history-count">0</span></header>
              <label class="search-input chat-history-search"><Search size={15} /><input placeholder={bi('Search conversations…', '搜索对话…')} /></label>
              <button class="chat-filter" type="button" onclick={() => notify(t('filters'))}><SlidersHorizontal size={14} />{t('filters')}</button>
              <div class="chat-history-empty"><Clock3 size={24} /><strong>{bi('No matching results', '没有匹配结果')}</strong></div>
            </aside>
            <section class="conversation-empty"><Clock3 size={27} /><h2>{bi('Select a conversation', '选择一个对话')}</h2><p>{bi('Choose a conversation from the history to read it here.', '从历史记录中选择一个对话以在此处阅读。')}</p></section>
          </section>
        {:else if contentScreen === 'job-detail'}
          {@const currentJob = jobs.find((item) => item.id === activeJob) ?? jobs[0]}
          <section class="page job-detail-page"><button class="back-link" type="button" onclick={() => go('jobs')}><ArrowLeft size={15} />{t('jobs')}</button><header class="detail-hero job-hero"><div><p class="eyebrow">{t('job')} · {t('illustrativeData')}</p><h1>{jobTitle(currentJob)}</h1><p class="page-description"><span class={`job-dot ${currentJob.status}`}></span>{statusLabel(currentJob.status)} · {currentJob.id} · {currentJob.time}</p></div><div class="page-actions"><button class="button" type="button" onclick={() => notify(t('copyId'))}><Code2 size={15} />{t('copyId')}</button>{#if currentJob.status === 'running'}<button class="button danger" type="button" onclick={() => notify(t('cancelJob'))}><Pause size={14} />{t('cancelJob')}</button>{/if}<button class="button primary" type="button" onclick={() => notify(t('openChat'))}><ArrowUpRight size={14} />{t('openChat')}</button></div></header><div class="job-detail-grid"><section class="atlas-card transcript-card"><header class="card-header"><div><h2>{t('messages')}</h2><p>{currentJob.provider} · gpt-5.4</p></div><span class="design-badge">{t('illustrativeData')}</span></header><div class="transcript"><article class="message user"><span class="message-avatar"><UserRound size={14} /></span><div><small>{t('user')}</small><p>{bi('Compare the current provider routes and tell me where the workspace has the most coverage.', '比较当前的服务商路由，并告诉我工作区在哪些方面覆盖最广。')}</p><time>10:42</time></div></article><article class="message assistant"><span class="message-avatar"><Bot size={14} /></span><div><small>{t('assistant')}</small><p>{bi('The broadest coverage is in conversation and browser tasks. ChatGPT currently handles the reasoning route, while Claude is the preferred fallback for file-heavy work.', '覆盖最广的是对话和浏览器任务。ChatGPT 当前处理推理路由，而 Claude 是文件密集型工作的首选回退。')}</p><time>10:43</time></div></article><article class="message assistant"><span class="message-avatar"><Sparkles size={14} /></span><div><small>{t('assistant')} · {t('insights')}</small><p class="message-note">{bi('Design note: this is illustrative content for exploring the conversation layout.', '设计说明：这些是用于探索对话布局的示例内容。')}</p><time>10:44</time></div></article></div><form class="composer" onsubmit={sendMessage}><input value={messageDraft} oninput={(event) => { messageDraft = (event.currentTarget as HTMLInputElement).value }} placeholder={t('messagePlaceholder')} /><button class="button primary" type="submit"><ArrowUpRight size={15} />{t('sendMessage')}</button></form></section><aside class="job-meta"><section class="atlas-card meta-card"><header class="card-header"><h2>{t('job')}</h2><button class="icon-button ghost" type="button" aria-label={t('technicalDetails')} onclick={() => openModal('command')}><MoreHorizontal size={16} /></button></header><dl><div><dt>{t('provider')}</dt><dd>{currentJob.provider}</dd></div><div><dt>{t('executionMode')}</dt><dd>Browser</dd></div><div><dt>{t('started')}</dt><dd>{currentJob.time}</dd></div><div><dt>{t('duration')}</dt><dd>{currentJob.duration}</dd></div></dl></section><section class="atlas-card meta-card"><header class="card-header"><h2>{t('technicalDetails')}</h2><Info size={15} /></header><div class="technical-lines"><code>capability: responses.continue</code><code>profile: {activeProfile}</code><code>session: browser-145</code><code>design-data: true</code></div></section></aside></div></section>
        {:else if contentScreen === 'system'}
          <section class="page system-page production-system">
            <header class="page-header"><div><h1>{t('system')}</h1><p class="page-description">{bi('Preferences, runtime, and diagnostics.', '偏好设置、运行时与诊断信息。')}</p></div><div class="page-actions"><button class="icon-button" type="button" aria-label={t('reset')} onclick={() => notify(t('reset'))}><RefreshCw size={15} /></button><button class="button primary" type="button" onclick={() => notify(t('changesSaved'))}><Save size={15} />{t('save')}</button></div></header>
            <div class="production-system-grid">
              <section class="production-system-card"><header class="system-card-title"><div><h2>{t('appearance')}</h2><p>{bi('Theme and density', '主题与密度')}</p></div><Info size={15} /></header><div class="system-card-fields"><label class="system-field"><span>{t('language')}</span><select value={languageLocal} onchange={(event) => { languageLocal = (event.currentTarget as HTMLSelectElement).value as DesignLanguage }}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label><label class="system-field"><span>{t('theme')}</span><select><option>{t('light')}</option><option>{bi('Dim', '暗色')}</option></select></label><label class="system-field"><span>{t('density')}</span><select><option>{t('comfortable')}</option><option>{t('compact')}</option><option>{t('airy')}</option></select></label></div></section>
              <section class="production-system-card"><header class="system-card-title"><div><h2>{t('runtimeSettings')}</h2><p>{bi('Browser and execution mode', '浏览器与执行模式')}</p></div><MonitorIcon /></header><div class="system-card-fields"><label class="system-field"><span>{t('browserRuntime')}</span><select><option>Google Chrome · 145</option><option>Brave · 1.84</option></select></label><div class="system-readonly"><span>{t('executionMode')}</span><strong>{t('browserSession')}</strong><small>{t('available')}</small></div><div class="system-readonly"><span>{t('currentProfile')}</span><strong>{activeProfile}</strong><small>{t('illustrativeData')}</small></div></div></section>
              <section class="production-system-card"><header class="system-card-title"><div><h2>{t('configuration')}</h2><p>{bi('Configuration metadata', '配置元数据')}</p></div><Code2 size={15} /></header><dl class="system-meta-list"><div><dt>{bi('Schema', '架构')}</dt><dd>tokenless.config.v1</dd></div><div><dt>{bi('Version', '版本')}</dt><dd>0.6.0</dd></div><div><dt>{bi('Profile registry', '配置档注册表')}</dt><dd>{activeProfile}</dd></div><div><dt>{bi('Data source', '数据来源')}</dt><dd>{t('illustrativeData')}</dd></div></dl></section>
              <section class="production-system-card"><header class="system-card-title"><div><h2>{t('connection')}</h2><p>{bi('Local API connection', '本地 API 连接')}</p></div><Network size={15} /></header><div class="system-card-fields"><label class="system-field"><span>{t('daemonUrl')}</span><input value="http://127.0.0.1:8787" /></label><div class="system-switch-row"><span><strong>{t('apiProxy')}</strong><small>{bi('Keep the API boundary visible', '保持 API 边界可见')}</small></span><button class:active={proxyEnabled} class="switch" type="button" aria-label={t('apiProxy')} aria-pressed={proxyEnabled} onclick={() => { proxyEnabled = !proxyEnabled }}><i></i></button></div><div class="system-connection-state"><i></i><span>{t('allSystemsOperational')}</span></div></div></section>
              <section class="production-system-card"><header class="system-card-title"><div><h2>{t('advanced')}</h2><p>{bi('Routing and diagnostics', '路由与诊断')}</p></div><Settings2 size={15} /></header><div class="system-card-fields"><div class="system-switch-row"><span><strong>{t('semanticRouting')}</strong><small>{bi('Prefer the route with the best fit', '优先选择最匹配的路由')}</small></span><button class:active={routerEnabled} class="switch" type="button" aria-label={t('semanticRouting')} aria-pressed={routerEnabled} onclick={() => { routerEnabled = !routerEnabled }}><i></i></button></div><div class="system-readonly"><span>{t('health')}</span><strong>{t('ready')}</strong><small>{bi('Design-only status', '仅设计状态')}</small></div><button class="button secondary full-width" type="button" onclick={() => notify(t('changesSaved'))}><Save size={14} />{t('saveChanges')}</button></div></section>
            </div>
          </section>
        {:else}
          <section class="state-screen"><div class="state-card"><span class="state-icon"><CircleHelp size={24} /></span><p class="eyebrow">{t('designAtlas')}</p><h1>{t('overview')}</h1><p>{t('overviewDescription')}</p><button class="button primary" type="button" onclick={() => go('overview')}>{t('backOverview')}</button></div></section>
        {/if}
      </main>
    </div>
  {/if}

  {#if activeModal !== 'none'}
    <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) activeModal = 'none' }}>
      <div class="atlas-modal" role="dialog" aria-modal="true" aria-labelledby="atlas-modal-title">
        <header><div><p class="eyebrow">{t('designAtlas')}</p><h2 id="atlas-modal-title">{activeModal === 'profile' ? t('chooseProfile') : activeModal === 'provider' ? t('chooseProvider') : activeModal === 'capability' ? t('openCapability') : t('commandPalette')}</h2></div><button class="icon-button ghost" type="button" aria-label={t('close')} onclick={() => { activeModal = 'none' }}><X size={17} /></button></header>
        {#if activeModal === 'profile'}<div class="modal-options">{#each ['design', 'studio', 'research', 'personal'] as slug}<button class:selected={activeProfile === slug} type="button" onclick={() => { activeProfile = slug; activeModal = 'none'; notify(`${t('useProfile')}: ${slug}`) }}><span class="profile-avatar">{slug.slice(0, 1).toUpperCase()}</span><span><strong>{slug}</strong><small>{slug === 'design' ? t('defaultProfile') : t('profileDescription')}</small></span><ChevronRight size={15} /></button>{/each}</div>{:else if activeModal === 'provider'}<div class="modal-options">{#each providers as entry}<button class:selected={activeProvider === entry.name} type="button" onclick={() => { activeProvider = entry.name; activeModal = 'none'; notify(t('providerSelected')) }}><i class="provider-avatar" style={`--provider-tint:${entry.tint}`}>{entry.short}</i><span><strong>{entry.name}</strong><small>{entry.model} · {entry.mode}</small></span><span class={`status-badge ${entry.status}`}>{statusLabel(entry.status)}</span></button>{/each}</div>{:else if activeModal === 'capability'}<div class="modal-detail"><div class="capability-detail-icon"><Layers3 size={20} /></div><p class="eyebrow">{bi('Conversation', '对话')}</p><h3>responses.continue</h3><p>{bi('Continue an existing conversation while keeping the route visible to the operator.', '继续现有对话，同时让操作员清楚看到路由。')}</p><div class="detail-callout"><ShieldCheck size={16} /><div><strong>{t('evidence')}</strong><p>{bi('Illustrative route: ChatGPT · Claude', '示例路由：ChatGPT · Claude')}</p></div></div><button class="button primary full-width" type="button" onclick={() => { activeModal = 'none'; notify(t('changesSaved')) }}>{t('openCapability')}</button></div>{:else}<div class="modal-command"><p>{t('commandDescription')}</p><label class="search-input"><Search size={15} /><input placeholder={`${t('searchJobs')}…`} /></label><div class="command-list"><button type="button" onclick={() => go('overview')}><LayoutDashboard size={15} /><span>{t('overview')}</span><kbd>⌘ 1</kbd></button><button type="button" onclick={() => go('providers')}><PlugZap size={15} /><span>{t('providers')}</span><kbd>⌘ 2</kbd></button><button type="button" onclick={() => go('jobs')}><ListChecks size={15} /><span>{t('jobs')}</span><kbd>⌘ 3</kbd></button><button type="button" onclick={() => go('system')}><Settings size={15} /><span>{t('system')}</span><kbd>⌘ ,</kbd></button></div></div>{/if}
      </div>
    </div>
  {/if}

  {#if toast}<div class="toast" role="status"><CheckCircle2 size={15} />{toast}<button type="button" aria-label={t('close')} onclick={() => { toast = '' }}><X size={13} /></button></div>{/if}

  {#if activeScreen !== 'setup'}
    <nav class="mobile-bottom-nav" aria-label={t('workspace')}>
      {#each navItems as item (item.id)}
        <button class:active={contentScreen === item.id} type="button" onclick={() => go(item.id)}><item.icon size={16} strokeWidth={1.8} /><span>{t(item.label)}</span></button>
      {/each}
      <button class:active={contentScreen === 'system'} type="button" onclick={() => go('system')}><Settings size={16} strokeWidth={1.8} /><span>{t('system')}</span></button>
    </nav>
  {/if}
</div>
