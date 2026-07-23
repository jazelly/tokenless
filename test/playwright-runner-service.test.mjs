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
} from '../packages/cli/dist/src/playwright/index.js'
import { createDomProviderAdapter } from '../packages/cli/dist/src/playwright/adapters/provider-dom-adapter.js'
import { getProviderById } from '../packages/cli/dist/src/playwright/providers.js'

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

test('runner skips profiles while their managed data is being reset', async () => {
  const profiles = fakeProfiles(['profile-resetting', 'profile-ready'])
  profiles[0].lifecycle = 'importing'
  profiles[1].lifecycle = 'ready'
  const daemon = new FakeDaemon([
    fakeJob('job-ready', profiles[1], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })),
  ])
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(),
    adapterRegistry: fakeAdapterRegistry(),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-ready', status: 'succeeded' })
  assert.deepEqual(daemon.claims.map((claim) => claim.profileId), ['profile-ready'])
})

test('runner brings the provider target page to the foreground for navigation checks only', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeForegroundPage()
  const daemon = new FakeDaemon([
    fakeJob('job-foreground', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.NAVIGATION_CHECK, payload: {} }],
    })),
    fakeJob('job-background-auth', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })),
  ])
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    adapterRegistry: fakeAdapterRegistry(),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-foreground', status: 'succeeded' })
  assert.deepEqual(page.events, [
    ['goto', 'https://chatgpt.com/', { waitUntil: 'domcontentloaded' }],
    ['bringToFront'],
  ])

  page.events = []
  const authResult = await service.runOnce()
  assert.deepEqual(authResult, { claimed: true, jobId: 'job-background-auth', status: 'succeeded' })
  assert.deepEqual(page.events, [
    ['goto', 'https://chatgpt.com/', { waitUntil: 'domcontentloaded' }],
  ])
})

test('runner starts auto jobs headless and headed jobs headed through the context manager', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const autoLaunches = []
  const headedLaunches = []
  const autoRequest = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    browserVisibility: 'auto',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })
  const headedRequest = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    browserVisibility: 'headed',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })

  const autoResult = await new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: new FakeDaemon([fakeJob('job-auto', profiles[0], autoRequest)]),
    contextManager: fakeContextManager(new FakeResponsePage(), autoLaunches),
    adapterRegistry: fakeAdapterRegistry(),
  }).runOnce()
  const headedResult = await new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: new FakeDaemon([fakeJob('job-headed', profiles[0], headedRequest)]),
    contextManager: fakeContextManager(new FakeResponsePage(), headedLaunches),
    adapterRegistry: fakeAdapterRegistry(),
  }).runOnce()

  assert.deepEqual(autoResult, { claimed: true, jobId: 'job-auto', status: 'succeeded' })
  assert.deepEqual(headedResult, { claimed: true, jobId: 'job-headed', status: 'succeeded' })
  assert.equal(autoLaunches[0].headless, true)
  assert.equal(headedLaunches[0].headless, false)
})

test('runner fails terminal blockers without escalating auto jobs to headed', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const launches = []
  const page = new FakeHandoverPage()
  page.rawBlockers = [{
    kind: 'terminal',
    code: 'provider_rate_limited',
    family: 'rate_limit',
    message: 'Provider rate limit is terminal for this run.',
    userResolvable: false,
    retryable: true,
    visibleProof: 'visible-rate-limit',
    provider: 'chatgpt',
    url: 'https://chatgpt.com/',
  }]
  const daemon = new FakeDaemon([
    fakeJob('job-terminal', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      browserVisibility: 'auto',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'must not type' } }],
    })),
  ])
  let actionCalls = 0
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page, launches),
    adapterRegistry: fakeAdapterRegistry(async (_page, request) => {
      actionCalls += 1
      return successResponse(request, { visible: true, inputProof: 'prompt-text-visible' })
    }),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-terminal', status: 'failed' })
  assert.equal(actionCalls, 0)
  assert.equal(daemon.waiting.length, 0)
  assert.equal(daemon.completed[0].error.code, 'provider_rate_limited')
  assert.deepEqual(launches.map((launch) => launch.headless), [true])
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

test('runner parks on visible user-resolvable blocker and resumes unfinished action in same page', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const daemon = new FakeDaemon([
    fakeJob('job-handover', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [
        { action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'after handover' } },
        { action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
      ],
    })),
  ])
  const adapterEvents = []
  daemon.onWaiting = () => {
    assert.equal(adapterEvents.length, 0, 'runner must not execute page actions while waiting for user')
    setTimeout(() => {
      page.rawBlockers = []
      page.composerVisible = true
    }, 25)
  }
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    adapterRegistry: fakeAdapterRegistry(async (actionPage, request) => {
      adapterEvents.push({ page: actionPage, action: request.action })
      return successResponse(request, request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT
        ? { visible: true, submissionProof: 'submitted' }
        : { visible: true, inputProof: 'prompt-text-visible' })
    }),
    renewIntervalMs: 5,
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-handover', status: 'succeeded' })
  assert.equal(daemon.waiting.length, 1)
  assert.equal(daemon.waiting[0].blocker.blocker.code, 'visible_recaptcha')
  assert.deepEqual(daemon.running, ['job-handover', 'job-handover'])
  assert.equal(daemon.renewals.length > 0, true)
  assert.deepEqual(adapterEvents.map((event) => event.action), [VISIBLE_ACTIONS.PROMPT_INPUT, VISIBLE_ACTIONS.PROMPT_SUBMIT])
  assert.equal(adapterEvents.every((event) => event.page === page), true)
})

test('auto visibility checkpoints before pre-submit blocker escalation and continues headed', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const launches = []
  const daemon = new FakeDaemon([
    fakeJob('job-auto-handover', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      browserVisibility: 'auto',
      actions: [
        { action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'after handover' } },
        { action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
      ],
    })),
  ])
  const adapterEvents = []
  daemon.onWaiting = () => {
    assert.equal(daemon.checkpoints[0].checkpoint.phase.state, 'idle')
    setTimeout(() => {
      page.rawBlockers = []
      page.composerVisible = true
    }, 25)
  }
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page, launches),
    adapterRegistry: fakeAdapterRegistry(async (_page, request) => {
      adapterEvents.push(request.action)
      return successResponse(request, request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT
        ? { visible: true, submissionProof: 'submitted' }
        : { visible: true, inputProof: 'prompt-text-visible' })
    }),
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-auto-handover', status: 'succeeded' })
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false])
  assert.deepEqual(adapterEvents, [VISIBLE_ACTIONS.PROMPT_INPUT, VISIBLE_ACTIONS.PROMPT_SUBMIT])
  assert.equal(daemon.waiting[0].blocker.browser.requestedVisibility, 'auto')
  assert.equal(daemon.waiting[0].blocker.browser.effectiveVisibility, 'headed')
  assert.equal(daemon.waiting[0].blocker.browser.windowOpen, true)
})

test('auto visibility reconstructs completed pre-submit actions after fresh headed relaunch', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const headlessPage = new FakeHandoverPage()
  headlessPage.rawBlockers = []
  headlessPage.composerVisible = true
  const headedPage = new FakeHandoverPage()
  const launches = []
  const daemon = new FakeDaemon([
    fakeJob('job-auto-reconstruct-live', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      browserVisibility: 'auto',
      actions: [
        { requestId: 'live-reconstruct:input', action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'must survive relaunch' } },
        { requestId: 'live-reconstruct:submit', action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
      ],
    })),
  ])
  const adapterEvents = []
  daemon.onWaiting = () => {
    setTimeout(() => {
      headedPage.rawBlockers = []
      headedPage.composerVisible = true
    }, 25)
  }
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManagerSequence([headlessPage, headedPage], launches),
    adapterRegistry: fakeAdapterRegistry(async (page, request) => {
      adapterEvents.push({ page, action: request.action })
      if (page === headlessPage && request.action === VISIBLE_ACTIONS.PROMPT_INPUT) {
        headlessPage.rawBlockers = headedPage.rawBlockers
        headlessPage.composerVisible = false
      }
      return successResponse(request, request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT
        ? { visible: true, submissionProof: 'submitted' }
        : { visible: true, inputProof: 'prompt-text-visible' })
    }),
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-auto-reconstruct-live', status: 'succeeded' })
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false])
  assert.deepEqual(adapterEvents.map((event) => event.action), [
    VISIBLE_ACTIONS.PROMPT_INPUT,
    VISIBLE_ACTIONS.PROMPT_INPUT,
    VISIBLE_ACTIONS.PROMPT_SUBMIT,
  ])
  assert.equal(adapterEvents[0].page, headlessPage)
  assert.equal(adapterEvents[1].page, headedPage)
  assert.equal(adapterEvents[2].page, headedPage)
  assert.equal(daemon.waiting[0].blocker.browser.windowOpen, true)
})

test('auto-escalated headed context closes 30 seconds after successful completion', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const timers = new FakeTimers()
  const launches = []
  const contexts = []
  const daemon = new FakeDaemon([
    fakeJob('job-auto-close', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      browserVisibility: 'auto',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'after handover' } }],
    })),
  ])
  daemon.onWaiting = () => {
    page.rawBlockers = []
    page.composerVisible = true
  }
  const contextManager = fakeContextManager(page, launches, { timers, contexts })
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager,
    adapterRegistry: fakeAdapterRegistry(async (_page, request) => (
      successResponse(request, { visible: true, inputProof: 'prompt-text-visible' })
    )),
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-auto-close', status: 'succeeded' })
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false])
  assert.deepEqual(contextManager.activeProfileIds(), ['profile-a'])
  assert.equal(contexts[1].closed, false)
  await timers.advance(29_999)
  assert.deepEqual(contextManager.activeProfileIds(), ['profile-a'])
  assert.equal(contexts[1].closed, false)
  await timers.advance(1)
  assert.deepEqual(contextManager.activeProfileIds(), [])
  assert.equal(contexts[1].closed, true)
})

test('auto-escalated headed context closes 30 seconds after failed terminal completion', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const timers = new FakeTimers()
  const launches = []
  const contexts = []
  const daemon = new FakeDaemon([
    fakeJob('job-auto-close-failed', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      browserVisibility: 'auto',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'will fail' } }],
    })),
  ])
  daemon.onWaiting = () => {
    page.rawBlockers = []
    page.composerVisible = true
  }
  const contextManager = fakeContextManager(page, launches, { timers, contexts })
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager,
    adapterRegistry: fakeAdapterRegistry(async (_page, request) => ({
      protocol: request.protocol,
      requestId: request.requestId,
      provider: request.provider,
      action: request.action,
      ok: false,
      result: null,
      error: { code: 'provider_terminal_after_handover', message: 'terminal', retryable: false },
    })),
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-auto-close-failed', status: 'failed' })
  assert.equal(daemon.completed[0].error.code, 'provider_terminal_after_handover')
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false])
  await timers.advance(30_000)
  assert.deepEqual(contextManager.activeProfileIds(), [])
  assert.equal(contexts[1].closed, true)
})

test('auto-escalated headed context closes 30 seconds after daemon cancellation while waiting', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const timers = new FakeTimers()
  const launches = []
  const contexts = []
  const daemon = new FakeDaemon([
    fakeJob('job-auto-close-canceled', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      browserVisibility: 'auto',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'must not run' } }],
    })),
  ])
  daemon.cancelAfterWaiting = true
  let actionCalls = 0
  const contextManager = fakeContextManager(page, launches, { timers, contexts })
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager,
    adapterRegistry: fakeAdapterRegistry(async (_page, request) => {
      actionCalls += 1
      return successResponse(request, { visible: true, inputProof: 'prompt-text-visible' })
    }),
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
    cancelPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-auto-close-canceled', status: 'canceled' })
  assert.equal(actionCalls, 0)
  assert.equal(daemon.completed.length, 0)
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false])
  await timers.advance(29_999)
  assert.deepEqual(contextManager.activeProfileIds(), ['profile-a'])
  assert.equal(contexts[1].closed, false)
  await timers.advance(1)
  assert.deepEqual(contextManager.activeProfileIds(), [])
  assert.equal(contexts[1].closed, true)
})

test('runner preserves auth status as an immediate check without user handover gating', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const daemon = new FakeDaemon([
    fakeJob('job-auth-handover', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })),
  ])
  const adapterEvents = []
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    adapterRegistry: fakeAdapterRegistry(async (_actionPage, request) => {
      adapterEvents.push(request.action)
      return successResponse(request, { state: 'authenticated', visibleProof: 'authenticated-control-visible' })
    }),
    renewIntervalMs: 5,
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-auth-handover', status: 'succeeded' })
  assert.equal(daemon.waiting.length, 0)
  assert.deepEqual(daemon.running, ['job-auth-handover'])
  assert.deepEqual(adapterEvents, [VISIBLE_ACTIONS.AUTH_STATUS])
})

test('dom adapter classifies auth status on recognized off-provider sign-in without DOM inspection', async () => {
  const provider = getProviderById('chatgpt')
  const adapter = createDomProviderAdapter(provider)
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  }).actions[0]
  const page = new FakeOffProviderSignInPage()

  const response = await adapter.execute(page, request, { profileId: 'profile-a', operationId: 'job-auth' })

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'provider_sign_in_navigation')
  assert.equal(response.error.retryable, true)
  assert.equal(page.offProviderEvaluateCalls, 0)
})

test('dom adapter fails closed for unsafe off-provider auth status navigation', async () => {
  const provider = getProviderById('chatgpt')
  const adapter = createDomProviderAdapter(provider)
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  }).actions[0]
  for (const url of ['https://example.com/login', 'https://evil.test/signin']) {
    const page = new FakeUnsafeOffProviderPage(url)

    const response = await adapter.execute(page, request, { profileId: 'profile-a', operationId: 'job-auth' })

    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'unsupported_provider_navigation')
    assert.equal(response.error.retryable, false)
    assert.equal(page.evaluateCalls, 0)
  }
})

test('runner gates setup readiness navigation checks and resumes auth in the same job', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const daemon = new FakeDaemon([
    fakeJob('job-setup-readiness', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [
        { action: VISIBLE_ACTIONS.NAVIGATION_CHECK, payload: {} },
        { action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} },
      ],
    })),
  ])
  const adapterEvents = []
  daemon.onWaiting = () => {
    assert.equal(adapterEvents.length, 0, 'runner must not inspect readiness while waiting for user')
    setTimeout(() => {
      page.rawBlockers = []
      page.composerVisible = true
    }, 25)
  }
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    adapterRegistry: fakeAdapterRegistry(async (_actionPage, request) => {
      adapterEvents.push(request.action)
      return successResponse(request, request.action === VISIBLE_ACTIONS.AUTH_STATUS
        ? { state: 'authenticated', visibleProof: 'authenticated-control-visible' }
        : { allowed: true, provider: 'chatgpt', reason: null })
    }),
    renewIntervalMs: 5,
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-setup-readiness', status: 'succeeded' })
  assert.equal(daemon.waiting.length, 1)
  assert.equal(daemon.waiting[0].blocker.blocker.code, 'visible_recaptcha')
  assert.deepEqual(daemon.running, ['job-setup-readiness', 'job-setup-readiness'])
  assert.deepEqual(adapterEvents, [VISIBLE_ACTIONS.NAVIGATION_CHECK, VISIBLE_ACTIONS.AUTH_STATUS])
})

test('runner waits through response-read challenge longer than response timeout without replaying submit', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  page.rawBlockers = []
  page.composerVisible = true
  const daemon = new FakeDaemon([
    fakeJob('job-response-handover', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [
        { action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
        { action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })),
  ])
  const adapterEvents = []
  daemon.onWaiting = () => {
    setTimeout(() => {
      page.rawBlockers = []
      page.composerVisible = true
      page.answers.push('resumed answer')
    }, 80)
  }
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    responseWaitTimeoutMs: 30,
    responseWaitPollMs: 5,
    userHandoverTimeoutMs: 300,
    userHandoverPollMs: 5,
    renewIntervalMs: 5,
    cancelPollMs: 1000,
    adapterRegistry: fakeAdapterRegistry(async (_actionPage, request) => {
      adapterEvents.push(request.action)
      if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) {
        page.rawBlockers = [{
          kind: 'challenge',
          code: 'visible_recaptcha',
          family: 'recaptcha',
          message: 'Visible reCAPTCHA verification is blocking the provider page.',
          proof: 'visible-recaptcha-frame',
        }]
        page.composerVisible = false
        return successResponse(request, { visible: true, submissionProof: 'submitted' })
      }
      if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) {
        return successResponse(request, { text: page.answers.at(-1), citations: [], visibleProof: 'latest' })
      }
      return successResponse(request, { visibleProof: 'ok', state: 'authenticated' })
    }),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-response-handover', status: 'succeeded' })
  assert.deepEqual(adapterEvents, [VISIBLE_ACTIONS.PROMPT_SUBMIT, VISIBLE_ACTIONS.RESPONSE_READ])
  assert.equal(daemon.waiting.length, 1)
  assert.equal(daemon.completed[0].result.responses.at(-1).result.text, 'resumed answer')
  assert.equal(daemon.renewals.length > 0, true)
})

test('auto post-submit blocker escalates without submitting a second time', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  page.rawBlockers = []
  page.composerVisible = true
  const launches = []
  const daemon = new FakeDaemon([
    fakeJob('job-post-submit-handover', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      browserVisibility: 'auto',
      actions: [
        { action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
        { action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })),
  ])
  const adapterEvents = []
  daemon.onWaiting = () => {
    setTimeout(() => {
      page.rawBlockers = []
      page.composerVisible = true
      page.answers.push('post-submit answer')
    }, 25)
  }
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page, launches),
    responseWaitTimeoutMs: 30,
    responseWaitPollMs: 5,
    userHandoverTimeoutMs: 300,
    userHandoverPollMs: 5,
    adapterRegistry: fakeAdapterRegistry(async (_page, request) => {
      adapterEvents.push(request.action)
      if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) {
        page.rawBlockers = [{
          kind: 'challenge',
          code: 'visible_recaptcha',
          family: 'recaptcha',
          message: 'Visible reCAPTCHA verification is blocking the provider page.',
          proof: 'visible-recaptcha-frame',
        }]
        page.composerVisible = false
        return successResponse(request, { visible: true, submissionProof: 'submitted' })
      }
      if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) {
        return successResponse(request, { text: page.answers.at(-1), citations: [], visibleProof: 'latest' })
      }
      return successResponse(request, { visibleProof: 'ok', state: 'authenticated' })
    }),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-post-submit-handover', status: 'succeeded' })
  assert.deepEqual(adapterEvents, [VISIBLE_ACTIONS.PROMPT_SUBMIT, VISIBLE_ACTIONS.RESPONSE_READ])
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false])
  assert.equal(daemon.checkpoints.some((entry) => entry.checkpoint.submitted?.requestId === daemon.jobs.get('job-post-submit-handover').request_json.actions[0].requestId), true)
  assert.equal(daemon.completed[0].result.responses.filter((response) => response.action === VISIBLE_ACTIONS.PROMPT_SUBMIT).length, 1)
})

test('runner classifies off-provider sign-in navigation without DOM inspection and stores origin-only blocker URL', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeOffProviderSignInPage()
  const daemon = new FakeDaemon([
    fakeJob('job-off-provider', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'after login' } }],
    })),
  ])
  const adapterEvents = []
  daemon.onWaiting = () => {
    setTimeout(() => {
      page.currentUrl = 'https://chatgpt.com/'
      page.composerVisible = true
    }, 25)
  }
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    userHandoverTimeoutMs: 300,
    userHandoverPollMs: 5,
    cancelPollMs: 1000,
    adapterRegistry: fakeAdapterRegistry(async (_actionPage, request) => {
      adapterEvents.push(request.action)
      return successResponse(request, { visible: true, inputProof: 'prompt-text-visible' })
    }),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-off-provider', status: 'succeeded' })
  assert.equal(page.offProviderEvaluateCalls, 0)
  assert.equal(daemon.waiting[0].blocker.blocker.code, 'provider_sign_in_navigation')
  assert.equal(daemon.waiting[0].blocker.blocker.url, 'https://accounts.google.com')
  assert.deepEqual(adapterEvents, [VISIBLE_ACTIONS.PROMPT_INPUT])
})

test('runner fails closed for unsafe off-provider sign-in-shaped navigation without waiting or DOM inspection', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeUnsafeOffProviderPage('https://evil.test/signin')
  const daemon = new FakeDaemon([
    fakeJob('job-unsafe-off-provider', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'after login' } }],
    })),
  ])
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-unsafe-off-provider', status: 'failed' })
  assert.equal(daemon.waiting.length, 0)
  assert.equal(daemon.completed[0].error.code, 'unsupported_provider_navigation')
  assert.equal(page.evaluateCalls, 0)
})

test('runner cancellation while waiting stops without running further adapter actions', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const daemon = new FakeDaemon([
    fakeJob('job-cancel-waiting', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'must not run' } }],
    })),
  ])
  daemon.cancelAfterWaiting = true
  let actionCalls = 0
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    adapterRegistry: fakeAdapterRegistry(async (_actionPage, request) => {
      actionCalls += 1
      return successResponse(request, { visible: true, inputProof: 'prompt-text-visible' })
    }),
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
    cancelPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-cancel-waiting', status: 'canceled' })
  assert.equal(actionCalls, 0)
  assert.equal(daemon.completed.length, 0)
})

test('runner times out user handover without running the blocked action', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const daemon = new FakeDaemon([
    fakeJob('job-timeout', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'never' } }],
    })),
  ])
  let actionCalls = 0
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page),
    adapterRegistry: fakeAdapterRegistry(async (actionPage, request) => {
      actionCalls += 1
      return successResponse(request, { visible: true, inputProof: 'prompt-text-visible' })
    }),
    userHandoverTimeoutMs: 30,
    userHandoverPollMs: 5,
    cancelPollMs: 1000,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-timeout', status: 'failed' })
  assert.equal(actionCalls, 0)
  assert.equal(daemon.completed[0].error.code, 'playwright_user_handover_timeout')
  assert.equal(daemon.completed[0].error.retryable, true)
})

test('strict headless jobs checkpoint and park user blockers without switching or cleanup', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const page = new FakeHandoverPage()
  const launches = []
  const root = await mkdtemp(join(tmpdir(), 'tokenless-headless-park-'))
  const jobRoot = join(root, 'job-headless-park')
  await mkdir(jobRoot)
  await writeFile(join(jobRoot, 'sentinel.txt'), 'keep me')
  const daemon = new FakeDaemon([
    fakeJob('job-headless-park', profiles[0], createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      browserVisibility: 'headless',
      actions: [{ action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'must park' } }],
    })),
  ])
  let actionCalls = 0
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page, launches),
    adapterRegistry: fakeAdapterRegistry(async (_page, request) => {
      actionCalls += 1
      return successResponse(request, { visible: true, inputProof: 'prompt-text-visible' })
    }),
    attachmentRootForJob: (job) => join(root, job.job_id),
    userHandoverTimeoutMs: 100,
    userHandoverPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-headless-park', status: 'waiting_for_user' })
  assert.equal(actionCalls, 0)
  assert.equal(daemon.completed.length, 0)
  assert.equal(daemon.parked.length, 1)
  assert.deepEqual(launches.map((launch) => launch.headless), [true])
  assert.equal(daemon.parked[0].blocker.browser.requestedVisibility, 'headless')
  assert.equal(daemon.parked[0].blocker.browser.effectiveVisibility, 'headless')
  assert.equal(daemon.parked[0].blocker.browser.windowOpen, false)
  await stat(join(jobRoot, 'sentinel.txt'))
})

test('runner resumes the same auto job headed from checkpoint after restart', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const launches = []
  const page = new FakeResponsePage()
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    browserVisibility: 'auto',
    actions: [
      { requestId: 'resume:input', action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'reconstruct me' } },
      { requestId: 'resume:submit', action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
      { requestId: 'resume:read', action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
    ],
  })
  const job = fakeJob('job-resume', profiles[0], request)
  job.checkpoint_json = {
    protocol: 'tokenless.playwright.runner-checkpoint.v1',
    jobId: 'job-resume',
    profileId: 'profile-a',
    provider: 'chatgpt',
    targetUrl: 'https://chatgpt.com/',
    browserVisibility: 'auto',
    actionCursor: 1,
    responses: [successResponse(request.actions[0], { visible: true, inputProof: 'prompt-text-visible' })],
    responseBaseline: null,
    submitted: null,
    phase: {
      state: 'completed',
      actionIndex: 0,
      requestId: 'resume:input',
      action: VISIBLE_ACTIONS.PROMPT_INPUT,
      mutating: true,
      providerUrl: 'https://chatgpt.com/',
    },
  }
  job.resume_json = { browser_visibility: 'headed' }
  const daemon = new FakeDaemon([job])
  const adapterEvents = []
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page, launches),
    responseWaitTimeoutMs: 500,
    responseWaitPollMs: 5,
    adapterRegistry: fakeAdapterRegistry(async (_page, action) => {
      adapterEvents.push(action.action)
      if (action.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) {
        setTimeout(() => page.answers.push('resumed answer'), 20)
        return successResponse(action, { visible: true, submissionProof: 'submitted' })
      }
      if (action.action === VISIBLE_ACTIONS.RESPONSE_READ) {
        return successResponse(action, { text: page.answers.at(-1), citations: [], visibleProof: 'latest' })
      }
      return successResponse(action, { visible: true, inputProof: 'prompt-text-visible' })
    }),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-resume', status: 'succeeded' })
  assert.deepEqual(launches.map((launch) => launch.headless), [false])
  assert.deepEqual(adapterEvents, [VISIBLE_ACTIONS.PROMPT_INPUT, VISIBLE_ACTIONS.PROMPT_SUBMIT, VISIBLE_ACTIONS.RESPONSE_READ])
  assert.equal(daemon.completed[0].result.responses.length, 3)
  assert.equal(daemon.completed[0].result.responses.filter((response) => response.action === VISIBLE_ACTIONS.PROMPT_SUBMIT).length, 1)
  assert.equal(daemon.completed[0].result.responses.at(-1).result.text, 'resumed answer')
})

test('runner resume override launches strict headless parked jobs headed without parking again', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const launches = []
  const page = new FakeHandoverPage()
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    browserVisibility: 'headless',
    actions: [{ requestId: 'headless-resume:input', action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'resume headed' } }],
  })
  const job = fakeJob('job-headless-resume', profiles[0], request)
  job.checkpoint_json = {
    protocol: 'tokenless.playwright.runner-checkpoint.v1',
    jobId: 'job-headless-resume',
    profileId: 'profile-a',
    provider: 'chatgpt',
    targetUrl: 'https://chatgpt.com/',
    browserVisibility: 'headless',
    actionCursor: 0,
    responses: [],
    responseBaseline: null,
    submitted: null,
    phase: { state: 'idle' },
  }
  job.resume_json = { browser_visibility: 'headed' }
  const daemon = new FakeDaemon([job])
  const adapterEvents = []
  daemon.onWaiting = () => {
    setTimeout(() => {
      page.rawBlockers = []
      page.composerVisible = true
    }, 25)
  }
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(page, launches),
    adapterRegistry: fakeAdapterRegistry(async (_page, action) => {
      adapterEvents.push(action.action)
      return successResponse(action, { visible: true, inputProof: 'prompt-text-visible' })
    }),
    userHandoverTimeoutMs: 500,
    userHandoverPollMs: 5,
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-headless-resume', status: 'succeeded' })
  assert.deepEqual(launches.map((launch) => launch.headless), [false])
  assert.equal(daemon.parked.length, 0)
  assert.equal(daemon.waiting[0].blocker.browser.requestedVisibility, 'headed')
  assert.equal(daemon.waiting[0].blocker.browser.effectiveVisibility, 'headed')
  assert.equal(daemon.waiting[0].blocker.browser.windowOpen, true)
  assert.deepEqual(adapterEvents, [VISIBLE_ACTIONS.PROMPT_INPUT])
})

test('runner fails closed when a checkpoint stopped inside a mutating action', async () => {
  const profiles = fakeProfiles(['profile-a'])
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    browserVisibility: 'auto',
    actions: [
      { requestId: 'ambiguous:input', action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'already typed' } },
      { requestId: 'ambiguous:submit', action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
      { requestId: 'ambiguous:read', action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
    ],
  })
  const job = fakeJob('job-ambiguous', profiles[0], request)
  job.checkpoint_json = {
    protocol: 'tokenless.playwright.runner-checkpoint.v1',
    jobId: 'job-ambiguous',
    profileId: 'profile-a',
    provider: 'chatgpt',
    targetUrl: 'https://chatgpt.com/',
    browserVisibility: 'auto',
    actionCursor: 1,
    responses: [successResponse(request.actions[0], { visible: true, inputProof: 'prompt-text-visible' })],
    responseBaseline: 1,
    submitted: null,
    phase: {
      state: 'started',
      actionIndex: 1,
      requestId: 'ambiguous:submit',
      action: VISIBLE_ACTIONS.PROMPT_SUBMIT,
      mutating: true,
      providerUrl: 'https://chatgpt.com/',
    },
  }
  const daemon = new FakeDaemon([job])
  const launches = []
  let actionCalls = 0
  const service = new ManagedPlaywrightRunnerService({
    profileRegistry: { async listProfiles() { return profiles } },
    daemonClient: daemon,
    contextManager: fakeContextManager(new FakeResponsePage(), launches),
    adapterRegistry: fakeAdapterRegistry(async (_page, action) => {
      actionCalls += 1
      return successResponse(action, { visibleProof: 'ok', state: 'authenticated' })
    }),
  })

  const result = await service.runOnce()

  assert.deepEqual(result, { claimed: true, jobId: 'job-ambiguous', status: 'failed' })
  assert.equal(actionCalls, 0)
  assert.deepEqual(launches, [])
  assert.equal(daemon.completed[0].error.code, 'ambiguous_action_outcome')
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
    this.checkpoints = []
    this.parked = []
    this.waiting = []
    this.cancelAfterRunning = false
    this.cancelAfterWaiting = false
    this.failRenewal = false
    this.onComplete = undefined
  }

  async createJob() { throw new Error('unused') }
  async listJobs() { throw new Error('unused') }

  async getJob({ jobId }) {
    const job = this.jobs.get(jobId)
    if (this.cancelAfterRunning && job?.status === 'running') job.status = 'canceled'
    if (this.cancelAfterWaiting && job?.status === 'waiting_for_user') job.status = 'canceled'
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

  async markJobWaitingForUser({ jobId, blocker }) {
    const job = this.jobs.get(jobId)
    job.status = 'waiting_for_user'
    job.blocker_json = blocker
    this.waiting.push({ jobId, blocker })
    this.onWaiting?.()
    return job
  }

  async checkpointJob({ jobId, checkpoint }) {
    const job = this.jobs.get(jobId)
    job.checkpoint_json = checkpoint
    this.checkpoints.push({ jobId, checkpoint })
    return job
  }

  async parkJob({ jobId, blocker, checkpoint }) {
    const job = this.jobs.get(jobId)
    job.status = 'waiting_for_user'
    job.claim_token = `${jobId}-parked-claim`
    job.blocker_json = blocker
    job.checkpoint_json = checkpoint
    job.resume_json = null
    this.parked.push({ jobId, blocker, checkpoint })
    this.onWaiting?.()
    return job
  }

  async resumeJob({ jobId, browserVisibility }) {
    const job = this.jobs.get(jobId)
    job.status = 'queued'
    job.resume_json = { browser_visibility: browserVisibility }
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
    this.closed = false
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
    this.closed = true
    this.emit('close')
  }
}

function fakeContextManager(page, launches = [], managerOptions = {}) {
  return new PersistentContextManager({
    ...(managerOptions.timers === undefined ? {} : { timers: managerOptions.timers }),
    launcher: async (_userDataDir, launchOptions) => {
      launches.push(launchOptions)
      const context = new FakeContext(page)
      managerOptions.contexts?.push(context)
      return context
    },
  })
}

function fakeContextManagerSequence(pages, launches = [], managerOptions = {}) {
  let launchIndex = 0
  return new PersistentContextManager({
    ...(managerOptions.timers === undefined ? {} : { timers: managerOptions.timers }),
    launcher: async (_userDataDir, launchOptions) => {
      launches.push(launchOptions)
      const page = pages[Math.min(launchIndex, pages.length - 1)]
      launchIndex += 1
      const context = new FakeContext(page)
      managerOptions.contexts?.push(context)
      return context
    },
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

class FakeForegroundPage {
  constructor() {
    this.events = []
    this.currentUrl = ''
  }

  async goto(url, options) {
    this.currentUrl = url
    this.events.push(['goto', url, options])
  }

  async bringToFront() {
    this.events.push(['bringToFront'])
  }

  url() {
    return this.currentUrl
  }

  locator() {
    return new FakeLocator(() => [])
  }
}

class FakeHandoverPage {
  constructor() {
    this.answers = ['old answer']
    this.rawBlockers = [{
      kind: 'challenge',
      code: 'visible_recaptcha',
      family: 'recaptcha',
      message: 'Visible reCAPTCHA verification is blocking the provider page.',
      proof: 'visible-recaptcha-frame',
    }]
    this.composerVisible = false
  }

  async goto() {}

  url() {
    return 'https://chatgpt.com/'
  }

  async evaluate() {
    return this.rawBlockers
  }

  locator(selector) {
    if (selector === '[data-message-author-role="assistant"]') {
      return new FakeLocator(() => this.answers.map(() => true))
    }
    if (selector === 'button[data-testid="stop-button"]') {
      return new FakeLocator(() => [])
    }
    if (selector === 'div#prompt-textarea[contenteditable="true"]' || selector === '#prompt-textarea[contenteditable="true"]') {
      return new FakeSingleLocator(() => this.composerVisible)
    }
    return new FakeSingleLocator(() => false)
  }
}

class FakeOffProviderSignInPage {
  constructor() {
    this.currentUrl = 'https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fchatgpt.com%2Fsecret#private'
    this.composerVisible = false
    this.offProviderEvaluateCalls = 0
  }

  async goto() {}

  url() {
    return this.currentUrl
  }

  async evaluate() {
    if (this.currentUrl.startsWith('https://accounts.google.com/')) {
      this.offProviderEvaluateCalls += 1
      throw new Error('off-provider DOM must not be inspected')
    }
    return []
  }

  locator(selector) {
    if (selector === 'div#prompt-textarea[contenteditable="true"]' || selector === '#prompt-textarea[contenteditable="true"]') {
      return new FakeSingleLocator(() => this.composerVisible)
    }
    return new FakeSingleLocator(() => false)
  }
}

class FakeUnsafeOffProviderPage {
  constructor(url = 'https://example.com/private?token=secret#fragment') {
    this.currentUrl = url
    this.evaluateCalls = 0
  }

  async goto() {}

  url() {
    return this.currentUrl
  }

  async evaluate() {
    this.evaluateCalls += 1
    throw new Error('unsafe off-provider DOM must not be inspected')
  }

  locator() {
    return new FakeSingleLocator(() => false)
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

class FakeSingleLocator {
  constructor(visible) {
    this.visible = visible
  }

  first() {
    return this
  }

  filter() {
    return this
  }

  async isVisible() {
    return Boolean(this.visible())
  }

  async count() {
    return this.visible() ? 1 : 0
  }

  nth() {
    return this
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
    blocker_json: null,
    checkpoint_json: null,
    resume_json: null,
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

class FakeTimers {
  constructor() {
    this.now = 0
    this.timers = []
  }

  setTimeout(callback, ms) {
    const timer = {
      dueAt: this.now + ms,
      callback,
      cleared: false,
    }
    this.timers.push(timer)
    return timer
  }

  clearTimeout(timer) {
    timer.cleared = true
  }

  async advance(ms) {
    this.now += ms
    while (true) {
      const due = this.timers
        .filter((timer) => !timer.cleared && timer.dueAt <= this.now)
        .sort((left, right) => left.dueAt - right.dueAt)[0]
      if (!due) return
      due.cleared = true
      due.callback()
      await Promise.resolve()
    }
  }
}
