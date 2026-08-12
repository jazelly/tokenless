import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

import { browserRuntimeStatus } from '../packages/cli/dist/src/index.js'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'
import {
  FEATUREBENCH_COMMIT,
  FEATUREBENCH_DATASET_REVISION,
  FEATUREBENCH_WIRING_TASK,
  runFeatureBenchProviderCase,
} from './helpers/featurebench-provider-case.mjs'

assert.equal(requiredEnvironment('TOKENLESS_LIVE_FEATUREBENCH_GATE'), 'real-featurebench')

const provider = requiredEnvironment('TOKENLESS_FEATUREBENCH_PROVIDER')
const executionMode = requiredEnvironment('TOKENLESS_FEATUREBENCH_EXECUTION_MODE')
assert.ok(executionMode === 'browser' || executionMode === 'direct', 'TOKENLESS_FEATUREBENCH_EXECUTION_MODE must be browser or direct.')
const target = await resolveConfiguredBrowserTarget()

test('built Tokenless scaffold completes one real FeatureBench task through the official evaluator', { timeout: 3 * 60 * 60_000 }, async () => {
  const result = await runFeatureBenchProviderCase({
    provider,
    executionMode,
    homeDir: target.homeDir,
    profile: target.profile.slug,
    daemonUrl: target.config.daemonUrl,
    model: process.env.TOKENLESS_FEATUREBENCH_MODEL?.trim() || 'provider-default',
    effort: process.env.TOKENLESS_FEATUREBENCH_EFFORT?.trim(),
  })

  assert.equal(result.report.benchmarkCommit, FEATUREBENCH_COMMIT)
  assert.equal(result.report.datasetRevision, FEATUREBENCH_DATASET_REVISION)
  assert.equal(result.report.scope, 'wiring')
  assert.deepEqual(result.report.requestedTasks, [FEATUREBENCH_WIRING_TASK])
  assert.equal(result.report.attemptsPerTask, 1)
  assert.equal(result.report.totalTasks, 1)
  assert.equal(result.report.completedTasks, 1)
  assert.equal(result.report.missingTasks, 0)
  assert.equal(result.report.infrastructureFailures, 0)
  assert.equal(result.report.officialEvaluation.totalInstances, 1)
  assert.equal(result.report.officialEvaluation.completedInstances, 1)
  assert.equal(result.report.officialEvaluation.resolvedInstances, 1)
  assert.equal(result.report.resolvedPercent, 100)

  const [runtime, profileDirectory] = await Promise.all([
    browserRuntimeStatus({
      homeDir: target.homeDir,
      ...(target.config.daemonUrl ? { daemonUrl: target.config.daemonUrl } : {}),
    }),
    fs.stat(target.profile.directory),
  ])
  assert.equal(runtime.status, 'running')
  assert.ok(runtime.activeProfileCount >= 1)
  assert.ok(profileDirectory.isDirectory())
})

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}
