import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'
import { providerCodeSmokeCase } from './helpers/code-benchmark-provider-case.mjs'
import { browserRuntimeStatus } from '../packages/cli/dist/src/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const gate = requiredEnvironment('TOKENLESS_LIVE_DIRECT_E2E_GATE')
assert.equal(gate, 'real-perplexity-direct', 'TOKENLESS_LIVE_DIRECT_E2E_GATE must be real-perplexity-direct')

const target = await resolveConfiguredBrowserTarget()

test('built CLI completes and evaluates one real Perplexity direct code benchmark', { timeout: 600_000 }, async () => {
  const benchmark = providerCodeSmokeCase()
  await benchmark.prepare()
  const completed = spawnSync(process.execPath, [
    cliEntry,
    'run',
    '--home', target.homeDir,
    '--profile', target.profile.slug,
    '--provider', 'perplexity',
    '--execution-mode', 'direct',
    '--prompt', benchmark.prompt,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 540_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(completed.status, 0, `The built direct Perplexity CLI request must succeed.\n${completed.stderr}\n${completed.stdout}`)

  let output
  try {
    output = JSON.parse(completed.stdout)
  } catch {
    throw new Error('The built direct Perplexity CLI request did not return JSON.')
  }
  const responses = output?.result?.result?.responses
  assert.equal(output?.executionMode, 'direct')
  assert.ok(Array.isArray(responses), 'The direct Perplexity result must contain action responses.')
  const read = responses.find((response) => response?.action === 'response.read')
  assert.equal(read?.ok, true)
  assert.equal(read?.result?.visibleProof, 'direct-protocol-sse-response')
  assert.equal(typeof read?.result?.text, 'string')
  assert.ok(read.result.text.length > 0, 'The direct Perplexity text response must be non-empty.')
  assert.deepEqual(read?.result?.citations, [])
  assert.equal((await benchmark.evaluate(read.result.text)).passed, true)

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
  if (!value) throw new Error(`${name} is required.`)
  return value
}
