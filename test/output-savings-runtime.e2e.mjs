import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('built daemon records output savings directly from a completed result', { timeout: 180_000 }, async () => {
  const tempRoot = fs.realpathSync.native(os.tmpdir())
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, 'tokenless-output-savings-runtime-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({
    protocol: 'tokenless.config.v1',
    updatedAt: null,
    profiles: {},
    browser: 'chrome',
    browserExecutablePath: null,
    browserVisibility: 'headed',
    daemonUrl,
    language: 'en',
    outputSavings: { enabled: true },
    apiProxy: { enabled: false, executionMode: 'direct' },
    g4f: { enabled: false },
    directProvider: { defaultBackend: 'native', providerBackends: {} },
    router: { enabled: false, engine: 'chrome-prompt-api', providers: [] },
  }) + '\n', { mode: 0o600 })
  try {
    const initial = runSavings(homeDir, 'status')
    assert.equal(initial.outputSavings.enabled, true)
    assert.equal(initial.outputSavings.collection, 'unavailable')
    assert.equal(initial.outputSavings.runtime.state, 'not_installed')
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)

    const [{ OutputSavingsRuntimeManager }, { JobStore }] = await Promise.all([
      import('../packages/cli/dist/src/index.js'),
      import('../packages/server/dist/src/jobs/store.js'),
    ])
    const runtimeManager = new OutputSavingsRuntimeManager(homeDir)
    const measurement = await runtimeManager.measure('hello world', { installIfMissing: true })
    assert.equal(measurement.state, 'measured')
    const store = await JobStore.open(homeDir)
    try {
      const created = store.createJob({
        provider: 'chatgpt',
        request_json: { taskId: 'direct-savings' },
        profile_id: 'savings-profile',
      })
      const running = store.takeNextJob({}, 'savings-profile')
      assert.ok(running)
      const completed = store.completeJob(running.job_id, {
        result_json: {
          protocol: 'tokenless.playwright.job.v3',
          provider: 'chatgpt',
          responses: [{
            protocol: 'tokenless.playwright.visible-action.v3',
            requestId: 'direct-savings-response',
            provider: 'chatgpt',
            action: 'response.read',
            ok: true,
            result: {
              text: 'hello world',
              citations: [],
              visibleProof: 'visible-answer-read',
              outputSavings: measurement,
            },
            error: null,
          }],
        },
      })
      assert.equal(completed.status, 'succeeded')
      assert.ok(store.outputSavingsSummary().estimated_output_tokens > 0)
      assert.equal(store.outputSavingsSummary().response_count, 1)
      assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), true)
    } finally {
      store.close()
    }

    const measured = runSavings(homeDir, 'status')
    assert.equal(measured.outputSavings.collection, 'enabled')
    assert.ok(measured.outputSavings.summary.estimated_output_tokens > 0)
    assert.equal(measured.outputSavings.summary.response_count, 1)
    assert.equal(measured.outputSavings.summary.job_count, 1)

    const enabled = runSavings(homeDir, 'enable')
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
    assert.ok(enabled.outputSavings.summary.estimated_output_tokens > 0)
    assert.equal(enabled.outputSavings.summary.response_count, 1)
    assert.equal(enabled.outputSavings.summary.job_count, 1)

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
    stopDaemon(homeDir)
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

function stopDaemon(homeDir) {
  spawnSync(process.execPath, [
    cliEntry,
    'daemon',
    'stop',
    '--home',
    homeDir,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  })
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === 'string') reject(new Error('failed to allocate a port'))
        else resolve(address.port)
      })
    })
  })
}
