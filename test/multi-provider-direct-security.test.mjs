import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const cliModuleUrl = process.env.TOKENLESS_DIRECT_TEST_CLI_MODULE
  ? pathToFileURL(path.resolve(process.env.TOKENLESS_DIRECT_TEST_CLI_MODULE))
  : new URL('../packages/cli/dist/src/index.js', import.meta.url)
const { executeDirectApi, executeDirectRun } = await import(cliModuleUrl)
const { anthropicMessagesUrl, geminiGenerateContentUrl } = await import(
  new URL('./direct/config.js', cliModuleUrl)
)
const { postDirectJson } = await import(new URL('./direct/api-transport.js', cliModuleUrl))

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

test('versioned provider endpoints preserve prefixes without duplicating versions', () => {
  assert.equal(anthropicMessagesUrl('https://api.example.test'), 'https://api.example.test/v1/messages')
  assert.equal(
    anthropicMessagesUrl('https://api.example.test/prefix/v1/'),
    'https://api.example.test/prefix/v1/messages',
  )
  assert.equal(
    geminiGenerateContentUrl('https://api.example.test/prefix', 'gemini-test'),
    'https://api.example.test/prefix/v1beta/models/gemini-test:generateContent',
  )
  assert.equal(
    geminiGenerateContentUrl('https://api.example.test/prefix/v1beta/', 'gemini-test'),
    'https://api.example.test/prefix/v1beta/models/gemini-test:generateContent',
  )
  assert.throws(
    () => geminiGenerateContentUrl('https://api.example.test', 'gemini%2Fescape'),
    (error) => error.code === 'direct_configuration_error',
  )
})

test('provider options cannot override a provider adapter credential namespace', async () => {
  let observed
  await withHttpServer(async (request, response) => {
    observed = {
      url: request.url,
      xApiKey: request.headers['x-api-key'],
      authorization: request.headers.authorization,
    }
    await readRequestBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ content: [{ type: 'text', text: 'Claude answer' }] }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: `${baseUrl}/wrong-provider`,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'chatgpt-key-must-not-win',
      TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-key',
    }, async () => {
      const result = await executeDirectApi(
        { provider: 'claude', model: 'claude-test', prompt: 'Hello' },
        { provider: 'chatgpt' },
      )
      assert.equal(result.text, 'Claude answer')
    })
  })
  assert.deepEqual(observed, {
    url: '/v1/messages',
    xApiKey: 'claude-key',
    authorization: undefined,
  })
})

test('Gemini and Antigravity reject unsafe model identifiers before opening a socket', async () => {
  let requests = 0
  await withHttpServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-key',
      TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-key',
    }, async () => {
      const unsafeGeminiModels = [
        'gemini/escape',
        String.raw`gemini\escape`,
        'gemini%2Fescape',
        'gemini%2fescape',
        'gemini?query',
        'gemini#fragment',
        'gemini:method',
        '..',
        'gemini-..',
      ]
      for (const model of unsafeGeminiModels) {
        await assert.rejects(
          executeDirectRun({ provider: 'gemini', model, prompt: 'Hello' }),
          (error) =>
            error.retryable === false &&
            ['direct_configuration_error', 'direct_ambiguous_model'].includes(error.code),
          `Gemini model ${JSON.stringify(model)} must fail closed`,
        )
      }

      const unsafeAntigravityModels = [
        'claude/escape',
        String.raw`claude\escape`,
        'claude%2Fescape',
        'gemini%2fescape',
        'claude?query',
        'gemini#fragment',
        'claude:method',
        '..',
        'claude-..',
        'gemini-..',
        'CLAUDE-test',
        'Claude-test',
        'GEMINI-test',
        'openai-test',
        'grok-test',
        'claude',
        'gemini',
      ]
      for (const model of unsafeAntigravityModels) {
        await assert.rejects(
          executeDirectRun({ provider: 'antigravity', model, prompt: 'Hello' }),
          (error) =>
            error.retryable === false &&
            ['direct_configuration_error', 'direct_ambiguous_model'].includes(error.code),
          `Antigravity model ${JSON.stringify(model)} must fail closed`,
        )
      }
    })
  })
  assert.equal(requests, 0)
})

test('Antigravity joins root, prefix, family root, and versioned bases exactly once', async () => {
  const observedUrls = []
  await withHttpServer(async (request, response) => {
    observedUrls.push(request.url)
    await readRequestBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url.endsWith('/messages')) {
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'Claude answer' }] }))
      return
    }
    response.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }],
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-routing-key',
    }, async () => {
      const cases = [
        {
          baseUrl,
          model: 'claude-test',
          expected: '/antigravity/v1/messages',
        },
        {
          baseUrl: `${baseUrl}/prefix`,
          model: 'claude-test',
          expected: '/prefix/antigravity/v1/messages',
        },
        {
          baseUrl: `${baseUrl}/antigravity`,
          model: 'claude-test',
          expected: '/antigravity/v1/messages',
        },
        {
          baseUrl: `${baseUrl}/antigravity/v1`,
          model: 'claude-test',
          expected: '/antigravity/v1/messages',
        },
        {
          baseUrl: `${baseUrl}/antigravity/v1beta`,
          model: 'claude-test',
          expected: '/antigravity/v1/messages',
        },
        {
          baseUrl,
          model: 'gemini-test',
          expected: '/antigravity/v1beta/models/gemini-test:generateContent',
        },
        {
          baseUrl: `${baseUrl}/prefix`,
          model: 'gemini-test',
          expected: '/prefix/antigravity/v1beta/models/gemini-test:generateContent',
        },
        {
          baseUrl: `${baseUrl}/antigravity`,
          model: 'gemini-test',
          expected: '/antigravity/v1beta/models/gemini-test:generateContent',
        },
        {
          baseUrl: `${baseUrl}/antigravity/v1beta`,
          model: 'gemini-test',
          expected: '/antigravity/v1beta/models/gemini-test:generateContent',
        },
        {
          baseUrl: `${baseUrl}/antigravity/v1`,
          model: 'gemini-test',
          expected: '/antigravity/v1beta/models/gemini-test:generateContent',
        },
      ]

      for (const entry of cases) {
        const result = await executeDirectRun({
          provider: 'antigravity',
          model: entry.model,
          prompt: 'Hello',
        }, { baseUrl: entry.baseUrl })
        assert.equal(result.text, entry.model.startsWith('claude-') ? 'Claude answer' : 'Gemini answer')
      }
      assert.deepEqual(observedUrls, cases.map((entry) => entry.expected))
    })
  })
})

test('direct API keys containing CRLF or control characters fail before network access', async () => {
  let requests = 0
  await withHttpServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  }, async (baseUrl) => {
    const cases = [
      {
        request: { provider: 'chatgpt', backend: 'api', model: 'gpt-test', prompt: 'Hello' },
        baseName: 'TOKENLESS_DIRECT_CHATGPT_BASE_URL',
        keyName: 'TOKENLESS_DIRECT_CHATGPT_API_KEY',
        key: 'safe-prefix\r\nx-injected: true',
      },
      {
        request: { provider: 'claude', model: 'claude-test', prompt: 'Hello' },
        baseName: 'TOKENLESS_DIRECT_CLAUDE_BASE_URL',
        keyName: 'TOKENLESS_DIRECT_CLAUDE_API_KEY',
        key: 'safe-prefix\tunsafe-suffix',
      },
      {
        request: { provider: 'gemini', model: 'gemini-test', prompt: 'Hello' },
        baseName: 'TOKENLESS_DIRECT_GEMINI_BASE_URL',
        keyName: 'TOKENLESS_DIRECT_GEMINI_API_KEY',
        key: 'safe-prefix\u007funsafe-suffix',
      },
      {
        request: { provider: 'grok', model: 'grok-test', prompt: 'Hello' },
        baseName: 'TOKENLESS_DIRECT_GROK_BASE_URL',
        keyName: 'TOKENLESS_DIRECT_GROK_API_KEY',
        key: 'safe-prefix\nunsafe-suffix',
      },
      {
        request: { provider: 'antigravity', model: 'claude-test', prompt: 'Hello' },
        baseName: 'TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL',
        keyName: 'TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY',
        key: 'safe-prefix\runsafe-suffix',
      },
      {
        request: { provider: 'chatgpt', backend: 'api', model: 'gpt-test', prompt: 'Hello' },
        baseName: 'TOKENLESS_DIRECT_CHATGPT_BASE_URL',
        keyName: 'TOKENLESS_DIRECT_CHATGPT_API_KEY',
        key: 'non-ascii-😀-key',
      },
    ]

    for (const entry of cases) {
      await withDirectEnvironment({
        [entry.baseName]: baseUrl,
        [entry.keyName]: entry.key,
      }, async () => {
        await assert.rejects(
          executeDirectRun(entry.request),
          (error) =>
            error.code === 'direct_configuration_error' &&
            error.retryable === false &&
            /(control characters|visible ASCII)/i.test(error.message),
        )
      })
    }
  })
  assert.equal(requests, 0)
})

test('each provider sends only its own credential in its documented authentication header', async () => {
  const observed = []
  await withHttpServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request))
    observed.push({
      url: request.url,
      authorization: request.headers.authorization,
      xApiKey: request.headers['x-api-key'],
      anthropicVersion: request.headers['anthropic-version'],
      xGoogApiKey: request.headers['x-goog-api-key'],
      cookie: request.headers.cookie,
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url.endsWith('/messages')) {
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }))
    } else if (request.url.includes(':generateContent')) {
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }))
    } else {
      response.end(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: body.model }] }],
      }))
    }
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_BASE_URL: `${baseUrl}/generic-must-not-win`,
      TOKENLESS_DIRECT_API_KEY: 'generic-must-not-win',
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'chatgpt-only-key',
      TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-only-key',
      TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-only-key',
      TOKENLESS_DIRECT_GROK_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GROK_API_KEY: 'grok-only-key',
      TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-only-key',
    }, async () => {
      await executeDirectRun({ provider: 'chatgpt', backend: 'api', model: 'gpt-test', prompt: 'Hello' })
      await executeDirectRun({ provider: 'claude', model: 'claude-test', prompt: 'Hello' })
      await executeDirectRun({ provider: 'gemini', model: 'gemini-test', prompt: 'Hello' })
      await executeDirectRun({ provider: 'grok', model: 'grok-test', prompt: 'Hello' })
      await executeDirectRun({ provider: 'antigravity', model: 'claude-test', prompt: 'Hello' })
    })
  })

  assert.deepEqual(observed, [
    {
      url: '/v1/responses',
      authorization: 'Bearer chatgpt-only-key',
      xApiKey: undefined,
      anthropicVersion: undefined,
      xGoogApiKey: undefined,
      cookie: undefined,
    },
    {
      url: '/v1/messages',
      authorization: undefined,
      xApiKey: 'claude-only-key',
      anthropicVersion: '2023-06-01',
      xGoogApiKey: undefined,
      cookie: undefined,
    },
    {
      url: '/v1beta/models/gemini-test:generateContent',
      authorization: undefined,
      xApiKey: undefined,
      anthropicVersion: undefined,
      xGoogApiKey: 'gemini-only-key',
      cookie: undefined,
    },
    {
      url: '/v1/responses',
      authorization: 'Bearer grok-only-key',
      xApiKey: undefined,
      anthropicVersion: undefined,
      xGoogApiKey: undefined,
      cookie: undefined,
    },
    {
      url: '/antigravity/v1/messages',
      authorization: undefined,
      xApiKey: 'antigravity-only-key',
      anthropicVersion: '2023-06-01',
      xGoogApiKey: undefined,
      cookie: undefined,
    },
  ])
})

test('Claude-family temperatures above one fail before network access', async () => {
  let requests = 0
  await withHttpServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-key',
      TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY: 'antigravity-key',
    }, async () => {
      for (const request of [
        { provider: 'claude', model: 'claude-test', prompt: 'Hello', temperature: 1.000_001 },
        { provider: 'antigravity', model: 'claude-test', prompt: 'Hello', temperature: 1.000_001 },
      ]) {
        await assert.rejects(
          executeDirectRun(request),
          (error) =>
            error.code === 'direct_configuration_error' &&
            error.retryable === false &&
            /between 0 and 1/.test(error.message),
        )
      }
    })
  })
  assert.equal(requests, 0)
})

test('unsafe usage integers and overflowing token sums are omitted', async () => {
  await withHttpServer(async (request, response) => {
    await readRequestBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url === '/v1/messages') {
      response.end(JSON.stringify({
        content: [{ type: 'text', text: 'Claude answer' }],
        usage: {
          input_tokens: Number.MAX_SAFE_INTEGER,
          cache_creation_input_tokens: 1,
          output_tokens: 2,
        },
      }))
      return
    }
    if (request.url.includes(':generateContent')) {
      response.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: Number.MAX_SAFE_INTEGER,
          thoughtsTokenCount: 1,
          totalTokenCount: Number.MAX_SAFE_INTEGER + 1,
        },
      }))
      return
    }
    response.end(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grok answer' }] }],
      usage: {
        input_tokens: Number.MAX_SAFE_INTEGER + 1,
        output_tokens: 2,
        total_tokens: Number.MAX_SAFE_INTEGER + 1,
      },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-key',
      TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-key',
      TOKENLESS_DIRECT_GROK_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GROK_API_KEY: 'grok-key',
    }, async () => {
      const claude = await executeDirectRun({ provider: 'claude', model: 'claude-test', prompt: 'Hello' })
      const gemini = await executeDirectRun({ provider: 'gemini', model: 'gemini-test', prompt: 'Hello' })
      const grok = await executeDirectRun({ provider: 'grok', model: 'grok-test', prompt: 'Hello' })

      assert.deepEqual(claude.usage, { outputTokens: 2 })
      assert.deepEqual(gemini.usage, { inputTokens: 3 })
      assert.deepEqual(grok.usage, { outputTokens: 2 })
      for (const result of [claude, gemini, grok]) {
        assert.ok(Object.values(result.usage).every(Number.isSafeInteger))
      }
    })
  })
})

test('present but malformed usage components never produce trusted aggregate counts', async () => {
  await withHttpServer(async (request, response) => {
    await readRequestBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url === '/v1/messages') {
      response.end(JSON.stringify({
        content: [{ type: 'text', text: 'Claude answer' }],
        usage: {
          input_tokens: -1,
          cache_creation_input_tokens: '4',
          cache_read_input_tokens: 5.5,
          output_tokens: 2,
        },
      }))
      return
    }
    response.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: -1,
        thoughtsTokenCount: '7',
        totalTokenCount: 12,
      },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-key',
      TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-key',
    }, async () => {
      const claude = await executeDirectRun({ provider: 'claude', model: 'claude-test', prompt: 'Hello' })
      const gemini = await executeDirectRun({ provider: 'gemini', model: 'gemini-test', prompt: 'Hello' })
      assert.deepEqual(claude.usage, { outputTokens: 2 })
      assert.deepEqual(gemini.usage, { inputTokens: 3, totalTokens: 12 })
    })
  })
})

test('Anthropic usage requires a valid ordinary input_tokens field before aggregating cache input', async () => {
  let requests = 0
  await withHttpServer(async (request, response) => {
    requests += 1
    await readRequestBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      content: [{ type: 'text', text: 'Claude answer' }],
      usage: {
        ...(requests === 1 ? {} : { input_tokens: null }),
        cache_read_input_tokens: 5,
        output_tokens: 2,
      },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-key',
    }, async () => {
      for (let index = 0; index < 2; index += 1) {
        const result = await executeDirectRun({
          provider: 'claude',
          model: 'claude-test',
          prompt: 'Hello',
        })
        assert.deepEqual(result.usage, { outputTokens: 2 })
      }
    })
  })
  assert.equal(requests, 2)
})

test('Gemini excludes thought text while accounting for thought tokens', async () => {
  await withHttpServer(async (request, response) => {
    await readRequestBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      candidates: [{ content: { parts: [
        { thought: true, text: 'private chain of thought' },
        { text: 'Visible first' },
        { thought: true, text: 'more private chain of thought' },
        { text: 'Visible second' },
      ] } }],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 7,
        totalTokenCount: 14,
      },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-key',
    }, async () => {
      const result = await executeDirectRun({
        provider: 'gemini',
        model: 'gemini-test',
        prompt: 'Hello',
      })
      assert.equal(result.text, 'Visible first\nVisible second')
      assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 10, totalTokens: 14 })
      assert.equal(result.text.includes('private chain of thought'), false)
    })
  })
})

test('Anthropic errors use a bounded body request_id when no request-id header is present', async () => {
  await withHttpServer(async (request, response) => {
    await readRequestBody(request)
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      request_id: 'req_anthropic_body_fallback',
      error: { message: 'Anthropic failed safely.' },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CLAUDE_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CLAUDE_API_KEY: 'claude-key',
    }, async () => {
      await assert.rejects(
        executeDirectRun({ provider: 'claude', model: 'claude-test', prompt: 'Hello' }),
        (error) => {
          assert.equal(error.code, 'direct_upstream_error')
          assert.equal(error.status, 500)
          assert.equal(error.retryable, true)
          assert.equal(error.requestId, 'req_anthropic_body_fallback')
          return true
        },
      )
    })
  })
})

test('a pre-aborted direct request is nonretryable and opens no socket', async () => {
  let requests = 0
  await withHttpServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  }, async (baseUrl) => {
    const controller = new AbortController()
    controller.abort()
    await withDirectEnvironment({
      TOKENLESS_DIRECT_GEMINI_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_GEMINI_API_KEY: 'gemini-key',
    }, async () => {
      await assert.rejects(
        executeDirectRun({
          provider: 'gemini',
          model: 'gemini-test',
          prompt: 'Hello',
          signal: controller.signal,
        }),
        (error) =>
          error.code === 'direct_upstream_error' &&
          error.retryable === false &&
          /aborted/i.test(error.message),
      )
    })
  })
  assert.equal(requests, 0)
})

test('an in-flight abort is nonretryable and makes one request without fallback', async () => {
  const controller = new AbortController()
  const observedUrls = []
  await withHttpServer(async (request, response) => {
    observedUrls.push(request.url)
    await readRequestBody(request)
    controller.abort()
    response.once('close', () => undefined)
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_BASE_URL: `${baseUrl}/fallback-must-not-run`,
      TOKENLESS_DIRECT_API_KEY: 'fallback-key',
      TOKENLESS_DIRECT_GEMINI_BASE_URL: `${baseUrl}/primary`,
      TOKENLESS_DIRECT_GEMINI_API_KEY: 'primary-key',
    }, async () => {
      await assert.rejects(
        executeDirectRun({
          provider: 'gemini',
          model: 'gemini-test',
          prompt: 'Hello',
          signal: controller.signal,
        }, { timeoutMs: 2_000 }),
        (error) =>
          error.code === 'direct_upstream_error' &&
          error.retryable === false &&
          /aborted/i.test(error.message),
      )
    })
  })
  assert.deepEqual(observedUrls, ['/primary/v1beta/models/gemini-test:generateContent'])
})

test('an external abort remains the first failure even when transport rejection arrives after timeout', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let calls = 0
  globalThis.fetch = (_url, options) => {
    calls += 1
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        setTimeout(() => reject(new Error('delayed transport abort')), 20)
      }, { once: true })
    })
  }
  try {
    const pending = postDirectJson({
      endpoint: 'https://example.invalid/v1/responses',
      authentication: { kind: 'bearer', apiKey: 'test-key' },
      body: { model: 'test' },
      timeoutMs: 5,
      signal: controller.signal,
      requestIdHeaders: ['x-request-id'],
    })
    controller.abort()
    await assert.rejects(
      pending,
      (error) =>
        error.code === 'direct_upstream_error' &&
        error.retryable === false &&
        /aborted/i.test(error.message),
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

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
