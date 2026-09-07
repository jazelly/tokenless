import type { TokenlessLanguage } from './i18n.js'

export type DashboardLanguage = TokenlessLanguage

export type DashboardBrowserSelection =
  | 'auto'
  | 'chrome'
  | 'brave'
  | 'edge'
  | 'chromium'
  | 'chrome-for-testing'
  | 'managed-chromium'
  | 'cloak'
  | 'profile'

export type DashboardBrowserVisibility = 'auto' | 'headed' | 'headless'

export type DashboardJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type DashboardProviderAccess =
  | 'guest'
  | 'sign_in_required'
  | 'account_blocked'
  | 'signed_in_free'
  | 'signed_in_paid'
  | 'signed_in_unknown'
  | 'unknown'

export type DashboardProviderAccount = {
  name: string | null
  subscription: string | null
  tier: {
    class: 'signed_in_free' | 'signed_in_paid' | 'signed_in_unknown'
    label: string | null
  }
}

export type DashboardProviderObservation = {
  provider: string
  auth: 'authenticated' | 'unauthenticated' | 'unknown'
  access: DashboardProviderAccess
  checkedAt: string
  account: DashboardProviderAccount | null
}

export type DashboardProxy = {
  server: string
  bypass: string[]
}

export type DashboardProfileConfig = {
  runtimeBinding?: {
    runtimeId: string
    family: string
    browserId: string
    executablePath: string
    createdWithVersion: string
    profileFormat: number
  }
  roleLabel: string
  enabledProviders: string[]
  providerModes: { [provider: string]: DashboardProviderExecutionMode[] }
  browserVisibility: DashboardBrowserVisibility
  proxy: DashboardProxy | null
}

export type DashboardApiProxyConfig = {
  enabled: boolean
  executionMode: 'browser' | 'direct'
}

export type DashboardDirectProviderConfig = {
  defaultBackend: 'native' | 'g4f'
  providerBackends: { [provider: string]: 'native' | 'g4f' }
}

export type DashboardRouterProviderRule = {
  id: string
  suitableTasks: string
}

export type DashboardRouterConfig = {
  enabled: boolean
  engine: 'chrome-prompt-api' | 'spark-x2.5-4b-mlx'
  providers: DashboardRouterProviderRule[]
}

export type DashboardTerminalBenchSemanticTask = {
  instructionDigest: string
  instruction: string
}

export type DashboardTerminalBenchSemanticManifestEntry = {
  instructionDigest: string
  preferredProvider: string
  taskType: string
  complexity: 'low' | 'medium' | 'high'
  truncated: boolean
}

export type DashboardTerminalBenchSemanticTasks = {
  schema: 'tokenless.terminalbench-semantic-manifest-tasks.v1'
  dataset: string
  datasetRef: string
  officialInstructionDigest: string
  tasks: DashboardTerminalBenchSemanticTask[]
}

export type DashboardTerminalBenchSemanticManifestSave = {
  token: string
  entries: DashboardTerminalBenchSemanticManifestEntry[]
}

export type DashboardTerminalBenchSemanticManifestResult = {
  fileName: string
  manifestDigest: string
  taskCount: number
}

export type DashboardBrowserTabGc = {
  idleTimeoutSeconds: number
  sweepIntervalSeconds: number
  maxTabsPerProfile: number
}

export type DashboardTabGcStatus = {
  idleReuses: number
  expired: number
  capacity: number
  capacityRejected: number
  closeFailures: number
  reopenedSoon: number
  profiles: Array<{ profileId: string; workPages: number; idlePages: number; busyPages: number; totalPages?: number | null; untrackedPages?: number | null; status?: string; errorCode?: string | null }>
}

export type DashboardConfig = {
  updatedAt: string | null
  profiles: { [slug: string]: DashboardProfileConfig }
  browser: DashboardBrowserSelection
  browserExecutablePathConfigured: boolean
  browserVisibility: DashboardBrowserVisibility
  daemonUrl: string | null
  language: DashboardLanguage
  browserTabGc: DashboardBrowserTabGc
  outputSavings: { enabled: boolean }
  g4f: { enabled: boolean }
  directProvider: {
    defaultBackend: 'native' | 'g4f'
    providerBackends: { [provider: string]: 'native' | 'g4f' }
  }
  router: DashboardRouterConfig
}

/** The authenticated, fresh-on-request representation of config.json. */
export type DashboardConfigDocument = {
  protocol: string
  updatedAt: string | null
  defaultProfile: string | null
  profiles: { [slug: string]: DashboardProfileConfig }
  browser: DashboardBrowserSelection
  browserExecutablePath: string | null
  browserVisibility: DashboardBrowserVisibility
  daemonUrl: string | null
  language: DashboardLanguage
  browserTabGc: DashboardBrowserTabGc
  outputSavings: { enabled: boolean }
  apiProxy: DashboardApiProxyConfig
  g4f: { enabled: boolean }
  directProvider: DashboardDirectProviderConfig
  router: DashboardRouterConfig
  configPath?: string
}

export type DashboardConfigUpdate = {
  defaultProfile?: string | null
  browser?: DashboardBrowserSelection
  browserExecutablePath?: string | null
  browserVisibility?: DashboardBrowserVisibility
  daemonUrl?: string | null
  language?: DashboardLanguage
  browserTabGc?: DashboardBrowserTabGc
  outputSavings?: { enabled: boolean }
  apiProxy?: DashboardApiProxyConfig
  g4f?: { enabled: boolean }
  directProvider?: DashboardDirectProviderConfig
  router?: DashboardRouterConfig
}

export type DashboardSetupBrowserId = 'chrome' | 'brave' | 'cloak'

export type DashboardBrowserCandidate = {
  browserId: DashboardSetupBrowserId
  runtimeId: string
  family: 'system' | 'cloak'
  label: string
  version: string
  source: 'system' | 'tokenless-cache'
  executablePath: string
  managed: boolean
}

export type DashboardSetupSnapshot = {
  browserCandidates: DashboardBrowserCandidate[]
  defaultProfileSlug: string | null
  configuredProfileSlugs: string[]
}

export type DashboardSetupInput = {
  slug: string
  roleLabel?: string
  enabledProviders?: string[]
  browser: DashboardSetupBrowserId
  browserExecutablePath?: string | null
  language?: DashboardLanguage
  browserVisibility?: DashboardBrowserVisibility
  setDefault?: boolean
}

export type DashboardProfileCreate = {
  slug: string
  roleLabel?: string
  enabledProviders?: string[]
  providerModes?: { [provider: string]: DashboardProviderExecutionMode[] }
  browserVisibility?: DashboardBrowserVisibility
  proxy?: DashboardProxy | null
  setDefault?: boolean
}

export type DashboardProfileUpdate = {
  roleLabel?: string
  enabledProviders?: string[]
  providerModes?: { [provider: string]: DashboardProviderExecutionMode[] }
  browserVisibility?: DashboardBrowserVisibility
  proxy?: DashboardProxy | null
  setDefault?: boolean
}

export type DashboardBrowserBinding = {
  browserId: string
  runtimeId: string
  family: string
  version: string | null
}

export type DashboardProfile = {
  slug: string
  isDefault: boolean
  browserMode: 'native' | 'managed'
  browserBinding: DashboardBrowserBinding
  roleLabel: string
  enabledProviders: string[]
  providerModes: { [provider: string]: DashboardProviderExecutionMode[] }
  browserVisibility: DashboardBrowserVisibility
  proxy: DashboardProxy | null
  observations: DashboardProviderObservation[]
}

export type DashboardProviderChoice = {
  label: string
  selected: boolean
  enabled: boolean
}

export type DashboardProviderControls = {
  checkedAt: string | null
  model: DashboardProviderChoice[] | null
  effort: DashboardProviderChoice[] | null
}

export type DashboardProviderExecutionMode = 'browser' | 'direct'

export type DashboardProviderCapacity = {
  decision: 'admit' | 'defer' | 'unknown'
  reason: string
  subscription: {
    accessClass: string
    observedLabel: string | null
    planId: string
    match: 'label' | 'access_class' | 'unknown'
  }
  rules: Array<{
    ruleId: string
    action: string
    publishedAllowance: number | null
    remainingUnits: number | null
    requestedUnits: number
    decision: 'admit' | 'defer' | 'unknown'
  }>
}

export type DashboardProviderProfileState = {
  profileId: string
  enabled: boolean
  enabledModes: readonly DashboardProviderExecutionMode[]
  observation: Omit<DashboardProviderObservation, 'provider'> | null
  runtimeEligibility: 'eligible' | 'ineligible'
  capabilities: Array<{
    id: string
    support: string
    executionMode: DashboardProviderExecutionMode
    evidence: readonly string[]
  }>
  capacity: DashboardProviderCapacity
  controls: DashboardProviderControls
}

export type DashboardProvider = {
  id: string
  label: string
  stage: 'experimental' | 'supported' | 'disabled'
  executionModes: readonly DashboardProviderExecutionMode[]
  subscriptionSupport: 'supported' | 'unsupported'
  entryUrls: Readonly<Record<DashboardProviderExecutionMode, string | null>>
  profiles: DashboardProviderProfileState[]
}

export type DashboardCapability = {
  id: string
  title: string
  description: string
  family: string
  lifecycle: string
  stability: string
  requiredEvidence: readonly string[]
  providers: Array<{
    provider: string
    support: string
    strategy: string
    evidence: readonly string[]
  }>
}

export type DashboardOutputSavingsRuntime = {
  runtimeId: string
  state: 'not_installed' | 'invalid' | 'ready'
  installed: boolean
  downloadBytes: number
  installedBytes: number
  checksumVerified?: true
  selfTestVerified?: true
}

export type DashboardOutputSavingsSummary = {
  estimatedOutputTokens: number
  visibleCharacters: number
  responseCount: number
  jobCount: number
  firstMeasuredAt: string | null
  lastMeasuredAt: string | null
}

export type DashboardOutputSavingsEvent = {
  responseRequestId: string
  estimatedOutputTokens: number
  visibleCharacters: number
  estimator: string
  estimatorRevision: string
  basis: 'visible_assistant_text'
  measuredAt: string
}

export type DashboardOutputSavingsState = {
  enabled: boolean
  collection: 'disabled' | 'enabled' | 'unavailable'
  estimator: 'o200k_base'
  basis: 'visible_assistant_text'
  runtime: DashboardOutputSavingsRuntime
  summary: DashboardOutputSavingsSummary
  cleared?: number
}

export type DashboardJobOutputSavings = {
  estimatedOutputTokens: number
  visibleCharacters: number
  responseCount: number
}

export type DashboardJobSummary = {
  jobId: string
  profileId: string | null
  profileSlug: string | null
  provider: string
  action: string
  status: DashboardJobStatus
  taskId: string | null
  chatTitle: string | null
  titlePrompt: string | null
  executionMode: DashboardProviderExecutionMode | null
  providers: string[]
  conversationUrl: string | null
  estimatedTokens: number | null
  capabilityRoute: unknown
  blocker: unknown
  outputSavings: DashboardJobOutputSavings
  createdAt: string
  updatedAt: string
}

export type DashboardJobDetail = DashboardJobSummary & {
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>
  result: unknown
  error: unknown
  outputSavingsEvents: DashboardOutputSavingsEvent[]
}

export type DashboardAnalyticsRange = '7d' | '30d' | '90d' | '1y' | 'all'

export type DashboardAnalyticsTotals = {
  finishedJobs: number
  succeededJobs: number
  failedJobs: number
  canceledJobs: number
  successRate: number | null
  estimatedOutputTokens: number
  visibleCharacters: number
  measuredResponses: number
  measuredJobs: number
  capabilitiesUsed: number
  catalogCapabilities: number
}

export type DashboardAnalyticsDailyPoint = {
  day: string
  succeededJobs: number
  failedJobs: number
  canceledJobs: number
  finishedJobs: number
  estimatedOutputTokens: number
  cumulativeEstimatedOutputTokens: number
  measuredResponses: number
  capabilityFamilies: Record<string, number>
}

export type DashboardAnalyticsProvider = {
  provider: string
  succeededJobs: number
  failedJobs: number
  canceledJobs: number
  finishedJobs: number
  share: number
  successRate: number | null
  estimatedOutputTokens: number
  measuredResponses: number
  capabilitiesUsed: number
  browserJobs: number
  directJobs: number
  unknownModeJobs: number
  lastUsedDay: string | null
}

export type DashboardAnalyticsCapability = {
  capabilityId: string
  family: string
  succeededJobs: number
  failedJobs: number
  canceledJobs: number
  finishedJobs: number
  successRate: number | null
  providersUsed: number
}

export type DashboardAnalyticsCapabilityFamily = {
  family: string
  succeededJobs: number
  failedJobs: number
  canceledJobs: number
  finishedJobs: number
}

export type DashboardAnalyticsCapabilityMatrixCell = DashboardAnalyticsCapabilityFamily & {
  capabilityId: string
  provider: string
}

export type DashboardAnalyticsExecutionMode = {
  mode: 'browser' | 'direct' | 'unknown'
  finishedJobs: number
  share: number
}

export type DashboardAnalytics = {
  schema: 'tokenless.dashboard-analytics.v1'
  generatedAt: string
  timeZone: 'UTC'
  range: {
    id: DashboardAnalyticsRange
    fromDay: string
    toDay: string
  }
  profileId: string | null
  totals: DashboardAnalyticsTotals
  daily: DashboardAnalyticsDailyPoint[]
  providers: DashboardAnalyticsProvider[]
  capabilities: DashboardAnalyticsCapability[]
  capabilityFamilies: DashboardAnalyticsCapabilityFamily[]
  capabilityMatrix: DashboardAnalyticsCapabilityMatrixCell[]
  executionModes: DashboardAnalyticsExecutionMode[]
  measurementCoverage: {
    firstMeasuredAt: string | null
    lastMeasuredAt: string | null
  }
}

export type DashboardRuntimeStatus = {
  status: 'running' | 'quiescing' | 'quiesced' | 'stopped'
  activeProfileCount: number
  activeJobCount: number
  pid: number
  tabGc?: DashboardTabGcStatus
}

export type DashboardRuntimeOpenResult = {
  profileId: string
  browserVisibility: DashboardBrowserVisibility
  effectiveBrowserVisibility: Exclude<DashboardBrowserVisibility, 'auto'>
  pageCount: number
  status: DashboardRuntimeStatus
}

export type DashboardDiagnostic = {
  id: string
  state: 'ok' | 'action_required' | 'error'
  message: string | null
}

export type DashboardDaemonStatus = {
  version: string
  origin: string
  uptimeMs: number
  pid: number
}

export type DashboardSnapshot = {
  schema: 'tokenless.dashboard-snapshot.v1'
  generatedAt: string
  revision: string
  daemon: DashboardDaemonStatus
  runtime: DashboardRuntimeStatus
  config: DashboardConfig
  setup: DashboardSetupSnapshot
  outputSavings: DashboardOutputSavingsState
  profiles: DashboardProfile[]
  providers: DashboardProvider[]
  capabilities: DashboardCapability[]
  jobs: DashboardJobSummary[]
  diagnostics: DashboardDiagnostic[]
}

export type DashboardSession = {
  csrf: string
  expiresAt: string
}

export type DashboardProviderReadinessRefresh = {
  profileSlug: string
  jobs: DashboardJobSummary[]
}

export type DashboardProviderAction = 'open' | 'readiness' | 'controls'
export type DashboardProviderSelection = { kind: 'model' | 'effort'; label: string }
export type DashboardConfirmedDeletion = { confirmDelete: true }
export type DashboardProfileRemoval = { slug: string; removed: true }

export type DashboardErrorEnvelope = {
  error: {
    code: string
    message: string
  }
}
