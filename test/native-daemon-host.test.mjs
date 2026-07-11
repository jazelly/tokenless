import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const cliIndex = path.join(root, 'packages/cli/dist/src/index.js')

test('daemon client accepts loopback only', async () => {
  const { daemonUrl } = await importCli()
  for (const url of [
    'http://192.168.1.10:7331',
    'https://127.0.0.1:7331',
    'http://example.com:7331',
    'not-a-url',
  ]) {
    assert.throws(() => daemonUrl(url), /loopback HTTP URL/)
  }
  assert.equal(daemonUrl('http://127.0.0.1:7331/'), 'http://127.0.0.1:7331')
  assert.equal(daemonUrl('http://localhost:7331'), 'http://localhost:7331')
  assert.equal(daemonUrl('http://[::1]:7331'), 'http://[::1]:7331')
})

test('ready probe rejects either daemon or native protocol mismatch', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-ready-protocol-'))
  const { DAEMON_PROTOCOL, NATIVE_PROTOCOL, probeDaemonReady } = await importCli()
  const token = 'ready-protocol-test-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  let readyBody = {
    ready: true,
    home_dir: fs.realpathSync(homeDir),
    daemon_protocol: DAEMON_PROTOCOL,
    native_protocol: NATIVE_PROTOCOL,
  }
  const server = http.createServer((request, response) => {
    const challenge = new URL(request.url, 'http://127.0.0.1').searchParams.get('challenge')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(signedReadyBody(readyBody, challenge, token)))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const daemonUrl = `http://127.0.0.1:${address.port}`
  try {
    readyBody = { ...readyBody, daemon_protocol: 'tokenless.daemon.v999' }
    const daemonMismatch = await probeDaemonReady({ homeDir, daemonUrl })
    assert.equal(daemonMismatch.ok, false)
    assert.equal(daemonMismatch.code, 'daemon_protocol_mismatch')

    readyBody = {
      ...readyBody,
      daemon_protocol: DAEMON_PROTOCOL,
      native_protocol: 'tokenless.native.v999',
    }
    const nativeMismatch = await probeDaemonReady({ homeDir, daemonUrl })
    assert.equal(nativeMismatch.ok, false)
    assert.equal(nativeMismatch.code, 'native_protocol_mismatch')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('spoofed ready proof cannot capture bearer token or job prompt through CLI or exported client', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-ready-spoof-'))
  const victimToken = 'victim-home-token'
  const secretPrompt = 'NEVER_SEND_PROMPT_TO_UNPROVED_DAEMON'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${victimToken}\n`, { mode: 0o600 })
  const captured = []
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1')
    const body = await streamText(request)
    captured.push({
      url: requestUrl.pathname,
      authorization: request.headers.authorization,
      body,
    })
    if (requestUrl.pathname === '/ready') {
      respondJson(response, 200, signedReadyBody({
        ready: true,
        home_dir: fs.realpathSync(homeDir),
        daemon_protocol: 'tokenless.daemon.v1',
        native_protocol: 'tokenless.native.v1',
      }, requestUrl.searchParams.get('challenge'), 'attacker-token'))
      return
    }
    respondJson(response, 200, {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const daemonUrl = `http://127.0.0.1:${address.port}`
  try {
    const child = spawn(process.execPath, [
      cliEntry,
      'run',
      '--prompt',
      secretPrompt,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--no-open',
      '--json',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const completed = await waitForChild(child)
    assert.equal(completed.code, 1, completed.stderr)
    assert.equal(JSON.parse(completed.stdout).error.code, 'daemon_ready_proof_mismatch')

    const { createDaemonJob } = await importCli()
    await assert.rejects(
      createDaemonJob({
        homeDir,
        daemonUrl,
        provider: 'chatgpt',
        action: 'submit_and_read',
        requestJson: { prompt: secretPrompt },
      }),
      (error) => error.code === 'daemon_ready_proof_mismatch'
    )
    assert.equal(captured.every((request) => request.authorization === undefined), true)
    assert.equal(captured.every((request) => !request.body.includes(secretPrompt)), true)
    assert.deepEqual([...new Set(captured.map((request) => request.url))], ['/ready'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('ready proof is bound to each fresh challenge and rejects replay', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-ready-replay-'))
  const token = 'replay-test-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  let replayedBody
  const server = http.createServer((request, response) => {
    const challenge = new URL(request.url, 'http://127.0.0.1').searchParams.get('challenge')
    replayedBody ??= signedReadyBody({
      ready: true,
      home_dir: fs.realpathSync(homeDir),
      daemon_protocol: 'tokenless.daemon.v1',
      native_protocol: 'tokenless.native.v1',
    }, challenge, token)
    respondJson(response, 200, replayedBody)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const daemonUrl = `http://127.0.0.1:${address.port}`
  try {
    const { probeDaemonReady } = await importCli()
    assert.equal((await probeDaemonReady({ homeDir, daemonUrl })).ok, true)
    const replay = await probeDaemonReady({ homeDir, daemonUrl })
    assert.equal(replay.ok, false)
    assert.equal(replay.code, 'daemon_ready_proof_missing')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('ensureDaemonReady starts one packaged Rust daemon under concurrent callers and verifies home identity', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-auto-daemon-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const { DAEMON_PROTOCOL, ensureDaemonReady, probeDaemonReady } = await importCli()
  let pid
  try {
    const results = await Promise.all([
      ensureDaemonReady({ homeDir, daemonUrl }),
      ensureDaemonReady({ homeDir, daemonUrl }),
    ])
    assert.equal(results.filter((result) => result.started).length, 1)
    pid = results.find((result) => result.pid)?.pid
    assert.ok(Number.isInteger(pid))
    assert.equal(new Set(results.map((result) => result.pid)).size, 1)
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.pid.json')), true)
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.log')), true)
    const ready = await probeDaemonReady({ homeDir, daemonUrl })
    assert.equal(ready.ok, true)
    assert.equal(ready.body.daemon_protocol, DAEMON_PROTOCOL)
    assert.equal(ready.body.native_protocol, 'tokenless.native.v1')
    assert.equal(ready.actualHome, fs.realpathSync(homeDir))

    const wrongHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-wrong-home-'))
    try {
      fs.copyFileSync(path.join(homeDir, 'daemon.token'), path.join(wrongHome, 'daemon.token'))
      const mismatch = await probeDaemonReady({ homeDir: wrongHome, daemonUrl })
      assert.equal(mismatch.ok, false)
      assert.equal(mismatch.code, 'daemon_home_mismatch')
      await assert.rejects(
        ensureDaemonReady({ homeDir: wrongHome, daemonUrl }),
        (error) => error.code === 'daemon_home_mismatch'
      )
    } finally {
      fs.rmSync(wrongHome, { recursive: true, force: true })
    }
  } finally {
    await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('run is daemon-only and --no-open fails before job creation when bridge is absent', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-no-bridge-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const result = spawnSync(process.execPath, [
      cliEntry,
      'run',
      '--prompt',
      'must not queue',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--no-open',
      '--no-wait',
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'extension_bridge_unavailable')
    assert.match(payload.error.message, /No live Tokenless extension bridge/)
    assert.equal(payload.statusLog.some((event) => event.event === 'bridge_missing'), true)
    assert.doesNotMatch(result.stdout, /taskUrl|chrome-extension:\/\//)

    const ready = await fetch(`${daemonUrl}/health`).then((response) => response.json())
    pid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    assert.equal(ready.home_dir, fs.realpathSync(homeDir))
    const jobs = await fetch(`${daemonUrl}/jobs`, {
      headers: daemonAuthorization(homeDir),
    }).then((response) => response.json())
    assert.deepEqual(jobs, [])
    assert.equal(fs.existsSync(path.join(homeDir, 'jobs')), false)
  } finally {
    await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('run needs no extension id, skips wake with live bridge, and state reads daemon metadata', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-live-bridge-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const { ensureDaemonReady } = await importCli()
  let pid
  try {
    const daemon = await ensureDaemonReady({ homeDir, daemonUrl })
    pid = daemon.pid
    writeLiveBridge(homeDir)
    const run = spawnSync(process.execPath, [
      cliEntry,
      'run',
      '--prompt',
      'hello through daemon only',
      '--project-name',
      'Tokenless',
      '--chat-name',
      'Daemon state',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--no-open',
      '--no-wait',
      '--json',
    ], {
      cwd: root,
      env: { ...process.env, TOKENLESS_EXTENSION_ID: '' },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    const payload = JSON.parse(run.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.transport, 'daemon')
    assert.equal(payload.provider, 'chatgpt')
    assert.equal(payload.taskId, 'project:Tokenless:chat:Daemon state')
    assert.equal(payload.statusLog.some((event) => event.event === 'bridge_ready'), true)
    assert.equal(payload.statusLog.some((event) => event.event === 'provider_opened'), false)
    assert.doesNotMatch(run.stdout, /taskUrl|requestPath|chrome-extension:\/\//)

    const daemonJob = await fetch(`${daemonUrl}/jobs/${encodeURIComponent(payload.jobId)}`, {
      headers: daemonAuthorization(homeDir),
    }).then((response) => response.json())
    assert.equal(daemonJob.status, 'queued')
    assert.equal(daemonJob.request_json.targetUrl, 'https://chatgpt.com/')
    assert.equal(daemonJob.request_json.taskId, payload.taskId)
    assert.match(daemonJob.request_json.prompt, /hello through daemon only/)
    assert.equal(fs.existsSync(path.join(homeDir, 'jobs')), false)

    const state = spawnSync(process.execPath, [
      cliEntry,
      'state',
      '--task-id',
      payload.taskId,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(state.status, 0, state.stderr)
    const statePayload = JSON.parse(state.stdout)
    assert.equal(statePayload.transport, 'daemon')
    assert.equal(statePayload.latest.jobId, payload.jobId)
    assert.equal(statePayload.latest.status, 'queued')
    assert.equal(statePayload.latest.state.actor, 'tokenless-daemon')
    assert.equal(statePayload.latest.result, null)
    assert.equal(statePayload.latest.prompt, undefined)
    assert.equal(statePayload.latest.claimToken, undefined)
  } finally {
    await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('state uses daemon-side task filtering and preserves error_json on failed jobs', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-error-state-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const { createDaemonJob, ensureDaemonReady } = await importCli()
  let pid
  try {
    const daemon = await ensureDaemonReady({ homeDir, daemonUrl })
    pid = daemon.pid
    const failed = await createDaemonJob({
      homeDir,
      daemonUrl,
      provider: 'chatgpt',
      action: 'submit_and_read',
      requestJson: {
        taskId: 'task-with-preserved-error',
        metadata: { taskId: 'task-with-preserved-error' },
      },
    })
    const claimed = await claimNextJob(homeDir, daemonUrl, 'submit_and_read')
    assert.equal(claimed.job.job_id, failed.job_id)
    const expectedError = {
      code: 'provider_blocker_visible',
      message: 'Visible provider asked for user action.',
      retryable: false,
    }
    await failJob(homeDir, daemonUrl, claimed.job, expectedError)

    // Newer unrelated jobs would hide the target under the old finite local scan.
    for (let index = 0; index < 12; index += 1) {
      await createDaemonJob({
        homeDir,
        daemonUrl,
        provider: 'chatgpt',
        action: 'submit_and_read',
        requestJson: { taskId: `unrelated-${index}` },
      })
    }
    await createDaemonJob({
      homeDir,
      daemonUrl,
      provider: 'claude',
      action: 'submit_and_read',
      requestJson: { taskId: 'task-with-preserved-error' },
    })
    const state = spawnSync(process.execPath, [
      cliEntry,
      'state',
      '--task-id',
      'task-with-preserved-error',
      '--limit',
      '1',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(state.status, 0, state.stderr)
    const payload = JSON.parse(state.stdout)
    assert.equal(payload.latest.jobId, failed.job_id)
    assert.equal(payload.latest.status, 'failed')
    assert.deepEqual(payload.latest.error, expectedError)
    assert.deepEqual(payload.latest.state.error, expectedError)
    assert.deepEqual(payload.latest.result.error, expectedError)
    assert.equal(payload.latest.result.value, null)
  } finally {
    await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('cancel command reports only daemon-confirmed cancellation', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-explicit-cancel-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const { createDaemonJob, ensureDaemonReady, getDaemonJob } = await importCli()
  let pid
  try {
    const daemon = await ensureDaemonReady({ homeDir, daemonUrl })
    pid = daemon.pid
    const created = await createDaemonJob({
      homeDir,
      daemonUrl,
      provider: 'chatgpt',
      action: 'submit_and_read',
      requestJson: { taskId: 'explicit-cancel' },
    })
    const canceled = spawnSync(process.execPath, [
      cliEntry,
      'cancel',
      '--job-id',
      created.job_id,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(canceled.status, 0, canceled.stderr)
    const payload = JSON.parse(canceled.stdout)
    assert.equal(payload.status, 'canceled')
    assert.equal(payload.error.code, 'job_canceled')
    assert.equal(payload.error.reason.code, 'user_requested')
    assert.equal((await getDaemonJob({ homeDir, daemonUrl, jobId: created.job_id })).status, 'canceled')

    const repeated = spawnSync(process.execPath, [
      cliEntry,
      'cancel',
      '--job-id',
      created.job_id,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(repeated.status, 1)
    assert.equal(JSON.parse(repeated.stdout).error.code, 'job_cancel_failed')
    assert.match(JSON.parse(repeated.stdout).error.message, /not confirmed.*may still be running or may already have completed/)
  } finally {
    await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('SIGINT confirms cancellation while SIGTERM cancellation failure reports that the job may continue', {
  skip: process.platform === 'win32' && 'POSIX signal delivery is not portable to Windows child processes.',
}, async () => {
  for (const scenario of [
    { signal: 'SIGINT', cancelMode: 'delayed-success', cancelTimeoutMs: 1000, expectedCode: 'job_interrupted', expectedEvent: 'cancel_confirmed' },
    { signal: 'SIGTERM', cancelMode: 'hang', cancelTimeoutMs: 100, expectedCode: 'job_cancel_failed', expectedEvent: 'cancel_failed' },
  ]) {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-signal-cancel-'))
    const fake = await startSignalDaemon(homeDir, scenario.cancelMode)
    writeLiveBridge(homeDir)
    const child = spawn(process.execPath, [
      cliEntry,
      'run',
      '--prompt',
      'wait for a cancellation signal',
      '--home',
      homeDir,
      '--daemon-url',
      fake.daemonUrl,
      '--no-open',
      '--timeout-ms',
      '10000',
      '--cancel-timeout-ms',
      String(scenario.cancelTimeoutMs),
      '--json',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const completion = waitForChild(child)
    try {
      await waitUntil(() => fake.pollingStarted, 5000, 'CLI did not begin polling the fake daemon job.')
      assert.equal(child.kill(scenario.signal), true)
      const completed = await completion
      assert.equal(completed.code, 1, completed.stderr)
      const payload = JSON.parse(completed.stdout)
      assert.equal(payload.error.code, scenario.expectedCode)
      assert.equal(payload.statusLog.some((event) => event.event === scenario.expectedEvent), true)
      if (scenario.cancelMode === 'delayed-success') {
        assert.match(payload.error.message, /cancellation was confirmed/)
      } else {
        assert.match(payload.error.message, /not confirmed.*may still be running or may already have completed/)
        assert.equal(fake.jobStatus, 'running')
        const explicit = spawn(process.execPath, [
          cliEntry,
          'cancel',
          '--job-id',
          'signal-job',
          '--home',
          homeDir,
          '--daemon-url',
          fake.daemonUrl,
          '--cancel-timeout-ms',
          '100',
          '--json',
        ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
        const explicitResult = await waitForChild(explicit)
        assert.equal(explicitResult.code, 1, explicitResult.stderr)
        assert.equal(JSON.parse(explicitResult.stdout).error.code, 'job_cancel_failed')
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await fake.close()
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  }
})

test('bridge wake opens only ChatGPT HTTPS by default and never emits a task URL', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-wake-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const launcher = createFakeBrowserLauncher(homeDir)
  const { ensureDaemonReady } = await importCli()
  let pid
  try {
    const daemon = await ensureDaemonReady({ homeDir, daemonUrl })
    pid = daemon.pid
    const env = fakeBrowserEnv(homeDir, launcher)
    const run = spawnSync(process.execPath, [
      cliEntry,
      'run',
      '--prompt',
      'wake ChatGPT safely',
      '--browser',
      'profile',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--bridge-timeout-ms',
      '3000',
      '--no-wait',
      '--json',
    ], { cwd: root, env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const payload = JSON.parse(run.stdout)
    assert.equal(fs.readFileSync(path.join(homeDir, 'opened-url.txt'), 'utf8'), 'https://chatgpt.com/')
    const opened = payload.statusLog.find((event) => event.event === 'provider_opened')
    assert.equal(opened.providerUrl, 'https://chatgpt.com/')
    assert.equal(opened.browser, 'profile')
    assert.doesNotMatch(run.stdout, /taskUrl|chrome-extension:\/\/|file:\/\//)

    fs.rmSync(path.join(homeDir, 'extension-bridge.json'), { force: true })
    fs.rmSync(path.join(homeDir, 'opened-url.txt'), { force: true })
    const rejected = spawnSync(process.execPath, [
      cliEntry,
      'run',
      '--prompt',
      'do not open attacker URL',
      '--target-url',
      'https://example.com/attack',
      '--browser',
      'profile',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--no-wait',
      '--json',
    ], { cwd: root, env, encoding: 'utf8' })
    assert.equal(rejected.status, 1)
    assert.equal(JSON.parse(rejected.stdout).error.code, 'invalid_provider_url')
    assert.equal(fs.existsSync(path.join(homeDir, 'opened-url.txt')), false)
  } finally {
    await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('snapshot-dom persists sanitized daemon result artifacts without a task page', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-snapshot-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const { ensureDaemonReady } = await importCli()
  let pid
  let child
  try {
    const daemon = await ensureDaemonReady({ homeDir, daemonUrl })
    pid = daemon.pid
    writeLiveBridge(homeDir)
    child = spawn(process.execPath, [
      cliEntry,
      'snapshot-dom',
      '--provider',
      'chatgpt',
      '--include-text',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--no-open',
      '--timeout-ms',
      '10000',
      '--json',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const job = await waitForQueuedJob(homeDir, daemonUrl, child)
    const claimed = await claimNextJob(homeDir, daemonUrl, 'snapshot_dom')
    assert.equal(claimed.job.job_id, job.job_id)
    await completeJob(homeDir, daemonUrl, claimed.job, {
      status: 'snapshotted',
      provider: 'chatgpt',
      url: 'https://chatgpt.com/',
      title: 'Visible ChatGPT',
      capturedAt: new Date().toISOString(),
      sanitized: true,
      includeText: true,
      html: '<!doctype html><html><body>[redacted]</body></html>',
      selectorProbes: { composer: true },
      visibleText: 'Visible safe text',
    })
    const completed = await waitForChild(child)
    assert.equal(completed.code, 0, completed.stderr)
    const payload = JSON.parse(completed.stdout)
    assert.equal(payload.transport, 'daemon')
    assert.equal(payload.snapshot.sanitized, true)
    assert.equal(fs.existsSync(payload.snapshot.htmlPath), true)
    assert.equal(fs.existsSync(payload.snapshot.selectorProbesPath), true)
    assert.equal(fs.existsSync(payload.snapshot.visibleTextPath), true)
    assert.match(fs.readFileSync(payload.snapshot.htmlPath, 'utf8'), /\[redacted\]/)
    assert.doesNotMatch(completed.stdout, /taskUrl|chrome-extension:\/\//)
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM')
    await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('install and doctor report direct Rust binaries, daemon readiness, manifest, config, and bridge', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-doctor-'))
  const manifestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-doctor-manifest-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const launcher = createFakeBrowserLauncher(homeDir)
  const env = fakeBrowserEnv(homeDir, launcher)
  let pid
  try {
    const install = spawnSync(process.execPath, [
      cliEntry,
      'install',
      '--extension-id',
      'abcdefghijklmnopabcdefghijklmnop',
      '--browser',
      'profile',
      '--manifest-home',
      manifestHome,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { cwd: root, env, encoding: 'utf8' })
    assert.equal(install.status, 0, install.stderr)
    const installed = JSON.parse(install.stdout)
    pid = installed.daemon.pid
    assert.equal(installed.runtime, 'rust')
    assert.equal(installed.nativeHost.runtime, 'rust')
    assert.match(installed.nativeHost.executable, /tokenless-native-host(?:\.exe)?$/)
    assert.match(installed.daemon.executable, /tokenless-daemon(?:\.exe)?$/)
    assert.equal(installed.nativeHost.manifests.length, 1)
    const manifest = JSON.parse(fs.readFileSync(installed.nativeHost.manifests[0], 'utf8'))
    assert.equal(manifest.path, installed.nativeHost.executable)
    assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'])

    const packagedNativeHost = fs.readFileSync(installed.nativeHost.executable)
    const validConfig = fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')
    fs.writeFileSync(installed.nativeHost.executable, 'stale native host')
    if (process.platform !== 'win32') fs.chmodSync(installed.nativeHost.executable, 0o755)
    writeLiveBridge(homeDir)
    fs.writeFileSync(path.join(homeDir, 'config.json'), '{ invalid config json')
    const malformedConfigDoctor = spawnSync(process.execPath, [
      cliEntry,
      'doctor',
      '--browser',
      'profile',
      '--manifest-home',
      manifestHome,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { cwd: root, env, encoding: 'utf8' })
    assert.equal(malformedConfigDoctor.status, 1, malformedConfigDoctor.stderr)
    const malformedPayload = JSON.parse(malformedConfigDoctor.stdout)
    assert.equal(malformedPayload.checks.runtimeRefresh.ok, true)
    assert.equal(malformedPayload.checks.runtimeRefresh.refreshed.includes(installed.nativeHost.executable), true)
    assert.equal(malformedPayload.checks.config.ok, false)
    assert.equal(Buffer.compare(fs.readFileSync(installed.nativeHost.executable), packagedNativeHost), 0)
    fs.writeFileSync(path.join(homeDir, 'config.json'), validConfig)

    const doctor = spawnSync(process.execPath, [
      cliEntry,
      'doctor',
      '--browser',
      'profile',
      '--manifest-home',
      manifestHome,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { cwd: root, env, encoding: 'utf8' })
    assert.equal(doctor.status, 0, doctor.stderr)
    const payload = JSON.parse(doctor.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.runtime, 'rust')
    assert.equal(payload.checks.runtimeRefresh.ok, true)
    assert.equal(payload.checks.rustBinaries.ok, true)
    assert.equal(payload.checks.daemon.ok, true)
    assert.equal(payload.checks.daemon.daemonProtocol, 'tokenless.daemon.v1')
    assert.equal(payload.checks.daemon.nativeProtocol, 'tokenless.native.v1')
    assert.equal(payload.checks.nativeHostManifests.ok, true)
    assert.equal(payload.checks.config.value.browser, 'profile')
    assert.equal(payload.checks.extensionBridge.ok, true)

    fs.rmSync(path.join(homeDir, 'extension-bridge.json'))
    const failedDoctor = spawnSync(process.execPath, [
      cliEntry,
      'doctor',
      '--browser',
      'profile',
      '--manifest-home',
      manifestHome,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { cwd: root, env, encoding: 'utf8' })
    assert.equal(failedDoctor.status, 1, failedDoctor.stderr)
    const failedPayload = JSON.parse(failedDoctor.stdout)
    assert.equal(failedPayload.ok, false)
    assert.equal(failedPayload.checks.extensionBridge.ok, false)
  } finally {
    await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(manifestHome, { recursive: true, force: true })
  }
})

function importCli() {
  return import(pathToFileURL(cliIndex).href)
}

function writeLiveBridge(homeDir) {
  fs.writeFileSync(path.join(homeDir, 'extension-bridge.json'), JSON.stringify({
    protocol: 'tokenless.extension-bridge-state.v1',
    pid: process.pid,
    sessionId: `test-${Date.now()}`,
    connectedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  }))
}

function createFakeBrowserLauncher(homeDir) {
  const script = path.join(homeDir, 'fake-chromium.mjs')
  fs.writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const home = process.env.TOKENLESS_TEST_BRIDGE_HOME
fs.writeFileSync(process.env.TOKENLESS_TEST_OPEN_LOG, process.argv[2])
fs.writeFileSync(path.join(home, 'extension-bridge.json'), JSON.stringify({
  protocol: 'tokenless.extension-bridge-state.v1',
  pid: Number(process.env.TOKENLESS_TEST_BRIDGE_PID),
  sessionId: 'fake-browser-bridge',
  connectedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString()
}))
`)
  fs.chmodSync(script, 0o755)
  return script
}

function fakeBrowserEnv(homeDir, launcher) {
  return {
    ...process.env,
    TOKENLESS_BROWSER_EXECUTABLE: launcher,
    TOKENLESS_TEST_BRIDGE_HOME: homeDir,
    TOKENLESS_TEST_OPEN_LOG: path.join(homeDir, 'opened-url.txt'),
    TOKENLESS_TEST_BRIDGE_PID: String(process.pid),
  }
}

async function claimNextJob(homeDir, daemonUrl, action) {
  const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
  const response = await fetch(`${daemonUrl}/control/jobs/claim-next?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(response.ok, true)
  return response.json()
}

async function completeJob(homeDir, daemonUrl, job, result) {
  const response = await fetch(`${daemonUrl}/jobs/${encodeURIComponent(job.job_id)}/complete`, {
    method: 'POST',
    headers: { ...daemonAuthorization(homeDir), 'content-type': 'application/json' },
    body: JSON.stringify({ claim_token: job.claim_token, result_json: result }),
  })
  assert.equal(response.ok, true, await response.text())
}

async function failJob(homeDir, daemonUrl, job, error) {
  const response = await fetch(`${daemonUrl}/jobs/${encodeURIComponent(job.job_id)}/complete`, {
    method: 'POST',
    headers: { ...daemonAuthorization(homeDir), 'content-type': 'application/json' },
    body: JSON.stringify({ claim_token: job.claim_token, error_json: error }),
  })
  assert.equal(response.ok, true, await response.text())
}

async function waitForQueuedJob(homeDir, daemonUrl, child) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CLI exited before creating job: ${await streamText(child.stderr)}`)
    const jobs = await fetch(`${daemonUrl}/jobs`, {
      headers: daemonAuthorization(homeDir),
    }).then((response) => response.json()).catch(() => [])
    if (jobs[0]) return jobs[0]
    await delay(50)
  }
  throw new Error('Timed out waiting for daemon job.')
}

function daemonAuthorization(homeDir) {
  const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
  return { authorization: `Bearer ${token}` }
}

async function waitForChild(child) {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout, stderr }
}

async function streamText(stream) {
  let text = ''
  for await (const chunk of stream) text += chunk.toString('utf8')
  return text
}

async function startSignalDaemon(homeDir, cancelMode) {
  const token = 'fake-daemon-control-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  let created = false
  let pollingStarted = false
  let jobStatus = 'running'
  let requestJson = {}
  const job = (status = jobStatus, error = null) => ({
    job_id: 'signal-job',
    claim_token: 'signal-claim',
    provider: 'chatgpt',
    action: 'submit_and_read',
    status,
    request_json: requestJson,
    result_json: null,
    error_json: error,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1')
    if (requestUrl.pathname === '/ready') {
      respondJson(response, 200, signedReadyBody({
        ready: true,
        home_dir: fs.realpathSync(homeDir),
        daemon_protocol: 'tokenless.daemon.v1',
        native_protocol: 'tokenless.native.v1',
      }, requestUrl.searchParams.get('challenge'), token))
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      respondJson(response, 401, { error: { message: 'missing bearer token' } })
      return
    }
    if (request.method === 'POST' && requestUrl.pathname === '/jobs') {
      const payload = JSON.parse(await streamText(request))
      requestJson = payload.request_json
      created = true
      respondJson(response, 200, job('queued'))
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === '/jobs/signal-job') {
      pollingStarted = true
      respondJson(response, 200, job())
      return
    }
    if (request.method === 'POST' && requestUrl.pathname === '/control/jobs/signal-job/cancel') {
      const payload = JSON.parse((await streamText(request)) || '{}')
      if (cancelMode === 'hang') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.flushHeaders()
        return
      }
      if (cancelMode === 'failure') {
        respondJson(response, 503, { error: { message: 'injected cancellation failure' } })
        return
      }
      jobStatus = 'canceled'
      if (cancelMode === 'delayed-success') await delay(200)
      respondJson(response, 200, job('canceled', { code: 'job_canceled', reason: payload.reason }))
      return
    }
    respondJson(response, 404, { error: { message: 'not found' } })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    daemonUrl: `http://127.0.0.1:${address.port}`,
    get created() { return created },
    get pollingStarted() { return pollingStarted },
    get jobStatus() { return jobStatus },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function respondJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function signedReadyBody(body, challenge, token) {
  const proofProtocol = 'tokenless.daemon-ready-proof.v1'
  const fields = [
    proofProtocol,
    challenge ?? '',
    body.daemon_protocol,
    body.native_protocol,
    body.home_dir,
  ]
  const chunks = []
  for (const field of fields) {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(value.length)
    chunks.push(length, value)
  }
  return {
    ...body,
    ready_proof_protocol: proofProtocol,
    ready_challenge: challenge,
    ready_proof: createHmac('sha256', token).update(Buffer.concat(chunks)).digest('base64url'),
  }
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error(message)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function stopPid(pid) {
  if (!Number.isInteger(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await delay(25)
    } catch {
      return
    }
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
