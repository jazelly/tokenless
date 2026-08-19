import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createLocalHttpClient } from '../packages/harness/dist/src/http/provider-turn/http-client.js'
import {
  createLocalHttpProviderTurnClient,
  createAgentRunHttpHandler,
  createStdioMcpToolRegistry,
  finalizeHarnessBootstrapTurn,
  openWebAgentHarness,
  prepareHarnessBootstrapTurn,
} from '../packages/harness/dist/src/index.js'
import { canonicalJson } from '../packages/harness/dist/src/internal/filesystem.js'
import { HarnessRunStore } from '../packages/harness/dist/src/internal/run-store.js'
import { serveHttp } from '../packages/server/dist/src/http/server.js'
import { JobStore } from '../packages/server/dist/src/jobs/store.js'
import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'
import { writeTokenlessConfig } from '../packages/cli/dist/src/index.js'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')

test('an incorrect approval digest preserves the run and the exact approved call resumes through real MCP and local HTTP', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-approval-')))
  const homeDir = path.join(root, 'home')
  const stagingRoot = path.join(root, 'staging')
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({
    store,
    host: '127.0.0.1',
    port: 0,
    agentRunHandlerFactory: createAgentRunHttpHandler,
  })
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

test('injected completed local turn returns semantic call failures and same-conversation continuation', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-tool-errors-')))
  const homeDir = path.join(root, 'home')
  const stagingRoot = path.join(root, 'staging')
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  let harness
  try {
    const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'tool-errors', lifecycle: 'ready' })
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
    const echo = catalog.find((entry) => entry.serverToolName === 'echo')
    assert.ok(echo)
    const runId = `run_${'e'.repeat(32)}`
    const nonce = `nonce:${'f'.repeat(32)}`
    const taskPrompt = 'Continue after semantic tool-call errors.'
    const preparation = await prepareHarnessBootstrapTurn({
      runId, stagingRoot, taskPrompt, nonce,
      tools: catalog.map(({ server, serverToolName, readOnly, approval, ...tool }) => tool),
    })
    await finalizeHarnessBootstrapTurn({
      runId, stagingRoot, nonce,
      attachmentAcceptances: preparation.attachments.map((attachment) => ({ name: attachment.name, sha256: attachment.sha256, accepted: true })),
    })

    const staged = await local.stage(binding.providerBindingRef, await fs.readFile(preparation.systemPrompt.sourcePath), { name: preparation.systemPrompt.name })
    const actionBatch = {
      protocol: 'tokenless.web-agent/v1',
      kind: 'action_batch',
      runId,
      turn: 1,
      nonce,
      skillLoads: [],
      calls: [
        { id: 'call_bad', tool: echo.name, arguments: { message: 42 }, dependsOn: [] },
        { id: 'call_array', tool: echo.name, arguments: [], dependsOn: [] },
        { id: 'call_good', tool: echo.name, arguments: { message: 'independent' }, dependsOn: [] },
        { id: 'call_revalidate', tool: echo.name, arguments: { message: 'revalidate-before-mcp' }, dependsOn: [] },
        { id: 'call_dep', tool: echo.name, arguments: { message: 'blocked' }, dependsOn: ['call_bad'] },
        { id: 'call_dep2', tool: echo.name, arguments: { message: 'blocked-twice' }, dependsOn: ['call_dep'] },
        { id: 'call_unknown', tool: 'mcp__everything__missing', arguments: {}, dependsOn: [] },
      ],
      needs: [],
    }
    const first = await local.start(binding.providerBindingRef, {
      protocol: 'tokenless.internal.web-ai-interaction-protocol/v0',
      requestRef: `request:${'1'.repeat(32)}`,
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
      canonical_url: 'https://chatgpt.com/c/harness-tool-errors', job_id: job.job_id,
    })
    // Inject a completed local control-plane turn; this proves Harness handling, not provider behavior.
    store.completeJob(claim.job_id, claim.claim_token, { result_json: successfulVisibleResult(framed(actionBatch)) })

    const batchId = digest({ runId, turn: 1, nonce, batch: actionBatch })
    const calls = actionBatch.calls.map((call) => ({
      ...call,
      argumentsDigest: digest({ runId, turn: 1, nonce, batchId, callId: call.id, tool: call.tool, arguments: call.arguments }),
      approval: 'not_required',
      status: 'pending',
    }))
    const now = new Date().toISOString()
    const runStore = await HarnessRunStore.open(homeDir)
    runStore.create({
      protocol: 'tokenless.web-agent.run/v1', runId, revision: 0, status: 'running', phase: 'awaiting_provider',
      spec: { admissionRef: `admission:${'2'.repeat(32)}`, provider: 'chatgpt', profileId: profile.id, taskPrompt, stagingRoot, mcpServers },
      turn: 1, nonce, requestRef: `request:${'1'.repeat(32)}`, catalog,
      providerTurn: {
        protocol: 'tokenless.provider-turn/v1', requestRef: `request:${'1'.repeat(32)}`,
        runId, turn: 1, nonce, provider: 'chatgpt', profileId: profile.id,
        turnRef: first.turnRef, providerRef: first.providerRef, providerBindingRef: first.providerBindingRef,
        conversationRef: first.conversationRef, lifecycle: 'succeeded', deliverySha256: staged.sha256,
      },
      calls, needs: [], callResults: [], needResults: [], history: [], createdAt: now, updatedAt: now,
    })
    runStore.close()

    harness = await openWebAgentHarness({
      tokenlessHome: homeDir,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: daemon.origin, token }),
      toolRegistry: registry,
    })
    const accepted = await harness.read(runId)
    assert.equal(accepted.status, 'waiting_for_approval', JSON.stringify(accepted))
    assert.deepEqual(accepted.waiting.calls.map((call) => call.id), ['call_good', 'call_revalidate'])
    const waitingStore = await HarnessRunStore.open(homeDir)
    const waitingRecord = waitingStore.read(runId)
    assert.deepEqual(waitingRecord.calls.filter((call) => call.id === 'call_dep' || call.id === 'call_dep2').map((call) => ({
      id: call.id,
      status: call.status,
      approval: call.approval,
      code: call.outcome?.code,
    })), [
      { id: 'call_dep', status: 'failed', approval: 'not_required', code: 'harness_tool_dependency_failed' },
      { id: 'call_dep2', status: 'failed', approval: 'not_required', code: 'harness_tool_dependency_failed' },
    ])
    assert.deepEqual(waitingRecord.callResults.filter((result) => result.id === 'call_bad' || result.id === 'call_array' || result.id === 'call_dep' || result.id === 'call_dep2' || result.id === 'call_unknown').map((result) => ({ id: result.id, code: result.content.code })), [
      { id: 'call_bad', code: 'harness_tool_arguments_invalid' },
      { id: 'call_array', code: 'harness_tool_arguments_invalid' },
      { id: 'call_dep', code: 'harness_tool_dependency_failed' },
      { id: 'call_dep2', code: 'harness_tool_dependency_failed' },
      { id: 'call_unknown', code: 'harness_tool_unknown' },
    ])
    const goodDigest = waitingRecord.calls.find((call) => call.id === 'call_good').argumentsDigest
    const mutated = waitingStore.update(runId, waitingRecord.revision, (current) => ({
      ...current,
      calls: current.calls.map((call) => call.id === 'call_revalidate'
        ? {
            ...call,
            arguments: [],
            argumentsDigest: digest({
              runId: current.runId,
              turn: current.turn,
              nonce: current.nonce,
              batchId: current.batchId,
              callId: call.id,
              tool: call.tool,
              arguments: [],
            }),
          }
        : call),
    }))
    const revalidateDigest = mutated.calls.find((call) => call.id === 'call_revalidate').argumentsDigest
    waitingStore.close()
    const resumed = await harness.resume(runId, {
      approvals: [
        { callId: 'call_good', argumentsDigest: goodDigest },
        { callId: 'call_revalidate', argumentsDigest: revalidateDigest },
      ],
    })
    assert.equal(resumed.status, 'running')
    const continuing = await harness.read(runId)
    assert.equal(continuing.status, 'submitting_provider', JSON.stringify(continuing))

    const persistedStore = await HarnessRunStore.open(homeDir)
    const persisted = persistedStore.read(runId)
    assert.equal(persisted.status, 'submitting_provider')
    const completedBatch = persisted.history.at(-1)
    assert.ok(completedBatch)
    assert.equal(completedBatch.callResults.find((result) => result.id === 'call_bad').content.code, 'harness_tool_arguments_invalid')
    assert.equal(completedBatch.callResults.find((result) => result.id === 'call_array').content.code, 'harness_tool_arguments_invalid')
    assert.equal(completedBatch.callResults.find((result) => result.id === 'call_unknown').content.code, 'harness_tool_unknown')
    assert.equal(completedBatch.callResults.find((result) => result.id === 'call_dep').content.code, 'harness_tool_dependency_failed')
    assert.equal(completedBatch.callResults.find((result) => result.id === 'call_dep2').content.code, 'harness_tool_dependency_failed')
    assert.equal(completedBatch.callResults.find((result) => result.id === 'call_revalidate').content.code, 'harness_tool_arguments_invalid')
    assert.equal(completedBatch.callResults.find((result) => result.id === 'call_good').status, 'succeeded')
    assert.equal(completedBatch.calls.find((call) => call.id === 'call_bad').status, 'failed')
    assert.equal(completedBatch.calls.find((call) => call.id === 'call_array').status, 'failed')
    assert.equal(completedBatch.calls.find((call) => call.id === 'call_unknown').status, 'failed')
    assert.equal(completedBatch.calls.find((call) => call.id === 'call_dep').status, 'failed')
    assert.equal(completedBatch.calls.find((call) => call.id === 'call_dep2').status, 'failed')
    assert.equal(completedBatch.calls.find((call) => call.id === 'call_revalidate').status, 'failed')
    assert.equal(completedBatch.calls.find((call) => call.id === 'call_good').status, 'succeeded')

    const pending = persisted.pendingProviderRequest
    assert.equal(pending.turn, 2)
    assert.equal(pending.continuation.providerRef, first.providerRef)
    assert.equal(pending.continuation.providerBindingRef, first.providerBindingRef)
    assert.equal(pending.continuation.conversationRef, first.conversationRef)
    assert.deepEqual(pending.continuation.result.callResults.map((result) => ({
      id: result.id,
      status: result.status,
      code: result.content?.code,
    })).toSorted((left, right) => left.id.localeCompare(right.id)), [
      { id: 'call_array', status: 'failed', code: 'harness_tool_arguments_invalid' },
      { id: 'call_bad', status: 'failed', code: 'harness_tool_arguments_invalid' },
      { id: 'call_dep', status: 'failed', code: 'harness_tool_dependency_failed' },
      { id: 'call_dep2', status: 'failed', code: 'harness_tool_dependency_failed' },
      { id: 'call_good', status: 'succeeded', code: undefined },
      { id: 'call_revalidate', status: 'failed', code: 'harness_tool_arguments_invalid' },
      { id: 'call_unknown', status: 'failed', code: 'harness_tool_unknown' },
    ])
    const continuationRequestRef = pending.requestRef
    persistedStore.close()

    const submitted = await harness.read(runId)
    assert.equal(submitted.status, 'running', JSON.stringify(submitted))
    assert.notEqual(submitted.providerTurnRef, first.turnRef)
    const second = store.getWebAiTurn(submitted.providerTurnRef)
    assert.ok(second)
    assert.equal(second.conversation_ref, first.conversationRef)
    assert.equal(second.request_ref, continuationRequestRef)
    assert.notEqual(second.turn_ref, first.turnRef)
    assert.equal(store.webAiCounts().turns, 2)
    const secondJob = store.getJob(second.job_id)
    const secondClaim = store.claimJob(secondJob.job_id, secondJob.claim_token)
    store.markRunning(secondClaim.job_id, secondClaim.claim_token)
    store.recordProviderSubmission(secondClaim.job_id, secondClaim.claim_token)
    const finalResponse = {
      protocol: 'tokenless.web-agent/v1',
      kind: 'final',
      runId,
      turn: 2,
      nonce: persisted.pendingProviderRequest.nonce,
      output: 'continuation accepted',
      artifacts: [],
    }
    // Inject the completed local continuation turn at the same control-plane boundary.
    store.completeJob(secondClaim.job_id, secondClaim.claim_token, { result_json: successfulVisibleResult(framed(finalResponse)) })
    const completed = await harness.read(runId)
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed))
    assert.deepEqual(completed.final, { output: 'continuation accepted', artifacts: [] })
    const finalRecordStore = await HarnessRunStore.open(homeDir)
    const finalRecord = finalRecordStore.read(runId)
    assert.equal(finalRecord.turn, 2)
    assert.equal(finalRecord.providerTurn.conversationRef, first.conversationRef)
    assert.equal(finalRecord.providerTurn.turnRef, second.turn_ref)
    finalRecordStore.close()
  } finally {
    harness?.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function successfulVisibleResult(text = 'ready') {
  return { responses: [
    { action: 'file.upload', ok: true, result: { acceptance: 'accepted' } },
    { action: 'prompt.submit', ok: true, result: { submitted: true } },
    { action: 'response.read', ok: true, result: { text, citations: [] } },
  ] }
}

function framed(value) {
  return `<TOKENLESS_HARNESS_RESPONSE>\n${JSON.stringify(value)}\n</TOKENLESS_HARNESS_RESPONSE>`
}
