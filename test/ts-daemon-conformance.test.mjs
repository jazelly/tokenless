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
const createdChildren = new Set()

test.after(async () => {
  await Promise.all([...createdChildren].map((child) => terminateChild(child)))
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

test('JobStore normalizes a legacy WAL database for direct read compatibility', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-legacy-wal-')
  const databasePath = path.join(homeDir, 'tokenless.sqlite3')
  const legacyDatabase = new DatabaseSync(databasePath)
  try {
    assert.equal(String(legacyDatabase.prepare('PRAGMA journal_mode = WAL').get().journal_mode).toLowerCase(), 'wal')
  } finally {
    legacyDatabase.close()
  }

  const moduleUrl = pathToFileURL(path.join(cliDir, 'dist/src/daemon/job-store.js')).href + '?test=' + randomUUID()
  const { JobStore } = await import(moduleUrl)
  let store
  try {
    store = await JobStore.open(homeDir)
    store.close()
    store = undefined

    const readOnlyDatabase = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(String(readOnlyDatabase.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'delete')
    } finally {
      readOnlyDatabase.close()
    }
    assert.equal(fs.existsSync(databasePath + '-wal'), false)
  } finally {
    store?.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})
test('TS daemon rejects unsupported Playwright providers', {
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
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon rejects under-declared capability routes before durable job creation', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-capability-route-validation-')
  const daemon = await startTsDaemon(homeDir)
  try {
    const token = readControlToken(homeDir)
    const playwright = await importPlaywright()
    const route = playwright.resolveTaskCapabilityRoute({
      requirements: [playwright.TASK_CAPABILITIES.CONVERSATION_CHAT],
      candidates: [{ provider: 'chatgpt', runtimeEligibility: 'eligible' }],
    })
    assert.equal(route.ok, true)
    const rejected = await fetch(`${daemon.url}/jobs`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        provider: 'chatgpt',
        action: managedPlaywrightJobAction,
        execution_backend: 'playwright',
        profile_id: randomUUID(),
        job_id: randomUUID(),
        request_json: {
          protocol: 'tokenless.playwright.job.v3',
          provider: 'chatgpt',
          target: { kind: 'provider_home', url: 'https://chatgpt.com/' },
          taskId: 'under-declared-route',
          capabilityRoute: route.route,
          fallback: null,
          browserVisibility: 'headless',
          actions: [{
            protocol: 'tokenless.playwright.visible-action.v3',
            requestId: 'under-declared-route:file',
            provider: 'chatgpt',
            action: playwright.VISIBLE_ACTIONS.FILE_UPLOAD,
            payload: {
              attachments: [{
                protocol: 'tokenless.visible-attachment.v1',
                bundleId: 'under-declared-route-bundle',
                attachmentId: 'under-declared-route-attachment',
                name: 'evidence.txt',
                type: 'text/plain',
                size: 8,
                sha256: 'c'.repeat(64),
              }],
            },
          }],
        },
      }),
    })
    assert.equal(rejected.status, 400)
    const body = await rejected.json()
    assert.equal(body.error.code, 'invalid_input')
    assert.match(body.error.message, /omits action-required capabilities: file\.upload/)
    const jobs = await daemonRequest(daemon.url, token, 'GET', '/jobs?limit=10')
    assert.deepEqual(jobs, [])
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon rejects raw image jobs that bypass the shared image/download contract', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-arena-image-job-contract-')
  const daemon = await startTsDaemon(homeDir)
  try {
    const token = readControlToken(homeDir)
    const playwright = await importPlaywright()
    const artifactOnly = playwright.resolveTaskCapabilityRoute({
      requirements: [
        playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
        playwright.TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
      ],
      candidates: [{ provider: 'arena', runtimeEligibility: 'eligible' }],
    })
    const imageDownload = playwright.resolveTaskCapabilityRoute({
      requirements: [
        playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
        playwright.TASK_CAPABILITIES.IMAGE_GENERATION,
        playwright.TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
      ],
      candidates: [{ provider: 'arena', runtimeEligibility: 'eligible' }],
    })
    const metaImageDownload = playwright.resolveTaskCapabilityRoute({
      requirements: [
        playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
        playwright.TASK_CAPABILITIES.IMAGE_GENERATION,
        playwright.TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
      ],
      candidates: [{ provider: 'meta', runtimeEligibility: 'eligible' }],
    })
    const chatgptImageDownload = playwright.resolveTaskCapabilityRoute({
      requirements: [
        playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
        playwright.TASK_CAPABILITIES.IMAGE_GENERATION,
        playwright.TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
      ],
      candidates: [{ provider: 'chatgpt', runtimeEligibility: 'eligible' }],
    })
    const grokImageDownload = playwright.resolveTaskCapabilityRoute({
      requirements: [
        playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
        playwright.TASK_CAPABILITIES.IMAGE_GENERATION,
        playwright.TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
      ],
      candidates: [{ provider: 'grok', runtimeEligibility: 'eligible' }],
    })
    assert.equal(artifactOnly.ok, true)
    assert.equal(imageDownload.ok, true)
    assert.equal(metaImageDownload.ok, true)
    assert.equal(chatgptImageDownload.ok, true)
    assert.equal(grokImageDownload.ok, true)
    const valid = playwright.createManagedPlaywrightJobRequest({
      provider: 'arena',
      taskId: 'arena-image-contract-task',
      capabilityRoute: imageDownload.route,
      browserVisibility: 'headless',
      actions: [
        { requestId: 'arena-surface', action: playwright.VISIBLE_ACTIONS.ARENA_SURFACE_SELECT, payload: { mode: 'direct', modality: 'image' } },
        { requestId: 'arena-prompt', action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'contract test' } },
        { requestId: 'arena-submit', action: playwright.VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
        { requestId: 'arena-read', action: playwright.VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })
    const { context: _context, ...wireBase } = valid
    const metaValid = playwright.createManagedPlaywrightJobRequest({
      provider: 'meta',
      taskId: 'meta-image-contract-task',
      capabilityRoute: metaImageDownload.route,
      browserVisibility: 'headless',
      actions: [
        { requestId: 'meta-prompt', action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'contract test' } },
        { requestId: 'meta-submit', action: playwright.VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
        { requestId: 'meta-read', action: playwright.VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })
    assert.equal(metaValid.actions.some((action) => action.action === playwright.VISIBLE_ACTIONS.ARENA_SURFACE_SELECT), false)
    const { context: _metaContext, ...metaWireBase } = metaValid
    const chatgptValid = playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      taskId: 'chatgpt-image-contract-task',
      capabilityRoute: chatgptImageDownload.route,
      browserVisibility: 'headless',
      actions: [
        { requestId: 'chatgpt-prompt', action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'contract test' } },
        { requestId: 'chatgpt-submit', action: playwright.VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
        { requestId: 'chatgpt-read', action: playwright.VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })
    assert.equal(chatgptValid.actions.some((action) => action.action === playwright.VISIBLE_ACTIONS.ARENA_SURFACE_SELECT), false)
    const { context: _chatgptContext, ...chatgptWireBase } = chatgptValid
    const grokValid = playwright.createManagedPlaywrightJobRequest({
      provider: 'grok',
      taskId: 'grok-image-contract-task',
      capabilityRoute: grokImageDownload.route,
      browserVisibility: 'headless',
      actions: [
        { requestId: 'grok-imagine', action: playwright.VISIBLE_ACTIONS.GROK_IMAGINE_SELECT, payload: { modality: 'image' } },
        { requestId: 'grok-prompt', action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'contract test' } },
        { requestId: 'grok-submit', action: playwright.VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
        { requestId: 'grok-read', action: playwright.VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })
    assert.equal(grokValid.actions.some((action) => action.action === playwright.VISIBLE_ACTIONS.GROK_IMAGINE_SELECT), true)
    const { context: _grokContext, ...grokWireBase } = grokValid
    const cases = [
      {
        provider: 'arena',
        request_json: {
          ...wireBase,
          capabilityRoute: artifactOnly.route,
        },
        message: /artifact\.download requires image\.generation or image\.edit/u,
      },
      {
        provider: 'arena',
        request_json: {
          ...wireBase,
          actions: valid.actions.map((action) => (
            action.action === playwright.VISIBLE_ACTIONS.ARENA_SURFACE_SELECT
              ? { ...action, payload: { mode: 'battle', modality: 'image' } }
              : action
          )),
        },
        message: /Arena image capabilities require arena\.surface\.select with mode direct and modality image/u,
      },
      {
        provider: 'meta',
        request_json: {
          ...metaWireBase,
          actions: metaValid.actions.filter((action) => action.action === playwright.VISIBLE_ACTIONS.RESPONSE_READ),
        },
        message: /Image capabilities require prompt\.input, prompt\.submit, and response\.read in order/u,
      },
      {
        provider: 'chatgpt',
        request_json: {
          ...chatgptWireBase,
          actions: chatgptValid.actions.filter((action) => action.action === playwright.VISIBLE_ACTIONS.RESPONSE_READ),
        },
        message: /Image capabilities require prompt\.input, prompt\.submit, and response\.read in order/u,
      },
      {
        provider: 'grok',
        request_json: {
          ...grokWireBase,
          actions: grokValid.actions.filter((action) => action.action !== playwright.VISIBLE_ACTIONS.GROK_IMAGINE_SELECT),
        },
        message: /Grok Imagine image capabilities require grok\.imagine\.select with modality image/u,
      },
      {
        provider: 'grok',
        request_json: {
          ...grokWireBase,
          actions: [
            ...grokValid.actions.filter((action) => action.action !== playwright.VISIBLE_ACTIONS.GROK_IMAGINE_SELECT),
            grokValid.actions.find((action) => action.action === playwright.VISIBLE_ACTIONS.GROK_IMAGINE_SELECT),
          ],
        },
        message: /before prompt\.input/u,
      },
    ]
    for (const [index, entry] of cases.entries()) {
      const rejected = await fetch(`${daemon.url}/jobs`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          provider: entry.provider,
          action: managedPlaywrightJobAction,
          execution_backend: 'playwright',
          profile_id: randomUUID(),
          job_id: `${entry.provider}-image-contract-${index}-${randomUUID()}`,
          request_json: entry.request_json,
        }),
      })
      assert.equal(rejected.status, 400)
      const body = await rejected.json()
      assert.equal(body.error.code, 'invalid_input')
      assert.match(body.error.message, entry.message)
    }
    assert.deepEqual(await daemonRequest(daemon.url, token, 'GET', '/jobs?limit=10'), [])
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('agent replay drains each durable job once, survives restart, and keeps full job state queryable', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-agent-replay-')
  let daemon = await startTsDaemon(homeDir)
  const agentA = { agent_kind: 'codex', agent_session_id: `session-a-${randomUUID()}` }
  const agentB = { agent_kind: 'codex', agent_session_id: `session-b-${randomUUID()}` }
  const agentC = { agent_kind: 'codex', agent_session_id: `session-c-${randomUUID()}` }
  const agentD = { agent_kind: 'codex', agent_session_id: `session-d-${randomUUID()}` }
  const agentE = { agent_kind: 'codex', agent_session_id: `session-e-${randomUUID()}` }
  const jobA = randomUUID()
  const jobB = randomUUID()
  const jobC = randomUUID()
  const jobD = randomUUID()
  const jobE = randomUUID()
  const unaddressedJob = randomUUID()
  try {
    const token = readControlToken(homeDir)
    await daemonRequest(daemon.url, token, 'POST', '/control/browser-runtime/quiesce')
    for (const invalidRecipient of [
      { agent_kind: null },
      { agent_kind: null, agent_session_id: null },
    ]) {
      const response = await fetch(`${daemon.url}/jobs`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          provider: 'chatgpt',
          action: managedPlaywrightJobAction,
          execution_backend: 'playwright',
          profile_id: randomUUID(),
          request_json: { malformed: true },
          ...invalidRecipient,
        }),
      })
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error.code, 'invalid_input')
    }
    for (const invalidLimit of [null, 201]) {
      const invalidReplayLimit = await fetch(`${daemon.url}/replay/drain`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          ...agentA,
          limit: invalidLimit,
        }),
      })
      assert.equal(invalidReplayLimit.status, 400)
      assert.equal((await invalidReplayLimit.json()).error.code, 'invalid_input')
    }

    for (const [jobId, recipient] of [
      [jobA, agentA],
      [jobB, agentB],
      [unaddressedJob, null],
    ]) {
      await daemonRequest(daemon.url, token, 'POST', '/jobs', {
        provider: 'chatgpt',
        action: managedPlaywrightJobAction,
        execution_backend: 'playwright',
        profile_id: randomUUID(),
        job_id: jobId,
        ...(recipient ?? {}),
        request_json: {
          malformed: true,
          taskId: `task-${jobId}`,
        },
      })
      await daemonRequest(daemon.url, token, 'POST', `/jobs/${encodeURIComponent(jobId)}/cancel`, {
        reason: { code: 'replay_test', detail: 'x'.repeat(2_000) },
      })
    }

    const isolated = await daemonRequest(daemon.url, token, 'POST', '/replay/drain', {
      agent_kind: agentA.agent_kind,
      agent_session_id: `unknown-${randomUUID()}`,
    })
    assert.deepEqual(isolated.jobs, [])

    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: randomUUID(),
      job_id: jobC,
      ...agentC,
      request_json: { malformed: true, taskId: `task-${jobC}` },
    })
    const waitingDatabase = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
    try {
      waitingDatabase.prepare(
        `UPDATE jobs
         SET status = 'waiting_for_user', blocker_json = ?, checkpoint_json = ?,
             claim_expires_at = NULL, updated_at = ?,
             outcome_revision = outcome_revision + 1
         WHERE job_id = ?`
      ).run(
        JSON.stringify({ code: 'user_action_required' }),
        JSON.stringify({ cursor: 'durable-checkpoint' }),
        new Date(1_000).toISOString(),
        jobC
      )
    } finally {
      waitingDatabase.close()
    }
    const waitingReplay = await daemonRequest(daemon.url, token, 'POST', '/replay/drain', agentC)
    assert.deepEqual(waitingReplay.jobs.map((job) => [job.job_id, job.status]), [[jobC, 'waiting_for_user']])
    const sameTimestampDatabase = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
    try {
      sameTimestampDatabase.prepare(
        `UPDATE jobs
         SET status = 'canceled', error_json = ?, blocker_json = NULL, checkpoint_json = NULL,
             outcome_revision = outcome_revision + 1
         WHERE job_id = ?`
      ).run(JSON.stringify({ code: 'job_canceled', reason: { code: 'after_waiting_report' } }), jobC)
    } finally {
      sameTimestampDatabase.close()
    }
    const finalRevisionReplay = await daemonRequest(daemon.url, token, 'POST', '/replay/drain', agentC)
    assert.deepEqual(finalRevisionReplay.jobs.map((job) => [job.job_id, job.status]), [[jobC, 'canceled']])
    assert.equal(finalRevisionReplay.jobs[0].updated_at, waitingReplay.jobs[0].updated_at)
    assert.deepEqual((await daemonRequest(daemon.url, token, 'POST', '/replay/drain', agentC)).jobs, [])

    const createdJobD = await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: randomUUID(),
      job_id: jobD,
      ...agentD,
      request_json: { malformed: true },
    })
    assert.equal(Object.hasOwn(createdJobD, 'agent_kind'), false)
    assert.equal(Object.hasOwn(createdJobD, 'agent_session_id'), false)
    await daemonRequest(daemon.url, token, 'POST', `/jobs/${encodeURIComponent(jobD)}/cancel`)
    const mismatchedReceipt = await fetch(`${daemon.url}/jobs/${encodeURIComponent(jobD)}/report`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        agent_kind: agentD.agent_kind,
        agent_session_id: `wrong-${randomUUID()}`,
      }),
    })
    assert.equal(mismatchedReceipt.status, 404)
    const mismatchedReceiptBody = await mismatchedReceipt.json()
    assert.equal(mismatchedReceiptBody.error.code, 'job_not_found')
    assert.equal(Object.hasOwn(mismatchedReceiptBody, 'job'), false)
    const runtime = await importCli()
    const firstReceipt = await runtime.markDaemonJobReported({
      homeDir,
      daemonUrl: daemon.url,
      jobId: jobD,
      agentKind: agentD.agent_kind,
      agentSessionId: agentD.agent_session_id,
    })
    assert.equal(firstReceipt.reported, true)
    const repeatedReceipt = await runtime.markDaemonJobReported({
      homeDir,
      daemonUrl: daemon.url,
      jobId: jobD,
      agentKind: agentD.agent_kind,
      agentSessionId: agentD.agent_session_id,
    })
    assert.equal(repeatedReceipt.reported, false)
    assert.deepEqual((await daemonRequest(daemon.url, token, 'POST', '/replay/drain', agentD)).jobs, [])

    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: randomUUID(),
      job_id: jobE,
      ...agentE,
      request_json: { malformed: true },
    })
    const activeWaitingDatabase = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
    try {
      activeWaitingDatabase.prepare(
        `UPDATE jobs
         SET status = 'waiting_for_user', blocker_json = ?,
             claim_expires_at = ?, outcome_revision = outcome_revision + 1
         WHERE job_id = ?`
      ).run(
        JSON.stringify({ code: 'active_user_handover' }),
        Date.now() + 60_000,
        jobE
      )
    } finally {
      activeWaitingDatabase.close()
    }
    const activeWaitingReceipt = await runtime.markDaemonJobReported({
      homeDir,
      daemonUrl: daemon.url,
      jobId: jobE,
      agentKind: agentE.agent_kind,
      agentSessionId: agentE.agent_session_id,
    })
    assert.equal(activeWaitingReceipt.reported, true)
    const repeatedActiveWaitingReceipt = await runtime.markDaemonJobReported({
      homeDir,
      daemonUrl: daemon.url,
      jobId: jobE,
      agentKind: agentE.agent_kind,
      agentSessionId: agentE.agent_session_id,
    })
    assert.equal(repeatedActiveWaitingReceipt.reported, false)
    assert.deepEqual((await daemonRequest(daemon.url, token, 'POST', '/replay/drain', agentE)).jobs, [])

    const cliReplay = runCli([
      'replay',
      '--home',
      homeDir,
      '--agent-kind',
      agentA.agent_kind,
      '--agent-session-id',
      agentA.agent_session_id,
      '--json',
    ])
    assert.equal(cliReplay.status, 0, cliReplay.stderr || cliReplay.stdout)
    const cliPayload = JSON.parse(cliReplay.stdout)
    assert.equal(cliPayload.ok, true)
    assert.equal(cliPayload.count, 1)
    assert.equal(cliPayload.jobs[0].job_id, jobA)
    assert.equal(cliPayload.jobs[0].status, 'canceled')
    assert.equal(cliPayload.jobs[0].task_id, `task-${jobA}`)
    assert.equal(cliPayload.jobs[0].outcome_kind, 'error')
    assert.equal(cliPayload.jobs[0].has_error, true)
    assert.equal(Object.hasOwn(cliPayload.jobs[0], 'preview'), false)
    assert.equal(Object.hasOwn(cliPayload.jobs[0], 'request_json'), false)

    const emptySecondDrain = await daemonRequest(daemon.url, token, 'POST', '/replay/drain', agentA)
    assert.deepEqual(emptySecondDrain.jobs, [])

    await shutdownDaemon(daemon)
    daemon = await startTsDaemon(homeDir)
    const restartedToken = readControlToken(homeDir)
    const emptyAfterRestart = await daemonRequest(daemon.url, restartedToken, 'POST', '/replay/drain', agentA)
    assert.deepEqual(emptyAfterRestart.jobs, [])

    const fullJob = await daemonRequest(
      daemon.url,
      restartedToken,
      'GET',
      `/jobs/${encodeURIComponent(jobA)}`
    )
    assert.equal(fullJob.job_id, jobA)
    assert.equal(fullJob.status, 'canceled')
    assert.equal(fullJob.error_json.reason.detail.length, 2_000)
    assert.equal(Object.hasOwn(fullJob, 'agent_kind'), false)
    assert.equal(Object.hasOwn(fullJob, 'agent_session_id'), false)

    const otherAgent = await daemonRequest(daemon.url, restartedToken, 'POST', '/replay/drain', agentB)
    assert.deepEqual(otherAgent.jobs.map((job) => job.job_id), [jobB])
    assert.equal(otherAgent.jobs.some((job) => job.job_id === unaddressedJob), false)
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('daemon startup reconciles an expired running lease before becoming ready', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-startup-recovery-')
  let daemon = await startTsDaemon(homeDir)
  const jobId = randomUUID()
  try {
    const token = readControlToken(homeDir)
    await daemonRequest(daemon.url, token, 'POST', '/control/browser-runtime/quiesce')
    await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: randomUUID(),
      job_id: jobId,
      request_json: { malformed: true },
    })
    await shutdownDaemon(daemon)

    const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
    try {
      database.prepare(
        `UPDATE jobs
         SET status = 'running', claim_token = ?, claim_expires_at = ?, updated_at = ?
         WHERE job_id = ?`
      ).run(`stale-${randomUUID()}`, 1, new Date(0).toISOString(), jobId)
    } finally {
      database.close()
    }

    daemon = await startTsDaemon(homeDir)
    const restartedToken = readControlToken(homeDir)
    const recovered = await daemonRequest(
      daemon.url,
      restartedToken,
      'GET',
      `/jobs/${encodeURIComponent(jobId)}`
    )
    assert.equal(recovered.status, 'queued')
    const recoveredDatabase = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      const row = recoveredDatabase.prepare(
        'SELECT status, claim_expires_at FROM jobs WHERE job_id = ?'
      ).get(jobId)
      assert.equal(row.status, 'queued')
      assert.equal(row.claim_expires_at, null)
    } finally {
      recoveredDatabase.close()
    }
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('replay migration initializes durable outcome revisions and preserves an existing receipt', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-replay-migration-')
  let daemon = await startTsDaemon(homeDir)
  const recipient = { agent_kind: 'codex', agent_session_id: `migration-${randomUUID()}` }
  const replayableJobId = randomUUID()
  const alreadyReportedJobId = randomUUID()
  const activeWaitingJobId = randomUUID()
  const activeWaitingReportedJobId = randomUUID()
  try {
    const token = readControlToken(homeDir)
    await daemonRequest(daemon.url, token, 'POST', '/control/browser-runtime/quiesce')
    for (const jobId of [replayableJobId, alreadyReportedJobId]) {
      await daemonRequest(daemon.url, token, 'POST', '/jobs', {
        provider: 'chatgpt',
        action: managedPlaywrightJobAction,
        execution_backend: 'playwright',
        profile_id: randomUUID(),
        job_id: jobId,
        ...recipient,
        request_json: { malformed: true },
      })
      await daemonRequest(daemon.url, token, 'POST', `/jobs/${encodeURIComponent(jobId)}/cancel`)
    }
    for (const jobId of [activeWaitingJobId, activeWaitingReportedJobId]) {
      await daemonRequest(daemon.url, token, 'POST', '/jobs', {
        provider: 'chatgpt',
        action: managedPlaywrightJobAction,
        execution_backend: 'playwright',
        profile_id: randomUUID(),
        job_id: jobId,
        ...recipient,
        request_json: { malformed: true },
      })
    }
    await shutdownDaemon(daemon)

    const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
    try {
      database.exec('ALTER TABLE jobs ADD COLUMN replay_reported_job_updated_at TEXT')
      database.prepare(
        `UPDATE jobs
         SET outcome_revision = 0, reported_outcome_revision = NULL,
             replay_reported_at = NULL, replay_reported_job_updated_at = NULL
         WHERE job_id = ?`
      ).run(replayableJobId)
      database.prepare(
        `UPDATE jobs
         SET outcome_revision = 0, reported_outcome_revision = NULL,
             replay_reported_at = updated_at, replay_reported_job_updated_at = updated_at
         WHERE job_id = ?`
      ).run(alreadyReportedJobId)
      database.prepare(
        `UPDATE jobs
         SET status = 'waiting_for_user', blocker_json = ?, claim_expires_at = ?,
             outcome_revision = 0, reported_outcome_revision = NULL,
             replay_reported_at = NULL, replay_reported_job_updated_at = NULL
         WHERE job_id = ?`
      ).run(
        JSON.stringify({ code: 'legacy_active_waiting' }),
        Date.now() + 60_000,
        activeWaitingJobId
      )
      database.prepare(
        `UPDATE jobs
         SET status = 'waiting_for_user', blocker_json = ?, claim_expires_at = ?,
             outcome_revision = 0, reported_outcome_revision = NULL,
             replay_reported_at = updated_at, replay_reported_job_updated_at = updated_at
         WHERE job_id = ?`
      ).run(
        JSON.stringify({ code: 'legacy_active_waiting_reported' }),
        Date.now() + 60_000,
        activeWaitingReportedJobId
      )
    } finally {
      database.close()
    }

    daemon = await startTsDaemon(homeDir)
    const restartedToken = readControlToken(homeDir)
    const replay = await daemonRequest(daemon.url, restartedToken, 'POST', '/replay/drain', recipient)
    assert.deepEqual(replay.jobs.map((job) => job.job_id), [replayableJobId])
    assert.deepEqual((await daemonRequest(daemon.url, restartedToken, 'POST', '/replay/drain', recipient)).jobs, [])
    const runtime = await importCli()
    const migratedActiveReceipt = await runtime.markDaemonJobReported({
      homeDir,
      daemonUrl: daemon.url,
      jobId: activeWaitingJobId,
      agentKind: recipient.agent_kind,
      agentSessionId: recipient.agent_session_id,
    })
    assert.equal(migratedActiveReceipt.reported, true)
    const migratedExistingReceipt = await runtime.markDaemonJobReported({
      homeDir,
      daemonUrl: daemon.url,
      jobId: activeWaitingReportedJobId,
      agentKind: recipient.agent_kind,
      agentSessionId: recipient.agent_session_id,
    })
    assert.equal(migratedExistingReceipt.reported, false)
    const migratedDatabase = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      const rows = migratedDatabase.prepare(
        `SELECT job_id, outcome_revision, reported_outcome_revision
         FROM jobs
         WHERE job_id IN (?, ?)
         ORDER BY job_id`
      ).all(activeWaitingJobId, activeWaitingReportedJobId)
      assert.equal(rows.every((row) => row.outcome_revision === 1), true)
      assert.equal(rows.every((row) => row.reported_outcome_revision === 1), true)
    } finally {
      migratedDatabase.close()
    }
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('SQLite preserves exact provider Project and conversation mappings across store restart', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-provider-mappings-')
  const { JobStore } = await import(`${pathToFileURL(path.join(cliDir, 'dist/src/daemon/job-store.js')).href}?test=${randomUUID()}`)
  let store = await JobStore.open(homeDir)
  try {
    const job = store.createJob({
      provider: 'claude',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: 'profile-mapping',
      request_json: {
        protocol: 'tokenless.playwright.job.v3',
        provider: 'claude',
        target: { kind: 'provider_home', url: 'https://claude.ai/new' },
        taskId: 'task-mapping',
        browserVisibility: 'headed',
        actions: [],
      },
    })
    store.upsertProviderProject({
      provider: 'claude',
      profile_id: 'profile-mapping',
      resource_id: 'project-resource',
      name: 'TOKENLESS_E2E_PROJECT_MAPPING',
      canonical_url: 'https://claude.ai/project/project-resource',
      visible_proof: 'native-project-url-name-and-composer-visible',
      job_id: job.job_id,
      created: true,
    })
    store.upsertProviderConversation({
      provider: 'claude',
      profile_id: 'profile-mapping',
      project_resource_id: 'project-resource',
      task_id: 'task-mapping',
      canonical_url: 'https://claude.ai/project/project-resource/chat/conversation-resource',
      job_id: job.job_id,
    })
    store.upsertProviderTaskConversation({
      provider: 'claude',
      profile_id: 'profile-mapping',
      task_id: 'task-mapping',
      canonical_url: 'https://claude.ai/project/project-resource/chat/conversation-resource',
      job_id: job.job_id,
    })
    const e2eJob = store.createJob({
      provider: 'claude',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: 'profile-mapping',
      job_id: `tlp_e2e-run-${randomUUID()}`,
      request_json: {
        protocol: 'tokenless.playwright.job.v3',
        provider: 'claude',
        target: { kind: 'provider_home', url: 'https://claude.ai/new' },
        taskId: 'task-e2e-isolation',
        browserVisibility: 'headed',
        actions: [],
      },
    })
    const isolatedClaim = store.claimNextJob(
      {
        action: managedPlaywrightJobAction,
        job_id_prefix: 'tlp_e2e-run-',
      },
      'playwright',
      'profile-mapping',
    )
    assert.equal(isolatedClaim.job_id, e2eJob.job_id)
    assert.equal(store.getJob(job.job_id).status, 'queued')
    store.close()
    store = await JobStore.open(homeDir)

    const project = store.resolveProviderMapping({
      provider: 'claude',
      profile_id: 'profile-mapping',
      project_name: 'TOKENLESS_E2E_PROJECT_MAPPING',
      task_id: 'task-mapping',
    })
    assert.equal(project.project.resource_id, 'project-resource')
    assert.equal(project.conversation.task_id, 'task-mapping')
    const conversation = store.resolveProviderTaskConversation({
      provider: 'claude',
      profile_id: 'profile-mapping',
      task_id: 'task-mapping',
    })
    assert.equal(
      conversation.canonical_url,
      'https://claude.ai/project/project-resource/chat/conversation-resource',
    )
  } finally {
    store.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('built Playwright validators enforce the current internal schema IDs', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const playwright = await importPlaywright()
  const runtime = await importCli()
  const created = playwright.createManagedPlaywrightJobRequest({
    provider: 'qwen',
    target: { kind: 'provider_home', url: 'https://chat.qwen.ai/' },
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
  assert.equal(created.protocol, runtime.MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID)
  assert.equal(created.protocol, runtime.MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V4)
  assert.match(created.pageRef, /^page:[0-9a-f-]{36}$/u)
  assert.notEqual(created.pageRef, created.taskId)

  const explicitPageRef = playwright.createManagedPlaywrightJobRequest({
    provider: 'qwen',
    pageRef: 'page:explicit:qwen',
    actions: [{ action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })
  assert.equal(explicitPageRef.pageRef, 'page:explicit:qwen')

  const jobScopedPageRef = playwright.createManagedPlaywrightJobRequest({
    provider: 'qwen',
    pageRef: null,
    actions: [{ action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })
  assert.equal(jobScopedPageRef.pageRef, null)
  assert.throws(
    () => playwright.createManagedPlaywrightJobRequest({
      provider: 'qwen',
      pageRef: 'invalid\npage-ref',
      actions: [{ action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    }),
    (error) => error.code === 'invalid_playwright_job_page_ref',
  )
  assert.equal(created.provider, 'qwen')
  assert.equal(created.target.url, 'https://chat.qwen.ai/')
  assert.equal(created.capabilityRoute, null)
  assert.equal(created.userHandoff, false)
  assert.equal(created.actions[0].provider, 'qwen')
  assert.equal(created.actions[0].protocol, runtime.VISIBLE_ACTION_SCHEMA_ID)
  assert.equal(created.actions[0].protocol, runtime.VISIBLE_ACTION_SCHEMA_ID_V3)

  const forcedReplacement = playwright.createManagedPlaywrightJobRequest({
    provider: 'qwen',
    target: { kind: 'provider_home', url: 'https://chat.qwen.ai/' },
    taskId: 'v3-explicit-tab-replacement',
    pagePolicy: 'replace',
    browserVisibility: 'headless',
    actions: [
      {
        requestId: 'v3-explicit-tab-replacement-action',
        action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
        payload: {},
      },
    ],
  })
  assert.equal(forcedReplacement.pagePolicy, 'replace')
  assert.equal(playwright.validateManagedPlaywrightJobRequest(forcedReplacement).pagePolicy, 'replace')
  const explicitUserHandoff = playwright.createManagedPlaywrightJobRequest({
    provider: 'qwen',
    userHandoff: true,
    actions: [{ action: playwright.VISIBLE_ACTIONS.NAVIGATION_CHECK, payload: {} }],
  })
  assert.equal(explicitUserHandoff.userHandoff, true)
  assert.throws(
    () => playwright.createManagedPlaywrightJobRequest({
      provider: 'qwen',
      userHandoff: 'foreground',
      actions: [{ action: playwright.VISIBLE_ACTIONS.NAVIGATION_CHECK, payload: {} }],
    }),
    (error) => {
      assert.equal(error.code, 'invalid_playwright_job_user_handoff')
      return true
    },
  )
  assert.throws(
    () => playwright.createManagedPlaywrightJobRequest({
      provider: 'qwen',
      pagePolicy: 'reuse-any-tab',
      actions: [{ action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    }),
    (error) => {
      assert.equal(error.code, 'invalid_managed_page_policy')
      return true
    },
  )

  const v3Validated = playwright.validateManagedPlaywrightJobRequest({
    protocol: runtime.MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3,
    provider: 'qwen',
    target: { kind: 'provider_home', url: 'https://chat.qwen.ai/' },
    taskId: 'v3-explicit-qwen-provider',
    browserVisibility: 'headless',
    actions: [
      {
        protocol: runtime.VISIBLE_ACTION_SCHEMA_ID_V3,
        requestId: 'v3-explicit-action',
        provider: 'qwen',
        action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
        payload: {},
      },
    ],
  })
  assert.equal(v3Validated.provider, 'qwen')
  assert.equal(v3Validated.capabilityRoute, null)
  assert.equal(v3Validated.userHandoff, false)
  assert.equal(v3Validated.actions[0].provider, 'qwen')

  assert.equal(v3Validated.protocol, runtime.MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V4)
  assert.equal(v3Validated.pageRef, null)
  assert.throws(
    () => playwright.validateManagedPlaywrightJobRequest({
      protocol: runtime.MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3,
      provider: 'qwen',
      target: { kind: 'provider_home', url: 'https://chat.qwen.ai/' },
      taskId: 'legacy-v3-with-page-ref',
      pageRef: 'page:not-valid-in-v3',
      browserVisibility: 'headless',
      actions: [{
        protocol: runtime.VISIBLE_ACTION_SCHEMA_ID_V3,
        requestId: 'legacy-v3-page-ref-action',
        provider: 'qwen',
        action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
        payload: {},
      }],
    }),
    (error) => error.code === 'invalid_playwright_job_request',
  )
  const routeDecision = playwright.resolveTaskCapabilityRoute({
    requirements: [playwright.TASK_CAPABILITIES.CONVERSATION_CHAT],
    candidates: [{ provider: 'chatgpt', runtimeEligibility: 'unchecked' }],
  })
  assert.equal(routeDecision.ok, true)
  const rankedRoutes = playwright.resolveTaskCapabilityRoutes({
    requirements: [playwright.TASK_CAPABILITIES.CONVERSATION_CHAT],
    candidates: [
      { provider: 'qwen', runtimeEligibility: 'eligible', preferenceRank: 0 },
      { provider: 'chatgpt', runtimeEligibility: 'eligible', preferenceRank: 1 },
    ],
  })
  assert.equal(rankedRoutes.ok, true)
  assert.deepEqual(rankedRoutes.routes.map((route) => route.provider), ['chatgpt'])
  assert.deepEqual(
    rankedRoutes.evaluated.map((evaluation) => [evaluation.provider, evaluation.rank, evaluation.support]),
    [['qwen', null, null], ['chatgpt', 1, 'supported']],
  )
  const completeSetRoutes = playwright.resolveTaskCapabilityRoutes({
    requirements: [
      playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
      playwright.TASK_CAPABILITIES.FILE_UPLOAD,
    ],
    candidates: [
      { provider: 'gemini', runtimeEligibility: 'eligible', preferenceRank: 0 },
      { provider: 'chatgpt', runtimeEligibility: 'eligible', preferenceRank: 1 },
    ],
  })
  assert.equal(completeSetRoutes.ok, true)
  assert.deepEqual(completeSetRoutes.routes.map((route) => route.provider), ['chatgpt', 'gemini'])
  assert.deepEqual(completeSetRoutes.evaluated[0].missingCapabilities, [])
  const routed = playwright.createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    target: { kind: 'provider_home', url: 'https://chatgpt.com/' },
    taskId: 'v3-chatgpt-capability-route',
    capabilityRoute: routeDecision.route,
    browserVisibility: 'headless',
    actions: [
      {
        requestId: 'v3-routed-action',
        action: playwright.VISIBLE_ACTIONS.AUTH_STATUS,
        payload: {},
      },
    ],
  })
  assert.deepEqual(routed.capabilityRoute, routeDecision.route)
  assert.equal(routed.context.schema, 'tokenless.context-envelope.v1')
  assert.deepEqual(routed.context.requirements, [playwright.TASK_CAPABILITIES.CONVERSATION_CHAT])

  assert.throws(
    () => playwright.validateManagedPlaywrightJobRequest({
      ...routed,
      capabilityRoute: {
        ...routed.capabilityRoute,
        evidence: ['invented-evidence'],
      },
    }),
    (error) => {
      assert.equal(error.code, 'invalid_playwright_job_capability_route')
      return true
    }
  )

  const chatgptPortableRoute = playwright.resolveTaskCapabilityRoute({
    requirements: [
      playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
      playwright.TASK_CAPABILITIES.FILE_UPLOAD,
    ],
    candidates: [{ provider: 'chatgpt', runtimeEligibility: 'eligible' }],
  })
  assert.equal(chatgptPortableRoute.ok, true)
  const chatgptChatRoute = playwright.resolveTaskCapabilityRoute({
    requirements: [playwright.TASK_CAPABILITIES.CONVERSATION_CHAT],
    candidates: [{ provider: 'chatgpt', runtimeEligibility: 'eligible' }],
  })
  assert.equal(chatgptChatRoute.ok, true)
  assert.throws(
    () => playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      capabilityRoute: chatgptChatRoute.route,
      actions: [{
        requestId: 'under-declared-file-action',
        action: playwright.VISIBLE_ACTIONS.FILE_UPLOAD,
        payload: {
          attachments: [{
            protocol: runtime.VISIBLE_ATTACHMENT_SCHEMA_ID,
            bundleId: 'under-declared-bundle',
            attachmentId: 'under-declared-attachment',
            name: 'evidence.txt',
            type: 'text/plain',
            size: 8,
            sha256: 'a'.repeat(64),
          }],
        },
      }],
    }),
    (error) => {
      assert.equal(error.code, 'invalid_playwright_job_capability_requirements')
      assert.deepEqual(error.details.missing, [playwright.TASK_CAPABILITIES.FILE_UPLOAD])
      return true
    },
  )
  assert.throws(
    () => playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      capabilityRoute: chatgptPortableRoute.route,
      actions: [{
        requestId: 'semantic-image-action',
        action: playwright.VISIBLE_ACTIONS.FILE_UPLOAD,
        payload: {
          attachments: [{
            protocol: runtime.VISIBLE_ATTACHMENT_SCHEMA_ID,
            bundleId: 'semantic-image-bundle',
            attachmentId: 'semantic-image-attachment',
            name: 'evidence.png',
            type: 'image/png',
            size: 8,
            sha256: 'b'.repeat(64),
          }],
        },
      }],
    }),
    (error) => {
      assert.equal(error.code, 'invalid_playwright_job_capability_requirements')
      assert.deepEqual(error.details.missing, [playwright.TASK_CAPABILITIES.IMAGE_INPUT])
      return true
    },
  )

  assert.throws(
    () => playwright.validateManagedPlaywrightJobRequest({
      protocol: runtime.MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3,
      provider: 'future-ai',
      target: { kind: 'provider_home', url: 'https://future.example/' },
      taskId: 'registry-rejects-unknown-provider',
      browserVisibility: 'headless',
      actions: [
        {
          protocol: runtime.VISIBLE_ACTION_SCHEMA_ID_V3,
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

test('SQLite atomically preserves provider fallback attempts under one durable job id', async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-provider-fallback-store-')
  const { JobStore } = await import(`${pathToFileURL(path.join(cliDir, 'dist/src/daemon/job-store.js')).href}?test=${randomUUID()}`)
  const playwright = await importPlaywright()
  let store = await JobStore.open(homeDir)
  try {
    const chatgptRoute = playwright.resolveTaskCapabilityRoute({
      requirements: [playwright.TASK_CAPABILITIES.CONVERSATION_CHAT],
      candidates: [{ provider: 'chatgpt', runtimeEligibility: 'eligible' }],
    })
    const claudeRoute = playwright.resolveTaskCapabilityRoute({
      requirements: [playwright.TASK_CAPABILITIES.CONVERSATION_CHAT],
      candidates: [{ provider: 'claude', runtimeEligibility: 'eligible' }],
    })
    assert.equal(chatgptRoute.ok, true)
    assert.equal(claudeRoute.ok, true)
    const alternative = playwright.createManagedPlaywrightJobRequest({
      provider: 'claude',
      taskId: 'fallback-store-task',
      capabilityRoute: claudeRoute.route,
      actions: [{ requestId: 'fallback-prompt', action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'fallback' } }],
    })
    const baseRequest = playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      taskId: 'fallback-store-task',
      pageRef: 'page:fallback-store',
      capabilityRoute: chatgptRoute.route,
      fallback: {
        protocol: 'tokenless.provider-fallback.v1',
        mode: 'automatic',
        replay: 'from_start',
        alternatives: [{
          provider: alternative.provider,
          target: alternative.target,
          capabilityRoute: alternative.capabilityRoute,
        }],
      },
      actions: [{ requestId: 'primary-prompt', action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'fallback' } }],
    })
    const request = playwright.validateManagedPlaywrightJobRequest({
      ...baseRequest,
      context: {
        ...baseRequest.context,
        instructions: [{ role: 'developer', content: 'fallback', provenance: 'upstream_agent' }],
        outputContract: { language: 'en', format: 'plain_text' },
        constraints: { tokenBudget: 64, deadline: '2030-01-01T00:00:00.000Z' },
        upstream: { agentKind: 'codex', sessionId: 'fallback-session', state: { phase: 'portable' } },
      },
    })
    const created = store.createJob({
      provider: request.provider,
      action: managedPlaywrightJobAction,
      request_json: request,
      profile_id: 'fallback-profile',
    })
    const claimed = store.claimJob(created.job_id, created.claim_token)
    store.markRunning(claimed.job_id, claimed.claim_token)
    const fallbackRequest = playwright.validateManagedPlaywrightJobRequest({
      ...request,
      provider: alternative.provider,
      target: alternative.target,
      capabilityRoute: alternative.capabilityRoute,
      fallback: null,
      context: request.context,
      actions: request.actions.map((action) => ({ ...action, provider: alternative.provider })),
    })
    const queued = store.fallbackJob({
      job_id: claimed.job_id,
      claim_token: claimed.claim_token,
      provider: 'claude',
      request_json: fallbackRequest,
      blocker_json: { blocker: { code: 'visible_cloudflare_turnstile' } },
    })
    assert.equal(queued.job_id, created.job_id)
    assert.equal(queued.provider, 'claude')
    assert.equal(queued.status, 'queued')
    assert.equal(queued.provider_attempts_json.length, 2)
    assert.equal(queued.provider_attempts_json[0].status, 'blocked')
    assert.equal(queued.provider_attempts_json[0].blocker.blocker.code, 'visible_cloudflare_turnstile')
    assert.deepEqual(queued.request_json.context, request.context)
    const fallbackClaim = store.claimJob(queued.job_id, queued.claim_token)
    store.markRunning(fallbackClaim.job_id, fallbackClaim.claim_token)
    assert.equal(queued.request_json.pageRef, request.pageRef)
    store.completeJob(fallbackClaim.job_id, fallbackClaim.claim_token, { result_json: { provider: 'claude' } })
    store.close()
    store = await JobStore.open(homeDir)
    const completed = store.getJob(created.job_id)
    assert.equal(completed.status, 'succeeded')
    assert.deepEqual(completed.request_json.context, request.context)
    assert.deepEqual(completed.provider_attempts_json.map((attempt) => [attempt.provider, attempt.status]), [
      ['chatgpt', 'blocked'],
      ['claude', 'succeeded'],
    ])
    assert.equal(completed.request_json.pageRef, request.pageRef)
  } finally {
    store.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
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
    assert.equal(Object.hasOwn(running, 'protocol'), false)
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
    const playwright = await importPlaywright()
    const roundtripPageRef = `page:http-roundtrip:${randomUUID()}`
    const roundtripRequest = playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      pageRef: roundtripPageRef,
      actions: [{ action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })
    const roundtripJobId = randomUUID()
    const roundtripCreated = await daemonRequest(daemon.url, token, 'POST', '/jobs', {
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      execution_backend: 'playwright',
      profile_id: profileId,
      job_id: roundtripJobId,
      request_json: roundtripRequest,
    })
    assert.equal(roundtripCreated.request_json.pageRef, roundtripPageRef)
    const roundtripRead = await daemonRequest(
      daemon.url,
      token,
      'GET',
      `/jobs/${encodeURIComponent(roundtripJobId)}`,
    )
    assert.equal(roundtripRead.request_json.pageRef, roundtripPageRef)
    await daemonRequest(daemon.url, token, 'POST', `/jobs/${encodeURIComponent(roundtripJobId)}/cancel`, {
      reason: { code: 'test_roundtrip_complete' },
    })

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

test('SQLite durably and idempotently attributes measured visible output to its triggering job', async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-output-savings-store-')
  const { JobStore } = await import(`${pathToFileURL(path.join(cliDir, 'dist/src/daemon/job-store.js')).href}?test=${randomUUID()}`)
  let store = await JobStore.open(homeDir)
  try {
    const created = store.createJob({
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      request_json: { taskId: 'savings-task' },
      profile_id: 'savings-profile',
    })
    const claimed = store.claimJob(created.job_id, created.claim_token)
    store.markRunning(claimed.job_id, claimed.claim_token)
    const result = {
      protocol: 'tokenless.playwright.job.v3',
      provider: 'chatgpt',
      responses: [{
        protocol: 'tokenless.playwright.visible-action.v3',
        requestId: 'savings-response',
        provider: 'chatgpt',
        action: 'response.read',
        ok: true,
        result: {
          text: 'hello world',
          citations: [],
          visibleProof: 'visible-answer-read',
          outputSavings: {
            schema: 'tokenless.output-savings-measurement.v1',
            state: 'measured',
            basis: 'visible_assistant_text',
            estimator: 'o200k_base',
            estimatorRevision: 'tiktoken-o200k_base-1.0.22',
            estimatedOutputTokens: 2,
            visibleCharacters: 11,
            sourceTextSha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
            measuredAt: '2099-08-04T00:00:00.000Z',
          },
        },
        error: null,
      }],
    }
    store.completeJob(claimed.job_id, claimed.claim_token, { result_json: result })
    store.reconcileOutputSavings()
    store.reconcileOutputSavings()
    assert.deepEqual(store.outputSavingsSummary(), {
      estimated_output_tokens: 2,
      visible_characters: 11,
      response_count: 1,
      job_count: 1,
      first_measured_at: '2099-08-04T00:00:00.000Z',
      last_measured_at: '2099-08-04T00:00:00.000Z',
    })
    assert.deepEqual(store.outputSavingsForJob(created.job_id), [{
      job_id: created.job_id,
      response_request_id: 'savings-response',
      estimated_output_tokens: 2,
      visible_characters: 11,
      estimator: 'o200k_base',
      estimator_revision: 'tiktoken-o200k_base-1.0.22',
      basis: 'visible_assistant_text',
      source_text_sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      measured_at: '2099-08-04T00:00:00.000Z',
    }])
    store.close()
    store = await JobStore.open(homeDir)
    assert.equal(store.outputSavingsSummary().estimated_output_tokens, 2)
    assert.deepEqual(store.clearOutputSavings(), { cleared: 1 })
    store.reconcileOutputSavings()
    assert.deepEqual(store.outputSavingsSummary(), {
      estimated_output_tokens: 0,
      visible_characters: 0,
      response_count: 0,
      job_count: 0,
      first_measured_at: null,
      last_measured_at: null,
    })
    assert.equal(
      Object.hasOwn(store.getJob(created.job_id).result_json.responses[0].result, 'outputSavings'),
      false,
    )
  } finally {
    store.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('SQLite completes the provider job before durable output savings work is processed', async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-output-savings-handoff-')
  const { JobStore } = await import(`${pathToFileURL(path.join(cliDir, 'dist/src/daemon/job-store.js')).href}?test=${randomUUID()}`)
  let store = await JobStore.open(homeDir)
  try {
    const created = store.createJob({
      provider: 'chatgpt',
      action: managedPlaywrightJobAction,
      request_json: { taskId: 'savings-handoff-task' },
      profile_id: 'savings-profile',
    })
    const claimed = store.claimJob(created.job_id, created.claim_token)
    store.markRunning(claimed.job_id, claimed.claim_token)
    const result = {
      protocol: 'tokenless.playwright.job.v3',
      provider: 'chatgpt',
      responses: [{
        protocol: 'tokenless.playwright.visible-action.v3',
        requestId: 'savings-handoff-response',
        provider: 'chatgpt',
        action: 'response.read',
        ok: true,
        result: {
          text: 'hello world',
          citations: [],
          visibleProof: 'visible-answer-read',
        },
        error: null,
      }],
    }
    const completed = store.completeJob(claimed.job_id, claimed.claim_token, {
      result_json: result,
      output_savings_work: [{
        response_request_id: 'savings-handoff-response',
        source_text: 'hello world',
      }],
    })
    assert.equal(completed.status, 'succeeded')
    assert.deepEqual(completed.result_json, result)
    assert.equal(JSON.stringify(completed.result_json).includes('source_text'), false)
    assert.equal(store.outputSavingsSummary().estimated_output_tokens, 0)
    assert.equal(store.pendingOutputSavingsWorkCount(), 1)

    store.close()
    store = await JobStore.open(homeDir)
    const work = store.nextOutputSavingsWork(Date.now() + 10_000)
    assert.equal(work.job_id, created.job_id)
    assert.equal(work.response_request_id, 'savings-handoff-response')
    assert.equal(work.source_text, 'hello world')
  } finally {
    store.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon closes when the embedded managed Playwright scheduler exits fatally', {
  timeout: 30_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-embedded-scheduler-fatal-')
  createMalformedManagedProfileRegistry(homeDir)
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
      assert.equal(Object.hasOwn(ready, 'protocol'), false)
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
      challenge,
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

function createMalformedManagedProfileRegistry(homeDir) {
  const browserDir = path.join(homeDir, 'browser')
  const profilesRoot = path.join(browserDir, 'profiles')
  fs.mkdirSync(profilesRoot, { recursive: true, mode: 0o700 })
  const registryPath = path.join(browserDir, 'profiles.json')
  fs.writeFileSync(registryPath, '{}\n', { mode: 0o600 })
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
