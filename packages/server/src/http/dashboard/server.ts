import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasConfiguredTokenlessLanguage, readTokenlessConfig } from '../../persistence/config.js'
import { TokenlessApplicationServices } from '../../application/services.js'
import type {
  DashboardConfigUpdate,
  DashboardConfirmedDeletion,
  DashboardProfileCreate,
  DashboardProfileUpdate,
  DashboardProviderSelection,
  DashboardSetupInput,
} from 'tokenless-internal-shared/dashboard'
import { DaemonError, daemonErrorCodeRetryable, daemonErrorStatus } from '../../errors.js'
import { DashboardSessionManager } from './session.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

type DashboardServerOptions = {
  services: TokenlessApplicationServices
  sessions: DashboardSessionManager
  origin: () => string
  resolveHarnessRunHandler?: () => Promise<DashboardHarnessRunHandler | undefined>
}

type DashboardHarnessRunHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
) => Promise<boolean>

const DASHBOARD_ROOT = fileURLToPath(new URL('../../../dashboard/', import.meta.url))

export class TokenlessDashboardServer {
  private readonly services: TokenlessApplicationServices
  private readonly sessions: DashboardSessionManager
  private readonly origin: () => string
  private readonly resolveHarnessRunHandler: (() => Promise<DashboardHarnessRunHandler | undefined>) | undefined

  constructor(options: DashboardServerOptions) {
    this.services = options.services
    this.sessions = options.sessions
    this.origin = options.origin
    this.resolveHarnessRunHandler = options.resolveHarnessRunHandler
  }

  dashboardUrl(profileId?: string | null, jobId?: string | null) {
    const url = new URL(jobId ? '/dashboard/jobs/' : '/dashboard/overview/', this.origin())
    if (profileId) url.searchParams.set('profile', profileId)
    if (jobId) url.searchParams.set('job', jobId)
    return url.toString()
  }

  redirectToDashboard(request: IncomingMessage, response: ServerResponse) {
    this.requireOrigin(request)
    this.sessions.ensureSession(request, response)
    this.securityHeaders(response)
    response.writeHead(303, { location: '/dashboard/overview/' })
    response.end()
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    const requestOrigin = this.requireOrigin(request)
    const method = request.method ?? 'GET'
    if (method === 'GET' && isDashboardPagePath(url.pathname)) {
      this.sessions.ensureSession(request, response)
      const language = await this.initialLanguage(request)
      const shellMessages = DASHBOARD_SHELL_MESSAGES[language]
      const template = await fs.readFile(path.join(DASHBOARD_ROOT, 'index.html'), 'utf8')
      const body = template
        .replaceAll('__TOKENLESS_LANG__', language)
        .replaceAll('__TOKENLESS_TITLE__', shellMessages.title)
        .replaceAll('__TOKENLESS_SKIP__', shellMessages.skip)
        .replaceAll('__TOKENLESS_LANGUAGE_LABEL__', shellMessages.language)
        .replaceAll('__TOKENLESS_EN_SELECTED__', language === 'en' ? 'selected' : '')
        .replaceAll('__TOKENLESS_ZH_SELECTED__', language === 'zh-CN' ? 'selected' : '')
      this.writeAsset(response, 200, body, 'text/html; charset=utf-8')
      return
    }
    if (method === 'GET' && url.pathname === '/dashboard/styles.css') {
      this.writeAsset(response, 200, await fs.readFile(path.join(DASHBOARD_ROOT, 'styles.css')), 'text/css; charset=utf-8')
      return
    }
    if (method === 'GET' && url.pathname === '/dashboard/mark.png') {
      this.writeAsset(response, 200, await fs.readFile(path.join(DASHBOARD_ROOT, 'mark.png')), 'image/png')
      return
    }
    const modulePath = method === 'GET' ? dashboardModulePath(url.pathname) : null
    if (modulePath) {
      try {
        this.writeAsset(response, 200, await fs.readFile(path.join(DASHBOARD_ROOT, modulePath)), 'text/javascript; charset=utf-8')
      } catch (error) {
        if (!isMissingFile(error)) throw error
        this.writeAsset(response, 404, 'Not found.', 'text/plain; charset=utf-8')
      }
      return
    }
    if (url.pathname.startsWith('/dashboard/')) {
      this.writeAsset(response, 404, 'Not found.', 'text/plain; charset=utf-8')
      return true
    }

    if (!url.pathname.startsWith('/dashboard-api/v1/')) return false
    if (url.pathname.startsWith('/dashboard-api/v1/harness/')) {
      if (method === 'GET') this.sessions.requireSession(request)
      else this.sessions.requireMutation(request, requestOrigin)
      const handler = await this.resolveHarnessRunHandler?.()
      if (!handler) {
        this.writeJson(response, 503, { error: { code: 'harness_unavailable', message: 'Harness API is unavailable.' } })
        return true
      }
      const privateUrl = new URL(url.href)
      privateUrl.pathname = url.pathname.replace('/dashboard-api/v1/harness', '/v1/private/agent')
      this.securityHeaders(response)
      if (await handler(request, response, method, privateUrl)) return true
    }
    const session = method === 'GET'
      ? this.sessions.ensureSession(request, response)
      : this.sessions.requireMutation(request, requestOrigin)
    if (method === 'GET' && url.pathname === '/dashboard-api/v1/session') {
      this.writeJson(response, 200, {
        csrf: session.csrf,
        expiresAt: new Date(session.expiresAt).toISOString(),
      })
      return true
    }
    if (method === 'GET' && url.pathname === '/dashboard-api/v1/snapshot') {
      const snapshot = await this.services.snapshot()
      const etag = `"${snapshot.revision}"`
      if (request.headers['if-none-match'] === etag) {
        this.securityHeaders(response)
        response.writeHead(304, { etag, 'cache-control': 'no-store' })
        response.end()
        return true
      }
      this.writeJson(response, 200, snapshot, { etag })
      return true
    }
    const jobMatch = /^\/dashboard-api\/v1\/jobs\/([^/]+)(?:\/(cancel))?$/.exec(url.pathname)
    if (jobMatch && method === 'GET' && !jobMatch[2]) {
      this.writeJson(response, 200, await this.services.job(decodeURIComponent(jobMatch[1] ?? '')))
      return true
    }
    if (jobMatch && method === 'POST' && jobMatch[2] === 'cancel') {
      this.writeJson(response, 200, await this.services.cancelJob(decodeURIComponent(jobMatch[1] ?? '')))
      return true
    }
    if (method === 'PATCH' && url.pathname === '/dashboard-api/v1/config') {
      this.writeJson(response, 200, await this.services.updateConfig(await readJson<DashboardConfigUpdate>(request)))
      return true
    }
    if (method === 'POST' && url.pathname === '/dashboard-api/v1/setup') {
      this.writeJson(response, 200, await this.services.setup(await readJson<DashboardSetupInput>(request)))
      return true
    }
    if (method === 'POST' && url.pathname === '/dashboard-api/v1/output-savings/enable') {
      await requireEmptyJson(request)
      this.writeJson(response, 200, await this.services.enableOutputSavings())
      return true
    }
    if (method === 'POST' && url.pathname === '/dashboard-api/v1/output-savings/disable') {
      await requireEmptyJson(request)
      this.writeJson(response, 200, await this.services.disableOutputSavings())
      return true
    }
    if (method === 'POST' && url.pathname === '/dashboard-api/v1/output-savings/runtime/uninstall') {
      this.writeJson(response, 200, await this.services.uninstallOutputSavings(await readJson<DashboardConfirmedDeletion>(request)))
      return true
    }
    if (method === 'POST' && url.pathname === '/dashboard-api/v1/output-savings/history/clear') {
      this.writeJson(response, 200, await this.services.clearOutputSavings(await readJson<DashboardConfirmedDeletion>(request)))
      return true
    }
    if (method === 'POST' && url.pathname === '/dashboard-api/v1/profiles') {
      this.writeJson(response, 201, await this.services.createProfile(await readJson<DashboardProfileCreate>(request)))
      return true
    }
    const profileMatch = /^\/dashboard-api\/v1\/profiles\/([^/]+)(?:\/(open))?$/.exec(url.pathname)
    if (profileMatch && method === 'PATCH' && !profileMatch[2]) {
      this.writeJson(response, 200, await this.services.updateProfile(
        decodeURIComponent(profileMatch[1] ?? ''),
        await readJson<DashboardProfileUpdate>(request),
      ))
      return true
    }
    if (profileMatch && method === 'DELETE' && !profileMatch[2]) {
      this.writeJson(response, 200, await this.services.removeProfile(decodeURIComponent(profileMatch[1] ?? '')))
      return true
    }
    if (profileMatch && method === 'POST' && profileMatch[2] === 'open') {
      this.writeJson(response, 200, await this.services.openProfile(decodeURIComponent(profileMatch[1] ?? '')))
      return true
    }
    const profileReadinessMatch = /^\/dashboard-api\/v1\/profiles\/([^/]+)\/providers\/actions\/readiness$/.exec(url.pathname)
    if (profileReadinessMatch && method === 'POST') {
      this.writeJson(response, 202, await this.services.refreshProviderReadiness(
        decodeURIComponent(profileReadinessMatch[1] ?? ''),
      ))
      return true
    }
    const providerMatch = /^\/dashboard-api\/v1\/profiles\/([^/]+)\/providers\/([^/]+)\/actions\/(open|readiness|controls)$/.exec(url.pathname)
    if (providerMatch && method === 'POST') {
      this.writeJson(response, 202, await this.services.providerAction(
        decodeURIComponent(providerMatch[1] ?? ''),
        decodeURIComponent(providerMatch[2] ?? ''),
        providerMatch[3] as 'open' | 'readiness' | 'controls',
      ))
      return true
    }
    const selectionMatch = /^\/dashboard-api\/v1\/profiles\/([^/]+)\/providers\/([^/]+)\/selection$/.exec(url.pathname)
    if (selectionMatch && method === 'POST') {
      this.writeJson(response, 202, await this.services.providerSelection(
        decodeURIComponent(selectionMatch[1] ?? ''),
        decodeURIComponent(selectionMatch[2] ?? ''),
        await readJson<DashboardProviderSelection>(request),
      ))
      return true
    }
    if (method === 'POST' && url.pathname === '/dashboard-api/v1/runtime/quiesce') {
      this.writeJson(response, 200, await this.services.quiesceRuntime())
      return true
    }
    this.writeJson(response, 404, { error: { code: 'dashboard_route_not_found', message: 'Not found.' } })
    return true
  }

  writeError(response: ServerResponse, error: unknown) {
    if (error instanceof DaemonError) {
      const status = daemonErrorStatus(error)
      const code = daemonErrorCodeRetryable(error).code
      const safeMessage = ['invalid_input', 'invalid_status', 'job_not_found', 'invalid_job_state'].includes(error.kind)
        ? error.message
        : 'The dashboard request failed.'
      this.writeJson(response, status, { error: { code, message: safeMessage } })
      return
    }
    const value = error as { code?: string, status?: number, message?: string }
    const isPublicError = Number.isInteger(value.status) && (value.status ?? 0) >= 400 && (value.status ?? 0) < 600
    this.writeJson(response, isPublicError ? value.status! : 400, {
      error: {
        code: value.code ?? 'dashboard_request_failed',
        message: isPublicError && value.message ? value.message : 'The dashboard request failed.',
      },
    })
  }

  private async initialLanguage(request: IncomingMessage) {
    if (await hasConfiguredTokenlessLanguage(this.services.store.homeDir)) {
      return (await readTokenlessConfig(this.services.store.homeDir)).language
    }
    const accepted = request.headers['accept-language'] ?? ''
    return /(^|,)\s*zh(?:-|;|,|$)/i.test(accepted) ? 'zh-CN' : 'en'
  }

  private requireOrigin(request: IncomingMessage) {
    const expected = new URL(this.origin())
    const host = (request.headers.host ?? '').toLowerCase()
    const allowedHosts = new Set([expected.host.toLowerCase()])
    if (expected.hostname === '127.0.0.1' || expected.hostname === '[::1]') {
      allowedHosts.add(`localhost${expected.port ? `:${expected.port}` : ''}`)
    } else if (expected.hostname === 'localhost') {
      allowedHosts.add(`127.0.0.1${expected.port ? `:${expected.port}` : ''}`)
    }
    if (!allowedHosts.has(host)) throw dashboardError('dashboard_host_rejected', 'The request Host is not allowed.', 403)
    return `${expected.protocol}//${host}`
  }

  private securityHeaders(response: ServerResponse) {
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader('cache-control', 'no-store')
  }

  private writeAsset(response: ServerResponse, status: number, body: string | Buffer, contentType: string) {
    this.securityHeaders(response)
    response.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  }

  private writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const payload = JSON.stringify(body)
    this.securityHeaders(response)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      ...headers,
    })
    response.end(payload)
  }
}

function isDashboardPagePath(pathname: string) {
  return pathname === '/dashboard'
    || pathname === '/dashboard/'
    || pathname === '/dashboard/setup'
    || pathname === '/dashboard/setup/'
    || /^\/dashboard\/(?:overview|profiles|providers|capabilities|jobs|system)\/?$/.test(pathname)
}

const DASHBOARD_SHELL_MESSAGES = {
  en: {
    title: 'Tokenless local Dashboard',
    skip: 'Skip to content',
    language: 'Language',
  },
  'zh-CN': {
    title: 'Tokenless 本地 Dashboard',
    skip: '跳到主要内容',
    language: '语言',
  },
} as const

function dashboardModulePath(pathname: string) {
  const match = /^\/dashboard\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)\.js$/.exec(pathname)
  return match ? `${match[1]}.js` : null
}

function isMissingFile(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > 1024 * 1024) throw dashboardError('dashboard_body_too_large', 'Request body is too large.', 413)
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {} as T
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw dashboardError('dashboard_json_invalid', 'Request body must be valid JSON.', 400)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw dashboardError('dashboard_json_invalid', 'Request body must be a JSON object.', 400)
  }
  return value as T
}

async function requireEmptyJson(request: IncomingMessage) {
  const value = await readJson<object>(request)
  if (Object.keys(value).length > 0) {
    throw dashboardError('invalid_fields', 'Request contains unsupported fields.', 400)
  }
}

function dashboardError(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}
