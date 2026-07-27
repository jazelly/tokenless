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
  VisibleAction,
  VisibleActionPayloadForAction,
  VisibleActionProtocolVersion,
  VisibleActionRequest,
  VisibleActionRequestForAction,
  VisibleActionWireRequest,
  VisibleSelectionPayload,
  WorkspaceEnsureActionRequest,
  WorkspaceEnsurePayload,
} from '../providers/contracts.js'

import type {
  AttachmentInput,
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

export type WorkspaceEnsureResult = {
  mode: 'conversation'
  requestedMode: 'auto' | 'native' | 'conversation'
  name: string
  identity: {
    provider: ProviderId
    name: string
    canonicalUrl: string | null
  }
  resource: {
    kind: 'conversation' | null
    native: false
  }
  native: {
    resourceKind: 'project'
    availability: 'unavailable'
    canonicalUrl: string | null
    visibleProof: string | null
    reason: string
    updateInstructions: {
      availability: 'unavailable'
      visibleProof: string | null
      reason: string
    }
  }
  updateInstructions: {
    availability: 'unavailable'
    visibleProof: string | null
    reason: string
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
