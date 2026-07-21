import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
  PLAYWRIGHT_EXECUTION_BACKEND,
  TokenlessPlaywrightError,
  VISIBLE_ACTIONS,
  createManagedPlaywrightJobRequest,
  submitManagedPlaywrightJob,
  listManagedPlaywrightJobs,
  cancelManagedPlaywrightJob,
  getManagedPlaywrightJob,
  validateManagedPlaywrightJobRequest,
} from '../packages/cli/dist/src/playwright/index.js'

test('managed Playwright job API submits versioned provider-scoped jobs through loopback daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenless-runner-api-'))
  await writeFile(join(home, 'daemon.token'), 'control-token\n', { mode: 0o600 })
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null })
    return jsonResponse({
      job_id: 'job-1',
      claim_token: 'claim-1',
      execution_backend: 'playwright',
      profile_id: 'profile-a',
      provider: 'chatgpt',
      action: MANAGED_PLAYWRIGHT_JOB_ACTION,
      status: 'queued',
      request_json: calls.at(-1).body.request_json,
      result_json: null,
      error_json: null,
      created_at: '2026-07-17T00:00:00Z',
      updated_at: '2026-07-17T00:00:00Z',
    })
  }

  const job = await submitManagedPlaywrightJob({
    homeDir: home,
    daemonUrl: 'http://127.0.0.1:7331',
    daemonClient: undefined,
    request: {
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    },
    profileId: 'profile-a',
    // The low-level client is exercised through fetch injection.
    fetchImpl,
  })

  assert.equal(job.execution_backend, PLAYWRIGHT_EXECUTION_BACKEND)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:7331/jobs')
  assert.equal(calls[0].init.headers.authorization, 'Bearer control-token')
  assert.equal(calls[0].body.execution_backend, PLAYWRIGHT_EXECUTION_BACKEND)
  assert.equal(calls[0].body.profile_id, 'profile-a')
  assert.equal(calls[0].body.action, MANAGED_PLAYWRIGHT_JOB_ACTION)
  assert.equal(calls[0].body.request_json.protocol, MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION)
  assert.equal(calls[0].body.request_json.provider, 'chatgpt')
  assert.equal(calls[0].body.request_json.target.url, 'https://chatgpt.com/')
  assert.equal(calls[0].body.request_json.taskId, null)
  assert.equal(calls[0].body.request_json.actions[0].provider, 'chatgpt')
})

test('managed Playwright job contract carries bounded top-level taskId metadata', () => {
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    taskId: 'task-123',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })

  assert.equal(request.taskId, 'task-123')
  assert.throws(() => createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    taskId: 'bad\ntask',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  }), matchCode('invalid_playwright_job_task_id'))
  assert.throws(() => createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    taskId: 'x'.repeat(257),
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  }), matchCode('invalid_playwright_job_task_id'))
  assert.throws(() => validateManagedPlaywrightJobRequest({
    protocol: MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
    provider: 'chatgpt',
    target: { kind: 'provider_home', url: 'https://chatgpt.com/' },
    actions: request.actions,
  }), matchCode('invalid_playwright_job_request'))
})

test('managed Playwright job API lists and cancels without entrypoint coupling', async () => {
  const paths = []
  const daemonClient = {
    async createJob() { throw new Error('unused') },
    async getJob(options) {
      paths.push(['get', options])
      return daemonJob({
        jobId: options.jobId,
        request_json: createManagedPlaywrightJobRequest({
          provider: 'chatgpt',
          actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
        }),
      })
    },
    async claimNextJob() { throw new Error('unused') },
    async markJobRunning() { throw new Error('unused') },
    async renewJobClaim() { throw new Error('unused') },
    async completeJob() { throw new Error('unused') },
    async listJobs(options) {
      paths.push(['list', options])
      return []
    },
    async cancelJob(options) {
      paths.push(['cancel', options])
      return { job_id: options.jobId, status: 'canceled' }
    },
  }

  await listManagedPlaywrightJobs({ daemonClient, profileId: 'profile-a', provider: 'claude', status: 'queued', limit: 10 })
  await cancelManagedPlaywrightJob({ daemonClient, jobId: 'job-1', profileId: 'profile-a', reason: { code: 'test_cancel' } })

  assert.deepEqual(paths[0], ['list', {
    daemonUrl: undefined,
    homeDir: undefined,
    token: undefined,
    fetchImpl: undefined,
    requestTimeoutMs: undefined,
    signal: undefined,
    executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
    profileId: 'profile-a',
    provider: 'claude',
    status: 'queued',
    taskId: undefined,
    limit: 10,
  }])
  assert.deepEqual(paths[1], ['get', {
    daemonUrl: undefined,
    homeDir: undefined,
    token: undefined,
    fetchImpl: undefined,
    requestTimeoutMs: undefined,
    signal: undefined,
    jobId: 'job-1',
  }])
  assert.deepEqual(paths[2], ['cancel', {
    daemonUrl: undefined,
    homeDir: undefined,
    token: undefined,
    fetchImpl: undefined,
    requestTimeoutMs: undefined,
    signal: undefined,
    jobId: 'job-1',
    reason: { code: 'test_cancel' },
  }])
})

test('managed Playwright get/cancel reject legacy and different-profile jobs before returning or canceling', async () => {
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })
  let canceled = false
  const daemonClient = {
    async createJob() { throw new Error('unused') },
    async listJobs() { throw new Error('unused') },
    async claimNextJob() { throw new Error('unused') },
    async markJobRunning() { throw new Error('unused') },
    async renewJobClaim() { throw new Error('unused') },
    async completeJob() { throw new Error('unused') },
    async getJob({ jobId }) {
      if (jobId === 'legacy') {
        return daemonJob({ jobId, execution_backend: 'legacy_extension', profile_id: null, request_json: {} })
      }
      return daemonJob({ jobId, profile_id: 'other-profile', request_json: request })
    },
    async cancelJob() {
      canceled = true
      throw new Error('cancel must not be called')
    },
  }

  await assert.rejects(() => getManagedPlaywrightJob({
    daemonClient,
    jobId: 'legacy',
    profileId: 'profile-a',
  }), matchCode('invalid_playwright_job_backend'))
  await assert.rejects(() => cancelManagedPlaywrightJob({
    daemonClient,
    jobId: 'other',
    profileId: 'profile-a',
  }), matchCode('invalid_playwright_job_profile'))
  assert.equal(canceled, false)
})

test('managed Playwright job contract rejects provider subdomains and non-loopback daemon URLs', async () => {
  assert.throws(() => createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    target: { url: 'https://evil.chatgpt.com/' },
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  }), matchCode('invalid_playwright_job_target'))

  await assert.rejects(() => submitManagedPlaywrightJob({
    daemonUrl: 'https://example.com',
    token: 'token',
    profileId: 'profile-a',
    request: {
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    },
  }), matchCode('invalid_daemon_url'))
})

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function matchCode(code) {
  return (error) => error instanceof TokenlessPlaywrightError && error.code === code
}

function daemonJob(overrides) {
  const job = {
    job_id: overrides.jobId,
    execution_backend: 'playwright',
    profile_id: 'profile-a',
    provider: 'chatgpt',
    action: MANAGED_PLAYWRIGHT_JOB_ACTION,
    status: 'queued',
    request_json: overrides.request_json,
    result_json: null,
    error_json: null,
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T00:00:00Z',
    ...overrides,
  }
  delete job.jobId
  return job
}
