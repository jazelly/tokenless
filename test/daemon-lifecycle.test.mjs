import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')
const cliIndex = path.join(cliDir, 'dist/src/index.js')
const packageVersion = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version
const supportedProviders = ['chatgpt', 'claude', 'gemini', 'grok', 'qwen']

test('ensureDaemonReady installs the packaged daemon and reports daemon v1 readiness', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-first-install-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000, requiredProvider: 'chatgpt' })
    pid = ready.pid
    assert.equal(ready.started, true)
    assert.equal(ready.identityVerified, true)
    assert.equal(ready.protocolCompatible, true)
    assert.equal(ready.body.protocol, runtime.DAEMON_PROTOCOL)
    assert.equal(ready.body.version, packageVersion)
    assert.equal(ready.runtimeKind, 'typescript')
    assert.equal(ready.body.runtime_kind, 'typescript')
    assert.equal(ready.binaryPath, process.execPath)
    assert.equal(fs.existsSync(ready.daemonEntryPath), true)
    assert.deepEqual(ready.supportedProviders, supportedProviders)
    assert.deepEqual(ready.body.supported_providers, supportedProviders)
    assert.equal(Number.isInteger(ready.body.pid), true)
    assert.equal(ready.body.pid, pid)
    const inspection = await runtime.inspectManagedRuntime(homeDir)
    assert.equal(inspection.ok, true)
    assert.equal(inspection.packaged.buildInfo.version, packageVersion)
    assert.equal(inspection.packaged.buildInfo.protocol, runtime.DAEMON_PROTOCOL)
    assert.equal(inspection.packaged.path, ready.daemonEntryPath)
    assert.equal(inspection.installed.path, ready.daemonEntryPath)
    assert.equal(inspection.installed.matchesBundled, true)
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
    assert.equal(ready.runtimeKind, 'typescript')
    assert.deepEqual(ready.supportedProviders, supportedProviders)

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

test('built client preserves native message size compatibility contract', async () => {
  const runtime = await importCli()
  assert.equal(runtime.MAX_NATIVE_MESSAGE_BYTES, runtime.MAX_DAEMON_REQUEST_BYTES)
  await assert.rejects(
    runtime.createDaemonJob({
      daemonUrl: 'http://127.0.0.1:9',
      provider: 'chatgpt',
      action: 'prompt.submit',
      requestJson: {
        prompt: 'x'.repeat(runtime.MAX_NATIVE_MESSAGE_BYTES + 1),
      },
    }),
    (error) => {
      assert.equal(error.code, 'native_message_too_large')
      assert.match(error.message, new RegExp(`keep it below ${runtime.MAX_NATIVE_MESSAGE_BYTES} bytes`))
      return true
    }
  )
})

test('concurrent ensureDaemonReady serializes one fresh daemon start under the daemon start lock', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-concurrent-lock-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const runtime = await importCli()
  const lockPath = path.join(homeDir, '.daemon-start.lock')
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
    assert.equal(results.every((result) => result.runtimeKind === 'typescript'), true)
    assert.equal(new Set(results.map((result) => result.pid)).size, 1)
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    if (startedPid) await stopPid(startedPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
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
    assert.equal(missingBody.error.protocol, runtime.DAEMON_PROTOCOL)
    assert.equal(missingBody.error.code, 'control_auth_missing')

    const rejected = await fetch(`${daemonUrl}/control/shutdown`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(rejected.status, 403)
    const rejectedBody = await rejected.json()
    assert.equal(rejectedBody.error.protocol, runtime.DAEMON_PROTOCOL)
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
  fs.writeFileSync(markerPath, 'unchanged\n', { mode: 0o600 })
  const before = snapshotTree(homeDir)
  try {
    const result = runCli(['doctor', '--home', homeDir, '--daemon-url', 'http://127.0.0.1:9', '--json'])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.checks.managedProfile.ok, true)
    assert.equal(payload.checks.managedProfile.slug, 'personal')
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

function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
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
