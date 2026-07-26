import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const tsDaemonEntry = path.join(cliDir, 'dist/src/daemon/daemon-entry.mjs')
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const nativeTuple = `${process.platform}-${process.arch}`
const rustDaemon = path.join(cliDir, 'npm', `tokenless-native-${nativeTuple}`, 'bin', `tokenless-daemon${executableSuffix}`)

const createdChildren = new Set()

test.after(async () => {
  await Promise.all([...createdChildren].map((child) => terminateChild(child)))
})

test('Rust and opt-in TS daemons share durable jobs through the same SQLite store', {
  timeout: 120_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-rust-interop-')
  try {
    await rustWritesTsAdvancesRustVerifies(homeDir)
    await tsWritesRustAdvancesTsVerifies(homeDir)
    assertUnixRestrictivePermissions(homeDir)
  } finally {
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon claim-next is atomic across independent real Node clients', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-claim-next-')
  const daemon = await startTsDaemon(homeDir)
  try {
    const token = readControlToken(homeDir)
    const jobId = randomUUID()
    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: 'prompt.submit',
      request_json: { prompt: 'claim exactly once' },
      job_id: jobId,
    })

    const barrierDir = fs.mkdtempSync(path.join(homeDir, 'claim-next-barrier-'))
    const releaseMarker = path.join(barrierDir, 'release')
    const readyMarkers = [
      path.join(barrierDir, 'client-a.ready'),
      path.join(barrierDir, 'client-b.ready'),
    ]
    const clientPromises = readyMarkers.map((readyMarker) => runNodeClaimClient({
      homeDir,
      daemonUrl: daemon.url,
      readyMarker,
      releaseMarker,
    }))
    let clients
    try {
      await Promise.all(readyMarkers.map((readyMarker) => waitForFile(readyMarker, 10_000)))
      fs.writeFileSync(releaseMarker, `${Date.now()}\n`, { flag: 'wx' })
      clients = await Promise.all(clientPromises)
    } catch (error) {
      if (!fs.existsSync(releaseMarker)) {
        fs.writeFileSync(releaseMarker, `${Date.now()}\n`, { flag: 'wx' })
      }
      await Promise.allSettled(clientPromises)
      throw error
    }
    const claimed = clients.filter((result) => result.job !== null)
    const empty = clients.filter((result) => result.job === null)
    assert.equal(claimed.length, 1, JSON.stringify(clients))
    assert.equal(empty.length, 1, JSON.stringify(clients))
    assert.equal(claimed[0].job.job_id, jobId)
    assert.equal(claimed[0].job.status, 'claimed')
    assert.equal(typeof claimed[0].job.claim_token, 'string')
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon preserves Playwright state, recovers leases, filters summaries, and authenticates control', {
  timeout: 150_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-playwright-')
  try {
    await verifyPlaywrightRestartResumeCancelAndAuth(homeDir)
    await verifyLeaseCrashRecovery(homeDir)
  } finally {
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

async function rustWritesTsAdvancesRustVerifies(homeDir) {
  let rust = await startRustDaemon(homeDir)
  const token = readControlToken(homeDir)
  const jobId = randomUUID()
  const claimToken = `rust-created-${randomUUID()}`
  await daemonRequest(rust.url, token, 'POST', '/jobs', {
    provider: 'chatgpt',
    action: 'prompt.submit',
    request_json: {
      prompt: 'created by rust',
      metadata: {
        taskId: 'rust-origin-task',
        projectName: 'conformance',
      },
    },
    job_id: jobId,
    claim_token: claimToken,
  })
  await shutdownDaemon(rust)
  rust = null

  let ts = await startTsDaemon(homeDir)
  try {
    const claimed = await daemonRequest(ts.url, token, 'POST', `/jobs/${encodeURIComponent(jobId)}/claim`, {
      claim_token: claimToken,
    })
    assert.equal(claimed.status, 'claimed')
    const completed = await daemonRequest(ts.url, token, 'POST', `/jobs/${encodeURIComponent(jobId)}/complete`, {
      claim_token: claimToken,
      result_json: { runtime: 'ts', step: 'advanced' },
    })
    assert.equal(completed.status, 'succeeded')
  } finally {
    await shutdownDaemon(ts).catch(() => undefined)
  }

  const verified = rustCli(homeDir, ['get', jobId])
  assert.equal(verified.job_id, jobId)
  assert.equal(verified.status, 'succeeded')
  assert.deepEqual(verified.result_json, { runtime: 'ts', step: 'advanced' })
}

async function tsWritesRustAdvancesTsVerifies(homeDir) {
  let ts = await startTsDaemon(homeDir)
  const token = readControlToken(homeDir)
  const jobId = randomUUID()
  const claimToken = `ts-created-${randomUUID()}`
  await daemonRequest(ts.url, token, 'POST', '/jobs', {
    provider: 'claude',
    action: 'prompt.submit',
    request_json: {
      prompt: 'created by ts',
      taskId: 'ts-origin-task',
      idempotencyKey: 'ts-origin-idempotency',
    },
    job_id: jobId,
    claim_token: claimToken,
  })
  await shutdownDaemon(ts)
  ts = null

  const claimed = rustCli(homeDir, ['claim', jobId, '--claim-token', claimToken])
  assert.equal(claimed.status, 'claimed')
  const completed = rustCli(homeDir, [
    'complete',
    jobId,
    '--claim-token',
    claimToken,
    '--result-json',
    JSON.stringify({ runtime: 'rust', step: 'advanced' }),
  ])
  assert.equal(completed.status, 'succeeded')

  ts = await startTsDaemon(homeDir)
  try {
    const verified = await daemonRequest(ts.url, token, 'GET', `/jobs/${encodeURIComponent(jobId)}`)
    assert.equal(verified.job_id, jobId)
    assert.equal(verified.status, 'succeeded')
    assert.deepEqual(verified.result_json, { runtime: 'rust', step: 'advanced' })
  } finally {
    await shutdownDaemon(ts).catch(() => undefined)
  }
}

async function verifyPlaywrightRestartResumeCancelAndAuth(homeDir) {
  let daemon = await startTsDaemon(homeDir)
  let token = readControlToken(homeDir)
  const tokenBeforeRestart = token
  const challenge = randomBytes(32).toString('base64url')
  const readyBefore = await readyProbe(daemon.url, challenge)
  assert.equal(readyBefore.home_dir, homeDir)
  assert.equal(readyBefore.pid, daemon.child.pid)
  assert.equal(readyBefore.ready_proof, readyProof(token, challenge, homeDir))

  const missingShutdown = await fetch(`${daemon.url}/control/shutdown`, { method: 'POST' })
  assert.equal(missingShutdown.status, 401)
  const rejectedShutdown = await fetch(`${daemon.url}/control/shutdown`, {
    method: 'POST',
    headers: { authorization: 'Bearer not-the-token' },
  })
  assert.equal(rejectedShutdown.status, 403)
  assert.equal((await readyProbe(daemon.url)).status, 'ok')

  const profileId = 'default-profile'
  const resumedJobId = randomUUID()
  const otherJobId = randomUUID()
  await daemonRequest(daemon.url, token, 'POST', '/jobs', {
    provider: 'chatgpt',
    action: 'prompt.submit',
    execution_backend: 'playwright',
    profile_id: profileId,
    job_id: resumedJobId,
    request_json: {
      prompt: 'checkpoint and resume',
      taskId: 'root-task-key',
      idempotencyKey: 'root-idempotency-key',
      metadata: {
        taskId: 'metadata-task-key',
        projectName: 'conformance-project',
        chatName: 'checkpoint-chat',
        idempotencyKey: 'metadata-idempotency-key',
      },
    },
  })
  await daemonRequest(daemon.url, token, 'POST', '/jobs', {
    provider: 'chatgpt',
    action: 'prompt.submit',
    execution_backend: 'playwright',
    profile_id: profileId,
    job_id: otherJobId,
    request_json: {
      prompt: 'not selected by summary filter',
      metadata: { taskId: 'other-task-key' },
    },
  })

  const filtered = await daemonRequest(daemon.url, token, 'GET', '/jobs?task_id=metadata-task-key&execution_backend=playwright&limit=10')
  assert.deepEqual(filtered.map((job) => job.job_id), [resumedJobId])
  assert.equal(Object.hasOwn(filtered[0], 'checkpoint_json'), false)
  assert.equal(Object.hasOwn(filtered[0], 'resume_json'), false)

  const claimed = await daemonRequest(
    daemon.url,
    token,
    'POST',
    `/control/jobs/claim-next?execution_backend=playwright&profile_id=${encodeURIComponent(profileId)}`
  )
  assert.equal(claimed.job.job_id, resumedJobId)
  assert.equal(claimed.job.status, 'claimed')
  const firstClaimToken = claimed.job.claim_token
  const checkpoint = {
    profileId,
    provider: 'chatgpt',
    actionCursor: 1,
    phase: { name: 'after-submit' },
    page: { url: 'https://chatgpt.com/c/real-boundary' },
  }
  const running = await daemonRequest(daemon.url, token, 'POST', `/control/jobs/${resumedJobId}/running`, {
    claim_token: firstClaimToken,
  })
  assert.equal(running.status, 'running')
  await daemonRequest(daemon.url, token, 'POST', `/control/jobs/${resumedJobId}/checkpoint`, {
    claim_token: firstClaimToken,
    checkpoint_json: checkpoint,
  })
  const parked = await daemonRequest(daemon.url, token, 'POST', `/control/jobs/${resumedJobId}/park`, {
    claim_token: firstClaimToken,
    blocker_json: { reason: 'provider_verification', browser: { windowOpen: false } },
    checkpoint_json: checkpoint,
  })
  assert.equal(parked.status, 'waiting_for_user')
  assert.equal(parked.blocker_json.browser.resumeRequired, undefined)

  const shutdown = await shutdownDaemon(daemon)
  assert.equal(shutdown.status, 'shutting_down')
  daemon = null

  daemon = await startTsDaemon(homeDir)
  token = readControlToken(homeDir)
  const readyAfter = await readyProbe(daemon.url, challenge)
  assert.equal(token, tokenBeforeRestart)
  assert.equal(readyAfter.home_dir, readyBefore.home_dir)
  assert.equal(readyAfter.pid, daemon.child.pid)
  assert.equal(readyAfter.ready_proof, readyBefore.ready_proof)
  assert.equal(readyAfter.ready_proof, readyProof(token, challenge, homeDir))

  const resumed = await daemonRequest(daemon.url, token, 'POST', `/jobs/${resumedJobId}/resume`, {
    browser_visibility: 'headed',
  })
  assert.equal(resumed.status, 'queued')
  const reclaimed = await daemonRequest(
    daemon.url,
    token,
    'POST',
    `/control/jobs/claim-next?execution_backend=playwright&profile_id=${encodeURIComponent(profileId)}`
  )
  assert.equal(reclaimed.job.job_id, resumedJobId)
  assert.notEqual(reclaimed.job.claim_token, firstClaimToken)
  assert.deepEqual(reclaimed.job.resume_json, { browser_visibility: 'headed' })
  assert.deepEqual(reclaimed.job.checkpoint_json, checkpoint)

  const canceled = await daemonRequest(daemon.url, token, 'POST', `/control/jobs/${resumedJobId}/cancel`)
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.error_json.code, 'job_canceled')

  const rootKeyFiltered = await daemonRequest(daemon.url, token, 'GET', '/jobs?task_id=root-idempotency-key&limit=10')
  assert.deepEqual(rootKeyFiltered.map((job) => job.job_id), [resumedJobId])

  await shutdownDaemon(daemon)
  daemon = null
}

async function verifyLeaseCrashRecovery(homeDir) {
  let daemon = await startTsDaemon(homeDir)
  const token = readControlToken(homeDir)
  const jobId = randomUUID()
  await daemonRequest(daemon.url, token, 'POST', '/jobs', {
    provider: 'gemini',
    action: 'prompt.submit',
    request_json: { prompt: 'recover expired claim' },
    job_id: jobId,
  })
  const firstClaim = await daemonRequest(daemon.url, token, 'POST', '/control/jobs/claim-next')
  assert.equal(firstClaim.job.job_id, jobId)
  const staleClaimToken = firstClaim.job.claim_token
  await killChild(daemon.child)
  daemon = null

  await delay(32_000)

  daemon = await startTsDaemon(homeDir)
  try {
    const reclaimed = await daemonRequest(daemon.url, token, 'POST', '/control/jobs/claim-next')
    assert.equal(reclaimed.job.job_id, jobId)
    assert.equal(reclaimed.job.status, 'claimed')
    assert.notEqual(reclaimed.job.claim_token, staleClaimToken)

    const staleCompletion = await fetch(`${daemon.url}/jobs/${encodeURIComponent(jobId)}/complete`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        claim_token: staleClaimToken,
        result_json: { stale: true },
      }),
    })
    assert.equal(staleCompletion.status, 403)
    const staleBody = await staleCompletion.json()
    assert.equal(staleBody.error.code, 'claim_rejected')

    const completed = await daemonRequest(daemon.url, token, 'POST', `/jobs/${encodeURIComponent(jobId)}/complete`, {
      claim_token: reclaimed.job.claim_token,
      result_json: { recovered: true },
    })
    assert.equal(completed.status, 'succeeded')
    assert.deepEqual(completed.result_json, { recovered: true })
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
  }
}

async function startTsDaemon(homeDir) {
  const port = await freePort()
  const child = spawn(process.execPath, [
    tsDaemonEntry,
    '--home',
    homeDir,
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: root,
    env: { ...process.env, TOKENLESS_HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return waitForDaemon(child, `http://127.0.0.1:${port}`, homeDir, 'TS')
}

async function startRustDaemon(homeDir) {
  const port = await freePort()
  const child = spawn(rustDaemon, [
    '--home',
    homeDir,
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: root,
    env: { ...process.env, TOKENLESS_HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return waitForDaemon(child, `http://127.0.0.1:${port}`, homeDir, 'Rust')
}

async function waitForDaemon(child, url, homeDir, label) {
  trackChild(child, homeDir)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const deadline = Date.now() + 10_000
  let lastError
  while (Date.now() < deadline) {
    const exit = await Promise.race([exited, delay(50).then(() => null)])
    if (exit) {
      throw new Error(`${label} daemon exited before ready: ${JSON.stringify(exit)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    try {
      const ready = await readyProbe(url)
      assert.equal(ready.ready, true)
      assert.equal(ready.home_dir, homeDir)
      return { child, url, homeDir, label }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`${label} daemon did not become ready: ${lastError?.message ?? lastError}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

async function shutdownDaemon(daemon) {
  if (!daemon) return null
  const token = readControlToken(daemon.homeDir)
  const body = await daemonRequest(daemon.url, token, 'POST', '/control/shutdown')
  await waitForExit(daemon.child, 5_000)
  createdChildren.delete(daemon.child)
  return body
}

async function daemonRequest(daemonUrl, token, method, requestPath, body) {
  const init = {
    method,
    headers: jsonHeaders(token),
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`${daemonUrl}${requestPath}`, init)
  const text = await response.text()
  let payload = null
  if (text) payload = JSON.parse(text)
  assert.equal(response.ok, true, `${method} ${requestPath} returned ${response.status}: ${text}`)
  return payload
}

function jsonHeaders(token) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
}

async function readyProbe(daemonUrl, challenge = randomBytes(32).toString('base64url')) {
  const response = await fetch(`${daemonUrl}/ready?challenge=${challenge}`)
  const text = await response.text()
  assert.equal(response.ok, true, `/ready returned ${response.status}: ${text}`)
  return JSON.parse(text)
}

function readyProof(token, challenge, homeDir) {
  return createHmac('sha256', token)
    .update(lengthPrefixedMessage([
      'tokenless.daemon-ready-proof.v1',
      challenge,
      'tokenless.daemon.v1',
      'tokenless.native.v1',
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

function rustCli(homeDir, args) {
  const result = spawnSync(rustDaemon, ['--home', homeDir, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_HOME: homeDir },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(result.status, 0, `rust daemon ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return JSON.parse(result.stdout)
}

async function runNodeClaimClient({ homeDir, daemonUrl, readyMarker, releaseMarker }) {
  const script = `
const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
const path = await import('node:path')
const token = readFileSync(path.join(process.env.TOKENLESS_HOME, 'daemon.token'), 'utf8').trim()
writeFileSync(process.env.TOKENLESS_READY_MARKER, process.pid + '\\n', { flag: 'wx' })
const releaseDeadline = Date.now() + 10000
while (!existsSync(process.env.TOKENLESS_RELEASE_MARKER)) {
  if (Date.now() > releaseDeadline) {
    console.error('claim client timed out waiting for release marker')
    process.exit(1)
  }
  await new Promise((resolve) => setTimeout(resolve, 10))
}
const response = await fetch(process.env.TOKENLESS_DAEMON_URL + '/control/jobs/claim-next', {
  method: 'POST',
  headers: { accept: 'application/json', authorization: 'Bearer ' + token },
})
const body = await response.text()
if (!response.ok) {
  console.error(body)
  process.exit(1)
}
console.log(body)
`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env: {
      ...process.env,
      TOKENLESS_HOME: homeDir,
      TOKENLESS_DAEMON_URL: daemonUrl,
      TOKENLESS_READY_MARKER: readyMarker,
      TOKENLESS_RELEASE_MARKER: releaseMarker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  trackChild(child, homeDir)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`claim client timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 10_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      createdChildren.delete(child)
      if (code !== 0) {
        reject(new Error(`claim client failed with ${JSON.stringify({ code, signal })}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (error) {
        reject(new Error(`claim client returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }
    })
  })
}

function trackChild(child, homeDir) {
  child.tokenlessHome = homeDir
  createdChildren.add(child)
  child.once('exit', () => {
    createdChildren.delete(child)
  })
}

async function terminateChildrenForHome(homeDir) {
  await Promise.all([...createdChildren]
    .filter((child) => child.tokenlessHome === homeDir)
    .map((child) => terminateChild(child)))
}

async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    if (child) createdChildren.delete(child)
    return
  }
  child.kill('SIGKILL')
  await waitForExit(child, 5_000).catch(() => undefined)
  createdChildren.delete(child)
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    if (child) createdChildren.delete(child)
    return
  }
  child.kill('SIGTERM')
  try {
    await waitForExit(child, 2_000)
  } catch {
    child.kill('SIGKILL')
    await waitForExit(child, 2_000).catch(() => undefined)
  } finally {
    createdChildren.delete(child)
  }
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    await delay(10)
  }
  throw new Error(`file did not appear within ${timeoutMs} ms: ${filePath}`)
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs} ms`))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolve()
    }
    child.once('exit', onExit)
  })
}

function tempHome(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function readControlToken(homeDir) {
  return fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
}

function assertUnixRestrictivePermissions(homeDir) {
  if (process.platform === 'win32') return
  assert.equal(fileMode(homeDir), 0o700)
  assert.equal(fileMode(path.join(homeDir, 'daemon.token')), 0o600)
  assert.equal(fileMode(path.join(homeDir, 'tokenless.sqlite3')), 0o600)
}

function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === 'string') reject(new Error('failed to allocate a port'))
        else resolve(address.port)
      })
    })
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requireBuiltArtifacts() {
  assert.equal(fs.existsSync(tsDaemonEntry), true, `missing compiled TS daemon: ${tsDaemonEntry}`)
  assert.equal(fs.existsSync(rustDaemon), true, `missing packaged Rust daemon: ${rustDaemon}`)
}
