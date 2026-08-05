import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('built runtime lazily installs on the first default-enabled measurement, then disables and removes cleanly', { timeout: 180_000 }, async () => {
  const tempRoot = fs.realpathSync.native(os.tmpdir())
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, 'tokenless-output-savings-runtime-')))
  try {
    const initial = runSavings(homeDir, 'status')
    assert.equal(initial.outputSavings.enabled, true)
    assert.equal(initial.outputSavings.collection, 'unavailable')
    assert.equal(initial.outputSavings.runtime.state, 'not_installed')
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)

    const { OutputSavingsRuntimeManager } = await import('../packages/cli/dist/src/index.js')
    const runtimeManager = new OutputSavingsRuntimeManager(homeDir)
    const measurement = await runtimeManager.measure('hello world', { installIfMissing: true })
    assert.deepEqual({ ...measurement, measuredAt: '<measured-at>' }, {
      schema: 'tokenless.output-savings-measurement.v1',
      state: 'measured',
      basis: 'visible_assistant_text',
      estimator: 'o200k_base',
      estimatorRevision: 'tiktoken-o200k_base-1.0.22',
      estimatedOutputTokens: 2,
      visibleCharacters: 11,
      sourceTextSha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      measuredAt: '<measured-at>',
    })

    const enabled = runSavings(homeDir, 'status')
    assert.equal(enabled.outputSavings.enabled, true)
    assert.equal(enabled.outputSavings.collection, 'enabled')
    assert.deepEqual(enabled.outputSavings.runtime, {
      state: 'ready',
      runtimeId: 'tiktoken-o200k_base-1.0.22',
      installed: true,
      downloadBytes: 10_611_708,
      installedBytes: 3_413_323,
      checksumVerified: true,
      selfTestVerified: true,
    })
    assert.equal(enabled.outputSavings.summary.estimated_output_tokens, 0)

    const explicitlyEnabled = runSavings(homeDir, 'enable')
    assert.deepEqual(explicitlyEnabled.outputSavings, enabled.outputSavings)

    const disabled = runSavings(homeDir, 'disable')
    assert.equal(disabled.outputSavings.enabled, false)
    assert.equal(disabled.outputSavings.collection, 'disabled')
    assert.equal(disabled.outputSavings.runtime.state, 'ready')

    assert.equal((await runtimeManager.inspect()).state, 'ready')
    fs.appendFileSync(path.join(runtimeManager.runtimeDirectory, 'lite', 'tiktoken.cjs'), '\n')
    assert.equal((await runtimeManager.inspect()).state, 'invalid')

    const removed = runSavings(homeDir, 'uninstall', '--confirm-delete')
    assert.equal(removed.outputSavings.enabled, false)
    assert.equal(removed.outputSavings.collection, 'disabled')
    assert.equal(removed.outputSavings.runtime.state, 'not_installed')
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

function runSavings(homeDir, subcommand, ...extra) {
  const result = spawnSync(process.execPath, [
    cliEntry,
    'savings',
    subcommand,
    ...extra,
    '--home',
    homeDir,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 150_000,
  })
  assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join('\n'))
  return JSON.parse(result.stdout)
}
