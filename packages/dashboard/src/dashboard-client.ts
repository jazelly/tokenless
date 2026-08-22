import { translate, translateError } from './i18n/index.js'
import type {
  DashboardConfirmedDeletion,
  DashboardConfig,
  DashboardConfigUpdate,
  DashboardErrorEnvelope,
  DashboardJobDetail,
  DashboardLanguage,
  DashboardOutputSavingsState,
  DashboardProfile,
  DashboardProfileCreate,
  DashboardProfileRemoval,
  DashboardProfileUpdate,
  DashboardProviderAction,
  DashboardProviderReadinessRefresh,
  DashboardProviderSelection,
  DashboardRuntimeOpenResult,
  DashboardRuntimeStatus,
  DashboardSetupInput,
  DashboardSession,
  DashboardSnapshot,
  DashboardJobSummary,
} from 'tokenless-internal-shared/dashboard'
import type {
  DashboardHarnessIntervention,
  HarnessExtensionPairing,
  HarnessExtensionPairingRequest,
  DashboardHarnessRunInput,
  DashboardHarnessRunView,
  SnapshotResult,
} from './types.js'

export class DashboardRequestError extends Error {
  readonly code: string
  readonly diagnostic: string
  readonly sessionExpired: boolean
  readonly status: number | undefined

  constructor(message: string, options: { code?: string, diagnostic?: string, sessionExpired?: boolean, status?: number } = {}) {
    super(message)
    this.name = 'DashboardRequestError'
    this.code = options.code ?? ''
    this.diagnostic = options.diagnostic ?? ''
    this.sessionExpired = options.sessionExpired ?? false
    this.status = options.status
  }
}

export class DashboardClient {
  private csrf = ''
  private snapshotEtag = ''

  constructor(private readonly currentLanguage: () => DashboardLanguage) {}

  async authenticate(): Promise<DashboardSession> {
    const session = await this.request<DashboardSession>('/session', { method: 'GET' })
    if (!session) throw new DashboardRequestError(translate(this.currentLanguage(), 'requestFailed'))
    this.csrf = session.csrf
    return session
  }

  async snapshot(): Promise<SnapshotResult> {
    const result = await this.request<DashboardSnapshot>('/snapshot', { method: 'GET' }, true)
    return result === null ? { changed: false } : { changed: true, snapshot: result }
  }

  async updateConfig(input: DashboardConfigUpdate): Promise<DashboardConfig> {
    return await this.requireResult(this.request<DashboardConfig>('/config', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }))
  }

  async setup(input: DashboardSetupInput): Promise<DashboardProfile> {
    return await this.requireResult(this.request<DashboardProfile>('/setup', {
      method: 'POST',
      body: JSON.stringify(input),
    }))
  }

  async enableOutputSavings(): Promise<DashboardOutputSavingsState> {
    return await this.requireResult(this.request<DashboardOutputSavingsState>('/output-savings/enable', {
      method: 'POST',
      body: '{}',
    }))
  }

  async disableOutputSavings(): Promise<DashboardOutputSavingsState> {
    return await this.requireResult(this.request<DashboardOutputSavingsState>('/output-savings/disable', {
      method: 'POST',
      body: '{}',
    }))
  }

  async clearOutputSavings(): Promise<DashboardOutputSavingsState> {
    return await this.requireResult(this.request<DashboardOutputSavingsState>('/output-savings/history/clear', {
      method: 'POST',
      body: JSON.stringify({ confirmDelete: true } satisfies DashboardConfirmedDeletion),
    }))
  }

  async uninstallOutputSavings(): Promise<DashboardOutputSavingsState> {
    return await this.requireResult(this.request<DashboardOutputSavingsState>('/output-savings/runtime/uninstall', {
      method: 'POST',
      body: JSON.stringify({ confirmDelete: true } satisfies DashboardConfirmedDeletion),
    }))
  }

  async createProfile(input: DashboardProfileCreate): Promise<DashboardProfile> {
    return await this.requireResult(this.request<DashboardProfile>('/profiles', {
      method: 'POST',
      body: JSON.stringify(input),
    }))
  }

  async updateProfile(slug: string, input: DashboardProfileUpdate): Promise<DashboardProfile> {
    return await this.requireResult(this.request<DashboardProfile>(`/profiles/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }))
  }

  async removeProfile(slug: string): Promise<DashboardProfileRemoval> {
    return await this.requireResult(this.request<DashboardProfileRemoval>(`/profiles/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    }))
  }

  async openProfile(slug: string): Promise<DashboardRuntimeOpenResult> {
    return await this.requireResult(this.request<DashboardRuntimeOpenResult>(`/profiles/${encodeURIComponent(slug)}/open`, {
      method: 'POST',
    }))
  }

  async runProviderAction(profileSlug: string, providerId: string, action: DashboardProviderAction): Promise<DashboardJobSummary> {
    return await this.requireResult(this.request<DashboardJobSummary>(
      `/profiles/${encodeURIComponent(profileSlug)}/providers/${encodeURIComponent(providerId)}/actions/${action}`,
      { method: 'POST' },
    ))
  }

  async selectProviderControl(profileSlug: string, providerId: string, input: DashboardProviderSelection): Promise<DashboardJobSummary> {
    return await this.requireResult(this.request<DashboardJobSummary>(
      `/profiles/${encodeURIComponent(profileSlug)}/providers/${encodeURIComponent(providerId)}/selection`,
      { method: 'POST', body: JSON.stringify(input) },
    ))
  }

  async refreshProviderReadiness(profileSlug: string): Promise<DashboardProviderReadinessRefresh> {
    return await this.requireResult(this.request<DashboardProviderReadinessRefresh>(
      `/profiles/${encodeURIComponent(profileSlug)}/providers/actions/readiness`,
      { method: 'POST', body: '{}' },
    ))
  }

  async getJob(jobId: string): Promise<DashboardJobDetail> {
    return await this.requireResult(this.request<DashboardJobDetail>(`/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }))
  }

  async cancelJob(jobId: string): Promise<DashboardJobDetail> {
    return await this.requireResult(this.request<DashboardJobDetail>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }))
  }

  async startHarnessRun(input: DashboardHarnessRunInput): Promise<DashboardHarnessRunView> {
    return await this.requireResult(this.request<DashboardHarnessRunView>('/harness/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    }))
  }

  async readHarnessRun(runId: string): Promise<DashboardHarnessRunView> {
    return await this.requireResult(this.request<DashboardHarnessRunView>(`/harness/runs/${encodeURIComponent(runId)}`, { method: 'GET' }))
  }

  async resumeHarnessRun(runId: string, input: DashboardHarnessIntervention): Promise<DashboardHarnessRunView> {
    return await this.requireResult(this.request<DashboardHarnessRunView>(`/harness/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      body: JSON.stringify(input),
    }))
  }

  async cancelHarnessRun(runId: string): Promise<DashboardHarnessRunView> {
    return await this.requireResult(this.request<DashboardHarnessRunView>(`/harness/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: '{}',
    }))
  }

  async getHarnessExtensionPairing(pairingId: string): Promise<HarnessExtensionPairingRequest> {
    return await this.requireResult(this.request<HarnessExtensionPairingRequest>(
      `/harness/browser-extension/pairings/${encodeURIComponent(pairingId)}`,
      { method: 'GET' },
    ))
  }

  async approveHarnessExtensionPairing(
    pairingId: string,
    input: { provider: string; profileId: string },
  ): Promise<HarnessExtensionPairing> {
    return await this.requireResult(this.request<HarnessExtensionPairing>(
      `/harness/browser-extension/pairings/${encodeURIComponent(pairingId)}/approve`,
      { method: 'POST', body: JSON.stringify(input) },
    ))
  }

  async quiesceRuntime(): Promise<DashboardRuntimeStatus> {
    return await this.requireResult(this.request<DashboardRuntimeStatus>('/runtime/quiesce', { method: 'POST' }))
  }

  private async requireResult<T>(result: Promise<T | null>): Promise<T> {
    const value = await result
    if (value === null) throw new DashboardRequestError(translate(this.currentLanguage(), 'requestFailed'))
    return value
  }

  private async request<T>(path: string, options: RequestInit, allowNotModified = false): Promise<T | null> {
    const method = options.method ?? 'GET'
    for (let attempt = 0; ; attempt += 1) {
      if (method !== 'GET') await this.authenticate()
      const response = await fetch(`/dashboard-api/v1${path}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(method !== 'GET' ? { 'x-tokenless-csrf': this.csrf } : {}),
          ...(path === '/snapshot' && this.snapshotEtag ? { 'if-none-match': this.snapshotEtag } : {}),
          ...(options.headers ?? {}),
        },
      })
      if (response.status === 401) {
        throw new DashboardRequestError(translate(this.currentLanguage(), 'reopen'), { sessionExpired: true, status: 401 })
      }
      if (response.status === 304 && allowNotModified) return null
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const error = dashboardErrorEnvelope(body)?.error
        if (method !== 'GET' && error?.code === 'dashboard_csrf_rejected' && attempt === 0) continue
        const code = error?.code ?? ''
        const language = this.currentLanguage()
        const summary = translateError(language, code, error?.message)
        const diagnostic = error?.message ?? ''
        const message = language === 'en' && diagnostic && diagnostic !== summary
          ? `${summary}\n${translate(language, 'diagnostics')}: ${diagnostic}`
          : summary
        throw new DashboardRequestError(
          message,
          { code, diagnostic, status: response.status },
        )
      }
      if (path === '/snapshot') this.snapshotEtag = response.headers.get('etag') ?? ''
      return body as T
    }
  }
}

function dashboardErrorEnvelope(value: unknown): DashboardErrorEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const error = (value as { error?: unknown }).error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null
  const code = (error as { code?: unknown }).code
  const message = (error as { message?: unknown }).message
  return typeof code === 'string' && typeof message === 'string'
    ? { error: { code, message } }
    : null
}
