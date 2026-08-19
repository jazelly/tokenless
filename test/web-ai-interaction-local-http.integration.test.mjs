import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parseStartTurnRequest, parseTurnState } from 'tokenless-web-ai-interaction-protocol'
import { LocalHttpError, createLocalHttpClient } from 'tokenless-web-ai-interaction-protocol/local-http'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemonServer = pathToFileURL(path.join(root, 'packages/server/dist/src/http/server.js')).href
const daemonStore = pathToFileURL(path.join(root, 'packages/server/dist/src/jobs/store.js')).href
const profileRegistry = pathToFileURL(path.join(root, 'packages/server/dist/src/browser/profiles/registry.js')).href
const startExample = JSON.parse(fs.readFileSync(path.join(root, 'packages/protocol/examples/v0/start-turn-request.json'), 'utf8'))
const markerName = '.tokenless-web-ai-v0-stage'
const maxStageBytes = 1024 * 1024

test('marker cleanup only targets V0 markers', async () => {
  await withHome(async (homeDir) => {
    let daemon = await startControlPlane(homeDir)
    try {
      await daemon.close()
      const attachments = path.join(homeDir, 'attachments')
      const orphan = path.join(attachments, 'marker-orphan')
      const ordinary = path.join(attachments, 'ordinary-bundle')
      fs.mkdirSync(orphan, { recursive: true })
      fs.mkdirSync(ordinary, { recursive: true })
      fs.writeFileSync(path.join(orphan, markerName), 'tokenless-web-ai-interaction-v0\n')
      fs.writeFileSync(path.join(ordinary, 'ordinary.bin'), 'ordinary')
      daemon = await startControlPlane(homeDir)
      assert.equal(fs.existsSync(orphan), false)
      assert.equal(fs.existsSync(ordinary), true)
      assert.equal(fs.existsSync(path.join(ordinary, 'ordinary.bin')), true)
    } finally {
      await daemon.close()
    }
  })
})

test('requestRef migration upgrades a persisted legacy V0 turns schema', async () => {
  await withHome(async (homeDir) => {
    persistLegacyWebAiTurnsSchema(homeDir)
    const daemon = await startControlPlane(homeDir)
    try {
      const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
      try {
        const columns = new Map(database.prepare('PRAGMA table_info(web_ai_v0_turns)').all().map((column) => [column.name, column]))
        assert.equal(columns.get('request_ref')?.notnull, 0)
        assert.equal(columns.get('request_sha256')?.notnull, 0)
        const index = database.prepare('PRAGMA index_list(web_ai_v0_turns)').all().find((entry) => entry.name === 'web_ai_v0_turns_request_ref_idx')
        assert.equal(index?.unique, 1)
        assert.equal(index?.partial, 1)
      } finally {
        database.close()
      }
    } finally {
      await daemon.close()
    }
  })
})

test('oversize stage is bounded and sanitized', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { client, binding, token } = await configuredClient(homeDir, daemon, 'chatgpt', 'oversize')
      const before = markerBundles(homeDir)
      const bytes = new Uint8Array(maxStageBytes + 1)
      await assertLocalHttpError(client.stage(binding.providerBindingRef, bytes), 400, 'invalid_input')
      assert.deepEqual(markerBundles(homeDir), before)
      assert.equal(daemon.store.webAiCounts().stagedAttachments, 0)
      const raw = await fetch(`${daemon.origin}/v1/web-ai/bindings/${encodeURIComponent(binding.providerBindingRef)}/attachments`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown' }, body: bytes,
      })
      assert.equal(raw.status, 400)
      assertSanitized(await raw.json(), token)
      assert.deepEqual(markerBundles(homeDir), before)
      assert.equal(daemon.store.webAiCounts().stagedAttachments, 0)
    } finally {
      await daemon.close()
    }
  })
})

test('durable failure projections preserve prompt submission certainty', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { client, binding } = await configuredClient(homeDir, daemon, 'chatgpt', 'projections')
      const uploadStarted = await startTurn(client, binding, '1', 'upload-started')
      const inputStarted = await startTurn(client, binding, '2', 'input-started')
      const promptStarted = await startTurn(client, binding, '3', 'prompt-started')
      const timeout = await startTurn(client, binding, '4', 'timeout')
      const uploadFailure = await startTurn(client, binding, '5', 'upload-failure')

      await checkpointStartedAction(daemon.store, uploadStarted.turnRef, 'file.upload')
      await checkpointStartedAction(daemon.store, inputStarted.turnRef, 'prompt.input')
      await checkpointStartedAction(daemon.store, promptStarted.turnRef, 'prompt.submit')

      const timeoutMapping = daemon.store.getWebAiTurn(timeout.turnRef)
      assert.ok(timeoutMapping)
      injectJobState(homeDir, timeoutMapping.job_id, 'timed_out', { code: 'provider_timeout' })

      const uploadMapping = daemon.store.getWebAiTurn(uploadFailure.turnRef)
      assert.ok(uploadMapping)
      const uploadJob = daemon.store.getJob(uploadMapping.job_id)
      const uploadClaim = daemon.store.claimJob(uploadJob.job_id, uploadJob.claim_token)
      daemon.store.markRunning(uploadClaim.job_id, uploadClaim.claim_token)
      daemon.store.completeJob(uploadClaim.job_id, uploadClaim.claim_token, { error_json: { code: 'file_upload_unavailable' } })

      for (const turn of [uploadStarted, inputStarted]) {
        const projected = await client.read(turn.turnRef)
        assert.equal(projected.lifecycle, 'running')
        assert.equal(projected.dispatchCertainty, 'not_dispatched')
        assert.equal(projected.attachmentDelivery.status, 'pending')
      }
      const projectedPrompt = await client.read(promptStarted.turnRef)
      assert.equal(projectedPrompt.lifecycle, 'running')
      assert.equal(projectedPrompt.dispatchCertainty, 'ambiguous')
      assert.equal(projectedPrompt.attachmentDelivery.status, 'delivered')
      const projectedTimeout = await client.read(timeout.turnRef)
      assert.equal(projectedTimeout.lifecycle, 'failed')
      assert.equal(projectedTimeout.error.code, 'timeout')
      const projectedUpload = await client.read(uploadFailure.turnRef)
      assert.equal(projectedUpload.lifecycle, 'failed')
      assert.equal(projectedUpload.attachmentDelivery.status, 'rejected')
      assert.equal(projectedUpload.error.code, 'upload_failed')
    } finally {
      await daemon.close()
    }
  })
})

test('unsupported binding stages through local-http but fails closed before job creation', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { ManagedProfileRegistry } = await import(profileRegistry)
      const registry = new ManagedProfileRegistry(homeDir)
      const profile = await registry.addProfile({ slug: 'unsupported', lifecycle: 'ready' })
      const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
      const client = createLocalHttpClient({ baseUrl: daemon.origin, token })
      const body = JSON.stringify({ provider: 'perplexity', profileId: profile.id })
      const missing = await fetch(`${daemon.origin}/v1/web-ai/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      assert.equal(missing.status, 401)
      const wrong = await fetch(`${daemon.origin}/v1/web-ai/bindings`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body })
      assert.equal(wrong.status, 403)
      const binding = await client.bind('perplexity', profile.id)
      assert.deepEqual(binding.capabilities.supportedCapabilities, ['conversation.chat'])
      const attachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# system prompt\n'))
      const request = requestFor(binding, attachment, '4')
      await assertLocalHttpError(client.start(binding.providerBindingRef, request), 400, 'invalid_input')
      assert.deepEqual(daemon.store.webAiCounts(), { bindings: 1, stagedAttachments: 1, turns: 0 })
      assert.equal(daemon.store.webAiStageStatus(attachment.attachmentRef)?.consumed, false)
    } finally {
      await daemon.close()
    }
  })
})

test('continuation reuses the proved provider conversation and resumes the same waiting turn', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { client, binding } = await configuredClient(homeDir, daemon, 'chatgpt', 'continuation')
      const first = await startTurn(client, binding, 'a', 'bootstrap')
      const firstMapping = daemon.store.getWebAiTurn(first.turnRef)
      const firstJob = daemon.store.getJob(firstMapping.job_id)
      const firstClaim = daemon.store.claimJob(firstJob.job_id, firstJob.claim_token)
      daemon.store.markRunning(firstClaim.job_id, firstClaim.claim_token)
      daemon.store.recordProviderSubmission(firstClaim.job_id, firstClaim.claim_token)
      daemon.store.upsertProviderTaskConversation({
        provider: 'chatgpt',
        profile_id: firstJob.profile_id,
        task_id: firstJob.request_json.taskId,
        canonical_url: 'https://chatgpt.com/c/tokenless-continuation',
        job_id: firstJob.job_id,
      })
      daemon.store.completeJob(firstClaim.job_id, firstClaim.claim_token, { result_json: successfulVisibleResult('first') })
      assert.equal((await client.read(first.turnRef)).lifecycle, 'succeeded')

      const resultAttachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('{"result":"exact"}'), { name: 'tool-result.md' })
      const continuationRequest = {
        protocol: startExample.protocol,
        requestRef: `request:${'b'.repeat(32)}`,
        providerRef: binding.capabilities.providerRef,
        providerBindingRef: binding.providerBindingRef,
        requiredCapabilities: ['conversation.chat', 'file.upload'],
        conversation: { mode: 'continue', conversationRef: first.conversationRef },
        continuation: {
          text: 'continue from the attached action result',
          attachments: [{ kind: 'tool_result', name: 'tool-result.md', ...resultAttachment }],
        },
      }
      const continued = await client.continue(binding.providerBindingRef, continuationRequest)
      const replayed = await client.continue(binding.providerBindingRef, continuationRequest)
      assert.equal(replayed.turnRef, continued.turnRef)
      assert.equal(continued.conversationRef, first.conversationRef)
      const continuedMapping = daemon.store.getWebAiTurn(continued.turnRef)
      const continuedJob = daemon.store.getJob(continuedMapping.job_id)
      assert.equal(continuedJob.request_json.taskId, firstJob.request_json.taskId)
      assert.equal(continuedJob.request_json.target.url, 'https://chatgpt.com/c/tokenless-continuation')

      injectWaitingJob(homeDir, continuedJob.job_id)
      assert.equal((await client.read(continued.turnRef)).lifecycle, 'waiting_for_user')
      const resumed = await client.resume(continued.turnRef)
      assert.equal(resumed.turnRef, continued.turnRef)
      assert.equal(daemon.store.getWebAiTurn(continued.turnRef).job_id, continuedJob.job_id)
      assert.equal(daemon.store.getJob(continuedJob.job_id).status, 'queued')
    } finally {
      await daemon.close()
    }
  })
})

test('authenticated V0 routes sanitize internal configuration failures', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { binding, token } = await configuredClient(homeDir, daemon, 'chatgpt', 'sanitizer')
      const poison = `broken config ${homeDir} ${token}`
      fs.writeFileSync(path.join(homeDir, 'config.json'), poison)
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const bind = await fetch(`${daemon.origin}/v1/web-ai/bindings`, {
        method: 'POST', headers, body: JSON.stringify({ provider: 'chatgpt', profileId: '00000000-0000-0000-0000-000000000000' }),
      })
      assert.equal(bind.status, 500)
      const bindBody = await bind.json()
      assert.deepEqual(bindBody.error, { code: 'local_http_error', message: 'The local Web AI service encountered an error.', retryable: true })
      assertSanitized(bindBody, token, poison)
      const capabilities = await fetch(`${daemon.origin}/v1/web-ai/bindings/${encodeURIComponent(binding.providerBindingRef)}/capabilities`, { headers })
      assert.equal(capabilities.status, 500)
      const capabilitiesBody = await capabilities.json()
      assert.deepEqual(capabilitiesBody.error, { code: 'local_http_error', message: 'The local Web AI service encountered an error.', retryable: true })
      assertSanitized(capabilitiesBody, token, poison)
    } finally {
      await daemon.close()
    }
  })
})

test('canonical start conformance rejects the same adversarial corpus at core, client, and daemon boundaries', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { client, binding, token } = await configuredClient(homeDir, daemon, 'chatgpt', 'conformance')
      const attachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# system\n'))
      const valid = requestFor(binding, attachment, '5')
      assert.deepEqual(parseStartTurnRequest(valid), valid)
      const before = daemon.store.webAiCounts()
      const corpus = [
        { ...valid, unknown: true },
        { ...valid, requiredCapabilities: ['conversation.chat'] },
        { ...valid, requiredCapabilities: ['file.upload', 'conversation.chat'] },
        { ...valid, bootstrap: { ...valid.bootstrap, text: 'x'.repeat(4001) } },
        { ...valid, bootstrap: { ...valid.bootstrap, attachments: [{ ...valid.bootstrap.attachments[0], attachmentRef: 'attachment:not-a-ref' }] } },
        { ...valid, bootstrap: { ...valid.bootstrap, attachments: [{ ...valid.bootstrap.attachments[0], byteLength: 0 }] } },
      ]
      for (const invalid of corpus) {
        assert.throws(() => parseStartTurnRequest(invalid))
        await assert.rejects(client.start(binding.providerBindingRef, invalid))
        const response = await fetch(`${daemon.origin}/v1/web-ai/bindings/${encodeURIComponent(binding.providerBindingRef)}/turns`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(invalid),
        })
        assert.equal(response.status, 400)
        assertSanitized(await response.json(), token)
        assert.deepEqual(daemon.store.webAiCounts(), before)
        assert.equal(daemon.store.webAiStageStatus(attachment.attachmentRef)?.consumed, false)
      }
      const turn = await client.start(binding.providerBindingRef, valid)
      assert.equal(turn.lifecycle, 'queued')
      assert.equal(turn.dispatchCertainty, 'not_dispatched')
      assert.equal(turn.attachmentDelivery.status, 'pending')
      const turnMapping = daemon.store.getWebAiTurn(turn.turnRef)
      assert.ok(turnMapping)
      assert.equal(turnMapping.conversation_ref, turn.conversationRef)
      const job = daemon.store.getJob(turnMapping.job_id)
      assert.equal(job.request_json.taskId, `chat:${turn.turnRef}`)
      assert.equal(job.request_json.pageRef, turn.conversationRef)
      assert.equal(Object.hasOwn(turn, 'jobId'), false)
      assert.equal(Object.hasOwn(turn, 'url'), false)
    } finally {
      await daemon.close()
    }
  })
})

test('requestRef replays one durable turn across restart and rejects a conflicting request', async () => {
  await withHome(async (homeDir) => {
    let daemon = await startControlPlane(homeDir)
    try {
      const { client, binding, token } = await configuredClient(homeDir, daemon, 'chatgpt', 'request-ref')
      const bytes = new TextEncoder().encode('# system\n')
      const firstAttachment = await client.stage(binding.providerBindingRef, bytes)
      const firstRequest = requestFor(binding, firstAttachment, '7')
      const first = await client.start(binding.providerBindingRef, firstRequest)
      const firstMapping = daemon.store.getWebAiTurn(first.turnRef)
      assert.ok(firstMapping)
      assert.equal(firstMapping.request_ref, firstRequest.requestRef)
      assert.equal(firstMapping.request_sha256?.length, 64)
      assert.equal(webAiJobCount(homeDir), 1)

      const replayAttachment = await client.stage(binding.providerBindingRef, bytes)
      const replay = await client.start(binding.providerBindingRef, requestFor(binding, replayAttachment, '7'))
      assert.equal(replay.turnRef, first.turnRef)
      assert.equal(webAiJobCount(homeDir), 1)
      assert.equal(daemon.store.webAiCounts().turns, 1)
      assert.equal(daemon.store.webAiStageStatus(replayAttachment.attachmentRef)?.consumed, false)

      await daemon.close()
      daemon = await startControlPlane(homeDir)
      const restartedClient = createLocalHttpClient({ baseUrl: daemon.origin, token })
      const afterRestart = await restartedClient.start(
        binding.providerBindingRef,
        requestFor(binding, replayAttachment, '7'),
      )
      assert.equal(afterRestart.turnRef, first.turnRef)
      assert.equal(webAiJobCount(homeDir), 1)

      const shaOnlyAttachment = await restartedClient.stage(binding.providerBindingRef, new TextEncoder().encode('# syStem\n'))
      assert.equal(shaOnlyAttachment.byteLength, firstAttachment.byteLength)
      assert.notEqual(shaOnlyAttachment.sha256, firstAttachment.sha256)
      await assertRequestRefConflict(restartedClient, binding.providerBindingRef, requestFor(binding, shaOnlyAttachment, '7'))

      const byteLengthConflict = requestFor(binding, replayAttachment, '7')
      byteLengthConflict.bootstrap.attachments[0].byteLength += 1
      await assertRequestRefConflict(restartedClient, binding.providerBindingRef, byteLengthConflict)

      const { client: otherClient, binding: otherBinding } = await configuredClient(homeDir, daemon, 'chatgpt', 'request-ref-other-profile')
      const otherAttachment = await otherClient.stage(otherBinding.providerBindingRef, bytes)
      await assertRequestRefConflict(otherClient, otherBinding.providerBindingRef, requestFor(otherBinding, otherAttachment, '7'))

      const conflict = requestFor(binding, replayAttachment, '7')
      conflict.bootstrap.text = 'different text'
      await assertRequestRefConflict(restartedClient, binding.providerBindingRef, conflict)
      const response = await fetch(`${daemon.origin}/v1/web-ai/bindings/${encodeURIComponent(binding.providerBindingRef)}/turns`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(conflict),
      })
      assert.equal(response.status, 409)
      const body = await response.json()
      assert.deepEqual(body.error, {
        code: 'web_ai_request_ref_conflict',
        message: 'The request reference is already bound to a different request.',
        retryable: false,
      })
      assertSanitized(body, token)
      assert.equal(webAiJobCount(homeDir), 1)
      assert.equal(daemon.store.webAiCounts().turns, 1)
    } finally {
      await daemon.close()
    }
  })
})

test('requestRef cancellation durably fences starts and returns compact cancellation state', async () => {
  await withHome(async (homeDir) => {
    let daemon = await startControlPlane(homeDir)
    try {
      const { client, binding, token } = await configuredClient(homeDir, daemon, 'chatgpt', 'request-cancel')
      const requestRef = `request:${'c'.repeat(32)}`
      const endpoint = `${daemon.origin}/v1/web-ai/requests/${encodeURIComponent(requestRef)}/cancel`
      const unauthorized = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      assert.equal(unauthorized.status, 401)
      await assert.rejects(client.cancel(`binding:${'b'.repeat(32)}`), (error) => {
        assert.ok(error instanceof TypeError)
        assert.equal(error.message, 'turnRef is invalid.')
        return true
      })
      assert.equal(daemon.store.webAiCounts().turns, 0)

      assert.deepEqual(await client.cancelRequest(requestRef), { kind: 'cancelled_before_start' })
      assert.deepEqual(await client.cancelRequest(requestRef), { kind: 'cancelled_before_start' })
      const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
      try {
        assert.equal(Number(database.prepare(
          'SELECT COUNT(*) AS count FROM web_ai_v0_request_cancellations WHERE request_ref = ?',
        ).get(requestRef).count), 1)
      } finally {
        database.close()
      }
      assert.equal(webAiJobCount(homeDir), 0)
      assert.equal(daemon.store.webAiCounts().turns, 0)

      const blockedAttachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# system\n'))
      const blockedRequest = requestFor(binding, blockedAttachment, 'c')
      await assert.rejects(client.start(binding.providerBindingRef, blockedRequest), (error) => {
        assert.ok(error instanceof LocalHttpError)
        assert.equal(error.status, 409)
        assert.deepEqual(error.error, {
          code: 'web_ai_request_cancelled',
          message: 'The request reference was cancelled before a turn could be created.',
          retryable: false,
        })
        return true
      })
      assert.equal(webAiJobCount(homeDir), 0)
      assert.equal(daemon.store.webAiCounts().turns, 0)
      assert.equal(daemon.store.webAiStageStatus(blockedAttachment.attachmentRef)?.consumed, false)

      await daemon.close()
      daemon = await startControlPlane(homeDir)
      const restartedClient = createLocalHttpClient({ baseUrl: daemon.origin, token })
      assert.deepEqual(await restartedClient.cancelRequest(requestRef), { kind: 'cancelled_before_start' })
      const afterRestartAttachment = await restartedClient.stage(binding.providerBindingRef, new TextEncoder().encode('# second system\n'))
      await assertRequestCancelled(restartedClient, binding.providerBindingRef, requestFor(binding, afterRestartAttachment, 'c'))
      assert.equal(webAiJobCount(homeDir), 0)
      assert.equal(daemon.store.webAiCounts().turns, 0)

      const liveAttachment = await restartedClient.stage(binding.providerBindingRef, new TextEncoder().encode('# live system\n'))
      const live = await restartedClient.start(binding.providerBindingRef, requestFor(binding, liveAttachment, 'd'))
      const raw = await fetch(`${daemon.origin}/v1/web-ai/requests/${encodeURIComponent(`request:${'d'.repeat(32)}`)}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(raw.status, 200)
      const body = await raw.json()
      assert.deepEqual(Object.keys(body).sort(), ['kind', 'turn'])
      assert.equal(body.kind, 'turn')
      assert.deepEqual(Object.keys(body.turn).sort(), [
        'attachmentDeliveryStatus', 'conversationRef', 'dispatchCertainty', 'lifecycle', 'turnRef',
      ])
      assert.equal(body.turn.turnRef, live.turnRef)
      assert.equal(body.turn.lifecycle, 'cancelled')
      assert.equal(body.turn.dispatchCertainty, 'not_dispatched')
      assert.equal(body.turn.attachmentDeliveryStatus, 'pending')
      assert.equal(/provider|profile|job|result|citation|url|path|attachmentRef|sha256/i.test(JSON.stringify(body)), false)
      assertSanitized(body, token)

      const repeated = await restartedClient.cancelRequest(`request:${'d'.repeat(32)}`)
      assert.equal(repeated.kind, 'turn')
      assert.deepEqual(Object.keys(repeated.turn).sort(), [
        'attachmentDeliveryStatus', 'conversationRef', 'dispatchCertainty', 'lifecycle', 'turnRef',
      ])
      assert.equal(repeated.turn.turnRef, live.turnRef)
      assert.equal(repeated.turn.lifecycle, 'cancelled')
      const mapping = daemon.store.getWebAiTurn(live.turnRef)
      assert.ok(mapping)
      assert.equal(daemon.store.getJob(mapping.job_id).status, 'canceled')

      const uncertainAttachment = await restartedClient.stage(binding.providerBindingRef, new TextEncoder().encode('# uncertain system\n'))
      const uncertain = await restartedClient.start(binding.providerBindingRef, requestFor(binding, uncertainAttachment, 'e'))
      await checkpointStartedAction(daemon.store, uncertain.turnRef, 'prompt.submit')
      const uncertainCancelled = await restartedClient.cancelRequest(`request:${'e'.repeat(32)}`)
      assert.equal(uncertainCancelled.kind, 'turn')
      assert.equal(uncertainCancelled.turn.lifecycle, 'cancelled')
      assert.equal(uncertainCancelled.turn.dispatchCertainty, 'ambiguous')
      assert.equal(uncertainCancelled.turn.attachmentDeliveryStatus, 'delivered')
    } finally {
      await daemon.close()
    }
  })
})

test('canonical and OpenAPI TurnState schemas reject global certainty counterexamples', () => {
  const running = readCanonicalExample('turn-state-running.json')
  const waiting = readCanonicalExample('turn-state-waiting.json')
  const failed = readCanonicalExample('turn-state-failed.json')
  const cancelled = readCanonicalExample('turn-state-cancelled.json')
  const validate = openApiTurnValidator()
  for (const value of [running, waiting, failed, cancelled]) assert.equal(validate(value), true, JSON.stringify(validate.errors))
  const invalid = [
    { ...running, dispatchCertainty: 'dispatched', attachmentDelivery: { ...running.attachmentDelivery, status: 'pending' } },
    { ...failed, dispatchCertainty: 'ambiguous', attachmentDelivery: { ...failed.attachmentDelivery, status: 'rejected' } },
    { ...waiting, dispatchCertainty: 'not_dispatched', attachmentDelivery: { ...waiting.attachmentDelivery, status: 'pending' } },
    { ...cancelled, attachmentDelivery: { ...cancelled.attachmentDelivery, status: 'rejected' } },
  ]
  for (const value of invalid) {
    assert.throws(() => parseTurnState(value))
    assert.equal(validate(value), false)
  }
})

test('queued cancellation deletes its bundle and restart removes a retained cancelled marker', async () => {
  await withHome(async (homeDir) => {
    let daemon = await startControlPlane(homeDir)
    try {
      const { client, binding, token } = await configuredClient(homeDir, daemon, 'chatgpt', 'cancel')
      const attachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# system\n'))
      const turn = await client.start(binding.providerBindingRef, requestFor(binding, attachment, '6'))
      const staged = daemon.store.getWebAiStagedAttachment(attachment.attachmentRef)
      assert.ok(staged)
      const cancelled = await client.cancel(turn.turnRef)
      assert.equal(cancelled.lifecycle, 'cancelled')
      assert.equal(cancelled.dispatchCertainty, 'not_dispatched')
      assert.equal(cancelled.attachmentDelivery.status, 'pending')
      const bundle = path.join(homeDir, 'attachments', staged.bundle_id)
      assert.equal(fs.existsSync(bundle), false)
      fs.mkdirSync(bundle, { recursive: true })
      fs.writeFileSync(path.join(bundle, markerName), 'tokenless-web-ai-interaction-v0\n')
      await daemon.close()
      daemon = await startControlPlane(homeDir)
      assert.equal(fs.existsSync(bundle), false)
      const afterRestart = await createLocalHttpClient({ baseUrl: daemon.origin, token }).read(turn.turnRef)
      assert.equal(afterRestart.turnRef, turn.turnRef)
      assert.equal(afterRestart.lifecycle, 'cancelled')
    } finally {
      await daemon.close()
    }
  })
})

async function configuredClient(homeDir, daemon, provider, slug) {
  const { ManagedProfileRegistry } = await import(profileRegistry)
  const registry = new ManagedProfileRegistry(homeDir)
  const profile = await registry.addProfile({ slug, lifecycle: 'ready' })
  const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
  const client = createLocalHttpClient({ baseUrl: daemon.origin, token })
  const binding = await client.bind(provider, profile.id)
  return { client, binding, token }
}

async function startTurn(client, binding, digit, text) {
  const attachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode(`# ${text}\n`))
  return client.start(binding.providerBindingRef, requestFor(binding, attachment, digit))
}

async function checkpointStartedAction(store, turnRef, action) {
  const mapping = store.getWebAiTurn(turnRef)
  assert.ok(mapping)
  const job = store.getJob(mapping.job_id)
  const claim = store.claimJob(job.job_id, job.claim_token)
  store.markRunning(claim.job_id, claim.claim_token)
  store.checkpointJob(claim.job_id, claim.claim_token, { phase: { state: 'started', action, mutating: true } })
}

function requestFor(binding, attachment, digit) {
  return {
    ...startExample,
    requestRef: `request:${digit.repeat(32)}`,
    providerRef: binding.capabilities.providerRef,
    providerBindingRef: binding.providerBindingRef,
    bootstrap: {
      ...startExample.bootstrap,
      text: 'hello',
      attachments: [{
        ...startExample.bootstrap.attachments[0],
        attachmentRef: attachment.attachmentRef,
        mediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
        sha256: attachment.sha256,
      }],
    },
  }
}

function readCanonicalExample(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'packages/protocol/examples/v0', name), 'utf8'))
}

function openApiTurnValidator() {
  const document = JSON.parse(fs.readFileSync(path.join(root, 'api/tokenless-daemon-api.openapi.json'), 'utf8'))
  const defs = Object.fromEntries(Object.entries(document.components.schemas).map(([name, schema]) => [name, rewriteOpenApiRefs(schema)]))
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  ajv.addKeyword({
    keyword: 'x-tokenless-internal-maxUtf8Bytes', type: 'string', schemaType: 'number',
    validate(limit, value) { return Buffer.byteLength(value, 'utf8') <= limit },
  })
  addFormats(ajv)
  return ajv.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: defs, $ref: '#/$defs/WebAiTurnState' })
}

function rewriteOpenApiRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteOpenApiRefs)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')
      ? `#/$defs/${child.slice('#/components/schemas/'.length)}`
      : rewriteOpenApiRefs(child),
  ]))
}

function injectJobState(homeDir, jobId, status, error) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  try {
    database.prepare('UPDATE jobs SET status = ?, error_json = ?, updated_at = ?, claim_expires_at = NULL WHERE job_id = ?')
      .run(status, JSON.stringify(error), new Date().toISOString(), jobId)
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

function successfulVisibleResult(text) {
  return {
    responses: [
      { action: 'file.upload', ok: true, result: { acceptance: 'accepted' } },
      { action: 'prompt.submit', ok: true, result: { submitted: true } },
      { action: 'response.read', ok: true, result: { text, citations: [] } },
    ],
  }
}

function webAiJobCount(homeDir) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  try {
    return Number(database.prepare('SELECT COUNT(*) AS count FROM jobs').get().count)
  } finally {
    database.close()
  }
}

function persistLegacyWebAiTurnsSchema(homeDir) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  try {
    database.exec(`
      CREATE TABLE web_ai_v0_turns (
        turn_ref TEXT PRIMARY KEY NOT NULL CHECK (length(turn_ref) BETWEEN 1 AND 128),
        binding_ref TEXT NOT NULL REFERENCES web_ai_v0_bindings(binding_ref) ON DELETE RESTRICT,
        provider_ref TEXT NOT NULL CHECK (length(provider_ref) BETWEEN 1 AND 128),
        conversation_ref TEXT NOT NULL CHECK (length(conversation_ref) BETWEEN 1 AND 128),
        attachment_ref TEXT NOT NULL UNIQUE REFERENCES web_ai_v0_staged_attachments(attachment_ref) ON DELETE RESTRICT,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id) ON DELETE RESTRICT,
        cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
        cancel_dispatch_certainty TEXT NOT NULL DEFAULT 'not_dispatched' CHECK (cancel_dispatch_certainty IN ('not_dispatched', 'dispatched', 'ambiguous')),
        cancel_attachment_delivery TEXT NOT NULL DEFAULT 'pending' CHECK (cancel_attachment_delivery IN ('pending', 'delivered')),
        created_at TEXT NOT NULL
      );
    `)
  } finally {
    database.close()
  }
}

async function assertRequestRefConflict(client, bindingRef, request) {
  await assert.rejects(client.start(bindingRef, request), (error) => {
    assert.ok(error instanceof LocalHttpError)
    assert.equal(error.status, 409)
    assert.deepEqual(error.error, {
      code: 'web_ai_request_ref_conflict',
      message: 'The request reference is already bound to a different request.',
      retryable: false,
    })
    return true
  })
}

async function assertRequestCancelled(client, bindingRef, request) {
  await assert.rejects(client.start(bindingRef, request), (error) => {
    assert.ok(error instanceof LocalHttpError)
    assert.equal(error.status, 409)
    assert.deepEqual(error.error, {
      code: 'web_ai_request_cancelled',
      message: 'The request reference was cancelled before a turn could be created.',
      retryable: false,
    })
    return true
  })
}

async function assertLocalHttpError(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LocalHttpError)
    assert.equal(error.status, status)
    assert.deepEqual(error.error, { code, message: 'The local daemon rejected the request.', retryable: false })
    return true
  })
}

function assertSanitized(value, token, secret = '') {
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes(token), false)
  assert.equal(secret === '' || !serialized.includes(secret), true)
  assert.equal(/tokenless\.sqlite3|attachments\/(?:[^\"]+)|bundle_id|job_id/i.test(serialized), false)
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized), false)
}

function markerBundles(homeDir) {
  const attachments = path.join(homeDir, 'attachments')
  if (!fs.existsSync(attachments)) return []
  return fs.readdirSync(attachments).filter((entry) => fs.existsSync(path.join(attachments, entry, markerName))).sort()
}

async function withHome(run) {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-web-ai-http-')))
  try {
    await run(homeDir)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
}

async function startControlPlane(homeDir) {
  const { JobStore } = await import(daemonStore)
  const { serveHttp } = await import(daemonServer)
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  return daemon
}
