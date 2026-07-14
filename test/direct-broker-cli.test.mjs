import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('serve command requires an explicit direct mode and an environment-only local key', () => {
  const environment = { ...process.env }
  delete environment.TOKENLESS_DIRECT_SERVER_KEY

  const missingMode = spawnSync(process.execPath, [cliEntry, 'serve', '--json'], {
    encoding: 'utf8',
    env: environment,
  })
  assert.equal(missingMode.status, 1)
  assert.equal(JSON.parse(missingMode.stdout).error.code, 'direct_serve_mode_required')

  const missingKey = spawnSync(process.execPath, [cliEntry, 'serve', '--mode', 'direct', '--json'], {
    encoding: 'utf8',
    env: environment,
  })
  assert.equal(missingKey.status, 1)
  assert.equal(JSON.parse(missingKey.stdout).error.code, 'direct_configuration_error')
  assert.match(JSON.parse(missingKey.stdout).error.message, /TOKENLESS_DIRECT_SERVER_KEY/)
})

test('serve command brokers a real streaming socket without touching visible-session or Codex paths', async () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-direct-broker-cli-'))
  let daemonContacts = 0
  let upstreamRequest
  const daemon = await startServer((_request, response) => {
    daemonContacts += 1
    response.writeHead(500).end()
  })
  const upstream = await startServer(async (request, response) => {
    upstreamRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readBody(request),
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'set-cookie': 'provider-session=must-not-escape',
      'x-request-id': 'req_cli_broker',
    })
    response.write('data: first\n\n')
    setImmediate(() => response.end('data: second\n\n'))
  })

  const environment = {
    ...process.env,
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    TOKENLESS_CODEX_BIN: path.join(temporaryHome, 'codex-must-not-run'),
    TOKENLESS_DAEMON_URL: daemon.url,
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'provider-secret',
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
    TOKENLESS_DIRECT_SERVER_KEY: 'tokenless-local-cli-secret-32-characters',
    TOKENLESS_DIRECT_TIMEOUT_MS: '5000',
  }
  const child = spawn(process.execPath, [
    cliEntry,
    'serve',
    '--mode', 'direct',
    '--host', '127.0.0.1',
    '--port', '0',
    '--json',
  ], {
    cwd: temporaryHome,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  try {
    const startup = await waitForStartupJson(child, () => stdout, () => stderr)
    assert.deepEqual({
      ok: startup.ok,
      protocol: startup.protocol,
      mode: startup.mode,
      transport: startup.transport,
      host: startup.host,
    }, {
      ok: true,
      protocol: 'tokenless.direct-broker.v1',
      mode: 'direct',
      transport: 'direct-broker',
      host: '127.0.0.1',
    })
    assert.equal(Number.isInteger(startup.port) && startup.port > 0, true)

    const unauthenticated = await fetch(`${startup.url}/health`)
    assert.equal(unauthenticated.status, 401)
    const health = await fetch(`${startup.url}/health`, {
      headers: { authorization: 'Bearer tokenless-local-cli-secret-32-characters' },
    })
    assert.deepEqual(await health.json(), {
      protocol: 'tokenless.direct-broker.v1',
      status: 'ok',
    })

    const response = await fetch(`${startup.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tokenless-local-cli-secret-32-characters',
        cookie: 'local-session=must-not-forward',
        'content-type': 'application/json',
        'x-api-key': 'inbound-secret',
        'x-auth-token': 'unknown-secret',
      },
      body: JSON.stringify({ model: 'gpt-test', input: 'hello', stream: true }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'req_cli_broker')
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(await response.text(), 'data: first\n\ndata: second\n\n')

    assert.equal(upstreamRequest.method, 'POST')
    assert.equal(upstreamRequest.url, '/v1/responses')
    assert.equal(upstreamRequest.headers.authorization, 'Bearer provider-secret')
    assert.equal(upstreamRequest.headers.cookie, undefined)
    assert.equal(upstreamRequest.headers['x-api-key'], undefined)
    assert.equal(upstreamRequest.headers['x-auth-token'], undefined)
    assert.deepEqual(JSON.parse(upstreamRequest.body), {
      model: 'gpt-test',
      input: 'hello',
      stream: true,
    })

    child.kill('SIGTERM')
    const exit = await waitForExit(child)
    assert.equal(exit.code, 0, stderr)
    assert.equal(exit.signal, null)
    assert.equal(daemonContacts, 0)
    assert.equal(fs.existsSync(path.join(temporaryHome, '.tokenless')), false)
    assert.doesNotMatch(`${stdout}\n${stderr}`, /provider-secret|tokenless-local-cli-secret-32-characters|inbound-secret|unknown-secret/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await upstream.close()
    await daemon.close()
    fs.rmSync(temporaryHome, { recursive: true, force: true })
  }
})

test('serve command routes project API accounts from its selected home and fails over only after exact rejection', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-project-api-cli-'))
  const homeDir = path.join(temporaryRoot, 'operator-home')
  const invalidBody = Buffer.from(JSON.stringify({
    error: {
      message: 'invalid redacted key',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_api_key',
    },
  }))
  const calls = []
  const upstream = await startServer(async (request, response) => {
    calls.push(request.headers.authorization)
    await readBody(request)
    if (request.headers.authorization === 'Bearer account-secret-a') {
      response.writeHead(401, {
        'content-length': String(invalidBody.byteLength),
        'content-type': 'application/json; charset=utf-8',
      })
      response.end(invalidBody)
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  const baseEnvironment = {
    ...process.env,
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    TOKENLESS_CODEX_BIN: path.join(temporaryRoot, 'codex-must-not-run'),
  }

  const accountA = runCliJson([
    'accounts', 'add',
    '--provider', 'chatgpt',
    '--driver', 'api',
    '--account', 'account-a',
    '--routing-domain', 'openai-team',
    '--home', homeDir,
    '--json',
  ], baseEnvironment).account
  const accountB = runCliJson([
    'accounts', 'add',
    '--provider', 'chatgpt',
    '--driver', 'api',
    '--account', 'account-b',
    '--routing-domain', 'openai-team',
    '--home', homeDir,
    '--json',
  ], baseEnvironment).account
  runCliJson([
    'projects', 'pin',
    '--project', 'Pinned-Project',
    '--provider', 'chatgpt',
    '--account', 'account-a',
    '--home', homeDir,
    '--json',
  ], baseEnvironment)

  const environment = {
    ...baseEnvironment,
    [accountA.credentialEnv]: 'account-secret-a',
    [accountB.credentialEnv]: 'account-secret-b',
    TOKENLESS_DIRECT_CHATGPT_BASE_URL: upstream.url,
    TOKENLESS_DIRECT_CHATGPT_ROUTING_DOMAIN: 'openai-team',
    TOKENLESS_DIRECT_SERVER_KEY: 'tokenless-project-cli-secret-32-characters',
    TOKENLESS_DIRECT_TIMEOUT_MS: '5000',
  }
  const child = spawn(process.execPath, [
    cliEntry,
    'serve',
    '--mode', 'direct',
    '--home', homeDir,
    '--host', '127.0.0.1',
    '--port', '0',
    '--json',
  ], {
    cwd: temporaryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  try {
    const startup = await waitForStartupJson(child, () => stdout, () => stderr)
    const request = (project) => fetch(`${startup.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tokenless-project-cli-secret-32-characters',
        'content-type': 'application/json',
        'x-tokenless-project': project,
      },
      body: '{"model":"gpt-test","input":"hello"}',
    })

    const rejected = await request('Pinned-Project')
    assert.equal(rejected.status, 401)
    assert.deepEqual(Buffer.from(await rejected.arrayBuffer()), invalidBody)
    assert.deepEqual(calls, ['Bearer account-secret-a'])

    const migrated = await request('Pinned-Project')
    assert.equal(migrated.status, 200)
    assert.deepEqual(await migrated.json(), { ok: true })
    const resolution = runCliJson([
      'projects', 'resolve',
      '--project', 'Pinned-Project',
      '--provider', 'chatgpt',
      '--home', homeDir,
      '--json',
    ], baseEnvironment)
    assert.equal(resolution.project.accountId, 'account-b')

    const assigned = await request('Unbound-Project')
    assert.equal(assigned.status, 200)
    assert.deepEqual(await assigned.json(), { ok: true })
    assert.deepEqual(calls, [
      'Bearer account-secret-a',
      'Bearer account-secret-b',
      'Bearer account-secret-b',
    ])

    child.kill('SIGTERM')
    const exit = await waitForExit(child)
    assert.equal(exit.code, 0, stderr)
    assert.equal(exit.signal, null)
    assert.doesNotMatch(`${stdout}\n${stderr}`, /account-secret-a|account-secret-b/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await upstream.close()
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

function waitForStartupJson(child, stdout, stderr) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for broker startup. ${stderr()}`)), 10_000)
    const inspect = () => {
      try {
        const parsed = JSON.parse(stdout())
        if (parsed.url) finish(undefined, parsed)
      } catch {
        // Startup JSON may span multiple stream chunks.
      }
    }
    const exited = (code, signal) => finish(new Error(
      `Broker exited before startup (code=${String(code)}, signal=${String(signal)}). ${stderr()}`,
    ))
    const finish = (error, value) => {
      clearTimeout(timeout)
      child.stdout.off('data', inspect)
      child.off('exit', exited)
      if (error) reject(error)
      else resolve(value)
    }
    child.stdout.on('data', inspect)
    child.once('exit', exited)
    inspect()
  })
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function startServer(listener) {
  const server = http.createServer(listener)
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

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function runCliJson(argv, environment) {
  const result = spawnSync(process.execPath, [cliEntry, ...argv], {
    encoding: 'utf8',
    env: environment,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}
