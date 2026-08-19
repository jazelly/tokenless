import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createLocalHttpProviderTurnClient,
  createStdioMcpToolRegistry,
  openWebAgentHarness,
} from '../packages/harness/dist/src/index.js'
import { HarnessRunStore } from '../packages/harness/dist/src/internal/run-store.js'

test('Harness run state survives reopening the real SQLite database with exact call arguments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-store-'))
  const home = path.join(root, 'home')
  const now = new Date().toISOString()
  const runId = `run_${'1'.repeat(32)}`
  try {
    const first = await HarnessRunStore.open(home)
    const initial = first.create({
      protocol: 'tokenless.web-agent.run/v1',
      runId,
      revision: 0,
      status: 'running',
      phase: 'discovering_tools',
      spec: {
        admissionRef: `admission:${'0'.repeat(32)}`,
        provider: 'chatgpt',
        profileId: 'configured-profile',
        taskPrompt: 'Use the explicitly configured tool.',
        stagingRoot: path.join(root, 'staging'),
        mcpServers: [],
      },
      turn: 1,
      nonce: `nonce:${'2'.repeat(32)}`,
      requestRef: `request:${'3'.repeat(32)}`,
      catalog: [],
      calls: [],
      needs: [],
      callResults: [],
      needResults: [],
      history: [],
      createdAt: now,
      updatedAt: now,
    })
    const argumentsValue = { path: 'workspace/report.md', content: 'exact bytes' }
    first.update(runId, initial.revision, (current) => ({
      ...current,
      status: 'submitting_provider',
      phase: 'submitting_provider',
      requestRef: `request:${'4'.repeat(32)}`,
      pendingProviderRequest: {
        protocol: 'tokenless.provider-turn/v1',
        requestRef: `request:${'4'.repeat(32)}`,
        runId,
        turn: 2,
        nonce: `nonce:${'5'.repeat(32)}`,
        provider: 'chatgpt',
        profileId: 'configured-profile',
        stagingRoot: path.join(root, 'staging'),
        continuation: {
          providerRef: `provider:${'6'.repeat(32)}`,
          providerBindingRef: `binding:${'7'.repeat(32)}`,
          conversationRef: `conversation:${'8'.repeat(32)}`,
          result: {
            protocol: 'tokenless.web-agent/v1',
            kind: 'action_batch_result',
            batchId: 'b'.repeat(64),
            callResults: [{ id: 'call_write', status: 'succeeded', content: 'written' }],
            needResults: [],
          },
          skillLoads: [],
        },
      },
      calls: [{
        id: 'call_write',
        tool: 'mcp__files__write_file',
        arguments: argumentsValue,
        argumentsDigest: 'a'.repeat(64),
        dependsOn: [],
        approval: 'pending',
        status: 'pending',
      }],
    }))
    first.close()

    const reopened = await HarnessRunStore.open(home)
    const restored = reopened.read(runId)
    assert.equal(restored.status, 'submitting_provider')
    assert.equal(restored.revision, 1)
    assert.deepEqual(restored.calls[0].arguments, argumentsValue)
    assert.equal(restored.calls[0].argumentsDigest, 'a'.repeat(64))
    assert.equal(restored.calls[0].status, 'pending')
    assert.equal(restored.pendingProviderRequest.requestRef, `request:${'4'.repeat(32)}`)
    assert.equal(restored.pendingProviderRequest.continuation.result.callResults[0].content, 'written')
    reopened.close()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('reopening after a durable tool outcome atomically queues the exact continuation without redispatch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-outcome-'))
  const home = path.join(root, 'home')
  const runId = `run_${'9'.repeat(32)}`
  const nonce = `nonce:${'8'.repeat(32)}`
  const batchId = '7'.repeat(64)
  const now = new Date().toISOString()
  let harness
  try {
    const store = await HarnessRunStore.open(home)
    store.create({
      protocol: 'tokenless.web-agent.run/v1', runId, revision: 0, status: 'running', phase: 'executing_batch',
      spec: {
        admissionRef: `admission:${'6'.repeat(32)}`,
        provider: 'chatgpt', profileId: 'configured-profile', taskPrompt: 'Continue after the result.',
        stagingRoot: path.join(root, 'staging'), mcpServers: [],
      },
      turn: 1, nonce, requestRef: `request:${'5'.repeat(32)}`, catalog: [],
      providerTurn: {
        protocol: 'tokenless.provider-turn/v1', requestRef: `request:${'5'.repeat(32)}`,
        turnRef: `turn:${'4'.repeat(32)}`, providerRef: 'chatgpt',
        providerBindingRef: `binding:${'3'.repeat(32)}`, conversationRef: `conversation:${'2'.repeat(32)}`,
        lifecycle: 'succeeded',
      },
      batch: {
        protocol: 'tokenless.web-agent/v1', kind: 'action_batch', runId, turn: 1, nonce,
        skillLoads: [], calls: [{ id: 'call_done', tool: 'mcp__everything__echo', arguments: { message: 'done' } }], needs: [],
      },
      batchId,
      calls: [{
        id: 'call_done', tool: 'mcp__everything__echo', arguments: { message: 'done' },
        argumentsDigest: '1'.repeat(64), dependsOn: [], approval: 'approved', status: 'succeeded', outcome: 'done',
      }],
      needs: [], callResults: [{ id: 'call_done', status: 'succeeded', content: 'done' }], needResults: [], history: [],
      createdAt: now, updatedAt: now,
    })
    const admitted = store.read(runId)
    const ambiguousRunId = `run_${'a'.repeat(32)}`
    store.create({
      ...admitted,
      runId: ambiguousRunId,
      spec: { ...admitted.spec, admissionRef: `admission:${'b'.repeat(32)}` },
      calls: admitted.calls.map((call) => ({ ...call, status: 'executing', outcome: undefined })),
      callResults: [],
    })
    store.close()

    harness = await openWebAgentHarness({
      tokenlessHome: home,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: 'http://127.0.0.1:7331', token: 'a'.repeat(32) }),
      toolRegistry: createStdioMcpToolRegistry(),
    })
    const view = await harness.read(runId)
    assert.equal(view.status, 'submitting_provider')
    assert.equal(view.turn, 2)
    const ambiguous = await harness.read(ambiguousRunId)
    assert.equal(ambiguous.status, 'submitting_provider')
    harness.close()
    harness = undefined
    const reconciledStore = await HarnessRunStore.open(home)
    const reconciled = reconciledStore.read(ambiguousRunId)
    assert.equal(reconciled.pendingProviderRequest.continuation.result.callResults[0].status, 'failed')
    assert.equal(reconciled.pendingProviderRequest.continuation.result.callResults[0].content.code, 'harness_tool_outcome_ambiguous')
    reconciledStore.close()

    const reopened = await HarnessRunStore.open(home)
    const restored = reopened.read(runId)
    assert.equal(restored.revision, 1)
    assert.equal(restored.phase, 'submitting_provider')
    assert.equal(restored.history.length, 1)
    assert.equal(restored.history[0].batchId, batchId)
    assert.equal(restored.pendingProviderRequest.continuation.conversationRef, `conversation:${'2'.repeat(32)}`)
    assert.deepEqual(restored.pendingProviderRequest.continuation.result.callResults, [{ id: 'call_done', status: 'succeeded', content: 'done' }])
    reopened.close()
  } finally {
    harness?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
