import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const directModuleRoot = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL('../packages/cli/dist/src/direct/', import.meta.url)
const { executeChatGptApi, MAX_DIRECT_REQUEST_BYTES } = await import(new URL('api-client.js', directModuleRoot))
const {
  chatGptResponsesUrl,
  resolveDirectApiConfig,
  validateDirectBaseUrl,
} = await import(new URL('config.js', directModuleRoot))

const DIRECT_ENVIRONMENT_NAMES = [
  'TOKENLESS_DIRECT_BASE_URL',
  'TOKENLESS_DIRECT_CHATGPT_BASE_URL',
  'TOKENLESS_DIRECT_API_KEY',
  'TOKENLESS_DIRECT_CHATGPT_API_KEY',
  'TOKENLESS_DIRECT_TIMEOUT_MS',
]

test('ChatGPT direct config uses explicit/provider/generic precedence and environment-only credentials', async () => {
  await withDirectEnvironment({
    TOKENLESS_DIRECT_BASE_URL: 'https://generic.example.test/root',
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: 'https://provider.example.test/openai',
    TOKENLESS_DIRECT_API_KEY: 'generic-key',
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'provider-key',
    TOKENLESS_DIRECT_TIMEOUT_MS: '4321',
  }, () => {
    const resolved = resolveDirectApiConfig({
      baseUrl: 'https://explicit.example.test/gateway/',
      // Runtime callers cannot override the environment credential with an option.
      apiKey: 'argument-key',
    })
    assert.deepEqual(resolved, {
      provider: 'chatgpt',
      baseUrl: 'https://explicit.example.test/gateway',
      apiKey: 'provider-key',
      timeoutMs: 4321,
    })
    assert.equal(resolveDirectApiConfig({ timeoutMs: 99 }).timeoutMs, 99)
  })

  await withDirectEnvironment({
    TOKENLESS_DIRECT_BASE_URL: 'https://generic.example.test',
    TOKENLESS_DIRECT_API_KEY: 'generic-key',
  }, () => {
    const resolved = resolveDirectApiConfig()
    assert.equal(resolved.baseUrl, 'https://generic.example.test')
    assert.equal(resolved.apiKey, 'generic-key')
  })
})

test('ChatGPT Responses request uses a real socket, exact public path/auth/body, and normalized output', async () => {
  let observed
  await withHttpServer(async (request, response) => {
    observed = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      xApiKey: request.headers['x-api-key'],
      cookie: request.headers.cookie,
      body: JSON.parse(await readRequestBody(request)),
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'req_socket_success',
    })
    response.end(JSON.stringify({
      id: 'resp_123',
      model: 'gpt-test',
      output: [{ type: 'message', content: [
        { type: 'output_text', text: 'First' },
        { type: 'output_text', text: 'Second' },
      ] }],
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: `${baseUrl}/v1`,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'socket-secret',
    }, async () => {
      const result = await executeChatGptApi({
        provider: 'chatgpt',
        backend: 'api',
        model: ' gpt-test ',
        prompt: 'Keep this prompt verbatim. ',
        maxOutputTokens: 44,
        temperature: 0.25,
      })

      assert.deepEqual(observed, {
        method: 'POST',
        url: '/v1/responses',
        authorization: 'Bearer socket-secret',
        contentType: 'application/json',
        xApiKey: undefined,
        cookie: undefined,
        body: {
          model: 'gpt-test',
          input: 'Keep this prompt verbatim. ',
          stream: false,
          store: false,
          max_output_tokens: 44,
          temperature: 0.25,
        },
      })
      assert.equal(result.protocol, 'tokenless.direct.v1')
      assert.equal(result.backend, 'api')
      assert.equal(result.transport, 'direct-api')
      assert.equal(result.capability, 'openai.responses')
      assert.equal(result.provider, 'chatgpt')
      assert.equal(result.model, 'gpt-test')
      assert.equal(result.text, 'First\nSecond')
      assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 })
      assert.equal(result.requestId, 'req_socket_success')
      assert.equal(result.raw.id, 'resp_123')
    })
  })

  assert.equal(chatGptResponsesUrl('https://gateway.example.test/prefix'), 'https://gateway.example.test/prefix/v1/responses')
  assert.equal(chatGptResponsesUrl('https://gateway.example.test/prefix/v1/'), 'https://gateway.example.test/prefix/v1/responses')
})

test('ChatGPT direct API ignores convenience and non-output text fields', async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      output_text: 'SDK-only convenience field',
      output: [{
        type: 'message',
        content: [
          { type: 'reasoning', text: 'hidden reasoning' },
          { type: 'output_text', text: 'Visible answer' },
          { type: 'tool_result', text: 'hidden tool result' },
        ],
      }],
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'test-key',
    }, async () => {
      const result = await executeChatGptApi({
        provider: 'chatgpt',
        model: 'gpt-test',
        prompt: 'Hello',
      })
      assert.equal(result.text, 'Visible answer')
    })
  })
})

test('ChatGPT direct API preserves a valid provider refusal as user-visible text', async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'refusal', refusal: 'I cannot help with that request.' }],
      }],
    }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'test-key',
    }, async () => {
      const result = await executeChatGptApi({
        provider: 'chatgpt',
        model: 'gpt-test',
        prompt: 'Hello',
      })
      assert.equal(result.text, 'I cannot help with that request.')
      assert.equal(result.raw.output[0].content[0].type, 'refusal')
    })
  })
})

test('ChatGPT direct API requires an environment key and explicit model before network access', async () => {
  await withDirectEnvironment({}, async () => {
    await assert.rejects(
      executeChatGptApi({ provider: 'chatgpt', model: 'gpt-test', prompt: 'Hello' }),
      (error) => error.code === 'direct_configuration_error' && /API_KEY/.test(error.message)
    )
  })

  await withDirectEnvironment({ TOKENLESS_DIRECT_CHATGPT_API_KEY: 'test-key' }, async () => {
    await assert.rejects(
      executeChatGptApi({ provider: 'chatgpt', prompt: 'Hello' }),
      (error) => error.code === 'direct_configuration_error' && /explicit model/.test(error.message)
    )
    await assert.rejects(
      executeChatGptApi({ provider: 'claude', model: 'claude-test', prompt: 'Hello' }),
      (error) => error.code === 'direct_unsupported_provider'
    )
    await assert.rejects(
      executeChatGptApi({ provider: 'chatgpt', backend: 'official-client', model: 'gpt-test', prompt: 'Hello' }),
      (error) => error.code === 'direct_configuration_error'
    )
  })
})

test('ChatGPT direct API rejects an oversized JSON request before opening a socket', async () => {
  let requests = 0
  await withHttpServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'test-key',
    }, async () => {
      await assert.rejects(
        executeChatGptApi({
          provider: 'chatgpt',
          model: 'gpt-test',
          prompt: 'x'.repeat(MAX_DIRECT_REQUEST_BYTES),
        }),
        (error) => error.code === 'direct_request_too_large' && error.retryable === false
      )
    })
  })
  assert.equal(requests, 0)
})

test('direct base URLs require HTTPS except exact loopback HTTP and reject credential-bearing URL components', async () => {
  for (const accepted of [
    'https://api.example.test',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
    'http://127.42.0.9:8788',
    'http://[::1]:8788',
  ]) {
    assert.doesNotThrow(() => validateDirectBaseUrl(accepted), accepted)
  }

  for (const rejected of [
    ['http://api.example.test', 'direct_insecure_upstream'],
    ['http://0.0.0.0:8788', 'direct_insecure_upstream'],
    ['ftp://localhost/model', 'direct_insecure_upstream'],
    ['https://user:password@api.example.test', 'direct_configuration_error'],
    ['https://api.example.test?key=value', 'direct_configuration_error'],
    ['https://api.example.test#fragment', 'direct_configuration_error'],
  ]) {
    assert.throws(
      () => validateDirectBaseUrl(rejected[0]),
      (error) => error.code === rejected[1],
      rejected[0]
    )
  }

  await withDirectEnvironment({
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'test-key',
    TOKENLESS_DIRECT_TIMEOUT_MS: 'infinite',
  }, () => {
    assert.throws(() => resolveDirectApiConfig(), (error) => error.code === 'direct_configuration_error')
  })
})

test('ChatGPT direct API rejects redirects without forwarding its credential', async () => {
  let initialRequests = 0
  let redirectedRequests = 0
  await withHttpServer((request, response) => {
    if (request.url === '/v1/responses') {
      initialRequests += 1
      response.writeHead(307, { location: '/redirect-target' })
      response.end()
      return
    }
    redirectedRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ output_text: 'redirected' }))
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'redirect-secret',
    }, async () => {
      await assert.rejects(
        executeChatGptApi({ provider: 'chatgpt', model: 'gpt-test', prompt: 'Hello' }),
        (error) => error.code === 'direct_upstream_error' && error.status === 307 && error.retryable === false
      )
    })
  })
  assert.equal(initialRequests, 1)
  assert.equal(redirectedRequests, 0)
})

test('401, 429, and 500 failures are stable, bounded, and redact credentials and HTML', async () => {
  const secret = 'sk-test-never-echo-this'
  const cases = new Map([
    ['auth', { status: 401, code: 'direct_authentication_failed', retryable: false }],
    ['rate', { status: 429, code: 'direct_rate_limited', retryable: true }],
    ['server', { status: 500, code: 'direct_upstream_error', retryable: true }],
  ])

  await withHttpServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request))
    const selected = cases.get(body.model)
    assert.ok(selected)
    response.writeHead(selected.status, {
      'content-type': body.model === 'server' ? 'text/html' : 'application/json',
      'x-request-id': `req_${body.model}`,
    })
    if (body.model === 'server') {
      response.end(`<html><script>unsafe()</script><body>${secret} ${'provider failure '.repeat(20_000)}</body></html>`)
    } else {
      response.end(JSON.stringify({ error: { message: `Provider echoed ${secret} in an error.` } }))
    }
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: secret,
    }, async () => {
      for (const [model, expected] of cases) {
        await assert.rejects(
          executeChatGptApi({ provider: 'chatgpt', model, prompt: 'Hello' }),
          (error) => {
            assert.equal(error.code, expected.code)
            assert.equal(error.status, expected.status)
            assert.equal(error.retryable, expected.retryable)
            assert.equal(error.requestId, `req_${model}`)
            assert.ok(error.message.length <= 512)
            assert.equal(error.message.includes(secret), false)
            assert.doesNotMatch(error.message, /<html|<script|unsafe\(\)/i)
            return true
          }
        )
      }
    })
  })
})

test('ChatGPT direct API applies a finite timeout to the real upstream socket', async () => {
  await withHttpServer((_request, response) => {
    setTimeout(() => {
      if (response.destroyed) return
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ output_text: 'too late' }))
    }, 250).unref()
  }, async (baseUrl) => {
    await withDirectEnvironment({
      TOKENLESS_DIRECT_CHATGPT_BASE_URL: baseUrl,
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'timeout-secret',
    }, async () => {
      await assert.rejects(
        executeChatGptApi(
          { provider: 'chatgpt', model: 'gpt-test', prompt: 'Hello' },
          { timeoutMs: 30 }
        ),
        (error) => error.code === 'direct_timeout' && error.retryable === true
      )
    })
  })
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
