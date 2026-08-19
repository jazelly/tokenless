import type {
  UiConfig,
  UiConfigUpdate,
  UiJobDetail,
  UiJobStatus,
  UiJobSummary,
  UiLanguage,
  UiOutputSavingsState,
  UiProfile,
  UiProfileCreate,
  UiProfileRemoval,
  UiProfileUpdate,
  UiProviderAction,
  UiProviderSelection,
  UiRuntimeOpenResult,
  UiRuntimeStatus,
  UiSnapshot,
} from 'tokenless-web-ai-interaction-protocol/ui-contract'

export type {
  UiBrowserBinding,
  UiBrowserSelection,
  UiBrowserVisibility,
  UiCapability,
  UiConfig,
  UiConfigUpdate,
  UiConfirmedDeletion,
  UiDaemonStatus,
  UiDiagnostic,
  UiErrorEnvelope,
  UiJobDetail,
  UiJobOutputSavings,
  UiJobStatus,
  UiJobSummary,
  UiLanguage,
  UiOutputSavingsEvent,
  UiOutputSavingsRuntime,
  UiOutputSavingsState,
  UiOutputSavingsSummary,
  UiProfile,
  UiProfileConfig,
  UiProfileCreate,
  UiProfileRemoval,
  UiProfileUpdate,
  UiProvider,
  UiProviderAccess,
  UiProviderAccount,
  UiProviderAction,
  UiProviderChoice,
  UiProviderControls,
  UiProviderExecutionMode,
  UiProviderObservation,
  UiProviderProfileState,
  UiProviderReadinessRefresh,
  UiProviderSelection,
  UiProxy,
  UiRouterConfig,
  UiRouterProviderRule,
  UiRuntimeOpenResult,
  UiRuntimeStatus,
  UiSession,
  UiSnapshot,
} from 'tokenless-web-ai-interaction-protocol/ui-contract'

export type Language = UiLanguage

export type Section = 'overview' | 'profiles' | 'providers' | 'capabilities' | 'routing' | 'jobs' | 'system'

export type ReadinessJobState = {
  jobId?: string
  status: UiJobStatus
}

export type ReadinessJobs = { [providerId: string]: ReadinessJobState }

export type DashboardOperation<Result> = () => Promise<Result>

export type DashboardActions = {
  updateConfig: (input: UiConfigUpdate, announce?: boolean) => Promise<UiConfig>
  createProfile: (input: UiProfileCreate, announce?: boolean) => Promise<UiProfile>
  updateProfile: (slug: string, input: UiProfileUpdate, announce?: boolean) => Promise<UiProfile>
  removeProfile: (slug: string, announce?: boolean) => Promise<UiProfileRemoval>
  openProfile: (slug: string, announce?: boolean) => Promise<UiRuntimeOpenResult>
  runProviderAction: (profileSlug: string, providerId: string, action: UiProviderAction, announce?: boolean) => Promise<UiJobSummary>
  selectProviderControl: (profileSlug: string, providerId: string, input: UiProviderSelection, announce?: boolean) => Promise<UiJobSummary>
  getJob: (jobId: string) => Promise<UiJobDetail>
  cancelJob: (jobId: string, announce?: boolean) => Promise<UiJobDetail>
  resumeJob: (jobId: string, announce?: boolean) => Promise<UiJobDetail>
  quiesceRuntime: (announce?: boolean) => Promise<UiRuntimeStatus>
  enableOutputSavings: (announce?: boolean) => Promise<UiOutputSavingsState>
  disableOutputSavings: (announce?: boolean) => Promise<UiOutputSavingsState>
  clearOutputSavings: (announce?: boolean) => Promise<UiOutputSavingsState>
  uninstallOutputSavings: (announce?: boolean) => Promise<UiOutputSavingsState>
}

export type DashboardState = {
  language: Language
  offline: boolean
  section: Section
  selectedProfile: string
  snapshot: UiSnapshot
}

export type SnapshotResult = {
  changed: boolean
  snapshot?: UiSnapshot
}
