import { randomUUID } from 'node:crypto'
import { tokenlessError } from '../../browser/errors.js'
import type { BrowserContext, Page } from 'playwright-core'
import type { Cookie } from 'impers'

const PERPLEXITY_ORIGIN = 'https://www.perplexity.ai'
const QUERY_URL = `${PERPLEXITY_ORIGIN}/rest/sse/perplexity_ask`

export type DirectPerplexityResult = {
  text: string
  citations: readonly []
}

type BrowserSessionBridge = {
  userAgent: string
  language: string
  timezone: string
  cookies: Cookie[]
}

export async function sendDirectPerplexityMessage(options: {
  page: Page
  browserContext: BrowserContext
  prompt: string
  proxy?: string | undefined
  signal: AbortSignal
}): Promise<DirectPerplexityResult> {
  assertNotAborted(options.signal)
  let bridge: BrowserSessionBridge
  try {
    bridge = await bootstrapBrowserSession(options.page, options.browserContext)
  } catch (error) {
    if (isSafeDirectError(error)) throw error
    throw tokenlessError(
      'direct_session_bridge_failed',
      'The selected Perplexity browser session could not be read without exposing session material.',
    )
  }
  try {
    return await requestDirectPerplexityResponse({
      bridge,
      prompt: options.prompt,
      proxy: options.proxy,
      signal: options.signal,
    })
  } catch (error) {
    if (isSafeDirectError(error)) throw error
    throw tokenlessError(
      'direct_transport_failed',
      'Perplexity direct protocol transport failed without exposing provider session material.',
    )
  }
}

async function bootstrapBrowserSession(page: Page, browserContext: BrowserContext): Promise<BrowserSessionBridge> {
  const pageUrl = new URL(page.url())
  if (pageUrl.origin !== PERPLEXITY_ORIGIN) {
    throw tokenlessError('direct_session_origin_invalid', 'Perplexity direct execution requires a current www.perplexity.ai page.')
  }
  const browserValues = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    language: navigator.language || 'en-US',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }))
  const providerCookies = await browserContext.cookies([`${PERPLEXITY_ORIGIN}/`])
  return {
    ...browserValues,
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

async function requestDirectPerplexityResponse(options: {
  bridge: BrowserSessionBridge
  prompt: string
  proxy?: string | undefined
  signal: AbortSignal
}): Promise<DirectPerplexityResult> {
  const { Session } = await import('impers')
  const requestId = randomUUID()
  const headers = {
    accept: 'text/event-stream',
    'accept-language': `${options.bridge.language},en;q=0.8`,
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    origin: PERPLEXITY_ORIGIN,
    referer: `${PERPLEXITY_ORIGIN}/`,
    'user-agent': options.bridge.userAgent,
    'x-perplexity-request-reason': 'perplexity-query-state-provider',
    'x-request-id': requestId,
  }
  const session = new Session({
    baseUrl: PERPLEXITY_ORIGIN,
    impersonate: 'chrome',
    defaultHeaders: false,
    headers,
    cookies: options.bridge.cookies,
    ...(options.proxy ? { proxy: options.proxy } : {}),
  })
  try {
    const accumulator = new PerplexitySseTextAccumulator()
    const response = await session.post(QUERY_URL, {
      allowRedirects: false,
      json: {
        params: {
          attachments: [],
          language: options.bridge.language,
          timezone: options.bridge.timezone,
          search_focus: 'internet',
          sources: ['web'],
          search_recency_filter: null,
          frontend_uuid: randomUUID(),
          mode: 'copilot',
          model_preference: 'turbo',
          is_related_query: false,
          is_sponsored: false,
          frontend_context_uuid: randomUUID(),
          prompt_source: 'user',
          query_source: 'home',
          is_incognito: false,
          local_search_enabled: false,
          use_schematized_api: true,
          send_back_text_in_streaming_api: false,
          supported_block_use_cases: ['diff_blocks'],
          client_coordinates: null,
          mentions: [],
          dsl_query: options.prompt,
          skip_search_enabled: true,
          is_nav_suggestions_disabled: false,
          source: 'default',
          always_search_override: false,
          override_no_search: false,
          should_ask_for_mcp_tool_confirmation: true,
          browser_agent_allow_once_from_toggle: false,
          force_enable_browser_agent: false,
          supported_features: ['browser_agent_permission_banner_v1.1'],
          version: '2.18',
        },
        query_str: options.prompt,
      },
      headers,
      signal: options.signal,
      stream: true,
      contentCallback: (chunk) => accumulator.push(chunk),
    })
    assertProviderResponse(response.status)
    accumulator.finish()
    await response.close()
    if (accumulator.failed()) {
      throw tokenlessError('direct_response_failed', 'Perplexity direct protocol returned a stream error.')
    }
    const text = accumulator.text().slice(0, 32_000)
    if (!text) {
      throw tokenlessError('direct_response_empty', 'Perplexity direct protocol completed without a text response.')
    }
    return { text, citations: [] }
  } finally {
    await session.close().catch(() => undefined)
  }
}

class PerplexitySseTextAccumulator {
  private decoder = new TextDecoder()
  private buffered = ''
  private output = ''
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
    return this.output.trim()
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
    const blocks = Array.isArray(event.blocks) ? event.blocks : []
    for (const block of blocks) {
      if (!isRecord(block)) continue
      const diffBlock = isRecord(block.diff_block) ? block.diff_block : null
      if (!diffBlock || diffBlock.field !== 'markdown_block' || !Array.isArray(diffBlock.patches)) continue
      for (const patch of diffBlock.patches) {
        if (!isRecord(patch) || typeof patch.path !== 'string' || patch.path.startsWith('/goals')) continue
        const value = isRecord(patch.value) ? patch.value.answer : patch.value
        if (typeof value !== 'string' || !value) continue
        if (value.startsWith(this.output)) {
          this.output += value.slice(this.output.length)
        } else if (!this.output.endsWith(value)) {
          this.output += value
        }
      }
    }
  }
}

function assertProviderResponse(status: number) {
  if (status >= 200 && status < 300) return
  throw tokenlessError(
    status === 401 || status === 403 ? 'direct_session_rejected' : 'direct_provider_request_failed',
    `Perplexity direct protocol query request failed with status ${status}.`,
  )
}

function isSafeDirectError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('direct_')
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw tokenlessError('direct_request_canceled', 'Perplexity direct protocol request was canceled.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
