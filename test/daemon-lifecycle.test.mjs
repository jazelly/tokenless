import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
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

test('ensureDaemonReady installs the packaged daemon and reports supported protocols', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-first-install-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = ready.pid
    assert.equal(ready.started, true)
    assert.equal(ready.identityVerified, true)
    assert.equal(ready.body.version, packageVersion)
    assert.equal(ready.runtimeKind, 'typescript')
    assert.equal(ready.body.runtime_kind, 'typescript')
    assert.equal(ready.binaryPath, process.execPath)
    assert.equal(fs.existsSync(ready.daemonEntryPath), true)
    assert.deepEqual(ready.supportedProtocols, {
      daemon: [runtime.DAEMON_PROTOCOL],
      job: [
        runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1,
        runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V2,
      ],
      action: [
        runtime.VISIBLE_ACTION_PROTOCOL_VERSION_V1,
        runtime.VISIBLE_ACTION_PROTOCOL_VERSION_V2,
      ],
    })
    assert.equal(Number.isInteger(ready.body.pid), true)
    assert.equal(ready.body.pid, pid)
    assert.equal(fs.existsSync(runtime.installedRustBinaryPath(homeDir)), false)

    const inspection = await runtime.inspectManagedRuntime(homeDir)
    assert.equal(inspection.ok, true)
    assert.equal(inspection.packaged.buildInfo.version, packageVersion)
    assert.equal(inspection.packaged.path, ready.daemonEntryPath)
    assert.equal(inspection.installed.path, ready.daemonEntryPath)
    assert.equal(inspection.installed.matchesBundled, true)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
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
    assert.equal(missingBody.error.protocol, runtime.DAEMON_ERROR_PROTOCOL)
    assert.equal(missingBody.error.code, 'control_auth_missing')

    const rejected = await fetch(`${daemonUrl}/control/shutdown`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(rejected.status, 403)
    const rejectedBody = await rejected.json()
    assert.equal(rejectedBody.error.protocol, runtime.DAEMON_ERROR_PROTOCOL)
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

test('ordinary daemon startup replaces a same-home legacy daemon when supported protocols overlap', {
  timeout: 180_000,
}, async (t) => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (cargo.error || cargo.status !== 0) {
    t.skip('cargo is required to build a real incompatible daemon binary')
    return
  }

  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-setup-daemon-reconcile-')))
  const crateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-incompatible-daemon-src-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const port = new URL(daemonUrl).port
  let pid
  try {
    const incompatibleVersion = differentMajorVersion(packageVersion)
    const incompatibleBinary = buildDaemonWithVersion(crateDir, incompatibleVersion)
    const runtime = await importCli()

    const child = spawn(incompatibleBinary, [
      '--home', homeDir,
      'serve',
      '--host', '127.0.0.1',
      '--port', port,
    ], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
    pid = child.pid
    assert.equal(Number.isInteger(pid), true)
    child.unref()
    writeDaemonPidFile(homeDir, pid, daemonUrl)

    const incompatible = await waitForLegacyReadyVersion(runtime, homeDir, daemonUrl, incompatibleVersion)
    assert.equal(incompatible.ok, false)
    assert.equal(incompatible.code, 'daemon_runtime_kind_mismatch')
    assert.equal(incompatible.runtimeKind, 'legacy')
    assert.equal(incompatible.actualHome, homeDir)

    const ordinaryReady = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(ordinaryReady.started, true)
    assert.notEqual(ordinaryReady.pid, pid)
    assert.equal(await pidExited(pid), true)
    pid = ordinaryReady.pid
    assert.equal(ordinaryReady.protocolCompatible, true)
    assert.equal(ordinaryReady.runtimeKind, 'typescript')
    assert.equal(ordinaryReady.body.runtime_kind, 'typescript')
    assert.equal(ordinaryReady.body.version, packageVersion)
    assert.equal(pidIsAlive(pid), true)
    const afterOrdinaryStart = await waitForReadyVersion(runtime, homeDir, daemonUrl, packageVersion)
    assert.equal(afterOrdinaryStart.body.pid, pid)

    const ready = await runtime.ensureSetupDaemonRunnable({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(ready.pid, pid)
    assert.equal(ready.body.version, packageVersion)
    assert.equal(ready.runtimeKind, 'typescript')
    assert.equal(ready.reconciliation.action, 'none')
    assert.equal(ready.reconciliation.reason, 'already_compatible')
    assert.equal(ready.reconciliation.previous, undefined)
    assert.equal(ready.reconciliation.stopped, undefined)
    assert.equal(ready.runningVersion, packageVersion)
    assert.equal(ready.runningMajor, semanticMajor(packageVersion))
    assert.equal(ready.protocolCompatible, true)
    assert.equal(ready.versionCompatible, true)
    assert.equal(ready.compatibilityPolicy, 'protocol-negotiation')
    assert.equal(pidIsAlive(pid), true)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(crateDir, { recursive: true, force: true })
  }
})

test('ordinary daemon startup refuses to kill a same-home legacy daemon without a claimed pid', {
  timeout: 180_000,
}, async (t) => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (cargo.error || cargo.status !== 0) {
    t.skip('cargo is required to build a real compatible legacy daemon binary')
    return
  }

  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-legacy-missing-pid-home-')))
  const crateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-legacy-missing-pid-src-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const compatibleBinary = buildDaemonWithoutShutdown(crateDir, packageVersion, { omitReadyPid: true })
    const child = spawnDaemonFixture(compatibleBinary, homeDir, daemonUrl)
    pid = child.pid
    const runtime = await importCli()
    const legacyReady = await waitForLegacyReadyVersion(runtime, homeDir, daemonUrl, packageVersion)
    assert.equal(legacyReady.runtimeKind, 'legacy')

    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 }),
      (error) => {
        assert.equal(error.code, 'daemon_shutdown_unsupported')
        return true
      }
    )
    assert.equal(pidIsAlive(pid), true)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(crateDir, { recursive: true, force: true })
  }
})

test('ordinary daemon startup refuses to kill a same-home legacy daemon with a mismatched claimed pid', {
  timeout: 180_000,
}, async (t) => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (cargo.error || cargo.status !== 0) {
    t.skip('cargo is required to build a real compatible legacy daemon binary')
    return
  }

  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-legacy-mismatched-pid-home-')))
  const crateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-legacy-mismatched-pid-src-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const compatibleBinary = buildDaemonWithoutShutdown(crateDir, packageVersion, { omitReadyPid: true })
    const child = spawnDaemonFixture(compatibleBinary, homeDir, daemonUrl)
    pid = child.pid
    writeDaemonPidFile(homeDir, process.pid, daemonUrl)
    const runtime = await importCli()
    const legacyReady = await waitForLegacyReadyVersion(runtime, homeDir, daemonUrl, packageVersion)
    assert.equal(legacyReady.runtimeKind, 'legacy')

    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 }),
      (error) => {
        assert.equal(error.code, 'daemon_shutdown_unsupported')
        return true
      }
    )
    assert.equal(pidIsAlive(pid), true)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(crateDir, { recursive: true, force: true })
  }
})

test('setup safely replaces verified same-home daemons with incompatible protocols', {
  timeout: 300_000,
}, async (t) => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (cargo.error || cargo.status !== 0) {
    t.skip('cargo is required to build real incompatible daemon fixtures')
    return
  }

  const runtime = await importCli()
  for (const fixture of [
    {
      name: 'daemon',
      constant: 'DAEMON_PROTOCOL',
      protocol: 'tokenless.daemon.v999',
      code: 'daemon_protocol_mismatch',
    },
  ]) {
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tokenless-${fixture.name}-protocol-mismatch-home-`)))
    const crateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tokenless-${fixture.name}-protocol-mismatch-src-`)))
    const daemonUrl = `http://127.0.0.1:${await freePort()}`
    let pid
    try {
      const incompatibleBinary = buildDaemonFixture(crateDir, {
        constants: { [fixture.constant]: fixture.protocol },
      })
      const child = spawnDaemonFixture(incompatibleBinary, homeDir, daemonUrl)
      pid = child.pid

      const mismatch = await waitForProbeCode(runtime, homeDir, daemonUrl, fixture.code)
      assert.equal(mismatch.identityVerified, true)
      assert.equal(mismatch.sameHomeVerified, true)
      assert.equal(mismatch.actualHome, homeDir)
      assert.equal(pidIsAlive(pid), true)

      await assert.rejects(
        runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 }),
        (error) => {
          assert.equal(error.code, fixture.code)
          return true
        }
      )
      assert.equal(pidIsAlive(pid), true)

      const ready = await runtime.ensureSetupDaemonRunnable({ homeDir, daemonUrl, timeoutMs: 10_000 })
      assert.equal(ready.reconciliation.attempted, true)
      assert.equal(ready.reconciliation.action, 'restart_daemon')
      assert.equal(ready.reconciliation.reason, fixture.code)
      assert.equal(ready.reconciliation.reasons.includes(fixture.code), true)
      assert.equal(ready.reconciliation.stopped.status, 'stopped')
      assert.equal(await pidExited(pid), true)
      pid = ready.pid
    } finally {
      if (pid) await stopPid(pid)
      fs.rmSync(homeDir, { recursive: true, force: true })
      fs.rmSync(crateDir, { recursive: true, force: true })
    }
  }
})

test('setup refuses to stop a protocol-mismatch daemon from a different home', {
  timeout: 180_000,
}, async (t) => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (cargo.error || cargo.status !== 0) {
    t.skip('cargo is required to build a real different-home daemon fixture')
    return
  }

  const requestedHomeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-different-home-requested-')))
  const daemonHomeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-different-home-daemon-')))
  const crateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-different-home-src-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const incompatibleBinary = buildDaemonFixture(crateDir, {
      constants: { DAEMON_PROTOCOL: 'tokenless.daemon.v999' },
    })
    const child = spawnDaemonFixture(incompatibleBinary, daemonHomeDir, daemonUrl)
    pid = child.pid
    const runtime = await importCli()
    await waitForProbeCode(runtime, daemonHomeDir, daemonUrl, 'daemon_protocol_mismatch')
    fs.mkdirSync(requestedHomeDir, { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(daemonHomeDir, 'daemon.token'), path.join(requestedHomeDir, 'daemon.token'))

    const mismatch = await waitForProbeCode(runtime, requestedHomeDir, daemonUrl, 'daemon_home_mismatch')
    assert.equal(mismatch.identityVerified, true)

    await assert.rejects(
      runtime.ensureSetupDaemonRunnable({ homeDir: requestedHomeDir, daemonUrl, timeoutMs: 10_000 }),
      (error) => {
        assert.equal(error.code, 'daemon_home_mismatch')
        return true
      }
    )
    assert.equal(pidIsAlive(pid), true)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(requestedHomeDir, { recursive: true, force: true })
    fs.rmSync(daemonHomeDir, { recursive: true, force: true })
    fs.rmSync(crateDir, { recursive: true, force: true })
  }
})

test('ordinary daemon startup refuses a different-home legacy daemon with compatible protocols', {
  timeout: 180_000,
}, async (t) => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (cargo.error || cargo.status !== 0) {
    t.skip('cargo is required to build a real compatible legacy daemon binary')
    return
  }

  const requestedHomeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-legacy-different-home-requested-')))
  const daemonHomeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-legacy-different-home-daemon-')))
  const crateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-compatible-legacy-daemon-src-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const port = new URL(daemonUrl).port
  let pid
  try {
    const compatibleBinary = buildDaemonWithVersion(crateDir, packageVersion)
    const runtime = await importCli()

    const child = spawn(compatibleBinary, [
      '--home', daemonHomeDir,
      'serve',
      '--host', '127.0.0.1',
      '--port', port,
    ], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
    pid = child.pid
    assert.equal(Number.isInteger(pid), true)
    child.unref()

    const legacyReady = await waitForLegacyReadyVersion(runtime, daemonHomeDir, daemonUrl, packageVersion)
    assert.equal(legacyReady.ok, false)
    assert.equal(legacyReady.code, 'daemon_runtime_kind_mismatch')
    assert.equal(legacyReady.runtimeKind, 'legacy')
    fs.mkdirSync(requestedHomeDir, { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(daemonHomeDir, 'daemon.token'), path.join(requestedHomeDir, 'daemon.token'))

    const mismatch = await waitForProbeCode(runtime, requestedHomeDir, daemonUrl, 'daemon_home_mismatch')
    assert.equal(mismatch.identityVerified, true)
    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir: requestedHomeDir, daemonUrl, timeoutMs: 10_000 }),
      (error) => {
        assert.equal(error.code, 'daemon_home_mismatch')
        return true
      }
    )
    await assert.rejects(
      runtime.ensureSetupDaemonRunnable({ homeDir: requestedHomeDir, daemonUrl, timeoutMs: 10_000 }),
      (error) => {
        assert.equal(error.code, 'daemon_home_mismatch')
        return true
      }
    )
    assert.equal(pidIsAlive(pid), true)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(requestedHomeDir, { recursive: true, force: true })
    fs.rmSync(daemonHomeDir, { recursive: true, force: true })
    fs.rmSync(crateDir, { recursive: true, force: true })
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

function buildDaemonWithVersion(crateDir, version) {
  return buildDaemonFixture(crateDir, { version })
}

function buildDaemonWithoutShutdown(crateDir, version, options = {}) {
  return buildDaemonFixture(crateDir, { version, disableShutdown: true, ...options })
}

function buildDaemonFixture(crateDir, {
  version,
  constants = {},
  disableShutdown = false,
  omitReadyPid = false,
} = {}) {
  fs.cpSync(path.join(root, 'packages/daemon'), crateDir, { recursive: true })
  const manifestPath = path.join(crateDir, 'Cargo.toml')
  if (version) {
    const manifest = fs.readFileSync(manifestPath, 'utf8')
    fs.writeFileSync(manifestPath, manifest.replace(/^version = ".*"$/m, `version = "${version}"`))
  }
  const constantsPath = path.join(crateDir, 'src/generated/protocol_constants.rs')
  let generated = fs.readFileSync(constantsPath, 'utf8')
  for (const [name, protocol] of Object.entries(constants)) {
    const matcher = new RegExp(`pub const ${name}: &str = "[^"]+";`)
    assert.match(generated, matcher)
    generated = generated.replace(matcher, `pub const ${name}: &str = "${protocol}";`)
  }
  fs.writeFileSync(constantsPath, generated)
  if (disableShutdown) {
    const libPath = path.join(crateDir, 'src/lib.rs')
    const lib = fs.readFileSync(libPath, 'utf8')
    const patched = lib.replace(
      'http_router_with_shutdown(store, Some(shutdown_tx)),',
      'http_router(store),'
    )
    assert.notEqual(patched, lib, 'expected daemon fixture to patch shutdown route')
    fs.writeFileSync(libPath, patched)
  }
  if (omitReadyPid) {
    const libPath = path.join(crateDir, 'src/lib.rs')
    const lib = fs.readFileSync(libPath, 'utf8')
    const patched = lib.replace('    pid: u32,\n', '    #[serde(skip_serializing)]\n    pid: u32,\n')
    assert.notEqual(patched, lib, 'expected daemon fixture to omit ready pid')
    fs.writeFileSync(libPath, patched)
  }
  const build = spawnSync('cargo', [
    'build',
    '--quiet',
    '--release',
    '--manifest-path',
    manifestPath,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 150_000,
  })
  assert.equal(build.status, 0, [
    build.error?.message,
    build.stderr,
    build.stdout,
  ].filter(Boolean).join('\n'))
  return path.join(crateDir, 'target/release', process.platform === 'win32' ? 'tokenless-daemon.exe' : 'tokenless-daemon')
}

function spawnDaemonFixture(binary, homeDir, daemonUrl) {
  const child = spawn(binary, [
    '--home', homeDir,
    'serve',
    '--host', '127.0.0.1',
    '--port', new URL(daemonUrl).port,
  ], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  })
  assert.equal(Number.isInteger(child.pid), true)
  child.unref()
  return child
}

function writeDaemonPidFile(homeDir, pid, daemonUrl) {
  fs.writeFileSync(path.join(homeDir, 'daemon.pid.json'), `${JSON.stringify({
    protocol: 'tokenless.daemon-process.v1',
    pid,
    homeDir,
    daemonUrl,
    binaryPath: 'legacy-daemon-fixture',
    runtimeKind: 'legacy',
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })
}

function differentMajorVersion(version) {
  const { major } = parseSemver(version)
  return `${major + 1}.0.0`
}

function semanticMajor(version) {
  return parseSemver(version).major
}

function parseSemver(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(version)
  assert.notEqual(match, null, `expected semver package version, got ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

async function waitForReadyVersion(runtime, homeDir, daemonUrl, version) {
  const deadline = Date.now() + 10_000
  let last
  while (Date.now() < deadline) {
    last = await runtime.probeDaemonReady({ homeDir, daemonUrl })
    if (last.ok && last.body.version === version) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`daemon did not report version ${version}: ${JSON.stringify(last)}`)
}

async function waitForLegacyReadyVersion(runtime, homeDir, daemonUrl, version) {
  const deadline = Date.now() + 10_000
  let last
  while (Date.now() < deadline) {
    last = await runtime.probeDaemonReady({ homeDir, daemonUrl })
    if (
      last.code === 'daemon_runtime_kind_mismatch' &&
      last.runtimeKind === 'legacy' &&
      last.body?.version === version
    ) {
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`legacy daemon did not report version ${version}: ${JSON.stringify(last)}`)
}

async function waitForProbeCode(runtime, homeDir, daemonUrl, code) {
  const deadline = Date.now() + 10_000
  let last
  while (Date.now() < deadline) {
    last = await runtime.probeDaemonReady({ homeDir, daemonUrl })
    if (last.code === code) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`daemon did not report ${code}: ${JSON.stringify(last)}`)
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
