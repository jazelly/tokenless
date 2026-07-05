import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import test from 'node:test'

test('Tokenless Relay exposes health, capabilities, validation, and accepted run responses', async () => {
  const port = 19000 + Math.floor(Math.random() * 1000)
  const child = spawn(process.execPath, ['packages/relay/src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TOKENLESS_RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')))
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')))

  try {
    await waitForOutput(output, /tokenless-relay listening/)
    const baseUrl = `http://127.0.0.1:${port}`

    const health = await requestJson(`${baseUrl}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(health.body, { ok: true, service: 'tokenless-relay' })

    const capabilities = await requestJson(`${baseUrl}/v1/capabilities`)
    assert.equal(capabilities.status, 200)
    assert.equal(capabilities.body.protocol, 'tokenless.relay.v1')
    assert.ok(capabilities.body.transports.includes('tokenless-relay'))
    assert.ok(capabilities.body.providers.includes('chatgpt'))
    assert.ok(capabilities.body.actions.includes('submit_and_read'))

    const invalid = await requestJson(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'tokenless.relay.v1', requestId: 'missing-provider' }),
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.ok, false)
    assert.equal(invalid.body.error.code, 'invalid_provider')

    const accepted = await requestJson(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 'tokenless.relay.v1',
        requestId: 'run-1',
        provider: 'chatgpt',
        action: 'submit_and_read',
        prompt: 'Say hello.',
      }),
    })
    assert.equal(accepted.status, 202)
    assert.equal(accepted.body.ok, true)
    assert.equal(accepted.body.result.status, 'accepted')
    assert.equal(accepted.body.result.relay, 'server')
  } finally {
    child.kill()
    await once(child, 'exit').catch(() => undefined)
  }
})

async function requestJson(url, init) {
  const response = await fetch(url, init)
  return {
    status: response.status,
    body: await response.json(),
  }
}

async function waitForOutput(output, pattern) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (pattern.test(output.join(''))) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for output: ${pattern}`)
}
