import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
