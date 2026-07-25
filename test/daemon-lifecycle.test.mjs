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

test('ensureDaemonReady installs the packaged daemon and reports the running version and process proof', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-first-install-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let pid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    pid = ready.pid
    assert.equal(ready.started, true)
    assert.equal(ready.body.version, packageVersion)
    assert.equal(ready.body.daemon_process_proof_protocol, runtime.DAEMON_PROCESS_PROOF_PROTOCOL)
    assert.equal(ready.body.daemon_process_identity_error, undefined)
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

test('daemon stop uses authenticated self-shutdown for a verified daemon', async () => {
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

test('setup daemon reconciliation replaces a verified same-home incompatible major daemon', {
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
    const incompatibleBinary = buildIncompatibleDaemon(crateDir)
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

    const runtime = await importCli()
    const incompatible = await waitForReadyVersion(runtime, homeDir, daemonUrl, '1.0.0')
    assert.equal(incompatible.ok, true)
    assert.equal(incompatible.actualHome, homeDir)

    const ready = await runtime.ensureSetupDaemonRunnable({ homeDir, daemonUrl, timeoutMs: 10_000 })
    assert.equal(ready.reconciliation.attempted, true)
    assert.equal(ready.reconciliation.reason, 'major_mismatch')
    assert.equal(ready.reconciliation.previous.version, '1.0.0')
    assert.equal(ready.reconciliation.previous.major, 1)
    assert.equal(ready.reconciliation.stopped.status, 'stopped')
    assert.equal(ready.runningVersion, packageVersion)
    assert.equal(ready.runningMajor, 0)
    assert.equal(ready.versionCompatible, true)
    assert.equal(ready.compatibilityPolicy, 'semantic-major')
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

function buildIncompatibleDaemon(crateDir) {
  fs.cpSync(path.join(root, 'packages/daemon'), crateDir, { recursive: true })
  const manifestPath = path.join(crateDir, 'Cargo.toml')
  const manifest = fs.readFileSync(manifestPath, 'utf8')
  fs.writeFileSync(manifestPath, manifest.replace(/^version = ".*"$/m, 'version = "1.0.0"'))
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
