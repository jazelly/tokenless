import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HarnessRunStore } from '../packages/web-agent-harness/dist/src/internal/run-store.js'

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
      spec: {
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
