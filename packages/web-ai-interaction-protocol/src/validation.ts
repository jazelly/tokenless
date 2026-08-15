import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ErrorObject } from 'ajv'
import type { Ajv2020 as Ajv2020Instance } from 'ajv/dist/2020.js'

import {
  ProtocolValidationError,
  type CapabilityDocument,
  type StartTurnRequest,
  type TurnState,
} from './contracts.js'
import { PROTOCOL_SCHEMA_IDS } from './version.js'
import { createAjv2020 } from './structured-control.js'

type MessageType = ProtocolValidationError['messageType']
type JsonRecord = Record<string, unknown>

const validators = createValidators()

export function parseCapabilityDocument(value: unknown): CapabilityDocument {
  return parse(value, 'capability_document', PROTOCOL_SCHEMA_IDS.capabilityDocument) as CapabilityDocument
}

export function parseStartTurnRequest(value: unknown): StartTurnRequest {
  const request = parse(value, 'start_turn_request', PROTOCOL_SCHEMA_IDS.startTurnRequest) as StartTurnRequest
  const attachments = request.bootstrap.attachments
  if (attachments[0]?.kind !== 'system_prompt' || attachments.slice(1).some((attachment) => attachment.kind !== 'skill')) {
    throw new ProtocolValidationError('start_turn_request', 'start_turn_request attachments must begin with one System Prompt followed only by Skills.')
  }
  const refs = new Set(attachments.map((attachment) => attachment.attachmentRef))
  const names = new Set(attachments.map((attachment) => attachment.name))
  if (refs.size !== attachments.length || names.size !== attachments.length) {
    throw new ProtocolValidationError('start_turn_request', 'start_turn_request attachment references and names must be unique.')
  }
  return request
}

export function parseTurnState(value: unknown): TurnState {
  return parse(value, 'turn_state', PROTOCOL_SCHEMA_IDS.turnState) as TurnState
}

function parse(value: unknown, messageType: MessageType, schemaId: string): unknown {
  assertJsonValue(value, messageType)
  assertNoForbiddenFields(value, messageType)
  const validate = validators.get(schemaId)
  if (!validate) throw new Error(`Missing bundled schema validator: ${schemaId}`)
  if (validate(value)) return value
  throw new ProtocolValidationError(messageType, `${messageType} is invalid: ${formatErrors(validate.errors ?? [])}`)
}

function createValidators() {
  const ajv = createAjv2020()
  ajv.addKeyword({
    keyword: 'x-tokenless-internal-maxUtf8Bytes',
    type: 'string',
    schemaType: 'number',
    validate(limit: number, value: string) {
      return Buffer.byteLength(value, 'utf8') <= limit
    },
  })
  for (const schema of readSchemas()) ajv.addSchema(schema)
  const validators = new Map<string, ReturnType<Ajv2020Instance['getSchema']>>()
  for (const schemaId of Object.values(PROTOCOL_SCHEMA_IDS)) {
    const validator = ajv.getSchema(schemaId)
    if (!validator) throw new Error(`Missing canonical schema: ${schemaId}`)
    validators.set(schemaId, validator)
  }
  return validators
}

function readSchemas(): object[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const schemaDirectory = path.resolve(moduleDirectory, '../../schemas/v0')
  return fs.readdirSync(schemaDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(schemaDirectory, name), 'utf8')) as object)
}

function assertJsonValue(value: unknown, messageType: MessageType): asserts value is JsonRecord {
  const visit = (current: unknown): void => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (Number.isFinite(current)) return
      throw new ProtocolValidationError(messageType, `${messageType} contains a non-finite number.`)
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry)
      return
    }
    if (typeof current === 'object' && Object.getPrototypeOf(current) === Object.prototype) {
      for (const entry of Object.values(current as JsonRecord)) visit(entry)
      return
    }
    throw new ProtocolValidationError(messageType, `${messageType} must be a plain JSON value.`)
  }
  visit(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolValidationError(messageType, `${messageType} must be a JSON object.`)
  }
}

function assertNoForbiddenFields(value: unknown, messageType: MessageType) {
  const forbidden = /(?:secret|token|profile|path|job(?:[_-]?store|[_-]?id)?|browser)/i
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry)
      return
    }
    if (!current || typeof current !== 'object') return
    for (const [key, entry] of Object.entries(current)) {
      if (forbidden.test(key)) {
        throw new ProtocolValidationError(messageType, `${messageType} contains a forbidden field.`)
      }
      visit(entry)
    }
  }
  visit(value)
}

function formatErrors(errors: ErrorObject[]) {
  return errors.slice(0, 3).map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`).join('; ')
}
