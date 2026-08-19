import {
  parseCapabilityDocument,
  parseStartTurnRequest,
  parseTurnState,
} from './validation.js'
import type { CapabilityDocument, StartTurnRequest, TurnState } from './contracts.js'

const PRIVATE_PROVIDER_TURN_PATH = '/v1/private/provider-turn'

export type LocalHttpClientOptions = {
  baseUrl: string
  token: string
}

export type LocalHttpBinding = {
  providerBindingRef: string
  capabilities: CapabilityDocument
}

export type LocalHttpAttachment = {
  attachmentRef: string
  mediaType: 'text/markdown'
  byteLength: number
  sha256: string
}

/** A strictly bounded outcome for cancelling a durable request intent. */
export type LocalHttpRequestCancellation =
  | { kind: 'cancelled_before_start' }
  | { kind: 'turn'; turn: LocalHttpRequestCancellationTurn }

type LocalHttpRequestCancellationIdentity = {
  turnRef: string
  conversationRef: string
}

export type LocalHttpRequestCancellationTurn =
  | (LocalHttpRequestCancellationIdentity & {
    lifecycle: 'cancelled'
    dispatchCertainty: 'not_dispatched'
    attachmentDeliveryStatus: 'pending'
  })
  | (LocalHttpRequestCancellationIdentity & {
    lifecycle: 'cancelled'
    dispatchCertainty: 'dispatched' | 'ambiguous'
    attachmentDeliveryStatus: 'delivered'
  })

/** Browser-independent local control-plane client. Callers supply credentials and bytes explicitly. */
export function createLocalHttpClient(options: LocalHttpClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  if (typeof options.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) throw new TypeError('token must be a bounded bearer-safe value.')
  const request = globalThis.fetch
  if (typeof request !== 'function') throw new TypeError('fetch is unavailable.')
  const call = async (pathname: string, init: RequestInit = {}) => {
    const response = await request(`${baseUrl}${pathname}`, {
      ...init,
      headers: { authorization: `Bearer ${options.token}`, ...(init.headers ?? {}) },
    })
    const value = await response.json().catch(() => null) as unknown
    if (!response.ok) throw new LocalHttpError(response.status, safeError(value))
    return value
  }
  return {
    async bind(provider: string, profileId: string): Promise<LocalHttpBinding> {
      return parseBinding(await call(`${PRIVATE_PROVIDER_TURN_PATH}/bindings`, jsonPost({ provider, profileId })))
    },
    async capabilities(providerBindingRef: string): Promise<LocalHttpBinding> {
      return parseBinding(await call(`${PRIVATE_PROVIDER_TURN_PATH}/bindings/${encodeURIComponent(bindingRef(providerBindingRef, 'providerBindingRef'))}/capabilities`))
    },
    async stage(
      providerBindingRef: string,
      bytes: Uint8Array,
      options?: { name?: string | undefined; bundleWith?: string | undefined },
    ): Promise<LocalHttpAttachment> {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new TypeError('bytes must be a nonempty Uint8Array.')
      const name = options?.name ?? 'system-prompt.md'
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new TypeError('attachment name is invalid.')
      const bundleWith = options?.bundleWith === undefined ? undefined : attachmentRefValue(options.bundleWith)
      const value = await call(`${PRIVATE_PROVIDER_TURN_PATH}/bindings/${encodeURIComponent(bindingRef(providerBindingRef, 'providerBindingRef'))}/attachments`, {
        method: 'POST',
        body: bytes as unknown as BodyInit,
        headers: {
          'content-type': 'text/markdown',
          'x-tokenless-attachment-name': name,
          ...(bundleWith === undefined ? {} : { 'x-tokenless-bundle-with': bundleWith }),
        },
      })
      return parseAttachment(value)
    },
    async start(providerBindingRef: string, requestValue: unknown): Promise<TurnState> {
      const start = parseStartTurnRequest(requestValue)
      if (start.providerBindingRef !== providerBindingRef) throw new TypeError('request providerBindingRef does not match the route.')
      return parseTurnEnvelope(await call(`${PRIVATE_PROVIDER_TURN_PATH}/bindings/${encodeURIComponent(bindingRef(providerBindingRef, 'providerBindingRef'))}/turns`, jsonPost(start)))
    },
    async continue(providerBindingRef: string, requestValue: unknown): Promise<TurnState> {
      const start = parseStartTurnRequest(requestValue)
      if (start.conversation.mode !== 'continue') throw new TypeError('request must be a continuation.')
      if (start.providerBindingRef !== providerBindingRef) throw new TypeError('request providerBindingRef does not match the route.')
      return parseTurnEnvelope(await call(`${PRIVATE_PROVIDER_TURN_PATH}/bindings/${encodeURIComponent(bindingRef(providerBindingRef, 'providerBindingRef'))}/turns`, jsonPost(start)))
    },
    async read(turnRef: string): Promise<TurnState> {
      return parseTurnEnvelope(await call(`${PRIVATE_PROVIDER_TURN_PATH}/turns/${encodeURIComponent(turnRefValue(turnRef))}`))
    },
    async cancel(turnRef: string): Promise<TurnState> {
      return parseTurnEnvelope(await call(`${PRIVATE_PROVIDER_TURN_PATH}/turns/${encodeURIComponent(turnRefValue(turnRef))}/cancel`, jsonPost({})))
    },
    async resume(turnRef: string): Promise<TurnState> {
      return parseTurnEnvelope(await call(`${PRIVATE_PROVIDER_TURN_PATH}/turns/${encodeURIComponent(turnRefValue(turnRef))}/resume`, jsonPost({})))
    },
    async cancelRequest(requestRef: string): Promise<LocalHttpRequestCancellation> {
      return parseRequestCancellation(await call(`${PRIVATE_PROVIDER_TURN_PATH}/requests/${encodeURIComponent(requestRefValue(requestRef))}/cancel`, jsonPost({})))
    },
  }
}

export class LocalHttpError extends Error {
  constructor(readonly status: number, readonly error: { code: string; message: string; retryable: boolean } | null) {
    super(`Local Web AI HTTP request failed with status ${status}.`)
    this.name = 'LocalHttpError'
  }
}

function jsonPost(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('baseUrl must be a loopback HTTP origin.')
  }
  return url.origin
}

function bindingRef(value: string, field: string) {
  if (typeof value !== 'string' || !/^binding:[a-f0-9]{32}$/.test(value)) throw new TypeError(`${field} is invalid.`)
  return value
}

function turnRefValue(value: string) {
  if (typeof value !== 'string' || !/^turn:[a-f0-9]{32}$/.test(value)) throw new TypeError('turnRef is invalid.')
  return value
}

function requestRefValue(value: string) {
  if (typeof value !== 'string' || !/^request:[a-f0-9]{32}$/.test(value)) throw new TypeError('requestRef is invalid.')
  return value
}

function attachmentRefValue(value: string) {
  if (typeof value !== 'string' || !/^attachment:[a-f0-9]{32}$/.test(value)) throw new TypeError('attachmentRef is invalid.')
  return value
}

function parseBinding(value: unknown): LocalHttpBinding {
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.providerBindingRef !== 'string') throw new TypeError('Invalid local binding envelope.')
  return { providerBindingRef: bindingRef(value.providerBindingRef, 'providerBindingRef'), capabilities: parseCapabilityDocument(value.capabilities) }
}

function parseAttachment(value: unknown): LocalHttpAttachment {
  if (!isRecord(value) || !isRecord(value.attachment) || Object.keys(value).length !== 1) throw new TypeError('Invalid local attachment envelope.')
  const attachment = value.attachment
  if (Object.keys(attachment).length !== 4 || typeof attachment.attachmentRef !== 'string' || attachment.mediaType !== 'text/markdown' || typeof attachment.byteLength !== 'number' || !Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 1 || !/^[a-f0-9]{64}$/.test(String(attachment.sha256))) throw new TypeError('Invalid local attachment.')
  if (!/^attachment:[a-f0-9]{32}$/.test(attachment.attachmentRef)) throw new TypeError('Invalid local attachment reference.')
  return attachment as LocalHttpAttachment
}

function parseTurnEnvelope(value: unknown): TurnState {
  if (!isRecord(value) || Object.keys(value).length !== 1) throw new TypeError('Invalid local turn envelope.')
  return parseTurnState(value.turn)
}

function parseRequestCancellation(value: unknown): LocalHttpRequestCancellation {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new TypeError('Invalid local request cancellation envelope.')
  if (value.kind === 'cancelled_before_start' && Object.keys(value).length === 1) return { kind: 'cancelled_before_start' }
  if (value.kind === 'turn' && Object.keys(value).length === 2) return { kind: 'turn', turn: parseRequestCancellationTurn(value.turn) }
  throw new TypeError('Invalid local request cancellation envelope.')
}

function parseRequestCancellationTurn(value: unknown): LocalHttpRequestCancellationTurn {
  if (!isRecord(value) || Object.keys(value).length !== 5 ||
    typeof value.turnRef !== 'string' || typeof value.conversationRef !== 'string' ||
    typeof value.lifecycle !== 'string' || typeof value.dispatchCertainty !== 'string' ||
    typeof value.attachmentDeliveryStatus !== 'string') {
    throw new TypeError('Invalid local request cancellation turn.')
  }
  const turnRef = turnRefValue(value.turnRef)
  if (!/^conversation:[a-f0-9]{32}$/.test(value.conversationRef) || value.lifecycle !== 'cancelled') {
    throw new TypeError('Invalid local request cancellation turn.')
  }
  if (value.dispatchCertainty === 'not_dispatched' && value.attachmentDeliveryStatus === 'pending') {
    return { turnRef, conversationRef: value.conversationRef, lifecycle: 'cancelled', dispatchCertainty: 'not_dispatched', attachmentDeliveryStatus: 'pending' }
  }
  if ((value.dispatchCertainty === 'dispatched' || value.dispatchCertainty === 'ambiguous') && value.attachmentDeliveryStatus === 'delivered') {
    return { turnRef, conversationRef: value.conversationRef, lifecycle: 'cancelled', dispatchCertainty: value.dispatchCertainty, attachmentDeliveryStatus: 'delivered' }
  }
  throw new TypeError('Invalid local request cancellation turn.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}

function safeError(value: unknown) {
  const error = isRecord(value) && isRecord(value.error) ? value.error : value
  if (!isRecord(error) || typeof error.code !== 'string') return { code: 'local_http_error', message: 'The local daemon rejected the request.', retryable: false }
  const known = new Map<string, { message: string; retryable: boolean }>([
    ['invalid_input', { message: 'The local daemon rejected the request.', retryable: false }],
    ['control_auth_missing', { message: 'Local daemon authentication is required.', retryable: false }],
    ['control_auth_rejected', { message: 'Local daemon authentication was rejected.', retryable: false }],
    ['daemon_starting', { message: 'The local daemon is still starting.', retryable: true }],
    ['web_ai_request_ref_conflict', { message: 'The request reference is already bound to a different request.', retryable: false }],
    ['web_ai_request_cancelled', { message: 'The request reference was cancelled before a turn could be created.', retryable: false }],
  ])
  const mapped = known.get(error.code)
  return mapped ? { code: error.code, ...mapped } : { code: 'local_http_error', message: 'The local daemon rejected the request.', retryable: false }
}
