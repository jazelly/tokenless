import { randomUUID } from 'node:crypto'
import { tokenlessError } from './errors.js'
import { getProviderById } from './providers.js'
import type { ProviderCapabilityId, ProviderCapabilityResourceKind, ProviderCapabilityStability, ProviderId } from './providers.js'

export const VISIBLE_ACTION_PROTOCOL_VERSION_V1 = 'tokenless.playwright.visible-action.v1' as const
export const VISIBLE_ACTION_PROTOCOL_VERSION_V2 = 'tokenless.playwright.visible-action.v2' as const
export const VISIBLE_ACTION_PROTOCOL_VERSION = VISIBLE_ACTION_PROTOCOL_VERSION_V2
export const VISIBLE_ATTACHMENT_PROTOCOL_VERSION = 'tokenless.visible-attachment.v1' as const

export type VisibleActionProtocolVersion =
  | typeof VISIBLE_ACTION_PROTOCOL_VERSION_V1
  | typeof VISIBLE_ACTION_PROTOCOL_VERSION_V2

export function isVisibleActionProtocolVersion(value: unknown): value is VisibleActionProtocolVersion {
  return value === VISIBLE_ACTION_PROTOCOL_VERSION_V1 || value === VISIBLE_ACTION_PROTOCOL_VERSION_V2
}

export const VISIBLE_ACTIONS = Object.freeze({
  CAPABILITY_INSPECT: 'capability.inspect',
  AUTH_STATUS: 'auth.status',
  MODEL_INSPECT: 'model.inspect',
  MODEL_SELECT: 'model.select',
  EFFORT_INSPECT: 'effort.inspect',
  EFFORT_SELECT: 'effort.select',
  FILE_UPLOAD: 'file.upload',
  WORKSPACE_ENSURE: 'workspace.ensure',
  PROMPT_INPUT: 'prompt.input',
  PROMPT_CLEAR: 'prompt.clear',
  PROMPT_SUBMIT: 'prompt.submit',
  RESPONSE_READ: 'response.read',
  SNAPSHOT_SANITIZED: 'snapshot.sanitized',
  NAVIGATION_CHECK: 'navigation.check',
  BLOCKER_CHECK: 'blocker.check',
})

export type VisibleAction = typeof VISIBLE_ACTIONS[keyof typeof VISIBLE_ACTIONS]

export type VisibleActionRequest = {
  protocol: VisibleActionProtocolVersion
  requestId: string
  provider: ProviderId
  action: VisibleAction
  payload: Record<string, unknown>
}

export type VisibleActionError = {
  code: string
  message: string
  retryable: boolean
}

export type VisibleActionResponse =
  | {
    protocol: VisibleActionProtocolVersion
    requestId: string
    provider: ProviderId
    action: VisibleAction
    ok: true
    result: VisibleActionResult
    error: null
  }
  | {
    protocol: VisibleActionProtocolVersion
    requestId: string | null
    provider: ProviderId | null
    action: VisibleAction | null
    ok: false
    result: null
    error: VisibleActionError
  }

export type AuthStatusResult = {
  state: 'authenticated' | 'unauthenticated' | 'unknown'
  visibleProof: string
  account?: {
    name: string | null
    subscription: string | null
    subscriptionEvidence: {
      status: 'observed' | 'derived' | 'unknown'
      source: string | null
    }
  }
}

export type CapabilityInspectResult = {
  visibleProof: string
  capabilities: Readonly<Record<ProviderCapabilityId, ProviderCapabilityInspection>>
}

export type ProviderCapabilityInspection = {
  capability: ProviderCapabilityId
  availability: 'available' | 'unavailable' | 'unknown'
  visibleProof: string
  reason: string | null
  native: {
    resourceKind: ProviderCapabilityResourceKind | null
    availability: 'available' | 'unavailable' | 'unknown'
    visibleProof: string | null
    reason: string | null
  }
  fallback: {
    resourceKind: ProviderCapabilityResourceKind | null
    availability: 'available' | 'unavailable' | 'unknown'
    mode: 'conversation' | null
    visibleProof: string | null
    reason: string | null
  }
  stability: ProviderCapabilityStability
}

export type Choice = {
  label: string
  selected: boolean
  enabled: boolean
  description?: string
}

export type ChoiceInspectResult = {
  supported: true
  choices: readonly Choice[]
} | {
  supported: false
  reason: 'unsupported_by_provider' | 'selector_not_available'
}

export type ChoiceSelectResult = {
  supported: true
  selectedLabel: string
  visibleProof: string
} | {
  supported: false
  reason: 'unsupported_by_provider'
}

export type FileUploadResult = {
  acceptance: 'selected' | 'accepted'
  visibleProof: string
  attachments: readonly {
    protocol: typeof VISIBLE_ATTACHMENT_PROTOCOL_VERSION
    bundleId: string
    attachmentId: string
    name: string
    type: string
    size: number
    sha256: string
    visible: true
  }[]
}

export type WorkspaceEnsureResult = {
  mode: 'conversation'
  requestedMode: 'auto' | 'conversation'
  name: string
  resource: {
    kind: 'conversation' | null
    native: false
  }
  availability: 'available' | 'unavailable'
  visibleProof: string
  reason: string | null
  fallback: {
    mode: 'conversation'
    resourceKind: 'conversation'
    availability: 'available'
  } | null
}

export type PromptInputResult = {
  visible: true
  inputProof: string
}

export type PromptClearResult = {
  visible: true
  inputProof: 'empty'
}

export type PromptSubmitResult = {
  visible: true
  submissionProof: string
}

export type ResponseReadResult = {
  text: string
  citations: readonly VisibleCitation[]
  visibleProof: string
}

export type VisibleCitation = {
  label: string
  href: string
}

export type SnapshotResult = {
  page: {
    origin: string
  }
  controls: readonly {
    tag: string
    role?: string
    inputType?: string
    disabled: boolean
    visible: boolean
  }[]
}

export type NavigationCheckResult = {
  allowed: boolean
  provider: ProviderId | null
  reason: string | null
}

export type VisibleBlocker = {
  kind: 'challenge' | 'auth' | 'terminal'
  code: string
  message: string
  userResolvable: boolean
  retryable: boolean
  visibleProof: string
  provider: ProviderId
  url: string
  family?: 'recaptcha' | 'cloudflare' | 'hcaptcha' | 'arkose' | 'provider_sign_in' | 'rate_limit' | 'plan_limit'
}

export type BlockerCheckResult = {
  blocked: boolean
  reasons: readonly string[]
  blockers: readonly VisibleBlocker[]
}

type VisibleActionResultBase = {
  availability?: 'available' | 'unavailable' | 'unknown'
  reason?: string | null
}

export type VisibleActionResult = (
  | CapabilityInspectResult
  | AuthStatusResult
  | ChoiceInspectResult
  | ChoiceSelectResult
  | FileUploadResult
  | WorkspaceEnsureResult
  | PromptInputResult
  | PromptClearResult
  | PromptSubmitResult
  | ResponseReadResult
  | SnapshotResult
  | NavigationCheckResult
  | BlockerCheckResult
) & VisibleActionResultBase

export type AttachmentInput = {
  protocol: typeof VISIBLE_ATTACHMENT_PROTOCOL_VERSION
  bundleId: string
  attachmentId: string
  name: string
  type: string
  size: number
  sha256: string
}

const ACTIONS = Object.freeze(Object.values(VISIBLE_ACTIONS)) as readonly VisibleAction[]
const ACTION_SET = new Set<string>(ACTIONS)
const LEGACY_V1_ACTIONS = new Set<string>([
  VISIBLE_ACTIONS.AUTH_STATUS,
  VISIBLE_ACTIONS.MODEL_INSPECT,
  VISIBLE_ACTIONS.MODEL_SELECT,
  VISIBLE_ACTIONS.EFFORT_INSPECT,
  VISIBLE_ACTIONS.EFFORT_SELECT,
  VISIBLE_ACTIONS.FILE_UPLOAD,
  VISIBLE_ACTIONS.PROMPT_INPUT,
  VISIBLE_ACTIONS.PROMPT_CLEAR,
  VISIBLE_ACTIONS.PROMPT_SUBMIT,
  VISIBLE_ACTIONS.RESPONSE_READ,
  VISIBLE_ACTIONS.SNAPSHOT_SANITIZED,
  VISIBLE_ACTIONS.NAVIGATION_CHECK,
  VISIBLE_ACTIONS.BLOCKER_CHECK,
])
const EMPTY_PAYLOAD_ACTIONS = new Set<VisibleAction>([
  VISIBLE_ACTIONS.CAPABILITY_INSPECT,
  VISIBLE_ACTIONS.AUTH_STATUS,
  VISIBLE_ACTIONS.MODEL_INSPECT,
  VISIBLE_ACTIONS.EFFORT_INSPECT,
  VISIBLE_ACTIONS.PROMPT_CLEAR,
  VISIBLE_ACTIONS.PROMPT_SUBMIT,
  VISIBLE_ACTIONS.RESPONSE_READ,
  VISIBLE_ACTIONS.SNAPSHOT_SANITIZED,
  VISIBLE_ACTIONS.NAVIGATION_CHECK,
  VISIBLE_ACTIONS.BLOCKER_CHECK,
])
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const LABEL_MAX_BYTES = 512
const PROMPT_MAX_BYTES = 1024 * 1024
const WORKSPACE_TEXT_MAX_BYTES = 32 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function createVisibleActionRequest(
  input: Omit<Partial<VisibleActionRequest>, 'protocol'> & Record<string, unknown>
): VisibleActionRequest {
  return validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
    requestId: typeof input.requestId === 'string' ? input.requestId : randomUUID(),
    provider: input.provider,
    action: input.action,
    payload: isPlainRecord(input.payload) ? input.payload : {},
  })
}

export function validateVisibleActionRequest(input: unknown): VisibleActionRequest {
  if (!isPlainRecord(input)) {
    throw tokenlessError('invalid_visible_action_request', 'Visible action request must be an object.')
  }
  requireExactKeys(input, ['protocol', 'requestId', 'provider', 'action', 'payload'], 'invalid_visible_action_request')
  if (!isVisibleActionProtocolVersion(input.protocol)) {
    throw tokenlessError('invalid_visible_action_protocol', 'Visible action protocol version is not supported.')
  }
  if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) {
    throw tokenlessError('invalid_visible_action_request_id', 'Visible action request id is invalid.')
  }
  const provider = getProviderById(input.provider)
  if (!provider) {
    throw tokenlessError('unknown_visible_provider', 'Visible action provider is not supported.')
  }
  if (typeof input.action !== 'string' || !ACTION_SET.has(input.action)) {
    throw tokenlessError('unknown_visible_action', 'Visible action is not supported.')
  }
  if (input.protocol === VISIBLE_ACTION_PROTOCOL_VERSION_V1 && !LEGACY_V1_ACTIONS.has(input.action)) {
    throw tokenlessError('invalid_visible_action_protocol', 'Visible action requires visible action protocol v2.')
  }
  if (!isPlainRecord(input.payload)) {
    throw tokenlessError('invalid_visible_action_payload', 'Visible action payload must be an object.')
  }
  validatePayload(input.action as VisibleAction, input.payload)
  return {
    protocol: input.protocol,
    requestId: input.requestId,
    provider: provider.id,
    action: input.action as VisibleAction,
    payload: input.payload,
  }
}

export function validateAttachmentInput(input: unknown): AttachmentInput {
  if (!isPlainRecord(input)) throw tokenlessError('invalid_visible_attachment', 'Attachment descriptor must be an object.')
  requireExactKeys(input, ['protocol', 'bundleId', 'attachmentId', 'name', 'type', 'size', 'sha256'], 'invalid_visible_attachment')
  if (input.protocol !== VISIBLE_ATTACHMENT_PROTOCOL_VERSION) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment protocol is invalid.')
  }
  if (typeof input.bundleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.bundleId)) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment bundle id is invalid.')
  }
  if (typeof input.attachmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.attachmentId)) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment id is invalid.')
  }
  if (typeof input.name !== 'string' || input.name.length < 1 || Buffer.byteLength(input.name, 'utf8') > 255 || /[/\\\u0000-\u001f\u007f]/.test(input.name)) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment name is invalid.')
  }
  if (typeof input.type !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(input.type)) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment media type is invalid.')
  }
  if (typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > 512 * 1024 * 1024) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment size is invalid.')
  }
  if (typeof input.sha256 !== 'string' || !SHA256_PATTERN.test(input.sha256)) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment sha256 is invalid.')
  }
  return input as AttachmentInput
}

function validatePayload(action: VisibleAction, payload: Record<string, unknown>) {
  if (EMPTY_PAYLOAD_ACTIONS.has(action)) {
    requireExactKeys(payload, [], 'invalid_visible_action_payload')
    return
  }
  if (action === VISIBLE_ACTIONS.MODEL_SELECT || action === VISIBLE_ACTIONS.EFFORT_SELECT) {
    requireExactKeys(payload, ['label'], 'invalid_visible_action_payload')
    validateVisibleLabel(payload.label)
    return
  }
  if (action === VISIBLE_ACTIONS.WORKSPACE_ENSURE) {
    validateWorkspaceEnsurePayload(payload)
    return
  }
  if (action === VISIBLE_ACTIONS.PROMPT_INPUT) {
    requireExactKeys(payload, ['text'], 'invalid_visible_action_payload')
    if (typeof payload.text !== 'string' || Buffer.byteLength(payload.text, 'utf8') > PROMPT_MAX_BYTES) {
      throw tokenlessError('invalid_visible_prompt', 'Prompt text is invalid or too large.')
    }
    return
  }
  if (action === VISIBLE_ACTIONS.FILE_UPLOAD) {
    requireExactKeys(payload, ['attachments'], 'invalid_visible_action_payload')
    if (!Array.isArray(payload.attachments) || payload.attachments.length < 1 || payload.attachments.length > 100) {
      throw tokenlessError('invalid_visible_attachment', 'File upload requires one to one hundred attachments.')
    }
    for (const attachment of payload.attachments) validateAttachmentInput(attachment)
    return
  }
  throw tokenlessError('unknown_visible_action', 'Visible action is not supported.')
}

function validateWorkspaceEnsurePayload(payload: Record<string, unknown>) {
  const keys = Object.keys(payload)
  const expected = new Set(['name', 'mode', 'instructions'])
  if (
    (keys.length !== 2 && keys.length !== 3) ||
    !keys.every((key) => expected.has(key)) ||
    !Object.hasOwn(payload, 'name') ||
    !Object.hasOwn(payload, 'mode')
  ) {
    throw tokenlessError('invalid_visible_action_payload', 'Expected exact keys: name, mode, optional instructions.')
  }
  validateWorkspaceText(payload.name, 'invalid_visible_workspace_name', 'Workspace name is invalid or too large.')
  if (payload.mode !== 'auto' && payload.mode !== 'native' && payload.mode !== 'conversation') {
    throw tokenlessError('invalid_visible_workspace_mode', 'Workspace ensure mode is invalid.')
  }
  if (Object.hasOwn(payload, 'instructions')) {
    validateWorkspaceText(payload.instructions, 'invalid_visible_workspace_instructions', 'Workspace instructions are invalid or too large.')
  }
}

function validateWorkspaceText(value: unknown, code: string, message: string) {
  if (
    typeof value !== 'string' ||
    !/\S/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > WORKSPACE_TEXT_MAX_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw tokenlessError(code, message)
  }
}

function validateVisibleLabel(value: unknown) {
  if (typeof value !== 'string' || !/\S/u.test(value) || Buffer.byteLength(value, 'utf8') > LABEL_MAX_BYTES) {
    throw tokenlessError('invalid_visible_label', 'Visible selection label is invalid.')
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw tokenlessError('invalid_visible_label', 'Visible selection label contains control characters.')
  }
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], code: string) {
  const expected = new Set(keys)
  const actual = Object.keys(record)
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw tokenlessError(code, `Expected exact keys: ${keys.join(', ') || '(none)'}.`)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
