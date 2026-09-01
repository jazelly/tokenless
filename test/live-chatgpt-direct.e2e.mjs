import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

import { browserRuntimeStatus } from '../packages/cli/dist/src/index.js'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'
import { runFeatureBenchProviderCase } from './helpers/featurebench-provider-case.mjs'

const gate = requiredEnvironment('TOKENLESS_LIVE_DIRECT_E2E_GATE')
assert.equal(gate, 'real-chatgpt-direct', 'TOKENLESS_LIVE_DIRECT_E2E_GATE must be real-chatgpt-direct')
const target = await resolveConfiguredBrowserTarget()

test('built Tokenless scaffold completes one real FeatureBench task through ChatGPT direct mode', { timeout: 3 * 60 * 60_000 }, async () => {
  const result = await runFeatureBenchProviderCase({
    provider: 'chatgpt',
    executionMode: 'direct',
    homeDir: target.homeDir,
    profile: target.profile.slug,
    daemonUrl: target.config.daemonUrl,
  })
  assert.equal(result.report.executionMode, 'direct-protocol')
  assert.equal(result.report.infrastructureFailures, 0)
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
  assert.ok(runtime.activeProfileCount >= 1, 'The selected browser profile must remain attached after direct execution.')
  assert.ok(profileDirectory.isDirectory(), 'The selected browser profile directory must remain intact.')
})

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(name + ' is required.')
  return value
}
