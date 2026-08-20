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
import { serveHttp } from '../packages/server/dist/src/http/server.js'
import { JobStore } from '../packages/server/dist/src/jobs/store.js'
import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'

test('one in-process Harness run approves and executes an exact real MCP call', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-approval-')))
  const homeDir = path.join(root, 'home')
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  const registry = createStdioMcpToolRegistry()
  let harness
  try {
    const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'approval', lifecycle: 'ready' })
    const token = (await fs.readFile(path.join(homeDir, 'daemon.token'), 'utf8')).trim()
    const mcpServers = [{
      name: 'everything',
      command: process.execPath,
      args: [path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js')],
      enabledTools: ['echo'],
      timeoutMs: 30_000,
    }]
    const [tool] = await registry.catalog(mcpServers)
    harness = await openWebAgentHarness({
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: daemon.origin, token }),
      toolRegistry: registry,
    })

    const started = await harness.start({
      provider: 'chatgpt',
      profileId: profile.id,
      taskPrompt: 'Echo the approved message.',
      stagingRoot: path.join(root, 'staging'),
      mcpServers,
    })
    assert.equal((await harness.read(started.runId)).status, 'submitting_provider')
    const running = await harness.read(started.runId)
    assert.equal(running.status, 'running')

    const mapping = store.getWebAiTurn(running.providerTurnRef)
    const job = store.getJob(mapping.job_id)
    const claim = store.claimJob(job.job_id, job.claim_token)
    store.markRunning(claim.job_id, claim.claim_token)
    store.recordProviderSubmission(claim.job_id, claim.claim_token)
    store.upsertProviderTaskConversation({
      provider: 'chatgpt',
      profile_id: profile.id,
      task_id: job.request_json.taskId,
      canonical_url: 'https://chatgpt.com/c/harness-approval',
      job_id: job.job_id,
    })
    const promptAction = job.request_json.actions.find((action) => action.action === 'prompt.input')
    const bootstrap = JSON.parse(promptAction.payload.text)
    store.completeJob(claim.job_id, claim.claim_token, {
      result_json: successfulVisibleResult(framed({
        protocol: 'tokenless.web-agent/v1',
        kind: 'action_batch',
        runId: started.runId,
        turn: bootstrap.turn,
        nonce: bootstrap.nonce,
        skillLoads: [],
        calls: [{ id: 'call_echo', tool: tool.name, arguments: { message: 'approval-boundary' } }],
        needs: [],
      })),
    })

    const waiting = await harness.read(started.runId)
    assert.equal(waiting.status, 'waiting_for_approval')
    assert.equal(waiting.waiting.calls[0].arguments.message, 'approval-boundary')
    await assert.rejects(
      harness.resume(started.runId, {
        approvals: [{ callId: 'call_echo', argumentsDigest: '0'.repeat(64) }],
      }),
      (error) => error?.code === 'harness_approval_invalid',
    )
    const approved = await harness.resume(started.runId, {
      approvals: [{ callId: 'call_echo', argumentsDigest: waiting.waiting.calls[0].argumentsDigest }],
    })
    assert.equal(approved.status, 'running')
    assert.equal((await harness.read(started.runId)).status, 'submitting_provider')
    await assert.rejects(fs.stat(path.join(homeDir, 'harness.sqlite3')))
  } finally {
    harness?.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

function successfulVisibleResult(text) {
  return { responses: [
    { action: 'file.upload', ok: true, result: { acceptance: 'accepted' } },
    { action: 'prompt.submit', ok: true, result: { submitted: true } },
    { action: 'response.read', ok: true, result: { text, citations: [] } },
  ] }
}

function framed(value) {
  return `<TOKENLESS_HARNESS_RESPONSE>\n${JSON.stringify(value)}\n</TOKENLESS_HARNESS_RESPONSE>`
}
