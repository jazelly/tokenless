import { VISIBLE_ATTACHMENT_SCHEMA_ID } from '../schema-ids.js'
import { tokenlessError } from '../browser/errors.js'
import { PROVIDER_CAPABILITIES } from './provider-identity.js'
import { VISIBLE_ACTIONS } from './contracts.js'
import type { ProviderCapabilityId } from './provider-identity.js'
import type {
  AttachmentInput,
  ArenaSurfaceSelectionPayload,
  GrokImagineSelectionPayload,
  GeminiImageSelectionPayload,
  DolaImageSelectionPayload,
  EmptyVisibleActionPayload,
  FileUploadPayload,
  PromptInputPayload,
  VisibleAction,
  VisibleActionPayloadForAction,
  VisibleSelectionPayload,
  QwenModeSelectionPayload,
  DeepSeekModeSelectionPayload,
  DeepSeekToggleSelectionPayload,
  DoubaoModeSelectionPayload,
  DoubaoSkillSelectionPayload,
  KimiSearchSelectionPayload,
  WorkspaceEnsurePayload,
} from './contracts.js'

export type VisibleActionCompletion = 'immediate' | 'records_submission' | 'reads_response'

export type VisibleActionLifecycle = {
  readonly gated: boolean
  readonly mutating: boolean
  readonly reconstructablePreSubmit: boolean
  readonly completion: VisibleActionCompletion
}

export type VisibleActionCatalogDefinition<Action extends VisibleAction = VisibleAction> = {
  readonly action: Action
  readonly lifecycle: VisibleActionLifecycle
  readonly requiredCapabilities: readonly ProviderCapabilityId[]
  validatePayload(payload: Record<string, unknown>): VisibleActionPayloadForAction<Action>
}

const immediateReadOnly = Object.freeze({
  gated: false,
  mutating: false,
  reconstructablePreSubmit: false,
  completion: 'immediate',
} satisfies VisibleActionLifecycle)

const gatedReadOnly = Object.freeze({
  gated: true,
  mutating: false,
  reconstructablePreSubmit: false,
  completion: 'immediate',
} satisfies VisibleActionLifecycle)

const gatedMutation = Object.freeze({
  gated: true,
  mutating: true,
  reconstructablePreSubmit: false,
  completion: 'immediate',
} satisfies VisibleActionLifecycle)

const reconstructableGatedMutation = Object.freeze({
  gated: true,
  mutating: true,
  reconstructablePreSubmit: true,
  completion: 'immediate',
} satisfies VisibleActionLifecycle)

const submitLifecycle = Object.freeze({
  gated: true,
  mutating: true,
  reconstructablePreSubmit: false,
  completion: 'records_submission',
} satisfies VisibleActionLifecycle)

const responseReadLifecycle = Object.freeze({
  gated: true,
  mutating: false,
  reconstructablePreSubmit: false,
  completion: 'reads_response',
} satisfies VisibleActionLifecycle)

export const VISIBLE_ACTION_CATALOG = Object.freeze({
  [VISIBLE_ACTIONS.GITHUB_COPILOT_MODE_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.GITHUB_COPILOT_MODE_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GITHUB_COPILOT_MODE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.GITHUB_COPILOT_MODE_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.GITHUB_COPILOT_MODE_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GITHUB_COPILOT_MODE],
    validatePayload(payload) {
      if (payload.mode !== 'ask' && payload.mode !== 'agent') {
        throw tokenlessError('invalid_github_copilot_mode', 'GitHub Copilot mode must be ask or agent.', { retryable: false })
      }
      return { mode: payload.mode }
    },
  }),
  [VISIBLE_ACTIONS.GITHUB_COPILOT_REPOSITORY_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.GITHUB_COPILOT_REPOSITORY_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GITHUB_COPILOT_REPOSITORY],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.GITHUB_COPILOT_REPOSITORY_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.GITHUB_COPILOT_REPOSITORY_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GITHUB_COPILOT_REPOSITORY],
    validatePayload: validateSelectionPayload,
  }),
  [VISIBLE_ACTIONS.GITHUB_COPILOT_USAGE_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.GITHUB_COPILOT_USAGE_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GITHUB_COPILOT_USAGE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.CAPABILITY_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.CAPABILITY_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.CAPABILITY_INSPECT],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.AUTH_STATUS]: defineAction({
    action: VISIBLE_ACTIONS.AUTH_STATUS,
    lifecycle: immediateReadOnly,
    requiredCapabilities: [],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.MODEL_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.MODEL_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.MODEL_CHOICE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.MODEL_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.MODEL_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.MODEL_CHOICE],
    validatePayload: validateSelectionPayload,
  }),
  [VISIBLE_ACTIONS.ARENA_SURFACE_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.ARENA_SURFACE_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.ARENA_SURFACE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.ARENA_SURFACE_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.ARENA_SURFACE_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.ARENA_SURFACE],
    validatePayload: validateArenaSurfaceSelectionPayload,
  }),
  [VISIBLE_ACTIONS.GROK_IMAGINE_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.GROK_IMAGINE_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GROK_IMAGINE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.GROK_IMAGINE_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.GROK_IMAGINE_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GROK_IMAGINE],
    validatePayload: validateGrokImagineSelectionPayload,
  }),
  [VISIBLE_ACTIONS.GEMINI_IMAGE_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.GEMINI_IMAGE_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GEMINI_IMAGE_SURFACE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.GEMINI_IMAGE_SURFACE],
    validatePayload: validateGeminiImageSelectionPayload,
  }),
  [VISIBLE_ACTIONS.DOLA_IMAGE_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.DOLA_IMAGE_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DOLA_IMAGE_SURFACE],
    validatePayload: validateDolaImageSelectionPayload,
  }),
  [VISIBLE_ACTIONS.EFFORT_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.EFFORT_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.EFFORT_CHOICE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.EFFORT_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.EFFORT_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.EFFORT_CHOICE],
    validatePayload: validateSelectionPayload,
  }),
  [VISIBLE_ACTIONS.QWEN_MODE_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.QWEN_MODE_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.QWEN_MODE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.QWEN_MODE_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.QWEN_MODE_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.QWEN_MODE],
    validatePayload: validateQwenModeSelectionPayload,
  }),
  [VISIBLE_ACTIONS.DEEPSEEK_MODE_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.DEEPSEEK_MODE_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DEEPSEEK_MODE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.DEEPSEEK_MODE_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.DEEPSEEK_MODE_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DEEPSEEK_MODE],
    validatePayload: validateDeepSeekModeSelectionPayload,
  }),
  [VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DEEPSEEK_DEEPTHINK],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DEEPSEEK_DEEPTHINK],
    validatePayload: validateDeepSeekToggleSelectionPayload,
  }),
  [VISIBLE_ACTIONS.DEEPSEEK_SEARCH_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.DEEPSEEK_SEARCH_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DEEPSEEK_SEARCH],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.DEEPSEEK_SEARCH_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.DEEPSEEK_SEARCH_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DEEPSEEK_SEARCH],
    validatePayload: validateDeepSeekToggleSelectionPayload,
  }),
  [VISIBLE_ACTIONS.DOUBAO_MODE_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.DOUBAO_MODE_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DOUBAO_MODE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.DOUBAO_MODE_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.DOUBAO_MODE_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DOUBAO_MODE],
    validatePayload: validateDoubaoModeSelectionPayload,
  }),
  [VISIBLE_ACTIONS.DOUBAO_SKILL_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.DOUBAO_SKILL_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DOUBAO_SKILL],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.DOUBAO_SKILL],
    validatePayload: validateDoubaoSkillSelectionPayload,
  }),
  [VISIBLE_ACTIONS.KIMI_SEARCH_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.KIMI_SEARCH_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.KIMI_SEARCH],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.KIMI_SEARCH_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.KIMI_SEARCH_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.KIMI_SEARCH],
    validatePayload: validateKimiSearchSelectionPayload,
  }),
  [VISIBLE_ACTIONS.KIMI_PLUGIN_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.KIMI_PLUGIN_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.KIMI_PLUGIN],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.KIMI_PLUGIN_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.KIMI_PLUGIN_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.KIMI_PLUGIN],
    validatePayload: validateSelectionPayload,
  }),
  [VISIBLE_ACTIONS.KIMI_SKILL_INSPECT]: defineAction({
    action: VISIBLE_ACTIONS.KIMI_SKILL_INSPECT,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [PROVIDER_CAPABILITIES.KIMI_SKILL],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.KIMI_SKILL_SELECT]: defineAction({
    action: VISIBLE_ACTIONS.KIMI_SKILL_SELECT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.KIMI_SKILL],
    validatePayload: validateSelectionPayload,
  }),
  [VISIBLE_ACTIONS.FILE_UPLOAD]: defineAction({
    action: VISIBLE_ACTIONS.FILE_UPLOAD,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.FILE_UPLOAD],
    validatePayload: validateFileUploadPayload,
  }),
  [VISIBLE_ACTIONS.WORKSPACE_ENSURE]: defineAction({
    action: VISIBLE_ACTIONS.WORKSPACE_ENSURE,
    lifecycle: gatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.WORKSPACE_ENSURE],
    validatePayload: validateWorkspaceEnsurePayload,
  }),
  [VISIBLE_ACTIONS.PROMPT_INPUT]: defineAction({
    action: VISIBLE_ACTIONS.PROMPT_INPUT,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE],
    validatePayload: validatePromptInputPayload,
  }),
  [VISIBLE_ACTIONS.PROMPT_CLEAR]: defineAction({
    action: VISIBLE_ACTIONS.PROMPT_CLEAR,
    lifecycle: reconstructableGatedMutation,
    requiredCapabilities: [PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.PROMPT_SUBMIT]: defineAction({
    action: VISIBLE_ACTIONS.PROMPT_SUBMIT,
    lifecycle: submitLifecycle,
    requiredCapabilities: [PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.RESPONSE_READ]: defineAction({
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    lifecycle: responseReadLifecycle,
    requiredCapabilities: [PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.SNAPSHOT_SANITIZED]: defineAction({
    action: VISIBLE_ACTIONS.SNAPSHOT_SANITIZED,
    lifecycle: immediateReadOnly,
    requiredCapabilities: [],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.NAVIGATION_CHECK]: defineAction({
    action: VISIBLE_ACTIONS.NAVIGATION_CHECK,
    lifecycle: gatedReadOnly,
    requiredCapabilities: [],
    validatePayload: validateEmptyPayload,
  }),
  [VISIBLE_ACTIONS.BLOCKER_CHECK]: defineAction({
    action: VISIBLE_ACTIONS.BLOCKER_CHECK,
    lifecycle: immediateReadOnly,
    requiredCapabilities: [],
    validatePayload: validateEmptyPayload,
  }),
} satisfies { readonly [Action in VisibleAction]: VisibleActionCatalogDefinition<Action> })

const ACTIONS = Object.freeze(Object.keys(VISIBLE_ACTION_CATALOG)) as readonly VisibleAction[]
const ACTION_SET = new Set<string>(ACTIONS)

export function listVisibleActions(): readonly VisibleAction[] {
  return ACTIONS
}

export function isVisibleAction(value: unknown): value is VisibleAction {
  return typeof value === 'string' && ACTION_SET.has(value)
}

export function getVisibleActionCatalogDefinition<Action extends VisibleAction>(
  action: Action
): VisibleActionCatalogDefinition<Action> {
  return VISIBLE_ACTION_CATALOG[action] as VisibleActionCatalogDefinition<Action>
}

export function getVisibleActionLifecycle(action: VisibleAction): VisibleActionLifecycle {
  return VISIBLE_ACTION_CATALOG[action].lifecycle
}

export function validateVisibleActionPayload<Action extends VisibleAction>(
  action: Action,
  payload: Record<string, unknown>
): VisibleActionPayloadForAction<Action> {
  return getVisibleActionCatalogDefinition(action).validatePayload(payload)
}

export function validateAttachmentInput(input: unknown): AttachmentInput {
  if (!isPlainRecord(input)) throw tokenlessError('invalid_visible_attachment', 'Attachment descriptor must be an object.')
  requireExactKeys(input, ['protocol', 'bundleId', 'attachmentId', 'name', 'type', 'size', 'sha256'], 'invalid_visible_attachment')
  if (input.protocol !== VISIBLE_ATTACHMENT_SCHEMA_ID) {
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
  if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment sha256 is invalid.')
  }
  return input as AttachmentInput
}

function defineAction<Action extends VisibleAction>(
  definition: VisibleActionCatalogDefinition<Action>
): VisibleActionCatalogDefinition<Action> {
  return Object.freeze(definition)
}

function validateEmptyPayload(payload: Record<string, unknown>): EmptyVisibleActionPayload {
  requireExactKeys(payload, [], 'invalid_visible_action_payload')
  return payload as EmptyVisibleActionPayload
}

function validateSelectionPayload(payload: Record<string, unknown>): VisibleSelectionPayload {
  requireExactKeys(payload, ['label'], 'invalid_visible_action_payload')
  validateVisibleLabel(payload.label)
  return payload as VisibleSelectionPayload
}

function validateArenaSurfaceSelectionPayload(payload: Record<string, unknown>): ArenaSurfaceSelectionPayload {
  requireExactKeys(payload, ['mode', 'modality'], 'invalid_visible_action_payload')
  if (payload.mode !== 'battle' && payload.mode !== 'side-by-side' && payload.mode !== 'direct') {
    throw tokenlessError('invalid_visible_action_payload', 'Arena surface mode must be battle, side-by-side, or direct.')
  }
  if (payload.modality !== 'text' && payload.modality !== 'search' && payload.modality !== 'image' && payload.modality !== 'code') {
    throw tokenlessError('invalid_visible_action_payload', 'Arena surface modality must be text, search, image, or code.')
  }
  return payload as ArenaSurfaceSelectionPayload
}

function validateGrokImagineSelectionPayload(payload: Record<string, unknown>): GrokImagineSelectionPayload {
  requireExactKeys(payload, ['modality'], 'invalid_visible_action_payload')
  if (payload.modality !== 'image') {
    throw tokenlessError('invalid_visible_action_payload', 'Grok Imagine modality must be image.')
  }
  return payload as GrokImagineSelectionPayload
}

function validateGeminiImageSelectionPayload(payload: Record<string, unknown>): GeminiImageSelectionPayload {
  requireExactKeys(payload, ['modality'], 'invalid_visible_action_payload')
  if (payload.modality !== 'image') {
    throw tokenlessError('invalid_visible_action_payload', 'Gemini image modality must be image.')
  }
  return payload as GeminiImageSelectionPayload
}

function validateDolaImageSelectionPayload(payload: Record<string, unknown>): DolaImageSelectionPayload {
  requireExactKeys(payload, ['modality'], 'invalid_visible_action_payload')
  if (payload.modality !== 'image') {
    throw tokenlessError('invalid_visible_action_payload', 'Dola image modality must be image.')
  }
  return payload as DolaImageSelectionPayload
}

function validateQwenModeSelectionPayload(payload: Record<string, unknown>): QwenModeSelectionPayload {
  const keys = Object.keys(payload)
  if (
    (keys.length !== 1 && keys.length !== 2) ||
    !Object.hasOwn(payload, 'mode') ||
    keys.some((key) => key !== 'mode' && key !== 'variant')
  ) {
    throw tokenlessError('invalid_visible_action_payload', 'Expected exact keys: mode, optional variant.')
  }
  validateVisibleLabel(payload.mode)
  if (Object.hasOwn(payload, 'variant')) validateVisibleLabel(payload.variant)
  return payload as QwenModeSelectionPayload
}

function validateDeepSeekModeSelectionPayload(payload: Record<string, unknown>): DeepSeekModeSelectionPayload {
  requireExactKeys(payload, ['mode'], 'invalid_visible_action_payload')
  if (payload.mode !== 'Instant' && payload.mode !== 'Expert' && payload.mode !== 'Vision') {
    throw tokenlessError('invalid_visible_action_payload', 'DeepSeek mode must be Instant, Expert, or Vision.')
  }
  return payload as DeepSeekModeSelectionPayload
}

function validateDeepSeekToggleSelectionPayload(payload: Record<string, unknown>): DeepSeekToggleSelectionPayload {
  requireExactKeys(payload, ['enabled'], 'invalid_visible_action_payload')
  if (typeof payload.enabled !== 'boolean') {
    throw tokenlessError('invalid_visible_action_payload', 'DeepSeek toggle enabled must be a boolean.')
  }
  return payload as DeepSeekToggleSelectionPayload
}

function validateKimiSearchSelectionPayload(payload: Record<string, unknown>): KimiSearchSelectionPayload {
  requireExactKeys(payload, ['mode'], 'invalid_visible_action_payload')
  if (payload.mode !== 'auto' && payload.mode !== 'off') {
    throw tokenlessError('invalid_visible_action_payload', 'Kimi search mode must be auto or off.')
  }
  return payload as KimiSearchSelectionPayload
}

function validateDoubaoModeSelectionPayload(payload: Record<string, unknown>): DoubaoModeSelectionPayload {
  requireExactKeys(payload, ['mode'], 'invalid_visible_action_payload')
  if (
    payload.mode !== 'fast' &&
    payload.mode !== 'expert' &&
    payload.mode !== 'work-task-turbo' &&
    payload.mode !== 'work-task-pro'
  ) {
    throw tokenlessError(
      'invalid_visible_action_payload',
      'Doubao mode must be fast, expert, work-task-turbo, or work-task-pro.',
    )
  }
  return payload as DoubaoModeSelectionPayload
}

function validateDoubaoSkillSelectionPayload(payload: Record<string, unknown>): DoubaoSkillSelectionPayload {
  requireExactKeys(payload, ['skill'], 'invalid_visible_action_payload')
  if (!DOUBAO_SKILLS.has(String(payload.skill))) {
    throw tokenlessError('invalid_visible_action_payload', 'Doubao skill is not recognized.')
  }
  return payload as DoubaoSkillSelectionPayload
}

const DOUBAO_SKILLS = new Set([
  'chat',
  'document-writing',
  'presentation-generation',
  'image-generation',
  'video-generation',
  'deep-research',
  'audio-podcast',
  'music-generation',
  'problem-solving',
  'spreadsheet-generation',
  'audio-transcription',
])

function validateFileUploadPayload(payload: Record<string, unknown>): FileUploadPayload {
  requireExactKeys(payload, ['attachments'], 'invalid_visible_action_payload')
  if (!Array.isArray(payload.attachments) || payload.attachments.length < 1 || payload.attachments.length > 100) {
    throw tokenlessError('invalid_visible_attachment', 'File upload requires one to one hundred attachments.')
  }
  for (const attachment of payload.attachments) validateAttachmentInput(attachment)
  return payload as FileUploadPayload
}

function validateWorkspaceEnsurePayload(payload: Record<string, unknown>): WorkspaceEnsurePayload {
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
  return payload as WorkspaceEnsurePayload
}

function validatePromptInputPayload(payload: Record<string, unknown>): PromptInputPayload {
  requireExactKeys(payload, ['text'], 'invalid_visible_action_payload')
  if (typeof payload.text !== 'string' || Buffer.byteLength(payload.text, 'utf8') > 1024 * 1024) {
    throw tokenlessError('invalid_visible_prompt', 'Prompt text is invalid or too large.')
  }
  return payload as PromptInputPayload
}

function validateWorkspaceText(value: unknown, code: string, message: string) {
  if (
    typeof value !== 'string' ||
    !/\S/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > 32 * 1024 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw tokenlessError(code, message)
  }
}

function validateVisibleLabel(value: unknown) {
  if (typeof value !== 'string' || !/\S/u.test(value) || Buffer.byteLength(value, 'utf8') > 512) {
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
