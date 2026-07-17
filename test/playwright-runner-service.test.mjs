import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
  ManagedPlaywrightRunnerService,
  PLAYWRIGHT_EXECUTION_BACKEND,
  PersistentContextManager,
  VISIBLE_ACTIONS,
  createManagedPlaywrightJobRequest,
  tokenlessError,
} from '../packages/playwright/dist/src/index.js'

test('runner polls all registered profiles with exact Playwright/profile scoping and completes lifecycle', async () => {
  const profiles = fakeProfiles(['profile-a', 'profile-b'])
  const daemon = new FakeDaemon([
    fakeJob('job-b', profiles[1], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [
        { action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} },
        { action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })),
  ])
  const adapterCalls = []
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    adapterRegistry: fakeAdapterRegistry(async (_page, request, context) => {
      adapterCalls.push({ request, context })
      await delay(15)
      return successResponse(request, { visibleProof: 'ok', state: 'authenticated' })
    }),
    renewIntervalMs: 5,
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-b', status: 'succeeded' })
  assert.deepEqual(daemon.claims.map((claim) => claim.profileId), ['profile-a', 'profile-b'])
  assert.equal(daemon.running.length, 1)
  assert.equal(daemon.completed.length, 1)
  assert.equal(daemon.completed[0].result.protocol, MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION)
  assert.equal(daemon.completed[0].result.responses.length, 2)
  assert.ok(daemon.renewals.length >= 1)
  assert.equal(adapterCalls[0].context.profileId, 'profile-b')
  assert.equal(adapterCalls[0].context.operationId, 'job-b')
})

test('runner leaves additional profile jobs queued when four persistent contexts are already active', async () => {
  const profiles = fakeProfiles(['profile-0', 'profile-1', 'profile-2', 'profile-3', 'profile-4'])
  const manager = fakeContextManager()
  for (const profile of profiles.slice(0, 4)) {
    await manager.ensureContext(profile)
  }
  const daemon = new FakeDaemon([
    fakeJob('job-profile-4', profiles[4], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })),
  ])
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: manager,
    adapterRegistry: fakeAdapterRegistry(),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: false })
  assert.deepEqual(daemon.claims.map((claim) => claim.profileId), ['profile-0', 'profile-1', 'profile-2', 'profile-3'])
  assert.equal(daemon.jobs.get('job-profile-4').status, 'queued')
})

test('runner serializes same-profile visible actions through the shared context manager', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })
  const daemon = new FakeDaemon([
    fakeJob('job-1', profiles[0], request),
    fakeJob('job-2', profiles[0], request),
  ])
  const events = []
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    adapterRegistry: fakeAdapterRegistry(async (_page, visibleRequest, context) => {
      events.push(`${context.operationId}:start`)
      await delay(20)
      events.push(`${context.operationId}:end`)
      return successResponse(visibleRequest, { visibleProof: 'ok', state: 'authenticated' })
    }),
    cancelPollMs: 1000,
  })

  await Promise.all([service.runOnce(), service.runOnce()])

  assert.deepEqual(events, ['job-1:start', 'job-1:end', 'job-2:start', 'job-2:end'])
})

test('runner waits for a new visible response after submit before reading', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeResponsePage()
  const daemon = new FakeDaemon([
    fakeJob('job-1', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [
        { action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
        { action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })),
  ])
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    responseWaitTimeoutMs: 500,
    responseWaitPollMs: 5,
    adapterRegistry: fakeAdapterRegistry(async (_page, request) => {
      if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) {
        page.busy = true
        setTimeout(() => {
          page.answers.push('new answer')
          page.busy = false
        }, 25)
        return successResponse(request, { visible: true, submissionProof: 'submitted' })
      }
      if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) {
        return successResponse(request, {
          text: page.answers.at(-1),
          citations: [],
          visibleProof: 'latest',
        })
      }
      return successResponse(request, { visibleProof: 'ok', state: 'authenticated' })
    }),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-1', status: 'succeeded' })
  const read = daemon.completed[0].result.responses.at(-1)
  assert.equal(read.result.text, 'new answer')
  assert.notEqual(read.result.text, 'old answer')
})

test('runUntilStopped scheduler overlaps distinct profiles while keeping same-profile jobs single-flight', async () => {
  const profiles = fakeProfiles(['profile-a', 'profile-b'])
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })
  const daemon = new FakeDaemon([
    fakeJob('job-a-1', profiles[0], request),
    fakeJob('job-a-2', profiles[0], request),
    fakeJob('job-b-1', profiles[1], request),
  ])
  const events = []
  const activeByProfile = new Map()
  let crossProfileOverlap = false
  let sameProfileOverlap = false
  const controller = new AbortController()
  let service
  daemon.onComplete = () => {
    if (daemon.completed.length === 3) {
      service.stop()
      controller.abort()
    }
  }
  service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    pollIdleMs: 1,
    cancelPollMs: 1000,
    adapterRegistry: fakeAdapterRegistry(async (_page, visibleRequest, context) => {
      const active = activeByProfile.get(context.profileId) ?? 0
      sameProfileOverlap ||= active > 0
      activeByProfile.set(context.profileId, active + 1)
      crossProfileOverlap ||= [...activeByProfile.values()].filter((count) => count > 0).length > 1
      events.push(`${context.operationId}:start`)
      await delay(context.operationId === 'job-b-1' ? 60 : 20)
      events.push(`${context.operationId}:end`)
      activeByProfile.set(context.profileId, activeByProfile.get(context.profileId) - 1)
      return successResponse(visibleRequest, { visibleProof: 'ok', state: 'authenticated' })
    }),
  })

  await service.runUntilStopped(controller.signal)

  assert.equal(crossProfileOverlap, true)
  assert.equal(sameProfileOverlap, false)
  assert.ok(events.indexOf('job-a-2:start') > events.indexOf('job-a-1:end'))
  assert.ok(events.indexOf('job-b-1:end') > events.indexOf('job-a-2:start'))
  assert.deepEqual(daemon.completed.map((completion) => completion.jobId).sort(), ['job-a-1', 'job-a-2', 'job-b-1'])
})

test('runUntilStopped scheduler keeps fifth profile queued while four profiles are in flight', async () => {
  const profiles = fakeProfiles(['profile-0', 'profile-1', 'profile-2', 'profile-3', 'profile-4'])
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })
  const daemon = new FakeDaemon(profiles.map((profile, index) => fakeJob(`job-${index}`, profile, request)))
  const controller = new AbortController()
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    pollIdleMs: 1,
    cancelPollMs: 1000,
    adapterRegistry: fakeAdapterRegistry(async (_page, _visibleRequest, context) => {
      await waitForAbort(context.signal)
      throw tokenlessError('aborted', 'aborted')
    }),
  })

  const running = service.runUntilStopped(controller.signal)
  await waitUntil(() => daemon.running.length === 4)
  assert.equal(daemon.jobs.get('job-4').status, 'queued')
  assert.equal(daemon.claims.some((claim) => claim.profileId === 'profile-4'), false)
  service.stop()
  controller.abort()
  await running
})

test('runner observes cancelation, aborts actions, and cleans only the exact job attachment directory', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const root = await mkdtemp(join(tmpdir(), 'tokenless-runner-attachments-'))
  const jobRoot = join(root, 'job-1')
  await mkdir(jobRoot)
  await writeFile(join(jobRoot, 'sentinel.txt'), 'delete me')
  const daemon = new FakeDaemon([
    fakeJob('job-1', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })),
  ])
  daemon.cancelAfterRunning = true
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    adapterRegistry: fakeAdapterRegistry(async (_page, _request, context) => {
      await waitForAbort(context.signal)
      throw tokenlessError('aborted', 'aborted')
    }),
    attachmentRootForJob: (job) => join(root, job.job_id),
    cancelPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-1', status: 'canceled' })
  await assert.rejects(() => stat(jobRoot), /ENOENT/)
  assert.equal(daemon.completed.length, 0)
})

test('runner uses home-scoped default attachment bundle path and cleans exact job directory', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-home-'))
  const canonicalHome = await realpath(homeDir)
  const profiles = fakeProfiles(['profile-a'])
  const jobId = 'job-default-attachments'
  const jobRoot = join(canonicalHome, 'attachments', jobId)
  await mkdir(jobRoot, { recursive: true })
  await writeFile(join(jobRoot, 'sentinel.txt'), 'delete me')
  const daemon = new FakeDaemon([
    fakeJob(jobId, profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })),
  ])
  let adapterAttachmentRoot
  const service = new ManagedPlaywrightRunnerService({
    homeDir,
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    adapterRegistry: fakeAdapterRegistry(async (_page, request, context) => {
      adapterAttachmentRoot = context.attachmentRoot
      await stat(join(context.attachmentRoot, 'sentinel.txt'))
      return successResponse(request, { visibleProof: 'ok', state: 'authenticated' })
    }),
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId, status: 'succeeded' })
  assert.equal(adapterAttachmentRoot, jobRoot)
  await assert.rejects(() => stat(jobRoot), /ENOENT/)
})

test('runner refuses unsafe daemon job ids for default attachment paths', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tokenless-runner-home-'))
  const profiles = fakeProfiles(['profile-a'])
  const daemon = new FakeDaemon([
    fakeJob('../bad', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })),
  ])
  const service = new ManagedPlaywrightRunnerService({
    homeDir,
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    adapterRegistry: fakeAdapterRegistry(),
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: '../bad', status: 'failed' })
  assert.equal(daemon.completed[0].error.code, 'invalid_playwright_job_id')
})

test('runner treats renewal failure as a failed job and refuses unsafe attachment cleanup roots', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const daemon = new FakeDaemon([
    fakeJob('job-1', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })),
  ])
  daemon.failRenewal = true
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    adapterRegistry: fakeAdapterRegistry(async (_page, _request, context) => {
      await waitForAbort(context.signal)
      throw tokenlessError('aborted', 'aborted')
    }),
    renewIntervalMs: 5,
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-1', status: 'failed' })
  assert.equal(daemon.completed[0].error.code, 'lease_lost')

  const unsafe = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: new FakeDaemon([fakeJob('job-2', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    }))]),
    contextManager: fakeContextManager(),
    adapterRegistry: fakeAdapterRegistry(),
    attachmentRootForJob: () => join(tmpdir(), 'attachments'),
  })
  const unsafeResult = await unsafe.runOnce()
  assert.deepEqual(unsafeResult, { claimed: true, jobId: 'job-2', status: 'failed' })
})

class FakeDaemon {
  constructor(jobs) {
    this.jobs = new Map(jobs.map((job) => [job.job_id, job]))
    this.claims = []
    this.running = []
    this.renewals = []
    this.completed = []
    this.cancelAfterRunning = false
    this.failRenewal = false
    this.onComplete = undefined
  }

  async createJob() { throw new Error('unused') }
  async listJobs() { throw new Error('unused') }

  async getJob({ jobId }) {
    const job = this.jobs.get(jobId)
    if (this.cancelAfterRunning && job?.status === 'running') job.status = 'canceled'
    return job
  }

  async claimNextJob({ executionBackend, profileId, action }) {
    this.claims.push({ executionBackend, profileId, action })
    const job = [...this.jobs.values()].find((candidate) => (
      candidate.status === 'queued' &&
      candidate.execution_backend === executionBackend &&
      candidate.profile_id === profileId &&
      candidate.action === action
    ))
    if (!job) return { job: null }
    job.status = 'claimed'
    return { job }
  }

  async markJobRunning({ jobId }) {
    const job = this.jobs.get(jobId)
    job.status = 'running'
    this.running.push(jobId)
    return job
  }

  async renewJobClaim({ jobId }) {
    this.renewals.push(jobId)
    if (this.failRenewal) throw tokenlessError('lease_lost', 'claim lease was lost', { retryable: true })
    return this.jobs.get(jobId)
  }

  async completeJob({ jobId, result, error }) {
    const job = this.jobs.get(jobId)
    job.status = error ? 'failed' : 'succeeded'
    this.completed.push({ jobId, result, error })
    this.onComplete?.()
    return job
  }

  async cancelJob() { throw new Error('unused') }
}

class FakeContext extends EventEmitter {
  #pages = []
  #page
  constructor(page) {
    super()
    this.#page = page
  }
  pages() {
    return this.#pages
  }
  async newPage() {
    const page = this.#page ?? { async goto() {} }
    this.#pages.push(page)
    return page
  }
  async close() {
    this.emit('close')
  }
}

function fakeContextManager(page) {
  return new PersistentContextManager({
    launcher: async () => new FakeContext(page),
  })
}

class FakeResponsePage {
  constructor() {
    this.answers = ['old answer']
    this.busy = false
  }

  async goto() {}

  locator(selector) {
    if (selector === '[data-message-author-role="assistant"]') {
      return new FakeLocator(() => this.answers.map(() => true))
    }
    if (selector === 'button[data-testid="stop-button"]') {
      return new FakeLocator(() => this.busy ? [true] : [])
    }
    return new FakeLocator(() => [])
  }
}

class FakeLocator {
  constructor(values) {
    this.values = values
  }

  async count() {
    return this.values().length
  }

  nth(index) {
    return {
      isVisible: async () => Boolean(this.values()[index]),
    }
  }
}

function fakeAdapterRegistry(execute = async (_page, request) => successResponse(request, { visibleProof: 'ok', state: 'authenticated' })) {
  return {
    list() { return [] },
    get() { return null },
    execute,
  }
}

function fakeProfiles(ids) {
  return ids.map((id) => ({ id, directory: join(tmpdir(), id) }))
}

function fakeJob(jobId, profile, request) {
  return {
    job_id: jobId,
    claim_token: `${jobId}-claim`,
    execution_backend: PLAYWRIGHT_EXECUTION_BACKEND,
    profile_id: profile.id,
    provider: request.provider,
    action: MANAGED_PLAYWRIGHT_JOB_ACTION,
    status: 'queued',
    request_json: request,
    result_json: null,
    error_json: null,
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T00:00:00Z',
  }
}

function successResponse(request, result) {
  return {
    protocol: request.protocol,
    requestId: request.requestId,
    provider: request.provider,
    action: request.action,
    ok: true,
    result,
    error: null,
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForAbort(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', resolve, { once: true })
  })
}

async function waitUntil(predicate, timeoutMs = 500) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await delay(5)
  }
  throw new Error('Timed out waiting for test condition.')
}
