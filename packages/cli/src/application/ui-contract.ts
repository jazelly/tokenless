export type UiLanguage = 'en' | 'zh-CN'

export type UiBrowserSelection =
  | 'auto'
  | 'chrome'
  | 'brave'
  | 'edge'
  | 'chromium'
  | 'chrome-for-testing'
  | 'managed-chromium'
  | 'cloak'
  | 'profile'

export type UiBrowserVisibility = 'auto' | 'headed' | 'headless'

export type UiJobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out'

export type UiProviderAccess =
  | 'guest'
  | 'sign_in_required'
  | 'signed_in_free'
  | 'signed_in_paid'
  | 'signed_in_unknown'
  | 'unknown'

export type UiProviderAccount = {
  name: string | null
  subscription: string | null
  tier: {
    class: 'signed_in_free' | 'signed_in_paid' | 'signed_in_unknown'
    label: string | null
  }
}

export type UiProviderObservation = {
  provider: string
  auth: 'authenticated' | 'unauthenticated' | 'unknown'
  access: UiProviderAccess
  checkedAt: string
  account: UiProviderAccount | null
}

export type UiProxy = {
  server: string
  bypass: string[]
}

export type UiProfileConfig = {
  roleLabel: string
  enabledProviders: string[]
  browserVisibility: UiBrowserVisibility
  proxy: UiProxy | null
}

export type UiRouterProviderRule = {
  id: string
  suitableTasks: string
}

export type UiRouterConfig = {
  enabled: boolean
  engine: 'chrome-prompt-api'
  providers: UiRouterProviderRule[]
}

export type UiConfig = {
  updatedAt: string | null
  profiles: { [slug: string]: UiProfileConfig }
  browser: UiBrowserSelection
  browserExecutablePathConfigured: boolean
  browserVisibility: UiBrowserVisibility
  daemonUrl: string | null
  language: UiLanguage
  outputSavings: { enabled: boolean }
  g4f: { enabled: boolean }
  directProvider: {
    defaultBackend: 'native' | 'g4f'
    providerBackends: { [provider: string]: 'native' | 'g4f' }
  }
  router: UiRouterConfig
}

export type UiConfigUpdate = {
  browser?: UiBrowserSelection
  browserExecutablePath?: string | null
  browserVisibility?: UiBrowserVisibility
  language?: UiLanguage
  router?: UiRouterConfig
}

export type UiProfileCreate = {
  slug: string
  roleLabel?: string
  enabledProviders?: string[]
  browserVisibility?: UiBrowserVisibility
  setDefault?: boolean
}

export type UiProfileUpdate = {
  roleLabel?: string
  enabledProviders?: string[]
  browserVisibility?: UiBrowserVisibility
  setDefault?: boolean
}

export type UiBrowserBinding = {
  browserId: string
  runtimeId: string
  family: string
  version: string | null
}

export type UiProfile = {
  slug: string
  id: string
  lifecycle: 'created' | 'ready' | 'removed' | 'failed'
  isDefault: boolean
  createdAt: string
  updatedAt: string
  browserMode: 'native' | 'managed'
  browserBinding: UiBrowserBinding
  roleLabel: string
  enabledProviders: string[]
  browserVisibility: UiBrowserVisibility
  proxy: UiProxy | null
  observations: UiProviderObservation[]
}

export type UiProviderChoice = {
  label: string
  selected: boolean
  enabled: boolean
}

export type UiProviderControls = {
  checkedAt: string | null
  model: UiProviderChoice[] | null
  effort: UiProviderChoice[] | null
}

export type UiProviderExecutionMode = 'browser' | 'direct'

export type UiProviderProfileState = {
  profileId: string
  enabled: boolean
  observation: Omit<UiProviderObservation, 'provider'> | null
  runtimeEligibility: 'eligible' | 'ineligible'
  capabilities: Array<{ id: string; support: string }>
  controls: UiProviderControls
}

export type UiProvider = {
  id: string
  label: string
  stage: 'experimental' | 'supported' | 'disabled'
  executionModes: readonly UiProviderExecutionMode[]
  homeUrl: string
  profiles: UiProviderProfileState[]
}

export type UiCapability = {
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

export type UiOutputSavingsRuntime = {
  runtimeId: string
  state: 'not_installed' | 'invalid' | 'ready'
  installed: boolean
  downloadBytes: number
  installedBytes: number
  checksumVerified?: true
  selfTestVerified?: true
}

export type UiOutputSavingsSummary = {
  estimatedOutputTokens: number
  visibleCharacters: number
  responseCount: number
  jobCount: number
  firstMeasuredAt: string | null
  lastMeasuredAt: string | null
}

export type UiOutputSavingsEvent = {
  responseRequestId: string
  estimatedOutputTokens: number
  visibleCharacters: number
  estimator: string
  estimatorRevision: string
  basis: 'visible_assistant_text'
  measuredAt: string
}

export type UiOutputSavingsState = {
  enabled: boolean
  collection: 'disabled' | 'enabled' | 'unavailable'
  estimator: 'o200k_base'
  basis: 'visible_assistant_text'
  runtime: UiOutputSavingsRuntime
  summary: UiOutputSavingsSummary
  cleared?: number
}

export type UiJobOutputSavings = {
  estimatedOutputTokens: number
  visibleCharacters: number
  responseCount: number
}

export type UiJobSummary = {
  jobId: string
  profileId: string | null
  profileSlug: string | null
  provider: string
  action: string
  status: UiJobStatus
  taskId: string | null
  capabilityRoute: unknown
  agent: { kind: string; sessionId: string } | null
  blocker: unknown
  outputSavings: UiJobOutputSavings
  createdAt: string
  updatedAt: string
}

export type UiJobDetail = UiJobSummary & {
  result: unknown
  error: unknown
  providerAttempts: unknown
  outputSavingsEvents: UiOutputSavingsEvent[]
}

export type UiRuntimeStatus = {
  status: 'running' | 'quiescing' | 'quiesced' | 'stopped'
  activeProfileCount: number
  activeJobCount: number
  pid: number
}

export type UiRuntimeOpenResult = {
  profileId: string
  browserVisibility: UiBrowserVisibility
  effectiveBrowserVisibility: Exclude<UiBrowserVisibility, 'auto'>
  pageCount: number
  status: UiRuntimeStatus
}

export type UiDiagnostic = {
  id: string
  state: 'ok' | 'action_required' | 'error'
  message: string | null
}

export type UiDaemonStatus = {
  version: string
  origin: string
  uptimeMs: number
  pid: number
}

export type UiSnapshot = {
  schema: 'tokenless.ui-snapshot.v1'
  generatedAt: string
  revision: string
  daemon: UiDaemonStatus
  runtime: UiRuntimeStatus
  config: UiConfig
  outputSavings: UiOutputSavingsState
  profiles: UiProfile[]
  providers: UiProvider[]
  capabilities: UiCapability[]
  jobs: UiJobSummary[]
  diagnostics: UiDiagnostic[]
}

export type UiSession = {
  csrf: string
  expiresAt: string
}

export type UiProviderReadinessRefresh = {
  profileSlug: string
  jobs: UiJobSummary[]
}

export type UiProviderAction = 'open' | 'readiness' | 'controls'
export type UiProviderSelection = { kind: 'model' | 'effort'; label: string }
export type UiConfirmedDeletion = { confirmDelete: true }
export type UiProfileRemoval = { slug: string; removed: true }

export type UiErrorEnvelope = {
  error: {
    code: string
    message: string
  }
}
