import {
  MarkerExtractionError,
  extractExactlyOneMarkedValue,
  parseStrictJson,
} from 'tokenless-web-ai-interaction-protocol/structured-control'
import {
  WEB_AGENT_PROTOCOL,
  HarnessSkillError,
  type HarnessActionBatch,
  type HarnessFinalResponse,
  type HarnessModelResponse,
  type HarnessRunNeed,
  type HarnessToolCall,
  type JsonValue,
} from '../contracts.js'
import type { HarnessSkillState } from './state.js'
import { assertValidJsonSchema, validateJsonSchemaValue } from './json-schema.js'

const OPEN_MARKER = '<TOKENLESS_HARNESS_RESPONSE>'
const CLOSE_MARKER = '</TOKENLESS_HARNESS_RESPONSE>'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const SAFE_ITEM_ID = /^[A-Za-z0-9_-]{1,96}$/
const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function parseModelResponse({
  responseText,
  runId,
  turn,
  nonce,
  state,
}: {
  responseText: string
  runId: string
  turn: number
  nonce: string
  state: HarnessSkillState
}): HarnessModelResponse {
  if (typeof responseText !== 'string' || Buffer.byteLength(responseText, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new HarnessSkillError('harness_response_too_large', `Harness response must be at most ${MAX_RESPONSE_BYTES} bytes.`)
  }
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new HarnessSkillError('invalid_turn', 'turn must be a positive safe integer.')
  }
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 256) {
    throw new HarnessSkillError('invalid_nonce', 'nonce must contain 8-256 characters.')
  }
  const trimmed = responseText.trim()
  let json: string
  try {
    const marked = extractExactlyOneMarkedValue(trimmed, OPEN_MARKER, CLOSE_MARKER)
    if (marked.before !== '' || marked.after !== '') {
      throw new HarnessSkillError(
        'harness_response_framing_invalid',
        `Harness response must contain exactly one envelope between ${OPEN_MARKER} and ${CLOSE_MARKER}.`,
      )
    }
    json = marked.content.trim()
  } catch (error) {
    if (error instanceof HarnessSkillError) throw error
    if (error instanceof MarkerExtractionError && error.reason === 'count') {
      throw new HarnessSkillError('harness_response_framing_invalid', 'Harness response contains duplicate or missing control markers.')
    }
    throw new HarnessSkillError(
      'harness_response_framing_invalid',
      `Harness response must contain exactly one envelope between ${OPEN_MARKER} and ${CLOSE_MARKER}.`,
    )
  }
  const parsed = record(parseHarnessStrictJson(json), 'Harness response envelope')
  requireExactKeys(
    parsed,
    parsed.kind === 'final'
      ? ['protocol', 'kind', 'runId', 'turn', 'nonce', 'output', 'artifacts']
      : ['protocol', 'kind', 'runId', 'turn', 'nonce', 'skillLoads', 'calls', 'needs'],
    'Harness response envelope',
  )
  correlate(parsed, { runId, turn, nonce })
  if (parsed.kind === 'action_batch') return actionBatch(parsed, state)
  if (parsed.kind === 'final') return finalResponse(parsed, state)
  throw new HarnessSkillError('harness_response_kind_invalid', 'Harness response kind must be action_batch or final.')
}

function actionBatch(value: Record<string, unknown>, state: HarnessSkillState): HarnessActionBatch {
  const rawSkillLoads = array(value.skillLoads, 'skillLoads', 64)
  const skillLoads = rawSkillLoads.map((name) => {
    if (typeof name !== 'string' || !SAFE_SKILL_NAME.test(name) || name.length > 64) {
      throw new HarnessSkillError('harness_skill_load_invalid', 'Every skillLoads item must be a valid Skill name.')
    }
    return name
  })
  const calls = array(value.calls, 'calls', 128).map(toolCall)
  const needs = array(value.needs, 'needs', 64).map(runNeed)
  if (skillLoads.length === 0 && calls.length === 0 && needs.length === 0) {
    throw new HarnessSkillError('harness_action_batch_empty', 'action_batch must contain at least one Skill, call, or need.')
  }
  requireUnique(skillLoads, 'skillLoads')
  requireUnique(calls.map((call) => call.id), 'call ids')
  requireUnique(needs.map((need) => need.id), 'need ids')
  const allIds = [...calls.map((call) => call.id), ...needs.map((need) => need.id)]
  requireUnique(allIds, 'call and need ids')

  const toolNames = new Set(state.tools.map((tool) => tool.name))
  const tools = new Map(state.tools.map((tool) => [tool.name, tool]))
  for (const call of calls) {
    if (!toolNames.has(call.tool)) {
      throw new HarnessSkillError('harness_tool_unknown', `Tool '${call.tool}' is not present in the frozen catalog.`)
    }
    validateJsonSchemaValue(tools.get(call.tool)!.inputSchema, call.arguments, `Arguments for tool '${call.tool}'`)
  }
  validateDependencies(calls)
  return {
    protocol: WEB_AGENT_PROTOCOL,
    kind: 'action_batch',
    runId: value.runId as string,
    turn: value.turn as number,
    nonce: value.nonce as string,
    skillLoads,
    calls,
    needs,
  }
}

function finalResponse(value: Record<string, unknown>, state: HarnessSkillState): HarnessFinalResponse {
  if (typeof value.output !== 'string') {
    throw new HarnessSkillError('harness_final_invalid', 'final.output must be a string.')
  }
  const artifacts = array(value.artifacts, 'artifacts', 128).map((artifact) => {
    if (typeof artifact !== 'string' || artifact.length < 1 || artifact.length > 512) {
      throw new HarnessSkillError('harness_final_invalid', 'Every final artifact must be a bounded string identifier.')
    }
    return artifact
  })
  requireUnique(artifacts, 'artifact ids')
  if (state.finalOutput.kind === 'json_schema') {
    let structuredOutput: unknown
    try {
      structuredOutput = parseHarnessStrictJson(value.output)
    } catch (error) {
      throw new HarnessSkillError(
        'harness_final_output_invalid',
        `final.output must contain strict JSON: ${error instanceof Error ? error.message : 'invalid JSON'}`,
      )
    }
    validateJsonSchemaValue(state.finalOutput.schema, structuredOutput, 'final.output')
  }
  return {
    protocol: WEB_AGENT_PROTOCOL,
    kind: 'final',
    runId: value.runId as string,
    turn: value.turn as number,
    nonce: value.nonce as string,
    output: value.output,
    artifacts,
  }
}

function toolCall(value: unknown): HarnessToolCall {
  const call = record(value, 'tool call')
  requireExactKeys(call, ['id', 'tool', 'arguments', 'dependsOn'], 'tool call', ['dependsOn'])
  const id = itemId(call.id, 'tool call id')
  if (typeof call.tool !== 'string' || call.tool.length < 1 || call.tool.length > 128) {
    throw new HarnessSkillError('harness_tool_call_invalid', 'tool call tool must be a bounded string.')
  }
  const argumentsValue = record(call.arguments, 'tool call arguments') as Record<string, JsonValue>
  const dependsOn = call.dependsOn === undefined
    ? undefined
    : array(call.dependsOn, 'dependsOn', 128).map((dependency) => itemId(dependency, 'dependency id'))
  if (dependsOn) requireUnique(dependsOn, `Dependencies for call '${id}'`)
  return { id, tool: call.tool, arguments: argumentsValue, ...(dependsOn ? { dependsOn } : {}) }
}

function runNeed(value: unknown): HarnessRunNeed {
  const need = record(value, 'run need')
  requireExactKeys(need, ['id', 'kind', 'prompt', 'inputSchema'], 'run need')
  const id = itemId(need.id, 'run need id')
  if (need.kind !== 'user_input') {
    throw new HarnessSkillError('harness_need_invalid', 'Model-requested need kind must be user_input.')
  }
  if (typeof need.prompt !== 'string' || need.prompt.trim() === '' || need.prompt.length > 2048) {
    throw new HarnessSkillError('harness_need_invalid', 'Run need prompt must be a nonempty string of at most 2048 characters.')
  }
  assertJsonValue(need.inputSchema, 'run need inputSchema')
  assertValidJsonSchema(need.inputSchema as JsonValue, `inputSchema for need '${id}'`)
  return { id, kind: 'user_input', prompt: need.prompt.trim(), inputSchema: need.inputSchema as JsonValue }
}

function correlate(value: Record<string, unknown>, expected: { runId: string; turn: number; nonce: string }) {
  if (value.protocol !== WEB_AGENT_PROTOCOL) {
    throw new HarnessSkillError('harness_protocol_invalid', `Harness response protocol must be ${WEB_AGENT_PROTOCOL}.`)
  }
  if (value.runId !== expected.runId || value.turn !== expected.turn || value.nonce !== expected.nonce) {
    throw new HarnessSkillError('harness_response_correlation_invalid', 'Harness response run, turn, or nonce does not match the current request.')
  }
}

function validateDependencies(calls: readonly HarnessToolCall[]) {
  const ids = new Set(calls.map((call) => call.id))
  const graph = new Map(calls.map((call) => [call.id, call.dependsOn ?? []] as const))
  for (const call of calls) {
    for (const dependency of call.dependsOn ?? []) {
      if (!ids.has(dependency) || dependency === call.id) {
        throw new HarnessSkillError('harness_dependency_invalid', `Call '${call.id}' has an invalid dependency '${dependency}'.`)
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string) {
    if (visiting.has(id)) throw new HarnessSkillError('harness_dependency_cycle', 'Tool call dependencies must be acyclic.')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of graph.get(id) ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
) {
  const allowedSet = new Set(allowed)
  const optionalSet = new Set(optional)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new HarnessSkillError('harness_response_schema_invalid', `${label} contains unsupported field '${key}'.`)
  }
  for (const key of allowed) {
    if (!optionalSet.has(key) && !Object.hasOwn(value, key)) {
      throw new HarnessSkillError('harness_response_schema_invalid', `${label} is missing required field '${key}'.`)
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessSkillError('harness_response_schema_invalid', `${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, label: string, max: number) {
  if (!Array.isArray(value) || value.length > max) {
    throw new HarnessSkillError('harness_response_schema_invalid', `${label} must be an array with at most ${max} items.`)
  }
  return value as unknown[]
}

function itemId(value: unknown, label: string) {
  if (typeof value !== 'string' || !SAFE_ITEM_ID.test(value)) {
    throw new HarnessSkillError('harness_response_schema_invalid', `${label} must contain 1-96 letters, numbers, underscores, or hyphens.`)
  }
  return value
}

function requireUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new HarnessSkillError('harness_response_schema_invalid', `${label} must be unique.`)
  }
}

function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HarnessSkillError('harness_response_schema_invalid', `${label} contains a non-finite number.`)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) assertJsonValue(item, label)
    return
  }
  throw new HarnessSkillError('harness_response_schema_invalid', `${label} must be JSON-serializable.`)
}

function parseHarnessStrictJson(source: string) {
  try {
    return parseStrictJson(source)
  } catch (error) {
    throw new HarnessSkillError(
      'harness_response_json_invalid',
      error instanceof Error ? error.message : 'Harness response contains invalid JSON.',
    )
  }
}
