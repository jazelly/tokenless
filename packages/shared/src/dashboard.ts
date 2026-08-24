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

export type DashboardRouterProviderRule = {
  id: string
  suitableTasks: string
}

export type DashboardRouterConfig = {
  enabled: boolean
  engine: 'chrome-prompt-api'
  providers: DashboardRouterProviderRule[]
}

export type DashboardConfig = {
  updatedAt: string | null
  profiles: { [slug: string]: DashboardProfileConfig }
  browser: DashboardBrowserSelection
  browserExecutablePathConfigured: boolean
  browserVisibility: DashboardBrowserVisibility
  daemonUrl: string | null
  language: DashboardLanguage
  outputSavings: { enabled: boolean }
  g4f: { enabled: boolean }
  directProvider: {
    defaultBackend: 'native' | 'g4f'
    providerBackends: { [provider: string]: 'native' | 'g4f' }
  }
  router: DashboardRouterConfig
}

export type DashboardConfigUpdate = {
  browser?: DashboardBrowserSelection
  browserExecutablePath?: string | null
  browserVisibility?: DashboardBrowserVisibility
  language?: DashboardLanguage
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
  setDefault?: boolean
}

export type DashboardProfileUpdate = {
  roleLabel?: string
  enabledProviders?: string[]
  providerModes?: { [provider: string]: DashboardProviderExecutionMode[] }
  browserVisibility?: DashboardBrowserVisibility
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

export type DashboardProviderProfileState = {
  profileId: string
  enabled: boolean
  enabledModes: readonly DashboardProviderExecutionMode[]
  observation: Omit<DashboardProviderObservation, 'provider'> | null
  runtimeEligibility: 'eligible' | 'ineligible'
  capabilities: Array<{ id: string; support: string }>
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

export type DashboardRuntimeStatus = {
  status: 'running' | 'quiescing' | 'quiesced' | 'stopped'
  activeProfileCount: number
  activeJobCount: number
  pid: number
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
