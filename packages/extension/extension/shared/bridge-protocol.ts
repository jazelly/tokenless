import { getProviderById, listProviders } from './provider-config.js'

export const BRIDGE_PROTOCOL_VERSION = 'tokenless.browser-session-bridge.v1'

export const BRIDGE_ACTIONS = Object.freeze({
  CAPABILITIES: 'capabilities',
  OPEN: 'open',
  SUBMIT: 'submit',
  READ: 'read',
  SNAPSHOT_DOM: 'snapshot_dom',
  SUBMIT_AND_READ: 'submit_and_read',
  INSPECT_CHATGPT_CONTROLS: 'inspect_chatgpt_controls',
  CONFIGURE_CHATGPT: 'configure_chatgpt',
})

const ACTIONS = new Set(Object.values(BRIDGE_ACTIONS))
const CHATGPT_EFFORTS = new Set(['instant', 'medium', 'high', 'extra_high', 'pro'])

export type BridgeRequest = Record<string, any> & {
  protocol: typeof BRIDGE_PROTOCOL_VERSION
  requestId: string
  action: string
}

type BridgeError = {
  code: string
  message: string
  retryable: boolean
}

type BridgeValidation =
  | { ok: true; request: BridgeRequest }
  | { ok: false; error: BridgeError }

type BridgeResult =
  | { ok: true; result?: unknown }
  | { ok: false; error?: Partial<BridgeError> }

export function createBridgeRequest(input: Record<string, any> = {}): BridgeRequest {
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
    chatSurface: input.chatSurface,
    model: input.model,
    modelFallbacks: input.modelFallbacks,
    effort: input.effort,
    metadata: input.metadata,
  }
}

export function createBridgeResponse(request: Partial<BridgeRequest> | null | undefined, result: BridgeResult) {
  const ok = Boolean(result?.ok)
  const payload = result as Record<string, any>
  return {
    protocol: BRIDGE_PROTOCOL_VERSION,
    requestId: request?.requestId ?? null,
    ok,
    provider: request?.provider ?? null,
    action: request?.action ?? null,
    result: ok ? payload.result ?? null : null,
    error: ok ? null : normalizeError(payload.error),
  }
}

export function validateBridgeRequest(payload: unknown): BridgeValidation {
  if (!payload || typeof payload !== 'object') {
    return invalid('invalid_request', 'Bridge request must be an object.')
  }
  const request = payload as Record<string, any>
  if (request.protocol !== BRIDGE_PROTOCOL_VERSION) {
    return invalid('unsupported_protocol', 'Bridge protocol version is not supported.')
  }
  if (typeof request.requestId !== 'string' || request.requestId.trim() === '') {
    return invalid('invalid_request_id', 'Bridge requestId must be a nonempty string.')
  }
  if (!ACTIONS.has(request.action)) {
    return invalid('unsupported_action', 'Bridge action is not supported.')
  }
  if (request.action === BRIDGE_ACTIONS.CAPABILITIES) {
    return valid(normalizeRequest(request))
  }
  const provider = getProviderById(request.provider)
  if (!provider) {
    return invalid('unsupported_provider', 'Bridge provider is not supported.')
  }
  const chatGptControls = validateChatGptControls(request, provider.id)
  if (chatGptControls) return chatGptControls
  if (request.targetUrl !== undefined) {
    if (typeof request.targetUrl !== 'string' || request.targetUrl.trim() === '') {
      return invalid('invalid_target_url', 'Bridge targetUrl must be a nonempty absolute URL when provided.')
    }
    let target: URL
    try {
      target = new URL(request.targetUrl)
    } catch {
      return invalid('invalid_target_url', 'Bridge targetUrl must be a nonempty absolute URL when provided.')
    }
    if (
      target.protocol !== 'https:' ||
      target.username !== '' ||
      target.password !== '' ||
      target.port !== '' ||
      !provider.hosts.includes(target.hostname.toLowerCase())
    ) {
      return invalid('target_url_provider_mismatch', 'Bridge targetUrl must belong to the selected provider.')
    }
  }
  if (
    (request.action === BRIDGE_ACTIONS.SUBMIT || request.action === BRIDGE_ACTIONS.SUBMIT_AND_READ) &&
    (typeof request.prompt !== 'string' || request.prompt.trim() === '')
  ) {
    return invalid('invalid_prompt', 'Bridge prompt must be a nonempty string for submit actions.')
  }
  if (request.readDelayMs !== undefined && (!Number.isFinite(Number(request.readDelayMs)) || Number(request.readDelayMs) < 0)) {
    return invalid('invalid_read_delay', 'Bridge readDelayMs must be a nonnegative number.')
  }
  if (request.readTimeoutMs !== undefined && (!Number.isFinite(Number(request.readTimeoutMs)) || Number(request.readTimeoutMs) < 0)) {
    return invalid('invalid_read_timeout', 'Bridge readTimeoutMs must be a nonnegative number.')
  }
  if (request.submitTimeoutMs !== undefined && (!Number.isFinite(Number(request.submitTimeoutMs)) || Number(request.submitTimeoutMs) < 0)) {
    return invalid('invalid_submit_timeout', 'Bridge submitTimeoutMs must be a nonnegative number.')
  }
  if (request.maxTextChars !== undefined && (!Number.isFinite(Number(request.maxTextChars)) || Number(request.maxTextChars) < 0)) {
    return invalid('invalid_max_text_chars', 'Bridge maxTextChars must be a nonnegative number.')
  }
  const includeText = resolveIncludeText(request)
  if (includeText.ok === false) {
    return invalid('invalid_include_text', 'Bridge includeText must be a boolean when provided.')
  }
  return valid(normalizeRequest(request))
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

function normalizeRequest(payload: Record<string, any>): BridgeRequest {
  const includeText = resolveIncludeText(payload)
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
    includeText: includeText.ok ? includeText.value : undefined,
    maxTextChars: payload.maxTextChars === undefined ? undefined : Number(payload.maxTextChars),
    chatSurface: payload.chatSurface,
    model: payload.model,
    modelFallbacks: payload.modelFallbacks,
    effort: payload.effort,
    metadata: payload.metadata,
  }
}

function validateChatGptControls(
  payload: Record<string, any>,
  providerId: string
): BridgeValidation | null {
  const hasControls = (
    payload.chatSurface !== undefined ||
    payload.model !== undefined ||
    payload.modelFallbacks !== undefined ||
    payload.effort !== undefined
  )
  const requiresChatGpt = (
    payload.action === BRIDGE_ACTIONS.INSPECT_CHATGPT_CONTROLS ||
    payload.action === BRIDGE_ACTIONS.CONFIGURE_CHATGPT
  )
  if ((hasControls || requiresChatGpt) && providerId !== 'chatgpt') {
    return invalid('chatgpt_controls_unsupported', 'Model and Intelligence controls are available only for ChatGPT.')
  }
  if (payload.chatSurface !== undefined && payload.chatSurface !== 'chat') {
    return invalid('invalid_chat_surface', 'ChatGPT chatSurface must be "chat" when provided.')
  }
  if (payload.model !== undefined && !isControlLabel(payload.model)) {
    return invalid('invalid_model', 'ChatGPT model must be a nonempty UI model label up to 120 characters.')
  }
  if (payload.modelFallbacks !== undefined) {
    if (!Array.isArray(payload.modelFallbacks) || payload.modelFallbacks.length > 8 || !payload.modelFallbacks.every(isControlLabel)) {
      return invalid('invalid_model_fallbacks', 'ChatGPT modelFallbacks must contain at most eight nonempty UI model labels.')
    }
  }
  if (payload.effort !== undefined && (!isControlLabel(payload.effort) || !CHATGPT_EFFORTS.has(payload.effort))) {
    return invalid('invalid_effort', 'ChatGPT effort must be one of: instant, medium, high, extra_high, pro.')
  }
  return null
}

function isControlLabel(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120
}

function resolveIncludeText(payload: Record<string, any>):
  | { ok: true; value: boolean | undefined }
  | { ok: false } {
  if (payload.includeText !== undefined) {
    return typeof payload.includeText === 'boolean'
      ? { ok: true, value: payload.includeText }
      : { ok: false }
  }
  const metadata = payload.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { ok: true, value: undefined }
  }
  const metadataIncludeText = (metadata as Record<string, unknown>).includeText
  if (metadataIncludeText === undefined) {
    return { ok: true, value: undefined }
  }
  return typeof metadataIncludeText === 'boolean'
    ? { ok: true, value: metadataIncludeText }
    : { ok: false }
}

function valid(request: BridgeRequest): BridgeValidation {
  return { ok: true, request }
}

function invalid(code: string, message: string): BridgeValidation {
  return { ok: false, error: { code, message, retryable: false } }
}

function normalizeError(error: Partial<BridgeError> | null | undefined): BridgeError {
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
