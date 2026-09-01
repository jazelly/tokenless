import { randomUUID } from 'node:crypto'
import { tokenlessError } from '../../browser/errors.js'
import { createChatGptProofToken } from './proof-of-work.js'
import type { BrowserContext, Page } from 'playwright-core'
import type { Cookie } from 'impers'

const CHATGPT_ORIGIN = 'https://chatgpt.com'
const PREPARE_URL = `${CHATGPT_ORIGIN}/backend-api/f/conversation/prepare`
const REQUIREMENTS_URL = `${CHATGPT_ORIGIN}/backend-api/sentinel/chat-requirements`
const CONVERSATION_URL = `${CHATGPT_ORIGIN}/backend-api/f/conversation`

export type DirectChatGptResult = {
  text: string
  citations: readonly []
}

export type ChatGptBrowserSession = {
  accessToken: string
  userAgent: string
  language: string
  timezone: string
  timezoneOffsetMinutes: number
  cookies: Cookie[]
}

type BrowserSessionBridge = ChatGptBrowserSession

export async function sendDirectChatGptMessage(options: {
  page: Page
  browserContext: BrowserContext
  prompt: string
  proxy?: string | undefined
  signal: AbortSignal
}): Promise<DirectChatGptResult> {
  assertNotAborted(options.signal)
  let bridge: BrowserSessionBridge
  try {
    bridge = await readChatGptBrowserSession(options.page, options.browserContext)
  } catch (error) {
    if (isSafeDirectError(error)) throw error
    throw tokenlessError(
      'direct_session_bridge_failed',
      'The selected ChatGPT browser session could not be read without exposing session material.',
    )
  }
  try {
    return await requestDirectChatGptResponse({
      bridge,
      prompt: options.prompt,
      proxy: options.proxy,
      signal: options.signal,
    })
  } catch (error) {
    if (isSafeDirectError(error)) throw error
    throw tokenlessError(
      'direct_transport_failed',
      'ChatGPT direct protocol transport failed without exposing provider session material.',
    )
  }
}

export async function readChatGptBrowserSession(page: Page, browserContext: BrowserContext): Promise<ChatGptBrowserSession> {
  const pageUrl = new URL(page.url())
  if (pageUrl.origin !== CHATGPT_ORIGIN) {
    throw tokenlessError('direct_session_origin_invalid', 'ChatGPT direct execution requires a current chatgpt.com page.')
  }
  const browserValues = await page.evaluate(async () => {
    const findAccessToken = (root: unknown): string | null => {
      const seen = new WeakSet<object>()
      const visit = (value: unknown, depth: number): string | null => {
        if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return null
        seen.add(value)
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (key === 'accessToken' && typeof child === 'string' && child.length > 20) return child
          const nested = visit(child, depth + 1)
          if (nested) return nested
        }
        return null
      }
      return visit(root, 0)
    }

    let accessToken: string | null = null
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' })
      if (response.ok) accessToken = findAccessToken(await response.json())
    } catch {
      // The in-page Remix state remains the only fallback and never leaves this provider page.
    }
    accessToken ??= findAccessToken((window as Window & { __remixContext?: unknown }).__remixContext)
    return {
      accessToken,
      userAgent: navigator.userAgent,
      language: navigator.language || 'en-US',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    }
  })
  if (!browserValues.accessToken) {
    throw tokenlessError(
      'direct_session_unavailable',
      'The selected ChatGPT browser page does not expose an authenticated session. Sign in manually, then retry.',
    )
  }
  const providerCookies = await browserContext.cookies([`${CHATGPT_ORIGIN}/`])
  if (providerCookies.length === 0) {
    throw tokenlessError('direct_session_unavailable', 'The selected ChatGPT browser profile has no chatgpt.com session cookies.')
  }
  return {
    accessToken: browserValues.accessToken,
    userAgent: browserValues.userAgent,
    language: browserValues.language,
    timezone: browserValues.timezone,
    timezoneOffsetMinutes: browserValues.timezoneOffsetMinutes,
    cookies: providerCookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(cookie.expires > 0 ? { expires: new Date(cookie.expires * 1000) } : {}),
      ...(cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax' || cookie.sameSite === 'None'
        ? { sameSite: cookie.sameSite }
        : {}),
    })),
  }
}

async function requestDirectChatGptResponse(options: {
  bridge: BrowserSessionBridge
  prompt: string
  proxy?: string | undefined
  signal: AbortSignal
}): Promise<DirectChatGptResult> {
  const { Session } = await import('impers')
  const headers = {
    accept: '*/*',
    'accept-language': `${options.bridge.language},en;q=0.8`,
    authorization: `Bearer ${options.bridge.accessToken}`,
    origin: CHATGPT_ORIGIN,
    referer: `${CHATGPT_ORIGIN}/`,
    'user-agent': options.bridge.userAgent,
  }
  const session = new Session({
    baseUrl: CHATGPT_ORIGIN,
    impersonate: 'chrome',
    defaultHeaders: false,
    headers,
    cookies: options.bridge.cookies,
    ...(options.proxy ? { proxy: options.proxy } : {}),
  })
  try {
    const parentMessageId = randomUUID()
    const baseRequest = {
      action: 'next',
      parent_message_id: parentMessageId,
      model: 'auto',
      timezone_offset_min: options.bridge.timezoneOffsetMinutes,
      timezone: options.bridge.timezone,
      conversation_mode: { kind: 'primary_assistant' },
      system_hints: [],
      supports_buffering: true,
      supported_encodings: ['v1'],
    }
    const prepare = await session.post(PREPARE_URL, {
      allowRedirects: false,
      json: { ...baseRequest, fork_from_shared_post: false },
      headers: { ...headers, 'content-type': 'application/json' },
      signal: options.signal,
    })
    assertProviderResponse(prepare.status, 'prepare')
    const conduitToken = requiredResponseString(prepare.json<unknown>(), 'conduit_token', 'prepare')
    await prepare.close()

    const requirements = await session.post(REQUIREMENTS_URL, {
      allowRedirects: false,
      json: { p: null },
      headers: { ...headers, 'content-type': 'application/json' },
      signal: options.signal,
    })
    assertProviderResponse(requirements.status, 'requirements')
    const requirementsBody = requiredRecord(requirements.json<unknown>(), 'requirements')
    await requirements.close()
    const requirementsToken = requiredResponseString(requirementsBody, 'token', 'requirements')
    const proof = proofRequirement(requirementsBody.proofofwork)
    const proofToken = createChatGptProofToken(proof, options.bridge.userAgent)

    const accumulator = new ChatGptSseTextAccumulator()
    const response = await session.post(CONVERSATION_URL, {
      allowRedirects: false,
      json: {
        ...baseRequest,
        enable_message_followups: true,
        messages: [{
          id: randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [options.prompt] },
          metadata: { serialization_metadata: { custom_symbol_offsets: [] } },
          create_time: Date.now() / 1000,
        }],
      },
      headers: {
        ...headers,
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'openai-sentinel-chat-requirements-token': requirementsToken,
        'x-conduit-token': conduitToken,
        ...(proofToken ? { 'openai-sentinel-proof-token': proofToken } : {}),
      },
      signal: options.signal,
      stream: true,
      contentCallback: (chunk) => accumulator.push(chunk),
    })
    assertProviderResponse(response.status, 'conversation')
    accumulator.finish()
    await response.close()
    if (accumulator.failed()) {
      throw tokenlessError('direct_response_failed', 'ChatGPT direct protocol returned a stream error.')
    }
    const text = accumulator.text().slice(0, 32_000)
    if (!text) {
      throw tokenlessError('direct_response_empty', 'ChatGPT direct protocol completed without a text response.')
    }
    return { text, citations: [] }
  } finally {
    await session.close().catch(() => undefined)
  }
}

class ChatGptSseTextAccumulator {
  private decoder = new TextDecoder()
  private buffered = ''
  private output = ''
  private recipient = 'all'
  private path: string | null = null
  private streamFailed = false

  push(chunk: Buffer) {
    this.buffered += this.decoder.decode(chunk, { stream: true })
    this.consumeCompleteLines()
  }

  finish() {
    this.buffered += this.decoder.decode()
    this.consumeCompleteLines(true)
  }

  text() {
    return this.output.replace(/[\ue203\ue204\ue206]/gu, '').trim()
  }

  failed() {
    return this.streamFailed
  }

  private consumeCompleteLines(flush = false) {
    const lines = this.buffered.split(/\r?\n/u)
    const trailing = lines.pop() ?? ''
    this.buffered = flush ? '' : trailing
    for (const line of lines) this.consumeLine(line)
    if (flush && trailing) this.consumeLine(trailing)
  }

  private consumeLine(line: string) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return
    let event: unknown
    try {
      event = JSON.parse(line.slice(6))
    } catch {
      return
    }
    if (!isRecord(event)) return
    if (event.error) {
      this.streamFailed = true
      return
    }
    if (typeof event.p === 'string') this.path = event.p
    if (this.path?.startsWith('/message/content/thoughts')) return
    const value = event.v
    if (typeof value === 'string') {
      if (this.recipient === 'all' && (event.p === undefined || event.p === '/message/content/parts/0')) {
        this.output += value
      }
      return
    }
    if (Array.isArray(value)) {
      for (const patch of value) {
        if (isRecord(patch) && patch.p === '/message/content/parts/0' && typeof patch.v === 'string' && this.recipient === 'all') {
          this.output += patch.v
        }
      }
      return
    }
    if (!isRecord(value)) return
    const message = isRecord(value.message) ? value.message : null
    if (!message) return
    if (typeof message.recipient === 'string') this.recipient = message.recipient
    if (this.recipient !== 'all' || !isRecord(message.author) || message.author.role !== 'assistant') return
    const content = isRecord(message.content) ? message.content : null
    if (!content || !Array.isArray(content.parts)) return
    const initialText = content.parts.filter((part): part is string => typeof part === 'string').join('')
    if (initialText && !this.output) this.output = initialText
  }
}

function proofRequirement(value: unknown) {
  if (value === undefined) return { required: false }
  if (!isRecord(value) || typeof value.required !== 'boolean') {
    throw tokenlessError('direct_requirements_invalid', 'ChatGPT direct protocol returned invalid proof-of-work requirements.')
  }
  return {
    required: value.required,
    ...(typeof value.seed === 'string' ? { seed: value.seed } : {}),
    ...(typeof value.difficulty === 'string' ? { difficulty: value.difficulty } : {}),
  }
}

function assertProviderResponse(status: number, stage: string) {
  if (status >= 200 && status < 300) return
  throw tokenlessError(
    status === 401 || status === 403 ? 'direct_session_rejected' : 'direct_provider_request_failed',
    `ChatGPT direct protocol ${stage} request failed with status ${status}.`,
  )
}

function requiredResponseString(value: unknown, field: string, stage: string) {
  const record = requiredRecord(value, stage)
  if (typeof record[field] !== 'string' || !record[field]) {
    throw tokenlessError('direct_provider_response_invalid', `ChatGPT direct protocol ${stage} response is invalid.`)
  }
  return record[field]
}

function requiredRecord(value: unknown, stage: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw tokenlessError('direct_provider_response_invalid', `ChatGPT direct protocol ${stage} response is invalid.`)
  }
  return value
}

function isSafeDirectError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('direct_')
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw tokenlessError('direct_request_canceled', 'ChatGPT direct protocol request was canceled.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
