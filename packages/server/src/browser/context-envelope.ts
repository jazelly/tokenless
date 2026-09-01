import { createHash } from 'node:crypto'
import { tokenlessError } from './errors.js'
import { VISIBLE_ACTIONS } from '../providers/contracts.js'
import type { TaskCapabilityId } from '../providers/task-capabilities.js'
import type { VisibleActionRequest } from '../providers/contracts.js'

export const CONTEXT_ENVELOPE_SCHEMA_ID = 'tokenless.context-envelope.v1' as const

export type ContextInstruction = Readonly<{
  role: 'system' | 'developer' | 'user'
  content: string
  provenance: 'compiled_cli' | 'caller' | 'upstream_agent'
}>

export type ContextReference = Readonly<{
  kind: 'attachment'
  attachmentId: string
  name: string
  mediaType: string
  size: number
  sha256: string
  provenance: 'caller_selected_file'
}>

export type ContextEnvelope = Readonly<{
  schema: typeof CONTEXT_ENVELOPE_SCHEMA_ID
  taskId: string | null
  requirements: readonly TaskCapabilityId[]
  instructions: readonly ContextInstruction[]
  references: readonly ContextReference[]
  outputContract: Readonly<{
    language: 'en' | 'zh-CN' | null
    format: string | null
  }>
  constraints: Readonly<{
    tokenBudget: number | null
    deadline: string | null
  }>
  upstream: Readonly<{
    agentKind: string | null
    sessionId: string | null
    state: Readonly<Record<string, unknown>> | null
  }>
  delivery: Readonly<{
    mode: 'visible_actions'
    promptActions: readonly Readonly<{
      requestId: string
      sha256: string
      bytes: number
    }>[]
  }>
}>

export function createContextEnvelope(options: {
  taskId: string | null
  requirements: readonly TaskCapabilityId[]
  actions: readonly VisibleActionRequest[]
  language?: 'en' | 'zh-CN' | null | undefined
  upstream?: ContextEnvelope['upstream'] | undefined
}): ContextEnvelope {
  const prompts = promptActions(options.actions)
  return Object.freeze({
    schema: CONTEXT_ENVELOPE_SCHEMA_ID,
    taskId: options.taskId,
    requirements: Object.freeze([...options.requirements]),
    instructions: Object.freeze(prompts.map(({ text }) => Object.freeze({
      role: 'user' as const,
      content: text,
      provenance: 'compiled_cli' as const,
    }))),
    references: Object.freeze(attachmentReferences(options.actions)),
    outputContract: Object.freeze({ language: options.language ?? null, format: null }),
    constraints: Object.freeze({ tokenBudget: null, deadline: null }),
    upstream: Object.freeze(options.upstream ?? { agentKind: null, sessionId: null, state: null }),
    delivery: Object.freeze({
      mode: 'visible_actions' as const,
      promptActions: Object.freeze(prompts.map(({ requestId, text }) => Object.freeze({
        requestId,
        sha256: sha256(text),
        bytes: Buffer.byteLength(text, 'utf8'),
      }))),
    }),
  })
}

export function validateContextEnvelope(
  value: unknown,
  expected: {
    taskId: string | null
    requirements: readonly TaskCapabilityId[]
    actions: readonly VisibleActionRequest[]
  },
): ContextEnvelope {
  const input = record(value)
  if (!input) throw invalidContext('Context envelope must be an object.')
  requireExactKeys(input, [
    'schema',
    'taskId',
    'requirements',
    'instructions',
    'references',
    'outputContract',
    'constraints',
    'upstream',
    'delivery',
  ])
  if (input.schema !== CONTEXT_ENVELOPE_SCHEMA_ID || input.taskId !== expected.taskId) {
    throw invalidContext('Context envelope identity does not match the managed job.')
  }
  if (!sameStringArray(input.requirements, expected.requirements)) {
    throw invalidContext('Context envelope requirements do not match the capability route.')
  }
  if (!Array.isArray(input.instructions) || input.instructions.length > 32) {
    throw invalidContext('Context envelope instructions must contain at most thirty-two entries.')
  }
  const instructions = input.instructions.map(validateInstruction)
  const prompts = promptActions(expected.actions)
  const deliveredText = prompts.map(({ text }) => text).join('\n')
  if (instructions.some((instruction) => !deliveredText.includes(instruction.content))) {
    throw invalidContext('Every context instruction must be present in a delivered prompt action.')
  }
  const expectedReferences = attachmentReferences(expected.actions)
  if (JSON.stringify(input.references) !== JSON.stringify(expectedReferences)) {
    throw invalidContext('Context envelope references do not match staged attachment actions.')
  }
  const outputContract = validateOutputContract(input.outputContract)
  const constraints = validateConstraints(input.constraints)
  const upstream = validateUpstream(input.upstream)
  const delivery = validateDelivery(input.delivery, prompts)
  return Object.freeze({
    schema: CONTEXT_ENVELOPE_SCHEMA_ID,
    taskId: expected.taskId,
    requirements: Object.freeze([...expected.requirements]),
    instructions: Object.freeze(instructions),
    references: Object.freeze(expectedReferences),
    outputContract,
    constraints,
    upstream,
    delivery,
  })
}

function validateInstruction(value: unknown): ContextInstruction {
  const input = record(value)
  if (!input) throw invalidContext('Context instruction must be an object.')
  requireExactKeys(input, ['role', 'content', 'provenance'])
  if (input.role !== 'system' && input.role !== 'developer' && input.role !== 'user') {
    throw invalidContext('Context instruction role is invalid.')
  }
  if (typeof input.content !== 'string' || input.content.length === 0 || Buffer.byteLength(input.content, 'utf8') > 1_000_000) {
    throw invalidContext('Context instruction content is invalid.')
  }
  if (input.provenance !== 'compiled_cli' && input.provenance !== 'caller' && input.provenance !== 'upstream_agent') {
    throw invalidContext('Context instruction provenance is invalid.')
  }
  return Object.freeze({ role: input.role, content: input.content, provenance: input.provenance })
}

function validateOutputContract(value: unknown): ContextEnvelope['outputContract'] {
  const input = record(value)
  if (!input) throw invalidContext('Context output contract must be an object.')
  requireExactKeys(input, ['language', 'format'])
  if (input.language !== null && input.language !== 'en' && input.language !== 'zh-CN') {
    throw invalidContext('Context output language is invalid.')
  }
  if (input.format !== null && (typeof input.format !== 'string' || input.format.length === 0 || input.format.length > 120)) {
    throw invalidContext('Context output format is invalid.')
  }
  return Object.freeze({ language: input.language, format: input.format as string | null })
}

function validateConstraints(value: unknown): ContextEnvelope['constraints'] {
  const input = record(value)
  if (!input) throw invalidContext('Context constraints must be an object.')
  requireExactKeys(input, ['tokenBudget', 'deadline'])
  if (input.tokenBudget !== null && (!Number.isInteger(input.tokenBudget) || Number(input.tokenBudget) <= 0)) {
    throw invalidContext('Context token budget is invalid.')
  }
  if (input.deadline !== null && (typeof input.deadline !== 'string' || !Number.isFinite(Date.parse(input.deadline)))) {
    throw invalidContext('Context deadline is invalid.')
  }
  return Object.freeze({ tokenBudget: input.tokenBudget as number | null, deadline: input.deadline as string | null })
}

function validateUpstream(value: unknown): ContextEnvelope['upstream'] {
  const input = record(value)
  if (!input) throw invalidContext('Context upstream state must be an object.')
  requireExactKeys(input, ['agentKind', 'sessionId', 'state'])
  for (const field of ['agentKind', 'sessionId'] as const) {
    const entry = input[field]
    if (entry !== null && (typeof entry !== 'string' || entry.length === 0 || entry.length > 240)) {
      throw invalidContext(`Context upstream ${field} is invalid.`)
    }
  }
  const state = input.state === null ? null : record(input.state)
  if (input.state !== null && !state) throw invalidContext('Context upstream state must be a JSON object or null.')
  if (state && Buffer.byteLength(JSON.stringify(state), 'utf8') > 256_000) {
    throw invalidContext('Context upstream state is too large.')
  }
  return Object.freeze({
    agentKind: input.agentKind as string | null,
    sessionId: input.sessionId as string | null,
    state: state ? Object.freeze({ ...state }) : null,
  })
}

function validateDelivery(value: unknown, prompts: ReturnType<typeof promptActions>): ContextEnvelope['delivery'] {
  const input = record(value)
  if (!input) throw invalidContext('Context delivery receipt must be an object.')
  requireExactKeys(input, ['mode', 'promptActions'])
  if (input.mode !== 'visible_actions' || !Array.isArray(input.promptActions)) {
    throw invalidContext('Context delivery receipt is invalid.')
  }
  const expected = prompts.map(({ requestId, text }) => ({
    requestId,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
  }))
  if (JSON.stringify(input.promptActions) !== JSON.stringify(expected)) {
    throw invalidContext('Context delivery receipt does not match prompt actions.')
  }
  return Object.freeze({
    mode: 'visible_actions',
    promptActions: Object.freeze(expected.map((entry) => Object.freeze(entry))),
  })
}

function promptActions(actions: readonly VisibleActionRequest[]) {
  return actions.flatMap((action) => action.action === VISIBLE_ACTIONS.PROMPT_INPUT
    ? [{ requestId: action.requestId, text: action.payload.text }]
    : [])
}

function attachmentReferences(actions: readonly VisibleActionRequest[]): ContextReference[] {
  return actions.flatMap((action) => action.action === VISIBLE_ACTIONS.FILE_UPLOAD
    ? action.payload.attachments.map((attachment) => Object.freeze({
        kind: 'attachment' as const,
        attachmentId: attachment.attachmentId,
        name: attachment.name,
        mediaType: attachment.type,
        size: attachment.size,
        sha256: attachment.sha256,
        provenance: 'caller_selected_file' as const,
      }))
    : [])
}

function sameStringArray(value: unknown, expected: readonly string[]) {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw invalidContext(`Context envelope fields must be exactly: ${expected.join(', ')}.`)
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function invalidContext(message: string) {
  return tokenlessError('invalid_context_envelope', message)
}
