import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parseStartTurnRequest, parseTurnState } from 'tokenless-web-ai-interaction-protocol'
import { LocalHttpError, createLocalHttpClient } from 'tokenless-web-ai-interaction-protocol/local-http'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemonServer = path.join(root, 'packages/cli/dist/src/daemon/server.js')
const daemonStore = path.join(root, 'packages/cli/dist/src/daemon/job-store.js')
const profileRegistry = path.join(root, 'packages/cli/dist/src/playwright/profiles/registry.js')
const startExample = JSON.parse(fs.readFileSync(path.join(root, 'packages/web-ai-interaction-protocol/examples/v0/start-turn-request.json'), 'utf8'))
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
      const body = JSON.stringify({ provider: 'gemini', profileId: profile.id })
      const missing = await fetch(`${daemon.origin}/v1/web-ai/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      assert.equal(missing.status, 401)
      const wrong = await fetch(`${daemon.origin}/v1/web-ai/bindings`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body })
      assert.equal(wrong.status, 403)
      const binding = await client.bind('gemini', profile.id)
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
  return JSON.parse(fs.readFileSync(path.join(root, 'packages/web-ai-interaction-protocol/examples/v0', name), 'utf8'))
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
