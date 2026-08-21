import { randomBytes } from 'node:crypto'

import type { IncomingMessage, ServerResponse } from 'node:http'

const SESSION_TTL_MS = 30 * 60_000
const COOKIE_NAME = 'tokenless_dashboard_session'

type DashboardSession = {
  id: string
  csrf: string
  expiresAt: number
}

export class DashboardSessionManager {
  private readonly sessions = new Map<string, DashboardSession>()

  ensureSession(request: IncomingMessage, response: ServerResponse) {
    this.prune()
    const id = parseCookie(request.headers.cookie ?? '')[COOKIE_NAME]
    const existing = id ? this.sessions.get(id) : undefined
    if (existing && existing.expiresAt > Date.now()) return existing
    const session: DashboardSession = {
      id: secret(),
      csrf: secret(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    }
    this.sessions.set(session.id, session)
    response.setHeader('set-cookie', serializeCookie(session))
    return session
  }

  requireSession(request: IncomingMessage) {
    this.prune()
    const id = parseCookie(request.headers.cookie ?? '')[COOKIE_NAME]
    const session = id ? this.sessions.get(id) : undefined
    if (!session || session.expiresAt <= Date.now()) {
      throw dashboardAuthError('dashboard_session_required', 'Open the local Dashboard again to start a new session.', 401)
    }
    return session
  }

  requireMutation(request: IncomingMessage, expectedOrigin: string) {
    const session = this.requireSession(request)
    if (request.headers.origin !== expectedOrigin) {
      throw dashboardAuthError('dashboard_origin_rejected', 'The request origin is not allowed.', 403)
    }
    const csrf = request.headers['x-tokenless-csrf']
    const value = Array.isArray(csrf) ? csrf[0] : csrf
    if (!value || value !== session.csrf) {
      throw dashboardAuthError('dashboard_csrf_rejected', 'The request CSRF token is invalid.', 403)
    }
    return session
  }

  private prune() {
    const now = Date.now()
    for (const [id, value] of this.sessions) {
      if (value.expiresAt <= now) this.sessions.delete(id)
    }
  }
}

function serializeCookie(session: DashboardSession) {
  const maxAge = Math.floor((session.expiresAt - Date.now()) / 1000)
  return `${COOKIE_NAME}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

function parseCookie(value: string) {
  return Object.fromEntries(value.split(';').flatMap((part) => {
    const separator = part.indexOf('=')
    if (separator < 1) return []
    return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]]
  }))
}

function secret() {
  return randomBytes(32).toString('base64url')
}

function dashboardAuthError(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}
