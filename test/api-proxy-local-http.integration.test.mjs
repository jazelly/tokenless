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

test('api proxy routes stay behind the daemon control bearer token', async () => {
  await withDaemon(async (daemon) => {
    for (const route of ['/v1/openai/models', '/v1/openai/chat/completions', '/v1/anthropic/messages']) {
      const response = await fetch(`${daemon.origin}${route}`, { method: route.endsWith('models') ? 'GET' : 'POST' })
      assert.equal(response.status, 401, route)
      assert.equal((await response.json()).error.code, 'control_auth_missing')
    }
  })
})

test('api proxy stays disabled until it is explicitly enabled', async () => {
  await withDaemon(async (daemon) => {
    const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(response.status, 400)
    assert.match(response.body.error.message, /api proxy is disabled/)
  })
})

test('api proxy advertises every enabled provider as an explicit tokenless model name', async () => {
  await withDaemon(async (daemon) => {
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

test('api proxy rejects capabilities a visible page cannot honour', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    for (const field of ['tools', 'tool_choice', 'functions', 'function_call', 'response_format']) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages: [{ role: 'user', content: 'hello' }],
        [field]: field === 'tool_choice' ? 'auto' : [],
      })
      assert.equal(response.status, 400, field)
      assert.match(response.body.error.message, new RegExp(`does not support ${field}`))
    }
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
    assert.equal(openai.body.error.param, null)
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

test('api proxy rejects an unregistered provider before creating a job', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const response = await call(daemon, 'POST', '/v1/anthropic/messages', {
      model: 'tokenless/not-a-provider',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(response.status, 400)
    assert.match(response.body.error.message, /provider is not supported/)
    const jobs = await call(daemon, 'GET', '/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy conversation mode round-trips through the persisted config', async () => {
  await withDaemon(async (daemon) => {
    const { readTokenlessConfig, writeTokenlessConfig } = await import(runtimeModule)
    assert.deepEqual(
      (await readTokenlessConfig(daemon.homeDir)).apiProxy,
      { enabled: false, conversationMode: 'new-conversation' },
    )
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'continue-conversation' },
    })
    assert.deepEqual(
      (await readTokenlessConfig(daemon.homeDir)).apiProxy,
      { enabled: true, conversationMode: 'continue-conversation' },
    )
    await assert.rejects(
      () => writeTokenlessConfig({
        homeDir: daemon.homeDir,
        apiProxy: { enabled: true, conversationMode: 'sometimes' },
      }),
      /API proxy configuration/,
    )
  })
})

async function enableApiProxy(homeDir, conversationMode = 'new-conversation') {
  const { writeTokenlessConfig } = await import(runtimeModule)
  await writeTokenlessConfig({ homeDir, apiProxy: { enabled: true, conversationMode } })
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
