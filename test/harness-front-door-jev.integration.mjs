import assert from 'node:assert/strict'
import test from 'node:test'
import { runJevRoute } from '../packages/server/dist/src/http/dashboard/jev.js'
import { JEV_COMPLEXITY_LEVELS } from '../packages/shared/dist/src/jev-router.js'

const apiKey = process.env.TYPESAFE_API_KEY

test('Jev completes a real routing decision against the live TypeSafe API', {
  skip: !apiKey ? 'Set TYPESAFE_API_KEY to run this live integration test.' : false,
  timeout: 30_000,
}, async () => {
  const { route, latencyMs } = await runJevRoute('Draft a concise launch note for the local Spark model integration.', [{
    providerId: 'chatgpt',
    label: 'ChatGPT',
    suitableTasks: 'Writing and editing',
    model: 'gpt-5',
    plan: { accessClass: 'signed_in_plus', planId: 'integration-test', label: 'Integration test plan' },
    capacity: {
      decision: 'admit',
      rules: [{ action: 'run', publishedAllowance: null, remainingUnits: null, requestedUnits: 1, decision: 'admit' }],
    },
  }, {
    providerId: 'claude',
    label: 'Claude',
    suitableTasks: 'Coding and debugging',
    model: 'claude-sonnet-5',
    plan: { accessClass: 'signed_in_plus', planId: 'integration-test', label: 'Integration test plan' },
    capacity: {
      decision: 'admit',
      rules: [{ action: 'run', publishedAllowance: null, remainingUnits: null, requestedUnits: 1, decision: 'admit' }],
    },
  }])

  assert.equal(route.providerId, 'chatgpt')
  assert.equal(route.model, 'gpt-5')
  assert.match(route.taskType, /^[a-z][a-z0-9_-]{0,31}$/u)
  assert.ok(JEV_COMPLEXITY_LEVELS.includes(route.complexity))
  assert.ok(route.reason.trim().length > 0)
  assert.ok(latencyMs > 0)
})
