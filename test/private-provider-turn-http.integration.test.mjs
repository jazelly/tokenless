import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseStartTurnRequest } from '../packages/harness/dist/src/http/provider-turn/index.js'
import { LocalHttpError, createLocalHttpClient } from '../packages/harness/dist/src/http/provider-turn/http-client.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemonServer = pathToFileURL(path.join(root, 'packages/server/dist/src/http/server.js')).href
const daemonStore = pathToFileURL(path.join(root, 'packages/server/dist/src/jobs/store.js')).href
const profileRegistry = pathToFileURL(path.join(root, 'packages/server/dist/src/browser/profiles/registry.js')).href
const daemonConfig = pathToFileURL(path.join(root, 'packages/server/dist/src/persistence/config.js')).href
const startExample = JSON.parse(fs.readFileSync(path.join(root, 'packages/contracts/examples/v0/start-turn-request.json'), 'utf8'))
const maxStageBytes = 1024 * 1024

test('oversize stage is bounded and sanitized', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { client, binding, token } = await configuredClient(homeDir, daemon, 'chatgpt', 'oversize')
      const before = attachmentBundles(homeDir)
      const bytes = new Uint8Array(maxStageBytes + 1)
      await assertLocalHttpError(client.stage(binding.providerBindingRef, bytes), 400, 'invalid_input')
      assert.deepEqual(attachmentBundles(homeDir), before)
      assert.equal(daemon.store.webAiCounts().stagedAttachments, 0)
      const raw = await fetch(`${daemon.origin}/v1/private/provider-turn/bindings/${encodeURIComponent(binding.providerBindingRef)}/attachments`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown' }, body: bytes,
      })
      assert.equal(raw.status, 400)
      assertSanitized(await raw.json(), token)
      assert.deepEqual(attachmentBundles(homeDir), before)
      assert.equal(daemon.store.webAiCounts().stagedAttachments, 0)
    } finally {
      await daemon.close()
    }
  })
})

test('explicit ephemeral provider payload stays out of the stored job and attachment bytes', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { client, binding } = await configuredClient(homeDir, daemon, 'chatgpt', 'ephemeral-payload')
      const attachmentSecret = 'semantic-page-snapshot-secret'
      const promptSecret = 'extension-task-prompt-secret'
      const attachment = await client.stage(
        binding.providerBindingRef,
        new TextEncoder().encode(attachmentSecret),
        { name: 'ephemeral.md', payloadLifetime: 'ephemeral' },
      )
      const request = requestFor(binding, attachment, 'e')
      request.bootstrap.text = promptSecret
      const turn = await client.start(
        binding.providerBindingRef,
        request,
        { payloadLifetime: 'ephemeral' },
      )
      const mapping = daemon.store.getWebAiTurn(turn.turnRef)
      assert.ok(mapping)
      const job = daemon.store.getJob(mapping.job_id)
      const stored = JSON.stringify(job.request_json)
      assert.equal(stored.includes(promptSecret), false)
      assert.equal(stored.includes(attachmentSecret), false)
      assert.match(stored, /tokenless ephemeral provider payload/u)
      const staged = daemon.store.getWebAiStagedAttachment(attachment.attachmentRef)
      assert.ok(staged)
      assert.equal(fs.existsSync(path.join(homeDir, 'attachments', staged.bundle_id, `${staged.attachment_id}.bin`)), false)
      assert.equal((await client.read(turn.turnRef)).lifecycle, 'queued')
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
      const profile = await registry.addProfile({ slug: 'unsupported' })
      const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
      const client = createLocalHttpClient({ baseUrl: daemon.origin, token })
      const body = JSON.stringify({ provider: 'perplexity', profileId: profile.slug })
      const missing = await fetch(`${daemon.origin}/v1/private/provider-turn/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      assert.equal(missing.status, 401)
      const wrong = await fetch(`${daemon.origin}/v1/private/provider-turn/bindings`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body })
      assert.equal(wrong.status, 403)
      const legacy = await fetch(`${daemon.origin}/v1/web-ai/bindings`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body })
      assert.equal(legacy.status, 404)
      const binding = await client.bind('perplexity', profile.slug)
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

test('continuation reuses the proved provider conversation in the same process', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { client, binding } = await configuredClient(homeDir, daemon, 'chatgpt', 'continuation')
      const first = await startTurn(client, binding, 'a', 'bootstrap')
      const firstMapping = daemon.store.getWebAiTurn(first.turnRef)
      const firstJob = daemon.store.getJob(firstMapping.job_id)
      const firstJobState = daemon.store.takeNextJob({ job_id_prefix: firstJob.job_id }, firstJob.profile_id)
      assert.ok(firstJobState)
      daemon.store.recordProviderSubmission(firstJobState.job_id)
      daemon.store.upsertProviderTaskConversation({
        provider: 'chatgpt',
        profile_id: firstJob.profile_id,
        task_id: firstJob.request_json.taskId,
        canonical_url: 'https://chatgpt.com/c/tokenless-continuation',
        job_id: firstJob.job_id,
      })
      daemon.store.completeJob(firstJobState.job_id, { result_json: successfulVisibleResult('first') })
      assert.equal((await client.read(first.turnRef)).lifecycle, 'succeeded')

      const resultAttachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('{"result":"exact"}'), { name: 'tool-result.md' })
      const continuationRequest = {
        protocol: startExample.protocol,
        requestRef: `request:${'b'.repeat(32)}`,
        providerRef: binding.capabilities.providerRef,
        providerBindingRef: binding.providerBindingRef,
        requiredCapabilities: ['conversation.chat', 'file.upload', 'document.input'],
        conversation: { mode: 'continue', conversationRef: first.conversationRef },
        continuation: {
          text: 'continue from the attached action result',
          attachments: [{ kind: 'tool_result', name: 'tool-result.md', ...resultAttachment }],
        },
      }
      const continued = await client.continue(binding.providerBindingRef, continuationRequest)
      await assert.rejects(client.continue(binding.providerBindingRef, continuationRequest), (error) => {
        assert.ok(error instanceof LocalHttpError)
        assert.equal(error.status, 409)
        assert.deepEqual(error.error, {
          code: 'web_ai_request_ref_conflict',
          message: 'The request reference already has a turn; duplicate starts are not replayed.',
          retryable: false,
        })
        return true
      })
      assert.equal(continued.conversationRef, first.conversationRef)
      const continuedMapping = daemon.store.getWebAiTurn(continued.turnRef)
      const continuedJob = daemon.store.getJob(continuedMapping.job_id)
      assert.equal(continuedJob.request_json.taskId, firstJob.request_json.taskId)
      assert.equal(continuedJob.request_json.target.url, 'https://chatgpt.com/c/tokenless-continuation')
      assert.equal(continuedJob.request_json.fallback, null)

      assert.equal((await client.read(continued.turnRef)).lifecycle, 'queued')
    } finally {
      await daemon.close()
    }
  })
})

test('auto bootstrap preference reorders eligible providers while continuation keeps the settled provider', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { ManagedProfileRegistry } = await import(profileRegistry)
      const { writeTokenlessConfig } = await import(daemonConfig)
      const registry = new ManagedProfileRegistry(homeDir)
      const profile = await registry.addProfile({ slug: 'semantic-auto', setDefault: true })
      for (const provider of ['chatgpt', 'gemini', 'grok']) {
        await registry.updateProviderStatus(profile.slug, {
          provider,
          auth: 'authenticated',
          access: 'signed_in_free',
          checkedAt: new Date().toISOString(),
        })
      }
      await registry.updateProviderStatus(profile.slug, {
        provider: 'deepseek',
        auth: 'authenticated',
        access: 'account_blocked',
        checkedAt: new Date().toISOString(),
      })
      await registry.updateProviderStatus(profile.slug, {
        provider: 'perplexity',
        auth: 'authenticated',
        access: 'signed_in_free',
        checkedAt: new Date().toISOString(),
      })
      await writeTokenlessConfig({
        homeDir,
        profiles: {
          [profile.slug]: {
            roleLabel: '',
            enabledProviders: ['grok', 'gemini', 'chatgpt', 'deepseek', 'perplexity', 'blackbox'],
            browserVisibility: 'headed',
            proxy: null,
          },
        },
      })
      const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
      const client = createLocalHttpClient({ baseUrl: daemon.origin, token })
      const binding = await client.bind('auto', profile.slug)
      const attachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# system\n'))
      const preferredRequest = {
        ...requestFor(binding, attachment, 'f'),
        semanticPreference: 'chatgpt',
      }
      const first = await client.start(binding.providerBindingRef, preferredRequest)
      const firstMapping = daemon.store.getWebAiTurn(first.turnRef)
      assert.ok(firstMapping)
      const firstJob = daemon.store.getJob(firstMapping.job_id)
      assert.equal(firstJob.provider, 'chatgpt')
      assert.equal(firstJob.request_json.semanticPreference, 'chatgpt')
      assert.equal(firstJob.request_json.fallback.alternatives[0].provider, 'gemini')
      const expectedExclusions = [
        { provider: 'grok', category: 'capability', reason: 'capability_route_unavailable' },
        { provider: 'deepseek', category: 'access', reason: 'provider_access_account_blocked' },
        { provider: 'perplexity', category: 'capability', reason: 'capability_route_unavailable' },
        { provider: 'blackbox', category: 'runtime', reason: 'provider_mode_disabled' },
      ]
      assert.deepEqual(firstJob.request_json.routingObservation, {
        protocol: 'tokenless.provider-routing-observation.v1',
        exclusions: expectedExclusions,
        attempts: [],
      })
      const routed = await fetch(`${daemon.origin}/v1/private/provider-turn/turns/${encodeURIComponent(first.turnRef)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(routed.status, 200)
      assert.equal(routed.headers.get('x-tokenless-route-mode'), 'auto')
      assert.equal(routed.headers.get('x-tokenless-route-provider'), 'chatgpt')
      assert.deepEqual(JSON.parse(routed.headers.get('x-tokenless-route-exclusions')), expectedExclusions)

      const running = daemon.store.takeNextJob({ job_id_prefix: firstJob.job_id }, firstJob.profile_id)
      assert.ok(running)
      daemon.store.recordProviderSubmission(running.job_id)
      daemon.store.upsertProviderTaskConversation({
        provider: 'chatgpt',
        profile_id: firstJob.profile_id,
        task_id: firstJob.request_json.taskId,
        canonical_url: 'https://chatgpt.com/c/tokenless-semantic-continuation',
        job_id: firstJob.job_id,
      })
      daemon.store.completeJob(firstJob.job_id, { result_json: successfulVisibleResult('first') })

      const resultAttachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('{"result":"exact"}'), { name: 'tool-result.md' })
      const continuationRequest = {
        protocol: startExample.protocol,
        requestRef: `request:${'1'.repeat(32)}`,
        providerRef: binding.capabilities.providerRef,
        providerBindingRef: binding.providerBindingRef,
        requiredCapabilities: ['conversation.chat', 'file.upload', 'document.input'],
        conversation: { mode: 'continue', conversationRef: first.conversationRef },
        continuation: {
          text: 'continue from the attached action result',
          attachments: [{ kind: 'tool_result', name: 'tool-result.md', ...resultAttachment }],
        },
      }
      await assert.rejects(client.continue(binding.providerBindingRef, { ...continuationRequest, semanticPreference: 'chatgpt' }))
      const continued = await client.continue(binding.providerBindingRef, continuationRequest)
      const continuedMapping = daemon.store.getWebAiTurn(continued.turnRef)
      assert.ok(continuedMapping)
      const continuedJob = daemon.store.getJob(continuedMapping.job_id)
      assert.equal(continuedJob.provider, 'chatgpt')
      assert.equal(continuedJob.request_json.fallback.alternatives[0].provider, 'gemini')
      assert.equal(Object.hasOwn(continuedJob.request_json, 'semanticPreference'), false)

      await registry.updateProviderStatus(profile.slug, {
        provider: 'gemini',
        auth: 'authenticated',
        access: 'signed_in_free',
        checkedAt: '2000-01-01T00:00:00.000Z',
      })
      const staleAttachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# stale preference\n'))
      const stalePreference = await client.start(binding.providerBindingRef, {
        ...requestFor(binding, staleAttachment, '4'),
        semanticPreference: 'gemini',
      })
      const staleMapping = daemon.store.getWebAiTurn(stalePreference.turnRef)
      assert.ok(staleMapping)
      const staleJob = daemon.store.getJob(staleMapping.job_id)
      assert.equal(staleJob.provider, 'chatgpt')
      assert.equal(staleJob.request_json.semanticPreference, 'gemini')

      const ignoredAttachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# ignored preference\n'))
      const ignored = await client.start(binding.providerBindingRef, {
        ...requestFor(binding, ignoredAttachment, '2'),
        semanticPreference: 'deepseek',
      })
      const ignoredMapping = daemon.store.getWebAiTurn(ignored.turnRef)
      assert.ok(ignoredMapping)
      const ignoredJob = daemon.store.getJob(ignoredMapping.job_id)
      assert.equal(ignoredJob.provider, 'chatgpt')
      assert.equal(ignoredJob.request_json.semanticPreference, 'deepseek')

      const explicitBinding = await client.bind('chatgpt', profile.slug)
      const explicitAttachment = await client.stage(explicitBinding.providerBindingRef, new TextEncoder().encode('# explicit\n'))
      await assertLocalHttpError(client.start(explicitBinding.providerBindingRef, {
        ...requestFor(explicitBinding, explicitAttachment, '3'),
        semanticPreference: 'grok',
      }), 400, 'invalid_input')
    } finally {
      await daemon.close()
    }
  })
})

test('auto bootstrap no-route error exposes bounded provider exclusions', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { ManagedProfileRegistry } = await import(profileRegistry)
      const { writeTokenlessConfig } = await import(daemonConfig)
      const registry = new ManagedProfileRegistry(homeDir)
      const profile = await registry.addProfile({ slug: 'auto-no-route', setDefault: true })
      await registry.updateProviderStatus(profile.slug, {
        provider: 'deepseek',
        auth: 'authenticated',
        access: 'account_blocked',
        checkedAt: new Date().toISOString(),
      })
      await registry.updateProviderStatus(profile.slug, {
        provider: 'perplexity',
        auth: 'authenticated',
        access: 'signed_in_free',
        checkedAt: new Date().toISOString(),
      })
      await writeTokenlessConfig({
        homeDir,
        profiles: {
          [profile.slug]: {
            roleLabel: '',
            enabledProviders: ['deepseek', 'perplexity', 'blackbox'],
            browserVisibility: 'headed',
            proxy: null,
          },
        },
      })
      const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
      const client = createLocalHttpClient({ baseUrl: daemon.origin, token })
      const binding = await client.bind('auto', profile.slug)
      const attachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# system\n'))
      const response = await fetch(`${daemon.origin}/v1/private/provider-turn/bindings/${encodeURIComponent(binding.providerBindingRef)}/turns`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(requestFor(binding, attachment, '7')),
      })
      assert.equal(response.status, 400)
      assert.equal(response.headers.get('x-tokenless-route-outcome'), 'failed')
      assert.equal(response.headers.get('x-tokenless-route-mode'), 'auto')
      assert.equal(response.headers.get('x-tokenless-route-provider'), 'auto')
      assert.equal(response.headers.get('x-tokenless-route-provider-submitted'), '0')
      assert.deepEqual(JSON.parse(response.headers.get('x-tokenless-route-exclusions')), [
        { provider: 'deepseek', category: 'access', reason: 'provider_access_account_blocked' },
        { provider: 'perplexity', category: 'capability', reason: 'capability_route_unavailable' },
        { provider: 'blackbox', category: 'runtime', reason: 'provider_mode_disabled' },
      ])
      assert.deepEqual(await response.json(), {
        error: {
          code: 'invalid_input',
          message: 'The local Web AI request was rejected.',
          retryable: false,
        },
      })
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
      const bind = await fetch(`${daemon.origin}/v1/private/provider-turn/bindings`, {
        method: 'POST', headers, body: JSON.stringify({ provider: 'chatgpt', profileId: 'sanitizer' }),
      })
      assert.equal(bind.status, 500)
      const bindBody = await bind.json()
      assert.deepEqual(bindBody.error, { code: 'local_http_error', message: 'The local Web AI service encountered an error.', retryable: true })
      assertSanitized(bindBody, token, poison)
      const capabilities = await fetch(`${daemon.origin}/v1/private/provider-turn/bindings/${encodeURIComponent(binding.providerBindingRef)}/capabilities`, { headers })
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
        { ...valid, requiredCapabilities: ['file.upload', 'conversation.chat', 'document.input'] },
        { ...valid, bootstrap: { ...valid.bootstrap, text: 'x'.repeat(4001) } },
        { ...valid, bootstrap: { ...valid.bootstrap, attachments: [{ ...valid.bootstrap.attachments[0], attachmentRef: 'attachment:not-a-ref' }] } },
        { ...valid, bootstrap: { ...valid.bootstrap, attachments: [{ ...valid.bootstrap.attachments[0], byteLength: 0 }] } },
      ]
      for (const invalid of corpus) {
        assert.throws(() => parseStartTurnRequest(invalid))
        await assert.rejects(client.start(binding.providerBindingRef, invalid))
        const response = await fetch(`${daemon.origin}/v1/private/provider-turn/bindings/${encodeURIComponent(binding.providerBindingRef)}/turns`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(invalid),
        })
        assert.equal(response.status, 400)
        assertSanitized(await response.json(), token)
        assert.deepEqual(daemon.store.webAiCounts(), before)
        assert.equal(daemon.store.webAiStageStatus(attachment.attachmentRef)?.consumed, false)
      }
      const turn = await client.start(binding.providerBindingRef, valid)
      assert.equal(turn.lifecycle, 'queued')
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

test('requestRef cancellation returns not-found before start and compact cancellation state for an existing turn', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    try {
      const { client, binding, token } = await configuredClient(homeDir, daemon, 'chatgpt', 'request-cancel')
      const requestRef = `request:${'c'.repeat(32)}`
      const endpoint = `${daemon.origin}/v1/private/provider-turn/requests/${encodeURIComponent(requestRef)}/cancel`
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

      await assert.rejects(client.cancelRequest(requestRef), (error) => {
        assert.ok(error instanceof LocalHttpError)
        assert.equal(error.status, 404)
        assert.deepEqual(error.error, {
          code: 'web_ai_request_not_found',
          message: 'The Web AI request was not found.',
          retryable: false,
        })
        return true
      })
      assert.equal(webAiJobCount(homeDir), 0)
      assert.equal(daemon.store.webAiCounts().turns, 0)

      const liveAttachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# system\n'))
      const liveRequest = requestFor(binding, liveAttachment, 'c')
      const created = await client.start(binding.providerBindingRef, liveRequest)
      assert.equal(created.lifecycle, 'queued')
      await assert.rejects(client.start(binding.providerBindingRef, liveRequest), (error) => {
        assert.ok(error instanceof LocalHttpError)
        assert.equal(error.status, 409)
        assert.deepEqual(error.error, {
          code: 'web_ai_request_ref_conflict',
          message: 'The request reference already has a turn; duplicate starts are not replayed.',
          retryable: false,
        })
        return true
      })
      assert.equal(webAiJobCount(homeDir), 1)
      assert.equal(daemon.store.webAiCounts().turns, 1)

      const cancelAttachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode('# live system\n'))
      const live = await client.start(binding.providerBindingRef, requestFor(binding, cancelAttachment, 'd'))
      const raw = await fetch(`${daemon.origin}/v1/private/provider-turn/requests/${encodeURIComponent(`request:${'d'.repeat(32)}`)}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(raw.status, 200)
      const body = await raw.json()
      assert.deepEqual(Object.keys(body).sort(), ['kind', 'turn'])
      assert.equal(body.kind, 'turn')
      assert.deepEqual(Object.keys(body.turn).sort(), [
        'conversationRef', 'lifecycle', 'turnRef',
      ])
      assert.equal(body.turn.turnRef, live.turnRef)
      assert.equal(body.turn.lifecycle, 'cancelled')
      assert.equal(/provider|profile|job|result|citation|url|path|attachmentRef|sha256/i.test(JSON.stringify(body)), false)
      assertSanitized(body, token)

      const repeated = await client.cancelRequest(`request:${'d'.repeat(32)}`)
      assert.equal(repeated.kind, 'turn')
      assert.deepEqual(Object.keys(repeated.turn).sort(), [
        'conversationRef', 'lifecycle', 'turnRef',
      ])
      assert.equal(repeated.turn.turnRef, live.turnRef)
      assert.equal(repeated.turn.lifecycle, 'cancelled')
      const mapping = daemon.store.getWebAiTurn(live.turnRef)
      assert.ok(mapping)
      assert.equal(daemon.store.getJob(mapping.job_id).status, 'canceled')

    } finally {
      await daemon.close()
    }
  })
})

test('queued cancellation deletes its bundle and restart forgets its transient turn', async () => {
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
      assert.equal(cancelled.attachmentDelivery.status, 'pending')
      const bundle = path.join(homeDir, 'attachments', staged.bundle_id)
      assert.equal(fs.existsSync(bundle), false)
      await daemon.close()
      daemon = await startControlPlane(homeDir)
      assert.equal(fs.existsSync(bundle), false)
      await assertLocalHttpError(createLocalHttpClient({ baseUrl: daemon.origin, token }).read(turn.turnRef), 400, 'invalid_input')
    } finally {
      await daemon.close()
    }
  })
})

async function configuredClient(homeDir, daemon, provider, slug) {
  const { ManagedProfileRegistry } = await import(profileRegistry)
  const registry = new ManagedProfileRegistry(homeDir)
  const profile = await registry.addProfile({ slug })
  const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
  const client = createLocalHttpClient({ baseUrl: daemon.origin, token })
  const binding = await client.bind(provider, profile.slug)
  return { client, binding, token }
}

async function startTurn(client, binding, digit, text) {
  const attachment = await client.stage(binding.providerBindingRef, new TextEncoder().encode(`# ${text}\n`))
  return client.start(binding.providerBindingRef, requestFor(binding, attachment, digit))
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

function attachmentBundles(homeDir) {
  const attachments = path.join(homeDir, 'attachments')
  if (!fs.existsSync(attachments)) return []
  return fs.readdirSync(attachments).sort()
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
