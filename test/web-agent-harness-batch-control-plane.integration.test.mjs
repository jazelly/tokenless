import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  createLocalHttpProviderTurnClient,
  createStdioMcpToolRegistry,
  openWebAgentHarness,
} from '../packages/web-agent-harness/dist/src/index.js'
import { canonicalJson } from '../packages/web-agent-harness/dist/src/internal/filesystem.js'
import { HarnessRunStore } from '../packages/web-agent-harness/dist/src/internal/run-store.js'
import { serveHttp } from '../packages/cli/dist/src/daemon/server.js'
import { JobStore } from '../packages/cli/dist/src/daemon/job-store.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'

const everythingServer = {
  name: 'everything',
  command: process.execPath,
  args: [path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js')],
  enabledTools: ['echo'],
  timeoutMs: 30_000,
}

test('SQLite-seeded local control plane validates answers before approval and real MCP execution', async () => {
  const context = await seededBatch({
    suffix: '1',
    calls: [{ id: 'call_echo', arguments: { message: 'schema-approved' }, approval: 'pending' }],
    needs: [{ id: 'need_label', prompt: 'Provide a label.', inputSchema: { type: 'string', minLength: 3 } }],
    status: 'waiting_for_input',
    phase: 'waiting_intervention',
  })
  try {
    await assert.rejects(
      context.harness.resume(context.runId, { answers: { need_label: 42 } }),
      (error) => error?.code === 'harness_json_schema_validation_failed',
    )
    assert.equal((await context.harness.read(context.runId)).status, 'waiting_for_input')

    const answered = await context.harness.resume(context.runId, { answers: { need_label: 'valid' } })
    assert.equal(answered.status, 'running')
    const approval = await context.harness.read(context.runId)
    assert.equal(approval.status, 'waiting_for_approval')
    assert.equal(approval.waiting.calls[0].arguments.message, 'schema-approved')

    await context.harness.resume(context.runId, {
      approvals: [{ callId: 'call_echo', argumentsDigest: approval.waiting.calls[0].argumentsDigest }],
    })
    const continuing = await context.harness.read(context.runId)
    assert.equal(continuing.status, 'submitting_provider')
    const record = await context.persisted()
    assert.equal(record.pendingProviderRequest.continuation.result.callResults[0].status, 'succeeded')
    assert.deepEqual(record.pendingProviderRequest.continuation.result.needResults, [{ id: 'need_label', status: 'answered', value: 'valid' }])
  } finally {
    await context.close()
  }
})

test('reverse-order DAG execution and aggregate result projection use real official MCP processes', async () => {
  const large = 'x'.repeat(180_000)
  const context = await seededBatch({
    suffix: '2',
    calls: [
      { id: 'call_child', arguments: { message: 'child' }, dependsOn: ['call_parent'], approval: 'approved' },
      { id: 'call_parent', arguments: { message: 'parent' }, approval: 'approved' },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `call_large_${index}`,
        arguments: { message: `${index}:${large}` },
        approval: 'approved',
      })),
    ],
    needs: [],
    status: 'running',
    phase: 'executing_batch',
  })
  try {
    const continuing = await context.harness.read(context.runId)
    assert.equal(continuing.status, 'submitting_provider')
    const record = await context.persisted()
    const result = record.pendingProviderRequest.continuation.result
    assert.ok(result.callResults.findIndex((item) => item.id === 'call_parent') < result.callResults.findIndex((item) => item.id === 'call_child'))
    assert.ok(result.callResults.every((item) => item.status === 'succeeded'))
    assert.ok(result.callResults.some((item) => item.content?.truncated === true))
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 768 * 1024)
  } finally {
    await context.close()
  }
})

test('an auth handoff or failed process does not block an independent ready MCP call', async () => {
  const missingServer = {
    name: 'missing', command: path.join(os.tmpdir(), 'tokenless-missing-mcp-command'), enabledTools: ['absent'], timeoutMs: 2_000,
  }
  const context = await seededBatch({
    suffix: '3',
    servers: [everythingServer, missingServer],
    calls: [
      { id: 'call_auth', arguments: {}, approval: 'approved', status: 'authentication_required', handoff: 'Complete external authentication.' },
      { id: 'call_failed', tool: 'mcp__missing__absent', arguments: {}, approval: 'approved' },
      { id: 'call_echo', arguments: { message: 'independent' }, approval: 'approved' },
    ],
    catalogExtra: [{
      name: 'mcp__missing__absent', server: 'missing', serverToolName: 'absent', description: 'Unavailable process.',
      inputSchema: { type: 'object' }, source: 'mcp', readOnly: false, approval: 'always',
    }],
    needs: [],
    status: 'running',
    phase: 'executing_batch',
  })
  try {
    const waiting = await context.harness.read(context.runId)
    assert.equal(waiting.status, 'waiting_for_authentication')
    const record = await context.persisted()
    assert.equal(record.callResults.find((item) => item.id === 'call_failed').status, 'failed')
    assert.equal(record.callResults.find((item) => item.id === 'call_echo').status, 'succeeded')
  } finally {
    await context.close()
  }
})

test('spec secrets are rejected before SQLite admission and deterministic HTTP dispatch clears its intent', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-spec-')))
  const home = path.join(root, 'home')
  const jobStore = await JobStore.open(home)
  const daemon = await serveHttp({ store: jobStore, host: '127.0.0.1', port: 0 })
  daemon.activate()
  const profile = await new ManagedProfileRegistry(home).addProfile({ slug: 'deterministic', lifecycle: 'ready' })
  const token = (await fs.readFile(path.join(home, 'daemon.token'), 'utf8')).trim()
  const harness = await openWebAgentHarness({
    tokenlessHome: home,
    providerClient: createLocalHttpProviderTurnClient({ baseUrl: daemon.origin, token }),
    toolRegistry: createStdioMcpToolRegistry(),
  })
  try {
    await assert.rejects(harness.start({
      admissionRef: `admission:${'4'.repeat(32)}`,
      provider: 'chatgpt', profileId: profile.id, taskPrompt: 'Reject the secret.', stagingRoot: path.join(root, 'staging'),
      mcpServers: [{ ...everythingServer, env: { TOKENLESS_SENTINEL_SECRET: 'must-not-persist' } }],
    }), (error) => error?.code === 'harness_spec_invalid')

    const runStore = await HarnessRunStore.open(home)
    assert.equal(runStore.databasePath.includes('harness.sqlite3'), true)
    runStore.close()
    const database = new DatabaseSync(path.join(home, 'harness.sqlite3'))
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM harness_agent_runs').get().count, 0)
    database.close()
    for (const file of (await fs.readdir(home)).filter((name) => name.startsWith('harness.sqlite3'))) {
      assert.equal((await fs.readFile(path.join(home, file))).includes(Buffer.from('must-not-persist')), false)
    }

    const admitted = await harness.start({
      admissionRef: `admission:${'5'.repeat(32)}`,
      provider: 'unsupported-provider', profileId: profile.id, taskPrompt: 'Fail deterministically.',
      stagingRoot: path.join(root, 'staging'), mcpServers: [],
    })
    assert.equal((await harness.read(admitted.runId)).status, 'submitting_provider')
    const failed = await harness.read(admitted.runId)
    assert.equal(failed.status, 'failed')
    const persisted = await readRecord(home, admitted.runId)
    assert.equal(persisted.pendingProviderRequest, undefined)
    const failedRevision = persisted.revision
    assert.equal((await harness.read(admitted.runId)).status, 'failed')
    assert.equal((await readRecord(home, admitted.runId)).revision, failedRevision)
  } finally {
    harness.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function seededBatch({ suffix, calls, needs, status, phase, servers = [everythingServer], catalogExtra = [] }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `tokenless-harness-batch-${suffix}-`)))
  const home = path.join(root, 'home')
  const registry = createStdioMcpToolRegistry()
  const catalog = [...await registry.catalog([everythingServer]), ...catalogExtra]
  const tool = catalog.find((entry) => entry.server === 'everything').name
  const runId = `run_${suffix.repeat(32)}`
  const nonce = `nonce:${suffix.repeat(32)}`
  const batch = {
    protocol: 'tokenless.web-agent/v1', kind: 'action_batch', runId, turn: 1, nonce, skillLoads: [],
    calls: calls.map((call) => ({ id: call.id, tool: call.tool ?? tool, arguments: call.arguments, ...(call.dependsOn ? { dependsOn: call.dependsOn } : {}) })),
    needs: needs.map((need) => ({ ...need, kind: 'user_input' })),
  }
  const batchId = digest({ runId, turn: 1, nonce, batch })
  const now = new Date().toISOString()
  const store = await HarnessRunStore.open(home)
  store.create({
    protocol: 'tokenless.web-agent.run/v1', runId, revision: 0, status, phase,
    spec: {
      admissionRef: `admission:${suffix.repeat(32)}`, provider: 'chatgpt', profileId: 'local-control-plane',
      taskPrompt: 'Exercise the local durable batch.', stagingRoot: path.join(root, 'staging'), mcpServers: servers,
    },
    turn: 1, nonce, requestRef: `request:${suffix.repeat(32)}`, catalog,
    providerTurn: {
      protocol: 'tokenless.provider-turn/v1', requestRef: `request:${suffix.repeat(32)}`, turnRef: `turn:${suffix.repeat(32)}`,
      providerRef: 'chatgpt', providerBindingRef: `binding:${suffix.repeat(32)}`,
      conversationRef: `conversation:${suffix.repeat(32)}`, lifecycle: 'succeeded',
    },
    batch, batchId,
    calls: calls.map((call) => ({
      id: call.id, tool: call.tool ?? tool, arguments: call.arguments,
      argumentsDigest: digest({ runId, turn: 1, nonce, batchId, callId: call.id, tool: call.tool ?? tool, arguments: call.arguments }),
      dependsOn: call.dependsOn ?? [], approval: call.approval, status: call.status ?? 'pending',
      ...(call.handoff ? { handoff: call.handoff } : {}),
    })),
    needs: needs.map((need) => ({ id: need.id, prompt: need.prompt, inputSchema: need.inputSchema })),
    callResults: [], needResults: [], history: [], createdAt: now, updatedAt: now,
  })
  store.close()
  let harness = await openWebAgentHarness({
    tokenlessHome: home,
    providerClient: createLocalHttpProviderTurnClient({ baseUrl: 'http://127.0.0.1:7331', token: 'a'.repeat(32) }),
    toolRegistry: registry,
  })
  return {
    runId,
    get harness() { return harness },
    async persisted() { return readRecord(home, runId) },
    async close() {
      harness?.close()
      harness = undefined
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

async function readRecord(home, runId) {
  const store = await HarnessRunStore.open(home)
  try { return store.read(runId) } finally { store.close() }
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
