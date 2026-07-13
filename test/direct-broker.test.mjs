import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const directModuleRoot = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL('../packages/cli/dist/src/direct/', import.meta.url)
const {
  DIRECT_BROKER_CAPABILITIES_PATH,
  DIRECT_BROKER_HEALTH_PATH,
  startDirectBroker,
} = await import(new URL('broker.js', directModuleRoot))

const DIRECT_ENVIRONMENT_NAMES = [
  'TOKENLESS_DIRECT_BASE_URL',
  'TOKENLESS_DIRECT_API_KEY',
  'TOKENLESS_DIRECT_TIMEOUT_MS',
  'TOKENLESS_DIRECT_CHATGPT_BASE_URL',
  'TOKENLESS_DIRECT_CHATGPT_API_KEY',
  'TOKENLESS_DIRECT_CLAUDE_BASE_URL',
  'TOKENLESS_DIRECT_CLAUDE_API_KEY',
  'TOKENLESS_DIRECT_GEMINI_BASE_URL',
  'TOKENLESS_DIRECT_GEMINI_API_KEY',
  'TOKENLESS_DIRECT_GROK_BASE_URL',
  'TOKENLESS_DIRECT_GROK_API_KEY',
  'TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL',
  'TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY',
]

test('direct broker requires exact Bearer authentication and exposes authenticated metadata', async () => {
  await assert.rejects(
    startDirectBroker({ serverKey: '', port: 0 }),
    (error) => error.code === 'direct_configuration_error',
  )
  await assert.rejects(
    startDirectBroker({ serverKey: 'too-short', port: 0 }),
    (error) => error.code === 'direct_configuration_error' && /32/.test(error.message),
  )
  await assert.rejects(
    startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', host: '0.0.0.0', port: 0 }),
    (error) => error.code === 'direct_configuration_error',
  )
  await assert.rejects(
    startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', host: 42, port: 0 }),
    (error) => error.code === 'direct_configuration_error',
  )
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(
    startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0, signal: alreadyAborted.signal }),
    (error) => error.code === 'direct_configuration_error' && /already-aborted/.test(error.message),
  )

  const broker = await startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0 })
  try {
    for (const authorization of [undefined, 'tokenless-local-test-key-32-characters', 'bearer tokenless-local-test-key-32-characters', 'Bearer wrong']) {
      const response = await request(broker.url, DIRECT_BROKER_HEALTH_PATH, {
        ...(authorization === undefined ? {} : { authorization }),
      })
      assert.equal(response.status, 401)
      assert.equal(response.headers['www-authenticate'], 'Bearer')
    }

    const health = await request(broker.url, DIRECT_BROKER_HEALTH_PATH, {
      authorization: 'Bearer tokenless-local-test-key-32-characters',
    })
    assert.equal(health.status, 200)
    assert.deepEqual(JSON.parse(health.body), {
      protocol: 'tokenless.direct-broker.v1',
      status: 'ok',
    })

    const capabilities = await request(broker.url, DIRECT_BROKER_CAPABILITIES_PATH, {
      authorization: 'Bearer tokenless-local-test-key-32-characters',
    })
    assert.equal(capabilities.status, 200)
    assert.equal(JSON.parse(capabilities.body).officialClient, false)
    assert.equal(JSON.parse(capabilities.body).streaming, true)
    assert.equal((await request(
      broker.url,
      DIRECT_BROKER_HEALTH_PATH,
      { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-length': '2', 'content-type': 'application/json' },
      '{}',
      'GET',
    )).status, 400)
  } finally {
    await broker.close()
    await broker.close()
  }
})

test('direct broker streams bytes and replaces inbound credentials with the selected outbound credential', async () => {
  let observed
  let releaseSecondChunk
  const secondChunkGate = new Promise((resolve) => {
    releaseSecondChunk = resolve
  })
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    observed = {
      method: incoming.method,
      url: incoming.url,
      headers: incoming.headers,
      body: await readBody(incoming),
    }
    outgoing.writeHead(200, {
      connection: 'close',
      'content-type': 'text/event-stream',
      'set-cookie': 'provider-session=secret',
      'x-api-key': 'must-not-return',
      'x-provider-private': 'drop-me',
      'x-ratelimit-remaining': '7',
      'x-request-id': 'req_stream',
    })
    outgoing.write('data: first\n\n')
    await secondChunkGate
    outgoing.end('data: second\n\n')
  })

  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: `${upstream.url}/gateway/v1`,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-openai-key',
  }, async () => {
    const broker = await startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0 })
    try {
      const stream = streamingRequest(broker.url, '/v1/responses', {
        authorization: 'Bearer tokenless-local-test-key-32-characters',
        cookie: 'local-session=do-not-forward',
        'content-type': 'application/json',
        'idempotency-key': 'idem-1',
        'proxy-authorization': 'Basic do-not-forward',
        'x-api-key': 'inbound-key',
        'x-auth-token': 'unknown-secret',
        'x-custom-safe': 'forward-me',
        'x-goog-api-key': 'inbound-google-key',
        'x-tokenless-provider': 'chatgpt-must-not-be-forwarded',
      }, '{"stream":true}')

      // The unsupported selector fails before upstream contact.
      const rejected = await stream.response
      assert.equal(rejected.status, 400)
      assert.equal(observed, undefined)

      const accepted = streamingRequest(broker.url, '/v1/responses', {
        'accept-encoding': 'gzip',
        authorization: 'Bearer tokenless-local-test-key-32-characters',
        cookie: 'local-session=do-not-forward',
        'content-type': 'application/json',
        'idempotency-key': 'idem-1',
        'openai-organization': 'org-must-not-forward',
        'openai-project': 'project-must-not-forward',
        'proxy-authorization': 'Basic do-not-forward',
        'x-api-key': 'inbound-key',
        'x-auth-token': 'unknown-secret',
        'x-custom-safe': 'forward-me',
        'x-goog-api-key': 'inbound-google-key',
      }, '{"stream":true}')
      const firstChunk = await accepted.firstChunk
      assert.equal(firstChunk, 'data: first\n\n')
      assert.equal(accepted.finished, false)
      releaseSecondChunk()
      const response = await accepted.response

      assert.equal(response.status, 200)
      assert.equal(response.body, 'data: first\n\ndata: second\n\n')
      assert.equal(response.headers['content-type'], 'text/event-stream')
      assert.equal(response.headers['x-request-id'], 'req_stream')
      assert.equal(response.headers['x-ratelimit-remaining'], '7')
      assert.equal(response.headers['set-cookie'], undefined)
      assert.equal(response.headers['x-api-key'], undefined)
      assert.equal(response.headers['x-provider-private'], undefined)

      assert.equal(observed.method, 'POST')
      assert.equal(observed.url, '/gateway/v1/responses')
      assert.equal(observed.headers.authorization, 'Bearer outbound-openai-key')
      assert.equal(observed.headers['accept-encoding'], 'identity')
      assert.equal(observed.headers.cookie, undefined)
      assert.equal(observed.headers['proxy-authorization'], undefined)
      assert.equal(observed.headers['x-api-key'], undefined)
      assert.equal(observed.headers['x-auth-token'], undefined)
      assert.equal(observed.headers['x-goog-api-key'], undefined)
      assert.equal(observed.headers['x-tokenless-provider'], undefined)
      assert.equal(observed.headers['x-custom-safe'], undefined)
      assert.equal(observed.headers['idempotency-key'], 'idem-1')
      assert.equal(observed.headers['openai-organization'], undefined)
      assert.equal(observed.headers['openai-project'], undefined)
      assert.equal(observed.body, '{"stream":true}')
    } finally {
      await broker.close()
    }
  })
  await upstream.close()
})

test('direct broker preserves binary response bytes exactly', async () => {
  const binary = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a, 0x00, 0x7f])
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    await readBody(incoming)
    outgoing.writeHead(200, {
      'content-disposition': 'attachment; filename="result.bin"',
      'content-type': 'application/octet-stream',
    })
    outgoing.end(binary)
  })
  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-key',
  }, async () => {
    const broker = await startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0 })
    try {
      const response = await request(
        broker.url,
        '/v1/images/generations',
        { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-type': 'application/json' },
        '{}',
      )
      assert.equal(response.status, 200)
      assert.equal(response.headers['content-type'], 'application/octet-stream')
      assert.equal(response.headers['content-disposition'], 'attachment; filename="result.bin"')
      assert.deepEqual(response.bodyBytes, binary)
    } finally {
      await broker.close()
    }
  })
  await upstream.close()
})

test('direct broker rejects redirects, times out, and reports upstream disconnects without retrying', async () => {
  let routeRequests = 0
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    routeRequests += 1
    await readBody(incoming)
    if (incoming.url === '/redirect/v1/responses') {
      outgoing.writeHead(307, { location: '/redirect-target' }).end()
      return
    }
    if (incoming.url === '/timeout/v1/responses') return
    if (incoming.url === '/upgrade/v1/responses') {
      outgoing.writeHead(101, { connection: 'upgrade', upgrade: 'tokenless-test' })
      outgoing.flushHeaders()
      return
    }
    incoming.socket.destroy()
  })

  for (const [prefix, expectedStatus, expectedCode] of [
    ['redirect', 502, 'direct_upstream_error'],
    ['timeout', 504, 'direct_timeout'],
    ['upgrade', 502, 'direct_upstream_error'],
    ['disconnect', 502, 'direct_upstream_error'],
  ]) {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: `${upstream.url}/${prefix}`,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-key',
      TOKENLESS_DIRECT_TIMEOUT_MS: '30',
    }, async () => {
      const broker = await startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0 })
      try {
        const response = await request(
          broker.url,
          '/v1/responses',
          { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-type': 'application/json' },
          '{}',
        )
        assert.equal(response.status, expectedStatus, prefix)
        assert.equal(JSON.parse(response.body).error.code, expectedCode, prefix)
      } finally {
        await broker.close()
      }
    })
  }
  assert.equal(routeRequests, 4)
  await upstream.close()
})

test('direct broker enforces HTTPS certificate verification despite ambient Node overrides', async () => {
  let upstreamRequests = 0
  const upstream = await startSelfSignedHttpsServer((_incoming, outgoing) => {
    upstreamRequests += 1
    outgoing.end('{}')
  })
  const savedTlsOverride = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-key',
    }, async () => {
      const broker = await startDirectBroker({
        serverKey: 'tokenless-local-test-key-32-characters',
        port: 0,
      })
      try {
        const response = await request(
          broker.url,
          '/v1/responses',
          {
            authorization: 'Bearer tokenless-local-test-key-32-characters',
            'content-type': 'application/json',
          },
          '{}',
        )
        assert.equal(response.status, 502)
        assert.equal(JSON.parse(response.body).error.code, 'direct_upstream_error')
        assert.equal(upstreamRequests, 0)
      } finally {
        await broker.close()
      }
    })
  } finally {
    if (savedTlsOverride === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsOverride
    await upstream.close()
  }
})

test('direct broker routes all provider protocols and injects only their environment credential', async () => {
  const observed = []
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    observed.push({
      url: incoming.url,
      authorization: incoming.headers.authorization,
      xApiKey: incoming.headers['x-api-key'],
      xGoogApiKey: incoming.headers['x-goog-api-key'],
      anthropicVersion: incoming.headers['anthropic-version'],
    })
    await readBody(incoming)
    outgoing.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_provider' })
    outgoing.end('{}')
  })

  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: `${upstream.url}/openai`,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'chatgpt-key',
    TOKENLESS_DIRECT_CLAUDE_BASE_URL: `${upstream.url}/anthropic/v1`,
    TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-key',
    TOKENLESS_DIRECT_GEMINI_BASE_URL: `${upstream.url}/google/v1beta`,
    TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-key',
    TOKENLESS_DIRECT_GROK_BASE_URL: `${upstream.url}/xai/v1`,
    TOKENLESS_DIRECT_GROK_API_KEY: 'grok-key',
    TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: `${upstream.url}/gateway/antigravity/v1`,
    TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-key',
  }, async () => {
    const broker = await startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0 })
    const auth = { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-type': 'application/json' }
    try {
      assert.equal((await request(broker.url, '/v1/responses', auth, '{}')).status, 200)
      assert.equal((await request(broker.url, '/v1/responses/compact', auth, '{}')).status, 200)
      assert.equal((await request(broker.url, '/v1/models', {
        authorization: 'Bearer tokenless-local-test-key-32-characters',
      })).status, 200)
      assert.equal((await request(broker.url, '/v1/models', {
        authorization: 'Bearer tokenless-local-test-key-32-characters',
        'x-tokenless-provider': 'claude',
      })).status, 200)
      assert.equal((await request(broker.url, '/v1/responses', {
        ...auth,
        'x-tokenless-provider': 'grok',
      }, '{}')).status, 200)
      assert.equal((await request(broker.url, '/v1/videos/generations', {
        ...auth,
        'x-tokenless-provider': 'grok',
      }, '{}')).status, 200)
      assert.equal((await request(broker.url, '/v1/messages', auth, '{}')).status, 200)
      assert.equal((await request(broker.url, '/v1beta/models/gemini-test:generateContent?alt=sse', auth, '{}')).status, 200)
      assert.equal((await request(broker.url, '/antigravity/v1/messages', auth, '{}')).status, 200)
      assert.equal((await request(
        broker.url,
        '/antigravity/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
        auth,
        '{}',
      )).status, 200)

      const mismatched = await request(broker.url, '/v1/messages', {
        ...auth,
        'x-tokenless-provider': 'grok',
      }, '{}')
      assert.equal(mismatched.status, 400)
      const unsupportedGrokRoute = await request(broker.url, '/v1/embeddings', {
        ...auth,
        'x-tokenless-provider': 'grok',
      }, '{}')
      assert.equal(unsupportedGrokRoute.status, 400)
      assert.equal((await request(broker.url, '/v1/videos/generations', auth, '{}')).status, 400)
      assert.equal((await request(broker.url, '/v1/responses/compact', {
        ...auth,
        'x-tokenless-provider': 'grok',
      }, '{}')).status, 400)
      assert.equal((await request(broker.url, '/v1/responses', {
        ...auth,
        'x-tokenless-provider': 'claude',
      }, '{}')).status, 400)
      assert.equal((await request(broker.url, '/v1/models', {
        authorization: 'Bearer tokenless-local-test-key-32-characters',
        'x-tokenless-provider': 'Grok',
      })).status, 400)
      assert.equal((await request(
        broker.url,
        '/v1/models',
        { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-length': '2', 'content-type': 'application/json' },
        '{}',
        'GET',
      )).status, 400)
    } finally {
      await broker.close()
    }
  })

  assert.deepEqual(observed, [
    {
      url: '/openai/v1/responses',
      authorization: 'Bearer chatgpt-key',
      xApiKey: undefined,
      xGoogApiKey: undefined,
      anthropicVersion: undefined,
    },
    {
      url: '/openai/v1/responses/compact',
      authorization: 'Bearer chatgpt-key',
      xApiKey: undefined,
      xGoogApiKey: undefined,
      anthropicVersion: undefined,
    },
    {
      url: '/openai/v1/models',
      authorization: 'Bearer chatgpt-key',
      xApiKey: undefined,
      xGoogApiKey: undefined,
      anthropicVersion: undefined,
    },
    {
      url: '/anthropic/v1/models',
      authorization: undefined,
      xApiKey: 'claude-key',
      xGoogApiKey: undefined,
      anthropicVersion: '2023-06-01',
    },
    {
      url: '/xai/v1/responses',
      authorization: 'Bearer grok-key',
      xApiKey: undefined,
      xGoogApiKey: undefined,
      anthropicVersion: undefined,
    },
    {
      url: '/xai/v1/videos/generations',
      authorization: 'Bearer grok-key',
      xApiKey: undefined,
      xGoogApiKey: undefined,
      anthropicVersion: undefined,
    },
    {
      url: '/anthropic/v1/messages',
      authorization: undefined,
      xApiKey: 'claude-key',
      xGoogApiKey: undefined,
      anthropicVersion: '2023-06-01',
    },
    {
      url: '/google/v1beta/models/gemini-test:generateContent?alt=sse',
      authorization: undefined,
      xApiKey: undefined,
      xGoogApiKey: 'gemini-key',
      anthropicVersion: undefined,
    },
    {
      url: '/gateway/antigravity/v1/messages',
      authorization: undefined,
      xApiKey: 'antigravity-key',
      xGoogApiKey: undefined,
      anthropicVersion: '2023-06-01',
    },
    {
      url: '/gateway/antigravity/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
      authorization: undefined,
      xApiKey: 'antigravity-key',
      xGoogApiKey: undefined,
      anthropicVersion: undefined,
    },
  ])
  await upstream.close()
})

test('direct broker never reuses a generic API key across provider trust boundaries', async () => {
  let upstreamRequests = 0
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    upstreamRequests += 1
    await readBody(incoming)
    outgoing.end('{}')
  })
  await withDirectEnvironment({
    TOKENLESS_DIRECT_API_KEY: 'generic-must-not-leave',
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: `${upstream.url}/openai`,
    TOKENLESS_DIRECT_CLAUDE_BASE_URL: `${upstream.url}/anthropic`,
    TOKENLESS_DIRECT_GEMINI_BASE_URL: `${upstream.url}/google`,
    TOKENLESS_DIRECT_GROK_BASE_URL: `${upstream.url}/xai`,
    TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: `${upstream.url}/antigravity`,
  }, async () => {
    const broker = await startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0 })
    const authorization = { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-type': 'application/json' }
    try {
      for (const [pathname, headers] of [
        ['/v1/responses', authorization],
        ['/v1/messages', authorization],
        ['/v1beta/models/gemini-test:generateContent', authorization],
        ['/v1/responses', { ...authorization, 'x-tokenless-provider': 'grok' }],
        ['/antigravity/v1/messages', authorization],
      ]) {
        const response = await request(broker.url, pathname, headers, '{}')
        assert.equal(response.status, 400, pathname)
        assert.equal(JSON.parse(response.body).error.code, 'direct_configuration_error')
      }
      assert.equal(upstreamRequests, 0)
    } finally {
      await broker.close()
    }
  })
  await upstream.close()
})

test('direct broker fails closed on private, ambiguous, credential-bearing, and unlisted routes', async () => {
  let upstreamRequests = 0
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    upstreamRequests += 1
    await readBody(incoming)
    outgoing.end('{}')
  })
  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-key',
  }, async () => {
    const broker = await startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0 })
    const headers = { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-type': 'application/json' }
    try {
      for (const pathname of [
        '/backend-api/codex/responses',
        '/admin/users',
        '/v1/responses/arbitrary-subpath',
        '/v1/images/batches',
        '/v1/usage',
        '/antigravity/models',
        '/antigravity/v1/usage',
        '/v1beta/models/gemini-test:countTokens',
        '/v1beta/models/gemini-test:deleteEverything',
        '/antigravity/v1beta/models/gemini-test:embedContent',
      ]) {
        assert.equal((await request(broker.url, pathname, headers, '{}')).status, 404, pathname)
      }
      assert.equal((await request(broker.url, '/v1/responses?api_key=tokenless-local-test-key-32-characters', headers, '{}')).status, 400)
      assert.equal((await request(broker.url, '/v1/responses?access%5Ftoken=value', headers, '{}')).status, 400)
      assert.equal((await request(broker.url, '/v1/responses?%256bey=value', headers, '{}')).status, 400)
      assert.equal((await request(broker.url, '/v1/responses%2Fadmin', headers, '{}')).status, 400)
      assert.equal((await request(broker.url, '/v1/responses%252Fadmin', headers, '{}')).status, 400)
      assert.equal((await request(broker.url, '/v1/models/gpt..escape', headers, undefined, 'GET')).status, 400)
      assert.equal((await request(broker.url, '/v1/responses', headers, undefined, 'GET')).status, 405)
      for (const rawPath of ['/v1/../admin', '/v1/%2e%2e/admin', '/v1\\messages']) {
        const rawResponse = await rawHttpRequest(
          broker.host,
          broker.port,
          `POST ${rawPath} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer tokenless-local-test-key-32-characters\r\nContent-Length: 0\r\n\r\n`,
        )
        assert.match(rawResponse, /^HTTP\/1\.1 400 /, rawPath)
      }
      assert.equal(upstreamRequests, 0)
    } finally {
      await broker.close()
    }
  })
  await upstream.close()
})

test('direct broker enforces declared and chunked body limits before completing upstream delivery', async () => {
  let upstreamRequests = 0
  let completeBodies = 0
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    upstreamRequests += 1
    incoming.once('end', () => {
      completeBodies += 1
      outgoing.end('{}')
    })
    incoming.resume()
  })
  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-key',
  }, async () => {
    const broker = await startDirectBroker({
      serverKey: 'tokenless-local-test-key-32-characters',
      port: 0,
      maxRequestBytes: 16,
    })
    try {
      const declared = await request(
        broker.url,
        '/v1/responses',
        { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-type': 'application/octet-stream' },
        'x'.repeat(17),
      )
      assert.equal(declared.status, 413)
      assert.equal(upstreamRequests, 0)

      const chunked = await chunkedRequest(broker.url, '/v1/responses', {
        authorization: 'Bearer tokenless-local-test-key-32-characters',
        'content-type': 'application/octet-stream',
      }, ['x'.repeat(10), 'y'.repeat(10)])
      assert.equal(chunked.status, 413)
      assert.ok(upstreamRequests <= 1)
      assert.equal(completeBodies, 0)

      const unauthenticatedPipeline = await rawHttpRequest(
        broker.host,
        broker.port,
        [
          'POST /v1/responses HTTP/1.1',
          'Host: localhost',
          'Transfer-Encoding: chunked',
          'Connection: keep-alive',
          '',
          '64',
          'x'.repeat(100),
          '0',
          '',
          'GET /health HTTP/1.1',
          'Host: localhost',
          'Authorization: Bearer tokenless-local-test-key-32-characters',
          '',
          '',
        ].join('\r\n'),
      )
      assert.match(unauthenticatedPipeline, /^HTTP\/1\.1 401 /)
      assert.equal((unauthenticatedPipeline.match(/HTTP\/1\.1 /g) ?? []).length, 1)
    } finally {
      await broker.close()
    }
  })
  await upstream.close()
})

test('direct broker closes an unfinished upload when the upstream responds early', async () => {
  let upstreamRequests = 0
  const upstream = await startHttpServer((_incoming, outgoing) => {
    upstreamRequests += 1
    outgoing.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-key',
  }, async () => {
    const broker = await startDirectBroker({ serverKey: 'tokenless-local-test-key-32-characters', port: 0, maxRequestBytes: 16 })
    try {
      const raw = await earlyResponseUpload(broker.host, broker.port)
      assert.match(raw, /^HTTP\/1\.1 200 /)
      assert.equal((raw.match(/HTTP\/1\.1 /g) ?? []).length, 1)
      assert.equal(upstreamRequests, 1)
      assert.equal((await request(broker.url, '/health', {
        authorization: 'Bearer tokenless-local-test-key-32-characters',
      })).status, 200)
    } finally {
      await broker.close()
    }
  })
  await upstream.close()
})

test('direct broker applies a real parser header limit', async () => {
  const controller = new AbortController()
  const broker = await startDirectBroker({
    serverKey: 'tokenless-local-test-key-32-characters',
    port: 0,
    signal: controller.signal,
    maxHeaderBytes: 1_024,
  })
  const oversized = await rawHttpRequest(
    broker.host,
    broker.port,
    `GET /health HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer tokenless-local-test-key-32-characters\r\nX-Large: ${'x'.repeat(2_000)}\r\n\r\n`,
  )
  assert.match(oversized, /^HTTP\/1\.1 431 /)

  await broker.close()
  await broker.close()
})

test('direct broker AbortSignal shutdown lets an active stream finish within its grace period', async () => {
  let releaseStream
  const streamGate = new Promise((resolve) => {
    releaseStream = resolve
  })
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    await readBody(incoming)
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.write('data: first\n\n')
    await streamGate
    outgoing.end('data: final\n\n')
  })
  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-key',
  }, async () => {
    const controller = new AbortController()
    const broker = await startDirectBroker({
      serverKey: 'tokenless-local-test-key-32-characters',
      port: 0,
      signal: controller.signal,
      shutdownGraceMs: 2_000,
    })
    const stream = streamingRequest(
      broker.url,
      '/v1/responses',
      { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-type': 'application/json' },
      '{}',
    )
    assert.equal(await stream.firstChunk, 'data: first\n\n')
    controller.abort()
    const closed = broker.close()
    releaseStream()
    assert.equal((await stream.response).body, 'data: first\n\ndata: final\n\n')
    await closed
    await broker.close()
  })
  await upstream.close()
})

test('direct broker force-closes an active stream when shutdown grace expires', async () => {
  let releaseStream
  const streamGate = new Promise((resolve) => {
    releaseStream = resolve
  })
  const upstream = await startHttpServer(async (incoming, outgoing) => {
    await readBody(incoming)
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.write('data: first\n\n')
    await streamGate
    outgoing.end('data: too-late\n\n')
  })
  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'outbound-key',
  }, async () => {
    const controller = new AbortController()
    const broker = await startDirectBroker({
      serverKey: 'tokenless-local-test-key-32-characters',
      port: 0,
      signal: controller.signal,
      shutdownGraceMs: 25,
    })
    const stream = streamingRequest(
      broker.url,
      '/v1/responses',
      { authorization: 'Bearer tokenless-local-test-key-32-characters', 'content-type': 'application/json' },
      '{}',
    )
    assert.equal(await stream.firstChunk, 'data: first\n\n')
    const startedAt = Date.now()
    controller.abort()
    await assert.rejects(stream.response)
    await broker.close()
    assert.ok(Date.now() - startedAt < 1_000)
    releaseStream()
  })
  await upstream.close()
})

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

async function startSelfSignedHttpsServer(handler) {
  const { generate } = await import('selfsigned')
  const certificate = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
    algorithm: 'sha256',
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ],
  })
  const server = https.createServer({ key: certificate.private, cert: certificate.cert }, (incoming, outgoing) => {
    Promise.resolve(handler(incoming, outgoing)).catch(() => outgoing.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `https://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function request(baseUrl, pathname, headers = {}, body, method = body === undefined ? 'GET' : 'POST') {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, baseUrl)
    const outgoing = http.request(target, { method, headers }, (incoming) => {
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
    if (body !== undefined) outgoing.end(body)
    else outgoing.end()
  })
}

function streamingRequest(baseUrl, pathname, headers, body) {
  let finished = false
  let resolveFirstChunk
  const firstChunk = new Promise((resolve) => {
    resolveFirstChunk = resolve
  })
  const response = new Promise((resolve, reject) => {
    const outgoing = http.request(new URL(pathname, baseUrl), { method: 'POST', headers }, (incoming) => {
      const chunks = []
      incoming.on('data', (chunk) => {
        chunks.push(chunk)
        if (chunks.length === 1) resolveFirstChunk(chunk.toString('utf8'))
      })
      incoming.once('end', () => {
        finished = true
        resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      incoming.once('aborted', reject)
      incoming.once('error', reject)
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
  return {
    response,
    firstChunk,
    get finished() {
      return finished
    },
  }
}

function chunkedRequest(baseUrl, pathname, headers, chunks) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(new URL(pathname, baseUrl), { method: 'POST', headers }, (incoming) => {
      const responseChunks = []
      incoming.on('data', (chunk) => responseChunks.push(chunk))
      incoming.once('end', () => resolve({
        status: incoming.statusCode,
        body: Buffer.concat(responseChunks).toString('utf8'),
      }))
    })
    outgoing.once('error', reject)
    for (const chunk of chunks) outgoing.write(chunk)
    outgoing.end()
  })
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

function earlyResponseUpload(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const chunks = []
    let sentRemainder = false
    socket.once('connect', () => {
      socket.write([
        'POST /v1/responses HTTP/1.1',
        'Host: localhost',
        'Authorization: Bearer tokenless-local-test-key-32-characters',
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: keep-alive',
        '',
        '1',
        'x',
        '',
      ].join('\r\n'))
    })
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      if (sentRemainder) return
      sentRemainder = true
      socket.end([
        '64',
        'y'.repeat(100),
        '0',
        '',
        'GET /health HTTP/1.1',
        'Host: localhost',
        'Authorization: Bearer tokenless-local-test-key-32-characters',
        '',
        '',
      ].join('\r\n'))
    })
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')))
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('latin1')))
    socket.once('error', (error) => {
      if (chunks.length > 0) resolve(Buffer.concat(chunks).toString('latin1'))
      else reject(error)
    })
  })
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function withDirectEnvironment(values, operation) {
  const saved = new Map(DIRECT_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]))
  try {
    for (const name of DIRECT_ENVIRONMENT_NAMES) delete process.env[name]
    for (const [name, value] of Object.entries(values)) process.env[name] = value
    return await operation()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
