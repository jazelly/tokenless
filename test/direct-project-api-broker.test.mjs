import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const directModuleRoot = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL('../packages/cli/dist/src/direct/', import.meta.url)

const { AccountPoolStore } = await import(new URL('account-pool.js', directModuleRoot))
const { startDirectBroker } = await import(new URL('broker.js', directModuleRoot))

const SERVER_KEY = 'tokenless-project-api-test-key-32-characters'
const AUTHORIZATION = `Bearer ${SERVER_KEY}`
const PROVIDER_CASES = [
  { provider: 'chatgpt', project: 'OpenAI-Project', path: '/v1/responses', auth: 'authorization' },
  { provider: 'claude', project: 'Claude-Project', path: '/v1/messages', auth: 'x-api-key' },
  { provider: 'gemini', project: 'Gemini-Project', path: '/v1beta/models/gemini-test:generateContent', auth: 'x-goog-api-key' },
  { provider: 'grok', project: 'Grok-Project', path: '/v1/responses', auth: 'authorization', selector: 'grok' },
  { provider: 'antigravity', project: 'Gateway-Project', path: '/antigravity/v1/messages', auth: 'x-api-key' },
]

test('project broker isolates five provider credentials and preserves binary response bytes and safe headers', async () => {
  await withTemporaryHome(async (homeDir) => {
    const observed = []
    const binary = Buffer.from([0, 255, 1, 2, 13, 10, 128, 42])
    const upstream = await startUpstream(async (request, response, body) => {
      observed.push({ url: request.url, headers: request.headers, body })
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-request-id': 'safe-request-id',
        'x-upstream-secret': 'must-not-pass',
        'set-cookie': 'must-not-pass=1',
      })
      response.end(binary)
    })
    let broker
    try {
      const fixture = await createProviderFixture(homeDir)
      broker = await startProjectBroker(fixture, upstream.url)
      for (const entry of PROVIDER_CASES) {
        const response = await projectRequest(broker, entry.project, entry.path, {
          ...(entry.selector === undefined ? {} : { provider: entry.selector }),
          headers: {
            cookie: 'caller-cookie=secret',
            'x-api-key': 'caller-injected-key',
          },
        })
        assert.equal(response.status, 200)
        assert.deepEqual(response.body, binary)
        assert.equal(response.headers['x-request-id'], 'safe-request-id')
        assert.equal(response.headers['x-upstream-secret'], undefined)
        assert.equal(response.headers['set-cookie'], undefined)

        const sent = observed.at(-1)
        const expectedCredential = `${entry.provider}-account-secret`
        assert.equal(
          sent.headers[entry.auth],
          entry.auth === 'authorization' ? `Bearer ${expectedCredential}` : expectedCredential,
        )
        assert.equal(sent.headers.cookie, undefined)
        assert.equal(sent.headers['x-tokenless-project'], undefined)
        assert.equal(sent.headers['x-tokenless-provider'], undefined)
        for (const other of PROVIDER_CASES) {
          if (other.provider !== entry.provider) {
            assert.equal(JSON.stringify(sent.headers).includes(`${other.provider}-account-secret`), false)
          }
        }
      }

      const beforeOverride = observed.length
      const rejected = await projectRequest(broker, 'OpenAI-Project', '/v1/responses', {
        headers: { 'x-tokenless-account-id': 'caller-selected-account' },
      })
      assert.equal(rejected.status, 400)
      assert.equal(observed.length, beforeOverride)
    } finally {
      await broker?.close()
      await upstream.close()
    }
  })
})

test('exact credential rejection is returned byte-exact once and migrates only the next request', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const accountA = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'account-a',
      routingDomain: 'openai-team',
    })
    const accountB = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'account-b',
      routingDomain: 'openai-team',
    })
    await store.pinProject({ projectId: 'Project-A', provider: 'chatgpt', accountId: accountA.accountId })
    const invalidBody = Buffer.from(JSON.stringify({
      error: {
        message: 'invalid redacted key',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    }))
    const calls = []
    const upstream = await startUpstream(async (request, response) => {
      calls.push(request.headers.authorization)
      if (request.headers.authorization === 'Bearer secret-a') {
        response.writeHead(401, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(invalidBody.byteLength),
        })
        response.end(invalidBody)
      } else {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(Buffer.from('fallback-ok'))
      }
    })
    let broker
    try {
      broker = await startProjectBroker({
        homeDir,
        store,
        environment: {
          [accountA.credentialEnv]: 'secret-a',
          [accountB.credentialEnv]: 'secret-b',
        },
        routingDomains: { chatgpt: 'openai-team' },
      }, upstream.url)

      const rejected = await projectRequest(broker, 'Project-A', '/v1/responses')
      assert.equal(rejected.status, 401)
      assert.deepEqual(rejected.body, invalidBody)
      assert.deepEqual(calls, ['Bearer secret-a'])
      const afterRejection = await store.resolve({ projectId: 'Project-A', provider: 'chatgpt' })
      assert.equal(afterRejection.account.internalId, accountA.internalId)
      assert.equal(afterRejection.account.health.reason, 'api_credential_rejected')

      const next = await projectRequest(broker, 'Project-A', '/v1/responses')
      assert.equal(next.status, 200)
      assert.equal(next.body.toString(), 'fallback-ok')
      assert.deepEqual(calls, ['Bearer secret-a', 'Bearer secret-b'])
      const migrated = await store.resolve({ projectId: 'Project-A', provider: 'chatgpt' })
      assert.equal(migrated.account.internalId, accountB.internalId)

      await store.disableAccount({ provider: 'chatgpt', accountId: accountA.accountId })
      await store.enableAccount({ provider: 'chatgpt', accountId: accountA.accountId })
      await store.clearAccountHealth({ provider: 'chatgpt', accountId: accountA.accountId })
      const sticky = await projectRequest(broker, 'Project-A', '/v1/responses')
      assert.equal(sticky.status, 200)
      assert.deepEqual(calls, ['Bearer secret-a', 'Bearer secret-b', 'Bearer secret-b'])
      assert.equal(
        (await store.resolve({ projectId: 'Project-A', provider: 'chatgpt' })).account.internalId,
        accountB.internalId,
      )
    } finally {
      await broker?.close()
      await upstream.close()
    }
  })
})

test('permission, quota, transient, generic, non-JSON, oversize, and timeout failures never change binding or replay', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const accountA = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'stable-a',
      routingDomain: 'stable-domain',
    })
    const accountB = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'unused-b',
      routingDomain: 'stable-domain',
    })
    await store.pinProject({ projectId: 'Stable-Project', provider: 'chatgpt', accountId: accountA.accountId })
    const cases = new Map([
      ['permission', { status: 403, type: 'application/json', body: Buffer.from('{"error":{"code":"permission_denied"}}') }],
      ['quota', { status: 429, type: 'application/json', body: Buffer.from('{"error":{"code":"insufficient_quota"}}') }],
      ['server', { status: 500, type: 'application/json', body: Buffer.from('{"error":{"code":"server_error"}}') }],
      ['generic401', { status: 401, type: 'application/json', body: Buffer.from('{"error":{"code":"authentication_failed"}}') }],
      ['nonjson401', { status: 401, type: 'text/plain', body: Buffer.from('unauthorized') }],
      ['oversize401', {
        status: 401,
        type: 'application/json',
        body: Buffer.concat([
          Buffer.from('{"error":{"code":"invalid_api_key"},"padding":"'),
          Buffer.alloc(70 * 1_024, 0x78),
          Buffer.from('"}'),
        ]),
      }],
    ])
    const calls = []
    const upstream = await startUpstream(async (request, response) => {
      const requestCase = String(request.headers['x-client-request-id'])
      calls.push({ requestCase, authorization: request.headers.authorization })
      if (requestCase === 'timeout') return
      if (requestCase === 'truncated') {
        const complete = Buffer.from(JSON.stringify({
          error: {
            message: 'invalid redacted key',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key',
          },
        }))
        response.writeHead(401, {
          'content-type': 'application/json',
          'content-length': String(complete.byteLength),
        })
        response.flushHeaders()
        response.write(complete.subarray(0, complete.byteLength - 2))
        setImmediate(() => response.destroy())
        return
      }
      const fixture = cases.get(requestCase)
      response.writeHead(fixture.status, {
        'content-type': fixture.type,
        'content-length': String(fixture.body.byteLength),
      })
      response.end(fixture.body)
    })
    let broker
    try {
      broker = await startProjectBroker({
        homeDir,
        store,
        environment: {
          [accountA.credentialEnv]: 'stable-secret',
          [accountB.credentialEnv]: 'unused-secret',
          TOKENLESS_DIRECT_TIMEOUT_MS: '40',
        },
        routingDomains: { chatgpt: 'stable-domain' },
      }, upstream.url)
      for (const [name, fixture] of cases) {
        const result = await projectRequest(broker, 'Stable-Project', '/v1/responses', {
          headers: { 'x-client-request-id': name },
        })
        assert.equal(result.status, fixture.status)
        assert.deepEqual(result.body, fixture.body)
        await assertStableUsableBinding(store, accountA.internalId)
      }
      const truncated = await projectRequest(broker, 'Stable-Project', '/v1/responses', {
        headers: { 'x-client-request-id': 'truncated' },
      })
      assert.equal(truncated.status, 502)
      assert.equal(JSON.parse(truncated.body).error.code, 'direct_upstream_error')
      await assertStableUsableBinding(store, accountA.internalId)
      const timedOut = await projectRequest(broker, 'Stable-Project', '/v1/responses', {
        headers: { 'x-client-request-id': 'timeout' },
      })
      assert.equal(timedOut.status, 504)
      await assertStableUsableBinding(store, accountA.internalId)
      assert.equal(calls.length, cases.size + 2)
      assert.equal(calls.every((call) => call.authorization === 'Bearer stable-secret'), true)
    } finally {
      await broker?.close()
      await upstream.close()
    }
  })
})

test('account capacity covers the full SSE stream and busy or Expect requests never spill or receive 100 Continue', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const accountA = await store.addApiAccount({
      provider: 'claude',
      accountId: 'stream-a',
      routingDomain: 'anthropic-team',
      maxConcurrency: 1,
    })
    const accountB = await store.addApiAccount({
      provider: 'claude',
      accountId: 'stream-b',
      routingDomain: 'anthropic-team',
      maxConcurrency: 1,
    })
    await store.pinProject({ projectId: 'Stream-Project', provider: 'claude', accountId: accountA.accountId })
    let releaseStream
    let firstChunkWritten
    const firstChunk = new Promise((resolve) => firstChunkWritten = resolve)
    const calls = []
    const upstream = await startUpstream(async (request, response) => {
      calls.push(request.headers['x-api-key'])
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: first\ndata: one\n\n')
      firstChunkWritten()
      await new Promise((resolve) => releaseStream = resolve)
      response.end('event: done\ndata: two\n\n')
    })
    let broker
    try {
      broker = await startProjectBroker({
        homeDir,
        store,
        environment: {
          [accountA.credentialEnv]: 'stream-secret-a',
          [accountB.credentialEnv]: 'stream-secret-b',
        },
        routingDomains: { claude: 'anthropic-team' },
        queueDepth: 0,
      }, upstream.url)
      const streaming = projectRequest(broker, 'Stream-Project', '/v1/messages')
      await firstChunk

      const busy = await projectRequest(broker, 'Stream-Project', '/v1/messages')
      assert.equal(busy.status, 503)
      assert.equal(JSON.parse(busy.body).error.code, 'api_account_queue_full')
      const expect = await expectProjectRequest(broker, 'Stream-Project', '/v1/messages')
      assert.equal(expect.status, 503)
      assert.equal(expect.continued, false)
      assert.deepEqual(calls, ['stream-secret-a'])
      assert.equal(
        (await store.resolve({ projectId: 'Stream-Project', provider: 'claude' })).account.internalId,
        accountA.internalId,
      )

      releaseStream()
      const completed = await streaming
      assert.equal(completed.status, 200)
      assert.equal(
        completed.body.toString(),
        'event: first\ndata: one\n\nevent: done\ndata: two\n\n',
      )
    } finally {
      releaseStream?.()
      await broker?.close()
      await upstream.close()
    }
  })
})

test('chunked project rejection closes the terminal upload without accepting a pipelined request', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const account = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'oversize-account',
      routingDomain: 'oversize-domain',
    })
    await store.pinProject({
      projectId: 'Oversize-Project',
      provider: 'chatgpt',
      accountId: account.accountId,
    })
    let completeUpstreamBodies = 0
    const upstream = await startUpstream(async (_request, response) => {
      completeUpstreamBodies += 1
      response.end('{}')
    })
    let broker
    try {
      broker = await startDirectBroker({
        serverKey: SERVER_KEY,
        host: '127.0.0.1',
        port: 0,
        maxRequestBytes: 16,
        projectApi: {
          homeDir,
          accountPool: store,
          environment: { [account.credentialEnv]: 'oversize-secret' },
          routingDomains: { chatgpt: 'oversize-domain' },
          baseUrls: { chatgpt: upstream.url },
        },
      })
      const raw = await terminalChunkedProjectUpload(broker, 'Oversize-Project', 17)
      assert.match(raw, /^HTTP\/1\.1 413 /)
      assert.equal((raw.match(/HTTP\/1\.1 /g) ?? []).length, 1)
      assert.equal(completeUpstreamBodies, 0)
      assert.equal(
        (await store.resolve({ projectId: 'Oversize-Project', provider: 'chatgpt' })).account.internalId,
        account.internalId,
      )
      assert.equal((await brokerRequest(broker, '/health', { method: 'GET', body: Buffer.alloc(0) })).status, 200)
    } finally {
      await broker?.close()
      await upstream.close()
    }
  })
})

test('early upstream response closes the incomplete project upload without accepting a pipeline', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const account = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'early-response-account',
      routingDomain: 'early-response-domain',
    })
    await store.pinProject({
      projectId: 'Early-Response-Project',
      provider: 'chatgpt',
      accountId: account.accountId,
    })
    let upstreamRequests = 0
    const upstream = await startImmediateUpstream((_request, response) => {
      upstreamRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    let broker
    try {
      broker = await startDirectBroker({
        serverKey: SERVER_KEY,
        host: '127.0.0.1',
        port: 0,
        projectApi: {
          homeDir,
          accountPool: store,
          environment: { [account.credentialEnv]: 'early-response-secret' },
          routingDomains: { chatgpt: 'early-response-domain' },
          baseUrls: { chatgpt: upstream.url },
        },
      })
      const raw = await terminalChunkedProjectUpload(
        broker,
        'Early-Response-Project',
        1,
      )
      assert.match(raw, /^HTTP\/1\.1 200 /)
      assert.equal((raw.match(/HTTP\/1\.1 /g) ?? []).length, 1)
      assert.equal(upstreamRequests, 1)
      assert.equal(
        (await store.resolve({ projectId: 'Early-Response-Project', provider: 'chatgpt' })).account.internalId,
        account.internalId,
      )
      assert.equal((await brokerRequest(broker, '/health', { method: 'GET', body: Buffer.alloc(0) })).status, 200)
    } finally {
      await broker?.close()
      await upstream.close()
    }
  })
})

test('project API mode preserves legacy no-project credentials and validates injected timeout configuration', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const account = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'project-account',
      routingDomain: 'project-domain',
    })
    await store.pinProject({ projectId: 'Project-L', provider: 'chatgpt', accountId: account.accountId })
    const seen = []
    const upstream = await startUpstream(async (request, response) => {
      seen.push(request.headers.authorization)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    let broker
    try {
      await withEnvironment({
        TOKENLESS_DIRECT_CHATGPT_API_KEY: 'legacy-secret',
        TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
      }, async () => {
        broker = await startProjectBroker({
          homeDir,
          store,
          environment: {
            [account.credentialEnv]: 'project-secret',
            TOKENLESS_DIRECT_TIMEOUT_MS: '1000',
          },
          routingDomains: { chatgpt: 'project-domain' },
        }, upstream.url)
        assert.equal((await projectRequest(broker, 'Project-L', '/v1/responses')).status, 200)
        assert.equal((await brokerRequest(broker, '/v1/responses')).status, 200)
      })
      assert.deepEqual(seen, ['Bearer project-secret', 'Bearer legacy-secret'])

      await assert.rejects(
        startDirectBroker({
          serverKey: SERVER_KEY,
          host: '127.0.0.1',
          port: 0,
          projectApi: {
            homeDir,
            accountPool: store,
            environment: { TOKENLESS_DIRECT_TIMEOUT_MS: 'not-an-integer' },
          },
        }),
        (error) => error?.code === 'direct_configuration_error',
      )
    } finally {
      await broker?.close()
      await upstream.close()
    }
  })
})

async function createProviderFixture(homeDir) {
  const store = new AccountPoolStore({ homeDir })
  const environment = {}
  const routingDomains = {}
  for (const entry of PROVIDER_CASES) {
    const account = await store.addApiAccount({
      provider: entry.provider,
      accountId: `${entry.provider}-account`,
      routingDomain: `${entry.provider}-domain`,
    })
    const unused = await store.addApiAccount({
      provider: entry.provider,
      accountId: `${entry.provider}-unused`,
      routingDomain: `${entry.provider}-domain`,
    })
    await store.pinProject({ projectId: entry.project, provider: entry.provider, accountId: account.accountId })
    environment[account.credentialEnv] = `${entry.provider}-account-secret`
    environment[unused.credentialEnv] = `${entry.provider}-unused-secret`
    routingDomains[entry.provider] = `${entry.provider}-domain`
  }
  return { homeDir, store, environment, routingDomains }
}

async function startProjectBroker(fixture, upstreamUrl) {
  return startDirectBroker({
    serverKey: SERVER_KEY,
    host: '127.0.0.1',
    port: 0,
    projectApi: {
      homeDir: fixture.homeDir,
      accountPool: fixture.store,
      environment: fixture.environment,
      routingDomains: fixture.routingDomains,
      baseUrls: Object.fromEntries(PROVIDER_CASES.map(({ provider }) => [provider, upstreamUrl])),
      ...(fixture.queueDepth === undefined ? {} : { queueDepth: fixture.queueDepth }),
      ...(fixture.queueWaitMs === undefined ? {} : { queueWaitMs: fixture.queueWaitMs }),
    },
  })
}

function projectRequest(broker, projectId, requestPath, options = {}) {
  return brokerRequest(broker, requestPath, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      'x-tokenless-project': projectId,
      ...(options.provider === undefined ? {} : { 'x-tokenless-provider': options.provider }),
    },
  })
}

function brokerRequest(broker, requestPath, options = {}) {
  const body = options.body ?? Buffer.from('{}')
  return new Promise((resolve, reject) => {
    const request = http.request(`${broker.url}${requestPath}`, {
      method: options.method ?? 'POST',
      headers: {
        authorization: AUTHORIZATION,
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

function expectProjectRequest(broker, projectId, requestPath) {
  return new Promise((resolve, reject) => {
    let continued = false
    const request = http.request(`${broker.url}${requestPath}`, {
      method: 'POST',
      headers: {
        authorization: AUTHORIZATION,
        expect: '100-continue',
        'content-type': 'application/json',
        'content-length': '4',
        'x-tokenless-project': projectId,
      },
    })
    request.once('continue', () => {
      continued = true
      request.end('body')
    })
    request.once('response', (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => {
        if (!request.writableEnded) request.destroy()
        resolve({ status: response.statusCode, body: Buffer.concat(chunks), continued })
      })
    })
    request.once('error', reject)
    request.flushHeaders()
  })
}

function terminalChunkedProjectUpload(broker, projectId, initialBytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: broker.host, port: broker.port })
    const chunks = []
    let sentAfterRejection = false
    socket.once('connect', () => {
      socket.write([
        'POST /v1/responses HTTP/1.1',
        `Host: ${broker.host}:${broker.port}`,
        `Authorization: ${AUTHORIZATION}`,
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: keep-alive',
        `X-Tokenless-Project: ${projectId}`,
        '',
        initialBytes.toString(16),
        'x'.repeat(initialBytes),
        '',
      ].join('\r\n'))
    })
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk))
      if (sentAfterRejection) return
      sentAfterRejection = true
      socket.end([
        '1',
        'y',
        '0',
        '',
        'GET /health HTTP/1.1',
        `Host: ${broker.host}:${broker.port}`,
        `Authorization: ${AUTHORIZATION}`,
        '',
        '',
      ].join('\r\n'))
    })
    const finish = () => resolve(Buffer.concat(chunks).toString('latin1'))
    socket.once('end', finish)
    socket.once('close', finish)
    socket.once('error', (error) => {
      if (chunks.length > 0) finish()
      else reject(error)
    })
  })
}

async function assertStableUsableBinding(store, internalId) {
  const resolution = await store.resolve({ projectId: 'Stable-Project', provider: 'chatgpt' })
  assert.equal(resolution.account.internalId, internalId)
  assert.deepEqual(resolution.account.health, { state: 'usable', generation: 0 })
  assert.equal(resolution.binding.generation, 1)
}

async function startUpstream(handler) {
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.once('end', () => {
      void Promise.resolve(handler(request, response, Buffer.concat(chunks))).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function startImmediateUpstream(handler) {
  const server = http.createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function withEnvironment(updates, run) {
  const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]))
  Object.assign(process.env, updates)
  try {
    await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withTemporaryHome(run) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-project-api-broker-'))
  try {
    await run(homeDir)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
}
