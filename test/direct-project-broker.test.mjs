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

const {
  DIRECT_BROKER_CAPABILITIES_PATH,
  startDirectBroker,
} = await import(new URL('broker.js', directModuleRoot))
const {
  AccountPoolStore,
} = await import(new URL('account-pool.js', directModuleRoot))
const {
  createSqliteAccountPoolSerialization,
} = await import(new URL('account-pool-lock.js', directModuleRoot))
const {
  ManagedProjectExecutorError,
} = await import(new URL('project-codex-router.js', directModuleRoot))

const SERVER_KEY = 'tokenless-managed-project-test-key-32-characters'
const AUTHORIZATION = `Bearer ${SERVER_KEY}`

test('exact Host validation accepts bracketed IPv6 loopback authority', async (context) => {
  let broker
  try {
    try {
      broker = await startDirectBroker({ serverKey: SERVER_KEY, host: '::1', port: 0 })
    } catch (error) {
      if (error?.code === 'EADDRNOTAVAIL' || error?.code === 'EAFNOSUPPORT') {
        context.skip('IPv6 loopback is unavailable on this host.')
        return
      }
      throw error
    }
    assert.match(broker.url, /^http:\/\/\[::1\]:[0-9]+$/)
    const accepted = await brokerRequest(broker, '/health', {
      method: 'GET',
      headers: { authorization: AUTHORIZATION },
    })
    assert.equal(accepted.status, 200)
    const rejected = await rawHttpRequest(
      broker.host,
      broker.port,
      `GET /health HTTP/1.1\r\nHost: ::1:${broker.port}\r\nAuthorization: ${AUTHORIZATION}\r\n\r\n`,
    )
    assert.match(rejected, /^HTTP\/1\.1 400 /)
  } finally {
    await broker?.close()
  }
})

test('managed project routing stays pinned across new accounts and broker restarts', async () => {
  const fixture = await createPoolFixture()
  const firstDispatches = []
  let broker
  try {
    const accountA = await addReadyCodexAccount(fixture.store, 'account-a', 'A')
    const accountB = await addReadyCodexAccount(fixture.store, 'account-b', 'B')
    await fixture.store.pinProject({ projectId: 'Project-A', provider: 'chatgpt', accountId: 'account-a' })
    await fixture.store.pinProject({ projectId: 'Project-B', provider: 'chatgpt', accountId: 'account-b' })

    broker = await startManagedBroker(fixture.homeDir, async (execution) => {
      firstDispatches.push(dispatchSummary(execution))
      return 'stable managed answer'
    })
    const capabilities = await brokerRequest(broker, DIRECT_BROKER_CAPABILITIES_PATH, {
      method: 'GET',
      headers: { authorization: AUTHORIZATION },
    })
    assert.equal(JSON.parse(capabilities.body).officialClient, true)

    const responseA = await managedRequest(broker, 'Project-A', { input: 'first A' })
    const responseB = await managedRequest(broker, 'Project-B', { input: 'first B' })
    assert.equal(responseA.status, 200)
    assert.equal(responseB.status, 200)
    assert.equal(responseText(responseA), 'stable managed answer')
    assert.equal(responseText(responseB), 'stable managed answer')
    assert.deepEqual(firstDispatches.map(({ projectId, accountId }) => ({ projectId, accountId })), [
      { projectId: 'Project-A', accountId: 'account-a' },
      { projectId: 'Project-B', accountId: 'account-b' },
    ])

    await addReadyCodexAccount(fixture.store, 'account-c', 'C')
    await managedRequest(broker, 'Project-A', { input: 'A after C' })
    assert.equal(firstDispatches.at(-1).accountId, 'account-a')
    await broker.close()
    broker = undefined

    const restartedDispatches = []
    broker = await startManagedBroker(fixture.homeDir, async (execution) => {
      restartedDispatches.push(dispatchSummary(execution))
      return 'restart answer'
    })
    const streamed = await managedRequest(broker, 'Project-B', {
      input: 'B after restart',
      stream: true,
      store: false,
    })
    assert.equal(streamed.status, 200)
    assert.equal(streamed.headers['content-type'], 'text/event-stream; charset=utf-8')
    const events = parseSse(streamed.body)
    assert.deepEqual(events.map((event) => event.type), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    assert.equal(events.at(-1).response.output[0].content[0].text, 'restart answer')
    assert.equal(restartedDispatches[0].accountId, 'account-b')

    const snapshot = await fixture.store.readSnapshot()
    const bindingA = snapshot.bindings.find((binding) => binding.projectId === 'Project-A')
    const bindingB = snapshot.bindings.find((binding) => binding.projectId === 'Project-B')
    assert.equal(bindingA.accountInternalId, accountA.internalId)
    assert.equal(bindingB.accountInternalId, accountB.internalId)
    assert.equal(bindingA.generation, 1)
    assert.equal(bindingB.generation, 1)
    for (const privateValue of [
      'Project-B',
      accountA.internalId,
      accountB.internalId,
      fixture.homeDir,
      'provider-profiles',
      'account-a',
      'account-b',
    ]) {
      assert.equal(streamed.body.includes(privateValue), false, privateValue)
    }
  } finally {
    await broker?.close()
    await fixture.close()
  }
})

test('managed requests use bounded FIFO single-flight and never spill to another account', async () => {
  const fixture = await createPoolFixture()
  let broker
  try {
    const accountA = await addReadyCodexAccount(fixture.store, 'account-a', 'A')
    const accountB = await addReadyCodexAccount(fixture.store, 'account-b', 'B')
    await fixture.store.pinProject({ projectId: 'Queue-A', provider: 'chatgpt', accountId: 'account-a' })
    await fixture.store.pinProject({ projectId: 'Queue-B', provider: 'chatgpt', accountId: 'account-b' })

    const dispatches = []
    let active = 0
    let maximumActive = 0
    broker = await startManagedBroker(fixture.homeDir, (execution) => new Promise((resolve) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      const dispatch = {
        ...dispatchSummary(execution),
        input: execution.request.input,
        release: () => {
          active -= 1
          resolve('queued answer')
        },
      }
      dispatches.push(dispatch)
    }), { maxQueuedRequests: 2 })

    const first = managedRequest(broker, 'Queue-A', { input: 'first' })
    await waitFor(() => dispatches.length === 1)
    const second = managedRequest(broker, 'Queue-B', { input: 'second' })
    const third = managedRequest(broker, 'Queue-A', { input: 'third' })
    await addReadyCodexAccount(fixture.store, 'account-c', 'C')
    await delay(25)
    assert.equal(dispatches.length, 1)

    const overflow = await managedRequest(broker, 'Queue-B', { input: 'overflow' })
    assert.equal(overflow.status, 503)
    assert.deepEqual(JSON.parse(overflow.body).error, {
      code: 'direct_upstream_error',
      managed_code: 'managed_project_queue_full',
      message: 'The managed ChatGPT queue is full; retry the same project without changing its binding.',
      retryable: true,
      delivery_unknown: false,
    })

    dispatches[0].release()
    await waitFor(() => dispatches.length === 2)
    assert.equal(dispatches[1].input, 'second')
    assert.equal(dispatches[1].accountId, 'account-b')
    dispatches[1].release()
    await waitFor(() => dispatches.length === 3)
    assert.equal(dispatches[2].input, 'third')
    assert.equal(dispatches[2].accountId, 'account-a')
    dispatches[2].release()

    for (const response of await Promise.all([first, second, third])) assert.equal(response.status, 200)
    assert.equal(maximumActive, 1)
    const snapshot = await fixture.store.readSnapshot()
    assert.equal(snapshot.bindings.find((binding) => binding.projectId === 'Queue-A').accountInternalId, accountA.internalId)
    assert.equal(snapshot.bindings.find((binding) => binding.projectId === 'Queue-B').accountInternalId, accountB.internalId)
  } finally {
    await broker?.close()
    await fixture.close()
  }
})

test('managed queue wait timeout is pre-dispatch and leaves affinity unchanged', async () => {
  const fixture = await createPoolFixture()
  let broker
  try {
    const accountA = await addReadyCodexAccount(fixture.store, 'account-a', 'A')
    await addReadyCodexAccount(fixture.store, 'account-b', 'B')
    await fixture.store.pinProject({ projectId: 'Timeout-A', provider: 'chatgpt', accountId: 'account-a' })
    const dispatches = []
    broker = await startManagedBroker(fixture.homeDir, (execution) => new Promise((resolve) => {
      dispatches.push({ ...dispatchSummary(execution), release: () => resolve('released') })
    }), { queueWaitTimeoutMs: 30 })

    const active = managedRequest(broker, 'Timeout-A', { input: 'active' })
    await waitFor(() => dispatches.length === 1)
    const queued = expectContinueManagedRequest(
      broker,
      'Timeout-A',
      Buffer.from(JSON.stringify({ input: 'must not dispatch' })),
    )
    const timedOut = await queued.response
    assert.equal(timedOut.status, 504)
    assert.equal(queued.continued, false)
    assert.deepEqual(JSON.parse(timedOut.body).error, {
      code: 'direct_timeout',
      managed_code: 'managed_project_queue_timeout',
      message: 'The managed ChatGPT request timed out in the queue without changing its binding.',
      retryable: true,
      delivery_unknown: false,
    })
    assert.equal(dispatches.length, 1)
    dispatches[0].release()
    assert.equal((await active).status, 200)
    const binding = (await fixture.store.resolve({ projectId: 'Timeout-A', provider: 'chatgpt' })).binding
    assert.equal(binding.accountInternalId, accountA.internalId)
    assert.equal(binding.generation, 1)
  } finally {
    await broker?.close()
    await fixture.close()
  }
})

test('managed queue admission rejects overflow before reading or continuing its body', async () => {
  const fixture = await createPoolFixture()
  let broker
  try {
    await addReadyCodexAccount(fixture.store, 'account-a', 'A')
    await fixture.store.pinProject({ projectId: 'Admission-A', provider: 'chatgpt', accountId: 'account-a' })
    const dispatches = []
    broker = await startManagedBroker(fixture.homeDir, (execution) => new Promise((resolve) => {
      dispatches.push({
        ...dispatchSummary(execution),
        input: execution.request.input,
        release: () => resolve('admitted answer'),
      })
    }), { maxQueuedRequests: 1 })

    const active = managedRequest(broker, 'Admission-A', { input: 'active' })
    await waitFor(() => dispatches.length === 1)
    const queued = expectContinueManagedRequest(
      broker,
      'Admission-A',
      Buffer.from(JSON.stringify({ input: 'queued body' })),
    )
    await delay(25)
    assert.equal(queued.continued, false)

    const overflowBody = Buffer.alloc(4 * 1_024 * 1_024, 0x78)
    const overflow = expectContinueManagedRequest(broker, 'Admission-A', overflowBody)
    const rejected = await overflow.response
    assert.equal(rejected.status, 503)
    assert.equal(overflow.continued, false)
    assert.equal(JSON.parse(rejected.body).error.managed_code, 'managed_project_queue_full')
    assert.equal(JSON.parse(rejected.body).error.delivery_unknown, false)
    assert.equal(dispatches.length, 1)

    dispatches[0].release()
    await waitFor(() => queued.continued)
    await waitFor(() => dispatches.length === 2)
    assert.equal(dispatches[1].input, 'queued body')
    dispatches[1].release()
    assert.equal((await active).status, 200)
    assert.equal((await queued.response).status, 200)
    assert.equal(dispatches.length, 2)
  } finally {
    await broker?.close()
    await fixture.close()
  }
})

test('managed single-flight is process-global across broker and router instances', async () => {
  const fixture = await createPoolFixture()
  let brokerA
  let brokerB
  try {
    await addReadyCodexAccount(fixture.store, 'account-a', 'A')
    await addReadyCodexAccount(fixture.store, 'account-b', 'B')
    await fixture.store.pinProject({ projectId: 'Global-A', provider: 'chatgpt', accountId: 'account-a' })
    await fixture.store.pinProject({ projectId: 'Global-B', provider: 'chatgpt', accountId: 'account-b' })
    const dispatches = []
    let active = 0
    let maximumActive = 0
    const executor = (execution) => new Promise((resolve) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      dispatches.push({
        ...dispatchSummary(execution),
        release: () => {
          active -= 1
          resolve('global answer')
        },
      })
    })
    brokerA = await startManagedBroker(fixture.homeDir, executor)
    brokerB = await startManagedBroker(path.join(fixture.homeDir, '.'), executor)

    const first = managedRequest(brokerA, 'Global-A', { input: 'first broker' })
    await waitFor(() => dispatches.length === 1)
    const second = managedRequest(brokerB, 'Global-B', { input: 'second broker' })
    await delay(25)
    assert.equal(dispatches.length, 1)
    dispatches[0].release()
    await waitFor(() => dispatches.length === 2)
    assert.equal(dispatches[1].accountId, 'account-b')
    dispatches[1].release()
    for (const response of await Promise.all([first, second])) assert.equal(response.status, 200)
    assert.equal(maximumActive, 1)
  } finally {
    await brokerA?.close()
    await brokerB?.close()
    await fixture.close()
  }
})

test('managed execution errors preserve safe delivery semantics without leaking routing metadata', async () => {
  const fixture = await createPoolFixture()
  let broker
  try {
    const account = await addReadyCodexAccount(fixture.store, 'private-account', 'P')
    await fixture.store.pinProject({ projectId: 'Private-Project', provider: 'chatgpt', accountId: 'private-account' })
    broker = await startManagedBroker(fixture.homeDir, async (execution) => {
      const privateDetails = `${execution.projectId} ${execution.initialAccount.accountId} ${execution.initialAccount.internalId} ${execution.homeDir}`
      if (execution.request.input === 'typed') {
        throw new ManagedProjectExecutorError(
          'managed_executor_timeout',
          privateDetails,
          { retryable: true, deliveryUnknown: true },
        )
      }
      if (execution.request.input === 'invalid output') return ''
      throw new Error(privateDetails)
    })

    const typed = await managedRequest(broker, 'Private-Project', { input: 'typed' })
    assert.equal(typed.status, 504)
    assert.deepEqual(JSON.parse(typed.body).error, {
      code: 'direct_timeout',
      managed_code: 'managed_executor_timeout',
      message: 'The managed ChatGPT execution failed and the project binding was not changed.',
      retryable: true,
      delivery_unknown: true,
    })
    const unknown = await managedRequest(broker, 'Private-Project', { input: 'unknown' })
    assert.equal(unknown.status, 502)
    assert.equal(JSON.parse(unknown.body).error.managed_code, 'managed_executor_failed')
    assert.equal(JSON.parse(unknown.body).error.delivery_unknown, true)
    const invalidOutput = await managedRequest(broker, 'Private-Project', { input: 'invalid output' })
    assert.equal(invalidOutput.status, 502)
    assert.deepEqual(JSON.parse(invalidOutput.body).error, {
      code: 'direct_invalid_response',
      managed_code: 'managed_executor_invalid_response',
      message: 'The managed ChatGPT execution returned an invalid response.',
      retryable: false,
      delivery_unknown: true,
    })
    for (const response of [typed, unknown, invalidOutput]) {
      for (const privateValue of ['Private-Project', 'private-account', account.internalId, fixture.homeDir]) {
        assert.equal(response.body.includes(privateValue), false, privateValue)
      }
    }
    const binding = (await fixture.store.resolve({ projectId: 'Private-Project', provider: 'chatgpt' })).binding
    assert.equal(binding.accountInternalId, account.internalId)
    assert.equal(binding.generation, 1)
  } finally {
    await broker?.close()
    await fixture.close()
  }
})

test('managed routing fails closed, hardens loopback headers, and preserves accepted legacy bytes', async () => {
  const fixture = await createPoolFixture()
  const upstreamBodies = []
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    upstreamBodies.push({
      authorization: incoming.headers.authorization,
      body: await readBodyBytes(incoming),
      url: incoming.url,
    })
    outgoing.writeHead(200, { 'content-type': 'application/octet-stream' })
    outgoing.end(Buffer.from([0xff, 0x00, 0x41]))
  })
  let broker
  let executorCalls = 0
  try {
    const boundAccount = await addReadyCodexAccount(fixture.store, 'account-a', 'A')
    await addReadyCodexAccount(fixture.store, 'account-b', 'B')
    await fixture.store.pinProject({ projectId: 'Secure-A', provider: 'chatgpt', accountId: 'account-a' })
    await withChatGptEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'legacy-upstream-key',
    }, async () => {
      broker = await startManagedBroker(fixture.homeDir, async () => {
        executorCalls += 1
        return 'secure answer'
      })

      for (const [projectId, expectedStatus] of [
        ['Missing-A', 400],
        ['secure-a', 400],
        [' bad ', 400],
      ]) {
        const response = await managedRequest(broker, projectId, { input: 'must fail closed' })
        assert.equal(response.status, expectedStatus, projectId)
        assert.equal(upstreamBodies.length, 0)
      }
      assert.equal((await managedRequest(broker, 'Secure-A', { input: 'wrong provider' }, {
        'x-tokenless-provider': 'grok',
      })).status, 400)
      assert.equal((await brokerRequest(broker, '/v1/messages', {
        method: 'POST',
        headers: managedHeaders('Secure-A'),
        body: Buffer.from('{"input":"wrong route"}'),
      })).status, 404)
      assert.equal((await brokerRequest(broker, '/v1/responses?trace=true', {
        method: 'POST',
        headers: managedHeaders('Secure-A'),
        body: Buffer.from('{"input":"query"}'),
      })).status, 400)

      const authority = socketAuthority(broker.host, broker.port)
      const body = '{"input":"raw"}'
      const baseLines = [
        'POST /v1/responses HTTP/1.1',
        `Host: ${authority}`,
        `Authorization: ${AUTHORIZATION}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
      ]
      const rawCases = [
        { label: 'wrong host', status: 400, lines: baseLines.map((line) => line.startsWith('Host:') ? `Host: localhost:${broker.port}` : line) },
        { label: 'duplicate host', status: 400, lines: [...baseLines, `Host: ${authority}`] },
        { label: 'duplicate authorization', status: 401, lines: [...baseLines, `Authorization: ${AUTHORIZATION}`] },
        { label: 'origin', status: 400, lines: [...baseLines, 'Origin: https://attacker.invalid'] },
        { label: 'duplicate project', status: 400, lines: [...baseLines, 'X-Tokenless-Project: Secure-A', 'x-tokenless-project: Secure-A'] },
        { label: 'duplicate provider', status: 400, lines: [...baseLines, 'X-Tokenless-Project: Secure-A', 'X-Tokenless-Provider: chatgpt', 'x-tokenless-provider: chatgpt'] },
      ]
      for (const header of [
        'X-Tokenless-Account: account-a',
        'X-Tokenless-Internal-Id: hidden',
        'X-Tokenless-Routing-Domain: hidden',
        'X-Tokenless-Credential-Env: hidden',
        'X-Tokenless-Driver: official-codex',
        'X-Tokenless-Anything: hidden',
        'X_Tokenless_Project: Secure-A',
        'X-Codex-Home: /tmp/hidden',
        'Codex-Home: /tmp/hidden',
        'X_Profile_Id: hidden',
      ]) {
        rawCases.push({ label: header, status: 400, lines: [...baseLines, 'X-Tokenless-Project: Secure-A', header] })
      }
      for (const { label, status, lines } of rawCases) {
        const raw = await rawHttpRequest(
          broker.host,
          broker.port,
          `${lines.join('\r\n')}\r\n\r\n${body}`,
        )
        assert.match(raw, new RegExp(`^HTTP/1\\.1 ${status} `), label)
      }
      assert.equal(executorCalls, 0)
      assert.equal(upstreamBodies.length, 0)

      await fixture.store.disableAccount({ provider: 'chatgpt', accountId: 'account-a' })
      const unavailable = await managedRequest(broker, 'Secure-A', { input: 'do not fail over' })
      assert.equal(unavailable.status, 503)
      assert.equal(JSON.parse(unavailable.body).error.managed_code, 'managed_project_binding_unavailable')
      assert.equal(JSON.parse(unavailable.body).error.delivery_unknown, false)
      assert.equal(executorCalls, 0)
      assert.equal(
        (await fixture.store.resolve({ projectId: 'Secure-A', provider: 'chatgpt' })).binding.accountInternalId,
        boundAccount.internalId,
      )

      const legacyBody = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a])
      const legacy = await brokerRequest(broker, '/v1/responses', {
        method: 'POST',
        headers: {
          authorization: AUTHORIZATION,
          'content-type': 'application/octet-stream',
        },
        body: legacyBody,
      })
      assert.equal(legacy.status, 200)
      assert.deepEqual(legacy.bodyBytes, Buffer.from([0xff, 0x00, 0x41]))
      assert.equal(upstreamBodies.length, 1)
      assert.equal(upstreamBodies[0].url, '/v1/responses')
      assert.equal(upstreamBodies[0].authorization, 'Bearer legacy-upstream-key')
      assert.deepEqual(upstreamBodies[0].body, legacyBody)
      assert.equal(executorCalls, 0)
    })
  } finally {
    await broker?.close()
    await upstream.close()
    await fixture.close()
  }
})

test('managed client disconnect and forced shutdown abort execution without account spill', async () => {
  const fixture = await createPoolFixture()
  let broker
  try {
    await addReadyCodexAccount(fixture.store, 'account-a', 'A')
    await addReadyCodexAccount(fixture.store, 'account-b', 'B')
    await fixture.store.pinProject({ projectId: 'Abort-A', provider: 'chatgpt', accountId: 'account-a' })
    const dispatches = []
    broker = await startManagedBroker(fixture.homeDir, (execution) => new Promise((resolve, reject) => {
      const dispatch = { ...dispatchSummary(execution), aborted: false }
      dispatches.push(dispatch)
      const onAbort = () => {
        dispatch.aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }
      execution.signal.addEventListener('abort', onAbort, { once: true })
      if (execution.request.input === 'complete') resolve('completed')
    }), { shutdownGraceMs: 30 })

    const disconnected = openManagedRequest(broker, 'Abort-A', { input: 'disconnect' })
    await waitFor(() => dispatches.length === 1)
    disconnected.destroy()
    await waitFor(() => dispatches[0].aborted)

    const completed = await managedRequest(broker, 'Abort-A', { input: 'complete' })
    assert.equal(completed.status, 200)
    assert.deepEqual(dispatches.map(({ accountId }) => accountId), ['account-a', 'account-a'])

    const hanging = openManagedRequest(broker, 'Abort-A', { input: 'shutdown' })
    await waitFor(() => dispatches.length === 3)
    const closed = broker.close()
    await closed
    await waitFor(() => dispatches[2].aborted)
    hanging.destroy()
    broker = undefined
  } finally {
    await broker?.close()
    await fixture.close()
  }
})

async function createPoolFixture() {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-project-broker-')))
  if (process.platform !== 'win32') await fs.chmod(homeDir, 0o700)
  const store = new AccountPoolStore({
    homeDir,
    serialize: createSqliteAccountPoolSerialization({ homeDir, timeoutMs: 2_000 }),
  })
  return {
    homeDir,
    store,
    close: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

async function addReadyCodexAccount(store, accountId, fingerprintCharacter) {
  const pending = await store.addCodexAccount({ accountId })
  return store.finalizeCodexIdentity({
    provider: 'chatgpt',
    accountId,
    expectedInternalId: pending.internalId,
    identityFingerprint: `tokenless.codex-identity.v1:${fingerprintCharacter.repeat(43)}`,
  })
}

function startManagedBroker(homeDir, executor, options = {}) {
  const { shutdownGraceMs, ...managedProjectOptions } = options
  return startDirectBroker({
    serverKey: SERVER_KEY,
    port: 0,
    ...(shutdownGraceMs === undefined ? {} : { shutdownGraceMs }),
    managedProject: {
      homeDir,
      executor,
      ...managedProjectOptions,
    },
  })
}

function managedRequest(broker, projectId, payload, headers = {}) {
  return brokerRequest(broker, '/v1/responses', {
    method: 'POST',
    headers: { ...managedHeaders(projectId), ...headers },
    body: Buffer.from(JSON.stringify(payload)),
  })
}

function managedHeaders(projectId) {
  return {
    authorization: AUTHORIZATION,
    'content-type': 'application/json',
    'x-tokenless-project': projectId,
  }
}

function brokerRequest(broker, pathname, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(new URL(pathname, broker.url), { method, headers }, (incoming) => {
      const chunks = []
      incoming.on('data', (chunk) => chunks.push(chunk))
      incoming.once('end', () => {
        const bodyBytes = Buffer.concat(chunks)
        resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          body: bodyBytes.toString('utf8'),
          bodyBytes,
        })
      })
      incoming.once('aborted', reject)
      incoming.once('error', reject)
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

function openManagedRequest(broker, projectId, payload) {
  const outgoing = http.request(new URL('/v1/responses', broker.url), {
    method: 'POST',
    headers: managedHeaders(projectId),
  })
  outgoing.on('error', () => undefined)
  outgoing.end(JSON.stringify(payload))
  return outgoing
}

function expectContinueManagedRequest(broker, projectId, body) {
  let continued = false
  let bodySent = false
  let outgoing
  const response = new Promise((resolve, reject) => {
    outgoing = http.request(new URL('/v1/responses', broker.url), {
      method: 'POST',
      headers: {
        ...managedHeaders(projectId),
        expect: '100-continue',
        'content-length': String(body.byteLength),
      },
    }, (incoming) => {
      const chunks = []
      incoming.on('data', (chunk) => chunks.push(chunk))
      incoming.once('end', () => {
        const bodyBytes = Buffer.concat(chunks)
        resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          body: bodyBytes.toString('utf8'),
          bodyBytes,
        })
        if (!bodySent) outgoing.destroy()
      })
      incoming.once('aborted', reject)
      incoming.once('error', reject)
    })
    outgoing.once('continue', () => {
      continued = true
      bodySent = true
      outgoing.end(body)
    })
    outgoing.once('error', (error) => {
      if (!bodySent && error.code === 'ECONNRESET') return
      reject(error)
    })
    outgoing.flushHeaders()
  })
  return {
    response,
    get continued() {
      return continued
    },
  }
}

function responseText(response) {
  return JSON.parse(response.body).output[0].content[0].text
}

function parseSse(body) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6)))
}

function dispatchSummary(execution) {
  return {
    projectId: execution.projectId,
    accountId: execution.initialAccount.accountId,
    internalId: execution.initialAccount.internalId,
  }
}

function socketAuthority(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

function rawHttpRequest(host, port, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const chunks = []
    socket.once('connect', () => socket.end(raw))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')))
    socket.once('error', reject)
  })
}

async function startHttpServer(handler) {
  const server = http.createServer((incoming, outgoing) => {
    Promise.resolve(handler(incoming, outgoing)).catch(() => outgoing.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function readBodyBytes(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function withChatGptEnvironment(values, operation) {
  const names = [
    'TOKENLESS_DIRECT_BASE_URL',
    'TOKENLESS_DIRECT_API_KEY',
    'TOKENLESS_DIRECT_CHATGPT_BASE_URL',
    'TOKENLESS_DIRECT_CHATGPT_API_KEY',
  ]
  const saved = new Map(names.map((name) => [name, process.env[name]]))
  try {
    for (const name of names) delete process.env[name]
    for (const [name, value] of Object.entries(values)) process.env[name] = value
    return await operation()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(5)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
