import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('browser extension manifest is domain limited', () => {
  const manifest = readJson('packages/extension/extension/manifest.json')
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.name, 'Tokenless')
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions)
  assert.ok(!manifest.permissions.includes('alarms'))
  assert.ok(manifest.permissions.includes('nativeMessaging'))
  assert.ok(!manifest.permissions.includes('cookies'))
  assert.ok(!manifest.permissions.includes('history'))
  assert.ok(manifest.host_permissions.every((pattern) => pattern.startsWith('https://')))
})

test('extension routes mapped conversations by exact target URL before generic provider reuse', () => {
  const serviceWorker = fs.readFileSync(path.join(root, 'packages/extension/extension/background/service-worker.ts'), 'utf8')
  const targetBranch = serviceWorker.indexOf('if (targetUrl)')
  const genericReuse = serviceWorker.indexOf('const visibleCandidate')

  assert.ok(targetBranch > 0, 'service worker should branch on explicit targetUrl')
  assert.ok(genericReuse > 0, 'service worker should retain generic reuse fallback')
  assert.ok(targetBranch < genericReuse, 'explicit targetUrl routing must happen before generic provider reuse')
  assert.match(serviceWorker, /const exactCandidate = candidates\.find/)
  assert.match(serviceWorker, /return chrome\.tabs\.create\(\{ url: requestedUrl, active: true \}\)/)

  const contentScript = fs.readFileSync(path.join(root, 'packages/extension/extension/content/provider-content.ts'), 'utf8')
  assert.match(contentScript, /url: location\.href/)
})

test('extension validates provider landing before waiting on provider actions', () => {
  const serviceWorker = fs.readFileSync(path.join(root, 'packages/extension/extension/background/service-worker.ts'), 'utf8')
  const contentScript = fs.readFileSync(path.join(root, 'packages/extension/extension/content/provider-content.ts'), 'utf8')

  assert.match(serviceWorker, /const PROVIDER_LANDING_TIMEOUT_MS = 8000/)
  assert.match(serviceWorker, /waitForProviderTabLoaded\(tab\.id, provider\)/)
  assert.match(serviceWorker, /validateProviderLanding\(landedTab\.id, provider, request\)/)
  assert.match(serviceWorker, /invalid_target_url/)
  assert.match(serviceWorker, /target_url_provider_mismatch/)
  assert.match(serviceWorker, /parsed\.protocol !== 'https:' \|\| !provider\.hosts\.includes\(parsed\.hostname\.toLowerCase\(\)\)/)
  assert.doesNotMatch(serviceWorker, /provider_landing_failed/)

  assert.match(contentScript, /tokenless\.bridge\.validate_landing/)
  assert.match(contentScript, /request\.landingTimeoutMs \?\? 5000/)
  assert.match(contentScript, /provider_landing_unavailable/)
  assert.match(contentScript, /providerForMessage/)
  assert.match(contentScript, /chatSurfaceStatus/)
  assert.match(contentScript, /provider\.id === 'chatgpt'/)
  assert.match(contentScript, /Boolean\(visibleComposer && visibleSubmit\)/)
})

test('background maintains a native daemon bridge and runs pushed jobs through the visible provider bridge', () => {
  const serviceWorker = fs.readFileSync(path.join(root, 'packages/extension/extension/background/service-worker.ts'), 'utf8')

  assert.match(serviceWorker, /DAEMON_JOB_RESPONSE_TYPE = 'tokenless\.daemon\.job_result'/)
  assert.match(serviceWorker, /chrome\.runtime\.connectNative\(NATIVE_HOST_NAME\)/)
  assert.match(serviceWorker, /tokenless\.native\.daemon_connect/)
  assert.match(serviceWorker, /tokenless\.native\.daemon_job/)
  assert.match(serviceWorker, /tokenless\.native\.daemon_ready/)
  assert.match(serviceWorker, /tokenless\.native\.daemon_complete_job/)
  assert.match(serviceWorker, /daemonBridgePort/)
  assert.match(serviceWorker, /daemonBridgeReconnectTimer/)
  assert.match(serviceWorker, /scheduleDaemonBridgeReconnect/)
  assert.match(serviceWorker, /port\.onDisconnect\.addListener/)
  assert.match(serviceWorker, /daemonJobQueue = daemonJobQueue/)
  assert.match(serviceWorker, /handleDaemonBridgeMessage\(port, message\)/)
  assert.match(serviceWorker, /runClaimedDaemonJob\(job\)/)
  assert.match(serviceWorker, /postDaemonBridgeReady\(port\)/)
  assert.match(serviceWorker, /daemonBridgePort !== port/)
  assert.match(serviceWorker, /daemonJobToBridgeRequest\(claimedJob\)/)
  assert.match(serviceWorker, /requestJson\.prompt/)
  assert.match(serviceWorker, /requestJson\.targetUrl/)
  assert.doesNotMatch(
    serviceWorker.slice(
      serviceWorker.indexOf('function daemonJobToBridgeRequest'),
      serviceWorker.indexOf('async function completeDaemonJob')
    ),
    /claim_token|claimToken/,
    'daemon claim token must not be copied into provider bridge requests'
  )
  assert.match(serviceWorker, /validateBridgeRequest\(bridgeRequest\)/)
  assert.match(serviceWorker, /runBridgeRequest\(validation\.request\)/)
  assert.match(serviceWorker, /claimToken/)
  assert.match(serviceWorker, /normalizeBridgeResponse\(bridgeResponse\)/)
  assert.match(serviceWorker, /job: publicDaemonJob\(job\)/)
  assert.match(serviceWorker, /claim_token: _claimTokenSnake/)
  assert.match(serviceWorker, /claimToken: _claimTokenCamel/)
  assert.doesNotMatch(serviceWorker, /chrome\.alarms/)
  assert.doesNotMatch(serviceWorker, /tokenless\.native\.daemon_claim_next/)
  assert.match(serviceWorker, /handleRuntimeMessage\(message, \{ external: false \}\)/)
  assert.match(serviceWorker, /handleRuntimeMessage\(message, \{ external: true \}\)/)
  assert.match(serviceWorker, /external_bridge_forbidden/)
  assert.match(serviceWorker, /context\.external && validation\.request\.action !== BRIDGE_ACTIONS\.CAPABILITIES/)
  assert.doesNotMatch(serviceWorker, /DAEMON_RUN_NEXT_MESSAGE|tokenless\.daemon\.run_next|isDaemonRunNextMessage/)

  assert.ok(
    serviceWorker.indexOf('tokenless.native.daemon_job') < serviceWorker.indexOf('tokenless.native.daemon_complete_job'),
    'daemon jobs must be pushed to the background before they are completed'
  )
  assert.ok(
    serviceWorker.indexOf("if (context.external && validation.request.action !== BRIDGE_ACTIONS.CAPABILITIES)") <
      serviceWorker.indexOf('return runBridgeRequest(validation.request)'),
    'external bridge actions must be rejected before provider sessions can be driven'
  )
  assert.ok(
    serviceWorker.indexOf('port.postMessage({ type: \'tokenless.native.daemon_connect\' })') <
      serviceWorker.indexOf('tokenless.native.daemon_job'),
    'daemon jobs must arrive through the long-lived native bridge'
  )
  assert.ok(
    serviceWorker.indexOf('external_bridge_forbidden') < serviceWorker.indexOf('return runBridgeRequest(validation.request)'),
    'external bridge actions must be rejected before provider sessions can be driven'
  )
  assert.ok(serviceWorker.indexOf('async function runBridgeRequest') < serviceWorker.indexOf('async function runClaimedDaemonJob'))
  assert.match(serviceWorker, /tokenless\.bridge\.submit/)
  assert.match(serviceWorker, /tokenless\.bridge\.read/)
  assert.match(serviceWorker, /tokenless\.bridge\.validate_landing/)
})

test('daemon background path keeps provider sessions visible and does not inspect provider credentials', () => {
  const serviceWorker = fs.readFileSync(path.join(root, 'packages/extension/extension/background/service-worker.ts'), 'utf8')
  const manifest = fs.readFileSync(path.join(root, 'packages/extension/extension/manifest.json'), 'utf8')

  assert.match(serviceWorker, /getOrCreateProviderTab/)
  assert.match(serviceWorker, /focusTab\(tab\)/)
  assert.match(serviceWorker, /sendToProviderTab/)
  assert.match(serviceWorker, /chrome\.tabs\.sendMessage/)
  assert.doesNotMatch(serviceWorker, /chrome\.cookies/)
  assert.doesNotMatch(serviceWorker, /document\.cookie/)
  assert.doesNotMatch(serviceWorker, /localStorage/)
  assert.doesNotMatch(serviceWorker, /sessionStorage/)
  assert.doesNotMatch(serviceWorker, /provider.*fetch|fetch.*provider/)
  assert.doesNotMatch(manifest, /"cookies"/)
})

test('daemon background path preserves existing task page native job flow', () => {
  const taskPage = fs.readFileSync(path.join(root, 'packages/extension/extension/task/task.ts'), 'utf8')
  const taskHtml = fs.readFileSync(path.join(root, 'packages/extension/extension/task/task.html'), 'utf8')
  const serviceWorker = fs.readFileSync(path.join(root, 'packages/extension/extension/background/service-worker.ts'), 'utf8')

  assert.match(taskHtml, /<script type="module" src="\.\/task\.js"><\/script>/)
  assert.match(taskPage, /tokenless\.native\.claim_job/)
  assert.match(taskPage, /chrome\.runtime\.sendMessage/)
  assert.match(taskPage, /protocol: 'tokenless\.browser-session-bridge\.v1'/)
  assert.match(taskPage, /tokenless\.native\.write_result/)
  assert.match(taskPage, /tokenless\.native\.write_snapshot/)
  assert.match(taskPage, /normalizeBridgeResponse\(bridgeResponse\)/)
  assert.match(serviceWorker, /validateBridgeRequest\(message\)/)
})

test('daemon runner page is not part of the active extension architecture', () => {
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/extension/daemon/runner.html')), false)
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/extension/daemon/runner.ts')), false)
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/dist/extension/daemon/runner.html')), false)
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/dist/extension/daemon/runner.js')), false)
})

test('provider content script is safe to inject more than once', () => {
  const serviceWorker = fs.readFileSync(path.join(root, 'packages/extension/extension/background/service-worker.ts'), 'utf8')
  const contentScript = fs.readFileSync(path.join(root, 'packages/extension/extension/content/provider-content.ts'), 'utf8')
  const builtContentScript = fs.readFileSync(path.join(root, 'packages/extension/dist/extension/content/provider-content.js'), 'utf8')

  assert.match(serviceWorker, /chrome\.scripting\.executeScript/)
  assert.match(contentScript, /\(\(\) => \{/)
  assert.match(contentScript, /__TOKENLESS_PROVIDER_CONTENT_LOADED__/)
  assert.doesNotMatch(builtContentScript, /\nexport \{\};/)
  assert.ok(
    contentScript.indexOf('__TOKENLESS_PROVIDER_CONTENT_LOADED__') < contentScript.search(/const PROVIDERS\b/),
    'the duplicate-injection guard must run before top-level declarations inside the content script closure'
  )
})

test('browser bridge advertises sanitized DOM snapshot action', async () => {
  const { BRIDGE_ACTIONS, capabilitiesPayload, validateBridgeRequest, BRIDGE_PROTOCOL_VERSION } = await import('../packages/extension/dist/extension/shared/bridge-protocol.js')

  assert.equal(BRIDGE_ACTIONS.SNAPSHOT_DOM, 'snapshot_dom')
  assert.ok(capabilitiesPayload().actions.includes('snapshot_dom'))
  assert.equal(validateBridgeRequest({
    protocol: BRIDGE_PROTOCOL_VERSION,
    requestId: 'snapshot-1',
    provider: 'chatgpt',
    action: 'snapshot_dom',
  }).ok, true)
})

test('extension side panel renders provider-agnostic task history from native host', () => {
  const sidePanelHtml = fs.readFileSync(path.join(root, 'packages/extension/extension/sidepanel/index.html'), 'utf8')
  const sidePanelJs = fs.readFileSync(path.join(root, 'packages/extension/extension/sidepanel/index.ts'), 'utf8')
  const nativeHost = fs.readFileSync(path.join(root, 'packages/cli/dist/src/native-host.mjs'), 'utf8')

  assert.match(sidePanelHtml, /Task History/)
  assert.match(sidePanelHtml, /id="history"/)
  assert.match(sidePanelJs, /tokenless\.native\.list_history/)
  assert.match(sidePanelJs, /tokenless\.native\.read_config/)
  assert.match(sidePanelJs, /tokenless\.native\.write_config/)
  assert.match(sidePanelJs, /Save/)
  assert.match(sidePanelHtml, /Configuration/)
  assert.match(sidePanelJs, /Provider URL/)
  assert.match(sidePanelJs, /projectName/)
  assert.match(sidePanelJs, /chatName/)
  assert.match(nativeHost, /tokenless\.native\.list_history/)
  assert.match(nativeHost, /tokenless\.native\.read_config/)
  assert.match(nativeHost, /tokenless\.native\.write_config/)
  assert.match(nativeHost, /readLocalHistory/)
  assert.match(nativeHost, /readTokenlessConfig/)
  assert.match(nativeHost, /writeTokenlessConfig/)
})

test('Relay protocol validates required run fields', async () => {
  const { RELAY_PROTOCOL_VERSION, createRelayRun, validateRelayRun } = await import('../packages/relay/dist/src/index.js')
  const run = createRelayRun({ prompt: 'Review this diff.' })
  assert.equal(run.protocol, RELAY_PROTOCOL_VERSION)
  assert.equal(validateRelayRun(run).ok, true)
  assert.equal(validateRelayRun({ ...run, prompt: undefined }).ok, false)
})

test('Tokenless CLI prompt redacts obvious secret values', async () => {
  const { buildTokenlessPrompt } = await import('../packages/cli/dist/src/index.js')
  const prompt = await buildTokenlessPrompt({
    userPrompt: 'Review',
    turnContext: 'token=abc123',
    projectRoot: root,
  })
  assert.match(prompt, /token=<redacted>/)
  assert.doesNotMatch(prompt, /abc123/)
})

test('web client posts relay requests to a configured server', async () => {
  const { createRelayClient } = await import('../packages/client/dist/src/index.js')
  const calls = []
  const client = createRelayClient({
    baseUrl: 'https://relay.example.test/',
    async fetchImpl(url, init) {
      calls.push({ url, init })
      return {
        ok: true,
        async json() {
          return { ok: true, result: { status: 'accepted' } }
        },
      }
    },
  })

  const response = await client.createRun({ protocol: 'tokenless.relay.v1', requestId: 'r1' })
  assert.equal(calls[0].url, 'https://relay.example.test/v1/runs')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(response.ok, true)
})

test('local job store requires nonce and writes compact result', async () => {
  const {
    completeLocalJob,
    createLocalJob,
    JOB_STATES,
    readLocalJobRequest,
    readLocalTaskState,
    waitLocalJobResult,
    writeDomSnapshot,
    writeJobState,
  } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-job-store-'))
  const job = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Say hello.',
  })

  assert.equal((await readLocalJobRequest({ homeDir, jobId: job.jobId, nonce: job.nonce })).jobId, job.jobId)
  await assert.rejects(
    readLocalJobRequest({ homeDir, jobId: job.jobId, nonce: 'wrong' }),
    /nonce does not match/
  )

  await completeLocalJob({
    homeDir,
    jobId: job.jobId,
    nonce: job.nonce,
    ok: true,
    result: { text: 'hello from visible DOM' },
  })
  const result = await waitLocalJobResult({ homeDir, jobId: job.jobId, nonce: job.nonce, timeoutMs: 1000 })
  assert.equal(result.compactOutput, 'hello from visible DOM')
  const taskState = await readLocalTaskState({ homeDir, jobId: job.jobId })
  assert.equal(taskState.latest.jobId, job.jobId)
  assert.equal(taskState.latest.result.compactOutput, 'hello from visible DOM')
  assert.equal(taskState.latest.prompt, undefined)
  assert.equal(taskState.latest.nonce, undefined)

  const snapshotJob = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    action: 'snapshot_dom',
    targetUrl: 'https://chatgpt.com/',
  })
  const snapshot = await writeDomSnapshot({
    homeDir,
    jobId: snapshotJob.jobId,
    nonce: snapshotJob.nonce,
    snapshot: {
      status: 'snapshotted',
      provider: 'chatgpt',
      url: 'https://chatgpt.com/',
      title: 'ChatGPT',
      sanitized: true,
      includeText: false,
      html: '<!doctype html><html><body>[text]</body></html>',
      selectorProbes: { composers: [] },
    },
  })
  assert.match(snapshot.htmlPath, /snapshots\/chatgpt\/.*\/dom\.sanitized\.html$/)

  await completeLocalJob({
    homeDir,
    jobId: snapshotJob.jobId,
    nonce: snapshotJob.nonce,
    ok: true,
    result: { snapshot },
  })
  const snapshotResult = await waitLocalJobResult({ homeDir, jobId: snapshotJob.jobId, nonce: snapshotJob.nonce, timeoutMs: 1000 })
  assert.equal(snapshotResult.compactOutput, snapshot.htmlPath)

  const blockedJob = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Blocked visible session.',
  })
  const blockedResult = await completeLocalJob({
    homeDir,
    jobId: blockedJob.jobId,
    nonce: blockedJob.nonce,
    ok: false,
    error: { code: 'provider_blocker_visible', message: 'CAPTCHA is visible.', retryable: true },
  })
  assert.equal(blockedResult.status, JOB_STATES.BLOCKED)

  const uiMismatchJob = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Mismatched visible session.',
  })
  const uiMismatchResult = await completeLocalJob({
    homeDir,
    jobId: uiMismatchJob.jobId,
    nonce: uiMismatchJob.nonce,
    ok: false,
    error: { code: 'selector_drift', message: 'Composer selector was not found.', retryable: true },
  })
  assert.equal(uiMismatchResult.status, JOB_STATES.UI_MISMATCH)

  const timedOutJob = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Timed out visible session.',
  })
  const timedOutResult = await completeLocalJob({
    homeDir,
    jobId: timedOutJob.jobId,
    nonce: timedOutJob.nonce,
    ok: false,
    error: { code: 'provider_landing_timeout', message: 'Provider did not load.', retryable: true },
  })
  assert.equal(timedOutResult.status, JOB_STATES.TIMED_OUT)

  const failedJob = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Generic failure.',
  })
  const failedResult = await completeLocalJob({
    homeDir,
    jobId: failedJob.jobId,
    nonce: failedJob.nonce,
    ok: false,
    error: { code: 'bridge_runtime_error', message: 'Unexpected bridge failure.', retryable: true },
  })
  assert.equal(failedResult.status, JOB_STATES.FAILED)

  const pollingJob = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Wait for visible DOM.',
  })
  const events = []
  await writeJobState({
    homeDir,
    jobId: pollingJob.jobId,
    nonce: pollingJob.nonce,
    status: 'running',
    actor: 'extension',
    detail: { provider: 'chatgpt' },
  })
  const waiting = waitLocalJobResult({
    homeDir,
    jobId: pollingJob.jobId,
    nonce: pollingJob.nonce,
    timeoutMs: 1000,
    pollMs: 20,
    statusIntervalMs: 25,
    onStatus: (event) => events.push(event),
  })
  await delay(70)
  await completeLocalJob({
    homeDir,
    jobId: pollingJob.jobId,
    nonce: pollingJob.nonce,
    ok: true,
    result: { text: 'done after polling' },
  })
  assert.equal((await waiting).compactOutput, 'done after polling')
  assert.deepEqual(events.map((event) => event.type), ['state', 'poll', 'result'])
  assert.equal(events[0].status, 'running')
  assert.equal(events[1].status, 'running')
  assert.equal(events[2].status, 'succeeded')
})

test('local Tokenless config stores provider preference for default runs', async () => {
  const {
    configPath,
    createLocalJob,
    readTokenlessConfig,
    writeTokenlessConfig,
  } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-config-'))

  assert.deepEqual((await readTokenlessConfig(homeDir)).preferredProviders, [])

  const config = await writeTokenlessConfig({
    homeDir,
    preferredProviders: ['claude', 'chatgpt', 'claude', 'unsupported', 'gemini'],
  })
  assert.deepEqual(config.preferredProviders, ['claude', 'chatgpt', 'gemini'])
  assert.ok(fs.existsSync(configPath(homeDir)))

  const loaded = await readTokenlessConfig(homeDir)
  assert.deepEqual(loaded.preferredProviders, ['claude', 'chatgpt', 'gemini'])

  const job = await createLocalJob({
    homeDir,
    provider: loaded.preferredProviders[0],
    prompt: 'Use configured provider.',
  })
  assert.equal(job.provider, 'claude')
})

test('native host writes Tokenless config through native messaging protocol', async () => {
  const {
    readTokenlessConfig,
  } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-native-config-'))
  const response = await nativeHostMessage({
    type: 'tokenless.native.write_config',
    preferredProviders: ['gemini', 'chatgpt'],
  }, { TOKENLESS_HOME: homeDir })

  assert.equal(response.ok, true)
  assert.deepEqual(response.result.preferredProviders, ['gemini', 'chatgpt'])
  assert.deepEqual((await readTokenlessConfig(homeDir)).preferredProviders, ['gemini', 'chatgpt'])
})

test('local conversation mapping routes the same idempotency key to the same provider conversation', async () => {
  const {
    completeLocalJob,
    conversationMapPath,
    createLocalJob,
    readConversationMap,
    readLocalHistory,
  } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-conversation-map-'))

  const first = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    projectName: 'Tokenless',
    chatName: 'Bridge history',
    prompt: 'Start a mapped conversation.',
  })

  assert.equal(first.targetUrl, 'https://chatgpt.com/')
  assert.equal(first.conversation.route, 'new')
  assert.equal(first.idempotencyKey, 'project:Tokenless:chat:Bridge history')

  await completeLocalJob({
    homeDir,
    jobId: first.jobId,
    nonce: first.nonce,
    ok: true,
    result: {
      text: 'mapped answer',
      read: {
        text: 'mapped answer',
        url: 'https://chatgpt.com/c/abc-123?temporary-chat=false',
      },
    },
  })

  assert.ok(fs.existsSync(conversationMapPath(homeDir)))
  const map = await readConversationMap(homeDir)
  assert.equal(map.conversations['chatgpt:project:Tokenless:chat:Bridge history'].projectName, 'Tokenless')
  assert.equal(map.conversations['chatgpt:project:Tokenless:chat:Bridge history'].chatName, 'Bridge history')
  assert.equal(map.conversations['chatgpt:project:Tokenless:chat:Bridge history'].targetUrl, 'https://chatgpt.com/c/abc-123')
  assert.equal(map.conversations['chatgpt:project:Tokenless:chat:Bridge history'].providerConversationId, 'abc-123')

  const history = await readLocalHistory({ homeDir })
  assert.equal(history.history[0].projectName, 'Tokenless')
  assert.equal(history.history[0].chatName, 'Bridge history')
  assert.equal(history.history[0].provider, 'chatgpt')
  assert.equal(history.history[0].targetUrl, 'https://chatgpt.com/c/abc-123')
  assert.equal(history.history[0].lastStatus, 'succeeded')
  assert.equal(history.history[0].jobCount, 1)

  const second = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    projectName: 'Tokenless',
    chatName: 'Bridge history',
    prompt: 'Continue the mapped conversation.',
  })
  assert.equal(second.targetUrl, 'https://chatgpt.com/c/abc-123')
  assert.equal(second.conversation.route, 'mapped')

  const unrelated = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    idempotencyKey: 'agent-thread-99',
    prompt: 'Start a different conversation.',
  })
  assert.equal(unrelated.targetUrl, 'https://chatgpt.com/')
  assert.equal(unrelated.conversation.route, 'new')
})

test('local conversation mapping derives stable keys from partial agent names only', async () => {
  const {
    completeLocalJob,
    createLocalJob,
    readConversationMap,
    readLocalHistory,
  } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-partial-agent-names-'))

  const unnamed = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Start an unnamed fallback conversation.',
  })
  assert.equal(unnamed.idempotencyKey, undefined)
  assert.equal(unnamed.conversation.route, 'default')
  await completeLocalJob({
    homeDir,
    jobId: unnamed.jobId,
    nonce: unnamed.nonce,
    ok: true,
    result: {
      text: 'unnamed answer',
      read: {
        text: 'unnamed answer',
        url: 'https://chatgpt.com/c/unnamed-fallback',
      },
    },
  })
  assert.deepEqual((await readLocalHistory({ homeDir })).history, [])

  const projectOnly = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    projectName: 'Tokenless',
    prompt: 'Start project-only mapped conversation.',
  })
  assert.equal(projectOnly.idempotencyKey, 'project:Tokenless')
  await completeLocalJob({
    homeDir,
    jobId: projectOnly.jobId,
    nonce: projectOnly.nonce,
    ok: true,
    result: {
      text: 'project-only answer',
      read: {
        text: 'project-only answer',
        url: 'https://chatgpt.com/c/project-only',
      },
    },
  })
  const projectOnlyAgain = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    projectName: 'Tokenless',
    prompt: 'Continue project-only mapped conversation.',
  })
  assert.equal(projectOnlyAgain.idempotencyKey, 'project:Tokenless')
  assert.equal(projectOnlyAgain.targetUrl, 'https://chatgpt.com/c/project-only')
  assert.equal(projectOnlyAgain.conversation.route, 'mapped')

  const chatOnly = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    chatName: 'Bridge history',
    prompt: 'Start chat-only mapped conversation.',
  })
  assert.equal(chatOnly.idempotencyKey, 'chat:Bridge history')
  await completeLocalJob({
    homeDir,
    jobId: chatOnly.jobId,
    nonce: chatOnly.nonce,
    ok: true,
    result: {
      text: 'chat-only answer',
      read: {
        text: 'chat-only answer',
        url: 'https://chatgpt.com/c/chat-only',
      },
    },
  })
  const chatOnlyAgain = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    chatName: 'Bridge history',
    prompt: 'Continue chat-only mapped conversation.',
  })
  assert.equal(chatOnlyAgain.idempotencyKey, 'chat:Bridge history')
  assert.equal(chatOnlyAgain.targetUrl, 'https://chatgpt.com/c/chat-only')
  assert.equal(chatOnlyAgain.conversation.route, 'mapped')

  const map = await readConversationMap(homeDir)
  assert.equal(map.conversations['chatgpt:project:Tokenless'].targetUrl, 'https://chatgpt.com/c/project-only')
  assert.equal(map.conversations['chatgpt:chat:Bridge history'].targetUrl, 'https://chatgpt.com/c/chat-only')
  assert.equal(map.conversations['chatgpt:undefined'], undefined)

  const history = await readLocalHistory({ homeDir })
  assert.ok(history.history.some((entry) => (
    entry.projectName === 'Tokenless' &&
    entry.chatName === 'Unspecified chat' &&
    entry.targetUrl === 'https://chatgpt.com/c/project-only'
  )))
  assert.ok(history.history.some((entry) => (
    entry.projectName === 'Unspecified project' &&
    entry.chatName === 'Bridge history' &&
    entry.targetUrl === 'https://chatgpt.com/c/chat-only'
  )))
})

test('local conversation mapping preserves concurrent completions', async () => {
  const {
    completeLocalJob,
    createLocalJob,
    readConversationMap,
  } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-conversation-concurrent-'))
  const jobs = await Promise.all(Array.from({ length: 16 }, (_, index) => createLocalJob({
    homeDir,
    provider: 'chatgpt',
    idempotencyKey: `agent-thread-${index}`,
    prompt: `Start mapped conversation ${index}.`,
  })))

  await Promise.all(jobs.map((job, index) => completeLocalJob({
    homeDir,
    jobId: job.jobId,
    nonce: job.nonce,
    ok: true,
    result: {
      text: `mapped answer ${index}`,
      read: {
        text: `mapped answer ${index}`,
        url: `https://chatgpt.com/c/conversation-${index}?temporary-chat=false`,
      },
    },
  })))

  const map = await readConversationMap(homeDir)
  for (let index = 0; index < jobs.length; index += 1) {
    assert.equal(
      map.conversations[`chatgpt:agent-thread-${index}`].targetUrl,
      `https://chatgpt.com/c/conversation-${index}`
    )
  }
})

test('local conversation mapping rejects corrupt local state instead of overwriting it', async () => {
  const {
    completeLocalJob,
    conversationMapPath,
    createLocalJob,
    readConversationMap,
  } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-conversation-corrupt-'))
  const mapPath = conversationMapPath(homeDir)
  const job = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    idempotencyKey: 'agent-thread-corrupt',
    prompt: 'Start a mapped conversation.',
  })

  await fsp.writeFile(mapPath, '{not valid json', 'utf8')
  await assert.rejects(
    readConversationMap(homeDir),
    /Cannot read Tokenless conversation map/
  )

  const result = await completeLocalJob({
    homeDir,
    jobId: job.jobId,
    nonce: job.nonce,
    ok: true,
    result: {
      text: 'answer that should not hide local state failure',
      read: {
        text: 'answer that should not hide local state failure',
        url: 'https://chatgpt.com/c/corrupt-map',
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'conversation_map_error')
})

test('native host installer scopes manifest to extension origin', async () => {
  const { installNativeHost, NATIVE_HOST_NAME } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-native-home-'))
  const manifestHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-manifest-home-'))
  const installed = await installNativeHost({
    homeDir,
    manifestHome,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    browsers: ['chromium'],
  })

  assert.equal(installed.manifests.length, 1)
  assert.ok(fs.existsSync(installed.executable))
  const manifest = JSON.parse(fs.readFileSync(installed.manifests[0], 'utf8'))
  assert.equal(manifest.name, NATIVE_HOST_NAME)
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'])
})

test('native host installer supports Brave browser manifests', async () => {
  const { installNativeHost } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-native-home-'))
  const manifestHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-manifest-home-'))
  const installed = await installNativeHost({
    homeDir,
    manifestHome,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    browsers: ['brave-browser'],
  })

  assert.equal(installed.manifests.length, 1)
  const expectedSegment = path.join('BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts')
  assert.ok(installed.manifests[0].includes(expectedSegment))
})

test('native host installer supports isolated browser profile manifests', async () => {
  const { installNativeHost } = await import('../packages/cli/dist/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-native-home-'))
  const manifestHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-manifest-home-'))
  const installed = await installNativeHost({
    homeDir,
    manifestHome,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    browsers: ['profile'],
  })

  assert.equal(installed.manifests.length, 1)
  assert.equal(installed.manifests[0], path.join(manifestHome, 'NativeMessagingHosts', 'dev.tokenless.native_host.json'))
})

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
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
      reject(new Error('native host test timed out'))
    }, 5000)

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
