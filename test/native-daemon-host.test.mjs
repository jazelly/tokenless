import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('native host claims and completes a daemon job through the Rust control plane', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-native-'))
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const daemon = startDaemon({ homeDir, port })

  try {
    await waitForDaemonReady(daemonUrl, daemon)
    const { createDaemonJob } = await import(pathToFileURL(path.join(root, 'packages/cli/dist/src/index.js')).href)
    const created = await createDaemonJob({
      daemonUrl,
      provider: 'chatgpt',
      action: 'submit_and_read',
      requestJson: { prompt: 'complete through native host daemon bridge' },
    })

    assert.equal(created.provider, 'chatgpt')
    assert.equal(created.action, 'submit_and_read')
    assert.equal(created.status, 'queued')
    assert.equal(typeof created.claim_token, 'string')

    const claim = await nativeHostMessage({
      type: 'tokenless.native.daemon_claim_next',
      provider: 'chatgpt',
      action: 'submit_and_read',
    }, { TOKENLESS_HOME: homeDir, TOKENLESS_DAEMON_URL: daemonUrl })

    assert.equal(claim.ok, true)
    assert.equal(claim.result.job.job_id, created.job_id)
    assert.equal(claim.result.job.status, 'claimed')
    assert.equal(claim.result.job.claim_token, created.claim_token)

    const completionResult = { text: 'daemon job completed by native host' }
    const complete = await nativeHostMessage({
      type: 'tokenless.native.daemon_complete_job',
      jobId: claim.result.job.job_id,
      claimToken: claim.result.job.claim_token,
      result: completionResult,
    }, { TOKENLESS_HOME: homeDir, TOKENLESS_DAEMON_URL: daemonUrl })

    assert.equal(complete.ok, true)
    assert.equal(complete.result.job_id, created.job_id)
    assert.equal(complete.result.status, 'succeeded')
    assert.deepEqual(complete.result.result_json, completionResult)
    assert.equal(complete.result.claim_token, undefined)

    const empty = await nativeHostMessage({
      type: 'tokenless.native.daemon_claim_next',
      provider: 'chatgpt',
      action: 'submit_and_read',
    }, { TOKENLESS_HOME: homeDir, TOKENLESS_DAEMON_URL: daemonUrl })

    assert.deepEqual(empty, { ok: true, result: { job: null } })
  } finally {
    await stopDaemon(daemon)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('native host daemon bridge pushes claimed jobs over one long-lived process', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-native-bridge-'))
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const daemon = startDaemon({ homeDir, port })
  let nativeHost

  try {
    await waitForDaemonReady(daemonUrl, daemon)
    const config = await nativeHostMessage({
      type: 'tokenless.native.write_config',
      daemonUrl,
    }, { TOKENLESS_HOME: homeDir, TOKENLESS_DAEMON_URL: '' })
    assert.equal(config.ok, true, JSON.stringify(config, null, 2))
    const { createDaemonJob } = await import(pathToFileURL(path.join(root, 'packages/cli/dist/src/index.js')).href)

    nativeHost = startNativeHost({ TOKENLESS_HOME: homeDir, TOKENLESS_DAEMON_URL: '' })
    writeNativeHostMessage(nativeHost, {
      type: 'tokenless.native.daemon_connect',
      provider: 'chatgpt',
      action: 'submit_and_read',
    })

    const connected = await readNativeHostMessage(nativeHost)
    assert.equal(connected.type, 'tokenless.native.daemon_connected')
    assert.equal(connected.ok, true)

    const created = await createDaemonJob({
      daemonUrl,
      provider: 'chatgpt',
      action: 'submit_and_read',
      requestJson: { prompt: 'pushed through long-lived native daemon bridge' },
    })

    const pushed = await readNativeHostMessage(nativeHost, (message) => message.type === 'tokenless.native.daemon_job')
    assert.equal(pushed.ok, true, JSON.stringify(pushed, null, 2))
    assert.equal(pushed.result.job.job_id, created.job_id)
    assert.equal(pushed.result.job.status, 'claimed')
    assert.equal(pushed.result.job.claim_token, created.claim_token)
    assert.equal(nativeHost.writeCount, 1, 'test must not send a per-job native claim message')
  } finally {
    if (nativeHost) await stopNativeHost(nativeHost)
    await stopDaemon(daemon)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('native host daemon bridge waits for extension readiness before claiming another job', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-native-backpressure-'))
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const daemon = startDaemon({ homeDir, port })
  let nativeHost

  try {
    await waitForDaemonReady(daemonUrl, daemon)
    const config = await nativeHostMessage({
      type: 'tokenless.native.write_config',
      daemonUrl,
    }, { TOKENLESS_HOME: homeDir, TOKENLESS_DAEMON_URL: '' })
    assert.equal(config.ok, true, JSON.stringify(config, null, 2))
    const { createDaemonJob } = await import(pathToFileURL(path.join(root, 'packages/cli/dist/src/index.js')).href)

    nativeHost = startNativeHost({ TOKENLESS_HOME: homeDir, TOKENLESS_DAEMON_URL: '' })
    writeNativeHostMessage(nativeHost, {
      type: 'tokenless.native.daemon_connect',
      provider: 'chatgpt',
      action: 'submit_and_read',
    })

    const connected = await readNativeHostMessage(nativeHost)
    assert.equal(connected.type, 'tokenless.native.daemon_connected')
    assert.equal(connected.ok, true)

    const first = await createDaemonJob({
      daemonUrl,
      provider: 'chatgpt',
      action: 'submit_and_read',
      requestJson: { prompt: 'first long-lived bridge job' },
    })
    const second = await createDaemonJob({
      daemonUrl,
      provider: 'chatgpt',
      action: 'submit_and_read',
      requestJson: { prompt: 'second long-lived bridge job' },
    })

    const firstPushed = await readNativeHostMessage(nativeHost, (message) => message.type === 'tokenless.native.daemon_job')
    assert.equal(firstPushed.ok, true, JSON.stringify(firstPushed, null, 2))
    assert.equal(firstPushed.result.job.job_id, first.job_id)
    assert.equal(firstPushed.result.job.status, 'claimed')

    await delay(700)
    const secondBeforeReady = await readDaemonJob(daemonUrl, second.job_id)
    assert.equal(secondBeforeReady.status, 'queued')
    assert.equal(secondBeforeReady.claim_token, undefined)

    writeNativeHostMessage(nativeHost, { type: 'tokenless.native.daemon_ready' })
    const secondPushed = await readNativeHostMessage(nativeHost, (message) => message.type === 'tokenless.native.daemon_job')
    assert.equal(secondPushed.ok, true, JSON.stringify(secondPushed, null, 2))
    assert.equal(secondPushed.result.job.job_id, second.job_id)
    assert.equal(secondPushed.result.job.status, 'claimed')
    assert.equal(typeof secondPushed.result.job.claim_token, 'string')
  } finally {
    if (nativeHost) await stopNativeHost(nativeHost)
    await stopDaemon(daemon)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('daemon client rejects non-loopback daemon URLs', async () => {
  await import(pathToFileURL(path.join(root, 'packages/cli/dist/src/index.js')).href)
    .then(({ daemonUrl }) => {
      for (const url of [
        'http://192.168.1.10:7331',
        'https://127.0.0.1:7331',
        'http://example.com:7331',
        'not-a-url',
      ]) {
        assert.throws(
          () => daemonUrl(url),
          /loopback HTTP URL/
        )
      }
      assert.equal(daemonUrl('http://127.0.0.1:7331/'), 'http://127.0.0.1:7331')
      assert.equal(daemonUrl('http://localhost:7331'), 'http://localhost:7331')
      assert.equal(daemonUrl('http://[::1]:7331'), 'http://[::1]:7331')
    })
})

test('CLI run uses daemon transport when daemon is reachable', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-cli-'))
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const daemon = startDaemon({ homeDir, port })

  try {
    await waitForDaemonReady(daemonUrl, daemon)
    const run = spawnSync(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'run',
      '--prompt',
      'hello through daemon',
      '--extension-id',
      'abcdefghijklmnopabcdefghijklmnop',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--no-open',
      '--no-wait',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
    })

    assert.equal(run.status, 0, run.stderr)
    const payload = JSON.parse(run.stdout)
    assert.equal(payload.transport, 'daemon')
    assert.equal(payload.provider, 'chatgpt')
    assert.equal(payload.runnerUrl, undefined)
    assert.doesNotMatch(run.stdout, /runnerUrl|daemon\/runner\.html/)
    assert.deepEqual(payload.statusLog.map((event) => event.event), ['daemon_created', 'detached'])
    assert.equal(fs.existsSync(path.join(homeDir, 'jobs', `${payload.jobId}.request.json`)), false)

    const job = await fetch(`${daemonUrl}/jobs/${encodeURIComponent(payload.jobId)}`).then((response) => response.json())
    assert.equal(job.status, 'queued')
    assert.match(job.request_json.prompt, /hello through daemon/)
    assert.equal(job.request_json.metadata.source, 'tokenless-cli')
    assert.equal(job.claim_token, undefined)

    const config = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
    assert.equal(config.daemonUrl, daemonUrl)

    const claim = await nativeHostMessage({
      type: 'tokenless.native.daemon_claim_next',
      provider: 'chatgpt',
      action: 'submit_and_read',
    }, { TOKENLESS_HOME: homeDir, TOKENLESS_DAEMON_URL: '' })
    assert.equal(claim.ok, true, JSON.stringify(claim, null, 2))
    assert.equal(claim.result.job.job_id, payload.jobId)
    assert.equal(typeof claim.result.job.claim_token, 'string')
  } finally {
    await stopDaemon(daemon)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI run reports daemon process failure after daemon job creation', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-cli-failure-'))
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const daemon = startDaemon({ homeDir, port })
  let run

  try {
    await waitForDaemonReady(daemonUrl, daemon)
    run = spawn(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'run',
      '--prompt',
      'daemon should fail loudly',
      '--extension-id',
      'abcdefghijklmnopabcdefghijklmnop',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--no-open',
      '--timeout-ms',
      '10000',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const job = await waitForDaemonJob(daemonUrl, daemon)
    assert.equal(job.status, 'queued')
    await stopDaemon(daemon)

    const result = await waitForChild(run)
    assert.equal(result.code, 1, result.stdout || result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'daemon_unavailable')
    assert.equal(payload.status, 'failed')
    assert.deepEqual(payload.statusLog.map((event) => event.event), [
      'daemon_created',
      'daemon_status',
      'daemon_failed',
    ])
    assert.equal(payload.statusLog.at(-1).errorCode, 'daemon_unavailable')
    assert.equal(fs.existsSync(path.join(homeDir, 'jobs', `${payload.statusLog[0].jobId}.request.json`)), false)
  } finally {
    if (run && run.exitCode === null && run.signalCode === null) run.kill('SIGTERM')
    await stopDaemon(daemon)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

function startDaemon({ homeDir, port }) {
  const child = spawn('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    path.join(root, 'packages/daemon/Cargo.toml'),
    '--',
    '--home',
    homeDir,
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: { ...process.env, TOKENLESS_HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdoutText = ''
  child.stderrText = ''
  child.stdout.on('data', (chunk) => {
    child.stdoutText += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    child.stderrText += chunk.toString('utf8')
  })
  return child
}

async function waitForDaemonJob(daemonUrl, child) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited with ${child.exitCode}: ${child.stderrText}`)
    }
    try {
      const response = await fetch(`${daemonUrl}/jobs`)
      if (response.ok) {
        const jobs = await response.json()
        if (jobs[0]) return jobs[0]
      } else {
        lastError = new Error(`jobs returned ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`daemon job was not created: ${lastError?.message || 'timeout'}\n${child.stderrText}`)
}

async function readDaemonJob(daemonUrl, jobId) {
  const response = await fetch(`${daemonUrl}/jobs/${encodeURIComponent(jobId)}`)
  assert.equal(response.ok, true, `read daemon job returned ${response.status}`)
  return response.json()
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`child timed out: ${stderr}`))
    }, 15000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function stopDaemon(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  } else {
    child.kill('SIGTERM')
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function waitForDaemonReady(daemonUrl, child) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < 120000) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited with ${child.exitCode}: ${child.stderrText}`)
    }
    try {
      const response = await fetch(`${daemonUrl}/ready`)
      if (response.ok) return
      lastError = new Error(`ready returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`daemon did not become ready: ${lastError?.message || 'timeout'}\n${child.stderrText}`)
}

function nativeHostMessage(message, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, 'packages/cli/dist/src/native-host.mjs'),
    ], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = Buffer.alloc(0)
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`native host test timed out: ${stderr}`))
    }, 10000)

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code) => {
      if (code && stdout.length === 0) {
        clearTimeout(timeout)
        reject(new Error(`native host exited with ${code}: ${stderr}`))
      }
    })
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length < 4) return
      const length = stdout.readUInt32LE(0)
      if (stdout.length < length + 4) return
      const body = stdout.subarray(4, length + 4)
      clearTimeout(timeout)
      child.kill()
      resolve(JSON.parse(body.toString('utf8')))
    })

    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length, 0)
    child.stdin.write(Buffer.concat([header, body]))
  })
}

function startNativeHost(env = {}) {
  const child = spawn(process.execPath, [
    path.join(root, 'packages/cli/dist/src/native-host.mjs'),
  ], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdoutBuffer = Buffer.alloc(0)
  child.stderrText = ''
  child.writeCount = 0
  child.pendingMessages = []
  child.messageResolvers = []
  child.stdout.on('data', (chunk) => {
    child.stdoutBuffer = Buffer.concat([child.stdoutBuffer, chunk])
    drainNativeHostMessages(child)
  })
  child.stderr.on('data', (chunk) => {
    child.stderrText += chunk.toString('utf8')
  })
  return child
}

function writeNativeHostMessage(child, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  child.writeCount += 1
  child.stdin.write(Buffer.concat([header, body]))
}

function readNativeHostMessage(child, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const pendingIndex = child.pendingMessages.findIndex(predicate)
    if (pendingIndex >= 0) {
      const [message] = child.pendingMessages.splice(pendingIndex, 1)
      resolve(message)
      return
    }
    let resolver
    const timeout = setTimeout(() => {
      child.messageResolvers = child.messageResolvers.filter((candidate) => candidate !== resolver)
      reject(new Error(`native host message timed out: ${child.stderrText}`))
    }, 10000)
    resolver = {
      predicate,
      resolve: (message) => {
        clearTimeout(timeout)
        resolve(message)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
    child.messageResolvers.push(resolver)
    drainNativeHostMessages(child)
  })
}

function drainNativeHostMessages(child) {
  while (child.stdoutBuffer.length >= 4) {
    const length = child.stdoutBuffer.readUInt32LE(0)
    if (child.stdoutBuffer.length < length + 4) return
    const body = child.stdoutBuffer.subarray(4, length + 4)
    child.stdoutBuffer = child.stdoutBuffer.subarray(length + 4)
    const message = JSON.parse(body.toString('utf8'))
    const index = child.messageResolvers.findIndex((resolver) => resolver.predicate(message))
    if (index >= 0) {
      const [resolver] = child.messageResolvers.splice(index, 1)
      resolver.resolve(message)
    } else {
      child.pendingMessages.push(message)
    }
  }
}

async function stopNativeHost(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('failed to allocate a loopback port'))
          return
        }
        resolve(address.port)
      })
    })
    server.on('error', reject)
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
