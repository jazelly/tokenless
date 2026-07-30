import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VISIBLE_ACTIONS,
  listProviderDescriptors,
} from '../../packages/cli/dist/src/playwright/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const liveProviderCapabilityMatrixPath = path.join(root, 'test/live-provider-capability-matrix.json')

const schema = 'tokenless.live-provider-capability-matrix.v1'
const gates = new Set(['non_submission', 'mutation', 'project'])
const accountConditions = new Set([
  'signed_in_selected_setup_profile',
  'guest_or_signed_in_selected_setup_profile',
])
const closures = new Set([
  'cli',
  'visible_dom',
  'durable_state',
  'restore_original',
  'visible_attachment',
  'visible_response',
  'visible_submission',
  'visible_citation',
  'two_cli_processes',
  'same_conversation',
  'visible_two_turns',
  'durable_mapping',
  'conversation_fallback',
  'created_then_reused',
  'project_identity',
  'project_instructions',
  'durable_project_mapping',
  'durable_conversation_mapping',
])

export function loadLiveProviderCapabilityMatrix() {
  const matrix = JSON.parse(fs.readFileSync(liveProviderCapabilityMatrixPath, 'utf8'))
  validateLiveProviderCapabilityMatrix(matrix)
  return matrix
}

export function validateLiveProviderCapabilityMatrix(matrix) {
  assert.equal(isRecord(matrix), true, 'live capability matrix must be an object')
  assert.equal(matrix.schema, schema)
  assert.equal(isRecord(matrix.cases), true, 'live capability matrix cases must be an object')
  assert.equal(isRecord(matrix.providers), true, 'live capability matrix providers must be an object')

  const visibleActions = new Set(Object.values(VISIBLE_ACTIONS))
  const caseIds = Object.keys(matrix.cases)
  assert.ok(caseIds.length > 0, 'live capability matrix must declare cases')
  for (const caseId of caseIds) {
    assert.match(caseId, /^[a-z][a-z0-9-]*$/)
    const definition = matrix.cases[caseId]
    assert.deepEqual(Object.keys(definition).sort(), ['actions', 'closure', 'gate'])
    assert.equal(gates.has(definition.gate), true, `${caseId} gate must be recognized`)
    assert.equal(Array.isArray(definition.actions), true, `${caseId} actions must be an array`)
    assert.equal(Array.isArray(definition.closure), true, `${caseId} closure must be an array`)
    assert.ok(definition.actions.length > 0, `${caseId} must declare actions`)
    assert.ok(definition.closure.length > 0, `${caseId} must declare closure`)
    assert.equal(new Set(definition.actions).size, definition.actions.length, `${caseId} actions must be unique`)
    assert.equal(new Set(definition.closure).size, definition.closure.length, `${caseId} closure must be unique`)
    for (const action of definition.actions) {
      assert.equal(visibleActions.has(action), true, `${caseId} uses unknown visible action ${action}`)
    }
    for (const closure of definition.closure) {
      assert.equal(closures.has(closure), true, `${caseId} uses unknown closure ${closure}`)
    }
  }

  const descriptors = listProviderDescriptors()
  assert.deepEqual(
    Object.keys(matrix.providers).sort(),
    descriptors.map((provider) => provider.id).sort(),
    'live capability matrix must classify every registered provider exactly once',
  )
  for (const descriptor of descriptors) {
    const provider = matrix.providers[descriptor.id]
    assert.deepEqual(
      Object.keys(provider).sort(),
      ['account', 'required', 'stage', 'unavailable'],
      `${descriptor.id} matrix fields must be exact`,
    )
    assert.equal(provider.stage, descriptor.stage, `${descriptor.id} matrix stage must match registry`)
    assert.equal(accountConditions.has(provider.account), true, `${descriptor.id} account condition must be recognized`)
    assert.equal(Array.isArray(provider.required), true)
    assert.equal(isRecord(provider.unavailable), true)
    assert.equal(new Set(provider.required).size, provider.required.length, `${descriptor.id} required cases must be unique`)
    const classified = [...provider.required, ...Object.keys(provider.unavailable)]
    assert.equal(new Set(classified).size, classified.length, `${descriptor.id} cases must not overlap`)
    assert.deepEqual(
      [...classified].sort(),
      [...caseIds].sort(),
      `${descriptor.id} must classify every live case as required or unavailable`,
    )
    for (const [caseId, reason] of Object.entries(provider.unavailable)) {
      assert.equal(typeof reason, 'string', `${descriptor.id}.${caseId} unavailable reason must be a string`)
      assert.match(reason, /^[a-z][a-z0-9_]*$/, `${descriptor.id}.${caseId} unavailable reason must be machine-readable`)
    }
  }
  return matrix
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
