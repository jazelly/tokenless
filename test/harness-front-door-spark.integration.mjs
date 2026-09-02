import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createHarnessFrontDoorSidecar,
  createSparkX25MlxAiEngine,
  HARNESS_SIDECAR_PROTOCOL,
  SPARK_X25_4B_MLX_ENGINE_ID,
  SPARK_X25_4B_MLX_HEALTH_ENDPOINT,
} from '../packages/shared/dist/src/harness-sidecar.js'

test('Front Door completes against the real local Spark MLX server', {
  timeout: 120_000,
}, async () => {
  const health = await fetch(SPARK_X25_4B_MLX_HEALTH_ENDPOINT)
  assert.equal(health.ok, true, `Spark MLX health check failed with HTTP ${health.status}`)

  const result = await createHarnessFrontDoorSidecar(createSparkX25MlxAiEngine()).prepare({
    taskPrompt: 'Draft a concise launch note for the local Spark model integration.',
    providers: [{
      providerId: 'chatgpt',
      label: 'ChatGPT',
      suitableTasks: 'Writing and editing',
      model: 'gpt-5',
      plan: {
        accessClass: 'signed_in_plus',
        planId: 'integration-test',
        label: 'Integration test plan',
      },
      capacity: {
        decision: 'admit',
        rules: [{
          action: 'run',
          publishedAllowance: null,
          remainingUnits: null,
          requestedUnits: 1,
          decision: 'admit',
        }],
      },
    }],
  })

  assert.deepEqual(
    {
      protocol: result.protocol,
      kind: result.kind,
      engine: result.engine,
    },
    {
      protocol: HARNESS_SIDECAR_PROTOCOL,
      kind: 'front_door',
      engine: SPARK_X25_4B_MLX_ENGINE_ID,
    },
  )
  assert.equal(typeof result.title, 'string')
  assert.ok(result.title.trim().length > 0)
  assert.equal(result.route.providerId, 'chatgpt')
  assert.equal(result.route.model, 'gpt-5')
  assert.match(result.route.taskType, /^[a-z][a-z0-9_-]{0,31}$/u)
  assert.ok(['low', 'medium', 'high'].includes(result.route.complexity))
  assert.ok(result.route.reason.trim().length > 0)
})
