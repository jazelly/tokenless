import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = process.env.TOKENLESS_DIRECT_CLI_TEST_ENTRY
  ? path.resolve(process.env.TOKENLESS_DIRECT_CLI_TEST_ENTRY)
  : path.join(root, 'packages/cli/dist/src/tokenless.mjs')

const DIRECT_ENVIRONMENT_NAMES = [
  'TOKENLESS_BROWSER_EXECUTABLE',
  'TOKENLESS_CODEX_BIN',
  'TOKENLESS_DAEMON_URL',
  'TOKENLESS_DIRECT_API_KEY',
  'TOKENLESS_DIRECT_BASE_URL',
  'TOKENLESS_DIRECT_CHATGPT_API_KEY',
  'TOKENLESS_DIRECT_CHATGPT_BASE_URL',
  'TOKENLESS_DIRECT_CLAUDE_API_KEY',
  'TOKENLESS_DIRECT_CLAUDE_BASE_URL',
  'TOKENLESS_DIRECT_GEMINI_API_KEY',
  'TOKENLESS_DIRECT_GEMINI_BASE_URL',
  'TOKENLESS_DIRECT_GROK_API_KEY',
  'TOKENLESS_DIRECT_GROK_BASE_URL',
  'TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY',
  'TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL',
  'TOKENLESS_DIRECT_TIMEOUT_MS',
  'TOKENLESS_HOME',
]

test('expanded provider CLI matrix uses direct API sockets without touching visible, daemon, or Codex paths', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-direct-cli-providers-'))
  const poisonHome = path.join(temporaryRoot, 'home-is-a-file')
  const codexExecutable = path.join(temporaryRoot, 'poison-codex.mjs')
  const codexMarker = path.join(temporaryRoot, 'codex-invoked')
  const browserExecutable = path.join(temporaryRoot, 'poison-browser.mjs')
  const browserMarker = path.join(temporaryRoot, 'browser-invoked')
  fs.writeFileSync(poisonHome, 'must remain a file')
  writeMarkerExecutable(codexExecutable, codexMarker)
  writeMarkerExecutable(browserExecutable, browserMarker)

  const observed = []
  let daemonRequests = 0
  try {
    await withHttpServer((_request, response) => {
      daemonRequests += 1
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'direct mode must not contact the daemon' }))
    }, async (daemonUrl) => {
      await withHttpServer(async (request, response) => {
        const body = JSON.parse(await streamText(request))
        observed.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          xApiKey: request.headers['x-api-key'],
          xGoogApiKey: request.headers['x-goog-api-key'],
          cookie: request.headers.cookie,
          body,
        })
        respondToProviderFixture(request, response)
      }, async (baseUrl) => {
        const cases = [
          {
            provider: 'claude',
            model: 'claude-cli-test',
            capability: 'anthropic.messages',
            text: 'Claude CLI answer',
            apiKeyName: 'TOKENLESS_DIRECT_CLAUDE_API_KEY',
            apiKey: 'claude-cli-secret',
          },
          {
            provider: 'gemini',
            model: 'gemini-cli-test',
            capability: 'google.generateContent',
            text: 'Gemini CLI answer',
            apiKeyName: 'TOKENLESS_DIRECT_GEMINI_API_KEY',
            apiKey: 'gemini-cli-secret',
          },
          {
            provider: 'grok',
            model: 'grok-cli-test',
            capability: 'xai.responses',
            text: 'Grok CLI answer',
            apiKeyName: 'TOKENLESS_DIRECT_GROK_API_KEY',
            apiKey: 'grok-cli-secret',
          },
          {
            provider: 'antigravity',
            model: 'claude-sonnet-cli',
            capability: 'antigravity.anthropic.messages',
            text: 'Antigravity Claude CLI answer',
            apiKeyName: 'TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY',
            apiKey: 'antigravity-cli-secret',
          },
          {
            provider: 'antigravity',
            model: 'gemini-cli-test',
            capability: 'antigravity.google.generateContent',
            text: 'Antigravity Gemini CLI answer',
            apiKeyName: 'TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY',
            apiKey: 'antigravity-cli-secret',
          },
        ]

        for (const entry of cases) {
          const completed = await runCli([
            'run',
            '--mode', 'direct',
            '--direct-base-url', baseUrl,
            '--provider', entry.provider,
            '--model', entry.model,
            '--prompt', `Answer through the ${entry.provider} CLI fixture.`,
            '--timeout-ms', '5000',
            '--quiet',
            '--json',
          ], directEnvironment({
            [entry.apiKeyName]: entry.apiKey,
            TOKENLESS_BROWSER_EXECUTABLE: browserExecutable,
            TOKENLESS_CODEX_BIN: codexExecutable,
            TOKENLESS_DAEMON_URL: daemonUrl,
            TOKENLESS_HOME: poisonHome,
          }))

          assert.equal(completed.code, 0, `${entry.provider}/${entry.model}: ${completed.stderr}\n${completed.stdout}`)
          assert.equal(completed.stderr, '')
          const payload = JSON.parse(completed.stdout)
          assert.equal(payload.ok, true)
          assert.equal(payload.protocol, 'tokenless.direct.v1')
          assert.equal(payload.mode, 'direct')
          assert.equal(payload.backend, 'api')
          assert.equal(payload.transport, 'direct-api')
          assert.equal(payload.capability, entry.capability)
          assert.equal(payload.provider, entry.provider)
          assert.equal(payload.model, entry.model)
          assert.equal(payload.text, entry.text)
          assert.equal(payload.compactOutput, entry.text)
          assert.equal(payload.result.text, entry.text)
          assert.equal(payload.result.capability, entry.capability)
          assert.equal(payload.status, 'completed')
          assert.deepEqual(payload.statusLog.map(({ event }) => event), ['direct_started', 'direct_completed'])
        }
      })
    })

    assert.deepEqual(observed.map(({ method, url }) => ({ method, url })), [
      { method: 'POST', url: '/v1/messages' },
      { method: 'POST', url: '/v1beta/models/gemini-cli-test:generateContent' },
      { method: 'POST', url: '/v1/responses' },
      { method: 'POST', url: '/antigravity/v1/messages' },
      { method: 'POST', url: '/antigravity/v1beta/models/gemini-cli-test:generateContent' },
    ])
    assert.deepEqual(observed.map(({ authorization, xApiKey, xGoogApiKey, cookie }) => ({
      authorization,
      xApiKey,
      xGoogApiKey,
      cookie,
    })), [
      { authorization: undefined, xApiKey: 'claude-cli-secret', xGoogApiKey: undefined, cookie: undefined },
      { authorization: undefined, xApiKey: undefined, xGoogApiKey: 'gemini-cli-secret', cookie: undefined },
      { authorization: 'Bearer grok-cli-secret', xApiKey: undefined, xGoogApiKey: undefined, cookie: undefined },
      { authorization: undefined, xApiKey: 'antigravity-cli-secret', xGoogApiKey: undefined, cookie: undefined },
      { authorization: undefined, xApiKey: 'antigravity-cli-secret', xGoogApiKey: undefined, cookie: undefined },
    ])
    assert.equal(daemonRequests, 0)
    assert.equal(fs.existsSync(codexMarker), false)
    assert.equal(fs.existsSync(browserMarker), false)
    assert.equal(fs.readFileSync(poisonHome, 'utf8'), 'must remain a file')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('official-client is rejected for a non-ChatGPT provider before any alternate path is touched', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-direct-cli-official-reject-'))
  const poisonHome = path.join(temporaryRoot, 'home-is-a-file')
  const codexExecutable = path.join(temporaryRoot, 'poison-codex.mjs')
  const codexMarker = path.join(temporaryRoot, 'codex-invoked')
  const browserExecutable = path.join(temporaryRoot, 'poison-browser.mjs')
  const browserMarker = path.join(temporaryRoot, 'browser-invoked')
  fs.writeFileSync(poisonHome, 'must remain a file')
  writeMarkerExecutable(codexExecutable, codexMarker)
  writeMarkerExecutable(browserExecutable, browserMarker)

  let daemonRequests = 0
  try {
    await withHttpServer((_request, response) => {
      daemonRequests += 1
      response.writeHead(500)
      response.end()
    }, async (daemonUrl) => {
      const completed = await runCli([
        'run',
        '--mode', 'direct',
        '--direct-backend', 'official-client',
        '--provider', 'claude',
        '--model', 'claude-cli-test',
        '--prompt', 'This must be rejected before execution.',
        '--quiet',
        '--json',
      ], directEnvironment({
        TOKENLESS_BROWSER_EXECUTABLE: browserExecutable,
        TOKENLESS_CODEX_BIN: codexExecutable,
        TOKENLESS_DAEMON_URL: daemonUrl,
        TOKENLESS_DIRECT_CLAUDE_API_KEY: 'must-not-be-used',
        TOKENLESS_HOME: poisonHome,
      }))

      assert.equal(completed.code, 1, completed.stderr)
      assert.equal(completed.stderr, '')
      const payload = JSON.parse(completed.stdout)
      assert.equal(payload.ok, false)
      assert.equal(payload.error.code, 'direct_unsupported_provider')
      assert.equal(payload.error.retryable, false)
      assert.equal(payload.status, 'failed')
      assert.deepEqual(payload.statusLog.map(({ event }) => event), ['direct_started', 'direct_failed'])
    })

    assert.equal(daemonRequests, 0)
    assert.equal(fs.existsSync(codexMarker), false)
    assert.equal(fs.existsSync(browserMarker), false)
    assert.equal(fs.readFileSync(poisonHome, 'utf8'), 'must remain a file')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('a direct API upstream error is terminal and never falls back to Codex or visible mode', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-direct-cli-no-fallback-'))
  const poisonHome = path.join(temporaryRoot, 'home-is-a-file')
  const codexExecutable = path.join(temporaryRoot, 'poison-codex.mjs')
  const codexMarker = path.join(temporaryRoot, 'codex-invoked')
  const browserExecutable = path.join(temporaryRoot, 'poison-browser.mjs')
  const browserMarker = path.join(temporaryRoot, 'browser-invoked')
  fs.writeFileSync(poisonHome, 'must remain a file')
  writeMarkerExecutable(codexExecutable, codexMarker)
  writeMarkerExecutable(browserExecutable, browserMarker)

  let upstreamRequests = 0
  let daemonRequests = 0
  try {
    await withHttpServer((_request, response) => {
      daemonRequests += 1
      response.writeHead(500)
      response.end()
    }, async (daemonUrl) => {
      await withHttpServer((_request, response) => {
        upstreamRequests += 1
        response.writeHead(503, {
          'content-type': 'application/json',
          'request-id': 'req_cli_terminal_503',
        })
        response.end(JSON.stringify({ error: { message: 'fixture unavailable' } }))
      }, async (baseUrl) => {
        const completed = await runCli([
          'run',
          '--mode', 'direct',
          '--provider', 'claude',
          '--model', 'claude-cli-test',
          '--direct-base-url', baseUrl,
          '--prompt', 'Do not retry or fall back.',
          '--timeout-ms', '5000',
          '--quiet',
          '--json',
        ], directEnvironment({
          TOKENLESS_BROWSER_EXECUTABLE: browserExecutable,
          TOKENLESS_CODEX_BIN: codexExecutable,
          TOKENLESS_DAEMON_URL: daemonUrl,
          TOKENLESS_DIRECT_CLAUDE_API_KEY: 'terminal-error-secret',
          TOKENLESS_HOME: poisonHome,
        }))

        assert.equal(completed.code, 1, completed.stderr)
        assert.equal(completed.stderr, '')
        const payload = JSON.parse(completed.stdout)
        assert.equal(payload.ok, false)
        assert.equal(payload.error.code, 'direct_upstream_error')
        assert.equal(payload.error.status, 503)
        assert.equal(payload.error.requestId, 'req_cli_terminal_503')
        assert.equal(payload.error.retryable, true)
        assert.equal(payload.status, 'failed')
        assert.deepEqual(payload.statusLog.map(({ event }) => event), ['direct_started', 'direct_failed'])
      })
    })

    assert.equal(upstreamRequests, 1)
    assert.equal(daemonRequests, 0)
    assert.equal(fs.existsSync(codexMarker), false)
    assert.equal(fs.existsSync(browserMarker), false)
    assert.equal(fs.readFileSync(poisonHome, 'utf8'), 'must remain a file')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

function respondToProviderFixture(request, response) {
  const responses = {
    '/v1/messages': {
      headers: { 'request-id': 'req_cli_claude' },
      body: {
        id: 'msg_cli_claude',
        content: [{ type: 'text', text: 'Claude CLI answer' }],
        usage: { input_tokens: 4, output_tokens: 3 },
      },
    },
    '/v1beta/models/gemini-cli-test:generateContent': {
      body: {
        responseId: 'req_cli_gemini',
        candidates: [{ content: { parts: [{ text: 'Gemini CLI answer' }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      },
    },
    '/v1/responses': {
      headers: { 'x-request-id': 'req_cli_grok' },
      body: {
        id: 'resp_cli_grok',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grok CLI answer' }] }],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      },
    },
    '/antigravity/v1/messages': {
      headers: { 'request-id': 'req_cli_antigravity_claude' },
      body: {
        id: 'msg_cli_antigravity_claude',
        content: [{ type: 'text', text: 'Antigravity Claude CLI answer' }],
        usage: { input_tokens: 5, output_tokens: 4 },
      },
    },
    '/antigravity/v1beta/models/gemini-cli-test:generateContent': {
      body: {
        responseId: 'req_cli_antigravity_gemini',
        candidates: [{ content: { parts: [{ text: 'Antigravity Gemini CLI answer' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
      },
    },
  }
  const fixture = responses[request.url]
  if (fixture === undefined) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `Unexpected route ${request.url}` } }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json', ...fixture.headers })
  response.end(JSON.stringify(fixture.body))
}

function directEnvironment(overrides = {}) {
  const environment = { ...process.env }
  for (const name of DIRECT_ENVIRONMENT_NAMES) delete environment[name]
  return { ...environment, ...overrides }
}

async function runCli(args, env) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [code, stdout, stderr] = await Promise.all([
    new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }),
    streamText(child.stdout),
    streamText(child.stderr),
  ])
  return { code, stdout, stderr }
}

async function withHttpServer(handler, run) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error.message } }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function streamText(stream) {
  let text = ''
  for await (const chunk of stream) text += chunk.toString('utf8')
  return text
}

function writeMarkerExecutable(executable, marker) {
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(marker)}, 'invoked')
`, { mode: 0o755 })
}
