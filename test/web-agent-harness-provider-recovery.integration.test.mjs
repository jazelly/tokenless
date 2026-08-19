import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  createLocalHttpProviderTurnClient,
  createStdioMcpToolRegistry,
  openWebAgentHarness,
} from '../packages/harness/dist/src/index.js'
import { HarnessRunStore } from '../packages/harness/dist/src/internal/run-store.js'
import { serveHttp } from '../packages/server/dist/src/http/server.js'
import { JobStore } from '../packages/server/dist/src/jobs/store.js'
import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'

const everythingServer = {
  name: 'everything',
  command: process.execPath,
  args: [path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js')],
  enabledTools: ['echo'],
  timeoutMs: 30_000,
}

test('real local HTTP response loss reconciles accepted operations by immutable turn identity', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-provider-recovery-')))
  const home = path.join(root, 'home')
  const store = await JobStore.open(home)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  const proxy = await startResponseLossProxy(daemon.origin)
  let harness
  try {
    const profile = await new ManagedProfileRegistry(home).addProfile({ slug: 'provider-recovery', lifecycle: 'ready' })
    const token = (await fs.readFile(path.join(home, 'daemon.token'), 'utf8')).trim()
    const open = () => openWebAgentHarness({
      tokenlessHome: home,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: proxy.origin, token }),
      toolRegistry: createStdioMcpToolRegistry(),
    })
    harness = await open()
    let admitted
    let turnRef
    let mapping
    await t.test('accepted start response loss replays the same requestRef without creating a second turn', async () => {
      admitted = await harness.start(spec(profile.id, root, 'a'))
      assert.equal((await harness.read(admitted.runId)).status, 'submitting_provider')
      assert.equal((await harness.read(admitted.runId)).status, 'submitting_provider')
      assert.equal(store.webAiCounts().turns, 1)
      harness.close()
      harness = await open()
      const running = await harness.read(admitted.runId)
      assert.equal(running.status, 'running')
      turnRef = running.providerTurnRef
      mapping = store.getWebAiTurn(turnRef)
      assert.ok(mapping)
      assert.equal(store.webAiCounts().turns, 1)
    })

    await t.test('one lost provider GET response leaves the run recoverable on the next read', async () => {
      proxy.dropNextRead()
      const lostRead = await harness.read(admitted.runId)
      assert.equal(lostRead.status, 'running')
      assert.equal(lostRead.error, undefined)
      const recoveredRead = await harness.read(admitted.runId)
      assert.equal(recoveredRead.status, 'running')
      assert.equal(recoveredRead.providerTurnRef, turnRef)
      assert.equal(proxy.dropped().read, 1)
    })

    await t.test('resume and cancel response loss reconcile the already changed same job lifecycle', async () => {
      injectWaitingJob(home, mapping.job_id)
      assert.equal((await harness.read(admitted.runId)).waiting.kind, 'provider')
      const lostResume = await harness.resume(admitted.runId, { providerReady: true })
      assert.equal(lostResume.providerTurnRef, turnRef)
      assert.equal(store.getJob(mapping.job_id).status, 'queued')
      harness.close()
      harness = await open()
      const reconciledResume = await harness.read(admitted.runId)
      assert.equal(reconciledResume.providerTurnRef, turnRef)
      assert.equal(store.getWebAiTurn(turnRef).job_id, mapping.job_id)

      const lostCancel = await harness.cancel(admitted.runId)
      assert.notEqual(lostCancel.status, 'cancelled')
      assert.equal(store.getJob(mapping.job_id).status, 'canceled')
      harness.close()
      harness = await open()
      const reconciledCancel = await harness.read(admitted.runId)
      assert.equal(reconciledCancel.status, 'cancelled')
      assert.equal(reconciledCancel.providerTurnRef, turnRef)
      assert.equal(store.webAiCounts().turns, 1)
      assert.deepEqual(proxy.dropped(), { start: 1, read: 1, resume: 1, cancel: 1 })
    })

    await t.test('ambiguous submission requires reconciliation and never resumes by generic providerReady', async () => {
      const ambiguous = await harness.start(spec(profile.id, root, 'c'))
      await harness.read(ambiguous.runId)
      const running = await harness.read(ambiguous.runId)
      const ambiguousTurnRef = running.providerTurnRef
      const ambiguousMapping = store.getWebAiTurn(ambiguousTurnRef)
      assert.ok(ambiguousMapping)
      injectAmbiguousWaitingJob(home, ambiguousMapping.job_id)
      const waiting = await harness.read(ambiguous.runId)
      assert.equal(waiting.status, 'running')
      assert.equal(waiting.waiting.kind, 'provider')
      const reconciled = await harness.resume(ambiguous.runId, { providerReady: true })
      assert.equal(reconciled.status, 'reconciliation_required')
      assert.equal(reconciled.providerTurnRef, ambiguousTurnRef)
      assert.equal(store.getJob(ambiguousMapping.job_id).status, 'waiting_for_user')
      const repeated = await harness.resume(ambiguous.runId, { providerReady: true })
      assert.equal(repeated.status, 'reconciliation_required')
      assert.equal(store.getJob(ambiguousMapping.job_id).status, 'waiting_for_user')
    })

    await t.test('a hostile raw JobStore request identity fails closed in core', async () => {
      const hostile = await harness.start(spec(profile.id, root, 'b'))
      await harness.read(hostile.runId)
      const hostileRunning = await harness.read(hostile.runId)
      corruptRawRequestRef(home, hostileRunning.providerTurnRef)
      const failedClosed = await harness.read(hostile.runId)
      assert.equal(failedClosed.status, 'failed')
      assert.equal(failedClosed.error.code, 'harness_provider_identity_mismatch')
    })
  } finally {
    harness?.close()
    await proxy.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('explicit transient local-provider request failure retries twice then fails without creating a turn', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-provider-retry-')))
  const home = path.join(root, 'home')
  const store = await JobStore.open(home)
  // The real daemon reports daemon_starting as an explicit retryable error
  // until activate() is called; no provider boundary is simulated here.
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  let harness
  try {
    const profile = await new ManagedProfileRegistry(home).addProfile({ slug: 'provider-retry', lifecycle: 'ready' })
    const token = (await fs.readFile(path.join(home, 'daemon.token'), 'utf8')).trim()
    harness = await openWebAgentHarness({
      tokenlessHome: home,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: daemon.origin, token }),
      toolRegistry: createStdioMcpToolRegistry(),
    })
    const admitted = await harness.start({
      admissionRef: `admission:${'c'.repeat(32)}`,
      provider: 'chatgpt', profileId: profile.id,
      taskPrompt: 'Bound transient retry test.', stagingRoot: path.join(root, 'staging'),
    })
    assert.equal((await harness.read(admitted.runId)).status, 'submitting_provider')
    const failed = await harness.read(admitted.runId)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error.code, 'daemon_starting')
    const runStore = await HarnessRunStore.open(home)
    const record = runStore.read(admitted.runId)
    assert.equal(record.providerRetryCount, 2)
    assert.equal(record.pendingProviderRequest, undefined)
    runStore.close()
    assert.equal(store.webAiCounts().turns, 0)
  } finally {
    harness?.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('retryable local HTTP read stays recoverable instead of becoming terminal', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-provider-read-recovery-')))
  const home = path.join(root, 'home')
  const store = await JobStore.open(home)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  let harness
  try {
    const profile = await new ManagedProfileRegistry(home).addProfile({ slug: 'read-recovery', lifecycle: 'ready' })
    const runId = `run_${'d'.repeat(32)}`
    const nonce = `nonce:${'f'.repeat(32)}`
    const requestRef = `request:${'1'.repeat(32)}`
    const now = new Date().toISOString()
    const runStore = await HarnessRunStore.open(home)
    runStore.create({
      protocol: 'tokenless.web-agent.run/v1', runId, revision: 0, status: 'running', phase: 'awaiting_provider',
      spec: {
        admissionRef: `admission:${'e'.repeat(32)}`, provider: 'chatgpt', profileId: profile.id,
        taskPrompt: 'Reconcile a transient provider read.', stagingRoot: path.join(root, 'staging'),
      },
      turn: 1, nonce, requestRef, catalog: [],
      providerTurn: {
        protocol: 'tokenless.provider-turn/v1', requestRef, runId, turn: 1, nonce,
        provider: 'chatgpt', profileId: profile.id,
        turnRef: `turn:${'2'.repeat(32)}`, providerRef: 'chatgpt', providerBindingRef: `binding:${'3'.repeat(32)}`,
        conversationRef: `conversation:${'4'.repeat(32)}`, lifecycle: 'running',
      },
      calls: [], needs: [], callResults: [], needResults: [], history: [], createdAt: now, updatedAt: now,
    })
    runStore.close()
    const token = (await fs.readFile(path.join(home, 'daemon.token'), 'utf8')).trim()
    harness = await openWebAgentHarness({
      tokenlessHome: home,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: daemon.origin, token }),
      toolRegistry: createStdioMcpToolRegistry(),
    })
    const beforeStore = await HarnessRunStore.open(home)
    const before = beforeStore.read(runId)
    beforeStore.close()
    const view = await harness.read(runId)
    assert.equal(view.status, 'running')
    assert.equal(view.error, undefined)
    const afterStore = await HarnessRunStore.open(home)
    const after = afterStore.read(runId)
    afterStore.close()
    assert.equal(after.status, 'running')
    assert.equal(after.revision, before.revision)
  } finally {
    harness?.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The first test covers accepted response-loss replay through ambiguous reconciliation; this case covers retryable pre-dispatch only.
test('delayed daemon activation retries one real provider start with one request identity', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-provider-retry-success-')))
  const home = path.join(root, 'home')
  const store = await JobStore.open(home)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  const proxy = await startResponseLossProxy(daemon.origin, { dropResponses: false })
  let harness
  let activationTimer
  try {
    const profile = await new ManagedProfileRegistry(home).addProfile({ slug: 'retry-success', lifecycle: 'ready' })
    const token = (await fs.readFile(path.join(home, 'daemon.token'), 'utf8')).trim()
    harness = await openWebAgentHarness({
      tokenlessHome: home,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: proxy.origin, token }),
      toolRegistry: createStdioMcpToolRegistry(),
    })
    const admitted = await harness.start({
      admissionRef: `admission:${'f'.repeat(32)}`, provider: 'chatgpt', profileId: profile.id,
      taskPrompt: 'Bounded transient retry success.', stagingRoot: path.join(root, 'staging'),
    })
    assert.equal((await harness.read(admitted.runId)).status, 'submitting_provider')
    const pendingStore = await HarnessRunStore.open(home)
    const pending = pendingStore.read(admitted.runId).pendingProviderRequest
    pendingStore.close()
    assert.ok(pending)
    const startedAt = performance.now()
    activationTimer = setTimeout(() => daemon.activate(), 250)
    const running = await harness.read(admitted.runId)
    clearTimeout(activationTimer)
    activationTimer = undefined
    const elapsed = performance.now() - startedAt
    assert.equal(running.status, 'running', JSON.stringify(running))
    assert.ok(elapsed >= 250, `expected bounded backoff delay, got ${elapsed}ms`)
    assert.equal(proxy.requests().bind, 4)
    assert.equal(proxy.requests().start, 1)
    assert.equal(store.webAiCounts().turns, 1)
    const finalStore = await HarnessRunStore.open(home)
    const record = finalStore.read(admitted.runId)
    finalStore.close()
    assert.equal(record.providerTurn.requestRef, pending.requestRef)
    assert.equal(record.providerTurn.provider, pending.provider)
    assert.equal(record.providerTurn.profileId, pending.profileId)
  } finally {
    if (activationTimer) clearTimeout(activationTimer)
    harness?.close()
    await proxy.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('unknown provider 5xx stays ambiguous and preserves the same submission intent', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-provider-unknown-5xx-')))
  const home = path.join(root, 'home')
  const store = await JobStore.open(home)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  const proxy = await startResponseLossProxy(daemon.origin, { dropResponses: false })
  let harness
  try {
    const profile = await new ManagedProfileRegistry(home).addProfile({ slug: 'unknown-5xx', lifecycle: 'ready' })
    const token = (await fs.readFile(path.join(home, 'daemon.token'), 'utf8')).trim()
    harness = await openWebAgentHarness({
      tokenlessHome: home,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl: proxy.origin, token }),
      toolRegistry: createStdioMcpToolRegistry(),
    })
    const admitted = await harness.start({
      admissionRef: `admission:${'0'.repeat(32)}`, provider: 'chatgpt', profileId: profile.id,
      taskPrompt: 'Preserve unknown provider failure intent.', stagingRoot: path.join(root, 'staging'),
    })
    assert.equal((await harness.read(admitted.runId)).status, 'submitting_provider')
    const beforeStore = await HarnessRunStore.open(home)
    const before = beforeStore.read(admitted.runId)
    beforeStore.close()
    proxy.failNextStart()
    const ambiguous = await harness.read(admitted.runId)
    assert.equal(ambiguous.status, 'submitting_provider', JSON.stringify(ambiguous))
    const afterFailureStore = await HarnessRunStore.open(home)
    const afterFailure = afterFailureStore.read(admitted.runId)
    afterFailureStore.close()
    assert.equal(afterFailure.pendingProviderRequest.requestRef, before.pendingProviderRequest.requestRef)
    assert.equal(afterFailure.providerRetryCount, 0)
    assert.equal(store.webAiCounts().turns, 0)
    const running = await harness.read(admitted.runId)
    assert.equal(running.status, 'running', JSON.stringify(running))
    assert.equal(store.webAiCounts().turns, 1)
  } finally {
    harness?.close()
    await proxy.close()
    await daemon.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

function spec(profileId, root, suffix) {
  return {
    admissionRef: `admission:${suffix.repeat(32)}`,
    provider: 'chatgpt', profileId,
    taskPrompt: `Exercise durable provider recovery ${suffix}.`,
    stagingRoot: path.join(root, 'staging'),
    mcpServers: [everythingServer],
  }
}

function injectWaitingJob(home, jobId) {
  const database = new DatabaseSync(path.join(home, 'tokenless.sqlite3'))
  try {
    database.prepare(`UPDATE jobs SET status = 'waiting_for_user', checkpoint_json = ?, blocker_json = ?, claim_expires_at = NULL WHERE job_id = ?`)
      .run(JSON.stringify({ phase: { state: 'waiting', action: 'blocker.check', mutating: false } }), JSON.stringify({ code: 'provider_intervention' }), jobId)
  } finally {
    database.close()
  }
}

function injectAmbiguousWaitingJob(home, jobId) {
  const database = new DatabaseSync(path.join(home, 'tokenless.sqlite3'))
  try {
    database.prepare(`UPDATE jobs SET status = 'waiting_for_user', checkpoint_json = ?, blocker_json = ?, provider_submitted_at = NULL, claim_expires_at = NULL WHERE job_id = ?`)
      .run(JSON.stringify({ phase: { state: 'started', action: 'prompt.submit', mutating: true } }), JSON.stringify({ code: 'provider_intervention' }), jobId)
  } finally {
    database.close()
  }
}

function corruptRawRequestRef(home, turnRef) {
  const database = new DatabaseSync(path.join(home, 'tokenless.sqlite3'))
  try {
    database.prepare('UPDATE web_ai_v0_turns SET request_ref = ? WHERE turn_ref = ?')
      .run(`request:${'f'.repeat(32)}`, turnRef)
  } finally {
    database.close()
  }
}

async function startResponseLossProxy(targetOrigin, { dropResponses = true } = {}) {
  const target = new URL(targetOrigin)
  const dropped = { start: 0, read: 0, resume: 0, cancel: 0 }
  const requests = { bind: 0, start: 0, read: 0, resume: 0, cancel: 0 }
  let dropRead = false
  let failNextStart = false
  const server = http.createServer((request, response) => {
    const kind = responseLossKind(request.method, request.url)
    if (kind) requests[kind] += 1
    if (kind === 'start' && failNextStart) {
      failNextStart = false
      request.resume()
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'unexpected_gateway', message: 'Injected unknown gateway failure.', retryable: true } }))
      return
    }
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: request.headers,
    }, (upstreamResponse) => {
      if (dropResponses && kind && dropped[kind] === 0 && (kind !== 'read' || dropRead)) {
        dropped[kind] += 1
        if (kind === 'read') dropRead = false
        upstreamResponse.resume()
        upstreamResponse.once('end', () => response.destroy())
        return
      }
      response.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', (error) => response.destroy(error))
    request.pipe(upstream)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    dropNextRead() { dropRead = true },
    failNextStart() { failNextStart = true },
    dropped: () => ({ ...dropped }),
    requests: () => ({ ...requests }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function responseLossKind(method, url) {
  if (method === 'GET' && /\/v1\/private\/provider-turn\/turns\/[^/]+$/u.test(url)) return 'read'
  if (method !== 'POST') return undefined
  if (/\/v1\/private\/provider-turn\/bindings$/u.test(url)) return 'bind'
  if (/\/v1\/private\/provider-turn\/bindings\/[^/]+\/turns$/u.test(url)) return 'start'
  if (/\/v1\/private\/provider-turn\/turns\/[^/]+\/resume$/u.test(url)) return 'resume'
  if (/\/v1\/private\/provider-turn\/turns\/[^/]+\/cancel$/u.test(url)) return 'cancel'
  return undefined
}
