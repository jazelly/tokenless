import { getProviderById, listProviders } from './provider-config.js'
import { safeProviderTargetUrl } from './provider-navigation-policy.js'
import {
  isNativeAttachmentDescriptor,
  MAX_VISIBLE_ATTACHMENTS,
  MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES,
  VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
} from './native-protocol.js'
import type { NativeAttachmentDescriptor } from './native-protocol.js'
import { visibleProviderActionCapabilitiesPayload } from './visible-provider-capabilities.js'
import {
  VISIBLE_PROVIDER_ACTIONS,
  validateVisibleProviderActionRequest,
} from './visible-provider-actions.js'
import type { VisibleProviderActionRequest } from './visible-provider-actions.js'

export const BRIDGE_PROTOCOL_VERSION = 'tokenless.browser-session-bridge.v1'

export const BRIDGE_ACTIONS = Object.freeze({
  CAPABILITIES: 'capabilities',
  OPEN: 'open',
  SUBMIT: 'submit',
  READ: 'read',
  SNAPSHOT_DOM: 'snapshot_dom',
  SUBMIT_AND_READ: 'submit_and_read',
  INSPECT_CONTROLS: 'inspect_controls',
  CONFIGURE_CONTROLS: 'configure_controls',
  INSPECT_AUTH: 'inspect_auth',
  VISIBLE_PROVIDER_ACTION: 'visible_provider_action',
  INSPECT_CHATGPT_CONTROLS: 'inspect_chatgpt_controls',
  CONFIGURE_CHATGPT: 'configure_chatgpt',
})

const ACTIONS = new Set(Object.values(BRIDGE_ACTIONS))

export type BridgeRequest = Record<string, any> & {
  protocol: typeof BRIDGE_PROTOCOL_VERSION
  requestId: string
  action: string
  visibleAction?: VisibleProviderActionRequest
}

type BridgeError = {
  code: string
  message: string
  retryable: boolean
}

type BridgeValidation =
  | { ok: true; request: BridgeRequest }
  | { ok: false; error: BridgeError }

type VisibleProviderBridgeValidation =
  | { ok: true; request: VisibleProviderActionRequest }
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
    attachments: input.attachments,
    visibleAction: input.visibleAction,
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
  const visibleActionValidation = request.action === BRIDGE_ACTIONS.VISIBLE_PROVIDER_ACTION
    ? validateVisibleProviderBridgeAction(request)
    : null
  if (visibleActionValidation?.ok === false) return visibleActionValidation
  const attachmentError = validateAttachments(request)
  if (attachmentError) return attachmentError
  if (request.action === BRIDGE_ACTIONS.CAPABILITIES) {
    return valid(normalizeRequest(request))
  }
  const provider = getProviderById(request.provider)
  if (!provider) {
    return invalid('unsupported_provider', 'Bridge provider is not supported.')
  }
  const providerControls = validateProviderControls(request, provider.id)
  if (providerControls) return providerControls
  if (request.targetUrl !== undefined) {
    if (typeof request.targetUrl !== 'string' || request.targetUrl.trim() === '') {
      return invalid('invalid_target_url', 'Bridge targetUrl must be a nonempty absolute URL when provided.')
    }
    try {
      // Syntax parsing classifies the public error only. The original raw string
      // still goes through the strict provider policy below, so URL normalization
      // cannot turn an unsafe requested target into an allowlisted one.
      new URL(request.targetUrl)
    } catch {
      return invalid('invalid_target_url', 'Bridge targetUrl must be a nonempty absolute URL when provided.')
    }
    if (!safeProviderTargetUrl(provider, request.targetUrl)) {
      return invalid(
        'target_url_provider_mismatch',
        'Bridge targetUrl must be a strict HTTPS URL belonging to the selected provider.'
      )
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
  const normalized = normalizeRequest(request)
  if (visibleActionValidation?.ok === true) normalized.visibleAction = visibleActionValidation.request
  return valid(normalized)
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
    attachments: {
      protocol: VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
      actions: [BRIDGE_ACTIONS.SUBMIT, BRIDGE_ACTIONS.SUBMIT_AND_READ, BRIDGE_ACTIONS.VISIBLE_PROVIDER_ACTION],
      maxFiles: MAX_VISIBLE_ATTACHMENTS,
      maxRequestBytes: MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES,
    },
    visibleProviderActions: visibleProviderActionCapabilitiesPayload(),
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
    model: typeof payload.model === 'string' ? payload.model.trim() : payload.model,
    modelFallbacks: Array.isArray(payload.modelFallbacks)
      ? payload.modelFallbacks.map((model: unknown) => typeof model === 'string' ? model.trim() : model)
      : payload.modelFallbacks,
    effort: typeof payload.effort === 'string' ? payload.effort.trim() : payload.effort,
    attachments: Array.isArray(payload.attachments)
      ? payload.attachments.map(normalizeAttachmentDescriptor)
      : payload.attachments,
    visibleAction: payload.visibleAction,
    metadata: payload.metadata,
  }
}

function validateVisibleProviderBridgeAction(payload: Record<string, any>): VisibleProviderBridgeValidation {
  const allowedFields = new Set([
    'protocol',
    'requestId',
    'provider',
    'action',
    'targetUrl',
    'idempotencyKey',
    'attachments',
    'visibleAction',
    'metadata',
  ])
  const unsupportedFields = Object.keys(payload).filter((key) => (
    payload[key] !== undefined && !allowedFields.has(key)
  ))
  if (unsupportedFields.length > 0) {
    return invalid(
      'invalid_visible_action_bridge_shape',
      'Unified visible provider bridge requests contain unsupported wrapper fields.'
    )
  }

  const validation = validateVisibleProviderActionRequest(payload.visibleAction)
  if (validation.ok === false) {
    return invalid(validation.error.code, validation.error.message)
  }
  if (
    validation.request.requestId !== payload.requestId ||
    validation.request.provider !== payload.provider
  ) {
    return invalid(
      'visible_action_bridge_mismatch',
      'Unified visible provider action requestId and provider must match the bridge wrapper.'
    )
  }

  const nestedAttachments = validation.request.action === VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD
    ? validation.request.payload.attachments
    : undefined
  if (nestedAttachments !== undefined) {
    if (
      !Array.isArray(payload.attachments) ||
      !Array.isArray(nestedAttachments) ||
      !sameAttachmentDescriptors(payload.attachments, nestedAttachments)
    ) {
      return invalid(
        'visible_action_attachment_mismatch',
        'Standalone visible file upload descriptors must match the native bridge descriptors exactly.'
      )
    }
  } else if (payload.attachments !== undefined) {
    return invalid(
      'attachments_unsupported_for_action',
      'Native visible attachment transport is available only to file.upload in the unified action bridge.'
    )
  }
  return { ok: true, request: validation.request }
}

function validateAttachments(payload: Record<string, any>): BridgeValidation | null {
  if (payload.attachments === undefined) return null
  if (
    payload.action !== BRIDGE_ACTIONS.SUBMIT &&
    payload.action !== BRIDGE_ACTIONS.SUBMIT_AND_READ &&
    payload.action !== BRIDGE_ACTIONS.VISIBLE_PROVIDER_ACTION
  ) {
    return invalid(
      'attachments_unsupported_for_action',
      'Visible attachments are accepted only by submit actions.'
    )
  }
  if (!Array.isArray(payload.attachments) || payload.attachments.length === 0) {
    return invalid('invalid_attachments', 'attachments must be a nonempty array when provided.')
  }
  if (payload.attachments.length > MAX_VISIBLE_ATTACHMENTS) {
    return invalid(
      'too_many_attachments',
      `attachments may contain at most ${MAX_VISIBLE_ATTACHMENTS} visible files.`
    )
  }

  let bundleId: string | undefined
  let totalBytes = 0
  const attachmentIds = new Set<string>()
  for (const value of payload.attachments) {
    if (!isNativeAttachmentDescriptor(value)) {
      return invalid('invalid_attachment', 'Every visible attachment descriptor must be valid and contain no unknown fields.')
    }
    if (bundleId === undefined) bundleId = value.bundleId
    if (value.bundleId !== bundleId) {
      return invalid('attachment_bundle_mismatch', 'Visible attachments in one request must share one bundleId.')
    }
    if (attachmentIds.has(value.attachmentId)) {
      return invalid('duplicate_attachment', 'Visible attachment identities must be unique within a request.')
    }
    attachmentIds.add(value.attachmentId)
    if (value.size > MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES) {
      return invalid(
        'attachment_too_large',
        `Each visible attachment may contain at most ${MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES} bytes.`
      )
    }
    totalBytes += value.size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES) {
      return invalid(
        'attachments_too_large',
        `Visible attachments may contain at most ${MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES} bytes in total.`
      )
    }
  }
  return null
}

function sameAttachmentDescriptors(left: unknown[], right: unknown[]) {
  if (left.length !== right.length) return false
  const fields = ['protocol', 'bundleId', 'attachmentId', 'name', 'type', 'size', 'sha256'] as const
  return left.every((candidate, index) => {
    const expected = right[index]
    if (!candidate || typeof candidate !== 'object' || !expected || typeof expected !== 'object') return false
    const leftRecord = candidate as Record<string, unknown>
    const rightRecord = expected as Record<string, unknown>
    return fields.every((field) => leftRecord[field] === rightRecord[field])
  })
}

function normalizeAttachmentDescriptor(value: NativeAttachmentDescriptor): NativeAttachmentDescriptor {
  return {
    protocol: value.protocol,
    bundleId: value.bundleId,
    attachmentId: value.attachmentId,
    name: value.name,
    type: value.type,
    size: value.size,
    sha256: value.sha256,
  }
}

function validateProviderControls(
  payload: Record<string, any>,
  providerId: string
): BridgeValidation | null {
  const hasModelControls = payload.model !== undefined || payload.modelFallbacks !== undefined
  const hasEffortControl = payload.effort !== undefined
  const hasChatGptOnlyControls = (
    payload.chatSurface !== undefined
  )
  const legacyChatGptAction = (
    payload.action === BRIDGE_ACTIONS.INSPECT_CHATGPT_CONTROLS ||
    payload.action === BRIDGE_ACTIONS.CONFIGURE_CHATGPT
  )
  if (legacyChatGptAction && providerId !== 'chatgpt') {
    return invalid('chatgpt_controls_unsupported', 'Legacy ChatGPT control actions require the ChatGPT provider.')
  }
  const controlConfigurationAction = (
    payload.action === BRIDGE_ACTIONS.SUBMIT ||
    payload.action === BRIDGE_ACTIONS.SUBMIT_AND_READ ||
    payload.action === BRIDGE_ACTIONS.CONFIGURE_CONTROLS ||
    payload.action === BRIDGE_ACTIONS.CONFIGURE_CHATGPT
  )
  if ((hasModelControls || hasEffortControl) && !controlConfigurationAction) {
    return invalid(
      'controls_unsupported_for_action',
      'Visible provider controls are accepted only by submit or configure actions.'
    )
  }
  if (hasChatGptOnlyControls && providerId !== 'chatgpt') {
    return invalid(
      'chatgpt_controls_unsupported',
      'Chat surface controls are available only for ChatGPT.'
    )
  }
  if (payload.chatSurface !== undefined && payload.chatSurface !== 'chat') {
    return invalid('invalid_chat_surface', 'ChatGPT chatSurface must be "chat" when provided.')
  }
  if (payload.model !== undefined && !isControlLabel(payload.model)) {
    return invalid('invalid_model', 'Model must be a nonempty visible UI label up to 120 characters.')
  }
  if (payload.modelFallbacks !== undefined) {
    if (!Array.isArray(payload.modelFallbacks) || payload.modelFallbacks.length > 8 || !payload.modelFallbacks.every(isControlLabel)) {
      return invalid('invalid_model_fallbacks', 'modelFallbacks must contain at most eight nonempty visible UI labels.')
    }
    if (payload.model === undefined) {
      return invalid('model_fallback_requires_model', 'modelFallbacks require a primary visible UI model label.')
    }
  }
  if (payload.effort !== undefined && !isControlLabel(payload.effort)) {
    return invalid('invalid_effort', 'Effort must be an exact nonempty visible UI label up to 120 characters.')
  }
  return null
}

function isControlLabel(value: unknown) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 120 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
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

function invalid(code: string, message: string): { ok: false; error: BridgeError } {
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
