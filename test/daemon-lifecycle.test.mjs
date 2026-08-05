import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')
const cliIndex = path.join(cliDir, 'dist/src/index.js')
const cliPlaywrightIndex = path.join(cliDir, 'dist/src/playwright/index.js')
const tsDaemonEntry = path.join(cliDir, 'dist/src/daemon/daemon-entry.mjs')
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

test('concurrent ensureDaemonReady serializes one fresh daemon start through SQLite runtime state', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-concurrent-lock-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const runtime = await importCli()
  let startedPid
  try {
    const results = await Promise.all([
      runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 }),
      runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 }),
    ])
    const started = results.filter((result) => result.started)
    assert.equal(started.length, 1)
    startedPid = started[0].pid
    assert.equal(results.every((result) => result.body.version === packageVersion), true)
    assert.equal(new Set(results.map((result) => result.pid)).size, 1)
    assert.equal(new Set(results.map((result) => result.url)).size, 1)
    assert.equal(readPersistedRuntimeOrigin(homeDir), results[0].url)
    assert.equal(fs.existsSync(path.join(homeDir, '.daemon-start.lock')), false)
  } finally {
    if (startedPid) await stopPid(startedPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('repeated concurrent ensureDaemonReady never takes over a freshly published endpoint', async () => {
  const runtime = await importCli()
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tokenless-daemon-concurrent-repeat-${iteration}-`)))
    const daemonUrl = `http://127.0.0.1:${await freePort()}`
    let pid
    try {
      const results = await Promise.all([
        runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 }),
        runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 }),
        runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 }),
      ])
      pid = results[0].pid
      assert.equal(new Set(results.map((result) => result.pid)).size, 1)
      assert.equal(new Set(results.map((result) => result.url)).size, 1)
      const row = readRuntimeStateRow(homeDir)
      assert.equal(row?.state, 'running')
      assert.equal(row?.origin, results[0].url)
      assert.equal(row?.pid, pid)
    } finally {
      if (pid) await stopPid(pid)
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  }
})

test('ensureDaemonReady skips a foreign preferred port and later CLI stop uses the persisted actual origin', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-dynamic-port-')))
  const preferredPort = await freePort()
  const preferredUrl = `http://127.0.0.1:${preferredPort}`
  const foreign = await startForeignListener(preferredUrl)
  const runtime = await importCli()
  let pid
  try {
    await runtime.writeTokenlessConfig({ homeDir, daemonUrl: preferredUrl })
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl: preferredUrl, timeoutMs: 10_000 })
    pid = ready.pid
    assert.equal(ready.started, true)
    assert.notEqual(ready.url, preferredUrl)
    assert.equal(new URL(ready.url).hostname, '127.0.0.1')
    assert.equal(Number(new URL(ready.url).port) > preferredPort, true)
    assert.equal(readPersistedRuntimeOrigin(homeDir), ready.url)
    assert.equal((await runtime.readTokenlessConfig(homeDir)).daemonUrl, preferredUrl)
    assert.equal(await tcpReachable(preferredUrl), true)

    const doctor = runCli(['doctor', '--home', homeDir, '--json'])
    assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout)
    const doctorPayload = JSON.parse(doctor.stdout)
    assert.equal(doctorPayload.checks.daemon.ready, true)
    assert.equal(doctorPayload.checks.daemon.url, ready.url)
    assert.equal(doctorPayload.checks.daemon.pid, pid)
    assert.equal((await runtime.readTokenlessConfig(homeDir)).daemonUrl, preferredUrl)

    const stopped = runCli(['daemon', 'stop', '--home', homeDir, '--json'])
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout)
    const payload = JSON.parse(stopped.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'stopped')
    assert.equal(payload.url, ready.url)
    assert.equal(payload.pid, pid)
    assert.equal(await pidExited(pid), true)
    pid = undefined
    assert.equal(await tcpReachable(preferredUrl), true)
    assert.equal((await runtime.readTokenlessConfig(homeDir)).daemonUrl, preferredUrl)
  } finally {
    await foreign.close()
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('superseded daemon child never becomes ready or accepts jobs before claim-bound publish', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-superseded-child-')))
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const staleOwner = `stale-${randomUUID()}`
  let child
  try {
    seedStartingRuntimeState(homeDir, {
      generation: 2,
      ownerToken: `current-${randomUUID()}`,
      ownerPid: process.pid,
    })
    child = spawnDaemonEntry({
      homeDir,
      port,
      startupOwnerToken: staleOwner,
      startupGeneration: 1,
    })
    const probe = await waitForReadyStatusOrExit(child, daemonUrl)
    if (probe.exited !== true) {
      assert.notEqual(probe.status, 200)
      const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
      const response = await fetch(`${daemonUrl}/jobs`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'chatgpt',
          action: 'visible_provider_actions',
          execution_backend: 'playwright',
          profile_id: randomUUID(),
          job_id: randomUUID(),
          request_json: { malformed: true },
        }),
      }).catch(() => null)
      if (response) assert.notEqual(response.status, 200)
    }
    await waitForExit(child, 5_000).catch(() => undefined)
    assert.equal(readJobCount(homeDir), 0)
  } finally {
    if (child) await stopChild(child)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('direct concurrent daemon starts converge to one running daemon', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-direct-concurrent-')))
  const port = await freePort()
  const first = spawnDaemonEntry({ homeDir, port })
  const second = spawnDaemonEntry({ homeDir, port })
  let ready
  try {
    ready = await waitForOneReadyDaemon([
      { child: first, url: `http://127.0.0.1:${port}` },
      { child: second, url: `http://127.0.0.1:${port}` },
      { child: first, url: `http://127.0.0.1:${port + 1}` },
      { child: second, url: `http://127.0.0.1:${port + 1}` },
    ], homeDir)
    const endpoint = readPersistedRuntimeEndpoint(homeDir)
    assert.equal(endpoint.origin, ready.url)
    assert.equal(endpoint.pid, ready.pid)
    const exits = await Promise.all([
      waitForExitResult(first, 2_000).catch(() => null),
      waitForExitResult(second, 2_000).catch(() => null),
    ])
    assert.equal(exits.filter(Boolean).length, 1)
  } finally {
    await Promise.all([stopChild(first), stopChild(second)])
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
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

test('ensureDaemonReady does not stop or treat a foreign preferred listener as Tokenless', async () => {
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
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = ready.pid
    assert.equal(ready.started, true)
    assert.notEqual(ready.url, daemonUrl)
    assert.equal(fake.shutdownCount, 0)
    assert.equal(await tcpReachable(daemonUrl), true)
  } finally {
    await fake.close()
    if (pid) await stopPid(pid)
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
        executionBackend: 'playwright',
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
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.pid.json')), false)
    assert.equal(await pidExited(pid), true)
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

    const missing = await fetch(`${daemonUrl}/control/shutdown`, { method: 'POST' })
    assert.equal(missing.status, 401)
    const missingBody = await missing.json()
    assert.equal(Object.hasOwn(missingBody.error, 'protocol'), false)
    assert.equal(missingBody.error.code, 'control_auth_missing')

    const rejected = await fetch(`${daemonUrl}/control/shutdown`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(rejected.status, 403)
    const rejectedBody = await rejected.json()
    assert.equal(Object.hasOwn(rejectedBody.error, 'protocol'), false)
    assert.equal(rejectedBody.error.code, 'control_auth_rejected')
    assert.equal(JSON.stringify(rejectedBody).includes(controlToken), false)
    assert.equal((await runtime.probeDaemonReady({ homeDir, daemonUrl })).ok, true)

    const accepted = await fetch(`${daemonUrl}/control/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${controlToken}` },
    })
    assert.equal(accepted.status, 200)
    const acceptedBody = await accepted.json()
    assert.equal(acceptedBody.status, 'shutting_down')
    assert.equal(await pidExited(pid), true)
    assert.notEqual(readRuntimeStateRow(homeDir)?.state, 'running')
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
    assert.equal(payload.checks.runner.heartbeatAt, null)
    assert.equal(payload.checks.runner.activeProfileCount, 0)
    assert.equal(payload.checks.runner.activeJobCount, 0)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('doctor validates an existing managed profile registry without mutating home markers', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-doctor-existing-readonly-')))
  const browserDir = path.join(homeDir, 'browser')
  const profilesDir = path.join(browserDir, 'profiles')
  const profileId = randomUUID()
  fs.mkdirSync(path.join(profilesDir, profileId), { recursive: true, mode: 0o700 })
  const registryPath = path.join(browserDir, 'profiles.json')
  const markerPath = path.join(homeDir, 'doctor-marker.txt')
  const now = '2026-01-01T00:00:00.000Z'
  fs.writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    defaultProfile: 'personal',
    profiles: {
      personal: {
        slug: 'personal',
        id: profileId,
        label: 'Personal',
        labelOrigin: 'user',
        directory: path.join(profilesDir, profileId),
        lifecycle: 'ready',
        createdAt: now,
        updatedAt: now,
        lastObservedAuth: {
          chatgpt: { provider: 'chatgpt', auth: 'authenticated', checkedAt: now },
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), 'initialized-stopped-home-token\n', { mode: 0o600 })
  fs.writeFileSync(markerPath, 'unchanged\n', { mode: 0o600 })
  const before = snapshotTree(homeDir)
  try {
    const result = runCli(['doctor', '--home', homeDir, '--daemon-url', 'http://127.0.0.1:9', '--json'])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.checks.managedProfile.ok, true)
    assert.equal(payload.checks.managedProfile.slug, 'personal')
    assert.equal(payload.checks.daemon.ok, true)
    assert.equal(payload.checks.daemon.ready, false)
    assert.equal(payload.checks.daemon.running, false)
    assert.equal(payload.checks.daemon.status, 'stopped')
    assert.equal(payload.checks.daemon.versionCompatible, null)
    assert.equal(payload.checks.runner.ok, true)
    assert.equal(payload.checks.runner.state, 'stopped')
    assert.equal(payload.checks.daemon.daemonLogPath, path.join(homeDir, 'daemon.log'))
    assert.equal(payload.checks.daemon.daemonLogExists, false)
    assert.deepEqual(snapshotTree(homeDir), before)
  } finally {
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

async function importCli() {
  return await import(`${pathToFileURL(cliIndex).href}?daemon_lifecycle=${Date.now()}_${Math.random()}`)
}

async function importPlaywright() {
  return await import(`${pathToFileURL(cliPlaywrightIndex).href}?daemon_lifecycle=${Date.now()}_${Math.random()}`)
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
    if (request.method === 'POST' && requestUrl.pathname === '/jobs') {
      jobAuthorizationHeaders.push(request.headers.authorization)
      writeJson(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && requestUrl.pathname === '/control/shutdown') {
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
    return new Promise((resolve) => server.close(() => resolve()))
  }
}

async function startForeignListener(daemonUrl) {
  const url = new URL(daemonUrl)
  let closed = false
  const server = http.createServer((_request, response) => {
    writeJson(response, 200, { ok: true, service: 'foreign' })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(url.port), url.hostname, resolve)
  })
  return {
    close() {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function readPersistedRuntimeOrigin(homeDir) {
  const row = readRuntimeStateRow(homeDir)
  assert.equal(row?.state, 'running')
  return row.origin
}

function readPersistedRuntimeEndpoint(homeDir) {
  const row = readRuntimeStateRow(homeDir)
  assert.equal(row?.state, 'running')
  return {
    origin: row.origin,
    pid: row.pid,
  }
}

function readRuntimeStateRow(homeDir) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const row = database.prepare(
      `SELECT state, origin, pid
       FROM daemon_runtime_state
       WHERE id = 'daemon'`
    ).get()
    return row ?? null
  } finally {
    database.close()
  }
}

function seedStartingRuntimeState(homeDir, { generation, ownerToken, ownerPid }) {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS daemon_runtime_state (
        id TEXT PRIMARY KEY NOT NULL CHECK (id = 'daemon'),
        generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('starting', 'running')),
        owner_token TEXT,
        origin TEXT,
        pid INTEGER,
        lease_expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const now = new Date().toISOString()
    database.prepare(
      `INSERT INTO daemon_runtime_state (
         id, generation, state, owner_token, origin, pid, lease_expires_at, created_at, updated_at
       ) VALUES ('daemon', ?, 'starting', ?, NULL, ?, ?, ?, ?)`
    ).run(generation, ownerToken, ownerPid, Date.now() + 60_000, now, now)
  } finally {
    database.close()
  }
}

function readJobCount(homeDir) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const table = database.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'jobs'`
    ).get()
    if (!table) return 0
    const row = database.prepare('SELECT COUNT(*) AS count FROM jobs').get()
    return Number(row.count)
  } finally {
    database.close()
  }
}

function spawnDaemonEntry({
  homeDir,
  port,
  startupOwnerToken,
  startupGeneration,
}) {
  const args = [
    tsDaemonEntry,
    '--home',
    homeDir,
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]
  if (startupOwnerToken !== undefined && startupGeneration !== undefined) {
    args.push('--startup-owner-token', startupOwnerToken, '--startup-generation', String(startupGeneration))
  }
  return spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, TOKENLESS_HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForReadyStatusOrExit(child, daemonUrl) {
  const deadline = Date.now() + 5_000
  let latest = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { exited: true, exit: { code: child.exitCode, signal: child.signalCode } }
    }
    try {
      const response = await fetch(`${daemonUrl}/ready?challenge=${randomBytes(32).toString('base64url')}`)
      const body = await response.json().catch(() => null)
      latest = { exited: false, status: response.status, body }
      if (response.status !== 404) return latest
    } catch {
      // The child may not have bound yet or may have already exited.
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return latest ?? { exited: false, status: null, body: null }
}

async function waitForOneReadyDaemon(candidates, homeDir) {
  const deadline = Date.now() + 10_000
  let latestError
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (candidate.child.exitCode !== null || candidate.child.signalCode !== null) continue
      try {
        const response = await fetch(`${candidate.url}/ready?challenge=${randomBytes(32).toString('base64url')}`)
        if (!response.ok) continue
        const body = await response.json()
        if (body.ready === true && body.home_dir === homeDir) {
          return { url: candidate.url, pid: body.pid }
        }
      } catch (error) {
        latestError = error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`No direct daemon became ready: ${latestError?.message ?? latestError ?? 'unknown'}`)
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

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForExitResult(child, 2_000)
  } catch {
    child.kill('SIGKILL')
    await waitForExitResult(child, 2_000).catch(() => undefined)
  }
}

function waitForExit(child, timeoutMs) {
  return waitForExitResult(child, timeoutMs).then(() => undefined)
}

function waitForExitResult(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs} ms`))
    }, timeoutMs)
    const onExit = (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    }
    child.once('exit', onExit)
  })
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
