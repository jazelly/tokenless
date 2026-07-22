import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
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

test('ensureDaemonReady refuses to restart a stale daemon without process correlation', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-foreign-')))
  const token = 'foreign-control-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  let readyRequests = 0
  const server = await startForeignReadyServer({
    homeDir,
    token,
    version: '0.0.0-stale',
    includeProcessProof: false,
    onReady: () => { readyRequests += 1 },
  })
  try {
    const runtime = await importCli()
    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir, daemonUrl: server.url, timeoutMs: 1000 }),
      (error) => error.code === 'daemon_restart_unsafe' && /will not stop it automatically/.test(error.message)
    )
    assert.equal(server.listening(), true)
    assert.equal(readyRequests > 0, true)
  } finally {
    await server.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('ensureDaemonReady restarts a process-correlated stale daemon after refreshing runtime', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-safe-restart-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const token = 'safe-restart-control-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  const stale = await startChildStaleDaemon({ homeDir, token, daemonUrl, includeProcessProof: true })
  let restartedPid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    restartedPid = ready.pid
    assert.equal(ready.started, true)
    assert.equal(ready.body.version, packageVersion)
    assert.notEqual(restartedPid, stale.pid)
    assert.equal(await processExited(stale.child), true)
  } finally {
    if (restartedPid) await stopPid(restartedPid)
    stale.child.kill('SIGTERM')
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('ensureDaemonReady restarts a same-version daemon whose process proof binds a different binary hash', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-same-version-hash-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const token = 'same-version-hash-control-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  const stale = await startChildStaleDaemon({
    homeDir,
    token,
    daemonUrl,
    version: packageVersion,
    includeProcessProof: true,
    runningBinaryHash: '0'.repeat(64),
  })
  let restartedPid
  try {
    const runtime = await importCli()
    const ready = await runtime.ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
    restartedPid = ready.pid
    const inspection = await runtime.inspectManagedRuntime(homeDir)
    assert.equal(ready.started, true)
    assert.equal(ready.body.version, packageVersion)
    assert.equal(ready.body.running_binary_hash, inspection.packaged.hash)
    assert.notEqual(restartedPid, stale.pid)
    assert.equal(await processExited(stale.child), true)
  } finally {
    if (restartedPid) await stopPid(restartedPid)
    stale.child.kill('SIGTERM')
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('concurrent ensureDaemonReady serializes stale daemon stop, refresh, and start under the lifecycle lock', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-concurrent-lock-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const token = 'concurrent-lifecycle-control-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  const stale = await startChildStaleDaemon({
    homeDir,
    token,
    daemonUrl,
    includeProcessProof: true,
    runningBinaryHash: '1'.repeat(64),
  })
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
    assert.equal(await processExited(stale.child), true)
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    if (startedPid) await stopPid(startedPid)
    stale.child.kill('SIGTERM')
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('ensureDaemonReady terminates a spawned daemon and removes its pid marker when identity coherence fails', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-spawn-cleanup-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const token = 'spawn-cleanup-control-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  const childPidPath = path.join(homeDir, 'spawned-bad-daemon.pid')
  const binaryPath = writeSpawnedBadDaemon({
    homeDir,
    childPidPath,
    version: packageVersion,
    runningBinaryHash: '3'.repeat(64),
  })
  try {
    const runtime = await importCli()
    await assert.rejects(
      runtime.ensureDaemonReady({ homeDir, daemonUrl, binaryPath, timeoutMs: 5_000 }),
      (error) => error.code === 'daemon_binary_hash_mismatch'
    )
    const spawnedPid = Number(fs.readFileSync(childPidPath, 'utf8'))
    assert.equal(await pidExited(spawnedPid), true)
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.pid.json')), false)
  } finally {
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

test('doctor reports daemon mismatch for an old running daemon instead of ok=true', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-doctor-old-daemon-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const token = 'doctor-old-daemon-control-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  const server = await startChildStaleDaemon({
    homeDir,
    token,
    daemonUrl,
    version: '0.1.2',
    includeProcessProof: true,
    runningBinaryHash: '2'.repeat(64),
  })
  try {
    const result = runCli(['doctor', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.checks.daemon.ok, false)
    assert.equal(payload.checks.daemon.ready, true)
    assert.equal(payload.checks.daemon.code, 'daemon_version_mismatch')
    assert.equal(payload.checks.daemon.expectedVersion, packageVersion)
    assert.equal(payload.checks.daemon.runningVersion, '0.1.2')
    assert.equal(payload.checks.daemon.runningHash, '2'.repeat(64))
    assert.match(payload.checks.daemon.packagedHash, /^[0-9a-f]{64}$/)
    assert.equal(payload.checks.daemon.daemonLogPath, path.join(homeDir, 'daemon.log'))
    assert.equal(payload.checks.daemon.daemonLogExists, false)
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.log')), false)
  } finally {
    server.child.kill('SIGTERM')
    await processExited(server.child)
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

test('setup aborts on local runtime failure before provider readiness jobs', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-setup-runtime-gate-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-setup-runtime-gate-skills-')))
  const token = 'setup-runtime-control-token'
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${token}\n`, { mode: 0o600 })
  writeVerifiedSkills(skillHome)
  const server = await startChildStaleDaemon({
    homeDir,
    token,
    daemonUrl: `http://127.0.0.1:${await freePort()}`,
    version: '0.0.0-stale',
    includeProcessProof: false,
  })
  try {
    const result = await runCliAsync([
      'setup',
      '--defaults',
      '--fresh',
      '--skip-skill-install',
      '--home', homeDir,
      '--daemon-url', server.url,
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'daemon_restart_unsafe')
    assert.equal(fs.existsSync(path.join(homeDir, 'browser', 'profiles.json')), false)
    assert.equal(server.jobRequests(), 0)
  } finally {
    server.child.kill('SIGTERM')
    await processExited(server.child)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
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

function runCliAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: root,
      env: { ...process.env, TOKENLESS_PROVIDER: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Tokenless CLI timed out.\n${stdout}\n${stderr}`))
    }, 20_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

async function importCli() {
  return await import(`${pathToFileURL(cliIndex).href}?daemon_lifecycle=${Date.now()}_${Math.random()}`)
}

async function startForeignReadyServer({
  homeDir,
  token,
  version,
  includeProcessProof,
  runningBinaryHash = 'f'.repeat(64),
  onReady = () => {},
}) {
  let jobRequests = 0
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/jobs')) jobRequests += 1
    if (!request.url?.startsWith('/ready')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    onReady()
    const url = new URL(request.url, 'http://127.0.0.1')
    const challenge = url.searchParams.get('challenge') ?? ''
    const body = {
      protocol: 'tokenless.daemon.v1',
      daemon_protocol: 'tokenless.daemon.v1',
      version,
      native_protocol: 'tokenless.native.v1',
      status: 'ok',
      ready: true,
      home_dir: homeDir,
      ready_proof_protocol: 'tokenless.daemon-ready-proof.v1',
      ready_challenge: challenge,
      ready_proof: hmac(token, [
        'tokenless.daemon-ready-proof.v1',
        challenge,
        'tokenless.daemon.v1',
        'tokenless.native.v1',
        homeDir,
      ]),
      ...(includeProcessProof ? {
        pid: process.pid,
        instance_id: 'AAAAAAAAAAAAAAAAAAAAAA',
        running_binary_hash: runningBinaryHash,
        daemon_process_proof_protocol: 'tokenless.daemon-process-proof.v1',
        daemon_process_proof: hmac(token, [
          'tokenless.daemon-process-proof.v1',
          challenge,
          'tokenless.daemon.v1',
          'tokenless.native.v1',
          homeDir,
          String(process.pid),
          'AAAAAAAAAAAAAAAAAAAAAA',
          runningBinaryHash,
        ]),
      } : {}),
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    get url() {
      return `http://127.0.0.1:${server.address().port}`
    },
    get jobRequests() {
      return jobRequests
    },
    listening() {
      return server.listening
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

async function startChildStaleDaemon({
  homeDir,
  token,
  daemonUrl,
  includeProcessProof,
  runningBinaryHash = 'f'.repeat(64),
  version = '0.0.0-stale',
}) {
  const entry = path.join(homeDir, 'stale-daemon.mjs')
  const jobRequestsPath = path.join(homeDir, 'stale-daemon-job-requests.txt')
  fs.writeFileSync(entry, `
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

const homeDir = ${JSON.stringify(homeDir)}
const token = ${JSON.stringify(token)}
const daemonUrl = new URL(${JSON.stringify(daemonUrl)})
const instanceId = 'BBBBBBBBBBBBBBBBBBBBBB'
const includeProcessProof = ${JSON.stringify(includeProcessProof)}
const runningBinaryHash = ${JSON.stringify(runningBinaryHash)}
const jobRequestsPath = ${JSON.stringify(jobRequestsPath)}
const server = http.createServer((request, response) => {
  if (request.url?.startsWith('/jobs')) {
    fs.appendFileSync(jobRequestsPath, '1\\n')
  }
  if (!request.url?.startsWith('/ready')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
    return
  }
  const url = new URL(request.url, 'http://127.0.0.1')
  const challenge = url.searchParams.get('challenge') ?? ''
  const body = {
    protocol: 'tokenless.daemon.v1',
    daemon_protocol: 'tokenless.daemon.v1',
    version: ${JSON.stringify(version)},
    native_protocol: 'tokenless.native.v1',
    status: 'ok',
    ready: true,
    home_dir: homeDir,
    ready_proof_protocol: 'tokenless.daemon-ready-proof.v1',
    ready_challenge: challenge,
    ready_proof: hmac([
      'tokenless.daemon-ready-proof.v1',
      challenge,
      'tokenless.daemon.v1',
      'tokenless.native.v1',
      homeDir,
    ]),
    ...(includeProcessProof ? {
      pid: process.pid,
      instance_id: instanceId,
      running_binary_hash: runningBinaryHash,
      daemon_process_proof_protocol: 'tokenless.daemon-process-proof.v1',
      daemon_process_proof: hmac([
        'tokenless.daemon-process-proof.v1',
        challenge,
        'tokenless.daemon.v1',
        'tokenless.native.v1',
        homeDir,
        String(process.pid),
        instanceId,
        runningBinaryHash,
      ]),
    } : {}),
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
})
server.listen(Number(daemonUrl.port), daemonUrl.hostname, () => {
  process.stdout.write('ready\\n')
})
process.once('SIGTERM', () => server.close(() => process.exit(0)))

function hmac(fields) {
  return createHmac('sha256', token).update(lengthPrefixed(fields)).digest('base64url')
}

function lengthPrefixed(fields) {
  return Buffer.concat(fields.flatMap((field) => {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    return [length, value]
  }))
}
`, { mode: 0o700 })
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for stale daemon.\n${stdout}\n${stderr}`)), 5000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout.on('data', () => {
      if (!stdout.includes('ready')) return
      clearTimeout(timer)
      resolve()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Stale daemon exited early with ${code}.\n${stdout}\n${stderr}`))
    })
  })
  return {
    child,
    pid: child.pid,
    url: daemonUrl,
    jobRequests() {
      try {
        return fs.readFileSync(jobRequestsPath, 'utf8').trim().split('\\n').filter(Boolean).length
      } catch {
        return 0
      }
    },
  }
}

function writeSpawnedBadDaemon({
  homeDir,
  childPidPath,
  version,
  runningBinaryHash,
}) {
  const entry = path.join(homeDir, 'spawned-bad-daemon.mjs')
  fs.writeFileSync(entry, `#!/usr/bin/env node
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const valueAfter = (flag) => args[args.indexOf(flag) + 1]
const homeDir = valueAfter('--home')
const host = valueAfter('--host')
const port = Number(valueAfter('--port'))
const token = fs.readFileSync(\`\${homeDir.replace(/\\/$/, '')}/daemon.token\`, 'utf8').trim()
const version = ${JSON.stringify(version)}
const runningBinaryHash = ${JSON.stringify(runningBinaryHash)}
const instanceId = 'CCCCCCCCCCCCCCCCCCCCCC'
const childPidPath = ${JSON.stringify(childPidPath)}

const server = http.createServer((request, response) => {
  if (!request.url?.startsWith('/ready')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
    return
  }
  const url = new URL(request.url, 'http://127.0.0.1')
  const challenge = url.searchParams.get('challenge') ?? ''
  const body = {
    protocol: 'tokenless.daemon.v1',
    daemon_protocol: 'tokenless.daemon.v1',
    version,
    native_protocol: 'tokenless.native.v1',
    status: 'ok',
    ready: true,
    home_dir: homeDir,
    pid: process.pid,
    instance_id: instanceId,
    running_binary_hash: runningBinaryHash,
    ready_proof_protocol: 'tokenless.daemon-ready-proof.v1',
    ready_challenge: challenge,
    ready_proof: hmac([
      'tokenless.daemon-ready-proof.v1',
      challenge,
      'tokenless.daemon.v1',
      'tokenless.native.v1',
      homeDir,
    ]),
    daemon_process_proof_protocol: 'tokenless.daemon-process-proof.v1',
    daemon_process_proof: hmac([
      'tokenless.daemon-process-proof.v1',
      challenge,
      'tokenless.daemon.v1',
      'tokenless.native.v1',
      homeDir,
      String(process.pid),
      instanceId,
      runningBinaryHash,
    ]),
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
})

server.listen(port, host, () => {
  fs.writeFileSync(childPidPath, String(process.pid))
})
process.once('SIGTERM', () => server.close(() => process.exit(0)))

function hmac(fields) {
  return createHmac('sha256', token).update(lengthPrefixed(fields)).digest('base64url')
}

function lengthPrefixed(fields) {
  return Buffer.concat(fields.flatMap((field) => {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    return [length, value]
  }))
}
`, { mode: 0o700 })
  return entry
}

function hmac(token, fields) {
  return createHmac('sha256', token).update(lengthPrefixed(fields)).digest('base64url')
}

function lengthPrefixed(fields) {
  return Buffer.concat(fields.flatMap((field) => {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    return [length, value]
  }))
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

async function processExited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (child.exitCode !== null || child.signalCode !== null) return true
  }
  return false
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

function writeVerifiedSkills(home) {
  const rootDir = path.join(home, '.agents')
  const names = ['tokenless', 'tokenless-install']
  for (const name of names) {
    const directory = path.join(rootDir, 'skills', name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8')
  }
  fs.writeFileSync(path.join(rootDir, '.skill-lock.json'), JSON.stringify({
    version: 3,
    skills: Object.fromEntries(names.map((name) => [name, {
      source: 'jazelly/tokenless',
      sourceType: 'github',
      sourceUrl: 'https://github.com/jazelly/tokenless.git',
      skillPath: `skills/${name}/SKILL.md`,
    }])),
  }), 'utf8')
}
