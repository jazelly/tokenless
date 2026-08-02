import {
  VISIBLE_ACTION_SCHEMA_ID_V3,
  VISIBLE_ATTACHMENT_SCHEMA_ID,
} from '../schema-ids.js'
import type { ProviderId } from './provider-identity.js'

export type VisibleActionProtocolVersion = typeof VISIBLE_ACTION_SCHEMA_ID_V3

export function isVisibleActionProtocolVersion(value: unknown): value is VisibleActionProtocolVersion {
  return value === VISIBLE_ACTION_SCHEMA_ID_V3
}

export const VISIBLE_ACTIONS = Object.freeze({
  CAPABILITY_INSPECT: 'capability.inspect',
  AUTH_STATUS: 'auth.status',
  MODEL_INSPECT: 'model.inspect',
  MODEL_SELECT: 'model.select',
  EFFORT_INSPECT: 'effort.inspect',
  EFFORT_SELECT: 'effort.select',
  QWEN_MODE_INSPECT: 'qwen.mode.inspect',
  QWEN_MODE_SELECT: 'qwen.mode.select',
  DEEPSEEK_MODE_INSPECT: 'deepseek.mode.inspect',
  DEEPSEEK_MODE_SELECT: 'deepseek.mode.select',
  DEEPSEEK_DEEPTHINK_INSPECT: 'deepseek.deepthink.inspect',
  DEEPSEEK_DEEPTHINK_SELECT: 'deepseek.deepthink.select',
  DEEPSEEK_SEARCH_INSPECT: 'deepseek.search.inspect',
  DEEPSEEK_SEARCH_SELECT: 'deepseek.search.select',
  DOUBAO_MODE_INSPECT: 'doubao.mode.inspect',
  DOUBAO_MODE_SELECT: 'doubao.mode.select',
  DOUBAO_SKILL_INSPECT: 'doubao.skill.inspect',
  DOUBAO_SKILL_SELECT: 'doubao.skill.select',
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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type ProviderActionPreparation<Action extends VisibleAction = VisibleAction> = Readonly<{
  provider: ProviderId
  action: Action
  schema: string
  value: JsonValue
}>

export type ProviderActionObservation = Readonly<{
  state: 'pending' | 'ready'
}>

export type AttachmentInput = {
  protocol: typeof VISIBLE_ATTACHMENT_SCHEMA_ID
  bundleId: string
  attachmentId: string
  name: string
  type: string
  size: number
  sha256: string
}

export type EmptyVisibleActionPayload = Record<string, never>
export type VisibleSelectionPayload = {
  label: string
}
export type QwenModeSelectionPayload = {
  mode: string
  variant?: string
}
export type DeepSeekMode = 'Instant' | 'Expert' | 'Vision'
export type DeepSeekModeSelectionPayload = {
  mode: DeepSeekMode
}
export type DeepSeekToggleSelectionPayload = {
  enabled: boolean
}
export type DoubaoMode = 'fast' | 'expert' | 'work-task-turbo' | 'work-task-pro'
export type DoubaoModeSelectionPayload = {
  mode: DoubaoMode
}
export type DoubaoSkill =
  | 'chat'
  | 'document-writing'
  | 'presentation-generation'
  | 'image-generation'
  | 'video-generation'
  | 'deep-research'
  | 'audio-podcast'
  | 'music-generation'
  | 'problem-solving'
  | 'spreadsheet-generation'
  | 'audio-transcription'
export type DoubaoSkillSelectionPayload = {
  skill: DoubaoSkill
}
export type FileUploadPayload = {
  attachments: readonly AttachmentInput[]
}
export type WorkspaceEnsurePayload = {
  name: string
  mode: 'auto' | 'native' | 'conversation'
  instructions?: string
}
export type PromptInputPayload = {
  text: string
}

export type VisibleActionRequestEnvelope<
  Action extends VisibleAction = VisibleAction,
  Payload extends object = Record<string, unknown>,
> = {
  protocol: VisibleActionProtocolVersion
  requestId: string
  provider: ProviderId
  action: Action
  payload: Payload
}

export type CapabilityInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.CAPABILITY_INSPECT,
  EmptyVisibleActionPayload
>
export type AuthStatusActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.AUTH_STATUS,
  EmptyVisibleActionPayload
>
export type ModelInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.MODEL_INSPECT,
  EmptyVisibleActionPayload
>
export type ModelSelectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.MODEL_SELECT,
  VisibleSelectionPayload
>
export type EffortInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.EFFORT_INSPECT,
  EmptyVisibleActionPayload
>
export type EffortSelectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.EFFORT_SELECT,
  VisibleSelectionPayload
>
export type QwenModeInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.QWEN_MODE_INSPECT,
  EmptyVisibleActionPayload
>
export type QwenModeSelectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.QWEN_MODE_SELECT,
  QwenModeSelectionPayload
>
export type DeepSeekModeInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DEEPSEEK_MODE_INSPECT,
  EmptyVisibleActionPayload
>
export type DeepSeekModeSelectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DEEPSEEK_MODE_SELECT,
  DeepSeekModeSelectionPayload
>
export type DeepSeekDeepThinkInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_INSPECT,
  EmptyVisibleActionPayload
>
export type DeepSeekDeepThinkSelectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_SELECT,
  DeepSeekToggleSelectionPayload
>
export type DeepSeekSearchInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DEEPSEEK_SEARCH_INSPECT,
  EmptyVisibleActionPayload
>
export type DeepSeekSearchSelectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DEEPSEEK_SEARCH_SELECT,
  DeepSeekToggleSelectionPayload
>
export type DoubaoModeInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DOUBAO_MODE_INSPECT,
  EmptyVisibleActionPayload
>
export type DoubaoModeSelectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DOUBAO_MODE_SELECT,
  DoubaoModeSelectionPayload
>
export type DoubaoSkillInspectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DOUBAO_SKILL_INSPECT,
  EmptyVisibleActionPayload
>
export type DoubaoSkillSelectActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT,
  DoubaoSkillSelectionPayload
>
export type FileUploadActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.FILE_UPLOAD,
  FileUploadPayload
>
export type WorkspaceEnsureActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.WORKSPACE_ENSURE,
  WorkspaceEnsurePayload
>
export type PromptInputActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.PROMPT_INPUT,
  PromptInputPayload
>
export type PromptClearActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.PROMPT_CLEAR,
  EmptyVisibleActionPayload
>
export type PromptSubmitActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.PROMPT_SUBMIT,
  EmptyVisibleActionPayload
>
export type ResponseReadActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.RESPONSE_READ,
  EmptyVisibleActionPayload
>
export type SnapshotSanitizedActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.SNAPSHOT_SANITIZED,
  EmptyVisibleActionPayload
>
export type NavigationCheckActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.NAVIGATION_CHECK,
  EmptyVisibleActionPayload
>
export type BlockerCheckActionRequest = VisibleActionRequestEnvelope<
  typeof VISIBLE_ACTIONS.BLOCKER_CHECK,
  EmptyVisibleActionPayload
>

export type VisibleActionRequest =
  | CapabilityInspectActionRequest
  | AuthStatusActionRequest
  | ModelInspectActionRequest
  | ModelSelectActionRequest
  | EffortInspectActionRequest
  | EffortSelectActionRequest
  | QwenModeInspectActionRequest
  | QwenModeSelectActionRequest
  | DeepSeekModeInspectActionRequest
  | DeepSeekModeSelectActionRequest
  | DeepSeekDeepThinkInspectActionRequest
  | DeepSeekDeepThinkSelectActionRequest
  | DeepSeekSearchInspectActionRequest
  | DeepSeekSearchSelectActionRequest
  | DoubaoModeInspectActionRequest
  | DoubaoModeSelectActionRequest
  | DoubaoSkillInspectActionRequest
  | DoubaoSkillSelectActionRequest
  | FileUploadActionRequest
  | WorkspaceEnsureActionRequest
  | PromptInputActionRequest
  | PromptClearActionRequest
  | PromptSubmitActionRequest
  | ResponseReadActionRequest
  | SnapshotSanitizedActionRequest
  | NavigationCheckActionRequest
  | BlockerCheckActionRequest

export type VisibleActionWireRequest = VisibleActionRequestEnvelope<VisibleAction, Record<string, unknown>>
export type VisibleActionRequestForAction<Action extends VisibleAction> = Extract<VisibleActionRequest, { action: Action }>
export type VisibleActionPayloadForAction<Action extends VisibleAction> = VisibleActionRequestForAction<Action>['payload']

const MAX_PREPARATION_JSON_BYTES = 4096
const MAX_PREPARATION_JSON_DEPTH = 8
const MAX_PREPARATION_ARRAY_LENGTH = 64
const MAX_PREPARATION_OBJECT_KEYS = 32
const MAX_PREPARATION_KEY_LENGTH = 128
const MAX_PREPARATION_STRING_LENGTH = 2048
const UNSAFE_PREPARATION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function validateProviderActionPreparation(
  input: unknown,
  expected: {
    provider: ProviderId
    action: VisibleAction
    schema: string
  },
): ProviderActionPreparation {
  if (!isPlainRecord(input)) throw new Error('Provider action preparation must be an object.')
  if (!hasExactKeys(input, ['provider', 'action', 'schema', 'value'])) {
    throw new Error('Provider action preparation fields are invalid.')
  }
  if (input.provider !== expected.provider || input.action !== expected.action || input.schema !== expected.schema) {
    throw new Error('Provider action preparation target is invalid.')
  }
  const value = validateBoundedJsonValue(input.value)
  const preparation = Object.freeze({
    provider: input.provider,
    action: input.action,
    schema: input.schema,
    value,
  }) as ProviderActionPreparation
  const bytes = Buffer.byteLength(JSON.stringify(preparation), 'utf8')
  if (bytes > MAX_PREPARATION_JSON_BYTES) {
    throw new Error('Provider action preparation is too large.')
  }
  return preparation
}

export function validateBoundedJsonValue(input: unknown): JsonValue {
  const seen = new WeakSet<object>()
  return validateBoundedJsonValueAt(input, 0, seen)
}

function validateBoundedJsonValueAt(input: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (depth > MAX_PREPARATION_JSON_DEPTH) throw new Error('JSON value is too deep.')
  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    if (typeof input === 'string' && input.length > MAX_PREPARATION_STRING_LENGTH) {
      throw new Error('JSON string value is too large.')
    }
    return input
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('JSON number value is invalid.')
    return input
  }
  if (Array.isArray(input)) {
    if (input.length > MAX_PREPARATION_ARRAY_LENGTH) throw new Error('JSON array value is too large.')
    if (seen.has(input)) throw new Error('JSON value must not contain cycles.')
    seen.add(input)
    return Object.freeze(input.map((entry) => validateBoundedJsonValueAt(entry, depth + 1, seen)))
  }
  if (!isPlainRecord(input)) throw new Error('JSON value is invalid.')
  if (seen.has(input)) throw new Error('JSON value must not contain cycles.')
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length > MAX_PREPARATION_OBJECT_KEYS) throw new Error('JSON object value has too many keys.')
  const output: Record<string, JsonValue> = {}
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_PREPARATION_KEY_LENGTH || UNSAFE_PREPARATION_KEYS.has(key)) {
      throw new Error('JSON object key is invalid.')
    }
    output[key] = validateBoundedJsonValueAt(value, depth + 1, seen)
  }
  return Object.freeze(output)
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(input).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}
