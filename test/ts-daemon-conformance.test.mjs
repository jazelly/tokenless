import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')
const cliIndex = path.join(cliDir, 'dist/src/index.js')
const tsDaemonEntry = path.join(cliDir, 'dist/src/daemon/daemon-entry.mjs')
const managedPlaywrightJobAction = 'visible_provider_actions'
const supportedProviders = ['chatgpt', 'claude', 'gemini', 'grok', 'qwen']
const legacyProviders = [
  ['chatgpt', 'https://chatgpt.com/'],
  ['claude', 'https://claude.ai/new'],
  ['gemini', 'https://gemini.google.com/app'],
  ['grok', 'https://grok.com/'],
]

const createdChildren = new Set()

test.after(async () => {
  await Promise.all([...createdChildren].map((child) => terminateChild(child)))
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

test('JobStore migrates minimal legacy SQLite schema across concurrent real process opens', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-job-store-legacy-migration-')
  const jobId = randomUUID()
  const barrierDir = fs.mkdtempSync(path.join(homeDir, 'migration-barrier-'))
  const releaseMarker = path.join(barrierDir, 'release')
  const readyMarkers = [
    path.join(barrierDir, 'client-a.ready'),
    path.join(barrierDir, 'client-b.ready'),
  ]
  try {
    createMinimalLegacyJobStore(homeDir, jobId)
    const clients = readyMarkers.map((readyMarker) => runJobStoreMigrationClient({
      homeDir,
      jobId,
      readyMarker,
      releaseMarker,
    }))
    try {
      await Promise.all(readyMarkers.map((readyMarker) => waitForFile(readyMarker, 10_000)))
      fs.writeFileSync(releaseMarker, `${Date.now()}\n`, { flag: 'wx' })
      const results = await Promise.all(clients)
      assert.equal(results.length, 2)
      for (const result of results) {
        assert.equal(result.job.job_id, jobId)
        assert.equal(result.job.status, 'queued')
        assert.equal(result.job.claim_expires_at_ms, null)
        assert.deepEqual(result.job.checkpoint_json, null)
        assert.deepEqual(result.job.resume_json, null)
        assert.equal(result.count, 1)
      }
      assertMigratedJobColumns(homeDir)
    } catch (error) {
      if (!fs.existsSync(releaseMarker)) {
        fs.writeFileSync(releaseMarker, `${Date.now()}\n`, { flag: 'wx' })
      }
      await Promise.allSettled(clients)
      throw error
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon embeds the managed Playwright scheduler without idle browser launch', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-embedded-scheduler-')
  const profile = createReadyManagedProfile(homeDir)
  const daemon = await startTsDaemon(homeDir)
  try {
    await delay(1_500)
    assertProfileDirectoryEmpty(profile.directory)

    const token = readControlToken(homeDir)
    const jobId = randomUUID()
    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: profile.id,
      job_id: jobId,
      request_json: { malformed: true },
    })

    const failed = await waitForDaemonJobStatus(daemon.url, token, jobId, 'failed', 10_000)
    assert.equal(failed.error_json.code, 'invalid_playwright_job_request')
    assertProfileDirectoryEmpty(profile.directory)
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon rejects unsupported Playwright providers and preserves legacy jobs', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-provider-negotiation-')
  const daemon = await startTsDaemon(homeDir)
  try {
    const token = readControlToken(homeDir)
    const rejected = await fetch(`${daemon.url}/jobs`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        provider: 'not-a-provider',
        action: managedPlaywrightJobAction,
        execution_backend: 'playwright',
        profile_id: randomUUID(),
        job_id: randomUUID(),
        request_json: { malformed: true },
      }),
    })
    assert.equal(rejected.status, 400)
    const rejectedBody = await rejected.json()
    assert.equal(rejectedBody.error.code, 'invalid_input')
    assert.match(rejectedBody.error.message, /unsupported playwright provider: not-a-provider/)

    const legacyJobId = randomUUID()
    const legacy = await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'not-a-provider',
      action: 'prompt.submit',
      job_id: legacyJobId,
      request_json: { prompt: 'legacy extension compatibility' },
    })
    assert.equal(legacy.job_id, legacyJobId)
    assert.equal(legacy.provider, 'not-a-provider')
    assert.equal(legacy.execution_backend, 'legacy_extension')
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('built Playwright validators preserve legacy providers and enforce v3 registry membership', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const playwright = await importPlaywright()
  const runtime = await importCli()
  const legacyProtocols = [
    [runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1, runtime.VISIBLE_ACTION_PROTOCOL_VERSION_V1],
    [runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V2, runtime.VISIBLE_ACTION_PROTOCOL_VERSION_V2],
  ]
  for (const [jobProtocol, actionProtocol] of legacyProtocols) {
    for (const [provider, homeUrl] of legacyProviders) {
      const validated = playwright.validateManagedPlaywrightJobRequest({
        protocol: jobProtocol,
        provider,
        target: { kind: 'provider_home', url: homeUrl },
        taskId: `legacy-${jobProtocol}-${provider}`,
        ...(jobProtocol === runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1 ? {} : { browserVisibility: 'headless' }),
        actions: [
          {
            protocol: actionProtocol,
            requestId: `legacy-${actionProtocol}-${provider}`,
            provider,
            action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
            payload: {},
          },
        ],
      })
      assert.equal(validated.provider, provider)
      assert.equal(validated.target.url, homeUrl)
    }
    assert.throws(
      () => playwright.validateManagedPlaywrightJobRequest({
        protocol: jobProtocol,
        provider: 'qwen',
        target: { kind: 'provider_home', url: 'https://www.qianwen.com/' },
        taskId: `legacy-${jobProtocol}-qwen`,
        ...(jobProtocol === runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1 ? {} : { browserVisibility: 'headless' }),
        actions: [
          {
            protocol: actionProtocol,
            requestId: `legacy-${actionProtocol}-qwen`,
            provider: 'qwen',
            action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
            payload: {},
          },
        ],
      }),
      (error) => {
        assert.equal(error.code, 'invalid_playwright_job_protocol')
        return true
      }
    )
    assert.throws(
      () => playwright.validateVisibleActionRequest({
        protocol: actionProtocol,
        requestId: `legacy-action-policy-${actionProtocol}`,
        provider: 'qwen',
        action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
        payload: {},
      }),
      (error) => {
        assert.equal(error.code, 'invalid_visible_action_protocol')
        return true
      }
    )
  }

  const created = playwright.createManagedPlaywrightJobRequest({
    provider: 'qwen',
    target: { kind: 'provider_home', url: 'https://www.qianwen.com/' },
    taskId: 'v3-qwen-provider',
    browserVisibility: 'headless',
    actions: [
      {
        requestId: 'v3-action',
        action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
        payload: {},
      },
    ],
  })
  assert.equal(created.protocol, runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION)
  assert.equal(created.protocol, runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V3)
  assert.equal(created.provider, 'qwen')
  assert.equal(created.target.url, 'https://www.qianwen.com/')
  assert.equal(created.actions[0].provider, 'qwen')
  assert.equal(created.actions[0].protocol, runtime.VISIBLE_ACTION_PROTOCOL_VERSION)
  assert.equal(created.actions[0].protocol, runtime.VISIBLE_ACTION_PROTOCOL_VERSION_V3)

  const v3Validated = playwright.validateManagedPlaywrightJobRequest({
    protocol: runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V3,
    provider: 'qwen',
    target: { kind: 'provider_home', url: 'https://www.qianwen.com/' },
    taskId: 'v3-explicit-qwen-provider',
    browserVisibility: 'headless',
    actions: [
      {
        protocol: runtime.VISIBLE_ACTION_PROTOCOL_VERSION_V3,
        requestId: 'v3-explicit-action',
        provider: 'qwen',
        action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
        payload: {},
      },
    ],
  })
  assert.equal(v3Validated.provider, 'qwen')
  assert.equal(v3Validated.actions[0].provider, 'qwen')

  assert.throws(
    () => playwright.validateManagedPlaywrightJobRequest({
      protocol: runtime.MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V3,
      provider: 'future-ai',
      target: { kind: 'provider_home', url: 'https://future.example/' },
      taskId: 'registry-rejects-unknown-provider',
      browserVisibility: 'headless',
      actions: [
        {
          protocol: runtime.VISIBLE_ACTION_PROTOCOL_VERSION_V3,
          requestId: 'unknown-provider-action',
          provider: 'future-ai',
          action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
          payload: {},
        },
      ],
    }),
    (error) => {
      assert.equal(error.code, 'unknown_playwright_job_provider')
      return true
    }
  )
})

test('TS daemon browser runtime control is authenticated, quiesces queued work, and wakes on later job creation', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-browser-runtime-control-')
  const profileId = randomUUID()
  const daemon = await startTsDaemon(homeDir)
  try {
    const token = readControlToken(homeDir)

    const missingStatus = await fetch(`${daemon.url}/control/browser-runtime/status`)
    assert.equal(missingStatus.status, 401)
    const missingStatusBody = await missingStatus.json()
    assert.equal(missingStatusBody.error.code, 'control_auth_missing')

    const rejectedQuiesce = await fetch(`${daemon.url}/control/browser-runtime/quiesce`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(rejectedQuiesce.status, 403)
    const rejectedQuiesceBody = await rejectedQuiesce.json()
    assert.equal(rejectedQuiesceBody.error.code, 'control_auth_rejected')
    assert.equal(JSON.stringify(rejectedQuiesceBody).includes(token), false)

    const running = await daemonRequest(daemon.url, token, 'GET', '/control/browser-runtime/status')
    assert.equal(running.protocol, 'tokenless.browser-runtime-control.v1')
    assert.equal(running.status, 'running')
    assert.equal(running.pid, daemon.child.pid)
    assert.equal(running.activeProfileCount, 0)
    assert.equal(running.activeJobCount, 0)

    const pausedJobId = randomUUID()
    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: profileId,
      job_id: pausedJobId,
      request_json: { malformed: true },
    })
    const quiesced = await daemonRequest(daemon.url, token, 'POST', '/control/browser-runtime/quiesce')
    assert.equal(quiesced.status, 'quiesced')
    assert.equal(quiesced.activeProfileCount, 0)
    assert.equal(quiesced.activeJobCount, 0)

    await delay(1_500)
    const stillQueued = await daemonRequest(daemon.url, token, 'GET', `/jobs/${encodeURIComponent(pausedJobId)}`)
    assert.equal(stillQueued.status, 'queued')
    const profile = createReadyManagedProfile(homeDir, { profileId })
    assertProfileDirectoryEmpty(profile.directory)

    const wakeJobId = randomUUID()
    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: profileId,
      job_id: wakeJobId,
      request_json: { malformed: true },
    })
    const failedPausedJob = await waitForDaemonJobStatus(daemon.url, token, pausedJobId, 'failed', 10_000)
    assert.equal(failedPausedJob.error_json.code, 'invalid_playwright_job_request')
    const failedWakeJob = await waitForDaemonJobStatus(daemon.url, token, wakeJobId, 'failed', 10_000)
    assert.equal(failedWakeJob.error_json.code, 'invalid_playwright_job_request')
    const awake = await daemonRequest(daemon.url, token, 'GET', '/control/browser-runtime/status')
    assert.equal(awake.status, 'running')
    assertProfileDirectoryEmpty(profile.directory)
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon browser runtime wakes from quiesced state when a parked job resumes', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-browser-runtime-resume-wake-')
  const profileId = randomUUID()
  const daemon = await startTsDaemon(homeDir)
  try {
    const token = readControlToken(homeDir)
    const jobId = randomUUID()
    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: profileId,
      job_id: jobId,
      request_json: { malformed: true },
    })
    const quiesced = await daemonRequest(daemon.url, token, 'POST', '/control/browser-runtime/quiesce')
    assert.equal(quiesced.status, 'quiesced')
    const profile = createReadyManagedProfile(homeDir, { profileId })
    const claimed = await daemonRequest(
      daemon.url,
      token,
      'POST',
      `/control/jobs/claim-next?execution_backend=playwright&profile_id=${encodeURIComponent(profile.id)}`
    )
    assert.equal(claimed.job.job_id, jobId)
    const parked = await daemonRequest(daemon.url, token, 'POST', `/control/jobs/${encodeURIComponent(jobId)}/park`, {
      claim_token: claimed.job.claim_token,
      blocker_json: { reason: 'resume-test', browser: { windowOpen: false } },
      checkpoint_json: { phase: 'resume-wake-test' },
    })
    assert.equal(parked.status, 'waiting_for_user')
    assert.equal((await daemonRequest(daemon.url, token, 'GET', '/control/browser-runtime/status')).status, 'quiesced')

    const resumed = await daemonRequest(daemon.url, token, 'POST', `/jobs/${encodeURIComponent(jobId)}/resume`, {
      browser_visibility: 'headed',
    })
    assert.equal(resumed.status, 'queued')
    const failed = await waitForDaemonJobStatus(daemon.url, token, jobId, 'failed', 10_000)
    assert.equal(failed.error_json.code, 'invalid_playwright_job_request')
    assert.equal((await daemonRequest(daemon.url, token, 'GET', '/control/browser-runtime/status')).status, 'running')
    assertProfileDirectoryEmpty(profile.directory)
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('gated real browser quiesce settles an embedded-owned active claim before returning', {
  timeout: 180_000,
}, async (t) => {
  if (process.env.TOKENLESS_RUN_ACTIVE_CLAIM_QUIESCE_E2E !== '1') {
    t.skip('set TOKENLESS_RUN_ACTIVE_CLAIM_QUIESCE_E2E=1 to run real Chromium/provider active-claim quiesce proof')
    return
  }
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-active-claim-quiesce-')
  const profile = createReadyManagedProfile(homeDir)
  const daemon = await startTsDaemon(homeDir)
  try {
    const token = readControlToken(homeDir)
    const playwright = await importPlaywright()
    const jobId = randomUUID()
    const request = playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      target: { kind: 'provider_home', url: 'https://chatgpt.com/' },
      browserVisibility: 'headed',
      taskId: `active-claim-quiesce:${jobId}`,
      actions: [
        { requestId: `${jobId}:auth`, action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} },
      ],
    })
    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: profile.id,
      job_id: jobId,
      request_json: request,
    })
    const active = await waitForDaemonJobOneOf(daemon.url, token, jobId, ['running', 'waiting_for_user', 'succeeded', 'failed'], 90_000)
    if (active.status !== 'running') {
      t.skip(`real browser job reached ${active.status} before quiesce could observe a running claim`)
      return
    }
    const quiesced = await daemonRequest(daemon.url, token, 'POST', '/control/browser-runtime/quiesce')
    assert.equal(quiesced.status, 'quiesced')
    const latest = await daemonRequest(daemon.url, token, 'GET', `/jobs/${encodeURIComponent(jobId)}`)
    assert.notEqual(latest.status, 'claimed')
    assert.notEqual(latest.status, 'running')
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('profile removal quiesces the TS browser runtime while preserving the old runner JSON shape', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-profile-remove-quiesce-')
  createReadyManagedProfile(homeDir)
  const daemon = await startTsDaemon(homeDir)
  try {
    const runtime = await importCli()
    await runtime.writeTokenlessConfig({ homeDir, daemonUrl: daemon.url })
    const result = runCli([
      'profiles',
      'remove',
      '--home',
      homeDir,
      '--profile',
      'default',
      '--confirm-delete',
      '--json',
    ])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.runner, {
      state: 'stopped',
      pid: null,
      sessionId: null,
      safeToStop: false,
      heartbeatAt: null,
    })
    assert.deepEqual(Object.keys(payload.runner).sort(), ['heartbeatAt', 'pid', 'safeToStop', 'sessionId', 'state'].sort())
    const token = readControlToken(homeDir)
    const status = await daemonRequest(daemon.url, token, 'GET', '/control/browser-runtime/status')
    assert.equal(status.status, 'quiesced')
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon closes when the embedded managed Playwright scheduler exits fatally', {
  timeout: 30_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-embedded-scheduler-fatal-')
  createOverlyPermissiveManagedProfileRegistry(homeDir)
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
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
  trackChild(child, homeDir)
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  try {
    const exit = await waitForExitResult(child, 10_000)
    assert.equal(exit.code, 1, `expected scheduler fatal exit; got ${JSON.stringify(exit)}\nstderr:\n${stderr}`)
    await assert.rejects(fetch(`${url}/ready?challenge=${randomBytes(32).toString('base64url')}`))
  } finally {
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
      assert.deepEqual(ready.supported_providers, supportedProviders)
      assert.deepEqual(ready.supported_protocols.job, [
        'tokenless.playwright.job.v1',
        'tokenless.playwright.job.v2',
        'tokenless.playwright.job.v3',
      ])
      assert.deepEqual(ready.supported_protocols.action, [
        'tokenless.playwright.visible-action.v1',
        'tokenless.playwright.visible-action.v2',
        'tokenless.playwright.visible-action.v3',
      ])
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

async function importCli() {
  return await import(`${pathToFileURL(cliIndex).href}?test=${Date.now()}-${Math.random()}`)
}

async function importPlaywright() {
  return await import(`${pathToFileURL(path.join(cliDir, 'dist/src/playwright/index.js')).href}?test=${Date.now()}-${Math.random()}`)
}

function runCli(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 30_000,
  })
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

function createReadyManagedProfile(homeDir, options = {}) {
  const browserDir = path.join(homeDir, 'browser')
  const profilesRoot = path.join(browserDir, 'profiles')
  const profileId = options.profileId ?? randomUUID()
  const profileDir = path.join(profilesRoot, profileId)
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  const now = new Date().toISOString()
  fs.writeFileSync(path.join(browserDir, 'profiles.json'), `${JSON.stringify({
    version: 1,
    defaultProfile: 'default',
    profiles: {
      default: {
        slug: 'default',
        id: profileId,
        label: 'Default',
        labelOrigin: 'slug',
        directory: profileDir,
        lifecycle: 'ready',
        createdAt: now,
        updatedAt: now,
        lastObservedAuth: {},
      },
    },
  }, null, 2)}\n`, { mode: 0o600 })
  return { id: profileId, directory: profileDir }
}

function assertProfileDirectoryEmpty(profileDir) {
  assert.deepEqual(fs.readdirSync(profileDir).sort(), [])
}

function createOverlyPermissiveManagedProfileRegistry(homeDir) {
  const browserDir = path.join(homeDir, 'browser')
  const profilesRoot = path.join(browserDir, 'profiles')
  fs.mkdirSync(profilesRoot, { recursive: true, mode: 0o700 })
  const registryPath = path.join(browserDir, 'profiles.json')
  fs.writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    defaultProfile: null,
    profiles: {},
  }, null, 2)}\n`, { mode: 0o644 })
  fs.chmodSync(registryPath, 0o644)
}

async function waitForDaemonJobStatus(daemonUrl, token, jobId, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await daemonRequest(daemonUrl, token, 'GET', `/jobs/${encodeURIComponent(jobId)}`)
    if (latest.status === status) return latest
    await delay(100)
  }
  throw new Error(`job ${jobId} did not reach ${status}; latest: ${JSON.stringify(latest)}`)
}

async function waitForDaemonJobOneOf(daemonUrl, token, jobId, statuses, timeoutMs) {
  const expected = new Set(statuses)
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await daemonRequest(daemonUrl, token, 'GET', `/jobs/${encodeURIComponent(jobId)}`)
    if (expected.has(latest.status)) return latest
    await delay(100)
  }
  throw new Error(`job ${jobId} did not reach one of ${statuses.join(', ')}; latest: ${JSON.stringify(latest)}`)
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

function waitForExitResult(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs} ms`))
    }, timeoutMs)
    const onExit = (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
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

function createMinimalLegacyJobStore(homeDir, jobId) {
  fs.writeFileSync(path.join(homeDir, 'daemon.token'), `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
  const databasePath = path.join(homeDir, 'tokenless.sqlite3')
  const db = new DatabaseSync(databasePath)
  try {
    db.exec(`
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY NOT NULL,
        claim_token TEXT NOT NULL,
        execution_backend TEXT NOT NULL DEFAULT 'legacy_extension',
        profile_id TEXT,
        provider TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        blocker_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO jobs (
        job_id, claim_token, execution_backend, profile_id,
        provider, action, status, request_json,
        result_json, error_json, blocker_json, created_at, updated_at
      ) VALUES (?, ?, 'legacy_extension', NULL, 'claude', 'prompt.submit', 'queued', ?, NULL, NULL, NULL, ?, ?)
    `).run(jobId, `legacy-${randomUUID()}`, JSON.stringify({ prompt: 'legacy schema migration' }), now, now)
  } finally {
    db.close()
  }
}

function runJobStoreMigrationClient({
  homeDir,
  jobId,
  readyMarker,
  releaseMarker,
}) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    jobStoreMigrationClientSource(),
    cliDir,
    homeDir,
    jobId,
    readyMarker,
    releaseMarker,
  ], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  createdChildren.add(child)
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      createdChildren.delete(child)
      if (code !== 0) {
        reject(new Error(`JobStore migration client exited ${code}: ${stderr}`))
        return
      }
      try {
        const resultPath = `${readyMarker}.result.json`
        resolve(JSON.parse(fs.readFileSync(resultPath, 'utf8')))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function jobStoreMigrationClientSource() {
  return `
    import fs from 'node:fs'
    import path from 'node:path'
    import { pathToFileURL } from 'node:url'

    const [cliDir, homeDir, jobId, readyMarker, releaseMarker] = process.argv.slice(1)
    fs.writeFileSync(readyMarker, 'ready\\n', { flag: 'wx' })
    while (!fs.existsSync(releaseMarker)) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const { JobStore } = await import(pathToFileURL(path.join(cliDir, 'dist/src/daemon/job-store.js')).href)
    const store = await JobStore.open(homeDir)
    try {
      const job = store.getJob(jobId)
      const count = store.listJobs().length
      fs.writeFileSync(\`\${readyMarker}.result.json\`, JSON.stringify({ job, count }))
    } finally {
      store.close()
    }
  `
}

function assertMigratedJobColumns(homeDir) {
  const db = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((row) => String(row.name)))
    for (const column of [
      'checkpoint_json',
      'resume_json',
      'claim_expires_at',
      'summary_task_id',
      'summary_project_name',
      'summary_chat_name',
      'summary_idempotency_key',
    ]) {
      assert.equal(columns.has(column), true, `expected migrated jobs.${column}`)
    }
  } finally {
    db.close()
  }
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
}
