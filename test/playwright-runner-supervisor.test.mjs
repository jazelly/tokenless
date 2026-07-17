import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RUNNER_HEARTBEAT_FRESHNESS_MS,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  TokenlessPlaywrightError,
  ensureRunnerMarkersDir,
  runnerSupervisorStatus,
  startRunnerSupervisor,
  stopRunnerSupervisor,
  writeRunnerHeartbeat,
} from '../packages/playwright/dist/src/index.js'

test('home-scoped supervisor starts one runner, waits for heartbeat, and writes private markers', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  let spawns = 0
  const options = {
    homeDir,
    sessionId: 'session-a',
    heartbeatTimeoutMs: 1000,
    isProcessAlive: (pid) => pid === 4242,
    spawnDetached: async (_command, args) => {
      spawns += 1
      assert.equal(args.includes('--profile-id'), false)
      assert.equal(args.includes('--profile-directory'), false)
      const sessionId = args[args.indexOf('--session-id') + 1]
      await writeRunnerHeartbeat({ homeDir, sessionId, pid: 4242, now: fixedNow })
      return { pid: 4242 }
    },
    now: fixedNow,
  }

  const started = await startRunnerSupervisor(options)
  const second = await startRunnerSupervisor(options)
  const status = await runnerSupervisorStatus(options)
  const markers = await ensureRunnerMarkersDir(homeDir)

  assert.equal(started.started, true)
  assert.equal(started.safeToStop, true)
  assert.equal(second.started, false)
  assert.equal(spawns, 1)
  assert.deepEqual(status, {
    state: 'running',
    pid: 4242,
    sessionId: 'session-a',
    safeToStop: true,
    heartbeatAt: '2026-07-17T00:00:00.000Z',
  })
  assert.equal((await stat(markers.runnerDir)).mode & 0o777, 0o700)
  assert.equal((await stat(markers.sessionFile)).mode & 0o777, 0o600)
  assert.equal((await stat(markers.pidFile)).mode & 0o777, 0o600)
  assert.equal((await stat(markers.heartbeatFile)).mode & 0o777, 0o600)
  assert.equal((await stat(markers.logFile)).mode & 0o777, 0o600)
})

test('supervisor validates heartbeat identity before stopping', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const killed = []
  const options = {
    homeDir,
    sessionId: 'session-a',
    heartbeatTimeoutMs: 1000,
    isProcessAlive: (pid) => pid === 7777,
    killProcess: async (pid, signal) => killed.push({ pid, signal }),
    spawnDetached: async (_command, args) => {
      const sessionId = args[args.indexOf('--session-id') + 1]
      await writeRunnerHeartbeat({ homeDir, sessionId, pid: 7777, now: fixedNow })
      return { pid: 7777 }
    },
    now: fixedNow,
  }

  await startRunnerSupervisor(options)
  const stopped = await stopRunnerSupervisor(options)

  assert.deepEqual(killed, [{ pid: 7777, signal: 'SIGTERM' }])
  assert.equal(stopped.state, 'stopped')
})

test('supervisor serializes concurrent starts to one spawned runner per home', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  let spawns = 0
  const options = {
    homeDir,
    heartbeatTimeoutMs: 1000,
    isProcessAlive: (pid) => pid === 5151,
    spawnDetached: async (_command, args) => {
      spawns += 1
      await delay(20)
      const sessionId = args[args.indexOf('--session-id') + 1]
      await writeRunnerHeartbeat({ homeDir, sessionId, pid: 5151, now: fixedNow })
      return { pid: 5151 }
    },
    now: fixedNow,
  }

  const results = await Promise.all([
    startRunnerSupervisor({ ...options, sessionId: 'session-a' }),
    startRunnerSupervisor({ ...options, sessionId: 'session-b' }),
  ])

  assert.equal(spawns, 1)
  assert.equal(results.filter((result) => result.started).length, 1)
  assert.equal(results.filter((result) => !result.started).length, 1)
  assert.equal((await runnerSupervisorStatus(options)).safeToStop, true)
})

test('supervisor refuses to overwrite live unverified sessions', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const markers = await ensureRunnerMarkersDir(homeDir)
  await writeFile(markers.sessionFile, JSON.stringify({
    protocol: 'tokenless.playwright.runner-session.v1',
    sessionId: 'unverified',
    pid: 9999,
    startedAt: '2026-07-17T00:00:00.000Z',
  }), { mode: 0o600 })
  await writeFile(markers.pidFile, await readFile(markers.sessionFile), { mode: 0o600 })

  const options = {
    homeDir,
    isProcessAlive: (pid) => pid === 9999,
    spawnDetached: async () => {
      throw new Error('must not spawn over unverified live marker')
    },
  }

  const status = await runnerSupervisorStatus(options)
  assert.equal(status.state, 'unsafe')
  await assert.rejects(() => startRunnerSupervisor(options), matchCode('playwright_runner_identity_unverified'))
  await assert.rejects(() => stopRunnerSupervisor(options), matchCode('playwright_runner_identity_unverified'))
})

test('supervisor treats stale heartbeat for a live pid as unsafe', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const markers = await ensureRunnerMarkersDir(homeDir)
  await writeFile(markers.sessionFile, JSON.stringify({
    protocol: 'tokenless.playwright.runner-session.v1',
    sessionId: 'session-a',
    pid: 6060,
    startedAt: '2026-07-17T00:00:00.000Z',
  }), { mode: 0o600 })
  await writeFile(markers.pidFile, await readFile(markers.sessionFile), { mode: 0o600 })
  await writeFile(markers.heartbeatFile, JSON.stringify({
    protocol: 'tokenless.playwright.runner-heartbeat.v1',
    sessionId: 'session-a',
    pid: 6060,
    updatedAt: '2000-01-01T00:00:00.000Z',
  }), { mode: 0o600 })
  const options = {
    homeDir,
    heartbeatTimeoutMs: 50,
    isProcessAlive: (pid) => pid === 6060,
    now: fixedNow,
  }

  const status = await runnerSupervisorStatus(options)
  assert.equal(status.state, 'unsafe')
  await assert.rejects(() => stopRunnerSupervisor(options), matchCode('playwright_runner_identity_unverified'))
})

test('supervisor uses a wider default heartbeat freshness window than writer cadence', async () => {
  assert.equal(RUNNER_HEARTBEAT_INTERVAL_MS, 2_000)
  assert.equal(RUNNER_HEARTBEAT_FRESHNESS_MS, 15_000)
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const markers = await ensureRunnerMarkersDir(homeDir)
  await writeFile(markers.sessionFile, JSON.stringify({
    protocol: 'tokenless.playwright.runner-session.v1',
    sessionId: 'session-a',
    pid: 6161,
    startedAt: '2026-07-17T00:00:00.000Z',
  }), { mode: 0o600 })
  await writeFile(markers.pidFile, await readFile(markers.sessionFile), { mode: 0o600 })
  await writeFile(markers.heartbeatFile, JSON.stringify({
    protocol: 'tokenless.playwright.runner-heartbeat.v1',
    sessionId: 'session-a',
    pid: 6161,
    updatedAt: '2026-07-16T23:59:50.000Z',
  }), { mode: 0o600 })
  const options = {
    homeDir,
    isProcessAlive: (pid) => pid === 6161,
    now: fixedNow,
  }

  assert.equal((await runnerSupervisorStatus(options)).state, 'running')
  await writeFile(markers.heartbeatFile, JSON.stringify({
    protocol: 'tokenless.playwright.runner-heartbeat.v1',
    sessionId: 'session-a',
    pid: 6161,
    updatedAt: '2026-07-16T23:59:44.000Z',
  }), { mode: 0o600 })
  assert.equal((await runnerSupervisorStatus(options)).state, 'unsafe')
})

test('supervisor kills and cleans its own spawned runner when heartbeat handshake times out', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const alive = new Set([7070])
  const killed = []
  const options = {
    homeDir,
    sessionId: 'session-a',
    heartbeatTimeoutMs: 50,
    isProcessAlive: (pid) => alive.has(pid),
    killProcess: async (pid, signal) => {
      killed.push({ pid, signal })
      alive.delete(pid)
    },
    spawnDetached: async () => ({ pid: 7070 }),
    now: fixedNow,
  }

  await assert.rejects(() => startRunnerSupervisor(options), matchCode('playwright_runner_heartbeat_timeout'))
  assert.deepEqual(killed, [{ pid: 7070, signal: 'SIGTERM' }])
  assert.equal((await runnerSupervisorStatus(options)).state, 'stopped')
})

test('supervisor treats corrupt existing session markers as unsafe', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const markers = await ensureRunnerMarkersDir(homeDir)
  await writeFile(markers.sessionFile, '{not json', { mode: 0o600 })

  const status = await runnerSupervisorStatus({ homeDir })
  assert.equal(status.state, 'unsafe')
  await assert.rejects(() => startRunnerSupervisor({
    homeDir,
    spawnDetached: async () => {
      throw new Error('must not spawn over corrupt marker')
    },
  }), matchCode('playwright_runner_identity_unverified'))
})

test('supervisor rejects symlink and overbroad marker files', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const markers = await ensureRunnerMarkersDir(homeDir)
  await writeFile(join(markers.runnerDir, 'target.json'), '{}', { mode: 0o600 })
  await symlink(join(markers.runnerDir, 'target.json'), markers.sessionFile)

  await assert.rejects(() => runnerSupervisorStatus({ homeDir }), matchCode('playwright_runner_marker_permissions'))
})

test('supervisor rejects pre-existing pid symlinks before spawning', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const markers = await ensureRunnerMarkersDir(homeDir)
  await writeFile(join(markers.runnerDir, 'target.json'), '{}', { mode: 0o600 })
  await symlink(join(markers.runnerDir, 'target.json'), markers.pidFile)
  let spawned = false

  await assert.rejects(() => startRunnerSupervisor({
    homeDir,
    isProcessAlive: () => false,
    spawnDetached: async () => {
      spawned = true
      return { pid: 1 }
    },
  }), matchCode('playwright_runner_marker_permissions'))
  assert.equal(spawned, false)
})

test('runner heartbeat writer rejects pre-existing heartbeat symlinks', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-supervisor-'))
  const markers = await ensureRunnerMarkersDir(homeDir)
  await writeFile(join(markers.runnerDir, 'target.json'), '{}', { mode: 0o600 })
  await symlink(join(markers.runnerDir, 'target.json'), markers.heartbeatFile)

  await assert.rejects(() => writeRunnerHeartbeat({
    homeDir,
    sessionId: 'session-a',
    pid: 1234,
  }), matchCode('playwright_runner_marker_permissions'))
})

function fixedNow() {
  return new Date('2026-07-17T00:00:00.000Z')
}

function matchCode(code) {
  return (error) => error instanceof TokenlessPlaywrightError && error.code === code
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
