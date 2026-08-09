import { translate, translateError } from './localization.js'
import type { JsonRecord, Language, SnapshotResult } from './types.js'

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

  constructor(private readonly currentLanguage: () => Language) {}

  async authenticate() {
    const session = await this.request('/session', { method: 'GET' })
    if (!session) throw new DashboardRequestError(translate(this.currentLanguage(), 'requestFailed'))
    this.csrf = String(session.csrf)
  }

  async snapshot(): Promise<SnapshotResult> {
    const result = await this.request('/snapshot', { method: 'GET' })
    return result === null ? { changed: false } : { changed: true, snapshot: result }
  }

  get(path: string) {
    return this.request(path, { method: 'GET' })
  }

  mutate(path: string, body: unknown, method = 'POST') {
    return this.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  private async request(path: string, options: RequestInit): Promise<JsonRecord | null> {
    const response = await fetch(`/ui-api/v1${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.method && options.method !== 'GET' ? { 'x-tokenless-csrf': this.csrf } : {}),
        ...(path === '/snapshot' && this.snapshotEtag ? { 'if-none-match': this.snapshotEtag } : {}),
        ...(options.headers ?? {}),
      },
    })
    if (response.status === 401) {
      throw new DashboardRequestError(translate(this.currentLanguage(), 'reopen'), { sessionExpired: true, status: 401 })
    }
    if (response.status === 304) return null
    const body = await response.json().catch(() => ({})) as JsonRecord
    if (!response.ok) {
      const code = typeof body?.error?.code === 'string' ? body.error.code : ''
      const language = this.currentLanguage()
      const summary = translateError(language, code, body?.error?.message)
      const diagnostic = typeof body?.error?.message === 'string' ? body.error.message : ''
      const message = diagnostic && diagnostic !== summary
        ? `${summary}\n${translate(language, 'diagnostics')}: ${diagnostic}`
        : summary
      throw new DashboardRequestError(
        message,
        { code, diagnostic, status: response.status },
      )
    }
    if (path === '/snapshot') this.snapshotEtag = response.headers.get('etag') ?? ''
    return body
  }
}
