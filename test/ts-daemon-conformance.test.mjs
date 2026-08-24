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
const tsDaemonEntry = path.join(cliDir, 'dist/src/bootstrap/daemon-entry.mjs')
const createdChildren = new Set()

test.after(async () => {
  await Promise.all([...createdChildren].map((child) => terminateChild(child)))
})

test('TS daemon rejects malformed managed jobs without launching a browser', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-embedded-scheduler-')
  const profile = await createReadyManagedProfile(homeDir)
  const daemon = await startTsDaemon(homeDir)
  try {
    await delay(1_500)
    assertProfileDirectoryEmpty(profile.directory)

    const token = readControlToken(homeDir)
    const jobId = randomUUID()
    const rejected = await fetch(`${daemon.url}/v1/private/jobs`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        provider: 'chatgpt',
        profile_id: profile.slug,
        job_id: jobId,
        request_json: { malformed: true },
      }),
    })
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json()).error.code, 'invalid_input')
    assertProfileDirectoryEmpty(profile.directory)
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
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
    const rejected = await fetch(`${daemon.url}/v1/private/jobs`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        provider: 'not-a-provider',
        profile_id: randomUUID(),
        job_id: randomUUID(),
        request_json: { malformed: true },
      }),
    })
    assert.equal(rejected.status, 400)
    const rejectedBody = await rejected.json()
    assert.equal(rejectedBody.error.code, 'invalid_input')
    assert.match(rejectedBody.error.message, /unsupported provider: not-a-provider/)
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('TS daemon rejects under-declared capability routes before job creation', {
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
    const rejected = await fetch(`${daemon.url}/v1/private/jobs`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        provider: 'chatgpt',
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
    const jobs = await daemonRequest(daemon.url, token, 'GET', '/v1/private/jobs?limit=10')
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
    const chatgptDirectImageDownload = playwright.resolveTaskCapabilityRoute({
      requirements: [
        playwright.TASK_CAPABILITIES.IMAGE_GENERATION,
        playwright.TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
      ],
      executionMode: 'direct',
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
    assert.equal(chatgptDirectImageDownload.ok, true)
    assert.equal(chatgptImageDownload.route.executionMode, 'browser')
    assert.equal(chatgptDirectImageDownload.route.executionMode, 'direct')
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
    const chatgptDirectValid = playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      target: { kind: 'provider_home', url: 'https://chatgpt.com/' },
      taskId: 'chatgpt-direct-image-contract-task',
      capabilityRoute: chatgptDirectImageDownload.route,
      executionMode: 'direct',
      providerBackend: 'g4f',
      browserVisibility: 'headless',
      actions: [
        { requestId: 'chatgpt-direct-prompt', action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: 'contract test' } },
        { requestId: 'chatgpt-direct-submit', action: playwright.VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} },
        { requestId: 'chatgpt-direct-read', action: playwright.VISIBLE_ACTIONS.RESPONSE_READ, payload: {} },
      ],
    })
    assert.equal(chatgptDirectValid.executionMode, 'direct')
    assert.equal(chatgptDirectValid.capabilityRoute.executionMode, 'direct')
    assert.throws(
      () => playwright.createManagedPlaywrightJobRequest({
        ...chatgptDirectValid,
        capabilityRoute: chatgptImageDownload.route,
      }),
      (error) => error.code === 'invalid_playwright_job_capability_route',
    )
    assert.throws(
      () => playwright.createManagedPlaywrightJobRequest({
        ...chatgptDirectValid,
        authContextId: 'caller-context',
      }),
      (error) => error.code === 'direct_auth_context_unsupported',
    )
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
      const rejected = await fetch(`${daemon.url}/v1/private/jobs`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          provider: entry.provider,
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
    assert.deepEqual(await daemonRequest(daemon.url, token, 'GET', '/v1/private/jobs?limit=10'), [])
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('SQLite completes current jobs and marks active jobs interrupted on reopen', async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-job-lifecycle-')
  const moduleUrl = pathToFileURL(path.join(cliDir, 'dist/server/src/jobs/store.js')).href + '?test=' + randomUUID()
  const { JobStore } = await import(moduleUrl)
  let store = await JobStore.open(homeDir)
  try {
    const created = store.createJob({
      provider: 'chatgpt',
      request_json: { taskId: 'fresh-lifecycle' },
      profile_id: 'fresh-profile',
    })
    const running = store.takeNextJob({}, 'fresh-profile')
    assert.ok(running)
    assert.equal(running.job_id, created.job_id)
    assert.equal(running.status, 'running')
    assert.equal(running.provider_attempts_json.at(-1).status, 'running')
    const completed = store.completeJob(running.job_id, { result_json: { ok: true } })
    assert.equal(completed.status, 'succeeded')

    const active = store.createJob({
      provider: 'chatgpt',
      request_json: { taskId: 'interrupted-lifecycle' },
      profile_id: 'fresh-profile',
    })
    const activeJobState = store.takeNextJob({}, 'fresh-profile')
    assert.ok(activeJobState)
    assert.equal(activeJobState.job_id, active.job_id)
    assert.equal(activeJobState.status, 'running')
    const waiting = store.markWaitingForUser(active.job_id, { code: 'user_input_required' })
    assert.equal(waiting.provider_attempts_json.at(-1).status, 'waiting_for_user')
    const resumed = store.markRunning(active.job_id)
    assert.equal(resumed.provider_attempts_json.at(-1).status, 'running')
    store.close()
    store = await JobStore.open(homeDir)
    const interrupted = store.getJob(active.job_id)
    assert.equal(interrupted.status, 'failed')
    assert.equal(interrupted.error_json.code, 'job_interrupted')
    assert.equal(interrupted.provider_attempts_json.at(-1).status, 'failed')

    const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      const tables = new Set(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table'",
      ).all().map((row) => String(row.name)))
      assert.deepEqual(
        [
          'output_savings_events', 'output_savings_work', 'output_savings_state', 'output_savings_cleared_events',
          'api_response_ledger', 'web_ai_v0_bindings', 'web_ai_v0_staged_attachments',
          'web_ai_v0_turns', 'web_ai_v0_request_cancellations', 'job_task_keys',
        ]
          .filter((table) => tables.has(table)),
        [],
      )
      const jobColumns = new Set(database.prepare('PRAGMA table_info(jobs)').all().map((row) => String(row.name)))
      assert.deepEqual(
        [
          'claim_token', 'claim_expires_at', 'checkpoint_json', 'resume_json', 'eligible_at',
          'agent_kind', 'agent_session_id', 'summary_idempotency_key', 'replay_reported_at',
          'outcome_revision', 'reported_outcome_revision', 'execution_backend', 'action',
          'summary_task_id', 'summary_project_name', 'summary_chat_name',
        ].filter((column) => jobColumns.has(column)),
        [],
      )
    } finally {
      database.close()
    }
  } finally {
    store?.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('SQLite preserves exact provider Project and conversation mappings across store restart', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-provider-mappings-')
  const { JobStore } = await import(`${pathToFileURL(path.join(cliDir, 'dist/server/src/jobs/store.js')).href}?test=${randomUUID()}`)
  let store = await JobStore.open(homeDir)
  try {
    const job = store.createJob({
      provider: 'claude',
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
    const isolatedJobState = store.takeNextJob(
      {
        job_id_prefix: 'tlp_e2e-run-',
      },
      'profile-mapping',
    )
    assert.equal(isolatedJobState.job_id, e2eJob.job_id)
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

test('SQLite preserves provider fallback attempts under one current job id', async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-provider-fallback-store-')
  const { JobStore } = await import(`${pathToFileURL(path.join(cliDir, 'dist/server/src/jobs/store.js')).href}?test=${randomUUID()}`)
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
      request_json: request,
      profile_id: 'fallback-profile',
    })
    const selectedJob = store.takeNextJob({}, 'fallback-profile')
    assert.ok(selectedJob)
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
      job_id: selectedJob.job_id,
      provider: 'claude',
      request_json: fallbackRequest,
      blocker_json: { blocker: { code: 'visible_cloudflare_turnstile' } },
    })
    assert.equal(queued.job_id, created.job_id)
    assert.equal(queued.provider, 'claude')
    assert.equal(queued.status, 'running')
    assert.equal(queued.provider_attempts_json.length, 2)
    assert.equal(queued.provider_attempts_json[0].status, 'blocked')
    assert.equal(queued.provider_attempts_json[0].blocker.blocker.code, 'visible_cloudflare_turnstile')
    assert.deepEqual(queued.request_json.context, request.context)
    assert.equal(queued.request_json.pageRef, request.pageRef)
    store.completeJob(queued.job_id, { result_json: { provider: 'claude' } })
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

test('TS daemon browser runtime control authenticates, quiesces queued work, and preserves job roundtrips', {
  timeout: 60_000,
}, async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-ts-browser-runtime-control-')
  const profileId = 'default'
  const daemon = await startTsDaemon(homeDir)
  try {
    const token = readControlToken(homeDir)

    const missingStatus = await fetch(`${daemon.url}/v1/private/control/browser-runtime/status`)
    assert.equal(missingStatus.status, 401)
    const missingStatusBody = await missingStatus.json()
    assert.equal(missingStatusBody.error.code, 'control_auth_missing')

    const rejectedQuiesce = await fetch(`${daemon.url}/v1/private/control/browser-runtime/quiesce`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(rejectedQuiesce.status, 403)
    const rejectedQuiesceBody = await rejectedQuiesce.json()
    assert.equal(rejectedQuiesceBody.error.code, 'control_auth_rejected')
    assert.equal(JSON.stringify(rejectedQuiesceBody).includes(token), false)

    const running = await daemonRequest(daemon.url, token, 'GET', '/v1/private/control/browser-runtime/status')
    assert.equal(Object.hasOwn(running, 'protocol'), false)
    assert.equal(running.status, 'running')
    assert.equal(running.pid, daemon.child.pid)
    assert.equal(running.activeProfileCount, 0)
    assert.equal(running.activeJobCount, 0)

    const playwright = await importPlaywright()
    const pausedJobId = randomUUID()
    const pausedRequest = playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      actions: [{ action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })
    await daemonRequest(daemon.url, token, 'POST', '/v1/private/jobs', {
      provider: 'chatgpt',
      profile_id: profileId,
      job_id: pausedJobId,
      request_json: pausedRequest,
    })
    const quiesced = await daemonRequest(daemon.url, token, 'POST', '/v1/private/control/browser-runtime/quiesce')
    assert.equal(quiesced.status, 'quiesced')
    assert.equal(quiesced.activeProfileCount, 0)
    assert.equal(quiesced.activeJobCount, 0)

    await delay(1_500)
    const stillQueued = await daemonRequest(daemon.url, token, 'GET', `/v1/private/jobs/${encodeURIComponent(pausedJobId)}`)
    assert.equal(stillQueued.status, 'queued')
    const roundtripPageRef = `page:http-roundtrip:${randomUUID()}`
    const roundtripRequest = playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      pageRef: roundtripPageRef,
      actions: [{ action: playwright.VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
    })
    const roundtripJobId = randomUUID()
    const roundtripCreated = await daemonRequest(daemon.url, token, 'POST', '/v1/private/jobs', {
      provider: 'chatgpt',
      profile_id: profileId,
      job_id: roundtripJobId,
      request_json: roundtripRequest,
    })
    assert.equal(roundtripCreated.request_json.pageRef, roundtripPageRef)
    const roundtripRead = await daemonRequest(
      daemon.url,
      token,
      'GET',
      `/v1/private/jobs/${encodeURIComponent(roundtripJobId)}`,
    )
    assert.equal(roundtripRead.request_json.pageRef, roundtripPageRef)
    await daemonRequest(daemon.url, token, 'POST', `/v1/private/jobs/${encodeURIComponent(roundtripJobId)}/cancel`, {
      reason: { code: 'test_roundtrip_complete' },
    })

    await daemonRequest(daemon.url, token, 'POST', `/v1/private/jobs/${encodeURIComponent(pausedJobId)}/cancel`, {
      reason: { code: 'test_quiesce_complete' },
    })
  } finally {
    await shutdownDaemon(daemon).catch(() => undefined)
    await terminateChildrenForHome(homeDir)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('SQLite attributes measured visible output to its triggering job', async () => {
  requireBuiltArtifacts()
  const homeDir = tempHome('tokenless-output-savings-store-')
  const { JobStore } = await import(`${pathToFileURL(path.join(cliDir, 'dist/server/src/jobs/store.js')).href}?test=${randomUUID()}`)
  let store = await JobStore.open(homeDir)
  try {
    const created = store.createJob({
      provider: 'chatgpt',
      request_json: { taskId: 'savings-task' },
      profile_id: 'savings-profile',
    })
    const selectedJob = store.takeNextJob({}, 'savings-profile')
    assert.ok(selectedJob)
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
    store.completeJob(selectedJob.job_id, { result_json: result })
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
    assert.equal(
      Object.hasOwn(store.getJob(created.job_id).result_json.responses[0].result, 'outputSavings'),
      false,
    )
    store.close()
    store = await JobStore.open(homeDir)
    assert.equal(store.outputSavingsSummary().estimated_output_tokens, 0)
    assert.deepEqual(store.clearOutputSavings(), { cleared: 0 })
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
  const body = await daemonRequest(daemon.url, token, 'POST', '/v1/private/control/shutdown')
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
  return await import(`${pathToFileURL(path.join(cliDir, 'dist/server/src/browser/index.js')).href}?test=${Date.now()}-${Math.random()}`)
}

function runCli(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

async function createReadyManagedProfile(homeDir, options = {}) {
  const profileSlug = options.slug ?? options.profileId ?? 'default'
  const registry = new (await importPlaywright()).ManagedProfileRegistry(homeDir)
  return await registry.addProfile({ slug: profileSlug, setDefault: true })
}

function assertProfileDirectoryEmpty(profileDir) {
  assert.deepEqual(fs.readdirSync(profileDir).sort(), [])
}

async function waitForDaemonJobStatus(daemonUrl, token, jobId, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await daemonRequest(daemonUrl, token, 'GET', `/v1/private/jobs/${encodeURIComponent(jobId)}`)
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
    latest = await daemonRequest(daemonUrl, token, 'GET', `/v1/private/jobs/${encodeURIComponent(jobId)}`)
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
