import { createAjv2020 } from 'tokenless-internal-shared/structured-json'

import { HarnessSkillError, type JsonValue } from '../contracts.js'

export function assertValidJsonSchema(schema: JsonValue, label: string) {
  createValidator(schema, label)
}

export function validateJsonSchemaValue(schema: JsonValue, value: unknown, label: string) {
  const validate = createValidator(schema, label)
  if (validate(value)) return
  const issues = (validate.errors ?? []).slice(0, 8).map((error) => ({
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
  const ajv = createAjv2020()
  try {
    return ajv.compile(schema as object | boolean)
  } catch (error) {
    throw new HarnessSkillError(
      'harness_json_schema_invalid',
      `${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : 'unknown schema error'}`,
    )
  }
}
