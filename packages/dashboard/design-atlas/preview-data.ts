import type { DashboardAnalytics, DashboardAnalyticsRange, DashboardJobDetail, DashboardProfile, DashboardSnapshot, Language } from '../src/types.js'

// Illustrative design inputs only. Never use these as provider or benchmark evidence.
const date = '2026-09-04T10:00:00.000Z'
const catalog = [
  ['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'],
  ['grok', 'Grok'], ['qwen', 'Qwen / 千问'], ['deepseek', 'DeepSeek'],
  ['perplexity', 'Perplexity'], ['zai', 'Z.ai / GLM'], ['doubao', 'Doubao / 豆包'],
] as const

export function createPreviewSnapshot(language: Language): DashboardSnapshot {
  const profiles: DashboardProfile[] = [
    { slug: 'design', role: language === 'en' ? 'UI review and product design' : '界面评审与产品设计', providers: ['chatgpt'] },
    { slug: 'studio', role: language === 'en' ? 'Writing and creative work' : '写作与创意工作', providers: ['chatgpt', 'claude', 'gemini'] },
    { slug: 'research', role: language === 'en' ? 'Research and document analysis' : '研究与文档分析', providers: ['claude', 'deepseek', 'perplexity'] },
    { slug: 'personal', role: language === 'en' ? 'Everyday questions' : '日常问答', providers: ['chatgpt', 'qwen'] },
  ].map(({ slug, role, providers }) => ({
    slug, roleLabel: role, isDefault: slug === 'design', browserMode: 'native',
    browserBinding: { browserId: 'chrome', runtimeId: 'design-browser', family: 'system', version: '140.0' },
    enabledProviders: providers, providerModes: Object.fromEntries(providers.map(id => [id, ['browser']])),
    browserVisibility: 'headed', proxy: null, observations: [],
  }))
  const jobs: DashboardJobDetail[] = profiles.flatMap((profile, index) => [
    { id: `job-${index + 1}`, status: 'succeeded' as const, title: language === 'en' ? 'Review the Dashboard layout' : '评审 Dashboard 布局' },
    { id: `job-${index + 1}-running`, status: 'running' as const, title: language === 'en' ? 'Summarize project notes' : '总结项目笔记' },
    { id: `job-${index + 1}-canceled`, status: 'canceled' as const, title: language === 'en' ? 'Compare two drafts' : '比较两个草稿' },
  ].map(job => ({
    jobId: job.id, profileId: profile.slug, profileSlug: profile.slug,
    provider: profile.enabledProviders[0]!, providers: profile.enabledProviders.slice(0, 1),
    action: 'conversation', status: job.status, taskId: job.id, chatTitle: job.title, titlePrompt: job.title,
    executionMode: 'browser', conversationUrl: null, estimatedTokens: job.status === 'succeeded' ? 620 : null,
    capabilityRoute: null, blocker: null, outputSavings: { estimatedOutputTokens: 460, visibleCharacters: 1840, responseCount: 1 },
    createdAt: date, updatedAt: date, result: null, error: null, outputSavingsEvents: [],
    transcript: [
      { role: 'user', content: job.title },
      { role: 'assistant', content: language === 'en' ? 'Keep the primary action visible, group related settings, and use the same components across screens.' : '保持主要操作可见，将相关设置分组，并在各页面使用一致的组件。' },
    ],
  })))
  return {
    schema: 'tokenless.dashboard-snapshot.v1', generatedAt: date, revision: 'design-preview',
    daemon: { version: '0.6.0', origin: 'http://localhost:6007', uptimeMs: 3600000, pid: 0 },
    runtime: { status: 'running', activeProfileCount: 4, activeJobCount: 1, pid: 0 },
    config: {
      updatedAt: date,
      profiles: Object.fromEntries(profiles.map(profile => [profile.slug, {
        roleLabel: profile.roleLabel, enabledProviders: profile.enabledProviders, providerModes: profile.providerModes,
        browserVisibility: profile.browserVisibility, proxy: profile.proxy,
      }])),
      browser: 'chrome', browserExecutablePathConfigured: true, browserVisibility: 'headed',
      daemonUrl: null, language, outputSavings: { enabled: true }, g4f: { enabled: false },
      directProvider: { defaultBackend: 'native', providerBackends: {} },
      router: { enabled: false, engine: 'chrome-prompt-api', providers: [] },
    },
    setup: {
      defaultProfileSlug: 'design', configuredProfileSlugs: profiles.map(profile => profile.slug),
      browserCandidates: [{ browserId: 'chrome', runtimeId: 'design-browser', family: 'system', label: 'Google Chrome', version: '140.0', source: 'system', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', managed: false }],
    },
    outputSavings: {
      enabled: true, collection: 'enabled', estimator: 'o200k_base', basis: 'visible_assistant_text',
      runtime: { runtimeId: 'design-tokenizer', state: 'ready', installed: true, downloadBytes: 0, installedBytes: 0 },
      summary: { estimatedOutputTokens: 18400, visibleCharacters: 73600, responseCount: 40, jobCount: 24, firstMeasuredAt: '2026-08-29T00:00:00.000Z', lastMeasuredAt: date },
    },
    profiles,
    providers: catalog.map(([id, label]) => ({
      id, label, stage: 'supported', executionModes: ['browser', 'direct'], subscriptionSupport: 'supported',
      entryUrls: { browser: null, direct: null },
      profiles: profiles.map(profile => ({
        profileId: profile.slug, enabled: profile.enabledProviders.includes(id), enabledModes: profile.providerModes[id] ?? [],
        observation: null, runtimeEligibility: profile.enabledProviders.includes(id) ? 'eligible' : 'ineligible',
        capabilities: [], capacity: {
          decision: 'unknown', reason: 'design_preview',
          subscription: { accessClass: 'unknown', observedLabel: null, planId: 'unknown', match: 'unknown' }, rules: [],
        }, controls: { checkedAt: null, model: null, effort: null },
      })),
    })),
    capabilities: [
      { id: 'conversation', title: language === 'en' ? 'Conversation' : '对话', description: language === 'en' ? 'Ask questions and follow up.' : '提问与追问。', family: 'conversation' },
      { id: 'document-analysis', title: language === 'en' ? 'Document analysis' : '文档分析', description: language === 'en' ? 'Review and summarize documents.' : '评审与总结文档。', family: 'input' },
      { id: 'web-research', title: language === 'en' ? 'Web research' : '网络研究', description: language === 'en' ? 'Find and compare sources.' : '查找与比较来源。', family: 'retrieval_reasoning' },
    ].map(capability => ({ ...capability, lifecycle: 'active', stability: 'stable', requiredEvidence: [], providers: [{ provider: 'chatgpt', support: 'supported', strategy: 'browser', evidence: [] }] })),
    jobs, diagnostics: [],
  }
}

export function previewAnalytics(snapshot: DashboardSnapshot, profileId: string, range: DashboardAnalyticsRange): DashboardAnalytics {
  const index = Math.max(0, snapshot.profiles.findIndex(profile => profile.slug === profileId))
  const providers = snapshot.profiles[index]!.enabledProviders
  const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: 365 }[range]
  const perDay = (index + 1) * 3
  const count = days * perDay
  const tokens = count * 460
  const daily = Array.from({ length: days }, (_, day) => ({
    day: new Date(Date.UTC(2026, 8, 4 - days + day + 1)).toISOString().slice(0, 10),
    succeededJobs: perDay, failedJobs: 0, canceledJobs: 0, finishedJobs: perDay,
    estimatedOutputTokens: perDay * 460, cumulativeEstimatedOutputTokens: (day + 1) * perDay * 460,
    measuredResponses: perDay, capabilityFamilies: { conversation: perDay },
  }))
  return {
    schema: 'tokenless.dashboard-analytics.v1', generatedAt: date, timeZone: 'UTC', profileId,
    range: { id: range, fromDay: daily[0]!.day, toDay: daily.at(-1)!.day },
    totals: { finishedJobs: count, succeededJobs: count, failedJobs: 0, canceledJobs: 0, successRate: 1, estimatedOutputTokens: tokens, visibleCharacters: tokens * 4, measuredResponses: count, measuredJobs: count, capabilitiesUsed: 1, catalogCapabilities: snapshot.capabilities.length },
    daily,
    providers: providers.map(provider => ({ provider, succeededJobs: count / providers.length, failedJobs: 0, canceledJobs: 0, finishedJobs: count / providers.length, share: 1 / providers.length, successRate: 1, estimatedOutputTokens: tokens / providers.length, measuredResponses: count / providers.length, capabilitiesUsed: 1, browserJobs: count / providers.length, directJobs: 0, unknownModeJobs: 0, lastUsedDay: '2026-09-04' })),
    capabilities: [{ capabilityId: 'conversation', family: 'conversation', succeededJobs: count, failedJobs: 0, canceledJobs: 0, finishedJobs: count, successRate: 1, providersUsed: providers.length }],
    capabilityFamilies: [{ family: 'conversation', succeededJobs: count, failedJobs: 0, canceledJobs: 0, finishedJobs: count }],
    capabilityMatrix: providers.map(provider => ({ provider, capabilityId: 'conversation', family: 'conversation', succeededJobs: count / providers.length, failedJobs: 0, canceledJobs: 0, finishedJobs: count / providers.length })),
    executionModes: [{ mode: 'browser', finishedJobs: count, share: 1 }],
    measurementCoverage: { firstMeasuredAt: daily[0]!.day + 'T00:00:00.000Z', lastMeasuredAt: date },
  }
}
