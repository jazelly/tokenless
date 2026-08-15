import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemonServer = path.join(root, 'packages/cli/dist/src/daemon/server.js')
const daemonStore = path.join(root, 'packages/cli/dist/src/daemon/job-store.js')
const runtimeModule = path.join(root, 'packages/cli/dist/src/index.js')

const ROUTES = [
  ['GET', '/v1/openai/models'],
  ['GET', '/v1/models'],
  ['POST', '/v1/openai/chat/completions'],
  ['POST', '/v1/chat/completions'],
  ['POST', '/v1/anthropic/messages'],
]

test('api proxy routes stay behind the daemon control bearer token', async () => {
  await withDaemon(async (daemon) => {
    for (const [method, route] of ROUTES) {
      const response = await fetch(`${daemon.origin}${route}`, { method })
      assert.equal(response.status, 401, route)
      assert.equal((await response.json()).error.code, 'control_auth_missing')
    }
  })
})

test('every api proxy route stays disabled until the proxy is explicitly enabled', async () => {
  await withDaemon(async (daemon) => {
    for (const [method, route] of ROUTES) {
      const response = await call(daemon, method, route, method === 'GET' ? undefined : {
        model: 'tokenless/chatgpt',
        messages: [{ role: 'user', content: 'hello' }],
      })
      assert.equal(response.status, 503, route)
      assert.equal(response.body.error.type, 'overloaded_error', route)
      // The Anthropic envelope carries no machine code, by that vendor's shape.
      if (!route.includes('anthropic')) assert.equal(response.body.error.code, 'api_proxy_disabled', route)
    }
  })
})

test('api proxy advertises every enabled provider as an explicit tokenless model name', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const response = await call(daemon, 'GET', '/v1/openai/models')
    assert.equal(response.status, 200)
    assert.equal(response.body.object, 'list')
    assert.ok(response.body.data.length > 0)
    for (const model of response.body.data) {
      assert.match(model.id, /^tokenless\/[a-z0-9-]+$/)
      assert.equal(model.owned_by, 'tokenless')
    }
    assert.ok(response.body.data.some((model) => model.id === 'tokenless/chatgpt'))
  })
})

test('api proxy rejects a model that does not name a provider explicitly', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.type, 'invalid_request_error')
    assert.match(response.body.error.message, /model must be named tokenless\/<provider>/)
  })
})

test('api proxy accepts streaming function tools and complete tool history before profile readiness', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const tool = functionTool('read_file')
    tool.function.description = 'Read one UTF-8 file and return its exact contents to the external harness. '.repeat(24)
    const firstTurn = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [
        { role: 'developer', content: 'Use tools when needed.' },
        { role: 'user', content: 'Read package.json.' },
      ],
      tools: [tool],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: true,
      stream_options: { include_usage: true },
    })
    assert.equal(firstTurn.status, 409)
    assert.equal(firstTurn.body.error.code, 'profile_not_configured')

    const continuation = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [
        { role: 'user', content: 'Read package.json.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_from_previous_turn',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_from_previous_turn', content: '{"name":"tokenless"}' },
      ],
      tools: [tool],
    })
    assert.equal(continuation.status, 409)
    assert.equal(continuation.body.error.code, 'profile_not_configured')
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy accepts complete multiple-call history regardless of the current parallel setting', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const tools = [functionTool('read_file'), functionTool('search_files')]
    const messages = [
      { role: 'user', content: 'Read package.json and search the source.' },
      {
        role: 'assistant',
        content: 'I will inspect both independently.',
        tool_calls: [
          { id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } },
          { id: 'call_search', type: 'function', function: { name: 'search_files', arguments: '{"path":"packages"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_search', content: 'packages/cli' },
      { role: 'tool', tool_call_id: 'call_read', content: '{"name":"tokenless"}' },
    ]
    for (const parallelToolCalls of [undefined, true, false]) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages,
        tools,
        ...(parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }),
      })
      assert.equal(response.status, 409, String(parallelToolCalls))
      assert.equal(response.body.error.code, 'profile_not_configured', String(parallelToolCalls))
    }
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy accepts every single-call tool choice and recursive strict schemas before profile readiness', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const strictTool = functionTool('read_file')
    strictTool.function.strict = true
    strictTool.function.parameters = {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'options'],
      properties: {
        path: { type: 'string', minLength: 1 },
        options: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['encoding'],
          properties: { encoding: { type: ['string', 'null'] } },
        },
      },
    }
    const choices = [
      undefined,
      'auto',
      'none',
      'required',
      { type: 'function', function: { name: 'read_file' } },
    ]
    for (const toolChoice of choices) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages: [{ role: 'user', content: 'Read package.json.' }],
        tools: [strictTool],
        ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        parallel_tool_calls: false,
      })
      assert.equal(response.status, 409, JSON.stringify(toolChoice))
      assert.equal(response.body.error.code, 'profile_not_configured', JSON.stringify(toolChoice))
    }
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy accepts text and structured final formats with or without complete tool history before profile readiness', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const responseFormats = [
      { type: 'text' },
      { type: 'json_object' },
      {
        type: 'json_schema',
        json_schema: {
          name: 'repository_result',
          description: 'A closed nested repository result.',
          strict: false,
          schema: {
            type: 'object',
            title: 'Repository result',
            description: 'Accepted response fields.',
            additionalProperties: false,
            required: ['summary', 'metrics', 'tags', 'status'],
            properties: {
              summary: { type: 'string', minLength: 1, maxLength: 200, pattern: '^.+$', format: 'email' },
              metrics: {
                type: 'object',
                additionalProperties: false,
                required: ['score'],
                properties: {
                  score: { type: 'number', minimum: 0, maximum: 10, exclusiveMinimum: -1, exclusiveMaximum: 11, multipleOf: 0.5 },
                },
              },
              tags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['source', 'test'] } },
              status: { anyOf: [{ type: 'string', const: 'ok' }, { type: 'null' }] },
            },
          },
        },
      },
    ]
    const tool = functionTool('read_file')
    const completedHistory = [
      { role: 'user', content: 'Read package.json and summarize it.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"package.json"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read', content: '{"name":"tokenless"}' },
    ]
    for (const responseFormat of responseFormats) {
      for (const request of [
        { messages: [{ role: 'user', content: 'Return the requested final shape.' }] },
        { messages: completedHistory, tools: [tool], tool_choice: 'auto' },
      ]) {
        const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
          model: 'tokenless/chatgpt',
          ...request,
          response_format: responseFormat,
        })
        assert.equal(response.status, 409, JSON.stringify(responseFormat))
        assert.equal(response.body.error.code, 'profile_not_configured', JSON.stringify(responseFormat))
      }
    }
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy rejects malformed tool catalogs and history before creating a job', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const validTool = functionTool('read_file')
    const cases = [
      {
        name: 'duplicate tool name',
        body: { messages: [{ role: 'user', content: 'hello' }], tools: [validTool, validTool] },
        param: 'tools',
      },
      {
        name: 'invalid parameter schema',
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'not-a-json-schema-type' } } }],
        },
        param: 'tools',
      },
      ...[
        { name: 'strict must be boolean', strict: 'true' },
        { name: 'strict parameters root is not an object', strict: true, parameters: { type: 'string' } },
        {
          name: 'strict parameters root is nullable',
          strict: true,
          parameters: { ...validTool.function.parameters, type: ['object', 'null'] },
        },
        {
          name: 'strict root object allows extra properties',
          strict: true,
          parameters: { ...validTool.function.parameters, additionalProperties: true },
        },
        {
          name: 'strict root object omits a required property',
          strict: true,
          parameters: { ...validTool.function.parameters, required: [] },
        },
        {
          name: 'strict nested nullable object allows extra properties',
          strict: true,
          parameters: {
            ...validTool.function.parameters,
            required: ['path', 'options'],
            properties: {
              ...validTool.function.parameters.properties,
              options: { type: ['object', 'null'], properties: { encoding: { type: 'string' } }, required: ['encoding'] },
            },
          },
        },
      ].map(({ name, strict, parameters = validTool.function.parameters }) => ({
        name,
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ ...validTool, function: { ...validTool.function, strict, parameters } }],
        },
        param: 'tools',
      })),
      {
        name: 'undeclared history name',
        body: {
          messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'arguments fail schema',
        body: {
          messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":4}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'duplicate argument key',
        body: {
          messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a","path":"b"}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'unpaired call',
        body: {
          messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'mismatched result',
        body: {
          messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
            { role: 'tool', tool_call_id: 'call_other', content: 'done' },
          ],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'duplicate id in one assistant call group',
        body: {
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
                { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
          tools: [validTool],
          parallel_tool_calls: true,
        },
        param: 'messages',
      },
      {
        name: 'multiple calls are not all resolved before a user message',
        body: {
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
                { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_2', content: 'done' },
            { role: 'user', content: 'continue' },
          ],
          tools: [validTool],
          parallel_tool_calls: true,
        },
        param: 'messages',
      },
      ...[
        { name: 'unknown string tool choice', toolChoice: 'sometimes' },
        { name: 'named tool choice references undeclared function', toolChoice: { type: 'function', function: { name: 'write_file' } } },
        { name: 'named tool choice has invalid shape', toolChoice: { type: 'function', function: { name: 'read_file', extra: true } } },
      ].map(({ name, toolChoice }) => ({
        name,
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          tools: [validTool],
          tool_choice: toolChoice,
        },
        param: 'tool_choice',
      })),
      {
        name: 'required tool choice has no catalog',
        body: { messages: [{ role: 'user', content: 'hello' }], tool_choice: 'required' },
        param: 'tool_choice',
      },
    ]
    for (const entry of cases) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        ...entry.body,
      })
      assert.equal(response.status, 400, entry.name)
      assert.equal(response.body.error.code, 'invalid_request_error', entry.name)
      assert.equal(response.body.error.param, entry.param, entry.name)
    }
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy rejects deprecated function fields and malformed parallel control', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const cases = [
      ['functions', []],
      ['function_call', 'auto'],
      ['parallel_tool_calls', 'false'],
    ]
    for (const [field, value] of cases) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages: [{ role: 'user', content: 'hello' }],
        [field]: value,
      })
      assert.equal(response.status, 400, field)
      assert.equal(
        response.body.error.code,
        field === 'parallel_tool_calls' ? 'invalid_request_error' : 'unsupported_parameter',
        field,
      )
      assert.equal(response.body.error.param, field, field)
    }
  })
})

test('api proxy rejects malformed and unsupported structured output schemas before creating a job', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const closedSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: { value: { type: 'string' } },
    }
    const cases = [
      { name: 'non-object response format', responseFormat: null },
      { name: 'unknown response type', responseFormat: { type: 'yaml' } },
      { name: 'text extra field', responseFormat: { type: 'text', strict: true } },
      { name: 'json object extra field', responseFormat: { type: 'json_object', schema: {} } },
      { name: 'missing json schema definition', responseFormat: { type: 'json_schema' } },
      {
        name: 'invalid schema name',
        responseFormat: { type: 'json_schema', json_schema: { name: 'contains spaces', schema: closedSchema } },
      },
      {
        name: 'non-string description',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', description: 1, schema: closedSchema } },
      },
      {
        name: 'non-boolean strict',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', strict: 'true', schema: closedSchema } },
      },
      {
        name: 'root is not exactly object',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { type: ['object', 'null'] } } },
      },
      {
        name: 'unclosed root object',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { ...closedSchema, additionalProperties: true } } },
      },
      {
        name: 'unclosed nested object',
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'result',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['nested'],
              properties: { nested: { type: 'object', properties: {}, required: [] } },
            },
          },
        },
      },
      {
        name: 'root anyOf',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { ...closedSchema, anyOf: [closedSchema] } } },
      },
      {
        name: 'unsupported oneOf',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { ...closedSchema, oneOf: [closedSchema] } } },
      },
      {
        name: 'unsupported local ref',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { ...closedSchema, $ref: '#/$defs/result' } } },
      },
      {
        name: 'unsafe integer schema bound',
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'result',
            schema: {
              ...closedSchema,
              properties: { value: { type: 'number', maximum: 9007199254740992 } },
            },
          },
        },
      },
      {
        name: 'unsafe integer nested inside schema const',
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'result',
            schema: {
              ...closedSchema,
              properties: { value: { const: { nested: [9007199254740992] } } },
            },
          },
        },
      },
    ]
    for (const entry of cases) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages: [{ role: 'user', content: 'hello' }],
        response_format: entry.responseFormat,
      })
      assert.equal(response.status, 400, entry.name)
      assert.equal(response.body.error.code, 'invalid_request_error', entry.name)
      assert.equal(response.body.error.param, 'response_format', entry.name)
    }
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy reports each dialect failure in that dialect envelope', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const openai = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [],
    })
    assert.equal(openai.status, 400)
    assert.equal(openai.body.error.type, 'invalid_request_error')
    assert.equal(openai.body.error.param, 'messages')
    assert.equal(typeof openai.body.error.code, 'string')

    const anthropic = await call(daemon, 'POST', '/v1/anthropic/messages', {
      model: 'tokenless/claude',
      max_tokens: 16,
      messages: [],
    })
    assert.equal(anthropic.status, 400)
    assert.equal(anthropic.body.type, 'error')
    assert.equal(anthropic.body.error.type, 'invalid_request_error')
    assert.equal(anthropic.body.error.code, undefined)
  })
})

test('api proxy reports an unregistered provider as an unknown model before creating a job', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const response = await call(daemon, 'POST', '/v1/anthropic/messages', {
      model: 'tokenless/not-a-provider',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(response.status, 404)
    assert.equal(response.body.error.type, 'not_found_error')
    assert.match(response.body.error.message, /does not exist/)
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy serves the default OpenAI paths as aliases of the prefixed routes', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const prefixed = await call(daemon, 'GET', '/v1/openai/models')
    const bare = await call(daemon, 'GET', '/v1/models')
    assert.equal(bare.status, 200)
    assert.deepEqual(bare.body, prefixed.body)

    // The bare completion path must reach the same OpenAI dialect, proven by an
    // OpenAI-shaped rejection rather than an Anthropic one.
    const completion = await call(daemon, 'POST', '/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(completion.status, 400)
    assert.equal(completion.body.error.param, 'model')
    assert.match(completion.body.error.message, /model must be named tokenless\/<provider>/)
  })
})

test('api proxy distinguishes each caller mistake by status so clients can decide about retrying', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const cases = [
      {
        name: 'unknown provider',
        body: { model: 'tokenless/not-a-provider', messages: [{ role: 'user', content: 'hi' }] },
        status: 404,
        code: 'model_not_found',
      },
      {
        name: 'malformed tool field',
        body: { model: 'tokenless/chatgpt', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        status: 400,
        code: 'invalid_request_error',
      },
      {
        name: 'oversized body',
        raw: JSON.stringify({ model: 'tokenless/chatgpt', messages: [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }] }),
        status: 413,
        code: 'request_too_large',
      },
      { name: 'unparseable body', raw: '{ not json', status: 400, code: 'invalid_json' },
      { name: 'empty body', raw: '', status: 400, code: 'invalid_json' },
      { name: 'json array body', raw: '[]', status: 400, code: 'invalid_request_error' },
    ]
    for (const entry of cases) {
      const response = await fetch(`${daemon.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
        body: entry.raw ?? JSON.stringify(entry.body),
      })
      assert.equal(response.status, entry.status, entry.name)
      const { error } = await response.json()
      assert.equal(error.code, entry.code, entry.name)
    }
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy conversation mode round-trips through the persisted config', async () => {
  await withDaemon(async (daemon) => {
    const { readTokenlessConfig, writeTokenlessConfig } = await import(runtimeModule)
    assert.deepEqual(
      (await readTokenlessConfig(daemon.homeDir)).apiProxy,
      { enabled: false, conversationMode: 'new-conversation', executionMode: 'direct' },
    )
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'continue-conversation', executionMode: 'browser' },
    })
    assert.deepEqual(
      (await readTokenlessConfig(daemon.homeDir)).apiProxy,
      { enabled: true, conversationMode: 'continue-conversation', executionMode: 'browser' },
    )
    await assert.rejects(
      () => writeTokenlessConfig({
        homeDir: daemon.homeDir,
        apiProxy: { enabled: true, conversationMode: 'sometimes', executionMode: 'direct' },
      }),
      /API proxy configuration/,
    )
  })
})

async function enableApiProxy(homeDir, conversationMode = 'new-conversation') {
  const { writeTokenlessConfig } = await import(runtimeModule)
  await writeTokenlessConfig({ homeDir, apiProxy: { enabled: true, conversationMode } })
}

function functionTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: 'Read one UTF-8 file.',
      strict: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string', minLength: 1 } },
      },
    },
  }
}

async function call(daemon, method, route, body) {
  const response = await fetch(`${daemon.origin}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${daemon.token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

async function withDaemon(run) {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-api-proxy-')))
  const { JobStore } = await import(daemonStore)
  const { serveHttp } = await import(daemonServer)
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  try {
    await run({ origin: daemon.origin, token: store.controlToken(), homeDir })
  } finally {
    await daemon.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
}
