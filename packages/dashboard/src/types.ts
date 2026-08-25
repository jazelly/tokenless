import type {
  DashboardConfig,
  DashboardConfigDocument,
  DashboardConfigUpdate,
  DashboardJobDetail,
  DashboardJobStatus,
  DashboardJobSummary,
  DashboardLanguage,
  DashboardOutputSavingsState,
  DashboardProfile,
  DashboardProfileCreate,
  DashboardProfileRemoval,
  DashboardProfileUpdate,
  DashboardProviderAction,
  DashboardProviderSelection,
  DashboardRuntimeOpenResult,
  DashboardRuntimeStatus,
  DashboardSetupInput,
  DashboardSetupSnapshot,
  DashboardSnapshot,
  DashboardTerminalBenchSemanticManifestEntry,
  DashboardTerminalBenchSemanticManifestResult,
  DashboardTerminalBenchSemanticManifestSave,
  DashboardTerminalBenchSemanticTasks,
} from 'tokenless-internal-shared/dashboard'

export type {
  DashboardBrowserBinding,
  DashboardBrowserSelection,
  DashboardBrowserVisibility,
  DashboardCapability,
  DashboardConfig,
  DashboardConfigDocument,
  DashboardConfigUpdate,
  DashboardConfirmedDeletion,
  DashboardDaemonStatus,
  DashboardDiagnostic,
  DashboardErrorEnvelope,
  DashboardJobDetail,
  DashboardJobOutputSavings,
  DashboardJobStatus,
  DashboardJobSummary,
  DashboardLanguage,
  DashboardOutputSavingsEvent,
  DashboardOutputSavingsRuntime,
  DashboardOutputSavingsState,
  DashboardOutputSavingsSummary,
  DashboardProfile,
  DashboardProfileConfig,
  DashboardProfileCreate,
  DashboardProfileRemoval,
  DashboardProfileUpdate,
  DashboardProvider,
  DashboardProviderAccess,
  DashboardProviderAccount,
  DashboardProviderAction,
  DashboardProviderChoice,
  DashboardProviderControls,
  DashboardProviderExecutionMode,
  DashboardProviderObservation,
  DashboardProviderProfileState,
  DashboardProviderReadinessRefresh,
  DashboardProviderSelection,
  DashboardProxy,
  DashboardRouterConfig,
  DashboardRouterProviderRule,
  DashboardRuntimeOpenResult,
  DashboardRuntimeStatus,
  DashboardSetupBrowserId,
  DashboardSetupInput,
  DashboardSetupSnapshot,
  DashboardSession,
  DashboardSnapshot,
  DashboardTerminalBenchSemanticManifestEntry,
  DashboardTerminalBenchSemanticManifestResult,
  DashboardTerminalBenchSemanticManifestSave,
  DashboardTerminalBenchSemanticTasks,
} from 'tokenless-internal-shared/dashboard'

export type Language = DashboardLanguage

export type Section = 'overview' | 'profiles' | 'providers' | 'capabilities' | 'routing' | 'jobs' | 'system'

export type ReadinessJobState = {
  jobId?: string
  status: DashboardJobStatus
}

export type ReadinessJobs = { [providerId: string]: ReadinessJobState }

export type DashboardOperation<Result> = () => Promise<Result>

export type DashboardHarnessRunInput = {
  provider: string
  profileId: string
  taskPrompt: string
}

export type DashboardHarnessRunView = {
  protocol: string
  runId: string
  status: string
  turn: number
  providerTurnRef?: string | undefined
  waiting?: { kind: string } | undefined
  final?: { output: string; artifacts: readonly string[] } | undefined
  error?: { code: string; message: string } | undefined
}

export type DashboardHarnessIntervention = Record<string, unknown>

export type HarnessExtensionPairingRequest = {
  pairingId: string
  extensionId: string
  extensionVersion: string
  createdAt: string
  expiresAt: string
  state: 'pending' | 'approved'
}

export type HarnessExtensionPairing = {
  pairingId: string
  extensionId: string
  extensionVersion: string
  provider?: string
  profileId?: string
  status: 'active' | 'revoked'
  createdAt: string
  lastAttachedAt?: string
}

export type DashboardActions = {
  updateConfig: (input: DashboardConfigUpdate, announce?: boolean) => Promise<DashboardConfig>
  getConfigDocument: () => Promise<DashboardConfigDocument>
  createProfile: (input: DashboardProfileCreate, announce?: boolean) => Promise<DashboardProfile>
  updateProfile: (slug: string, input: DashboardProfileUpdate, announce?: boolean) => Promise<DashboardProfile>
  removeProfile: (slug: string, announce?: boolean) => Promise<DashboardProfileRemoval>
  openProfile: (slug: string, announce?: boolean) => Promise<DashboardRuntimeOpenResult>
  runProviderAction: (profileSlug: string, providerId: string, action: DashboardProviderAction, announce?: boolean) => Promise<DashboardJobSummary>
  selectProviderControl: (profileSlug: string, providerId: string, input: DashboardProviderSelection, announce?: boolean) => Promise<DashboardJobSummary>
  getJob: (jobId: string) => Promise<DashboardJobDetail>
  cancelJob: (jobId: string, announce?: boolean) => Promise<DashboardJobDetail>
  startHarnessRun: (input: DashboardHarnessRunInput, announce?: boolean) => Promise<DashboardHarnessRunView>
  readHarnessRun: (runId: string) => Promise<DashboardHarnessRunView>
  resumeHarnessRun: (runId: string, input: DashboardHarnessIntervention, announce?: boolean) => Promise<DashboardHarnessRunView>
  cancelHarnessRun: (runId: string, announce?: boolean) => Promise<DashboardHarnessRunView>
  readTerminalBenchSemanticTasks: () => Promise<DashboardTerminalBenchSemanticTasks>
  saveTerminalBenchSemanticManifest: (
    input: DashboardTerminalBenchSemanticManifestSave,
  ) => Promise<DashboardTerminalBenchSemanticManifestResult>
  quiesceRuntime: (announce?: boolean) => Promise<DashboardRuntimeStatus>
  enableOutputSavings: (announce?: boolean) => Promise<DashboardOutputSavingsState>
  disableOutputSavings: (announce?: boolean) => Promise<DashboardOutputSavingsState>
  clearOutputSavings: (announce?: boolean) => Promise<DashboardOutputSavingsState>
  uninstallOutputSavings: (announce?: boolean) => Promise<DashboardOutputSavingsState>
}

export type DashboardState = {
  language: Language
  offline: boolean
  section: Section
  selectedProfile: string
  snapshot: DashboardSnapshot
}

export type SnapshotResult = {
  changed: boolean
  snapshot?: DashboardSnapshot
}
