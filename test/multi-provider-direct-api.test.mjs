import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const cliModuleUrl = process.env.TOKENLESS_DIRECT_TEST_CLI_MODULE
  ? pathToFileURL(path.resolve(process.env.TOKENLESS_DIRECT_TEST_CLI_MODULE))
  : new URL('../packages/cli/dist/src/index.js', import.meta.url)
const { executeDirectRun } = await import(cliModuleUrl)

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
  // Provider SDK variables are deliberately not Tokenless credential inputs.
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'ANTIGRAVITY_API_KEY',
]

test('Claude Messages uses the exact public route, headers, body, and normalized result', async () => {
  let observed
  await withHttpServer(async (request, response) => {
    observed = await observeJsonRequest(request)
    response.writeHead(200, {
      'content-type': 'application/json',
      'request-id': 'req_claude_socket',
    })
    response.end(JSON.stringify({
      id: 'msg_claude_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'thinking', thinking: 'This must remain raw, not user-visible.' },
        { type: 'text', text: 'Claude first' },
        { type: 'tool_use', id: 'toolu_1', name: 'ignored', input: {} },
        { type: 'text', text: 'Claude second' },
      ],
      usage: {
        input_tokens: 8,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        output_tokens: 5,
      },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_BASE_URL: 'https://generic-must-not-win.example.test',
      TOKENLESS_DIRECT_API_KEY: 'generic-must-not-win',
      TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-socket-secret',
    }, async () => {
      const result = await executeDirectRun({
        provider: 'claude',
        model: ' claude-test ',
        prompt: 'Keep Claude prompt exact. ',
        temperature: 0.4,
      }, {
        // Runtime options are not a credential channel.
        apiKey: 'argument-must-not-win',
      })

      assert.deepEqual(observed, {
        method: 'POST',
        url: '/v1/messages',
        authorization: undefined,
        xApiKey: 'claude-socket-secret',
        anthropicVersion: '2023-06-01',
        xGoogApiKey: undefined,
        contentType: 'application/json',
        cookie: undefined,
        body: {
          model: 'claude-test',
          max_tokens: 4096,
          messages: [{ role: 'user', content: 'Keep Claude prompt exact. ' }],
          stream: false,
          temperature: 0.4,
        },
      })
      assertDirectResult(result, {
        capability: 'anthropic.messages',
        provider: 'claude',
        model: 'claude-test',
        text: 'Claude first\nClaude second',
        usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
        requestId: 'req_claude_socket',
      })
      assert.equal(result.raw.id, 'msg_claude_123')
      assert.equal(result.raw.content[0].thinking, 'This must remain raw, not user-visible.')
    })
  })
})

test('Gemini generateContent uses an encoded model route, native body, and first-candidate text', async () => {
  let observed
  await withHttpServer(async (request, response) => {
    observed = await observeJsonRequest(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      responseId: 'req_gemini_body',
      modelVersion: 'gemini-2.5-pro-test',
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: 'Gemini first' },
              { text: 'Hidden Gemini thought', thought: true },
              { inlineData: { mimeType: 'text/plain', data: 'aWdub3JlZA==' } },
              { text: 'Gemini second' },
            ],
          },
        },
        { index: 1, content: { role: 'model', parts: [{ text: 'Do not select this candidate' }] } },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 1,
        totalTokenCount: 17,
      },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-socket-secret',
    }, async () => {
      const result = await executeDirectRun({
        provider: 'gemini',
        backend: 'api',
        model: ' gemini-2.5-pro-test ',
        prompt: 'Keep Gemini prompt exact. ',
        maxOutputTokens: 55,
        temperature: 0.2,
      })

      assert.deepEqual(observed, {
        method: 'POST',
        url: '/v1beta/models/gemini-2.5-pro-test:generateContent',
        authorization: undefined,
        xApiKey: undefined,
        anthropicVersion: undefined,
        xGoogApiKey: 'gemini-socket-secret',
        contentType: 'application/json',
        cookie: undefined,
        body: {
          contents: [{ role: 'user', parts: [{ text: 'Keep Gemini prompt exact. ' }] }],
          store: false,
          generationConfig: { maxOutputTokens: 55, temperature: 0.2 },
        },
      })
      assertDirectResult(result, {
        capability: 'google.generateContent',
        provider: 'gemini',
        model: 'gemini-2.5-pro-test',
        text: 'Gemini first\nGemini second',
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
        requestId: 'req_gemini_body',
      })
      assert.equal(result.raw.modelVersion, 'gemini-2.5-pro-test')
      assert.equal(result.raw.candidates.length, 2)
    })
  })
})

test('Grok uses the public Responses contract without duplicating a /v1 base path', async () => {
  let observed
  await withHttpServer(async (request, response) => {
    observed = await observeJsonRequest(request)
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'req_grok_socket',
    })
    response.end(JSON.stringify({
      id: 'resp_grok_123',
      output: [{
        type: 'message',
        content: [
          { type: 'reasoning', text: 'not visible' },
          { type: 'output_text', text: 'Grok answer' },
        ],
      }],
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_GROK_BASE_URL: `${baseUrl}/v1`,
      TOKENLESS_DIRECT_GROK_API_KEY: 'grok-socket-secret',
    }, async () => {
      const result = await executeDirectRun({
        provider: 'grok',
        model: 'grok-test',
        prompt: 'Keep Grok prompt exact. ',
        maxOutputTokens: 33,
        temperature: 0.1,
      })

      assert.deepEqual(observed, {
        method: 'POST',
        url: '/v1/responses',
        authorization: 'Bearer grok-socket-secret',
        xApiKey: undefined,
        anthropicVersion: undefined,
        xGoogApiKey: undefined,
        contentType: 'application/json',
        cookie: undefined,
        body: {
          model: 'grok-test',
          input: 'Keep Grok prompt exact. ',
          stream: false,
          store: false,
          max_output_tokens: 33,
          temperature: 0.1,
        },
      })
      assertDirectResult(result, {
        capability: 'xai.responses',
        provider: 'grok',
        model: 'grok-test',
        text: 'Grok answer',
        usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
        requestId: 'req_grok_socket',
      })
      assert.equal(result.raw.id, 'resp_grok_123')
    })
  })
})

test('Antigravity selects its dedicated Claude and Gemini routes from strict model prefixes', async () => {
  const observed = []
  await withHttpServer(async (request, response) => {
    observed.push(await observeJsonRequest(request))
    if (request.url === '/antigravity/v1/messages') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'request-id': 'req_antigravity_claude',
      })
      response.end(JSON.stringify({
        id: 'msg_antigravity_claude',
        content: [{ type: 'text', text: 'Antigravity Claude answer' }],
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 1,
          output_tokens: 3,
        },
      }))
      return
    }
    if (request.url === '/antigravity/v1beta/models/gemini-2.5-pro:generateContent') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        responseId: 'req_antigravity_gemini',
        candidates: [{ content: { parts: [{ text: 'Antigravity Gemini answer' }] } }],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 4,
          totalTokenCount: 13,
        },
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `Unexpected route ${request.url}` } }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-socket-secret',
    }, async () => {
      const claudeResult = await executeDirectRun({
        provider: 'antigravity',
        model: 'claude-sonnet-4-5',
        prompt: 'Antigravity Claude prompt',
        maxOutputTokens: 64,
      })
      const geminiResult = await executeDirectRun({
        provider: 'antigravity',
        model: 'gemini-2.5-pro',
        prompt: 'Antigravity Gemini prompt',
        maxOutputTokens: 72,
        temperature: 0.3,
      })

      assert.deepEqual(observed, [
        {
          method: 'POST',
          url: '/antigravity/v1/messages',
          authorization: undefined,
          xApiKey: 'antigravity-socket-secret',
          anthropicVersion: '2023-06-01',
          xGoogApiKey: undefined,
          contentType: 'application/json',
          cookie: undefined,
          body: {
            model: 'claude-sonnet-4-5',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'Antigravity Claude prompt' }],
            stream: false,
          },
        },
        {
          method: 'POST',
          url: '/antigravity/v1beta/models/gemini-2.5-pro:generateContent',
          authorization: undefined,
          xApiKey: 'antigravity-socket-secret',
          anthropicVersion: undefined,
          xGoogApiKey: undefined,
          contentType: 'application/json',
          cookie: undefined,
          body: {
            contents: [{ role: 'user', parts: [{ text: 'Antigravity Gemini prompt' }] }],
            store: false,
            generationConfig: { maxOutputTokens: 72, temperature: 0.3 },
          },
        },
      ])
      assertDirectResult(claudeResult, {
        capability: 'antigravity.anthropic.messages',
        provider: 'antigravity',
        model: 'claude-sonnet-4-5',
        text: 'Antigravity Claude answer',
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
        requestId: 'req_antigravity_claude',
      })
      assertDirectResult(geminiResult, {
        capability: 'antigravity.google.generateContent',
        provider: 'antigravity',
        model: 'gemini-2.5-pro',
        text: 'Antigravity Gemini answer',
        usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
        requestId: 'req_antigravity_gemini',
      })
      assert.equal(claudeResult.raw.id, 'msg_antigravity_claude')
      assert.equal(geminiResult.raw.responseId, 'req_antigravity_gemini')
    })
  })
})

test('every expanded provider rejects redirects without following or forwarding credentials', async () => {
  let initialRequests = 0
  let redirectedRequests = 0
  await withHttpServer((_request, response) => {
    if (_request.url === '/redirect-target') {
      redirectedRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ output: [] }))
      return
    }
    initialRequests += 1
    response.writeHead(307, { location: '/redirect-target' })
    response.end()
  }, async (baseUrl) => {
    const cases = [
      {
        request: { provider: 'claude', model: 'claude-test', prompt: 'Hello' },
        environment: {
          TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
          TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-redirect-secret',
        },
      },
      {
        request: { provider: 'gemini', model: 'gemini-test', prompt: 'Hello' },
        environment: {
          TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
          TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-redirect-secret',
        },
      },
      {
        request: { provider: 'grok', model: 'grok-test', prompt: 'Hello' },
        environment: {
          TOKENLESS_DIRECT_GROK_BASE_URL: baseUrl,
          TOKENLESS_DIRECT_GROK_API_KEY: 'grok-redirect-secret',
        },
      },
      {
        request: { provider: 'antigravity', model: 'claude-test', prompt: 'Hello' },
        environment: {
          TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: baseUrl,
          TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-redirect-secret',
        },
      },
    ]

    for (const entry of cases) {
      await withDirectEnvironment(entry.environment, async () => {
        await assert.rejects(
          executeDirectRun(entry.request),
          (error) =>
            error.code === 'direct_upstream_error' &&
            error.status === 307 &&
            error.retryable === false
        )
      })
    }
  })
  assert.equal(initialRequests, 4)
  assert.equal(redirectedRequests, 0)
})

test('expanded providers accept credentials only from TOKENLESS_DIRECT_* environment variables', async () => {
  let requests = 0
  await withHttpServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  }, async (baseUrl) => {
    const cases = [
      {
        request: { provider: 'claude', model: 'claude-test', prompt: 'Hello' },
        environment: {
          TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: 'implicit-claude-key',
        },
      },
      {
        request: { provider: 'gemini', model: 'gemini-test', prompt: 'Hello' },
        environment: {
          TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
          GEMINI_API_KEY: 'implicit-gemini-key',
          GOOGLE_API_KEY: 'implicit-google-key',
        },
      },
      {
        request: { provider: 'grok', model: 'grok-test', prompt: 'Hello' },
        environment: {
          TOKENLESS_DIRECT_GROK_BASE_URL: baseUrl,
          XAI_API_KEY: 'implicit-grok-key',
        },
      },
      {
        request: { provider: 'antigravity', model: 'claude-test', prompt: 'Hello' },
        environment: {
          TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: baseUrl,
          ANTIGRAVITY_API_KEY: 'implicit-antigravity-key',
        },
      },
    ]

    for (const entry of cases) {
      await withDirectEnvironment(entry.environment, async () => {
        await assert.rejects(
          executeDirectRun(entry.request, { apiKey: 'argument-key-is-not-accepted' }),
          (error) => error.code === 'direct_configuration_error' && /TOKENLESS_DIRECT_.*API_KEY/.test(error.message)
        )
      })
    }
  })
  assert.equal(requests, 0)
})

test('Antigravity requires an explicit gateway base and rejects ambiguous models before network access', async () => {
  await withDirectEnvironment({
    TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-key',
  }, async () => {
    await assert.rejects(
      executeDirectRun({
        provider: 'antigravity',
        model: 'claude-test',
        prompt: 'Hello',
      }),
      (error) => error.code === 'direct_configuration_error' && /base URL/i.test(error.message)
    )
  })

  let requests = 0
  await withHttpServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-key',
    }, async () => {
      for (const model of ['experimental-model', 'CLAUDE-test', 'gemini']) {
        await assert.rejects(
          executeDirectRun({
            provider: 'antigravity',
            model,
            prompt: 'Hello',
          }),
          (error) => error.code === 'direct_ambiguous_model'
        )
      }
    })
  })
  assert.equal(requests, 0)
})

function assertDirectResult(result, expected) {
  assert.equal(result.protocol, 'tokenless.direct.v1')
  assert.equal(result.backend, 'api')
  assert.equal(result.transport, 'direct-api')
  assert.equal(result.capability, expected.capability)
  assert.equal(result.provider, expected.provider)
  assert.equal(result.model, expected.model)
  assert.equal(result.text, expected.text)
  assert.deepEqual(result.usage, expected.usage)
  assert.equal(result.requestId, expected.requestId)
  assert.ok(result.raw && typeof result.raw === 'object')
}

async function observeJsonRequest(request) {
  return {
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    xApiKey: request.headers['x-api-key'],
    anthropicVersion: request.headers['anthropic-version'],
    xGoogApiKey: request.headers['x-goog-api-key'],
    contentType: request.headers['content-type'],
    cookie: request.headers.cookie,
    body: JSON.parse(await readRequestBody(request)),
  }
}

async function withDirectEnvironment(values, callback) {
  const original = new Map(DIRECT_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]))
  try {
    for (const name of DIRECT_ENVIRONMENT_NAMES) delete process.env[name]
    for (const [name, value] of Object.entries(values)) process.env[name] = value
    return await callback()
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

async function withHttpServer(handler, callback) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
