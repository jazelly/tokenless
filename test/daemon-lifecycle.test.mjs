import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')
const cliIndex = path.join(cliDir, 'dist/src/index.js')
const cliPlaywrightIndex = path.join(cliDir, 'dist/src/http/managed-playwright.js')
const serverBrowserIndex = path.join(cliDir, 'dist/server/src/browser/index.js')
const packageVersion = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version

test('ensureDaemonReady installs the packaged daemon and reports OpenAPI v1 readiness', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-first-install-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000, requiredProvider: 'chatgpt' })
    pid = ready.pid
    assert.equal(ready.started, true)
    assert.equal(ready.identityVerified, true)
    assert.equal(Object.hasOwn(ready.body, 'protocol'), false)
    assert.equal(ready.body.version, packageVersion)
    assert.equal(ready.body.control_api_revision, runtime.DAEMON_CONTROL_API_REVISION)
    assert.equal(ready.binaryPath, process.execPath)
    assert.equal(fs.existsSync(ready.daemonEntryPath), true)
    assert.equal(typeof ready.body.proof, 'string')
    assert.equal(Number.isInteger(ready.body.pid), true)
    assert.equal(ready.body.pid, pid)
    const inspection = await runtime.inspectManagedRuntime(homeDir)
    assert.equal(inspection.ok, true)
    assert.equal(inspection.daemon.buildInfo.version, packageVersion)
    assert.equal(inspection.daemon.buildInfo.controlApiRevision, runtime.DAEMON_CONTROL_API_REVISION)
    assert.equal(Object.hasOwn(inspection.daemon.buildInfo, 'protocol'), false)
    assert.equal(inspection.daemon.path, ready.daemonEntryPath)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('built CLI profile, config, API proxy, and savings commands cross the private HTTP control boundary', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-http-control-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const env = { TOKENLESS_HOME: homeDir }
  let pid
  try {
    const runtime = await importCli()
    await runtime.writeTokenlessConfig({ homeDir, daemonUrl })
    const ready = await runtime.ensureDaemonReady({ homeDir, timeoutMs: 10_000 })
    pid = ready.pid
    const directState = await runtime.getControlState({ homeDir })
    assert.equal(directState.runtime.pid, pid)
    const added = runCli(['profiles', 'add', '--home', homeDir, '--profile', 'http-control', '--set-default', '--json'], env)
    assert.equal(added.status, 0, added.stderr || added.stdout)
    const addedPayload = JSON.parse(added.stdout)
    assert.equal(addedPayload.profile.slug, 'http-control')
    assert.equal(addedPayload.profile.isDefault, true)

    const duplicate = runCli(['profiles', 'add', '--home', homeDir, '--profile', 'http-control', '--json'], env)
    assert.equal(duplicate.status, 1, duplicate.stderr || duplicate.stdout)
    const duplicateError = JSON.parse(duplicate.stdout).error
    assert.equal(duplicateError.code, 'profile_already_exists')
    assert.equal(Object.hasOwn(duplicateError, 'status'), false)

    const state = await authenticatedJson(homeDir, daemonUrl, '/v1/private/control/state')
    pid = state.runtime.pid
    assert.equal(state.defaultProfile, 'http-control')
    assert.equal(state.profiles.some((profile) => profile.slug === 'http-control'), true)

    const capabilities = runCli(['capabilities', 'list', '--json'], env)
    assert.equal(capabilities.status, 0, capabilities.stderr || capabilities.stdout)
    const capabilityPayload = JSON.parse(capabilities.stdout)
    assert.equal(capabilityPayload.schema, 'tokenless.task-capability-catalog.v3')
    assert.equal(capabilityPayload.capabilities.some((capability) => capability.id === 'conversation.chat'), true)

    const route = await authenticatedJson(homeDir, daemonUrl, '/v1/private/control/execution-route', {
      method: 'POST',
      body: {
        profile: 'http-control',
        provider: 'chatgpt',
        requirements: ['conversation.chat'],
        execution_mode: 'browser',
      },
    })
    assert.equal(route.ok, true)
    assert.equal(route.profile.slug, 'http-control')
    assert.equal(route.routes[0].provider, 'chatgpt')

    const configured = runCli([
      'config',
      '--home', homeDir,
      '--profile', 'http-control',
      '--provider-whitelist', 'chatgpt,claude',
      '--json',
    ], env)
    assert.equal(configured.status, 0, configured.stderr || configured.stdout)
    assert.deepEqual(JSON.parse(configured.stdout).profile.enabledProviders, ['chatgpt', 'claude'])

    const proxy = runCli(['api-proxy', 'enable', '--home', homeDir, '--conversation-mode', 'continue-conversation', '--json'], env)
    assert.equal(proxy.status, 0, proxy.stderr || proxy.stdout)
    assert.equal(JSON.parse(proxy.stdout).apiProxy.conversationMode, 'continue-conversation')

    const savings = runCli(['savings', 'status', '--home', homeDir, '--json'], env)
    assert.equal(savings.status, 0, savings.stderr || savings.stdout)
    const savingsPayload = JSON.parse(savings.stdout).outputSavings
    assert.equal(savingsPayload.estimator, 'o200k_base')
    assert.equal(savingsPayload.summary.response_count, 0)
    assert.equal(Object.hasOwn(savingsPayload.summary, 'responseCount'), false)

    const removed = runCli([
      'profiles',
      'remove',
      '--home', homeDir,
      '--profile', 'http-control',
      '--confirm-delete',
      '--json',
    ], env)
    assert.equal(removed.status, 0, removed.stderr || removed.stdout)
    assert.deepEqual(JSON.parse(removed.stdout).profile, { slug: 'http-control', removed: true })

    const stopped = await runtime.stopDaemon({ homeDir })
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.pid, pid)
    assert.equal(await pidExited(pid), true)
    const repeated = runCli(['daemon', 'stop', '--home', homeDir, '--json'], env)
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout)
    assert.equal(JSON.parse(repeated.stdout).status, 'not_running')
    pid = undefined
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('ensureDaemonReady never restarts a healthy daemon for a provider absent from the local registry', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-provider-reconcile-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const runtime = await importCli()
  let pid
  try {
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000, requiredProvider: 'chatgpt' })
    pid = ready.pid
    assert.equal(ready.body.version, packageVersion)

    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000, requiredProvider: 'not-a-provider' }),
      (error) => {
        assert.equal(error.code, 'daemon_provider_unsupported')
        assert.match(error.message, /not-a-provider/)
        return true
      }
    )
    assert.equal(await pidExited(pid), false)
    const afterFailure = await runtime.probeDaemonReady({ homeDir, daemonUrl, timeoutMs: 500 })
    assert.equal(afterFailure.ok, true)
    assert.equal(afterFailure.body.pid, pid)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('built client rejects oversized daemon requests', async () => {
  const runtime = await importCli()
  await assert.rejects(
    runtime.createDaemonJob({
      daemonUrl: 'http://127.0.0.1:9',
      provider: 'chatgpt',
      action: 'prompt.submit',
      requestJson: {
        prompt: 'x'.repeat(runtime.MAX_DAEMON_REQUEST_BYTES + 1),
      },
    }),
    (error) => {
      assert.equal(error.code, 'daemon_request_too_large')
      assert.match(error.message, new RegExp(`keep it below ${runtime.MAX_DAEMON_REQUEST_BYTES} bytes`))
      return true
    }
  )
})

test('ensureDaemonReady gracefully replaces a proof-verified same-home version mismatch', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-version-replace-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const token = 'same-home-version-mismatch-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  const fake = await startReadyOnlyDaemon({
    homeDir,
    daemonUrl,
    token,
    version: '0.2.0',
  })
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = ready.pid
    assert.equal(fake.shutdownCount, 1)
    assert.notEqual(pid, fake.pid)
    assert.equal(ready.started, true)
    assert.equal(ready.body.version, packageVersion)
    assert.equal(Object.hasOwn(ready.body, 'protocol'), false)
  } finally {
    await fake.close()
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('ensureDaemonReady fails clearly when the fixed daemon port is already bound', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-foreign-listener-')))
  const foreignHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-foreign-home-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), 'requested-home-token\n', { mode: 0o600 })
  const fake = await startReadyOnlyDaemon({
    homeDir: foreignHome,
    daemonUrl,
    token: 'foreign-home-token',
    version: packageVersion,
  })
  try {
    const runtime = await importCli()
    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir, daemonUrl: 'http://127.0.0.1:0', timeoutMs: 2_000 }),
      (error) => {
        assert.equal(error.code, 'invalid_daemon_url')
        return true
      },
    )
    fs.writeFileSync(path.join(homeDir, 'config.json'), `${JSON.stringify({
      protocol: 'tokenless.config.v1',
      daemonUrl: 'http://127.0.0.1:0',
    })}\n`, { mode: 0o600 })
    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir, timeoutMs: 2_000 }),
      (error) => {
        assert.equal(error.code, 'tokenless_config_invalid')
        return true
      },
    )
    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 2_000 }),
      (error) => {
        assert.equal(error.code, 'daemon_start_failed')
        return true
      },
    )
    assert.equal(fake.shutdownCount, 0)
    assert.equal(await tcpReachable(daemonUrl), true)
  } finally {
    await fake.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(foreignHome, { recursive: true, force: true })
  }
})

test('playwright daemon client verifies /ready before sending the bearer token', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-client-ready-auth-')))
  const foreignHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-client-foreign-home-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), 'requested-home-token\n', { mode: 0o600 })
  const fake = await startReadyOnlyDaemon({
    homeDir: foreignHome,
    daemonUrl,
    token: 'foreign-home-token',
    version: packageVersion,
  })
  try {
    const playwright = await importPlaywright()
    const runtime = await importCli()
    await assert.rejects(
      runtime.createDaemonJob({
        homeDir,
        daemonUrl,
        provider: 'chatgpt',
        action: 'visible_provider_actions',
        requestJson: {},
        profileId: 'default',
      }),
      (error) => {
        assert.equal(error.code, 'daemon_ready_proof_mismatch')
        return true
      }
    )
    assert.deepEqual(fake.readyAuthorizationHeaders, [undefined])

    await assert.rejects(
      playwright.submitManagedPlaywrightJob({
        homeDir,
        daemonUrl,
        profileId: 'default',
        request: {
          provider: 'chatgpt',
          browserVisibility: 'headed',
          taskId: 'ready-auth-test',
          actions: [
            { requestId: 'ready-auth-test:auth', action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} },
          ],
        },
      }),
      (error) => {
        assert.equal(error.code, 'daemon_ready_proof_mismatch')
        return true
      }
    )
    assert.deepEqual(fake.readyAuthorizationHeaders, [undefined, undefined])
    assert.deepEqual(fake.jobAuthorizationHeaders, [])
  } finally {
    await fake.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(foreignHome, { recursive: true, force: true })
  }
})

test('doctor is read-only for an uninitialized Tokenless home', () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-doctor-readonly-parent-')))
  const homeDir = path.join(parent, 'missing-home')
  const result = runCli(['doctor', '--home', homeDir, '--daemon-url', 'http://127.0.0.1:9', '--json'])
  try {
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.runtime, 'typescript')
    assert.equal(payload.checks.daemon.ready, false)
    assert.equal(payload.checks.daemon.daemonLogPath, path.join(homeDir, 'daemon.log'))
    assert.equal(payload.checks.daemon.daemonLogExists, false)
    assert.equal(payload.checks.runner.state, 'stopped')
    assert.equal(payload.checks.managedProfile.ok, false)
    assert.deepEqual(payload.checks.outputSavings, {
      ok: true,
      enabled: true,
      collection: 'unavailable',
      runtime: {
        runtimeId: 'tiktoken-o200k_base-1.0.22',
        state: 'not_installed',
        installed: false,
        downloadBytes: 10611708,
        installedBytes: 3413323,
      },
    })
    assert.equal(fs.existsSync(homeDir), false, result.stdout)
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('doctor reports a saved but unusable browser executable path as incomplete configuration', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-doctor-browser-path-')))
  const configuredPath = path.join(homeDir, 'missing-google-chrome')
  fs.writeFileSync(path.join(homeDir, 'config.json'), `${JSON.stringify({
    protocol: 'tokenless.config.v1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    profiles: {},
    browser: 'chrome',
    browserExecutablePath: configuredPath,
    browserVisibility: 'headed',
    daemonUrl: null,
    language: 'en',
    outputSavings: { enabled: true },
  }, null, 2)}\n`, { mode: 0o600 })
  const before = snapshotTree(homeDir)
  try {
    const result = runCli(['doctor', '--home', homeDir, '--daemon-url', 'http://127.0.0.1:9', '--json'])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.checks.config.ok, true)
    assert.equal(payload.checks.configuration.ok, false)
    assert.equal(payload.checks.configuration.complete, false)
    assert.deepEqual(payload.checks.configuration.browser, {
      selection: 'chrome',
      executablePathConfigured: true,
      executablePathValid: false,
      resolved: payload.checks.browser.ok,
    })
    const issue = payload.checks.configuration.issues.find((candidate) => candidate.code === 'browser_executable_path_unusable')
    assert.equal(issue.message.includes(configuredPath), true)
    assert.match(issue.nextAction, /--browser-executable-path/)
    assert.deepEqual(snapshotTree(homeDir), before)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('daemon stop is idempotent when no daemon is listening', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-stop-not-running-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    const result = runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'not_running')
    assert.equal(payload.url, daemonUrl)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('daemon stop uses bearer-authenticated self-shutdown for a verified daemon', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-stop-self-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = ready.pid
    const result = runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'stopped')
    assert.equal(payload.pid, pid)
    assert.equal(await pidExited(pid), true)
    const repeated = runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout)
    assert.equal(JSON.parse(repeated.stdout).status, 'not_running')
    pid = undefined
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('daemon shutdown endpoint uses bearer authentication', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-bearer-shutdown-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = ready.pid
    const controlToken = await runtime.readDaemonToken({ homeDir })

    const missing = await fetch(`${daemonUrl}/v1/private/control/shutdown`, { method: 'POST' })
    assert.equal(missing.status, 401)
    const missingBody = await missing.json()
    assert.equal(Object.hasOwn(missingBody.error, 'protocol'), false)
    assert.equal(missingBody.error.code, 'control_auth_missing')

    const rejected = await fetch(`${daemonUrl}/v1/private/control/shutdown`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(rejected.status, 403)
    const rejectedBody = await rejected.json()
    assert.equal(Object.hasOwn(rejectedBody.error, 'protocol'), false)
    assert.equal(rejectedBody.error.code, 'control_auth_rejected')
    assert.equal(JSON.stringify(rejectedBody).includes(controlToken), false)
    assert.equal((await runtime.probeDaemonReady({ homeDir, daemonUrl })).ok, true)

    const accepted = await fetch(`${daemonUrl}/v1/private/control/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${controlToken}` },
    })
    assert.equal(accepted.status, 200)
    const acceptedBody = await accepted.json()
    assert.equal(acceptedBody.status, 'shutting_down')
    assert.equal(await pidExited(pid), true)
    pid = undefined
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('doctor reports authenticated embedded browser runtime status for a ready TypeScript daemon', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-doctor-embedded-runtime-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = ready.pid

    const result = runCli(['doctor', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.runtime, 'typescript')
    assert.equal(payload.checks.daemon.ready, true)
    assert.equal(payload.checks.daemon.pid, pid)
    assert.equal(payload.checks.runner.runtime, 'embedded')
    assert.equal(payload.checks.runner.runtimeStatus, 'running')
    assert.equal(payload.checks.runner.state, 'running')
    assert.equal(payload.checks.runner.pid, pid)
    assert.equal(payload.checks.runner.sessionId, 'embedded')
    assert.equal(payload.checks.runner.safeToStop, false)
    assert.equal(payload.checks.runner.activeProfileCount, 0)
    assert.equal(payload.checks.runner.activeJobCount, 0)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  })
}

async function authenticatedJson(homeDir, daemonUrl, requestPath, options = {}) {
  const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
  const response = await fetch(`${daemonUrl}${requestPath}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  assert.equal(response.status, 200)
  return await response.json()
}

async function importCli() {
  return await import(`${pathToFileURL(cliIndex).href}?daemon_lifecycle=${Date.now()}_${Math.random()}`)
}

async function importPlaywright() {
  const cacheKey = `daemon_lifecycle=${Date.now()}_${Math.random()}`
  const [client, browser] = await Promise.all([
    import(`${pathToFileURL(cliPlaywrightIndex).href}?${cacheKey}`),
    import(`${pathToFileURL(serverBrowserIndex).href}?${cacheKey}`),
  ])
  return { ...browser, ...client }
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function startReadyOnlyDaemon({ homeDir, daemonUrl, token, version }) {
  const url = new URL(daemonUrl)
  let shutdownCount = 0
  let closed = false
  const readyAuthorizationHeaders = []
  const jobAuthorizationHeaders = []
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', daemonUrl)
    if (request.method === 'GET' && requestUrl.pathname === '/ready') {
      readyAuthorizationHeaders.push(request.headers.authorization)
      const challenge = requestUrl.searchParams.get('challenge') ?? ''
      writeJson(response, 200, {
        version,
        ready: true,
        home_dir: homeDir,
        pid: process.pid,
        proof: readyProof(token, challenge, homeDir),
      })
      return
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/private/jobs') {
      jobAuthorizationHeaders.push(request.headers.authorization)
      writeJson(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && requestUrl.pathname === '/v1/private/control/shutdown') {
      if (request.headers.authorization !== `Bearer ${token}`) {
        writeJson(response, 403, { error: { message: 'forbidden' } })
        return
      }
      shutdownCount += 1
      writeJson(response, 200, { ok: true, status: 'shutting_down', pid: process.pid })
      setImmediate(() => {
        void closeServer()
      })
      return
    }
    writeJson(response, 404, { error: { message: 'not found' } })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(url.port), url.hostname, resolve)
  })
  return {
    pid: process.pid,
    get shutdownCount() {
      return shutdownCount
    },
    get readyAuthorizationHeaders() {
      return readyAuthorizationHeaders
    },
    get jobAuthorizationHeaders() {
      return jobAuthorizationHeaders
    },
    close: closeServer,
  }

  function closeServer() {
    if (closed) return Promise.resolve()
    closed = true
    return closeHttpServer(server)
  }
}

function closeHttpServer(server) {
  const closing = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  server.closeAllConnections()
  return closing
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function readyProof(token, challenge, homeDir) {
  return createHmac('sha256', token)
    .update(lengthPrefixedMessage([
      challenge,
      homeDir,
    ]))
    .digest('base64url')
}

function lengthPrefixedMessage(fields) {
  return Buffer.concat(fields.flatMap((field) => {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    return [length, value]
  }))
}

async function tcpReachable(daemonUrl) {
  const url = new URL(daemonUrl)
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) })
    const done = (reachable) => {
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(500, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function stopPid(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  for (let index = 0; index < 50; index += 1) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      return
    }
  }
}

async function pidExited(pid) {
  for (let index = 0; index < 50; index += 1) {
    if (!pidIsAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !pidIsAlive(pid)
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function snapshotTree(rootDir) {
  const entries = {}
  visit(rootDir)
  return entries

  function visit(current) {
    const stat = fs.statSync(current)
    const relative = path.relative(rootDir, current) || '.'
    entries[relative] = {
      mode: stat.mode & 0o777,
      size: stat.size,
      contentHash: stat.isFile() ? createHash('sha256').update(fs.readFileSync(current)).digest('hex') : null,
    }
    if (!stat.isDirectory()) return
    for (const child of fs.readdirSync(current).sort()) {
      visit(path.join(current, child))
    }
  }
}
