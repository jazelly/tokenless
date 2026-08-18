import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createLocalHttpClient } from 'tokenless-web-ai-interaction-protocol/local-http'
import {
  createLocalHttpProviderTurnClient,
  createStdioMcpToolRegistry,
  finalizeHarnessBootstrapTurn,
  openWebAgentHarness,
  prepareHarnessBootstrapTurn,
} from '../packages/web-agent-harness/dist/src/index.js'
import { canonicalJson } from '../packages/web-agent-harness/dist/src/internal/filesystem.js'
import { HarnessRunStore } from '../packages/web-agent-harness/dist/src/internal/run-store.js'
import { serveHttp } from '../packages/cli/dist/src/daemon/server.js'
import { JobStore } from '../packages/cli/dist/src/daemon/job-store.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'
import { writeTokenlessConfig } from '../packages/cli/dist/src/index.js'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')

test('an incorrect approval digest preserves the run and the exact approved call resumes through real MCP and local HTTP', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-approval-')))
  const homeDir = path.join(root, 'home')
  const stagingRoot = path.join(root, 'staging')
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  let harness
  try {
    const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'approval', lifecycle: 'ready' })
    const token = (await fs.readFile(path.join(homeDir, 'daemon.token'), 'utf8')).trim()
    const local = createLocalHttpClient({ baseUrl: daemon.origin, token })
    const binding = await local.bind('chatgpt', profile.id)
    const mcpServers = [{
      name: 'everything',
      command: process.execPath,
      args: [path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js')],
      enabledTools: ['echo'],
      timeoutMs: 30_000,
    }]
    const registry = createStdioMcpToolRegistry()
    const catalog = await registry.catalog(mcpServers)
    const runId = `run_${'a'.repeat(32)}`
    const nonce = `nonce:${'b'.repeat(32)}`
    const taskPrompt = 'Echo the approved message.'
    const preparation = await prepareHarnessBootstrapTurn({
      runId, stagingRoot, taskPrompt, nonce,
      tools: catalog.map(({ server, serverToolName, readOnly, approval, ...tool }) => tool),
    })
    await finalizeHarnessBootstrapTurn({
      runId, stagingRoot, nonce,
      attachmentAcceptances: preparation.attachments.map((attachment) => ({ name: attachment.name, sha256: attachment.sha256, accepted: true })),
    })

    const staged = await local.stage(binding.providerBindingRef, await fs.readFile(preparation.systemPrompt.sourcePath), { name: preparation.systemPrompt.name })
    const first = await local.start(binding.providerBindingRef, {
      protocol: 'tokenless.internal.web-ai-interaction-protocol/v0',
      requestRef: `request:${'c'.repeat(32)}`,
      providerRef: binding.capabilities.providerRef,
      providerBindingRef: binding.providerBindingRef,
      requiredCapabilities: ['conversation.chat', 'file.upload'],
      conversation: { mode: 'new' },
      bootstrap: { text: 'bootstrap', attachments: [{ kind: 'system_prompt', name: preparation.systemPrompt.name, ...staged }] },
    })
    const mapping = store.getWebAiTurn(first.turnRef)
    const job = store.getJob(mapping.job_id)
    const claim = store.claimJob(job.job_id, job.claim_token)
    store.markRunning(claim.job_id, claim.claim_token)
    store.recordProviderSubmission(claim.job_id, claim.claim_token)
    store.upsertProviderTaskConversation({
      provider: 'chatgpt', profile_id: profile.id, task_id: job.request_json.taskId,
      canonical_url: 'https://chatgpt.com/c/harness-approval', job_id: job.job_id,
    })
    store.completeJob(claim.job_id, claim.claim_token, { result_json: successfulVisibleResult() })

    const argumentsValue = { message: 'approval-boundary' }
    const callId = 'call_echo'
    const tool = catalog[0].name
    const batch = {
      protocol: 'tokenless.web-agent/v1', kind: 'action_batch', runId, turn: 1, nonce,
      skillLoads: [], calls: [{ id: callId, tool, arguments: argumentsValue }], needs: [],
    }
    const batchId = digest({ runId, turn: 1, nonce, batch })
    const argumentsDigest = digest({ runId, turn: 1, nonce, batchId, callId, tool, arguments: argumentsValue })
    const now = new Date().toISOString()
    const runStore = await HarnessRunStore.open(homeDir)
    runStore.create({
      protocol: 'tokenless.web-agent.run/v1', runId, revision: 0, status: 'waiting_for_approval', phase: 'waiting_intervention',
      spec: { admissionRef: `admission:${'d'.repeat(32)}`, provider: 'chatgpt', profileId: profile.id, taskPrompt, stagingRoot, mcpServers },
      turn: 1, nonce, requestRef: `request:${'c'.repeat(32)}`, catalog,
      providerTurn: {
        protocol: 'tokenless.provider-turn/v1', requestRef: `request:${'c'.repeat(32)}`,
        turnRef: first.turnRef, providerRef: first.providerRef, providerBindingRef: first.providerBindingRef,
        conversationRef: first.conversationRef, lifecycle: 'succeeded', deliverySha256: staged.sha256,
      },
      batch,
      batchId,
      calls: [{ id: callId, tool, arguments: argumentsValue, argumentsDigest, dependsOn: [], approval: 'pending', status: 'pending' }],
      needs: [], callResults: [], needResults: [], history: [], createdAt: now, updatedAt: now,
    })
    runStore.close()
    await writeTokenlessConfig({ homeDir, language: 'zh-CN' })

    const inspected = await execFileAsync(process.execPath, [
      cliEntry, 'agent', 'read', '--run-id', runId, '--home', homeDir, '--daemon-url', daemon.origin,
    ], { cwd: path.resolve('.'), env: { ...process.env, TOKENLESS_HOME: homeDir } })
    assert.match(inspected.stdout, /需要批准/)
    assert.match(inspected.stdout, /\{"message":"approval-boundary"\}/)
    assert.match(inspected.stdout, new RegExp(argumentsDigest))
    assert.equal(inspected.stderr, '')

    harness = await openWebAgentHarness({
      tokenlessHome: homeDir,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: daemon.origin, token }),
      toolRegistry: registry,
    })
    await assert.rejects(
      harness.resume(runId, { approvals: [{ callId, argumentsDigest: '0'.repeat(64) }] }),
      (error) => error?.code === 'harness_approval_invalid',
    )
    const waiting = await harness.read(runId)
    assert.equal(waiting.status, 'waiting_for_approval')
    assert.deepEqual(waiting.waiting.calls[0].arguments, argumentsValue)
    const resumed = await harness.resume(runId, { approvals: [{ callId, argumentsDigest }] })
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.turn, 1)
    const continuing = await harness.read(runId)
    assert.equal(continuing.status, 'submitting_provider')
    assert.equal(continuing.turn, 2)
    const submitted = await harness.read(runId)
    assert.equal(submitted.status, 'running', JSON.stringify(submitted))
    const latest = store.getLatestWebAiTurnForConversation(first.conversationRef)
    assert.notEqual(latest.turn_ref, first.turnRef)
    assert.equal(latest.conversation_ref, first.conversationRef)
  } finally {
    harness?.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function successfulVisibleResult() {
  return { responses: [
    { action: 'file.upload', ok: true, result: { acceptance: 'accepted' } },
    { action: 'prompt.submit', ok: true, result: { submitted: true } },
    { action: 'response.read', ok: true, result: { text: 'ready', citations: [] } },
  ] }
}
