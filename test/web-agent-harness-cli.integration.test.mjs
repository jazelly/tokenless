import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { promisify } from 'node:util'

import { serveHttp } from '../packages/cli/dist/src/daemon/server.js'
import { JobStore } from '../packages/cli/dist/src/daemon/job-store.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')

test('built singular agent CLI keeps one local control-plane turn across run, read, resume, and cancel', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-agent-cli-')))
  const homeDir = path.join(root, 'home')
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  try {
    const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'agent-cli', lifecycle: 'ready' })
    const mcpConfig = path.join(root, 'mcp.json')
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: [{
      name: 'everything',
      command: process.execPath,
      args: [path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js')],
      enabledTools: ['echo'],
      timeoutMs: 30_000,
    }] }))
    const cancellableCommand = [
      'agent', 'run', '--provider', 'chatgpt', '--profile', profile.slug,
      '--prompt', 'Cancel this admitted run.', '--mcp-config', mcpConfig,
      '--admission-ref', `admission:${'e'.repeat(32)}`,
    ]
    const cancellable = await runCli(cancellableCommand, homeDir, daemon.origin)
    const replayed = await runCli(cancellableCommand, homeDir, daemon.origin)
    assert.equal(replayed.runId, cancellable.runId)
    const pending = await runCli(['agent', 'read', '--run-id', cancellable.runId], homeDir, daemon.origin)
    assert.equal(pending.status, 'submitting_provider')
    const requestRef = harnessRequestRef(homeDir, cancellable.runId)
    const cancelledBeforeStart = await runCli(['agent', 'cancel', '--run-id', cancellable.runId], homeDir, daemon.origin)
    assert.equal(cancelledBeforeStart.status, 'cancelled')
    assert.equal(store.getWebAiTurnByRequestRef(requestRef), null)
    assert.equal(requestCancellationCount(homeDir, requestRef), 1)

    const started = await runCli([
      'agent', 'run', '--provider', 'chatgpt', '--profile', profile.slug,
      '--prompt', 'Return a final answer.', '--mcp-config', mcpConfig,
    ], homeDir, daemon.origin)
    assert.equal(started.status, 'discovering_tools', JSON.stringify(started))
    assert.match(started.runId, /^run_[a-f0-9]{32}$/)
    const submitting = await runCli(['agent', 'read', '--run-id', started.runId], homeDir, daemon.origin)
    assert.equal(submitting.status, 'submitting_provider')
    const running = await runCli(['agent', 'read', '--run-id', started.runId], homeDir, daemon.origin)
    assert.equal(running.status, 'running')
    const providerTurnRef = running.providerTurnRef
    const mapping = store.getWebAiTurn(providerTurnRef)
    assert.ok(mapping)

    injectWaitingJob(homeDir, mapping.job_id)
    const waiting = await runCli(['agent', 'read', '--run-id', started.runId], homeDir, daemon.origin)
    assert.equal(waiting.waiting.kind, 'provider')
    assert.equal(waiting.providerTurnRef, providerTurnRef)

    const resumed = await runCli(['agent', 'resume', '--run-id', started.runId, '--provider-ready'], homeDir, daemon.origin)
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.providerTurnRef, providerTurnRef)
    assert.equal(store.getWebAiTurn(providerTurnRef).job_id, mapping.job_id)
    assert.equal(store.getJob(mapping.job_id).status, 'queued')

    const cancelled = await runCli(['agent', 'cancel', '--run-id', started.runId], homeDir, daemon.origin)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.runId, started.runId)
    assert.equal(store.getJob(mapping.job_id).status, 'canceled')
  } finally {
    await daemon.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function runCli(command, homeDir, daemonUrl) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliEntry,
    ...command,
    '--home', homeDir,
    '--daemon-url', daemonUrl,
    '--json',
  ], { cwd: path.resolve('.'), env: { ...process.env, TOKENLESS_HOME: homeDir } })
  assert.equal(stderr, '')
  return JSON.parse(stdout)
}

function harnessRequestRef(homeDir, runId) {
  const database = new DatabaseSync(path.join(homeDir, 'harness.sqlite3'))
  try {
    const row = database.prepare('SELECT state_json FROM harness_agent_runs WHERE run_id = ?').get(runId)
    return JSON.parse(row.state_json).requestRef
  } finally {
    database.close()
  }
}

function requestCancellationCount(homeDir, requestRef) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  try {
    return database.prepare('SELECT COUNT(*) AS count FROM web_ai_v0_request_cancellations WHERE request_ref = ?').get(requestRef).count
  } finally {
    database.close()
  }
}

function injectWaitingJob(homeDir, jobId) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  try {
    database.prepare(`UPDATE jobs SET status = 'waiting_for_user', checkpoint_json = ?, blocker_json = ?, claim_expires_at = NULL WHERE job_id = ?`)
      .run(JSON.stringify({ phase: { state: 'waiting', action: 'blocker.check', mutating: false } }), JSON.stringify({ code: 'provider_intervention' }), jobId)
  } finally {
    database.close()
  }
}
