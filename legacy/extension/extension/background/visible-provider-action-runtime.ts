import { BRIDGE_ACTIONS, createBridgeRequest } from '../shared/bridge-protocol.js'
import { getProviderById } from '../shared/provider-config.js'
import {
  VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
  VISIBLE_PROVIDER_ACTIONS,
  VISIBLE_PROVIDER_RUNTIME_REQUEST_TYPE,
  authorizeVisibleProviderAction,
  createVisibleProviderActionResponse,
  validateVisibleProviderActionRequest,
} from '../shared/visible-provider-actions.js'
import { getVisibleProviderActionCapabilities } from '../shared/visible-provider-capabilities.js'
import type { BridgeRequest } from '../shared/bridge-protocol.js'
import type { NativeAttachmentDescriptor } from '../shared/native-protocol.js'
import type { ProviderConfig } from '../shared/provider-config.js'
import type {
  VisibleAuthStatusResult,
  VisibleProviderActionRequest,
  VisibleProviderActionResponse,
} from '../shared/visible-provider-actions.js'

export const VISIBLE_PROVIDER_CONTENT_ACTION_TYPE = 'tokenless.bridge.visible_provider_action' as const

export type VisibleProviderRuntimeDependencies = {
  acquireProviderTab(provider: ProviderConfig, options: { forceNew: boolean }): Promise<number>
  validateProviderLanding(tabId: number, provider: ProviderConfig, request: BridgeRequest): Promise<void>
  sendToProviderTab(
    tabId: number,
    provider: ProviderConfig,
    contextRequest: BridgeRequest,
    message: Record<string, unknown>
  ): Promise<unknown>
  uploadVisibleAttachments(
    tabId: number,
    provider: ProviderConfig,
    contextRequest: BridgeRequest,
    attachments: readonly NativeAttachmentDescriptor[]
  ): Promise<void>
}

type RuntimeSender = {
  id?: string | undefined
  tab?: unknown
  url?: string | undefined
}

type AuthProbe = {
  state: VisibleAuthStatusResult['state']
  response: VisibleProviderActionResponse
  verified: boolean
}

export function isVisibleProviderRuntimeMessage(message: unknown) {
  return isPlainRecord(message) && message.type === VISIBLE_PROVIDER_RUNTIME_REQUEST_TYPE
}

export function visibleProviderActionRequiresCleanTab(action: string) {
  return action === VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD
}

export function isTrustedVisibleProviderRuntimeSender(sender: RuntimeSender, extensionId: string) {
  if (!extensionId || sender.id !== extensionId || sender.tab !== undefined) return false
  if (sender.url === undefined) return true
  try {
    const parsed = new URL(sender.url)
    return (
      parsed.protocol === 'chrome-extension:' &&
      parsed.hostname === extensionId &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === ''
    )
  } catch {
    return false
  }
}

export function rejectedVisibleProviderRuntimeResponse(message: unknown): VisibleProviderActionResponse {
  return failureResponse(
    requestCandidate(message),
    'visible_action_sender_rejected',
    'Visible provider actions may be requested only by an extension-owned page.',
    false
  )
}

export function failedVisibleProviderRuntimeResponse(message: unknown): VisibleProviderActionResponse {
  return failureResponse(
    requestCandidate(message),
    'visible_action_runtime_failed',
    'Visible provider action runtime failed before a verified result was produced.',
    true
  )
}

export async function runVisibleProviderRuntimeEnvelope(
  envelope: unknown,
  dependencies: VisibleProviderRuntimeDependencies
): Promise<VisibleProviderActionResponse> {
  if (
    !isPlainRecord(envelope) ||
    !hasExactKeys(envelope, ['type', 'request']) ||
    envelope.type !== VISIBLE_PROVIDER_RUNTIME_REQUEST_TYPE
  ) {
    return failureResponse(
      requestCandidate(envelope),
      'invalid_visible_action_runtime_envelope',
      'Visible provider runtime envelope is invalid.',
      false
    )
  }

  const validation = validateVisibleProviderActionRequest(envelope.request)
  if (validation.ok === false) {
    return failureResponse(
      requestCandidate(envelope),
      validation.error.code,
      validation.error.message,
      validation.error.retryable
    )
  }
  const request = validation.request
  const provider = getProviderById(request.provider)
  const manifest = getVisibleProviderActionCapabilities(request.provider)
  if (!provider || !manifest) {
    return failureResponse(request, 'unsupported_provider', 'Visible provider is not supported.', false)
  }

  // Run the complete schema/capability preflight before opening a provider tab.
  // Authenticated is used only to postpone the live session check; pending,
  // unsupported, label, and upload-limit failures still stop without UI effects.
  const preflight = authorizeVisibleProviderAction(request, manifest, { authState: 'authenticated' })
  if (preflight.ok === false) {
    return failureResponse(request, preflight.error.code, preflight.error.message, preflight.error.retryable)
  }

  try {
    const tabId = await dependencies.acquireProviderTab(provider, {
      forceNew: visibleProviderActionRequiresCleanTab(request.action),
    })
    const contextRequest = bridgeContextRequest(request)
    const auth = await deriveVisibleAuthStatus(tabId, provider, contextRequest, request, dependencies)
    const authorization = authorizeVisibleProviderAction(request, manifest, { authState: auth.state })
    if (authorization.ok === false) {
      return failureResponse(
        request,
        authorization.error.code,
        authorization.error.message,
        authorization.error.retryable
      )
    }
    if (request.action === VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS) {
      return auth.verified
        ? auth.response
        : failureResponse(
          request,
          'visible_auth_status_unavailable',
          'Provider content did not return a verified privacy-safe auth status.',
          false
        )
    }

    await dependencies.validateProviderLanding(tabId, provider, contextRequest)
    return dispatchVisibleProviderAction(tabId, provider, request, dependencies)
  } catch (error) {
    const candidate = error && typeof error === 'object'
      ? error as Record<string, unknown>
      : {}
    return failureResponse(
      request,
      safeErrorCode(candidate.code, 'visible_action_runtime_failed'),
      'Visible provider action runtime failed before a verified result was produced.',
      candidate.retryable !== false
    )
  }
}

async function deriveVisibleAuthStatus(
  tabId: number,
  provider: ProviderConfig,
  contextRequest: BridgeRequest,
  sourceRequest: VisibleProviderActionRequest,
  dependencies: VisibleProviderRuntimeDependencies
): Promise<AuthProbe> {
  const request: VisibleProviderActionRequest = {
    ...sourceRequest,
    action: VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS,
    payload: {},
  }
  const unknown = createVisibleProviderActionResponse(request, {
    ok: true,
    result: { state: 'unknown' },
  })
  try {
    const response = await dependencies.sendToProviderTab(tabId, provider, contextRequest, {
      type: 'tokenless.bridge.inspect_auth',
      request: contextRequest,
    })
    if (
      !isPlainRecord(response) ||
      response.status !== 'inspected' ||
      response.provider !== provider.id ||
      response.visible !== true ||
      !isPlainRecord(response.auth)
    ) {
      return { state: 'unknown', response: unknown, verified: false }
    }
    const normalized = createVisibleProviderActionResponse(request, { ok: true, result: response.auth })
    if (!normalized.ok || !isPlainRecord(normalized.result)) {
      return { state: 'unknown', response: unknown, verified: false }
    }
    const state = normalized.result.state
    if (state !== 'authenticated' && state !== 'unauthenticated' && state !== 'unknown') {
      return { state: 'unknown', response: unknown, verified: false }
    }
    return { state, response: normalized, verified: true }
  } catch {
    return { state: 'unknown', response: unknown, verified: false }
  }
}

async function dispatchVisibleProviderAction(
  tabId: number,
  provider: ProviderConfig,
  request: VisibleProviderActionRequest,
  dependencies: VisibleProviderRuntimeDependencies
): Promise<VisibleProviderActionResponse> {
  const contextRequest = bridgeContextRequest(request)
  if (request.action === VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD) {
    const attachments = request.payload.attachments as NativeAttachmentDescriptor[]
    await dependencies.uploadVisibleAttachments(tabId, provider, contextRequest, attachments)
    return createVisibleProviderActionResponse(request, {
      ok: true,
      result: {
        attachments: attachments.map((attachment) => ({
          attachmentId: attachment.attachmentId,
          name: attachment.name,
          visible: true,
        })),
      },
    })
  }
  if (
    request.action === VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT ||
    request.action === VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT
  ) {
    const response = await dependencies.sendToProviderTab(tabId, provider, contextRequest, {
      type: 'tokenless.bridge.inspect_controls',
      request: contextRequest,
    })
    return normalizeLegacyInspection(request, response)
  }
  if (
    request.action === VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT ||
    request.action === VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT
  ) {
    const response = await dependencies.sendToProviderTab(tabId, provider, contextRequest, {
      type: 'tokenless.bridge.configure_controls',
      request: contextRequest,
    })
    return normalizeLegacySelection(request, response)
  }
  if (request.action === VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT) {
    const response = await dependencies.sendToProviderTab(tabId, provider, contextRequest, {
      type: 'tokenless.bridge.submit',
      request: contextRequest,
    })
    if (!isPlainRecord(response) || response.status !== 'submitted') {
      return contentBlockedResponse(request, response, 'visible_prompt_submit_unconfirmed')
    }
    return createVisibleProviderActionResponse(request, {
      ok: true,
      result: { submissionProof: `visible-submit-${request.requestId}`, visible: true },
    })
  }
  if (request.action === VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT) {
    const response = await dependencies.sendToProviderTab(tabId, provider, contextRequest, {
      type: 'tokenless.bridge.input_prompt',
      request: contextRequest,
    })
    if (
      !isPlainRecord(response) ||
      response.status !== 'input' ||
      response.provider !== provider.id ||
      response.visible !== true ||
      typeof response.inputProof !== 'string'
    ) {
      return contentBlockedResponse(request, response, 'visible_prompt_input_unconfirmed')
    }
    return createVisibleProviderActionResponse(request, {
      ok: true,
      result: { inputProof: response.inputProof, visible: true },
    })
  }

  const response = await dependencies.sendToProviderTab(tabId, provider, contextRequest, {
    type: VISIBLE_PROVIDER_CONTENT_ACTION_TYPE,
    request,
  })
  return normalizeGenericContentResponse(request, response)
}

function normalizeLegacyInspection(
  request: VisibleProviderActionRequest,
  response: unknown
): VisibleProviderActionResponse {
  if (!isPlainRecord(response) || response.status !== 'inspected' || !isPlainRecord(response.controls)) {
    return contentBlockedResponse(request, response, 'visible_control_inspection_unconfirmed')
  }
  const source = request.action === VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT
    ? response.controls.models
    : response.controls.efforts
  if (!Array.isArray(source) || source.length > 100) {
    return failureResponse(
      request,
      'invalid_visible_action_result',
      'Provider content returned an invalid control inventory.',
      false
    )
  }
  const choices: Array<{ label: unknown; selected: unknown; enabled: unknown }> = []
  for (const item of source) {
    if (!isPlainRecord(item)) {
      return failureResponse(
        request,
        'invalid_visible_action_result',
        'Provider content returned an invalid control inventory.',
        false
      )
    }
    choices.push({ label: item.label, selected: item.selected, enabled: item.available })
  }
  return createVisibleProviderActionResponse(request, { ok: true, result: { choices } })
}

function normalizeLegacySelection(
  request: VisibleProviderActionRequest,
  response: unknown
): VisibleProviderActionResponse {
  if (!isPlainRecord(response) || response.status !== 'configured') {
    return contentBlockedResponse(request, response, 'visible_control_selection_unconfirmed')
  }
  const selection = request.action === VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT
    ? response.model
    : response.effort
  if (
    !isPlainRecord(selection) ||
    (selection.status !== 'selected' && selection.status !== 'fallback_selected') ||
    typeof selection.applied !== 'string'
  ) {
    return failureResponse(
      request,
      'invalid_visible_action_result',
      'Provider content did not confirm one exact visible control selection.',
      false
    )
  }
  return createVisibleProviderActionResponse(request, {
    ok: true,
    result: { label: selection.applied, visible: true },
  })
}

function normalizeGenericContentResponse(
  request: VisibleProviderActionRequest,
  response: unknown
): VisibleProviderActionResponse {
  if (!isMatchingContentResponse(response, request)) {
    return failureResponse(
      request,
      'invalid_visible_action_result',
      'Provider content response did not match the visible action request.',
      false
    )
  }
  if (response.ok === true) {
    return createVisibleProviderActionResponse(request, { ok: true, result: response.result })
  }
  return failureResponse(
    request,
    safeErrorCode(isPlainRecord(response.error) ? response.error.code : undefined, 'visible_action_content_blocked'),
    'Provider content blocked the requested visible action.',
    false
  )
}

function contentBlockedResponse(
  request: VisibleProviderActionRequest,
  response: unknown,
  fallbackCode: string
) {
  const candidate = isPlainRecord(response) ? response : {}
  return failureResponse(
    request,
    safeErrorCode(candidate.stopReason, fallbackCode),
    'Provider content did not produce the required visible confirmation.',
    candidate.retryable === true
  )
}

function bridgeContextRequest(request: VisibleProviderActionRequest): BridgeRequest {
  const payload = request.payload
  if (request.action === VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT) {
    return createBridgeRequest({ requestId: request.requestId, provider: request.provider, action: BRIDGE_ACTIONS.INSPECT_CONTROLS })
  }
  if (request.action === VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT) {
    return createBridgeRequest({
      requestId: request.requestId,
      provider: request.provider,
      action: BRIDGE_ACTIONS.CONFIGURE_CONTROLS,
      model: payload.label,
      modelFallbacks: payload.fallbacks,
    })
  }
  if (request.action === VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT) {
    return createBridgeRequest({ requestId: request.requestId, provider: request.provider, action: BRIDGE_ACTIONS.INSPECT_CONTROLS })
  }
  if (request.action === VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT) {
    return createBridgeRequest({
      requestId: request.requestId,
      provider: request.provider,
      action: BRIDGE_ACTIONS.CONFIGURE_CONTROLS,
      effort: payload.label,
    })
  }
  if (request.action === VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT) {
    return createBridgeRequest({
      requestId: request.requestId,
      provider: request.provider,
      action: BRIDGE_ACTIONS.SUBMIT,
      prompt: payload.text,
    })
  }
  if (request.action === VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT) {
    const contextRequest = createBridgeRequest({
      requestId: request.requestId,
      provider: request.provider,
      action: BRIDGE_ACTIONS.SUBMIT,
      prompt: payload.text,
    })
    contextRequest.mode = payload.mode
    return contextRequest
  }
  if (request.action === VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD) {
    return createBridgeRequest({
      requestId: request.requestId,
      provider: request.provider,
      action: BRIDGE_ACTIONS.VISIBLE_PROVIDER_ACTION,
      visibleAction: request,
      attachments: payload.attachments,
    })
  }
  return createBridgeRequest({
    requestId: request.requestId,
    provider: request.provider,
    action: BRIDGE_ACTIONS.OPEN,
  })
}

function isMatchingContentResponse(
  response: unknown,
  request: VisibleProviderActionRequest
): response is Record<string, any> {
  return (
    isPlainRecord(response) &&
    response.protocol === VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION &&
    response.requestId === request.requestId &&
    response.provider === request.provider &&
    response.action === request.action &&
    typeof response.ok === 'boolean'
  )
}

function failureResponse(
  request: Partial<VisibleProviderActionRequest> | null | undefined,
  code: string,
  message: string,
  retryable: boolean
) {
  return createVisibleProviderActionResponse(request, {
    ok: false,
    error: { code: safeErrorCode(code, 'visible_action_failed'), message, retryable },
  })
}

function requestCandidate(envelope: unknown): Partial<VisibleProviderActionRequest> | null {
  if (!isPlainRecord(envelope) || !isPlainRecord(envelope.request)) return null
  return envelope.request as Partial<VisibleProviderActionRequest>
}

function safeErrorCode(value: unknown, fallback: string) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}
