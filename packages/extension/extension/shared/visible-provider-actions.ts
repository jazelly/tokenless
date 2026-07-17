import {
  isNativeAttachmentDescriptor,
  MAX_VISIBLE_ATTACHMENTS,
  MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES,
} from './native-protocol.js'
import { getProviderById } from './provider-config.js'
import type { NativeAttachmentDescriptor } from './native-protocol.js'
import type { ProviderId } from './provider-config.js'

export const VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION = 'tokenless.visible-provider-action.v1' as const
export const VISIBLE_PROVIDER_RUNTIME_REQUEST_TYPE = 'tokenless.visible-provider-action.request' as const

export const VISIBLE_PROVIDER_ACTIONS = Object.freeze({
  AUTH_STATUS: 'auth.status',
  MODEL_INSPECT: 'model.inspect',
  MODEL_SELECT: 'model.select',
  EFFORT_INSPECT: 'effort.inspect',
  EFFORT_SELECT: 'effort.select',
  FILE_UPLOAD: 'file.upload',
  SKILL_UPLOAD: 'skill.upload',
  CONNECTOR_INSPECT: 'connector.inspect',
  CONNECTOR_SELECT: 'connector.select',
  PROMPT_INPUT: 'prompt.input',
  PROMPT_SUBMIT: 'prompt.submit',
  PROJECT_INSPECT: 'project.inspect',
  PROJECT_OPEN: 'project.open',
  HISTORY_INSPECT: 'history.inspect',
  HISTORY_OPEN: 'history.open',
})

export type VisibleProviderAction = typeof VISIBLE_PROVIDER_ACTIONS[keyof typeof VISIBLE_PROVIDER_ACTIONS]
export type VisibleProviderCapabilityState = 'verified' | 'pending_evidence' | 'unsupported'

export const VISIBLE_PROVIDER_ACTION_METADATA: Readonly<Record<VisibleProviderAction, {
  domain: 'auth' | 'model' | 'effort' | 'file' | 'skill' | 'connector' | 'prompt' | 'project' | 'history'
  mutatesVisibleUi: boolean
  priority: 'core' | 'enrichment'
}>> = Object.freeze({
  [VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS]: Object.freeze({ domain: 'auth', mutatesVisibleUi: false, priority: 'core' }),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT]: Object.freeze({ domain: 'model', mutatesVisibleUi: false, priority: 'core' }),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT]: Object.freeze({ domain: 'model', mutatesVisibleUi: true, priority: 'core' }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT]: Object.freeze({ domain: 'effort', mutatesVisibleUi: false, priority: 'core' }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT]: Object.freeze({ domain: 'effort', mutatesVisibleUi: true, priority: 'core' }),
  [VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD]: Object.freeze({ domain: 'file', mutatesVisibleUi: true, priority: 'core' }),
  [VISIBLE_PROVIDER_ACTIONS.SKILL_UPLOAD]: Object.freeze({ domain: 'skill', mutatesVisibleUi: true, priority: 'enrichment' }),
  [VISIBLE_PROVIDER_ACTIONS.CONNECTOR_INSPECT]: Object.freeze({ domain: 'connector', mutatesVisibleUi: false, priority: 'enrichment' }),
  [VISIBLE_PROVIDER_ACTIONS.CONNECTOR_SELECT]: Object.freeze({ domain: 'connector', mutatesVisibleUi: true, priority: 'enrichment' }),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT]: Object.freeze({ domain: 'prompt', mutatesVisibleUi: true, priority: 'core' }),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT]: Object.freeze({ domain: 'prompt', mutatesVisibleUi: true, priority: 'core' }),
  [VISIBLE_PROVIDER_ACTIONS.PROJECT_INSPECT]: Object.freeze({ domain: 'project', mutatesVisibleUi: false, priority: 'enrichment' }),
  [VISIBLE_PROVIDER_ACTIONS.PROJECT_OPEN]: Object.freeze({ domain: 'project', mutatesVisibleUi: true, priority: 'enrichment' }),
  [VISIBLE_PROVIDER_ACTIONS.HISTORY_INSPECT]: Object.freeze({ domain: 'history', mutatesVisibleUi: false, priority: 'enrichment' }),
  [VISIBLE_PROVIDER_ACTIONS.HISTORY_OPEN]: Object.freeze({ domain: 'history', mutatesVisibleUi: true, priority: 'enrichment' }),
})

const ACTIONS = Object.freeze(Object.values(VISIBLE_PROVIDER_ACTIONS)) as readonly VisibleProviderAction[]
const ACTION_SET = new Set<string>(ACTIONS)
const MAX_REQUEST_ID_CHARS = 128
const MAX_VISIBLE_LABEL_CHARS = 120
const MAX_PROMPT_UTF8_BYTES = 1024 * 1024
const EMPTY_PAYLOAD_ACTIONS = new Set<VisibleProviderAction>([
  VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS,
  VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT,
  VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT,
  VISIBLE_PROVIDER_ACTIONS.CONNECTOR_INSPECT,
  VISIBLE_PROVIDER_ACTIONS.PROJECT_INSPECT,
  VISIBLE_PROVIDER_ACTIONS.HISTORY_INSPECT,
])
const CHOICE_INSPECTION_ACTIONS = new Set<VisibleProviderAction>([
  VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT,
  VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT,
  VISIBLE_PROVIDER_ACTIONS.CONNECTOR_INSPECT,
  VISIBLE_PROVIDER_ACTIONS.PROJECT_INSPECT,
  VISIBLE_PROVIDER_ACTIONS.HISTORY_INSPECT,
])
const SELECTION_RESULT_ACTIONS = new Set<VisibleProviderAction>([
  VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT,
  VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT,
  VISIBLE_PROVIDER_ACTIONS.CONNECTOR_SELECT,
  VISIBLE_PROVIDER_ACTIONS.PROJECT_OPEN,
  VISIBLE_PROVIDER_ACTIONS.HISTORY_OPEN,
])

const SELECT_ACTION_DEPENDENCIES: Readonly<Partial<Record<VisibleProviderAction, VisibleProviderAction>>> = Object.freeze({
  [VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT]: VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT,
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT]: VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT,
  [VISIBLE_PROVIDER_ACTIONS.CONNECTOR_SELECT]: VISIBLE_PROVIDER_ACTIONS.CONNECTOR_INSPECT,
  [VISIBLE_PROVIDER_ACTIONS.PROJECT_OPEN]: VISIBLE_PROVIDER_ACTIONS.PROJECT_INSPECT,
  [VISIBLE_PROVIDER_ACTIONS.HISTORY_OPEN]: VISIBLE_PROVIDER_ACTIONS.HISTORY_INSPECT,
})

export type VisibleProviderActionError = {
  code: string
  message: string
  retryable: boolean
}

export type VisibleProviderActionRequest = {
  protocol: typeof VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION
  requestId: string
  provider: ProviderId
  action: VisibleProviderAction
  payload: Record<string, unknown>
}

export type VisibleProviderRuntimeEnvelope = {
  type: typeof VISIBLE_PROVIDER_RUNTIME_REQUEST_TYPE
  request: VisibleProviderActionRequest
}

export type VisibleProviderActionResponse = {
  protocol: typeof VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION
  requestId: string | null
  provider: ProviderId | null
  action: VisibleProviderAction | null
  ok: boolean
  result: unknown
  error: VisibleProviderActionError | null
}

export type VisibleAuthStatusResult = {
  state: 'authenticated' | 'unauthenticated' | 'unknown'
  plan?: {
    label: string
    free: boolean | null
  }
  usage?: readonly {
    label: string
    value: string
  }[]
}

export type VisibleProviderChoice = {
  label: string
  selected: boolean
  enabled: boolean
  description?: string
}

export type VisibleProviderChoiceResult = {
  choices: readonly VisibleProviderChoice[]
}

export type VisibleProviderUploadResult = {
  attachments: readonly {
    attachmentId: string
    name: string
    visible: true
  }[]
}

export type VisiblePromptInputResult = {
  inputProof: string
  visible: true
}

export type VisiblePromptSubmitResult = {
  submissionProof: string
  visible: true
}

export type VisibleProviderCapabilityConstraints = {
  allowedLabels?: readonly string[]
  maxItems?: number
  maxBytes?: number
}

export type VisibleProviderActionCapability = {
  state: VisibleProviderCapabilityState
  requiresAuthentication: boolean
  evidence: readonly string[]
  reason: string | null
  constraints: Readonly<VisibleProviderCapabilityConstraints>
}

export type VisibleProviderCapabilityManifest = {
  protocol: typeof VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION
  provider: ProviderId
  actions: Readonly<Record<VisibleProviderAction, VisibleProviderActionCapability>>
  safety: {
    visibleUiOnly: true
    readsPrivateProviderApis: false
    readsBrowserCredentials: false
    exactVisibleSelection: true
  }
}

export type VisibleProviderCapabilityDeclaration = {
  state: VisibleProviderCapabilityState
  requiresAuthentication?: boolean
  evidence?: readonly string[]
  reason?: string
  constraints?: VisibleProviderCapabilityConstraints
}

export type VisibleProviderActionContext = {
  authState: VisibleAuthStatusResult['state']
}

type ValidationSuccess = { ok: true; request: VisibleProviderActionRequest }
type ValidationFailure = { ok: false; error: VisibleProviderActionError }
export type VisibleProviderActionValidation = ValidationSuccess | ValidationFailure
export type VisibleProviderActionAuthorization =
  | (ValidationSuccess & { capability: VisibleProviderActionCapability })
  | ValidationFailure

export function listVisibleProviderActions(): VisibleProviderAction[] {
  return [...ACTIONS]
}

export function createVisibleProviderActionRequest(
  input: Omit<Partial<VisibleProviderActionRequest>, 'protocol'> & Record<string, unknown>
): VisibleProviderActionRequest {
  return {
    protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    requestId: typeof input.requestId === 'string' ? input.requestId : cryptoRandomId(),
    provider: input.provider as ProviderId,
    action: input.action as VisibleProviderAction,
    payload: isPlainRecord(input.payload) ? input.payload : {},
  }
}

export function createVisibleProviderRuntimeEnvelope(
  request: VisibleProviderActionRequest
): VisibleProviderRuntimeEnvelope {
  return { type: VISIBLE_PROVIDER_RUNTIME_REQUEST_TYPE, request }
}

export function validateVisibleProviderActionRequest(payload: unknown): VisibleProviderActionValidation {
  if (!isPlainRecord(payload)) return invalid('invalid_visible_action_request', 'Visible provider action request must be an object.')
  if (!hasExactKeys(payload, ['protocol', 'requestId', 'provider', 'action', 'payload'])) {
    return invalid('invalid_visible_action_request', 'Visible provider action request contains missing or unsupported fields.')
  }
  if (payload.protocol !== VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION) {
    return invalid('unsupported_visible_action_protocol', 'Visible provider action protocol version is not supported.')
  }
  if (!isBoundedIdentifier(payload.requestId, MAX_REQUEST_ID_CHARS)) {
    return invalid('invalid_visible_action_request_id', 'Visible provider action requestId is invalid.')
  }
  if (!getProviderById(payload.provider)) {
    return invalid('unsupported_provider', 'Visible provider action provider is not supported.')
  }
  if (typeof payload.action !== 'string' || !ACTION_SET.has(payload.action)) {
    return invalid('unsupported_visible_action', 'Visible provider action is not supported by this protocol.')
  }
  if (!isPlainRecord(payload.payload)) {
    return invalid('invalid_visible_action_payload', 'Visible provider action payload must be an object.')
  }

  const action = payload.action as VisibleProviderAction
  const normalizedPayload = validateAndNormalizePayload(action, payload.payload)
  if (normalizedPayload.ok === false) return normalizedPayload
  return {
    ok: true,
    request: {
      protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
      requestId: payload.requestId,
      provider: payload.provider as ProviderId,
      action,
      payload: normalizedPayload.value,
    },
  }
}

export function authorizeVisibleProviderAction(
  payload: unknown,
  manifest: VisibleProviderCapabilityManifest,
  context: VisibleProviderActionContext = { authState: 'unknown' }
): VisibleProviderActionAuthorization {
  const validation = validateVisibleProviderActionRequest(payload)
  if (validation.ok === false) return validation
  if (
    manifest.protocol !== VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION ||
    manifest.provider !== validation.request.provider
  ) {
    return invalid('visible_action_capability_mismatch', 'Visible provider capability manifest does not match the request.')
  }
  const capability = manifest.actions[validation.request.action]
  if (!capability || capability.state !== 'verified') {
    const state = capability?.state ?? 'pending_evidence'
    return invalid(
      state === 'unsupported' ? 'visible_action_unsupported' : 'visible_action_pending_evidence',
      capability?.reason ?? 'Visible provider action has no verified DOM implementation.'
    )
  }
  if (!['authenticated', 'unauthenticated', 'unknown'].includes(context.authState)) {
    return invalid('invalid_visible_action_context', 'Visible provider action authentication context is invalid.')
  }
  if (capability.requiresAuthentication && context.authState !== 'authenticated') {
    return invalid(
      'visible_action_auth_required',
      'Visible provider action requires a visibly authenticated provider session.'
    )
  }
  const constraintError = validateCapabilityConstraints(validation.request, capability.constraints)
  if (constraintError) return constraintError
  return { ...validation, capability }
}

export function createVisibleProviderCapabilityManifest(
  provider: ProviderId,
  declarations: Partial<Record<VisibleProviderAction, VisibleProviderCapabilityDeclaration>> = {}
): VisibleProviderCapabilityManifest {
  if (!getProviderById(provider)) throw new TypeError(`Unsupported visible provider capability manifest: ${String(provider)}.`)
  for (const key of Object.keys(declarations)) {
    if (!ACTION_SET.has(key)) throw new TypeError(`Unsupported visible provider action capability: ${key}.`)
  }

  const actions = Object.fromEntries(ACTIONS.map((action) => {
    const declaration = declarations[action] ?? {
      state: 'pending_evidence' as const,
      reason: 'No verified visible DOM implementation has been registered.',
    }
    return [action, normalizeCapability(action, declaration)]
  })) as Record<VisibleProviderAction, VisibleProviderActionCapability>

  for (const [action, dependency] of Object.entries(SELECT_ACTION_DEPENDENCIES) as [VisibleProviderAction, VisibleProviderAction][]) {
    if (actions[action].state === 'verified' && actions[dependency].state !== 'verified') {
      throw new TypeError(`${action} cannot be verified until ${dependency} is verified.`)
    }
  }

  return Object.freeze({
    protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    provider,
    actions: Object.freeze(actions),
    safety: Object.freeze({
      visibleUiOnly: true as const,
      readsPrivateProviderApis: false as const,
      readsBrowserCredentials: false as const,
      exactVisibleSelection: true as const,
    }),
  })
}

export function createVisibleProviderActionResponse(
  request: Partial<VisibleProviderActionRequest> | null | undefined,
  result: { ok: true; result?: unknown } | { ok: false; error?: Partial<VisibleProviderActionError> }
): VisibleProviderActionResponse {
  const requestedAction = typeof request?.action === 'string' && ACTION_SET.has(request.action)
    ? request.action
    : null
  const normalizedResult = result.ok === true && requestedAction
    ? normalizeSuccessfulResult(requestedAction, result.result)
    : null
  const ok = result.ok === true && normalizedResult?.ok === true
  const invalidResultMessage = normalizedResult?.ok === false
    ? normalizedResult.message
    : 'Visible provider action returned an invalid result.'
  return {
    protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    requestId: typeof request?.requestId === 'string' ? request.requestId : null,
    provider: getProviderById(request?.provider) ? request?.provider ?? null : null,
    action: requestedAction,
    ok,
    result: ok ? normalizedResult.value : null,
    error: ok
      ? null
      : result.ok === true
        ? normalizeError({
          code: 'invalid_visible_action_result',
          message: invalidResultMessage,
          retryable: false,
        })
        : normalizeError(result.error),
  }
}

function normalizeSuccessfulResult(
  action: VisibleProviderAction,
  value: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!isPlainRecord(value)) return invalidResult(`${action} result must be an object.`)
  if (action === VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS) return normalizeAuthStatusResult(value)
  if (CHOICE_INSPECTION_ACTIONS.has(action)) return normalizeChoiceResult(action, value)
  if (action === VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD || action === VISIBLE_PROVIDER_ACTIONS.SKILL_UPLOAD) {
    if (!hasExactKeys(value, ['attachments']) || !Array.isArray(value.attachments) || value.attachments.length < 1 || value.attachments.length > MAX_VISIBLE_ATTACHMENTS) {
      return invalidResult(`${action} result must contain a nonempty bounded attachments array.`)
    }
    const attachments: Array<{ attachmentId: string; name: string; visible: true }> = []
    for (const item of value.attachments) {
      if (
        !isPlainRecord(item) ||
        !hasExactKeys(item, ['attachmentId', 'name', 'visible']) ||
        !isBoundedIdentifier(item.attachmentId, 256) ||
        !isBoundedVisibleText(item.name, 255) ||
        item.visible !== true
      ) {
        return invalidResult(`${action} result contains an invalid visible attachment proof.`)
      }
      attachments.push({ attachmentId: item.attachmentId, name: item.name, visible: true })
    }
    return { ok: true, value: { attachments } }
  }
  if (SELECTION_RESULT_ACTIONS.has(action)) {
    if (!hasExactKeys(value, ['label', 'visible']) || !isVisibleLabel(value.label) || value.visible !== true) {
      return invalidResult(`${action} result must confirm one exact visible label.`)
    }
    return { ok: true, value: { label: normalizeVisibleLabel(value.label), visible: true } }
  }
  if (action === VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT) {
    if (!hasExactKeys(value, ['inputProof', 'visible']) || !isBoundedIdentifier(value.inputProof, 256) || value.visible !== true) {
      return invalidResult('prompt.input result must contain only a bounded inputProof and visible confirmation.')
    }
    return { ok: true, value: { inputProof: value.inputProof, visible: true } }
  }
  if (action === VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT) {
    if (!hasExactKeys(value, ['submissionProof', 'visible']) || !isBoundedIdentifier(value.submissionProof, 256) || value.visible !== true) {
      return invalidResult('prompt.submit result must contain only a bounded submissionProof and visible confirmation.')
    }
    return { ok: true, value: { submissionProof: value.submissionProof, visible: true } }
  }
  return invalidResult(`${action} has no success-result contract.`)
}

function normalizeAuthStatusResult(
  value: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!hasOnlyKeys(value, ['state', 'plan', 'usage']) || !['authenticated', 'unauthenticated', 'unknown'].includes(String(value.state))) {
    return invalidResult('auth.status result contains an invalid state or unsupported fields.')
  }
  const normalized: Record<string, unknown> = { state: value.state }
  if (value.plan !== undefined) {
    if (
      !isPlainRecord(value.plan) ||
      !hasExactKeys(value.plan, ['label', 'free']) ||
      !isVisibleLabel(value.plan.label) ||
      (typeof value.plan.free !== 'boolean' && value.plan.free !== null)
    ) {
      return invalidResult('auth.status plan must contain only a visible label and boolean-or-null free status.')
    }
    normalized.plan = { label: normalizeVisibleLabel(value.plan.label), free: value.plan.free }
  }
  if (value.usage !== undefined) {
    if (!Array.isArray(value.usage) || value.usage.length > 32) {
      return invalidResult('auth.status usage must be a bounded array of visible label/value rows.')
    }
    const usage: Array<{ label: string; value: string }> = []
    for (const row of value.usage) {
      if (
        !isPlainRecord(row) ||
        !hasExactKeys(row, ['label', 'value']) ||
        !isVisibleLabel(row.label) ||
        !isBoundedVisibleText(row.value, 500)
      ) {
        return invalidResult('auth.status usage contains an invalid or unsupported row.')
      }
      usage.push({ label: normalizeVisibleLabel(row.label), value: row.value.trim().normalize('NFKC') })
    }
    normalized.usage = usage
  }
  return { ok: true, value: normalized }
}

function normalizeChoiceResult(
  action: VisibleProviderAction,
  value: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!hasExactKeys(value, ['choices']) || !Array.isArray(value.choices) || value.choices.length > 100) {
    return invalidResult(`${action} result must contain only a bounded choices array.`)
  }
  const choices: VisibleProviderChoice[] = []
  for (const choice of value.choices) {
    if (
      !isPlainRecord(choice) ||
      !hasOnlyKeys(choice, ['label', 'selected', 'enabled', 'description']) ||
      !Object.hasOwn(choice, 'label') ||
      !Object.hasOwn(choice, 'selected') ||
      !Object.hasOwn(choice, 'enabled') ||
      !isVisibleLabel(choice.label) ||
      typeof choice.selected !== 'boolean' ||
      typeof choice.enabled !== 'boolean' ||
      (choice.description !== undefined && !isBoundedVisibleText(choice.description, 500))
    ) {
      return invalidResult(`${action} result contains an invalid visible choice.`)
    }
    choices.push({
      label: normalizeVisibleLabel(choice.label),
      selected: choice.selected,
      enabled: choice.enabled,
      ...(typeof choice.description === 'string'
        ? { description: choice.description.trim().normalize('NFKC') }
        : {}),
    })
  }
  return { ok: true, value: { choices } }
}

function invalidResult(message: string): { ok: false; message: string } {
  return { ok: false, message }
}

function validateAndNormalizePayload(
  action: VisibleProviderAction,
  payload: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | ValidationFailure {
  if (EMPTY_PAYLOAD_ACTIONS.has(action)) {
    return Object.keys(payload).length === 0
      ? { ok: true, value: {} }
      : invalid('invalid_visible_action_payload', `${action} does not accept payload fields.`)
  }
  if (action === VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT) {
    if (!hasOnlyKeys(payload, ['label', 'fallbacks']) || !isVisibleLabel(payload.label)) {
      return invalid('invalid_model_selection', 'model.select requires one exact visible model label.')
    }
    if (payload.fallbacks !== undefined) {
      if (
        !Array.isArray(payload.fallbacks) ||
        payload.fallbacks.length > 8 ||
        !payload.fallbacks.every(isVisibleLabel)
      ) {
        return invalid('invalid_model_selection', 'Model fallbacks must contain at most eight exact visible labels.')
      }
      const labels = [payload.label, ...payload.fallbacks].map((label) => normalizeVisibleLabel(label as string))
      if (new Set(labels).size !== labels.length) {
        return invalid('invalid_model_selection', 'Primary and fallback model labels must be unique.')
      }
    }
    return {
      ok: true,
      value: {
        label: normalizeVisibleLabel(payload.label as string),
        ...(Array.isArray(payload.fallbacks)
          ? { fallbacks: payload.fallbacks.map((label) => normalizeVisibleLabel(label as string)) }
          : {}),
      },
    }
  }
  if (
    action === VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT ||
    action === VISIBLE_PROVIDER_ACTIONS.CONNECTOR_SELECT ||
    action === VISIBLE_PROVIDER_ACTIONS.PROJECT_OPEN ||
    action === VISIBLE_PROVIDER_ACTIONS.HISTORY_OPEN
  ) {
    if (!hasExactKeys(payload, ['label']) || !isVisibleLabel(payload.label)) {
      return invalid('invalid_visible_selection', `${action} requires one exact visible label.`)
    }
    return { ok: true, value: { label: normalizeVisibleLabel(payload.label as string) } }
  }
  if (action === VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD || action === VISIBLE_PROVIDER_ACTIONS.SKILL_UPLOAD) {
    return validateUploadPayload(action, payload)
  }
  if (action === VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT || action === VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT) {
    if (
      !hasExactKeys(payload, ['text', 'mode']) ||
      typeof payload.text !== 'string' ||
      payload.text.trim().length === 0 ||
      new TextEncoder().encode(payload.text).byteLength > MAX_PROMPT_UTF8_BYTES ||
      payload.mode !== 'replace'
    ) {
      return invalid(
        'invalid_prompt_action',
        `${action} requires nonempty text up to ${MAX_PROMPT_UTF8_BYTES} UTF-8 bytes and mode "replace".`
      )
    }
    return { ok: true, value: { text: payload.text, mode: 'replace' } }
  }
  return invalid('unsupported_visible_action', 'Visible provider action has no payload contract.')
}

function validateUploadPayload(
  action: VisibleProviderAction,
  payload: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | ValidationFailure {
  if (!hasExactKeys(payload, ['attachments']) || !Array.isArray(payload.attachments) || payload.attachments.length < 1) {
    return invalid('invalid_visible_upload', `${action} requires a nonempty attachments array.`)
  }
  if (payload.attachments.length > MAX_VISIBLE_ATTACHMENTS) {
    return invalid('too_many_visible_uploads', `Visible upload may contain at most ${MAX_VISIBLE_ATTACHMENTS} files.`)
  }
  let bundleId: string | undefined
  let totalBytes = 0
  const attachmentIds = new Set<string>()
  const normalized: NativeAttachmentDescriptor[] = []
  for (const value of payload.attachments) {
    if (!isNativeAttachmentDescriptor(value)) {
      return invalid('invalid_visible_upload', 'Every visible upload descriptor must be path-free, valid, and contain no unknown fields.')
    }
    bundleId ??= value.bundleId
    if (value.bundleId !== bundleId) {
      return invalid('visible_upload_bundle_mismatch', 'Visible upload descriptors must share one bundleId.')
    }
    if (attachmentIds.has(value.attachmentId)) {
      return invalid('duplicate_visible_upload', 'Visible upload attachment identities must be unique.')
    }
    attachmentIds.add(value.attachmentId)
    totalBytes += value.size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES) {
      return invalid(
        'visible_upload_too_large',
        `Visible upload may contain at most ${MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES} bytes in total.`
      )
    }
    normalized.push({
      protocol: value.protocol,
      bundleId: value.bundleId,
      attachmentId: value.attachmentId,
      name: value.name,
      type: value.type,
      size: value.size,
      sha256: value.sha256,
    })
  }
  return { ok: true, value: { attachments: normalized } }
}

function normalizeCapability(
  action: VisibleProviderAction,
  declaration: VisibleProviderCapabilityDeclaration
): VisibleProviderActionCapability {
  if (!['verified', 'pending_evidence', 'unsupported'].includes(declaration.state)) {
    throw new TypeError(`${action} has an invalid capability state.`)
  }
  const evidence = declaration.evidence === undefined ? [] : [...declaration.evidence]
  if (!evidence.every(isEvidenceIdentifier) || new Set(evidence).size !== evidence.length) {
    throw new TypeError(`${action} evidence must contain unique bounded identifiers.`)
  }
  const reason = declaration.reason?.trim() || null
  if (declaration.state === 'verified' && evidence.length === 0) {
    throw new TypeError(`${action} requires DOM evidence before it can be verified.`)
  }
  if (declaration.state !== 'verified' && !reason) {
    throw new TypeError(`${action} requires a reason while it is not verified.`)
  }
  const constraints = normalizeCapabilityConstraints(action, declaration.constraints ?? {})
  return Object.freeze({
    state: declaration.state,
    requiresAuthentication: declaration.requiresAuthentication === true,
    evidence: Object.freeze(evidence),
    reason,
    constraints,
  })
}

function normalizeCapabilityConstraints(
  action: VisibleProviderAction,
  constraints: VisibleProviderCapabilityConstraints
): Readonly<VisibleProviderCapabilityConstraints> {
  if (!isPlainRecord(constraints) || !hasOnlyKeys(constraints, ['allowedLabels', 'maxItems', 'maxBytes'])) {
    throw new TypeError(`${action} contains invalid capability constraints.`)
  }
  const normalized: VisibleProviderCapabilityConstraints = {}
  if (constraints.allowedLabels !== undefined) {
    if (
      !Array.isArray(constraints.allowedLabels) ||
      constraints.allowedLabels.length < 1 ||
      constraints.allowedLabels.length > 100 ||
      !constraints.allowedLabels.every(isVisibleLabel)
    ) {
      throw new TypeError(`${action} allowedLabels are invalid.`)
    }
    const labels = constraints.allowedLabels.map(normalizeVisibleLabel)
    if (new Set(labels).size !== labels.length) throw new TypeError(`${action} allowedLabels must be unique.`)
    normalized.allowedLabels = Object.freeze(labels)
  }
  if (constraints.maxItems !== undefined) {
    if (!Number.isSafeInteger(constraints.maxItems) || constraints.maxItems < 1 || constraints.maxItems > MAX_VISIBLE_ATTACHMENTS) {
      throw new TypeError(`${action} maxItems is invalid.`)
    }
    normalized.maxItems = constraints.maxItems
  }
  if (constraints.maxBytes !== undefined) {
    if (!Number.isSafeInteger(constraints.maxBytes) || constraints.maxBytes < 1 || constraints.maxBytes > MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES) {
      throw new TypeError(`${action} maxBytes is invalid.`)
    }
    normalized.maxBytes = constraints.maxBytes
  }
  return Object.freeze(normalized)
}

function validateCapabilityConstraints(
  request: VisibleProviderActionRequest,
  constraints: Readonly<VisibleProviderCapabilityConstraints>
): ValidationFailure | null {
  const label = request.payload.label
  if (
    constraints.allowedLabels &&
    typeof label === 'string' &&
    (
      !constraints.allowedLabels.includes(label) ||
      (
        Array.isArray(request.payload.fallbacks) &&
        request.payload.fallbacks.some((fallback) => (
          typeof fallback !== 'string' || !constraints.allowedLabels?.includes(fallback)
        ))
      )
    )
  ) {
    return invalid('visible_action_choice_unavailable', 'Requested visible label is not declared by this provider capability.')
  }
  const attachments = request.payload.attachments
  if (Array.isArray(attachments)) {
    if (constraints.maxItems !== undefined && attachments.length > constraints.maxItems) {
      return invalid('visible_action_limit_exceeded', 'Visible upload exceeds the provider capability file-count limit.')
    }
    const totalBytes = attachments.reduce((total, value) => total + Number((value as NativeAttachmentDescriptor).size), 0)
    if (constraints.maxBytes !== undefined && totalBytes > constraints.maxBytes) {
      return invalid('visible_action_limit_exceeded', 'Visible upload exceeds the provider capability byte limit.')
    }
  }
  return null
}

function isVisibleLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_VISIBLE_LABEL_CHARS &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function isBoundedVisibleText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= maxChars &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function normalizeVisibleLabel(value: string) {
  return value.trim().normalize('NFKC')
}

function isEvidenceIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isBoundedIdentifier(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxChars && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function invalid(code: string, message: string): ValidationFailure {
  return { ok: false, error: { code, message, retryable: false } }
}

function normalizeError(error: Partial<VisibleProviderActionError> | undefined): VisibleProviderActionError {
  return {
    code: typeof error?.code === 'string' ? error.code : 'visible_action_failed',
    message: typeof error?.message === 'string' ? error.message : 'Visible provider action failed.',
    retryable: error?.retryable === true,
  }
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() ?? `visible-action-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
