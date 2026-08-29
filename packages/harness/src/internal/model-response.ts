import {
  MarkerExtractionError,
  extractExactlyOneMarkedValue,
  parseStrictJson,
} from 'tokenless-internal-shared/structured-json'
import {
  WEB_AGENT_PROTOCOL,
  HarnessSkillError,
  type HarnessActionBatch,
  type HarnessFinalResponse,
  type HarnessModelResponse,
  type HarnessRunNeed,
  type HarnessToolCall,
  type HarnessToolCallValidationError,
  type JsonValue,
} from '../contracts.js'
import type { HarnessSkillState } from './state.js'
import { assertValidJsonSchema, validateJsonSchemaValue } from './json-schema.js'

const OPEN_MARKER = '<TOKENLESS_HARNESS_RESPONSE>'
const CLOSE_MARKER = '</TOKENLESS_HARNESS_RESPONSE>'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_SEMANTIC_QUOTE_REPAIRS = 16
const MAX_SEMANTIC_STRING_SPAN_REPAIRS = 1024
const SAFE_ITEM_ID = /^[A-Za-z0-9_-]{1,96}$/
const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REPAIRED_ACTION_BATCH_ARGUMENTS: JsonValue = { discarded: true }
const REPAIRED_ACTION_BATCH_MESSAGE = 'Repaired JSON action_batch was not executed and must be reissued as strict JSON.'
export const INVALID_RESPONSE_ACTION_BATCH_MESSAGE = 'Invalid Harness response was not executed and must be reissued as strict JSON matching the schema.'
export const INVALID_RESPONSE_FRAMING_ACTION_BATCH_MESSAGE = 'Harness response framing is invalid. Return exactly one strict JSON object or one exact <TOKENLESS_HARNESS_RESPONSE>...</TOKENLESS_HARNESS_RESPONSE> envelope; a single ```json fence around that object is allowed, but do not add prose, multiple envelopes, or other fences.'
export const INVALID_RESPONSE_CORRELATION_ACTION_BATCH_MESSAGE = 'Harness response run, turn, or nonce does not match the current request.'
const INVALID_RESPONSE_PROTOCOL_ACTION_BATCH_MESSAGE = `Harness response protocol is invalid. Use protocol "${WEB_AGENT_PROTOCOL}" and copy the current runId, turn, and nonce exactly.`
export const INVALID_BENCHMARK_EVIDENCE_ACTION_BATCH_MESSAGE = 'Benchmark evidence is insufficient. Complete implementation work and a separate public end-to-end verification that asserts every stated observable outcome, waits for generated outputs, and fails on missing or invalid results with workspace tools before finalizing.'
const SYNTHETIC_REISSUE_REASON_CODES = new Set([
  'harness_response_framing_invalid',
  'harness_response_correlation_invalid',
  'harness_protocol_invalid',
  'harness_response_json_invalid',
  'harness_response_schema_invalid',
  'harness_action_batch_json_repair_forbidden',
  'harness_response_kind_invalid',
  'harness_skill_load_invalid',
  'harness_action_batch_empty',
  'harness_final_invalid',
  'harness_final_output_invalid',
  'harness_tool_call_invalid',
  'harness_need_invalid',
  'harness_dependency_invalid',
  'harness_dependency_cycle',
  'harness_json_schema_validation_failed',
  'harness_benchmark_evidence_insufficient',
])
const MODEL_CORRECTABLE_RESPONSE_CODES = new Set([
  'harness_action_batch_json_repair_forbidden',
  'harness_response_kind_invalid',
  'harness_skill_load_invalid',
  'harness_action_batch_empty',
  'harness_final_invalid',
  'harness_final_output_invalid',
  'harness_tool_call_invalid',
  'harness_need_invalid',
  'harness_dependency_invalid',
  'harness_dependency_cycle',
])

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
  const rawJson = rawStrictObjectCandidate(trimmed)
  let json: string
  if (rawJson !== null) {
    json = rawJson
  } else {
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
  }
  let parsed: unknown
  let semanticallyRepaired = false
  const stringOutputProperty = state.finalOutput.kind === 'json_schema'
    ? singleRequiredStringSchemaProperty(state.finalOutput.schema)
    : null
  try {
    try {
      parsed = parseHarnessStrictJson(json)
    } catch (error) {
      if (isCommaSerializationError(error)) {
        const repaired = escapeUnexpectedJsonStringQuotes(json)
        if (repaired !== null) {
          try {
            parsed = parseHarnessStrictJson(repaired)
          } catch (repairError) {
            if ((!isCommaSerializationError(repairError) && !isStringSerializationError(repairError)) || stringOutputProperty === null) throw repairError
            const envelopeRepaired = repairFinalEnvelopeOutput(json)
            if (envelopeRepaired === null) throw repairError
            parsed = parseHarnessStrictJson(envelopeRepaired)
          }
        } else {
          if (stringOutputProperty === null) throw error
          const envelopeRepaired = repairFinalEnvelopeOutput(json)
          if (envelopeRepaired === null) throw error
          parsed = parseHarnessStrictJson(envelopeRepaired)
        }
      } else if (isStringSerializationError(error) && stringOutputProperty !== null) {
        const envelopeRepaired = repairFinalEnvelopeOutput(json)
        if (envelopeRepaired === null) throw error
        parsed = parseHarnessStrictJson(envelopeRepaired)
      } else {
        throw error
      }
      semanticallyRepaired = true
    }
  } catch (error) {
    if (isResponseJsonInvalid(error)) {
      return malformedJsonActionBatch(runId, turn, nonce, INVALID_RESPONSE_ACTION_BATCH_MESSAGE, 'harness_response_json_invalid')
    }
    throw error
  }
  let parsedEnvelope: Record<string, unknown> | null = null
  try {
    parsedEnvelope = record(parsed, 'Harness response envelope')
    correlate(parsedEnvelope, { runId, turn, nonce })
    if (semanticallyRepaired && parsedEnvelope.kind !== 'final' && parsedEnvelope.kind !== 'action_batch') {
      throw new HarnessSkillError(
        'harness_action_batch_json_repair_forbidden',
        'A repaired Harness action_batch response is not executable.',
      )
    }
    requireExactKeys(
      parsedEnvelope,
      parsedEnvelope.kind === 'final'
        ? ['protocol', 'kind', 'runId', 'turn', 'nonce', 'output', 'artifacts']
        : ['protocol', 'kind', 'runId', 'turn', 'nonce', 'skillLoads', 'calls', 'needs'],
      'Harness response envelope',
    )
    if (parsedEnvelope.kind === 'action_batch') {
      const batch = actionBatch(parsedEnvelope, state)
      return semanticallyRepaired ? discardRepairedActionBatch(batch) : batch
    }
    if (parsedEnvelope.kind === 'final') return finalResponse(parsedEnvelope, state, stringOutputProperty)
    throw new HarnessSkillError('harness_response_kind_invalid', 'Harness response kind must be action_batch or final.')
  } catch (error) {
    if (error instanceof HarnessSkillError && error.code === 'harness_protocol_invalid') {
      return malformedProtocolActionBatch(runId, turn, nonce)
    }
    if (error instanceof HarnessSkillError &&
      error.code === 'harness_response_correlation_invalid' &&
      error.message === INVALID_RESPONSE_CORRELATION_ACTION_BATCH_MESSAGE) {
      return malformedCorrelationActionBatch(runId, turn, nonce)
    }
    if (isResponseSchemaInvalid(error) || isModelCorrectableResponseError(error, parsedEnvelope)) {
      return malformedJsonActionBatch(
        runId,
        turn,
        nonce,
        INVALID_RESPONSE_ACTION_BATCH_MESSAGE,
        error instanceof HarnessSkillError && SYNTHETIC_REISSUE_REASON_CODES.has(error.code)
          ? error.code
          : 'harness_response_schema_invalid',
      )
    }
    throw error
  }
}

function discardRepairedActionBatch(batch: HarnessActionBatch): HarnessActionBatch {
  if (batch.calls.length === 0) {
    throw new HarnessSkillError(
      'harness_action_batch_json_repair_forbidden',
      'A repaired Harness action_batch response must contain at least one call.',
    )
  }
  return {
    ...batch,
    skillLoads: [],
    calls: batch.calls.map((call) => ({
      ...call,
      arguments: REPAIRED_ACTION_BATCH_ARGUMENTS,
      validationError: {
        code: 'harness_tool_arguments_invalid',
        message: REPAIRED_ACTION_BATCH_MESSAGE,
      },
    })),
    needs: [],
  }
}

export function malformedFramingActionBatch(runId: string, turn: number, nonce: string): HarnessActionBatch {
  return malformedJsonActionBatch(runId, turn, nonce, INVALID_RESPONSE_FRAMING_ACTION_BATCH_MESSAGE, 'harness_response_framing_invalid')
}

export function malformedProtocolActionBatch(runId: string, turn: number, nonce: string): HarnessActionBatch {
  return malformedJsonActionBatch(runId, turn, nonce, INVALID_RESPONSE_PROTOCOL_ACTION_BATCH_MESSAGE, 'harness_protocol_invalid')
}

export function malformedCorrelationActionBatch(runId: string, turn: number, nonce: string): HarnessActionBatch {
  return malformedJsonActionBatch(runId, turn, nonce, INVALID_RESPONSE_CORRELATION_ACTION_BATCH_MESSAGE, 'harness_response_correlation_invalid')
}

export function malformedBenchmarkEvidenceActionBatch(runId: string, turn: number, nonce: string): HarnessActionBatch {
  return malformedJsonActionBatch(
    runId,
    turn,
    nonce,
    INVALID_BENCHMARK_EVIDENCE_ACTION_BATCH_MESSAGE,
    'harness_benchmark_evidence_insufficient',
  )
}

export function malformedJsonActionBatch(
  runId: string,
  turn: number,
  nonce: string,
  message = INVALID_RESPONSE_ACTION_BATCH_MESSAGE,
  reasonCode = 'harness_response_json_invalid',
): HarnessActionBatch {
  if (!SYNTHETIC_REISSUE_REASON_CODES.has(reasonCode)) {
    throw new HarnessSkillError('harness_response_schema_invalid', 'Synthetic Harness reissue reason is invalid.')
  }
  return {
    protocol: WEB_AGENT_PROTOCOL,
    kind: 'action_batch',
    runId,
    turn,
    nonce,
    skillLoads: [],
    calls: [{
      id: 'reissue',
      tool: 'harness.reissue',
      arguments: REPAIRED_ACTION_BATCH_ARGUMENTS,
      validationError: {
        code: 'harness_tool_arguments_invalid',
        message,
        details: { reasonCode },
      },
    }],
    needs: [],
  }
}

export function syntheticReissueReasonCode(batch: HarnessActionBatch): string | null {
  if (batch.kind !== 'action_batch'
    || batch.skillLoads.length !== 0
    || batch.needs.length !== 0
    || batch.calls.length !== 1) return null
  const call = batch.calls[0]
  if (!call) return null
  if (call.id !== 'reissue' || call.tool !== 'harness.reissue' || call.dependsOn !== undefined) return null
  if (!isJsonObject(call.arguments)
    || Object.keys(call.arguments).length !== 1
    || call.arguments.discarded !== true) return null
  const validation = call.validationError
  if (!validation || validation.code !== 'harness_tool_arguments_invalid') return null
  const details = validation.details
  if (!isJsonObject(details)
    || Object.keys(details).length !== 1
    || typeof details.reasonCode !== 'string'
    || !SYNTHETIC_REISSUE_REASON_CODES.has(details.reasonCode)) return null
  return details.reasonCode
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

  // Structural checks, including dependency graph validation, happen before
  // semantic tool checks so malformed batches still fail closed atomically.
  validateDependencies(calls)

  const tools = new Map(state.tools.map((tool) => [tool.name, tool]))
  const validatedCalls = calls.map((call) => {
    const tool = tools.get(call.tool)
    if (!tool) {
      return {
        ...call,
        validationError: {
          code: 'harness_tool_unknown' as const,
          message: `Tool '${call.tool}' is not present in the frozen catalog.`,
          details: { tool: call.tool },
        },
      }
    }
    if (!isJsonObject(call.arguments)) {
      return {
        ...call,
        validationError: {
          code: 'harness_tool_arguments_invalid' as const,
          message: `Arguments for tool '${call.tool}' must be a JSON object.`,
          details: { expectedType: 'object' },
        },
      }
    }
    try {
      validateJsonSchemaValue(tool.inputSchema, call.arguments, `Arguments for tool '${call.tool}'`)
      return call
    } catch (error) {
      if (!(error instanceof HarnessSkillError) || error.code !== 'harness_json_schema_validation_failed') throw error
      return {
        ...call,
        validationError: validationError(error),
      }
    }
  })
  return {
    protocol: WEB_AGENT_PROTOCOL,
    kind: 'action_batch',
    runId: value.runId as string,
    turn: value.turn as number,
    nonce: value.nonce as string,
    skillLoads,
    calls: validatedCalls,
    needs,
  }
}

function validationError(error: HarnessSkillError): HarnessToolCallValidationError {
  return {
    code: 'harness_tool_arguments_invalid',
    message: error.message,
    ...(error.context?.issues === undefined ? {} : { details: { issues: error.context.issues } }),
  }
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finalResponse(value: Record<string, unknown>, state: HarnessSkillState, stringOutputProperty: string | null): HarnessFinalResponse {
  if (typeof value.output !== 'string') {
    throw new HarnessSkillError('harness_final_invalid', 'final.output must be a string.')
  }
  let output = value.output
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
      if ((isCommaSerializationError(error) || isStringSerializationError(error)) && stringOutputProperty !== null) {
        const repaired = repairSingleStringPropertyValue(value.output, stringOutputProperty)
        if (repaired !== null) {
          try {
            structuredOutput = parseHarnessStrictJson(repaired)
            output = repaired
          } catch (repairError) {
            throw new HarnessSkillError(
              'harness_final_output_invalid',
              `final.output must contain strict JSON: ${repairError instanceof Error ? repairError.message : 'invalid JSON'}`,
            )
          }
        } else {
          throw new HarnessSkillError(
            'harness_final_output_invalid',
            `final.output must contain strict JSON: ${error instanceof Error ? error.message : 'invalid JSON'}`,
          )
        }
      } else {
        throw new HarnessSkillError(
          'harness_final_output_invalid',
          `final.output must contain strict JSON: ${error instanceof Error ? error.message : 'invalid JSON'}`,
        )
      }
    }
    validateJsonSchemaValue(state.finalOutput.schema, structuredOutput, 'final.output')
  }
  return {
    protocol: WEB_AGENT_PROTOCOL,
    kind: 'final',
    runId: value.runId as string,
    turn: value.turn as number,
    nonce: value.nonce as string,
    output,
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
  assertJsonValue(call.arguments, 'tool call arguments')
  const argumentsValue = call.arguments as JsonValue
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
    throw new HarnessSkillError('harness_response_correlation_invalid', INVALID_RESPONSE_CORRELATION_ACTION_BATCH_MESSAGE)
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

function isCommaSerializationError(error: unknown) {
  return error instanceof HarnessSkillError
    && error.code === 'harness_response_json_invalid'
    && error.message === 'JSON object entries must be separated by commas'
}

function isResponseJsonInvalid(error: unknown) {
  return error instanceof HarnessSkillError && error.code === 'harness_response_json_invalid'
}

function isResponseSchemaInvalid(error: unknown) {
  return error instanceof HarnessSkillError && error.code === 'harness_response_schema_invalid'
}

function isModelCorrectableResponseError(error: unknown, parsedEnvelope: Record<string, unknown> | null) {
  if (!(error instanceof HarnessSkillError)) return false
  if (MODEL_CORRECTABLE_RESPONSE_CODES.has(error.code)) return true
  return error.code === 'harness_json_schema_validation_failed' && parsedEnvelope?.kind === 'final'
}

function isStringSerializationError(error: unknown) {
  return error instanceof HarnessSkillError
    && error.code === 'harness_response_json_invalid'
    && (
      error.message === 'JSON string escape is invalid'
      || error.message === 'JSON unicode escape is invalid'
      || error.message === 'JSON string escape is incomplete'
      || error.message === 'JSON strings cannot contain unescaped control characters'
  )
}

function rawStrictObjectCandidate(value: string): string | null {
  if (value.includes(OPEN_MARKER) || value.includes(CLOSE_MARKER) || !value.startsWith('{') || !value.endsWith('}')) return null
  try {
    const parsed = parseHarnessStrictJson(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? value : null
  } catch {
    return null
  }
}

function singleRequiredStringSchemaProperty(schema: JsonValue): string | null {
  if (!isJsonObject(schema) || schema.type !== 'object' || schema.additionalProperties !== false) return null
  const properties = schema.properties
  if (properties === undefined || !isJsonObject(properties)) return null
  const names = Object.keys(properties)
  if (names.length !== 1) return null
  const property = properties[names[0]!]
  if (property === undefined || !isJsonObject(property) || property.type !== 'string') return null
  const required = schema.required
  if (!Array.isArray(required) || required.length !== 1 || required[0] !== names[0]) return null
  return names[0]!
}

function repairFinalEnvelopeOutput(source: string): string | null {
  const outputToken = '"output"'
  const artifactsToken = '"artifacts"'
  const outputIndex = source.indexOf(outputToken)
  const artifactsIndex = source.indexOf(artifactsToken)
  if (outputIndex < 0 || artifactsIndex < 0
    || source.indexOf(outputToken, outputIndex + outputToken.length) >= 0
    || source.indexOf(artifactsToken, artifactsIndex + artifactsToken.length) >= 0) return null
  const outputColon = skipJsonWhitespace(source, outputIndex + outputToken.length)
  if (source[outputColon] !== ':') return null
  const valueStart = skipJsonWhitespace(source, outputColon + 1)
  if (source[valueStart] !== '"') return null
  const artifactsColon = skipJsonWhitespace(source, artifactsIndex + artifactsToken.length)
  if (source[artifactsColon] !== ':') return null
  const comma = previousJsonToken(source, artifactsIndex - 1)
  const close = previousJsonToken(source, comma - 1)
  if (source[comma] !== ',' || source[close] !== '"' || close <= valueStart) return null
  try {
    parseHarnessStrictJson(`${source.slice(0, valueStart)}""}`)
    parseHarnessStrictJson(`{${source.slice(artifactsIndex)}`)
  } catch {
    return null
  }
  return escapeJsonStringSpan(source, valueStart + 1, close)
}

function repairSingleStringPropertyValue(source: string, propertyName: string): string | null {
  const root = /^\s*\{\s*/u.exec(source)
  if (!root) return null
  const keyStart = root[0].length
  const key = JSON.stringify(propertyName)
  if (!source.startsWith(key, keyStart)) return null
  const value = /^\s*:\s*"/u.exec(source.slice(keyStart + key.length))
  if (!value) return null
  const valueStart = keyStart + key.length + value[0].length - 1
  try {
    parseHarnessStrictJson(`${source.slice(0, valueStart)}""}`)
  } catch {
    return null
  }
  const rootClose = source.trimEnd().length - 1
  if (source[rootClose] !== '}') return null
  const valueClose = source.lastIndexOf('"', rootClose - 1)
  if (source[valueClose] !== '"' || valueClose <= valueStart) return null
  if (hasAmbiguousObjectMember(source, valueStart + 1, valueClose)) return null
  const repaired = escapeJsonStringSpan(source, valueStart + 1, valueClose)
  if (repaired === null) return null
  try {
    const parsed = record(parseHarnessStrictJson(repaired), 'final.output')
    if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, propertyName) || typeof parsed[propertyName] !== 'string') return null
  } catch {
    return null
  }
  return repaired
}

function skipJsonWhitespace(source: string, start: number, end = source.length): number {
  let index = start
  while (index < end && /[\t\n\r ]/u.test(source[index]!)) index += 1
  return index
}

function previousJsonToken(source: string, start: number): number {
  let index = start
  while (index >= 0 && /[\t\n\r ]/u.test(source[index]!)) index -= 1
  return index
}

function hasAmbiguousObjectMember(source: string, start: number, end: number) {
  let previousQuote = -1
  let beforePreviousQuote = -1
  let escaped = false
  for (let index = start; index < end; index += 1) {
    const character = source[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character !== '"') continue
    const after = skipJsonWhitespace(source, index + 1, end)
    if (source[after] === ':' && beforePreviousQuote >= 0) {
      const separator = skipJsonWhitespace(source, beforePreviousQuote + 1, previousQuote)
      const afterComma = source[separator] === ','
        ? skipJsonWhitespace(source, separator + 1, previousQuote)
        : separator
      if (afterComma === previousQuote) return true
    }
    beforePreviousQuote = previousQuote
    previousQuote = index
  }
  return false
}

function escapeJsonStringSpan(source: string, start: number, end: number): string | null {
  let repaired = source.slice(0, start)
  let repairs = 0
  const addRepair = (replacement: string) => {
    repairs += 1
    if (repairs > MAX_SEMANTIC_STRING_SPAN_REPAIRS) return false
    repaired += replacement
    return true
  }
  for (let index = start; index < end;) {
    const character = source[index]!
    if (character === '\\') {
      const next = source[index + 1]
      if (next === 'u' && /^[0-9A-Fa-f]{4}$/u.test(source.slice(index + 2, index + 6))) {
        repaired += source.slice(index, index + 6)
        index += 6
        continue
      }
      if (next !== undefined && '"\\/bfnrt'.includes(next)) {
        repaired += source.slice(index, index + 2)
        index += 2
        continue
      }
      if (!addRepair('\\\\')) return null
      index += 1
      continue
    }
    if (character === '"') {
      if (!addRepair('\\u0022')) return null
      index += 1
      continue
    }
    const code = character.codePointAt(0)!
    if (code < 0x20) {
      const escaped = code === 0x08 ? '\\b'
        : code === 0x09 ? '\\t'
          : code === 0x0a ? '\\n'
            : code === 0x0c ? '\\f'
              : code === 0x0d ? '\\r'
                : `\\u${code.toString(16).padStart(4, '0')}`
      if (!addRepair(escaped)) return null
      index += character.length
      continue
    }
    repaired += character
    index += character.length
  }
  repaired += source.slice(end)
  return repairs === 0 ? null : repaired
}

function escapeUnexpectedJsonStringQuotes(value: string): string | null {
  let inString = false
  let escaped = false
  let repairs = 0
  let repairedValue = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (!inString) {
      repairedValue += character
      if (character === '"') inString = true
      continue
    }
    if (escaped) {
      repairedValue += character
      escaped = false
      continue
    }
    if (character === '\\') {
      repairedValue += character
      escaped = true
      continue
    }
    if (character === '"') {
      const next = nextJsonToken(value, index + 1)
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        repairedValue += character
        inString = false
      } else {
        repairs += 1
        if (repairs > MAX_SEMANTIC_QUOTE_REPAIRS) return null
        repairedValue += '\\u0022'
      }
      continue
    }
    repairedValue += character
  }
  return repairs === 0 ? null : repairedValue
}

function nextJsonToken(source: string, start: number) {
  let index = start
  while (index < source.length && /[\t\n\r ]/u.test(source[index]!)) index += 1
  return source[index]
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
