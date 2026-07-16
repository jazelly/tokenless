import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = process.env.TOKENLESS_DIRECT_CLI_TEST_ENTRY
  ? path.resolve(process.env.TOKENLESS_DIRECT_CLI_TEST_ENTRY)
  : path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const cliIndex = process.env.TOKENLESS_DIRECT_CLI_TEST_INDEX
  ? path.resolve(process.env.TOKENLESS_DIRECT_CLI_TEST_INDEX)
  : path.join(root, 'packages/cli/dist/src/index.js')

const DIRECT_ENVIRONMENT_NAMES = [
  'TOKENLESS_CODEX_BIN',
  'TOKENLESS_DIRECT_API_KEY',
  'TOKENLESS_DIRECT_BASE_URL',
  'TOKENLESS_DIRECT_CHATGPT_API_KEY',
  'TOKENLESS_DIRECT_CHATGPT_BASE_URL',
  'TOKENLESS_DIRECT_TIMEOUT_MS',
  'TOKENLESS_HOME',
]

const officialPermissionProfile =
  'permissions={tokenless_direct={workspace_roots={"."=true},filesystem={":root"="deny",":workspace_roots"="read"},network={enabled=false}}}'
const officialDisabledFeatures = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'deferred_executor',
  'enable_fanout',
  'enable_mcp_apps',
  'exec_permission_approvals',
  'guardian_approval',
  'hooks',
  'image_generation',
  'imagegenext',
  'in_app_browser',
  'js_repl',
  'js_repl_tools_only',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugin_sharing',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'respect_system_proxy',
  'search_tool',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'workspace_dependencies',
]

test('public CLI module exports the reusable direct client contract', async () => {
  const direct = await import(pathToFileURL(cliIndex).href)
  assert.equal(typeof direct.executeDirectRun, 'function')
  assert.equal(typeof direct.executeChatGptApi, 'function')
  assert.equal(typeof direct.runOfficialCodex, 'function')
  assert.equal(typeof direct.resolveDirectApiConfig, 'function')
  assert.equal(typeof direct.DirectError, 'function')
  assert.equal(direct.DIRECT_PROTOCOL, 'tokenless.direct.v1')
})

test('direct ChatGPT API CLI uses a real socket and never reads Tokenless home or daemon state', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-direct-cli-api-'))
  const poisonHome = path.join(temporaryRoot, 'home-is-a-file')
  fs.writeFileSync(poisonHome, 'must remain a file')
  let observed

  try {
    await withHttpServer(async (request, response) => {
      observed = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        body: JSON.parse(await streamText(request)),
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'req_cli_socket',
      })
      response.end(JSON.stringify({
        id: 'resp_cli_socket',
        model: 'gpt-cli-test',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'API CLI answer' }] }],
        usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
      }))
    }, async (baseUrl) => {
      const completed = await runCli([
        'run',
        '--mode', 'direct',
        '--direct-backend', 'api',
        '--direct-base-url', baseUrl,
        '--provider', 'chatgpt',
        '--model', 'gpt-cli-test',
        '--max-output-tokens', '23',
        '--temperature', '0.2',
        '--project-name', 'Tokenless',
        '--chat-name', 'Direct API',
        '--prompt', 'Answer through the API fixture.',
        '--timeout-ms', '5000',
        '--quiet',
        '--json',
      ], directEnvironment({
        TOKENLESS_DIRECT_CHATGPT_API_KEY: 'cli-socket-secret',
        TOKENLESS_HOME: poisonHome,
      }))

      assert.equal(completed.code, 0, completed.stderr)
      assert.equal(completed.stderr, '')
      const payload = JSON.parse(completed.stdout)
      assert.equal(payload.ok, true)
      assert.equal(payload.protocol, 'tokenless.direct.v1')
      assert.equal(payload.mode, 'direct')
      assert.equal(payload.backend, 'api')
      assert.equal(payload.transport, 'direct-api')
      assert.equal(payload.capability, 'openai.responses')
      assert.equal(payload.provider, 'chatgpt')
      assert.equal(payload.model, 'gpt-cli-test')
      assert.equal(payload.text, 'API CLI answer')
      assert.equal(payload.compactOutput, 'API CLI answer')
      assert.equal(payload.result.text, 'API CLI answer')
      assert.equal(payload.result.raw.id, 'resp_cli_socket')
      assert.equal(payload.taskId, 'project:Tokenless:chat:Direct API')
      assert.equal(payload.status, 'completed')
      assert.deepEqual(payload.statusLog.map((event) => event.event), ['direct_started', 'direct_completed'])
    })

    assert.equal(observed.method, 'POST')
    assert.equal(observed.url, '/v1/responses')
    assert.equal(observed.authorization, 'Bearer cli-socket-secret')
    assert.equal(observed.cookie, undefined)
    assert.equal(observed.body.model, 'gpt-cli-test')
    assert.equal(observed.body.store, false)
    assert.equal(observed.body.max_output_tokens, 23)
    assert.equal(observed.body.temperature, 0.2)
    assert.match(observed.body.input, /# Tokenless Request/)
    assert.match(observed.body.input, /Answer through the API fixture\./)
    assert.equal(fs.readFileSync(poisonHome, 'utf8'), 'must remain a file')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('direct ChatGPT CLI defaults to the isolated official Codex client', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-direct-cli-codex-'))
  const executable = path.join(temporaryRoot, 'fake-codex.mjs')
  const invocationPath = path.join(temporaryRoot, 'invocation.json')
  const tracePath = path.join(temporaryRoot, 'trace.jsonl')
  const poisonHome = path.join(temporaryRoot, 'home-is-a-file')
  fs.writeFileSync(poisonHome, 'must remain a file')
  writeFakeCodex(executable, invocationPath, tracePath)

  try {
    const completed = await runCli([
      'run',
      '--mode', 'direct',
      '--provider', 'chatgpt',
      '--task-id', 'direct-official-task',
      '--prompt', 'Answer through the official client fixture.',
      '--timeout-ms', '5000',
      '--quiet',
      '--json',
    ], directEnvironment({
      TOKENLESS_CODEX_BIN: executable,
      TOKENLESS_HOME: poisonHome,
      CODEX_ACCESS_TOKEN: 'must-not-reach-codex',
      CODEX_API_KEY: 'must-not-reach-codex',
      CODEX_BASE_URL: 'https://must-not-reach-codex.invalid',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://must-not-reach-codex.invalid',
      HTTPS_PROXY: 'http://must-not-reach-codex.invalid',
      NODE_OPTIONS: '--no-warnings',
      OPENAI_API_KEY: 'must-not-reach-codex',
      OPENAI_BASE_URL: 'https://must-not-reach-codex.invalid',
      TOKENLESS_DIRECT_API_KEY: 'must-not-reach-codex',
      TOKENLESS_DIRECT_CHATGPT_API_KEY: 'must-not-reach-codex',
    }))

    assert.equal(completed.code, 0, `${completed.stderr}\n${completed.stdout}`)
    assert.equal(completed.stderr, '')
    const payload = JSON.parse(completed.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.mode, 'direct')
    assert.equal(payload.backend, 'official-client')
    assert.equal(payload.transport, 'official-codex')
    assert.equal(payload.capability, 'openai.codex')
    assert.equal(payload.provider, 'chatgpt')
    assert.equal(payload.model, undefined)
    assert.equal(payload.text, 'Official Codex CLI answer')
    assert.equal(payload.result.raw.events[0].type, 'turn.completed')
    assert.equal(payload.taskId, 'direct-official-task')
    assert.equal(payload.status, 'completed')

    const invocation = JSON.parse(fs.readFileSync(invocationPath, 'utf8'))
    assert.match(invocation.stdin, /# Tokenless Request/)
    assert.match(invocation.stdin, /Answer through the official client fixture\./)
    assert.equal(path.basename(path.dirname(invocation.cwd)).startsWith('tokenless-codex-'), true)
    assert.equal(invocation.cwd.endsWith(`${path.sep}workspace`), true)
    assert.equal(invocation.args.includes('--sandbox'), false)
    assert.equal(invocation.args.includes('read-only'), false)
    assert.equal(invocation.args.includes('--ephemeral'), true)
    assert.equal(invocation.args.includes('--ignore-user-config'), true)
    assert.equal(invocation.args.includes('--ignore-rules'), true)
    assert.equal(invocation.args.includes('--strict-config'), true)
    assert.equal(invocation.args.includes('shell_environment_policy.inherit="none"'), true)
    assert.equal(invocation.args.includes('default_permissions="tokenless_direct"'), true)
    assert.equal(invocation.args.includes(officialPermissionProfile), true)
    assert.equal(invocation.args.some((value) => value.includes(':minimal')), false)
    assert.equal(invocation.args.includes('--json'), true)
    assert.deepEqual(
      invocation.args.flatMap((value, index) => (value === '--disable' ? [invocation.args[index + 1]] : [])),
      officialDisabledFeatures,
    )
    assert.deepEqual(invocation.forbiddenEnvironment, [])
    assert.equal(invocation.environment.CODEX_EXEC_SERVER_URL, 'none')
    assert.equal(invocation.environment.NODE_OPTIONS, undefined)
    assert.equal(invocation.environment.HTTPS_PROXY, undefined)
    const trace = fs.readFileSync(tracePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(trace.map(({ phase }) => phase), [
      'exec-help',
      'features-list',
      'sandbox-help',
      'sandbox-canary',
      'tool-schema',
      'authentication',
      'execution',
    ])
    assert.equal(fs.readFileSync(poisonHome, 'utf8'), 'must remain a file')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('direct mode rejects visible-only flags before provider or daemon preflight', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-direct-cli-reject-'))
  const executable = path.join(temporaryRoot, 'fake-codex.mjs')
  const marker = path.join(temporaryRoot, 'invoked')
  const poisonHome = path.join(temporaryRoot, 'home-is-a-file')
  fs.writeFileSync(poisonHome, 'must remain untouched')
  writeInvocationMarkerExecutable(executable, marker)
  try {
    const completed = await runCli([
      'run',
      '--mode', 'direct',
      '--provider', 'chatgpt',
      '--home', poisonHome,
      '--browser', 'chrome',
      '--attach-file', poisonHome,
      '--no-open',
      '--prompt', 'must not leave the CLI',
      '--json',
    ], directEnvironment({ TOKENLESS_CODEX_BIN: executable }))
    assert.equal(completed.code, 1, completed.stderr)
    const payload = JSON.parse(completed.stdout)
    assert.equal(payload.error.code, 'direct_visible_option')
    assert.match(payload.error.message, /--browser/)
    assert.match(payload.error.message, /--home/)
    assert.match(payload.error.message, /--attach-file/)
    assert.match(payload.error.message, /--no-open/)
    assert.equal(fs.existsSync(marker), false)
    assert.equal(fs.readFileSync(poisonHome, 'utf8'), 'must remain untouched')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('direct API CLI preserves bounded upstream status and request id in its error contract', async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(429, {
      'content-type': 'application/json',
      'x-request-id': 'req_cli_rate_limit',
    })
    response.end(JSON.stringify({ error: { message: 'Slow down.' } }))
  }, async (baseUrl) => {
    const completed = await runCli([
      'run',
      '--mode', 'direct',
      '--direct-backend', 'api',
      '--direct-base-url', baseUrl,
      '--provider', 'chatgpt',
      '--model', 'gpt-cli-test',
      '--prompt', 'exercise the error contract',
      '--quiet',
      '--json',
    ], directEnvironment({ TOKENLESS_DIRECT_CHATGPT_API_KEY: 'error-contract-secret' }))
    assert.equal(completed.code, 1, completed.stderr)
    const payload = JSON.parse(completed.stdout)
    assert.equal(payload.error.code, 'direct_rate_limited')
    assert.equal(payload.error.status, 429)
    assert.equal(payload.error.requestId, 'req_cli_rate_limit')
    assert.equal(payload.error.retryable, true)
    assert.equal(payload.status, 'failed')
    assert.equal(payload.statusLog.at(-1).event, 'direct_failed')
  })
})

test('run remains visible by default and never performs a direct-client preflight', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-visible-default-'))
  const executable = path.join(temporaryRoot, 'fake-codex.mjs')
  const marker = path.join(temporaryRoot, 'invoked')
  writeInvocationMarkerExecutable(executable, marker)
  try {
    const completed = await runCli([
      'run',
      '--provider', 'chatgpt',
      '--long-running',
      '--no-wait',
      '--prompt', 'stay on the visible path',
      '--json',
    ], directEnvironment({ TOKENLESS_CODEX_BIN: executable }))
    assert.equal(completed.code, 1, completed.stderr)
    const payload = JSON.parse(completed.stdout)
    assert.equal(payload.error.code, 'long_running_requires_wait')
    assert.equal(fs.existsSync(marker), false)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('direct API requires a model and direct-only options cannot be silently ignored by visible mode', async () => {
  const missingModel = await runCli([
    'run',
    '--mode', 'direct',
    '--direct-backend', 'api',
    '--provider', 'chatgpt',
    '--prompt', 'model required',
    '--quiet',
    '--json',
  ], directEnvironment({ TOKENLESS_DIRECT_CHATGPT_API_KEY: 'unused-key' }))
  assert.equal(missingModel.code, 1, missingModel.stderr)
  const missingPayload = JSON.parse(missingModel.stdout)
  assert.equal(missingPayload.error.code, 'direct_configuration_error')
  assert.match(missingPayload.error.message, /explicit model/)
  assert.equal(missingPayload.status, 'failed')
  assert.equal(missingPayload.statusLog.at(-1).event, 'direct_failed')

  const visible = await runCli([
    'run',
    '--direct-backend', 'api',
    '--prompt', 'must not charge an API',
    '--json',
  ], directEnvironment({ TOKENLESS_DIRECT_CHATGPT_API_KEY: 'unused-key' }))
  assert.equal(visible.code, 1, visible.stderr)
  const visiblePayload = JSON.parse(visible.stdout)
  assert.equal(visiblePayload.error.code, 'direct_option_requires_direct_mode')
})

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
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function streamText(stream) {
  let text = ''
  for await (const chunk of stream) text += chunk.toString('utf8')
  return text
}

function writeFakeCodex(executable, invocationPath, tracePath) {
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs'

const args = process.argv.slice(2)
const invocationPath = ${JSON.stringify(invocationPath)}
const tracePath = ${JSON.stringify(tracePath)}
const featureList = ${JSON.stringify(officialDisabledFeatures.map((feature) => `${feature} stable true`).join('\n'))}

function record(phase) {
  fs.appendFileSync(tracePath, JSON.stringify({ phase, args, environment: process.env }) + '\\n')
}

if (args[0] === 'exec' && args[1] === '--help') {
  record('exec-help')
  console.log(['--config', '--disable', '--strict-config', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--color', 'never', '--json', '--output-last-message', '--model'].join('\\n'))
  process.exit(0)
}
if (args[0] === 'features' && args[1] === 'list') {
  record('features-list')
  console.log(featureList)
  process.exit(0)
}
if (args[0] === 'sandbox' && args[1] === '--help') {
  record('sandbox-help')
  console.log(['--config', '--permission-profile', '--cd'].join('\\n'))
  process.exit(0)
}
if (args[0] === 'sandbox') {
  record('sandbox-canary')
  console.error('Operation not permitted')
  process.exit(126)
}
if (args[0] === 'exec' && args.includes('model_provider="tokenless_probe"')) {
  record('tool-schema')
  const provider = args.find((value) => value.startsWith('model_providers.tokenless_probe='))
  const baseUrl = /base_url="([^"]+)"/.exec(provider)?.[1]
  const response = await fetch(baseUrl + '/responses', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.TOKENLESS_PROBE_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.1',
      tools: [{ type: 'function', name: 'update_plan' }],
    }),
  })
  await response.text()
  process.exit(response.ok ? 0 : 65)
}
if (args[0] === 'login' && args[1] === 'status') {
  record('authentication')
  console.log('Logged in using ChatGPT')
  process.exit(0)
}
if (args[0] !== 'exec') process.exit(2)

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk.toString('utf8')
const outputIndex = args.indexOf('--output-last-message')
fs.writeFileSync(args[outputIndex + 1], 'Official Codex CLI answer\\n', 'utf8')
const forbiddenNames = [
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'CODEX_BASE_URL',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'HTTPS_PROXY',
  'NODE_OPTIONS',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'TOKENLESS_DIRECT_API_KEY',
  'TOKENLESS_DIRECT_CHATGPT_API_KEY',
]
record('execution')
fs.writeFileSync(invocationPath, JSON.stringify({
  args,
  cwd: process.cwd(),
  stdin,
  environment: process.env,
  forbiddenEnvironment: forbiddenNames.filter((name) => process.env[name] !== undefined),
}), 'utf8')
console.log(JSON.stringify({ type: 'turn.completed' }))
`, { mode: 0o755 })
}

function writeInvocationMarkerExecutable(executable, marker) {
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(marker)}, 'invoked')
`, { mode: 0o755 })
}
