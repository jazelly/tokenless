import { randomBytes } from 'node:crypto'

import type { IncomingMessage, ServerResponse } from 'node:http'

const TICKET_TTL_MS = 60_000
const SESSION_TTL_MS = 30 * 60_000
const COOKIE_NAME = 'tokenless_ui_session'

type Ticket = {
  expiresAt: number
  profileId: string | null
}

type UiSession = {
  id: string
  csrf: string
  expiresAt: number
  initialProfileId: string | null
}

export class UiSessionManager {
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, UiSession>()

  mintTicket(origin: string, profileId?: string | null) {
    this.prune()
    const ticket = secret()
    const expiresAt = Date.now() + TICKET_TTL_MS
    this.tickets.set(ticket, { expiresAt, profileId: profileId ?? null })
    return {
      ticket,
      bootstrapUrl: `${origin}/ui/bootstrap?ticket=${encodeURIComponent(ticket)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  consumeTicket(ticket: string, response: ServerResponse) {
    this.prune()
    const stored = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (!stored || stored.expiresAt <= Date.now()) return null
    const session: UiSession = {
      id: secret(),
      csrf: secret(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      initialProfileId: stored.profileId,
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
      throw uiAuthError('ui_session_required', 'Open the dashboard again from the Tokenless CLI.', 401)
    }
    return session
  }

  requireMutation(request: IncomingMessage, expectedOrigin: string) {
    const session = this.requireSession(request)
    if (request.headers.origin !== expectedOrigin) {
      throw uiAuthError('ui_origin_rejected', 'The request origin is not allowed.', 403)
    }
    const csrf = request.headers['x-tokenless-csrf']
    const value = Array.isArray(csrf) ? csrf[0] : csrf
    if (!value || value !== session.csrf) {
      throw uiAuthError('ui_csrf_rejected', 'The request CSRF token is invalid.', 403)
    }
    return session
  }

  private prune() {
    const now = Date.now()
    for (const [ticket, value] of this.tickets) {
      if (value.expiresAt <= now) this.tickets.delete(ticket)
    }
    for (const [id, value] of this.sessions) {
      if (value.expiresAt <= now) this.sessions.delete(id)
    }
  }
}

function serializeCookie(session: UiSession) {
  const maxAge = Math.floor((session.expiresAt - Date.now()) / 1000)
  return `${COOKIE_NAME}=${session.id}; HttpOnly; SameSite=Strict; Path=/ui-api/v1; Max-Age=${maxAge}`
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

function uiAuthError(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}
