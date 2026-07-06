import { getProviderById, listProviders } from './provider-config.js'

export const BRIDGE_PROTOCOL_VERSION = 'tokenless.browser-session-bridge.v1'

export const BRIDGE_ACTIONS = Object.freeze({
  CAPABILITIES: 'capabilities',
  OPEN: 'open',
  SUBMIT: 'submit',
  READ: 'read',
  SNAPSHOT_DOM: 'snapshot_dom',
  SUBMIT_AND_READ: 'submit_and_read',
})

const ACTIONS = new Set(Object.values(BRIDGE_ACTIONS))

export function createBridgeRequest(input = {}) {
  return {
    protocol: BRIDGE_PROTOCOL_VERSION,
    requestId: input.requestId ?? cryptoRandomId(),
    provider: input.provider,
    action: input.action,
    prompt: input.prompt,
    targetUrl: input.targetUrl,
    idempotencyKey: input.idempotencyKey,
    conversation: input.conversation,
    readDelayMs: input.readDelayMs,
    readTimeoutMs: input.readTimeoutMs,
    submitTimeoutMs: input.submitTimeoutMs,
    includeText: input.includeText,
    maxTextChars: input.maxTextChars,
    metadata: input.metadata,
  }
}

export function createBridgeResponse(request, result) {
  return {
    protocol: BRIDGE_PROTOCOL_VERSION,
    requestId: request?.requestId ?? null,
    ok: Boolean(result?.ok),
    provider: request?.provider ?? null,
    action: request?.action ?? null,
    result: result?.ok ? result.result ?? null : null,
    error: result?.ok ? null : normalizeError(result?.error),
  }
}

export function validateBridgeRequest(payload) {
  if (!payload || typeof payload !== 'object') {
    return invalid('invalid_request', 'Bridge request must be an object.')
  }
  if (payload.protocol !== BRIDGE_PROTOCOL_VERSION) {
    return invalid('unsupported_protocol', 'Bridge protocol version is not supported.')
  }
  if (typeof payload.requestId !== 'string' || payload.requestId.trim() === '') {
    return invalid('invalid_request_id', 'Bridge requestId must be a nonempty string.')
  }
  if (!ACTIONS.has(payload.action)) {
    return invalid('unsupported_action', 'Bridge action is not supported.')
  }
  if (payload.action === BRIDGE_ACTIONS.CAPABILITIES) {
    return valid(normalizeRequest(payload))
  }
  const provider = getProviderById(payload.provider)
  if (!provider) {
    return invalid('unsupported_provider', 'Bridge provider is not supported.')
  }
  if (
    (payload.action === BRIDGE_ACTIONS.SUBMIT || payload.action === BRIDGE_ACTIONS.SUBMIT_AND_READ) &&
    (typeof payload.prompt !== 'string' || payload.prompt.trim() === '')
  ) {
    return invalid('invalid_prompt', 'Bridge prompt must be a nonempty string for submit actions.')
  }
  if (payload.readDelayMs !== undefined && (!Number.isFinite(Number(payload.readDelayMs)) || Number(payload.readDelayMs) < 0)) {
    return invalid('invalid_read_delay', 'Bridge readDelayMs must be a nonnegative number.')
  }
  if (payload.readTimeoutMs !== undefined && (!Number.isFinite(Number(payload.readTimeoutMs)) || Number(payload.readTimeoutMs) < 0)) {
    return invalid('invalid_read_timeout', 'Bridge readTimeoutMs must be a nonnegative number.')
  }
  if (payload.submitTimeoutMs !== undefined && (!Number.isFinite(Number(payload.submitTimeoutMs)) || Number(payload.submitTimeoutMs) < 0)) {
    return invalid('invalid_submit_timeout', 'Bridge submitTimeoutMs must be a nonnegative number.')
  }
  if (payload.maxTextChars !== undefined && (!Number.isFinite(Number(payload.maxTextChars)) || Number(payload.maxTextChars) < 0)) {
    return invalid('invalid_max_text_chars', 'Bridge maxTextChars must be a nonnegative number.')
  }
  return valid(normalizeRequest(payload))
}

export function capabilitiesPayload() {
  return {
    protocol: BRIDGE_PROTOCOL_VERSION,
    providers: listProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      homeUrl: provider.homeUrl,
      matchPatterns: [...provider.matchPatterns],
    })),
    actions: [...ACTIONS],
    safety: {
      visibleOnly: true,
      exportsCookies: false,
      callsPrivateProviderApis: false,
      requiresHostPermission: true,
    },
  }
}

function normalizeRequest(payload) {
  return {
    protocol: payload.protocol,
    requestId: payload.requestId,
    provider: payload.provider,
    action: payload.action,
    prompt: payload.prompt,
    targetUrl: payload.targetUrl,
    idempotencyKey: payload.idempotencyKey,
    conversation: payload.conversation,
    readDelayMs: payload.readDelayMs === undefined ? undefined : Number(payload.readDelayMs),
    readTimeoutMs: payload.readTimeoutMs === undefined ? undefined : Number(payload.readTimeoutMs),
    submitTimeoutMs: payload.submitTimeoutMs === undefined ? undefined : Number(payload.submitTimeoutMs),
    includeText: payload.includeText === undefined ? undefined : Boolean(payload.includeText),
    maxTextChars: payload.maxTextChars === undefined ? undefined : Number(payload.maxTextChars),
    metadata: payload.metadata,
  }
}

function valid(request) {
  return { ok: true, request }
}

function invalid(code, message) {
  return { ok: false, error: { code, message, retryable: false } }
}

function normalizeError(error) {
  if (!error || typeof error !== 'object') {
    return { code: 'bridge_error', message: 'Bridge request failed.', retryable: true }
  }
  return {
    code: typeof error.code === 'string' ? error.code : 'bridge_error',
    message: typeof error.message === 'string' ? error.message : 'Bridge request failed.',
    retryable: Boolean(error.retryable),
  }
}

function cryptoRandomId() {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID()
  }
  return `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
