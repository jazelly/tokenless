import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('built daemon completes the job before its durable background tokenizer work updates savings', { timeout: 180_000 }, async () => {
  const tempRoot = fs.realpathSync.native(os.tmpdir())
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, 'tokenless-output-savings-runtime-')))
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
    const handoffStore = await JobStore.open(homeDir)
    try {
      const created = handoffStore.createJob({
        provider: 'chatgpt',
        action: 'visible_provider_actions',
        request_json: { taskId: 'background-savings' },
        profile_id: 'savings-profile',
      })
      const claimed = handoffStore.claimJob(created.job_id, created.claim_token)
      handoffStore.markRunning(claimed.job_id, claimed.claim_token)
      const completed = handoffStore.completeJob(claimed.job_id, claimed.claim_token, {
        result_json: {
          protocol: 'tokenless.playwright.job.v3',
          provider: 'chatgpt',
          responses: [],
        },
        output_savings_work: [{
          response_request_id: 'background-savings-response',
          source_text: 'hello world',
        }],
      })
      assert.equal(completed.status, 'succeeded')
      assert.equal(handoffStore.outputSavingsSummary().estimated_output_tokens, 0)
      assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
    } finally {
      handoffStore.close()
    }

    await waitFor(
      () => runSavings(homeDir, 'status').outputSavings.summary.estimated_output_tokens === 2,
      120_000,
    )

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
    assert.equal(enabled.outputSavings.summary.estimated_output_tokens, 2)
    assert.equal(enabled.outputSavings.summary.response_count, 1)
    assert.equal(enabled.outputSavings.summary.job_count, 1)

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
    stopDaemon(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('disabling output savings discards durable work without installing the tokenizer', async () => {
  const tempRoot = fs.realpathSync.native(os.tmpdir())
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, 'tokenless-output-savings-disabled-')))
  try {
    const { JobStore } = await import('../packages/server/dist/src/jobs/store.js')
    const store = await JobStore.open(homeDir)
    try {
      const created = store.createJob({
        provider: 'chatgpt',
        action: 'visible_provider_actions',
        request_json: { taskId: 'disabled-savings' },
        profile_id: 'savings-profile',
      })
      const claimed = store.claimJob(created.job_id, created.claim_token)
      store.markRunning(claimed.job_id, claimed.claim_token)
      store.completeJob(claimed.job_id, claimed.claim_token, {
        result_json: {
          protocol: 'tokenless.playwright.job.v3',
          provider: 'chatgpt',
          responses: [],
        },
        output_savings_work: [{
          response_request_id: 'disabled-savings-response',
          source_text: 'hello world',
        }],
      })
      assert.equal(store.pendingOutputSavingsWorkCount(), 1)
    } finally {
      store.close()
    }

    const disabled = runSavings(homeDir, 'disable')
    assert.equal(disabled.outputSavings.enabled, false)
    assert.equal(disabled.outputSavings.collection, 'disabled')
    assert.equal(disabled.outputSavings.summary.estimated_output_tokens, 0)

    const reopened = await JobStore.open(homeDir)
    try {
      assert.equal(reopened.pendingOutputSavingsWorkCount(), 0)
      assert.equal(reopened.outputSavingsSummary().estimated_output_tokens, 0)
    } finally {
      reopened.close()
    }
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
  } finally {
    stopDaemon(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

async function waitFor(predicate, timeoutMs = 30_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms.`)
}

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
