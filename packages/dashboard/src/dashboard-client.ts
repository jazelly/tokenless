import { translate, translateError } from './i18n/index.js'
import type {
  UiConfirmedDeletion,
  UiConfig,
  UiConfigUpdate,
  UiErrorEnvelope,
  UiJobDetail,
  UiLanguage,
  UiOutputSavingsState,
  UiProfile,
  UiProfileCreate,
  UiProfileRemoval,
  UiProfileUpdate,
  UiProviderAction,
  UiProviderReadinessRefresh,
  UiProviderSelection,
  UiRuntimeOpenResult,
  UiRuntimeStatus,
  UiSetupInput,
  UiSession,
  UiSnapshot,
  UiJobSummary,
} from 'tokenless-internal-shared/ui'
import type { SnapshotResult } from './types.js'

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

  constructor(private readonly currentLanguage: () => UiLanguage) {}

  async authenticate(): Promise<UiSession> {
    const session = await this.request<UiSession>('/session', { method: 'GET' })
    if (!session) throw new DashboardRequestError(translate(this.currentLanguage(), 'requestFailed'))
    this.csrf = session.csrf
    return session
  }

  async snapshot(): Promise<SnapshotResult> {
    const result = await this.request<UiSnapshot>('/snapshot', { method: 'GET' }, true)
    return result === null ? { changed: false } : { changed: true, snapshot: result }
  }

  async updateConfig(input: UiConfigUpdate): Promise<UiConfig> {
    return await this.requireResult(this.request<UiConfig>('/config', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }))
  }

  async setup(input: UiSetupInput): Promise<UiProfile> {
    return await this.requireResult(this.request<UiProfile>('/setup', {
      method: 'POST',
      body: JSON.stringify(input),
    }))
  }

  async enableOutputSavings(): Promise<UiOutputSavingsState> {
    return await this.requireResult(this.request<UiOutputSavingsState>('/output-savings/enable', {
      method: 'POST',
      body: '{}',
    }))
  }

  async disableOutputSavings(): Promise<UiOutputSavingsState> {
    return await this.requireResult(this.request<UiOutputSavingsState>('/output-savings/disable', {
      method: 'POST',
      body: '{}',
    }))
  }

  async clearOutputSavings(): Promise<UiOutputSavingsState> {
    return await this.requireResult(this.request<UiOutputSavingsState>('/output-savings/history/clear', {
      method: 'POST',
      body: JSON.stringify({ confirmDelete: true } satisfies UiConfirmedDeletion),
    }))
  }

  async uninstallOutputSavings(): Promise<UiOutputSavingsState> {
    return await this.requireResult(this.request<UiOutputSavingsState>('/output-savings/runtime/uninstall', {
      method: 'POST',
      body: JSON.stringify({ confirmDelete: true } satisfies UiConfirmedDeletion),
    }))
  }

  async createProfile(input: UiProfileCreate): Promise<UiProfile> {
    return await this.requireResult(this.request<UiProfile>('/profiles', {
      method: 'POST',
      body: JSON.stringify(input),
    }))
  }

  async updateProfile(slug: string, input: UiProfileUpdate): Promise<UiProfile> {
    return await this.requireResult(this.request<UiProfile>(`/profiles/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }))
  }

  async removeProfile(slug: string): Promise<UiProfileRemoval> {
    return await this.requireResult(this.request<UiProfileRemoval>(`/profiles/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    }))
  }

  async openProfile(slug: string): Promise<UiRuntimeOpenResult> {
    return await this.requireResult(this.request<UiRuntimeOpenResult>(`/profiles/${encodeURIComponent(slug)}/open`, {
      method: 'POST',
    }))
  }

  async runProviderAction(profileSlug: string, providerId: string, action: UiProviderAction): Promise<UiJobSummary> {
    return await this.requireResult(this.request<UiJobSummary>(
      `/profiles/${encodeURIComponent(profileSlug)}/providers/${encodeURIComponent(providerId)}/actions/${action}`,
      { method: 'POST' },
    ))
  }

  async selectProviderControl(profileSlug: string, providerId: string, input: UiProviderSelection): Promise<UiJobSummary> {
    return await this.requireResult(this.request<UiJobSummary>(
      `/profiles/${encodeURIComponent(profileSlug)}/providers/${encodeURIComponent(providerId)}/selection`,
      { method: 'POST', body: JSON.stringify(input) },
    ))
  }

  async refreshProviderReadiness(profileSlug: string): Promise<UiProviderReadinessRefresh> {
    return await this.requireResult(this.request<UiProviderReadinessRefresh>(
      `/profiles/${encodeURIComponent(profileSlug)}/providers/actions/readiness`,
      { method: 'POST', body: '{}' },
    ))
  }

  async getJob(jobId: string): Promise<UiJobDetail> {
    return await this.requireResult(this.request<UiJobDetail>(`/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }))
  }

  async cancelJob(jobId: string): Promise<UiJobDetail> {
    return await this.requireResult(this.request<UiJobDetail>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }))
  }

  async resumeJob(jobId: string): Promise<UiJobDetail> {
    return await this.requireResult(this.request<UiJobDetail>(`/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST' }))
  }

  async quiesceRuntime(): Promise<UiRuntimeStatus> {
    return await this.requireResult(this.request<UiRuntimeStatus>('/runtime/quiesce', { method: 'POST' }))
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
      const response = await fetch(`/ui-api/v1${path}`, {
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
        const error = uiErrorEnvelope(body)?.error
        if (method !== 'GET' && error?.code === 'ui_csrf_rejected' && attempt === 0) continue
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

function uiErrorEnvelope(value: unknown): UiErrorEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const error = (value as { error?: unknown }).error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null
  const code = (error as { code?: unknown }).code
  const message = (error as { message?: unknown }).message
  return typeof code === 'string' && typeof message === 'string'
    ? { error: { code, message } }
    : null
}
