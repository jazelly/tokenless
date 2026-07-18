import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDaemonClient = path.join(root, 'packages/cli/dist/src/daemon-client.js')

test('CLI daemon wait returns waiting_for_user promptly with blocker and does not cancel', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-cli-waiting-'))
  const canonicalHome = await fs.realpath(homeDir)
  await fs.writeFile(path.join(homeDir, 'daemon.token'), 'control-token\n', { mode: 0o600 })
  const requests = []
  const job = daemonJob({
    status: 'waiting_for_user',
    blocker_json: {
      blocker: { code: 'visible_recaptcha', kind: 'challenge', userResolvable: true },
    },
  })

  await withReadyDaemon({ homeDir: canonicalHome, token: 'control-token', job, requests }, async (daemonUrl) => {
    const { waitDaemonJobResult } = await import(pathToFileURL(cliDaemonClient).href)
    const result = await waitDaemonJobResult({
      homeDir,
      daemonUrl,
      jobId: job.job_id,
      timeoutMs: 10_000,
      pollMs: 5,
    })

    assert.equal(result.ok, null)
    assert.equal(result.status, 'waiting_for_user')
    assert.equal(result.blocker.blocker.code, 'visible_recaptcha')
    assert.match(result.userAction.message, /Visible Chrome is open/)
    assert.equal(requests.some((request) => request.method === 'POST' && request.url.includes('/cancel')), false)
  })
})

function daemonJob(overrides = {}) {
  return {
    job_id: 'job-waiting',
    execution_backend: 'playwright',
    profile_id: 'profile-a',
    provider: 'chatgpt',
    action: 'visible_provider_actions',
    status: 'queued',
    request_json: { taskId: 'task-waiting' },
    result_json: null,
    error_json: null,
    blocker_json: null,
    created_at: '2026-07-18T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:00.000Z',
    ...overrides,
  }
}

async function withReadyDaemon({ homeDir, token, job, requests }, callback) {
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url })
    if (request.url?.startsWith('/ready?')) {
      const challenge = new URL(request.url, 'http://127.0.0.1').searchParams.get('challenge')
      const body = {
        protocol: 'tokenless.daemon.v1',
        daemon_protocol: 'tokenless.daemon.v1',
        version: '0.1.2',
        native_protocol: 'tokenless.native.v1',
        status: 'ok',
        ready: true,
        home_dir: homeDir,
        ready_proof_protocol: 'tokenless.daemon-ready-proof.v1',
        ready_challenge: challenge,
      }
      body.ready_proof = createHmac('sha256', token)
        .update(daemonReadyProofMessage([
          body.ready_proof_protocol,
          challenge,
          body.daemon_protocol,
          body.native_protocol,
          body.home_dir,
        ]))
        .digest('base64url')
      return respondJson(response, 200, body)
    }
    if (request.url === `/jobs/${encodeURIComponent(job.job_id)}` && request.method === 'GET') {
      return respondJson(response, 200, job)
    }
    respondJson(response, 404, { error: { message: 'not found' } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function daemonReadyProofMessage(fields) {
  return Buffer.concat(fields.flatMap((field) => {
    const value = Buffer.from(String(field), 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    return [length, value]
  }))
}

function respondJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
