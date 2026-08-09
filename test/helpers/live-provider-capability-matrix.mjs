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

const schema = 'tokenless.live-provider-capability-matrix.v2'
const gates = new Set(['non_submission', 'mutation', 'project'])
const knownIssueSkipReasons = new Set(['claude_recurring_cloudflare_human_check'])
const knownIssueSkipBlockerCodes = new Set([
  'visible_cloudflare_turnstile',
  'visible_cloudflare_interstitial',
])
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
  'exact_visible_identity',
  'deep_research_surface',
  'research_plan',
  'terminal_report',
  'durable_background_job',
  'docs_surface',
  'slides_surface',
  'sheets_surface',
  'websites_surface',
  'terminal_artifact',
  'visible_download',
  'terminal_state',
  'agent_swarm_surface',
  'visible_agent_plan',
  'visible_parallel_progress',
  'visible_search_selection',
])

export function loadLiveProviderCapabilityMatrix() {
  const matrix = JSON.parse(fs.readFileSync(liveProviderCapabilityMatrixPath, 'utf8'))
  validateLiveProviderCapabilityMatrix(matrix)
  return matrix
}

export function validateLiveProviderCapabilityMatrix(matrix) {
  assert.equal(isRecord(matrix), true, 'live capability matrix must be an object')
  assert.deepEqual(
    Object.keys(matrix).sort(),
    ['cases', 'journey', 'knownIssueSkips', 'providers', 'schema'],
    'live capability matrix fields must be exact',
  )
  assert.equal(matrix.schema, schema)
  assert.deepEqual(matrix.journey, {
    scope: 'provider_capability',
    pagePolicy: 'one_managed_page',
    caseOrder: 'providers.required',
    identityProof: ['stable_task_id', 'stable_chromium_target_id'],
  })
  assert.equal(isRecord(matrix.cases), true, 'live capability matrix cases must be an object')
  assert.equal(isRecord(matrix.providers), true, 'live capability matrix providers must be an object')
  assert.equal(Array.isArray(matrix.knownIssueSkips), true, 'live capability matrix knownIssueSkips must be an array')

  const visibleActions = new Set(Object.values(VISIBLE_ACTIONS))
  const caseIds = Object.keys(matrix.cases)
  assert.ok(caseIds.length > 0, 'live capability matrix must declare cases')
  for (const caseId of caseIds) {
    assert.match(caseId, /^[a-z][a-z0-9-]*$/)
    const definition = matrix.cases[caseId]
    assert.deepEqual(Object.keys(definition).sort(), ['actions', 'closure', 'gate', 'submissions'])
    assert.equal(gates.has(definition.gate), true, `${caseId} gate must be recognized`)
    assert.equal(Number.isSafeInteger(definition.submissions), true, `${caseId} submissions must be an integer`)
    assert.ok(definition.submissions >= 0 && definition.submissions <= 4, `${caseId} submissions must be between zero and four`)
    assert.equal(
      definition.gate === 'non_submission',
      definition.submissions === 0,
      `${caseId} submission budget must match its gate`,
    )
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
  const providerIds = new Set(descriptors.map((provider) => provider.id))
  validateKnownIssueSkips(matrix.knownIssueSkips, providerIds)
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

export function knownIssueSkipForDurableBlocker(matrix, provider, payload) {
  if (payload?.status !== 'waiting_for_user') return null
  if (payload?.provider !== provider) return null
  const blockerCodes = structuredBlockerCodes(payload?.blocker)
  for (const issue of matrix.knownIssueSkips) {
    if (issue.provider !== provider) continue
    const blockerCode = blockerCodes.find((code) => issue.blockerCodes.includes(code))
    if (!blockerCode) continue
    return {
      provider: issue.provider,
      reason: issue.reason,
      blockerCode,
    }
  }
  return null
}

export function structuredBlockerCodes(blocker) {
  const codes = []
  appendBlockerCode(codes, blocker)
  appendBlockerCode(codes, blocker?.primary)
  appendBlockerCode(codes, blocker?.blocker)
  if (Array.isArray(blocker?.blockers)) {
    for (const candidate of blocker.blockers) appendBlockerCode(codes, candidate)
  }
  return [...new Set(codes)]
}

function validateKnownIssueSkips(knownIssueSkips, providerIds) {
  assert.equal(knownIssueSkips.length, 1, 'live capability matrix must declare exactly one known issue skip')
  for (const issue of knownIssueSkips) {
    assert.equal(isRecord(issue), true, 'known issue skip must be an object')
    assert.deepEqual(
      Object.keys(issue).sort(),
      ['blockerCodes', 'provider', 'reason'],
      'known issue skip fields must be exact',
    )
    assert.equal(issue.provider, 'claude', 'known issue skip provider must be claude')
    assert.equal(providerIds.has(issue.provider), true, `${issue.provider} known issue provider must be registered`)
    assert.equal(
      knownIssueSkipReasons.has(issue.reason),
      true,
      `${issue.provider} known issue skip reason must be recognized`,
    )
    assert.equal(Array.isArray(issue.blockerCodes), true, `${issue.provider} known issue blockerCodes must be an array`)
    assert.ok(issue.blockerCodes.length > 0, `${issue.provider} known issue must declare blocker codes`)
    assert.equal(
      new Set(issue.blockerCodes).size,
      issue.blockerCodes.length,
      `${issue.provider} known issue blocker codes must be unique`,
    )
    assert.deepEqual(
      [...issue.blockerCodes].sort(),
      [...knownIssueSkipBlockerCodes].sort(),
      `${issue.provider} known issue blocker codes must match the allowed Cloudflare codes exactly`,
    )
    for (const code of issue.blockerCodes) {
      assert.equal(
        knownIssueSkipBlockerCodes.has(code),
        true,
        `${issue.provider} known issue blocker code ${code} is not allowed`,
      )
    }
  }
}

function appendBlockerCode(codes, candidate) {
  if (isRecord(candidate) && typeof candidate.code === 'string') codes.push(candidate.code)
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
