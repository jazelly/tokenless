import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
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

test('ensureDaemonReady installs the packaged daemon and reports the running version and process proof', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-first-install-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = ready.pid
    assert.equal(ready.started, true)
    assert.equal(ready.identityVerified, true)
    assert.equal(ready.processIdentityVerified, true)
    assert.equal(ready.capabilityProofVerified, true)
    assert.equal(ready.body.version, packageVersion)
    assert.equal(ready.body.daemon_process_proof_protocol, runtime.DAEMON_PROCESS_PROOF_PROTOCOL)
    assert.equal(ready.body.daemon_process_identity_error, undefined)
    assert.equal(ready.body.readiness_protocol, runtime.DAEMON_READINESS_PROTOCOL)
    assert.equal(ready.body.daemon_lifecycle_protocol, runtime.DAEMON_LIFECYCLE_PROTOCOL)
    assert.equal(ready.body.capability_proof_protocol, runtime.DAEMON_CAPABILITY_PROOF_PROTOCOL)
    assert.equal(ready.body.worker_capabilities, undefined)
    assert.deepEqual(ready.lifecycleCapabilities.daemonAccepts, [
      runtime.DAEMON_PROTOCOL,
      runtime.DAEMON_LIFECYCLE_PROTOCOL,
      runtime.DAEMON_SHUTDOWN_PROOF_PROTOCOL,
      runtime.NATIVE_PROTOCOL,
      'tokenless.visible-attachment.v1',
    ])
    assert.equal(ready.lifecycleCapabilities.workerCapabilities, null)
    assert.equal(Number.isInteger(ready.body.pid), true)
    assert.equal(ready.body.pid, pid)
    assert.match(ready.body.running_binary_hash, /^[0-9a-f]{64}$/)
    assert.equal(fs.existsSync(runtime.installedRustBinaryPath(homeDir)), true)

    const inspection = await runtime.inspectManagedRuntime(homeDir)
    assert.equal(inspection.ok, true)
    assert.equal(inspection.packaged.buildInfo.version, packageVersion)
    assert.equal(inspection.installed.matchesBundled, true)
    assert.equal(ready.body.running_binary_hash, inspection.packaged.hash)
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('concurrent ensureDaemonReady serializes one fresh daemon start under the lifecycle lock', async () => {
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
    assert.equal(new Set(results.map((result) => result.pid)).size, 1)
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    if (startedPid) await stopPid(startedPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('running daemon reports the startup-frozen executable hash after its binary path is replaced', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-frozen-hash-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const inspection = await runtime.inspectManagedRuntime(homeDir)
    const binaryPath = path.join(homeDir, `tokenless-daemon-copy${process.platform === 'win32' ? '.exe' : ''}`)
    fs.copyFileSync(inspection.packaged.path, binaryPath)
    if (process.platform !== 'win32') fs.chmodSync(binaryPath, 0o755)
    const startupHash = fileHash(binaryPath)
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, binaryPath, timeoutMs: 10_000 })
    pid = ready.pid
    assert.equal(ready.body.running_binary_hash, startupHash)

    const replacement = `${binaryPath}.replacement`
    fs.writeFileSync(replacement, Buffer.concat([fs.readFileSync(binaryPath), Buffer.from('\nreplacement\n')]))
    if (process.platform !== 'win32') fs.chmodSync(replacement, 0o755)
    fs.renameSync(replacement, binaryPath)
    assert.notEqual(fileHash(binaryPath), startupHash)

    const reprobe = await runtime.probeDaemonReady({ homeDir, daemonUrl })
    assert.equal(reprobe.ok, true)
    assert.equal(reprobe.body.running_binary_hash, startupHash)
  } finally {
    if (pid) await stopPid(pid)
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

test('daemon stop uses proof-authenticated self-shutdown for a verified daemon', async () => {
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

test('daemon shutdown proof rejects tampering and replay against a restarted process', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-shutdown-proof-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const first = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = first.pid
    const controlToken = await runtime.readDaemonToken({ homeDir })
    const staleRequest = daemonShutdownProofRequest(runtime, first, controlToken)
    const tamperedRequest = {
      ...staleRequest,
      proof: Buffer.alloc(32, 0xa5).toString('base64url'),
    }
    const tampered = await fetch(`${daemonUrl}/control/shutdown`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(tamperedRequest),
    })
    assert.equal(tampered.status, 403)
    const tamperedBody = await tampered.json()
    assert.equal(tamperedBody.error.protocol, runtime.DAEMON_ERROR_PROTOCOL)
    assert.equal(tamperedBody.error.code, 'daemon_shutdown_proof_rejected')
    assert.equal(JSON.stringify(tamperedBody).includes(controlToken), false)
    assert.equal(JSON.stringify(tamperedBody).includes(tamperedRequest.proof), false)
    assert.equal((await runtime.probeDaemonReady({ homeDir, daemonUrl })).ok, true)

    const stopped = await runtime.stopDaemon({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(stopped.status, 'stopped')
    assert.equal(await pidExited(pid), true)

    const second = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = second.pid
    assert.notEqual(second.body.instance_id, first.body.instance_id)
    const replayed = await fetch(`${daemonUrl}/control/shutdown`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(staleRequest),
    })
    assert.equal(replayed.status, 403)
    const replayedBody = await replayed.json()
    assert.equal(replayedBody.error.protocol, runtime.DAEMON_ERROR_PROTOCOL)
    assert.equal(replayedBody.error.code, 'daemon_shutdown_proof_rejected')
    assert.equal((await runtime.probeDaemonReady({ homeDir, daemonUrl })).ok, true)

    const finalStop = await runtime.stopDaemon({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(finalStop.status, 'stopped')
    assert.equal(await pidExited(pid), true)
    pid = undefined
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

test('ordinary daemon startup reuses a different-major daemon when its signed protocols are compatible', {
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
    const incompatibleMajor = semanticMajor(incompatibleVersion)
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

    const incompatible = await waitForReadyVersion(runtime, homeDir, daemonUrl, incompatibleVersion)
    assert.equal(incompatible.ok, true)
    assert.equal(incompatible.actualHome, homeDir)

    const ordinaryReady = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(ordinaryReady.started, false)
    assert.equal(ordinaryReady.pid, pid)
    assert.equal(ordinaryReady.protocolCompatible, true)
    assert.equal(ordinaryReady.body.version, incompatibleVersion)
    assert.equal(pidIsAlive(pid), true)
    const afterOrdinaryReuse = await waitForReadyVersion(runtime, homeDir, daemonUrl, incompatibleVersion)
    assert.equal(afterOrdinaryReuse.body.pid, pid)

    const ready = await runtime.ensureSetupDaemonRunnable({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(ready.reconciliation.attempted, true)
    assert.equal(ready.reconciliation.reason, 'version_mismatch')
    assert.deepEqual(ready.reconciliation.reasons, [
      'version_mismatch',
      'running_artifact_mismatch',
      'installed_artifact_mismatch',
    ])
    assert.equal(ready.reconciliation.previous.version, incompatibleVersion)
    assert.equal(ready.reconciliation.previous.major, incompatibleMajor)
    assert.equal(ready.reconciliation.stopped.status, 'stopped')
    assert.equal(ready.runningVersion, packageVersion)
    assert.equal(ready.runningMajor, semanticMajor(packageVersion))
    assert.equal(ready.protocolCompatible, true)
    assert.equal(ready.versionCompatible, true)
    assert.equal(ready.compatibilityPolicy, 'protocol-negotiation')
    assert.equal(await pidExited(pid), true)
    pid = ready.pid
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(crateDir, { recursive: true, force: true })
  }
})

test('setup safely replaces signed same-home daemons with incompatible daemon or native protocols', {
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
    {
      name: 'native',
      constant: 'NATIVE_PROTOCOL',
      protocol: 'tokenless.native.v999',
      code: 'native_protocol_mismatch',
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
      assert.equal(mismatch.processIdentityVerified, true)
      assert.equal(mismatch.capabilityProofVerified, true)
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

test('setup refuses to stop a protocol-mismatch daemon without the signed lifecycle capability', {
  timeout: 180_000,
}, async (t) => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (cargo.error || cargo.status !== 0) {
    t.skip('cargo is required to build a real lifecycle-negative daemon fixture')
    return
  }

  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-unverified-lifecycle-home-')))
  const crateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-unverified-lifecycle-src-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const incompatibleBinary = buildDaemonFixture(crateDir, {
      constants: { DAEMON_PROTOCOL: 'tokenless.daemon.v999' },
      omitLifecycleAdvertisement: true,
    })
    const child = spawnDaemonFixture(incompatibleBinary, homeDir, daemonUrl)
    pid = child.pid
    const runtime = await importCli()

    const mismatch = await waitForProbeCode(runtime, homeDir, daemonUrl, 'daemon_protocol_mismatch')
    assert.equal(mismatch.identityVerified, true)
    assert.equal(mismatch.processIdentityVerified, true)
    assert.equal(mismatch.capabilityProofVerified, true)
    assert.equal(mismatch.sameHomeVerified, true)
    assert.equal(mismatch.lifecycleCapabilities.daemonAccepts.includes(runtime.DAEMON_LIFECYCLE_PROTOCOL), false)
    assert.equal(mismatch.lifecycleCapabilities.daemonEmits.includes(runtime.DAEMON_LIFECYCLE_PROTOCOL), false)

    await assert.rejects(
      runtime.ensureSetupDaemonRunnable({ homeDir, daemonUrl, timeoutMs: 10_000 }),
      (error) => {
        assert.equal(error.code, 'daemon_shutdown_unverified')
        assert.match(error.message, /does not advertise the signed tokenless\.daemon-lifecycle\.v1/)
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

test('ordinary daemon startup reuses a same-major different-version daemon while setup reconciles to the packaged daemon', {
  timeout: 180_000,
}, async (t) => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (cargo.error || cargo.status !== 0) {
    t.skip('cargo is required to build a real same-major daemon binary')
    return
  }

  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-setup-daemon-exact-reconcile-')))
  const crateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-same-major-daemon-src-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const port = new URL(daemonUrl).port
  let pid
  try {
    const differentVersion = sameMajorDifferentVersion(packageVersion)
    const differentMajor = semanticMajor(differentVersion)
    const differentBinary = buildDaemonWithVersion(crateDir, differentVersion)
    const runtime = await importCli()
    const staleInstalledDaemon = runtime.installedRustBinaryPath(homeDir)
    fs.mkdirSync(path.dirname(staleInstalledDaemon), { recursive: true, mode: 0o700 })
    fs.copyFileSync(differentBinary, staleInstalledDaemon)
    if (process.platform !== 'win32') fs.chmodSync(staleInstalledDaemon, 0o755)
    const staleInstalledHash = fileHash(staleInstalledDaemon)
    const currentInspection = await runtime.inspectManagedRuntime(homeDir)
    assert.notEqual(staleInstalledHash, currentInspection.packaged.hash)

    const child = spawn(differentBinary, [
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

    const differentReady = await waitForReadyVersion(runtime, homeDir, daemonUrl, differentVersion)
    assert.equal(differentReady.ok, true)
    assert.equal(differentReady.actualHome, homeDir)
    assert.equal(differentReady.body.running_binary_hash, staleInstalledHash)

    const ordinaryReady = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(ordinaryReady.started, false)
    assert.equal(ordinaryReady.pid, pid)
    assert.equal(ordinaryReady.body.version, differentVersion)
    assert.equal(ordinaryReady.body.running_binary_hash, staleInstalledHash)

    const ready = await runtime.ensureSetupDaemonRunnable({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(ready.reconciliation.attempted, true)
    assert.equal(ready.reconciliation.reason, 'version_mismatch')
    assert.deepEqual(ready.reconciliation.reasons, [
      'version_mismatch',
      'running_artifact_mismatch',
      'installed_artifact_mismatch',
    ])
    assert.equal(ready.reconciliation.previous.version, differentVersion)
    assert.equal(ready.reconciliation.previous.major, differentMajor)
    assert.equal(ready.reconciliation.previous.pid, pid)
    assert.equal(ready.reconciliation.previous.runningBinaryHash, staleInstalledHash)
    assert.equal(ready.reconciliation.previous.installedBinaryHash, staleInstalledHash)
    assert.equal(ready.reconciliation.previous.packagedBinaryHash, currentInspection.packaged.hash)
    assert.equal(ready.reconciliation.stopped.status, 'stopped')
    assert.deepEqual(ready.reconciliation.refreshed, [staleInstalledDaemon])
    assert.equal(ready.runningVersion, packageVersion)
    assert.equal(ready.runningMajor, semanticMajor(packageVersion))
    assert.equal(ready.protocolCompatible, true)
    assert.equal(ready.versionCompatible, true)
    assert.equal(ready.compatibilityPolicy, 'protocol-negotiation')
    assert.equal(ready.body.running_binary_hash, currentInspection.packaged.hash)
    assert.equal(fileHash(staleInstalledDaemon), currentInspection.packaged.hash)
    assert.equal(await pidExited(pid), true)
    pid = ready.pid
  } finally {
    if (pid) await stopPid(pid)
    fs.rmSync(homeDir, { recursive: true, force: true })
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

function buildDaemonFixture(crateDir, {
  version,
  constants = {},
  omitLifecycleAdvertisement = false,
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
  if (omitLifecycleAdvertisement) {
    const sourcePath = path.join(crateDir, 'src/lib.rs')
    let source = fs.readFileSync(sourcePath, 'utf8')
    for (const functionName of ['daemon_accepts', 'daemon_emits']) {
      const matcher = new RegExp(`(fn ${functionName}\\(\\) -> Vec<&'static str> \\{[\\s\\S]*?vec!\\[[\\s\\S]*?)        DAEMON_LIFECYCLE_PROTOCOL,\\n`)
      assert.match(source, matcher)
      source = source.replace(matcher, '$1')
    }
    fs.writeFileSync(sourcePath, source)
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

function sameMajorDifferentVersion(version) {
  const { major, minor, patch } = parseSemver(version)
  if (patch > 0) return `${major}.${minor}.${patch - 1}`
  if (minor > 0) return `${major}.${minor - 1}.0`
  return `${major}.${minor + 1}.0`
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

function daemonShutdownProofRequest(runtime, ready, controlToken) {
  const challenge = ready.body.shutdown_challenge
  const fields = [
    runtime.DAEMON_SHUTDOWN_PROOF_PROTOCOL,
    challenge,
    'POST',
    '/control/shutdown',
    ready.actualHome,
    String(ready.body.pid),
    ready.body.instance_id,
    ready.body.running_binary_hash,
  ]
  const chunks = []
  for (const field of fields) {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    chunks.push(length, value)
  }
  return {
    protocol: runtime.DAEMON_SHUTDOWN_PROOF_PROTOCOL,
    challenge,
    home_dir: ready.actualHome,
    pid: ready.body.pid,
    instance_id: ready.body.instance_id,
    running_binary_hash: ready.body.running_binary_hash,
    proof: createHmac('sha256', controlToken).update(Buffer.concat(chunks)).digest('base64url'),
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
