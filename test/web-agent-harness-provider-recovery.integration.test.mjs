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

function corruptRawRequestRef(home, turnRef) {
  const database = new DatabaseSync(path.join(home, 'tokenless.sqlite3'))
  try {
    database.prepare('UPDATE web_ai_v0_turns SET request_ref = ? WHERE turn_ref = ?')
      .run(`request:${'f'.repeat(32)}`, turnRef)
  } finally {
    database.close()
  }
}

async function startResponseLossProxy(targetOrigin) {
  const target = new URL(targetOrigin)
  const dropped = { start: 0, read: 0, resume: 0, cancel: 0 }
  let dropRead = false
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: request.headers,
    }, (upstreamResponse) => {
      const kind = responseLossKind(request.method, request.url)
      if (kind && dropped[kind] === 0 && (kind !== 'read' || dropRead)) {
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
    dropped: () => ({ ...dropped }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function responseLossKind(method, url) {
  if (method === 'GET' && /\/v1\/private\/provider-turn\/turns\/[^/]+$/u.test(url)) return 'read'
  if (method !== 'POST') return undefined
  if (/\/v1\/private\/provider-turn\/bindings\/[^/]+\/turns$/u.test(url)) return 'start'
  if (/\/v1\/private\/provider-turn\/turns\/[^/]+\/resume$/u.test(url)) return 'resume'
  if (/\/v1\/private\/provider-turn\/turns\/[^/]+\/cancel$/u.test(url)) return 'cancel'
  return undefined
}
