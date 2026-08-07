import { createRequire } from 'node:module'
import type { ErrorObject } from 'ajv'
import type { Ajv2020 as Ajv2020Instance } from 'ajv/dist/2020.js'
import type { FormatsPlugin } from 'ajv-formats'

import { HarnessSkillError, type JsonValue } from '../contracts.js'

const require = createRequire(import.meta.url)
const Ajv2020 = require('ajv/dist/2020.js') as new (
  options?: ConstructorParameters<typeof Ajv2020Instance>[0]
) => Ajv2020Instance
const addFormats = require('ajv-formats') as FormatsPlugin

export function assertValidJsonSchema(schema: JsonValue, label: string) {
  createValidator(schema, label)
}

export function validateJsonSchemaValue(schema: JsonValue, value: unknown, label: string) {
  const validate = createValidator(schema, label)
  if (validate(value)) return
  const issues = (validate.errors ?? []).slice(0, 8).map((error: ErrorObject) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'is invalid',
  }))
  throw new HarnessSkillError(
    'harness_json_schema_validation_failed',
    `${label} does not satisfy its frozen JSON Schema.`,
    { issues: issues as unknown as JsonValue },
  )
}

function createValidator(schema: JsonValue, label: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  addFormats(ajv)
  try {
    return ajv.compile(schema as object | boolean)
  } catch (error) {
    throw new HarnessSkillError(
      'harness_json_schema_invalid',
      `${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : 'unknown schema error'}`,
    )
  }
}
