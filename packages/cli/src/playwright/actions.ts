import { randomUUID } from 'node:crypto'
import {
  VISIBLE_ACTION_SCHEMA_ID,
  VISIBLE_ATTACHMENT_SCHEMA_ID,
} from '../schema-ids.js'
import {
  isVisibleAction,
  validateVisibleActionPayload,
} from '../providers/action-catalog.js'
import { VISIBLE_ACTIONS, isVisibleActionProtocolVersion } from '../providers/contracts.js'
import { tokenlessError } from './errors.js'
import { getProviderDescriptorById } from '../providers/registry.js'
import type {
  ProviderAccessClass,
  ProviderAccountTier,
  ProviderCapabilityId,
  ProviderCapabilityResourceKind,
  ProviderCapabilityStability,
  ProviderId,
} from '../providers/registry.js'

export {
  VISIBLE_ACTION_SCHEMA_ID,
  VISIBLE_ATTACHMENT_SCHEMA_ID,
} from '../schema-ids.js'
export { validateAttachmentInput } from '../providers/action-catalog.js'
export { VISIBLE_ACTIONS, isVisibleActionProtocolVersion } from '../providers/contracts.js'
export type {
  AttachmentInput,
  EmptyVisibleActionPayload,
  FileUploadActionRequest,
  FileUploadPayload,
  PromptInputActionRequest,
  PromptInputPayload,
  QwenModeInspectActionRequest,
  QwenModeSelectActionRequest,
  VisibleAction,
  VisibleActionPayloadForAction,
  VisibleActionProtocolVersion,
  VisibleActionRequest,
  VisibleActionRequestForAction,
  VisibleActionWireRequest,
  VisibleSelectionPayload,
  QwenModeSelectionPayload,
  DeepSeekMode,
  DeepSeekModeSelectionPayload,
  DeepSeekToggleSelectionPayload,
  WorkspaceEnsureActionRequest,
  WorkspaceEnsurePayload,
} from '../providers/contracts.js'

import type {
  AttachmentInput,
  DeepSeekMode,
  VisibleAction,
  VisibleActionProtocolVersion,
  VisibleActionRequest,
  VisibleActionWireRequest,
} from '../providers/contracts.js'

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
  access: ProviderAccessClass
  visibleProof: string
  account?: {
    name: string | null
    subscription: string | null
    tier: ProviderAccountTier
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
  actions?: readonly VisibleAction[]
  native: {
    resourceKind: ProviderCapabilityResourceKind | null
    availability: 'available' | 'unavailable' | 'unknown'
    visibleProof: string | null
    reason: string | null
    identity?: {
      provider: ProviderId
      canonicalUrl: string | null
    } | null
    updateInstructions?: {
      availability: 'available' | 'unavailable' | 'unknown'
      visibleProof: string | null
      reason: string | null
    }
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

export type QwenModeChoice = {
  mode: string
  enabled: boolean
  selected: boolean
}

export type QwenModeInspectResult = {
  supported: true
  active: {
    mode: string
    variant: string | null
  }
  modes: readonly QwenModeChoice[]
} | {
  supported: false
  reason: 'unsupported_by_provider' | 'selector_not_available'
}

export type QwenModeSelectResult = {
  supported: true
  selectedMode: string
  selectedVariant: string | null
  visibleProof: string
} | {
  supported: false
  reason: 'unsupported_by_provider' | 'selector_not_available' | 'exact_mode_not_found' | 'exact_variant_not_found'
}

export type DeepSeekModeChoice = {
  mode: DeepSeekMode
  enabled: boolean
  selected: boolean
  controls: {
    deepThink: boolean
    search: boolean
    fileUpload: boolean
    imageFileSelection: boolean
  }
}

export type DeepSeekModeInspectResult = {
  supported: true
  activeMode: DeepSeekMode
  modes: readonly DeepSeekModeChoice[]
} | {
  supported: false
  reason: 'unsupported_by_provider' | 'selector_not_available'
}

export type DeepSeekModeSelectResult = {
  supported: true
  selectedMode: DeepSeekMode
  visibleProof: string
} | {
  supported: false
  reason: 'unsupported_by_provider' | 'selector_not_available' | 'exact_mode_not_found'
}

export type DeepSeekToggleInspectResult = {
  supported: true
  activeMode: DeepSeekMode
  enabled: boolean
} | {
  supported: false
  activeMode: DeepSeekMode | null
  reason: 'unsupported_by_provider' | 'selector_not_available' | 'unavailable_in_mode'
}

export type DeepSeekToggleSelectResult = {
  supported: true
  activeMode: DeepSeekMode
  enabled: boolean
  visibleProof: string
} | {
  supported: false
  activeMode: DeepSeekMode | null
  reason: 'unsupported_by_provider' | 'selector_not_available' | 'unavailable_in_mode'
}

export type FileUploadResult = {
  acceptance: 'selected' | 'accepted'
  visibleProof: string
  attachments: readonly {
    protocol: typeof VISIBLE_ATTACHMENT_SCHEMA_ID
    bundleId: string
    attachmentId: string
    name: string
    type: string
    size: number
    sha256: string
    visible: true
  }[]
}

type WorkspaceInstructionOutcome =
  | 'not_requested'
  | 'applied_on_creation'
  | 'already_equivalent'
  | 'skipped_on_reuse'
  | 'unavailable'

type WorkspaceEnsureResultBase = {
  requestedMode: 'auto' | 'native' | 'conversation'
  resolvedMode: 'native' | 'conversation'
  name: string
  scope: {
    provider: ProviderId
    profileId: string
  }
  instructionOutcome: WorkspaceInstructionOutcome
  availability: 'available'
  visibleProof: string
  reason: string | null
}

export type NativeWorkspaceEnsureResult = WorkspaceEnsureResultBase & {
  mode: 'native'
  resolvedMode: 'native'
  identity: {
    provider: ProviderId
    name: string
    resourceId: string
    canonicalUrl: string
  }
  resource: {
    kind: 'project'
    native: true
    disposition: 'created' | 'reused'
    id: string
    canonicalUrl: string
  }
  native: {
    resourceKind: 'project'
    availability: 'available'
    canonicalUrl: string
    visibleProof: string
    reason: null
    updateInstructions: {
      availability: 'available' | 'unavailable'
      visibleProof: string | null
      reason: string | null
    }
  }
  updateInstructions: {
    availability: 'available' | 'unavailable'
    visibleProof: string | null
    reason: string | null
  }
  fallback: null
}

export type ConversationWorkspaceEnsureResult = WorkspaceEnsureResultBase & {
  mode: 'conversation'
  resolvedMode: 'conversation'
  identity: {
    provider: ProviderId
    name: string
    resourceId: null
    canonicalUrl: string | null
  }
  resource: {
    kind: 'conversation'
    native: false
    disposition: 'fallback'
    id: null
    canonicalUrl: string | null
  }
  native: {
    resourceKind: 'project'
    availability: 'unavailable'
    canonicalUrl: null
    visibleProof: null
    reason: string
    updateInstructions: {
      availability: 'unavailable'
      visibleProof: null
      reason: string
    }
  }
  updateInstructions: {
    availability: 'unavailable'
    visibleProof: null
    reason: string
  }
  fallback: {
    mode: 'conversation'
    resourceKind: 'conversation'
    availability: 'available'
  } | null
}

export type WorkspaceEnsureResult =
  | NativeWorkspaceEnsureResult
  | ConversationWorkspaceEnsureResult

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
  status: 'snapshotted'
  provider: ProviderId
  capturedAt: string
  url: string
  title: string
  sanitized: true
  includeText: false
  html: string
  selectorProbes: {
    composer: number
    authenticatedAccount: number
    login: number
    blocker: number
  }
  page: {
    origin: string
  }
  controls: readonly {
    tag: string
    role?: string
    inputType?: string
    dataTestId?: string
    ariaLabel?: string
    placeholder?: string
    text?: string
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
  family?: 'recaptcha' | 'cloudflare' | 'hcaptcha' | 'arkose' | 'provider_sign_in' | 'rate_limit' | 'plan_limit' | 'availability'
  retryAfterSeconds?: number | undefined
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
  | QwenModeInspectResult
  | QwenModeSelectResult
  | DeepSeekModeInspectResult
  | DeepSeekModeSelectResult
  | DeepSeekToggleInspectResult
  | DeepSeekToggleSelectResult
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
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function createVisibleActionRequest(
  input: Omit<Partial<VisibleActionWireRequest>, 'protocol'> & Record<string, unknown>
): VisibleActionRequest {
  return validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_SCHEMA_ID,
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
  const provider = getProviderDescriptorById(input.provider)
  if (!provider) {
    throw tokenlessError('unknown_visible_provider', 'Visible action provider is not supported.')
  }
  if (!isVisibleAction(input.action)) {
    throw tokenlessError('unknown_visible_action', 'Visible action is not supported.')
  }
  if (!isPlainRecord(input.payload)) {
    throw tokenlessError('invalid_visible_action_payload', 'Visible action payload must be an object.')
  }
  const action = input.action
  const payload = validateVisibleActionPayload(action, input.payload)
  return {
    protocol: input.protocol,
    requestId: input.requestId,
    provider: provider.id,
    action,
    payload,
  } as VisibleActionRequest
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
