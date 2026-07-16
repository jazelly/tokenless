import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionSource = path.join(root, 'packages/extension/extension')
const extensionDist = path.join(root, 'packages/extension/dist/extension')

test('primary manifest owns trusted debugger clicks without broad browser permissions', () => {
  const manifest = readJson('packages/extension/extension/manifest.json')

  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.version, '0.1.5')
  assert.equal(manifest.name, 'Tokenless')
  assert.equal(manifest.options_ui, undefined)
  assert.equal(manifest.action.default_title, 'Open Tokenless settings')
  assert.deepEqual(manifest.side_panel, { default_path: 'settings/index.html' })
  assert.equal(manifest.externally_connectable, undefined)
  assert.equal(manifest.content_scripts.length, 1)
  assert.ok(manifest.permissions.includes('nativeMessaging'))
  assert.ok(manifest.permissions.includes('sidePanel'))
  assert.ok(manifest.permissions.includes('debugger'))
  assert.ok(!manifest.permissions.includes('cookies'))
  assert.ok(!manifest.permissions.includes('history'))
  assert.ok(!manifest.permissions.includes('webRequest'))
  assert.ok(!manifest.permissions.includes('webRequestBlocking'))
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions)
  assert.ok(manifest.host_permissions.every((pattern) => pattern.startsWith('https://')))
  assert.ok(manifest.host_permissions.includes('https://grok.com/*'))
  assert.deepEqual(manifest.host_permissions, [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://gemini.google.com/*',
    'https://claude.ai/*',
    'https://grok.com/*',
  ])
})

test('extension build and package contain Settings and no debugger companion artifact', () => {
  const sourceArtifacts = listRelativeFiles(extensionSource)
  const builtArtifacts = listRelativeFiles(extensionDist)
  const buildManifest = readJson('packages/extension/dist/extension-build-manifest.json')
  const extensionPackage = readJson('packages/extension/package.json')
  const recordedArtifacts = buildManifest.files.map((entry) => entry.path)

  for (const artifacts of [sourceArtifacts, builtArtifacts, recordedArtifacts]) {
    assert.ok(artifacts.some((file) => file === 'settings/index.html'))
    assert.ok(artifacts.some((file) => file === 'settings/index.ts' || file === 'settings/index.js'))
    assert.ok(artifacts.every((file) => !file.startsWith('task/')), artifacts.join('\n'))
    assert.ok(artifacts.every((file) => !file.startsWith('sidepanel/')), artifacts.join('\n'))
    assert.ok(artifacts.every((file) => !file.startsWith('daemon/')), artifacts.join('\n'))
    assert.ok(artifacts.every((file) => !file.includes('runner')), artifacts.join('\n'))
  }
  assert.equal(extensionPackage.exports['./web-client'], undefined)
  assert.ok(!extensionPackage.files.includes('dist/debugger-control'))
  assert.equal(buildManifest.debuggerControl, undefined)
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/control-extension')), false)
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/dist/debugger-control')), false)
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/dist/tokenless-debugger-control.zip')), false)
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/src/web-client.ts')), false)
  assert.equal(fs.existsSync(path.join(root, 'packages/extension/dist/src/web-client.js')), false)
  for (const obsoleteDirectory of ['task', 'sidepanel', 'daemon']) {
    assert.equal(fs.existsSync(path.join(extensionSource, obsoleteDirectory)), false)
    assert.equal(fs.existsSync(path.join(extensionDist, obsoleteDirectory)), false)
  }
})

test('CLI, bridge, and build sources contain no companion extension plumbing', () => {
  const removedField = ['debugger', 'ControlExtensionId'].join('')
  const removedFlag = ['--debugger', '-control-extension-id'].join('')
  const cli = readText('packages/cli/src/tokenless.mts')
  const bridge = readText('packages/extension/extension/shared/bridge-protocol.ts')
  const build = readText('packages/extension/src/build-extension.mts')

  assert.ok(!cli.includes(removedField))
  assert.ok(!cli.includes(removedFlag))
  assert.ok(!bridge.includes(removedField))
  assert.ok(!build.includes('control-extension'))
  assert.ok(!build.includes('tokenless-debugger-control.zip'))
})

test('native messages are constructed and validated with tokenless.native.v1', async () => {
  const {
    createNativeMessage,
    isNativeMessage,
    NATIVE_MESSAGE_TYPES,
    NATIVE_PROTOCOL_VERSION,
  } = await import('../packages/extension/dist/extension/shared/native-protocol.js')

  assert.equal(NATIVE_PROTOCOL_VERSION, 'tokenless.native.v1')
  for (const type of Object.values(NATIVE_MESSAGE_TYPES)) {
    const message = createNativeMessage(type, { optional: undefined })
    assert.deepEqual(message, { protocol: NATIVE_PROTOCOL_VERSION, type })
    assert.equal(isNativeMessage(message), true)
  }
  assert.equal(isNativeMessage({ protocol: 'tokenless.native.v0', type: NATIVE_MESSAGE_TYPES.READ_CONFIG }), false)
  assert.equal(isNativeMessage({ type: NATIVE_MESSAGE_TYPES.READ_CONFIG }), false)
})

test('provider navigation policy centralizes approved visible-session routes', async () => {
  const { getProviderById } = await import('../packages/extension/dist/extension/shared/provider-config.js')
  const {
    areProviderTransitionSourcesEquivalent,
    canonicalProviderUrl,
    isApprovedProviderTransition,
    isProviderConversationUrl,
  } = await import('../packages/extension/dist/extension/shared/provider-navigation-policy.js')
  const chatgpt = getProviderById('chatgpt')
  const claude = getProviderById('claude')
  const gemini = getProviderById('gemini')
  const grok = getProviderById('grok')
  assert.ok(chatgpt)
  assert.ok(claude)
  assert.ok(gemini)
  assert.ok(grok)

  assert.equal(canonicalProviderUrl('https://chatgpt.com/g/g-12345678/'), 'https://chatgpt.com/g/g-12345678')
  assert.equal(isApprovedProviderTransition(chatgpt, 'https://chatgpt.com/', 'https://chatgpt.com/c/12345678'), true)
  assert.equal(isApprovedProviderTransition(chatgpt, 'https://chatgpt.com/g/g-12345678', 'https://chatgpt.com/g/g-12345678/c/abcdefgh9'), true)
  assert.equal(isApprovedProviderTransition(chatgpt, 'https://chatgpt.com/g/g-12345678', 'https://chatgpt.com/c/abcdefgh9'), false)
  assert.equal(isProviderConversationUrl(chatgpt, 'https://chatgpt.com/settings'), false)
  assert.equal(areProviderTransitionSourcesEquivalent(chatgpt, 'https://chatgpt.com/', 'https://chat.openai.com/'), true)
  assert.equal(isApprovedProviderTransition(claude, 'https://claude.ai/new', 'https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174001'), true)
  assert.equal(isProviderConversationUrl(claude, 'https://claude.ai/chat/settings123'), false)
  assert.equal(claude.composerSelectors[0], 'div[data-testid="chat-input"][contenteditable="true"][role="textbox"]')
  assert.equal(claude.answerSelectors.includes('[data-testid="virtual-message-list"] .font-claude-response-body'), true)
  assert.equal(claude.busySelectors.includes('[data-testid="virtual-message-list"] [data-is-streaming="true"]'), true)
  assert.equal(isApprovedProviderTransition(gemini, 'https://gemini.google.com/app', 'https://gemini.google.com/app/4b9f2c7d1e6a'), true)
  assert.equal(isProviderConversationUrl(gemini, 'https://gemini.google.com/app/settings123'), false)
  assert.equal(
    gemini.composerSelectors[0],
    'rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Enter a prompt for Gemini"]'
  )
  assert.deepEqual(gemini.submitSelectors, ['button[aria-label="Send message"]'])
  assert.deepEqual(gemini.answerSelectors, ['response-container message-content'])
  assert.deepEqual(gemini.busySelectors, ['button[aria-label="Stop response"]'])
  assert.equal(gemini.blockerSelectors.some((selector) => selector.includes('accounts.google.com')), false)
  assert.equal(isApprovedProviderTransition(grok, 'https://grok.com/', 'https://grok.com/c/123e4567-e89b-12d3-a456-426614174003'), true)
  assert.equal(isProviderConversationUrl(grok, 'https://grok.com/c/settings'), false)
  assert.equal(isProviderConversationUrl(grok, 'https://grok.com/c/settings123'), false)
  assert.deepEqual(grok.composerSelectors, [
    'div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]',
    'textarea[aria-label="Ask Grok anything"][placeholder="What do you want to know?"]',
  ])
  assert.deepEqual(grok.submitSelectors, [
    'button[data-testid="chat-submit"][aria-label="Submit"][type="submit"]',
  ])
  assert.deepEqual(grok.answerSelectors, ['div[data-testid="assistant-message"]'])
  assert.deepEqual(grok.blockerSelectors, ['div[data-testid="anon-paywall-sign-up-card"]'])
  assert.equal(grok.busySelectors, undefined)
  assert.equal(grok.busyTextLabels, undefined)
})

test('daemon bridge requires a v1 handshake and reconnects with bounded backoff', async () => {
  const { NativeDaemonBridge } = await import(
    '../packages/extension/dist/extension/background/native-daemon-bridge.js'
  )
  const scheduler = createManualScheduler()
  const ports = []
  const delivered = []
  let runtimeLastErrorReads = 0
  const bridge = new NativeDaemonBridge({
    connectNative() {
      const port = createBehaviorNativePort()
      ports.push(port)
      return port
    },
    onMessage(_port, message) {
      delivered.push(message)
    },
    readRuntimeLastError() {
      runtimeLastErrorReads += 1
      return { message: 'Access to the specified native messaging host is forbidden.' }
    },
    timing: {
      handshakeTimeoutMs: 100,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 40,
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  })

  bridge.start()
  bridge.start()
  assert.equal(ports.length, 1, 'duplicate starts must share the pending port')
  assert.deepEqual(ports[0].posted, [{
    protocol: 'tokenless.native.v1',
    type: 'tokenless.native.daemon_connect',
  }])

  await ports[0].onMessage.emit({
    type: 'tokenless.native.daemon_connected',
    ok: true,
  })
  assert.equal(ports[0].disconnectCount, 1, 'missing protocol must reject the handshake')
  assert.deepEqual(scheduler.pendingDelays(), [10])

  scheduler.runDelay(10)
  await ports[1].onMessage.emit({
    protocol: 'tokenless.native.v0',
    type: 'tokenless.native.daemon_connected',
    ok: true,
  })
  assert.equal(ports[1].disconnectCount, 1, 'wrong protocol must reject the handshake')
  assert.deepEqual(scheduler.pendingDelays(), [20])

  scheduler.runDelay(20)
  await ports[2].onMessage.emit({
    protocol: 'tokenless.native.v1',
    type: 'tokenless.native.daemon_connect',
    ok: false,
    error: { code: 'daemon_unavailable' },
  })
  assert.equal(ports[2].disconnectCount, 1, 'ok:false daemon_connect must reject the handshake')
  assert.deepEqual(scheduler.pendingDelays(), [40])

  scheduler.runDelay(40)
  scheduler.runDelay(100)
  assert.equal(ports[3].disconnectCount, 1, 'handshake timeout must close the port')
  assert.deepEqual(scheduler.pendingDelays(), [40], 'reconnect delay must stay capped')

  scheduler.runDelay(40)
  await ports[4].onMessage.emit(nativeSuccess('tokenless.native.daemon_connected', {
    status: 'connected',
  }))
  assert.deepEqual(scheduler.pendingDelays(), [], 'successful handshake must clear its timeout')

  await ports[4].onMessage.emit({
    protocol: 'tokenless.native.v1',
    type: 'tokenless.native.daemon_error',
    ok: false,
    error: { code: 'bridge_superseded', message: 'A newer bridge won.' },
  })
  assert.equal(ports[4].disconnectCount, 1)
  assert.deepEqual(scheduler.pendingDelays(), [10], 'successful handshake must reset backoff')

  bridge.start()
  assert.equal(ports.length, 5, 'start must not bypass an existing reconnect timer')
  scheduler.runDelay(10)
  await ports[5].onMessage.emit(nativeSuccess('tokenless.native.daemon_connected', {
    status: 'connected',
  }))
  await ports[5].onDisconnect.emit()
  assert.deepEqual(scheduler.pendingDelays(), [10], 'physical disconnect must reconnect from base delay')
  assert.equal(runtimeLastErrorReads, 6, 'every disconnect must consume runtime.lastError in its callback')

  scheduler.runDelay(10)
  await ports[6].onMessage.emit(nativeSuccess('tokenless.native.daemon_connected', {
    status: 'connected',
  }))
  const recoveredJob = nativeSuccess('tokenless.native.daemon_job', { job: { job_id: 'job-recovered' } })
  await ports[6].onMessage.emit(recoveredJob)
  assert.deepEqual(delivered, [recoveredJob], 'messages flow only after a recovered handshake')
  assert.ok(ports.every((port) => port.posted.every((message) => (
    message.protocol === 'tokenless.native.v1' && message.type === 'tokenless.native.daemon_connect'
  ))))

  bridge.stop()
  assert.deepEqual(scheduler.pendingDelays(), [])
  assert.equal(runtimeLastErrorReads, 7, 'intentional shutdown disconnects must also consume runtime.lastError')
})

test('Settings model normalizes redacted daemon history and explicit configuration clears', async () => {
  const {
    configWritePayload,
    normalizeHistoryEntries,
    normalizeProviderOrder,
  } = await import('../packages/extension/dist/extension/settings/model.js')
  const privateMarker = 'private-claim-marker'
  const entries = normalizeHistoryEntries([
    {
      job_id: 'job-202',
      claim_token: privateMarker,
      provider: 'chatgpt',
      action: 'submit_and_read',
      status: 'succeeded',
      metadata: {
        projectName: 'Tokenless',
        chatName: 'Background-only execution',
        taskId: 'project:Tokenless:chat:Background-only execution',
      },
      updated_at: '2026-07-10T01:02:03Z',
    },
    {
      job_id: 'job-legacy',
      provider: 'gemini',
      action: 'read',
      status: 'queued',
      request_json: {
        metadata: {
          projectName: 'Legacy project',
          chatName: 'Compatible history',
          idempotencyKey: 'legacy-task',
        },
      },
      created_at: '2026-07-09T01:02:03Z',
    },
  ])

  assert.deepEqual(entries, [
    {
      jobId: 'job-202',
      taskId: 'project:Tokenless:chat:Background-only execution',
      projectName: 'Tokenless',
      chatName: 'Background-only execution',
      provider: 'chatgpt',
      action: 'submit_and_read',
      status: 'succeeded',
      updatedAt: '2026-07-10T01:02:03Z',
    },
    {
      jobId: 'job-legacy',
      taskId: 'legacy-task',
      projectName: 'Legacy project',
      chatName: 'Compatible history',
      provider: 'gemini',
      action: 'read',
      status: 'queued',
      updatedAt: '2026-07-09T01:02:03Z',
    },
  ])
  assert.doesNotMatch(JSON.stringify(entries), new RegExp(privateMarker))
  assert.deepEqual(
    normalizeProviderOrder(['claude', 'chatgpt', 'claude', 'unsupported'], ['chatgpt', 'gemini', 'claude']),
    ['claude', 'chatgpt']
  )
  assert.deepEqual(configWritePayload({
    providerOrder: ['gemini', 'chatgpt'],
    browser: '',
    daemonUrl: '   ',
  }), {
    preferredProviders: ['gemini', 'chatgpt'],
    browser: null,
    daemonUrl: null,
  })
  assert.deepEqual(configWritePayload({
    providerOrder: ['chatgpt'],
    browser: ' chrome ',
    daemonUrl: ' http://127.0.0.1:7331 ',
  }), {
    preferredProviders: ['chatgpt'],
    browser: 'chrome',
    daemonUrl: 'http://127.0.0.1:7331',
  })
})

test('built Settings UI renders, saves, refreshes, redacts, and reports failures', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const server = await startStaticServer(extensionDist)
  const browser = await chromium.launch({ headless: true })

  try {
    const initialHistory = [{
      job_id: 'job-initial',
      claim_token: 'private-claim-marker',
      provider: 'gemini',
      action: 'submit_and_read',
      status: 'succeeded',
      metadata: {
        projectName: 'Tokenless',
        chatName: 'Settings behavior',
        taskId: 'task-settings-behavior',
      },
      request_json: {
        prompt: 'private-prompt-marker',
        result: 'private-result-marker',
      },
      updated_at: '2026-07-10T01:02:03Z',
    }]
    const refreshedHistory = [{
      job_id: 'job-refreshed',
      provider: 'chatgpt',
      action: 'read',
      status: 'queued',
      metadata: {
        projectName: 'Tokenless',
        chatName: 'History only refresh',
        taskId: 'task-history-refresh',
      },
      updated_at: '2026-07-10T02:03:04Z',
    }]
    const loaded = await openSettingsPage(browser, server.url, [
      { response: nativeSuccess('tokenless.native.read_config', {
        preferredProviders: ['gemini', 'chatgpt'],
        browser: 'Chrome Beta',
        daemonUrl: 'http://127.0.0.1:7331',
      }) },
      { response: nativeSuccess('tokenless.native.list_history', initialHistory) },
      { response: nativeSuccess('tokenless.native.write_config', {
        preferredProviders: ['chatgpt', 'gemini'],
        browser: null,
        daemonUrl: null,
      }) },
      { response: nativeSuccess('tokenless.native.list_history', refreshedHistory), delayMs: 150 },
      { response: nativeFailure('tokenless.native.list_history', 'History service offline.') },
    ])

    try {
      const { page, pageErrors } = loaded
      await page.getByText('Native host ready', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByText('Language', { exact: true }).waitFor()
      await page.getByRole('button', { name: '中文', exact: true }).click()
      await page.getByRole('button', { name: '设置', exact: true }).waitFor()
      await page.getByText('语言', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'EN', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
      assert.deepEqual(await page.locator('.provider-copy strong').allTextContents(), ['Gemini', 'ChatGPT'])
      assert.equal(await page.getByLabel('Browser preference').inputValue(), 'Chrome Beta')
      assert.equal(await page.getByLabel('Daemon URL').inputValue(), 'http://127.0.0.1:7331')
      const visibleText = await page.locator('body').innerText()
      assert.doesNotMatch(visibleText, /private-claim-marker|private-prompt-marker|private-result-marker/)
      assert.equal(await page.getByRole('button', { name: 'Move Gemini up', exact: true }).isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Move Gemini down', exact: true }).isEnabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Remove Gemini', exact: true }).isEnabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Move ChatGPT up', exact: true }).isEnabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Move ChatGPT down', exact: true }).isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Remove ChatGPT', exact: true }).isEnabled(), true)
      assert.equal(await page.getByRole('combobox', { name: 'Provider to add', exact: true }).count(), 1)
      assert.equal(await page.getByRole('combobox', { name: 'Provider to add', exact: true }).isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Add provider', exact: true }).isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).count(), 1)
      assert.equal(await page.locator('#refresh').count(), 1)

      await page.getByLabel('Browser preference').fill('   ')
      await page.getByLabel('Daemon URL').fill('')
      const moveChatGptUp = page.getByRole('button', { name: 'Move ChatGPT up', exact: true })
      await moveChatGptUp.focus()
      await page.keyboard.press('Enter')
      assert.deepEqual(await page.locator('.provider-copy strong').allTextContents(), ['ChatGPT', 'Gemini'])
      assert.deepEqual(await page.evaluate(() => ({
        providerId: document.activeElement?.getAttribute('data-provider-id'),
        action: document.activeElement?.getAttribute('data-provider-action'),
      })), { providerId: 'chatgpt', action: 'down' })
      await page.getByRole('button', { name: 'Save settings', exact: true }).click()
      await page.getByText('Settings saved.', { exact: true }).waitFor()

      const writeRequest = await page.evaluate(() => globalThis.__nativeMock.requests[2])
      assert.deepEqual(writeRequest, {
        protocol: 'tokenless.native.v1',
        type: 'tokenless.native.write_config',
        preferredProviders: ['chatgpt', 'gemini'],
        browser: null,
        daemonUrl: null,
      })

      await page.getByLabel('Browser preference').fill('firefox')
      await page.getByLabel('Daemon URL').fill('http://127.0.0.1:7444')
      await page.getByRole('button', { name: 'Move Gemini up', exact: true }).click()
      await page.getByRole('button', { name: 'Activity', exact: true }).click()
      await page.getByText('Settings behavior', { exact: true }).waitFor()
      assert.equal(await page.getByText('Project: Tokenless', { exact: true }).count(), 1)
      assert.equal(await page.getByText('Task: task-settings-behavior', { exact: true }).count(), 1)
      const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
      await refresh.click()
      await page.getByRole('button', { name: 'Refreshing…', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Refreshing…', exact: true }).isDisabled(), true)
      assert.equal(await page.locator('#configuration button[type="submit"]').isEnabled(), true)
      assert.equal(await page.getByLabel('Browser preference').inputValue(), 'firefox')
      assert.equal(await page.getByLabel('Daemon URL').inputValue(), 'http://127.0.0.1:7444')
      assert.deepEqual(await page.locator('.provider-copy strong').allTextContents(), ['Gemini', 'ChatGPT'])
      await page.getByText('Loading daemon history…', { exact: true }).waitFor()
      await page.getByText('History only refresh', { exact: true }).waitFor()
      assert.equal(await page.getByLabel('Browser preference').inputValue(), 'firefox')
      assert.deepEqual(await page.locator('.provider-copy strong').allTextContents(), ['Gemini', 'ChatGPT'])

      const requestTypes = await page.evaluate(() => globalThis.__nativeMock.requests.map((request) => request.type))
      assert.deepEqual(requestTypes, [
        'tokenless.native.read_config',
        'tokenless.native.list_history',
        'tokenless.native.write_config',
        'tokenless.native.list_history',
      ])

      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByText('History service offline.', { exact: true }).waitFor()
      assert.equal(await page.locator('#page-status').textContent(), 'History refresh failed')
      assert.equal(await page.getByLabel('Browser preference').inputValue(), 'firefox')
      assert.deepEqual(await page.locator('.provider-copy strong').allTextContents(), ['Gemini', 'ChatGPT'])

      await page.setViewportSize({ width: 320, height: 844 })
      const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(horizontalOverflow <= 0, `Settings overflowed the narrow viewport by ${horizontalOverflow}px`)
      assert.deepEqual(pageErrors, [])
    } finally {
      await loaded.context.close()
    }

    const loading = await openSettingsPage(browser, server.url, [{}, {}])
    try {
      const { page, pageErrors } = loading
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByText('Loading configuration…', { exact: true }).waitFor()
      await page.evaluate(([configResponse, historyResponse]) => {
        globalThis.__nativeMock.respond(0, configResponse)
        globalThis.__nativeMock.respond(1, historyResponse)
      }, [
        nativeSuccess('tokenless.native.read_config', {
          preferredProviders: [],
          browser: null,
          daemonUrl: null,
        }),
        nativeSuccess('tokenless.native.list_history', []),
      ])
      await page.getByText('Native host ready', { exact: true }).waitFor()
      await page.getByText('No preference saved. New jobs default to ChatGPT.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Activity', exact: true }).click()
      await page.getByText('Loading daemon history…', { exact: true }).waitFor({ state: 'hidden' })
      await page.getByText('No daemon jobs yet.', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(), true)
      assert.deepEqual(pageErrors, [])
    } finally {
      await loading.context.close()
    }

    const partial = await openSettingsPage(browser, server.url, [
      { response: nativeFailure('tokenless.native.read_config', 'Configuration permission denied.') },
      { response: nativeSuccess('tokenless.native.list_history', refreshedHistory) },
    ])
    try {
      const { page, pageErrors } = partial
      await page.getByText('Partially loaded', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByText('Configuration permission denied.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Activity', exact: true }).click()
      await page.getByText('History only refresh', { exact: true }).waitFor()
      assert.equal(await page.locator('#configuration [role="alert"]').count(), 1)
      assert.deepEqual(pageErrors, [])
    } finally {
      await partial.context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test('provider content uses only visible controls and snapshots a fail-closed real DOM', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })

  try {
    const chatgpt = await openProviderFixture(
      browser,
      'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174007?secret-query-marker=yes#secret-hash-marker',
      `
      <!doctype html>
      <html data-document-secret="secret-document-marker">
        <head><title>secret-title-marker</title></head>
        <body>
          <!-- secret-comment-marker -->
          <div style="opacity:0">
            <div id="prompt-textarea" contenteditable="true">ancestor-opacity-composer-marker</div>
          </div>
          <div style="content-visibility:hidden">
            <div id="content-hidden-composer" role="textbox" contenteditable="true">content-hidden-composer-marker</div>
          </div>
          <div style="position:fixed;left:-9999px;top:0">
            <div id="offscreen-composer" role="textbox" contenteditable="true">offscreen-composer-marker</div>
          </div>
          <div id="visible-composer" role="textbox" contenteditable="true"></div>
          <div style="visibility:hidden">
            <button data-testid="send-button" onclick="globalThis.__clicked.push('ancestor-hidden')">Ancestor hidden send</button>
          </div>
          <div style="content-visibility:hidden">
            <button data-testid="send-button" onclick="globalThis.__clicked.push('content-hidden')">Content hidden send</button>
          </div>
          <div style="position:fixed;left:-9999px;top:0">
            <button data-testid="send-button" onclick="globalThis.__clicked.push('offscreen')">Offscreen send</button>
          </div>
          <button data-testid="send-button" onclick="globalThis.__clicked.push('visible'); this.disabled = true; this.setAttribute('aria-disabled', 'true')">Visible send</button>
          <div style="opacity:0">
            <div aria-label="captcha hidden-blocker-marker">hidden-blocker-text-marker</div>
          </div>
          <p id="visible-copy">visible-snapshot-copy</p>
          <div style="display:none">
            <div
              id="secret-id-marker"
              class="secret-class-marker"
              data-secret="secret-data-marker"
              onclick="secret-event-marker"
              title="secret-attribute-marker"
            >secret-text-marker</div>
            <form action="/secret-form-marker">
              <input name="secret-name-marker" value="secret-value-marker" data-auth="secret-auth-marker">
              <button formaction="/secret-formaction-marker" type="button">secret-form-control-marker</button>
            </form>
            <a href="/secret-url-marker" aria-label="secret-label-marker">secret-link-marker</a>
          </div>
          <script>globalThis.__clicked = []</script>
        </body>
      </html>
    `)

    try {
      const request = {
        provider: 'chatgpt',
        requestId: 'visible-controls',
        prompt: 'visible prompt only',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
      }
      const submit = await chatgpt.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      assert.equal(submit.provider, 'chatgpt')
      assert.equal(await chatgpt.page.locator('#prompt-textarea').textContent(), 'ancestor-opacity-composer-marker')
      assert.equal(await chatgpt.page.locator('#content-hidden-composer').textContent(), 'content-hidden-composer-marker')
      assert.equal(await chatgpt.page.locator('#offscreen-composer').textContent(), 'offscreen-composer-marker')
      assert.match(await chatgpt.page.locator('#visible-composer').textContent(), /visible prompt only/)
      assert.deepEqual(await chatgpt.page.evaluate(() => globalThis.__clicked), ['visible'])

      const snapshot = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.snapshot_dom',
        request: {
          provider: 'chatgpt',
          requestId: 'snapshot-default-redaction',
          metadata: { includeText: false },
        },
      }))
      assert.equal(snapshot.status, 'snapshotted')
      assert.equal(snapshot.sanitized, true)
      assert.equal(snapshot.includeText, false)
      assert.equal(snapshot.visibleText, undefined)
      assert.equal(snapshot.url, 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174007')
      assert.match(snapshot.html, /\[text\]/)
      assert.match(snapshot.html, /\[structural\]/)
      assert.doesNotMatch(snapshot.html, /secret-(?:document|title|id|class|data|event|attribute|text|form|name|value|auth|formaction|url|label|link|composer|blocker)/i)
      assert.doesNotMatch(snapshot.html, /\s(?:data-[^=\s]*|style|on\w+|value|name|action|formaction|href)=/i)
      assert.doesNotMatch(snapshot.html, /secret-comment-marker/)
      assert.doesNotMatch(
        JSON.stringify(snapshot),
        /secret-(?:query|hash|title|comment|document|id|class|data|event|attribute|text|form|name|value|auth|formaction|url|label|link)|(?:ancestor-opacity|content-hidden|offscreen|hidden-blocker)-(?:composer|text)?-?marker/i
      )

      const textSnapshot = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.snapshot_dom',
        request: {
          provider: 'chatgpt',
          requestId: 'snapshot-visible-text-only',
          includeText: true,
        },
      }))
      assert.equal(textSnapshot.status, 'snapshotted')
      assert.equal(textSnapshot.title, '[text]')
      assert.match(textSnapshot.html, /visible prompt only/)
      assert.match(textSnapshot.html, /visible-snapshot-copy/)
      assert.match(textSnapshot.visibleText, /visible prompt only/)
      assert.doesNotMatch(
        JSON.stringify(textSnapshot),
        /secret-(?:query|hash|title|comment|id|class|data|event|attribute|text|form|name|value|auth|formaction|url|label|link)|(?:ancestor-opacity|content-hidden|offscreen|hidden-blocker)-(?:composer|text)?-?marker/i
      )

      const malformed = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.snapshot_dom',
        request: { provider: 'chatgpt', requestId: 'snapshot-malformed', includeText: 'false' },
      }))
      assert.equal(malformed.status, 'blocked')
      assert.equal(malformed.stopReason, 'invalid_include_text')

      const wrongProvider = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.read',
        request: { provider: 'gemini', requestId: 'wrong-provider', readTimeoutMs: 0 },
      }))
      assert.equal(wrongProvider.status, 'blocked')
      assert.equal(wrongProvider.stopReason, 'provider_context_mismatch')

      const wrongTarget = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.read',
        request: {
          provider: 'chatgpt',
          requestId: 'wrong-target',
          targetUrl: 'https://chatgpt.com/another-conversation',
          readTimeoutMs: 0,
        },
      }))
      assert.equal(wrongTarget.status, 'blocked')
      assert.equal(wrongTarget.stopReason, 'target_context_mismatch')
      const preSubmitPathDrift = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.submit',
        request: {
          provider: 'chatgpt',
          requestId: 'pre-submit-path-drift',
          targetUrl: 'https://chatgpt.com/',
          prompt: 'Must not submit after pre-submit path drift.',
          composerTimeoutMs: 100,
          submitTimeoutMs: 100,
        },
      }))
      assert.equal(preSubmitPathDrift.status, 'blocked')
      assert.equal(preSubmitPathDrift.stopReason, 'target_context_mismatch')
      assert.deepEqual(chatgpt.pageErrors, [])
    } finally {
      await chatgpt.context.close()
    }

    const claude = await openProviderFixture(
      browser,
      'https://claude.ai/new',
      readText('test/fixtures/claude-real-dom-fixture.html')
    )
    try {
      await claude.page.evaluate(() => {
        const ordinaryContinue = document.createElement('button')
        ordinaryContinue.id = 'ordinary-claude-continue'
        ordinaryContinue.type = 'button'
        ordinaryContinue.dataset.testid = 'continue'
        ordinaryContinue.textContent = 'Continue writing'
        document.querySelector('header')?.append(ordinaryContinue)
      })
      const submit = await claude.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.submit',
        request: {
          provider: 'claude',
          requestId: 'claude-disabled-send',
          targetUrl: 'https://claude.ai/new',
          prompt: 'Enable the visible send button.',
          composerTimeoutMs: 100,
          submitTimeoutMs: 100,
          readTimeoutMs: 2000,
        },
      }))
      assert.equal(submit.status, 'submitted')
      assert.equal(await claude.page.locator('#ordinary-claude-continue').isVisible(), true)
      assert.equal(await claude.page.locator('.message-row[data-role="user"]').count(), 2)
      assert.equal(
        await claude.page.locator('[data-testid="chat-input"]').getAttribute('aria-label'),
        'Write your prompt to Claude'
      )
      assert.equal(await claude.page.locator('[data-testid="file-upload"]').count(), 1)
      const request = {
        provider: 'claude',
        requestId: 'claude-disabled-send',
        targetUrl: 'https://claude.ai/new',
        prompt: 'Enable the visible send button.',
        readTimeoutMs: 2000,
      }
      await claude.page.waitForURL(
        'https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174001'
      )
      await claude.page.evaluate(() => {
        const answers = [...document.querySelectorAll('.font-claude-response-body')]
        const answer = answers.at(-1)
        const loginCitation = document.createElement('a')
        loginCitation.href = '/login'
        loginCitation.textContent = 'Authentication guide'
        answer?.append(' ', loginCitation)
      })
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'claude-transition-proof-001')
      const read = await claude.page.evaluate(({ contentRequest, answerBaseline, transitionProof }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: {
            ...contentRequest,
            answerBaseline,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: transitionProof,
          },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline, transitionProof: proof })
      assert.equal(read.status, 'read')
      assert.match(read.text, /visible Claude real-DOM fixture answer for: Enable the visible send button\./)
      assert.match(read.text, /Authentication guide/)
      assert.doesNotMatch(read.text, /stale Claude real-DOM fixture answer/)
      assert.doesNotMatch(read.text, /_streaming/)
      assert.equal(read.url, 'https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174001')
      for (const unsafePath of ['/chat/settings', '/chat/settings123']) {
        await claude.page.evaluate((pathname) => {
          history.replaceState({}, '', pathname)
          const answers = [...document.querySelectorAll('.font-claude-response-body')]
          const answer = answers.at(-1)
          if (answer) answer.textContent = 'Misleading Claude settings answer'
        }, unsafePath)
        const blocked = await dispatchPostSubmitRead(claude.page, request, submit.answerBaseline, proof)
        assert.equal(blocked.status, 'blocked')
        assert.equal(blocked.stopReason, 'target_context_mismatch')
        assert.doesNotMatch(JSON.stringify(blocked), /Misleading Claude settings answer/)
      }
      assert.deepEqual(claude.pageErrors, [])
    } finally {
      await claude.context.close()
    }

    const claudeLoginBlocker = await openProviderFixture(
      browser,
      'https://claude.ai/new',
      readText('test/fixtures/claude-real-dom-fixture.html')
    )
    try {
      await claudeLoginBlocker.page.evaluate(() => {
        const loginForm = document.createElement('form')
        loginForm.setAttribute('aria-label', 'Sign in to Claude')
        loginForm.style.cssText = 'position:fixed;left:300px;top:80px;z-index:50;padding:20px;background:white'

        const email = document.createElement('input')
        email.placeholder = 'Enter your email'
        email.setAttribute('aria-label', 'Email address')

        const continueButton = document.createElement('button')
        continueButton.type = 'button'
        continueButton.dataset.testid = 'continue'
        continueButton.textContent = 'Continue'

        loginForm.append(email, continueButton)
        document.body.append(loginForm)
      })
      const blocked = await claudeLoginBlocker.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.submit',
        request: {
          provider: 'claude',
          requestId: 'claude-visible-login-blocker',
          targetUrl: 'https://claude.ai/new',
          prompt: 'This prompt must not be submitted through a visible login form.',
          composerTimeoutMs: 100,
          submitTimeoutMs: 100,
        },
      }))
      assert.equal(blocked.status, 'blocked')
      assert.equal(blocked.stopReason, 'provider_blocker_visible')
      assert.match(blocked.message, /Continue/)
      assert.equal(await claudeLoginBlocker.page.locator('.message-row[data-role="user"]').count(), 1)
      assert.deepEqual(claudeLoginBlocker.pageErrors, [])
    } finally {
      await claudeLoginBlocker.context.close()
    }

    for (const driftTarget of ['composer', 'submit']) {
      const claudeSelectorDrift = await openProviderFixture(
        browser,
        'https://claude.ai/new',
        readText('test/fixtures/claude-real-dom-fixture.html')
      )
      try {
        await claudeSelectorDrift.page.evaluate((target) => {
          if (target === 'composer') {
            const composer = document.querySelector('[data-testid="chat-input"]')
            composer.id = 'drifted-claude-composer'
            composer.removeAttribute('data-testid')
            composer.removeAttribute('aria-label')
            composer.removeAttribute('role')
            composer.className = 'fixture-drifted-composer'
            return
          }
          const send = document.querySelector('button[aria-label="Send message"]')
          send.id = 'drifted-claude-submit'
          send.removeAttribute('aria-label')
          send.removeAttribute('data-cds')
        }, driftTarget)
        const blocked = await claudeSelectorDrift.page.evaluate((target) => globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.submit',
          request: {
            provider: 'claude',
            requestId: `claude-${target}-selector-drift`,
            targetUrl: 'https://claude.ai/new',
            prompt: `This prompt must not pass the drifted Claude ${target} contract.`,
            composerTimeoutMs: 100,
            submitTimeoutMs: 100,
          },
        }), driftTarget)
        assert.equal(blocked.status, 'blocked')
        assert.equal(blocked.stopReason, 'selector_drift')
        assert.match(blocked.message, new RegExp(`Provider ${driftTarget} selector`))
        assert.equal(await claudeSelectorDrift.page.locator('.message-row[data-role="user"]').count(), 1)
        assert.deepEqual(claudeSelectorDrift.pageErrors, [])
      } finally {
        await claudeSelectorDrift.context.close()
      }
    }

    const claudeAnswerDrift = await openProviderFixture(
      browser,
      'https://claude.ai/new',
      readText('test/fixtures/claude-real-dom-fixture.html')
    )
    try {
      const answerDriftRequest = {
        provider: 'claude',
        requestId: 'claude-answer-selector-drift',
        targetUrl: 'https://claude.ai/new',
        prompt: 'Answer selector contract drift.',
        readTimeoutMs: 0,
      }
      const submit = await claudeAnswerDrift.page.evaluate((request) => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.submit',
        request: {
          ...request,
          composerTimeoutMs: 100,
          submitTimeoutMs: 100,
        },
      }), answerDriftRequest)
      assert.equal(submit.status, 'submitted')
      await claudeAnswerDrift.page.waitForURL(
        'https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174001'
      )
      await claudeAnswerDrift.page.evaluate(() => {
        for (const answer of document.querySelectorAll('.font-claude-response-body')) {
          answer.classList.remove('font-claude-response-body')
          answer.setAttribute('data-answer-contract', 'drifted')
        }
      })
      const proof = postSubmitTransitionProof(
        answerDriftRequest,
        submit.answerBaseline,
        'claude-answer-drift-proof-001'
      )
      const blocked = await dispatchPostSubmitRead(
        claudeAnswerDrift.page,
        answerDriftRequest,
        submit.answerBaseline,
        proof
      )
      assert.equal(blocked.status, 'blocked')
      assert.equal(blocked.stopReason, 'response_unavailable')
      assert.doesNotMatch(JSON.stringify(blocked), /visible Claude real-DOM fixture answer/)
      assert.deepEqual(claudeAnswerDrift.pageErrors, [])
    } finally {
      await claudeAnswerDrift.context.close()
    }

    const gemini = await openProviderFixture(
      browser,
      'https://gemini.google.com/app',
      readText('test/fixtures/gemini-real-dom-fixture.html')
    )
    try {
      assert.equal(await gemini.page.locator('button[aria-label="Send message"]').count(), 0)
      assert.equal(await gemini.page.locator('a[aria-label="Sign in"][href^="https://accounts.google.com/ServiceLogin"]').isVisible(), true)
      assert.equal(await gemini.page.locator('button[data-test-id="bard-mode-menu-button"][aria-label^="Open mode picker, currently "]').isVisible(), true)
      assert.equal(await gemini.page.locator('button[aria-label="Upload & tools"][aria-haspopup="menu"]').isVisible(), true)
      const request = {
        provider: 'gemini',
        requestId: 'gemini-conversation-transition',
        targetUrl: 'https://gemini.google.com/app',
        prompt: 'Start the visible Gemini conversation.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 2000,
      }
      const submit = await gemini.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      assert.deepEqual(submit.answerBaseline, {
        count: 1,
        lastText: 'stale Gemini real-DOM fixture answer that must not be read',
      })
      assert.equal(await gemini.page.locator('button[aria-label="Stop response"]').isVisible(), true)
      assert.match(
        await gemini.page.locator('response-container message-content').last().textContent(),
        /answer_streaming/
      )
      assert.equal(await gemini.page.locator('button[aria-label="Send message"]').count(), 0)
      assert.equal(await gemini.page.locator('user-query').count(), 2)
      assert.match(await gemini.page.locator('user-query').last().textContent(), /Start the visible Gemini conversation\./)
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'gemini-transition-proof-001')
      const read = await gemini.page.evaluate(({ contentRequest, answerBaseline, transitionProof }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: {
            ...contentRequest,
            answerBaseline,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: transitionProof,
          },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline, transitionProof: proof })
      assert.equal(read.status, 'read')
      assert.equal(
        read.text,
        'visible Gemini real-DOM fixture answer for: Start the visible Gemini conversation.'
      )
      assert.doesNotMatch(read.text, /stale Gemini real-DOM fixture answer/)
      assert.doesNotMatch(read.text, /_streaming/)
      assert.equal(read.url, 'https://gemini.google.com/app/4b9f2c7d1e6a')
      assert.equal(await gemini.page.locator('button[aria-label="Stop response"]').count(), 0)
      for (const unsafePath of ['/app/settings', '/app/settings123']) {
        await gemini.page.evaluate((pathname) => {
          history.replaceState({}, '', pathname)
          const answers = [...document.querySelectorAll('response-container message-content')]
          const answer = answers.at(-1)
          if (answer) answer.textContent = 'Misleading Gemini settings answer'
        }, unsafePath)
        const blocked = await dispatchPostSubmitRead(gemini.page, request, submit.answerBaseline, proof)
        assert.equal(blocked.status, 'blocked')
        assert.equal(blocked.stopReason, 'target_context_mismatch')
        assert.doesNotMatch(JSON.stringify(blocked), /Misleading Gemini settings answer/)
      }
      assert.deepEqual(gemini.pageErrors, [])
    } finally {
      await gemini.context.close()
    }

    const geminiChallengeBlocker = await openProviderFixture(
      browser,
      'https://gemini.google.com/app',
      readText('test/fixtures/gemini-real-dom-fixture.html')
    )
    try {
      await geminiChallengeBlocker.context.route(
        'https://www.google.com/recaptcha/**',
        (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' })
      )
      await geminiChallengeBlocker.page.evaluate(() => {
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        dialog.setAttribute('aria-label', 'Complete the security challenge')

        const challenge = document.createElement('iframe')
        challenge.src = 'https://www.google.com/recaptcha/api2/anchor'
        challenge.title = 'reCAPTCHA'
        challenge.style.cssText = 'display:block;width:280px;height:80px;border:0'

        dialog.append(challenge)
        document.body.append(dialog)
      })
      const blocked = await geminiChallengeBlocker.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.submit',
        request: {
          provider: 'gemini',
          requestId: 'gemini-visible-challenge-blocker',
          targetUrl: 'https://gemini.google.com/app',
          prompt: 'This prompt must not be submitted through a visible challenge.',
          composerTimeoutMs: 100,
          submitTimeoutMs: 100,
        },
      }))
      assert.equal(blocked.status, 'blocked')
      assert.equal(blocked.stopReason, 'provider_blocker_visible')
      assert.equal(await geminiChallengeBlocker.page.locator('user-query').count(), 1)
      assert.equal(await geminiChallengeBlocker.page.locator('button[aria-label="Send message"]').count(), 0)
      assert.deepEqual(geminiChallengeBlocker.pageErrors, [])
    } finally {
      await geminiChallengeBlocker.context.close()
    }

    for (const driftTarget of ['composer', 'submit']) {
      const geminiSelectorDrift = await openProviderFixture(
        browser,
        'https://gemini.google.com/app',
        readText('test/fixtures/gemini-real-dom-fixture.html')
      )
      try {
        await geminiSelectorDrift.page.evaluate((target) => {
          if (target === 'composer') {
            const composer = document.querySelector('rich-textarea .ql-editor')
            composer.id = 'drifted-gemini-composer'
            composer.removeAttribute('data-gramm')
            composer.removeAttribute('aria-label')
            composer.className = 'fixture-drifted-composer'
            return
          }

          const sendSlot = document.querySelector('#send-slot')
          const observer = new MutationObserver(() => {
            const send = sendSlot.querySelector('button[aria-label="Send message"]')
            if (!send) return
            send.id = 'drifted-gemini-submit'
            send.removeAttribute('aria-label')
            observer.disconnect()
          })
          observer.observe(sendSlot, { childList: true })
        }, driftTarget)
        const blocked = await geminiSelectorDrift.page.evaluate((target) => globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.submit',
          request: {
            provider: 'gemini',
            requestId: `gemini-${target}-selector-drift`,
            targetUrl: 'https://gemini.google.com/app',
            prompt: `This prompt must not pass the drifted Gemini ${target} contract.`,
            composerTimeoutMs: 100,
            submitTimeoutMs: 100,
          },
        }), driftTarget)
        assert.equal(blocked.status, 'blocked')
        assert.equal(blocked.stopReason, 'selector_drift')
        assert.match(blocked.message, new RegExp(`Provider ${driftTarget} selector`))
        assert.equal(await geminiSelectorDrift.page.locator('user-query').count(), 1)
        assert.deepEqual(geminiSelectorDrift.pageErrors, [])
      } finally {
        await geminiSelectorDrift.context.close()
      }
    }

    const geminiAnswerDrift = await openProviderFixture(
      browser,
      'https://gemini.google.com/app',
      readText('test/fixtures/gemini-real-dom-fixture.html')
    )
    try {
      const answerDriftRequest = {
        provider: 'gemini',
        requestId: 'gemini-answer-selector-drift',
        targetUrl: 'https://gemini.google.com/app',
        prompt: 'Answer selector contract drift.',
        readTimeoutMs: 0,
      }
      const submit = await geminiAnswerDrift.page.evaluate((request) => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.submit',
        request: {
          ...request,
          composerTimeoutMs: 100,
          submitTimeoutMs: 100,
        },
      }), answerDriftRequest)
      assert.equal(submit.status, 'submitted')
      await geminiAnswerDrift.page.waitForURL('https://gemini.google.com/app/4b9f2c7d1e6a')
      await geminiAnswerDrift.page.evaluate(() => {
        for (const answer of document.querySelectorAll('response-container message-content')) {
          const drifted = document.createElement('div')
          drifted.dataset.answerContract = 'drifted'
          drifted.textContent = answer.textContent
          answer.replaceWith(drifted)
        }
      })
      const proof = postSubmitTransitionProof(
        answerDriftRequest,
        submit.answerBaseline,
        'gemini-answer-drift-proof-001'
      )
      const blocked = await dispatchPostSubmitRead(
        geminiAnswerDrift.page,
        answerDriftRequest,
        submit.answerBaseline,
        proof
      )
      assert.equal(blocked.status, 'blocked')
      assert.equal(blocked.stopReason, 'response_unavailable')
      assert.doesNotMatch(JSON.stringify(blocked), /visible Gemini real-DOM fixture answer/)
      assert.deepEqual(geminiAnswerDrift.pageErrors, [])
    } finally {
      await geminiAnswerDrift.context.close()
    }

    const grok = await openProviderFixture(
      browser,
      'https://grok.com/',
      readText('test/fixtures/grok-real-dom-fixture.html')
    )
    try {
      assert.equal(await grok.page.getByRole('button', { name: 'Sign in', exact: true }).isVisible(), true)
      assert.equal(await grok.page.locator('button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]').isVisible(), true)
      assert.equal(await grok.page.locator('button[data-testid="attach-button"][aria-label="Attach"][aria-haspopup="menu"]').isVisible(), true)
      assert.equal(await grok.page.locator('input[type="file"][name="files"][multiple]').count(), 1)
      const request = {
        provider: 'grok',
        requestId: 'grok-conversation-transition',
        targetUrl: 'https://grok.com/',
        prompt: 'Start the visible Grok conversation.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 2000,
      }
      const submit = await grok.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      assert.deepEqual(submit.answerBaseline, {
        count: 1,
        lastText: 'stale Grok real-DOM fixture answer that must not be read',
      })
      assert.equal(await grok.page.locator('[data-testid="user-message"]').count(), 2)
      assert.equal(
        await grok.page.locator('[data-testid="user-message"]').last().textContent(),
        'Start the visible Grok conversation.'
      )
      assert.equal(await grok.page.locator('button[data-testid="chat-submit"]').isDisabled(), true)
      await grok.page.waitForURL('https://grok.com/c/123e4567-e89b-12d3-a456-426614174003')
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'grok-transition-proof-001')
      const read = await dispatchPostSubmitRead(grok.page, request, submit.answerBaseline, proof)
      assert.equal(read.status, 'read')
      assert.equal(
        read.text,
        'visible Grok real-DOM fixture answer for: Start the visible Grok conversation.'
      )
      assert.doesNotMatch(read.text, /stale Grok real-DOM fixture answer/)
      assert.equal(read.url, 'https://grok.com/c/123e4567-e89b-12d3-a456-426614174003')
      for (const unsafePath of ['/c/settings', '/c/settings123']) {
        await grok.page.evaluate((pathname) => {
          history.replaceState({}, '', pathname)
          const answer = document.querySelectorAll('[data-testid="assistant-message"]')
          answer[answer.length - 1].textContent = 'Misleading Grok settings answer'
        }, unsafePath)
        const blocked = await dispatchPostSubmitRead(grok.page, request, submit.answerBaseline, proof)
        assert.equal(blocked.status, 'blocked')
        assert.equal(blocked.stopReason, 'target_context_mismatch')
        assert.doesNotMatch(JSON.stringify(blocked), /Misleading Grok settings answer/)
      }
      assert.deepEqual(grok.pageErrors, [])
    } finally {
      await grok.context.close()
    }

    const grokTextarea = await openProviderFixture(
      browser,
      'https://grok.com/',
      readText('test/fixtures/grok-real-dom-fixture.html')
    )
    try {
      await grokTextarea.page.evaluate(() => {
        const contenteditable = document.querySelector('div[aria-label="Ask Grok anything"]')
        const textarea = document.createElement('textarea')
        textarea.setAttribute('aria-label', 'Ask Grok anything')
        textarea.placeholder = 'What do you want to know?'
        contenteditable.replaceWith(textarea)
      })
      const request = {
        provider: 'grok',
        requestId: 'grok-textarea-composer',
        targetUrl: 'https://grok.com/',
        prompt: 'Use the observed Grok textarea composer.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 2000,
      }
      const submit = await grokTextarea.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      assert.equal(
        await grokTextarea.page.locator('[data-testid="user-message"]').last().textContent(),
        'Use the observed Grok textarea composer.'
      )
      await grokTextarea.page.waitForURL('https://grok.com/c/123e4567-e89b-12d3-a456-426614174003')
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'grok-textarea-proof-001')
      const read = await dispatchPostSubmitRead(grokTextarea.page, request, submit.answerBaseline, proof)
      assert.equal(read.status, 'read')
      assert.equal(
        read.text,
        'visible Grok real-DOM fixture answer for: Use the observed Grok textarea composer.'
      )
      assert.deepEqual(grokTextarea.pageErrors, [])
    } finally {
      await grokTextarea.context.close()
    }

    const grokAnonymousPaywall = await openProviderFixture(
      browser,
      'https://grok.com/',
      readText('test/fixtures/grok-real-dom-fixture.html')
    )
    try {
      await grokAnonymousPaywall.page.evaluate(() => {
        globalThis.__fixtureGrokAnonymousPaywallDelayMs = 200
      })
      const request = {
        provider: 'grok',
        requestId: 'grok-anonymous-paywall',
        targetUrl: 'https://grok.com/',
        prompt: 'Reach the visible anonymous Grok account gate.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 2000,
      }
      const submit = await grokAnonymousPaywall.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      assert.equal(await grokAnonymousPaywall.page.locator('[data-testid="user-message"]').count(), 2)
      assert.equal(await grokAnonymousPaywall.page.locator('[data-testid="assistant-message"]').count(), 1)
      const blockerWaitStartedAt = Date.now()
      const blocked = await grokAnonymousPaywall.page.evaluate(({ contentRequest, answerBaseline }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: { ...contentRequest, answerBaseline },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline })
      assert.equal(blocked.status, 'blocked')
      assert.equal(blocked.stopReason, 'provider_blocker_visible')
      assert.match(blocked.message, /Continue your conversation/)
      assert.ok(Date.now() - blockerWaitStartedAt < 1500, 'late Grok paywall must interrupt answer waiting')
      assert.deepEqual(grokAnonymousPaywall.pageErrors, [])
    } finally {
      await grokAnonymousPaywall.context.close()
    }

    for (const driftTarget of ['composer', 'submit']) {
      const grokSelectorDrift = await openProviderFixture(
        browser,
        'https://grok.com/',
        readText('test/fixtures/grok-real-dom-fixture.html')
      )
      try {
        await grokSelectorDrift.page.evaluate((target) => {
          if (target === 'composer') {
            const composer = document.querySelector('div[aria-label="Ask Grok anything"]')
            composer.id = 'drifted-grok-composer'
            composer.className = 'fixture-drifted-composer'
            composer.removeAttribute('aria-label')
            composer.removeAttribute('aria-multiline')
            composer.removeAttribute('role')
            return
          }
          const send = document.querySelector('button[data-testid="chat-submit"]')
          send.id = 'drifted-grok-submit'
          send.removeAttribute('data-testid')
          send.removeAttribute('aria-label')
          send.removeAttribute('type')
        }, driftTarget)
        const blocked = await grokSelectorDrift.page.evaluate((target) => globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.submit',
          request: {
            provider: 'grok',
            requestId: `grok-${target}-selector-drift`,
            targetUrl: 'https://grok.com/',
            prompt: `This prompt must not pass the drifted Grok ${target} contract.`,
            composerTimeoutMs: 100,
            submitTimeoutMs: 100,
          },
        }), driftTarget)
        assert.equal(blocked.status, 'blocked')
        assert.equal(blocked.stopReason, 'selector_drift')
        assert.match(blocked.message, new RegExp(`Provider ${driftTarget} selector`))
        assert.equal(await grokSelectorDrift.page.locator('[data-testid="user-message"]').count(), 1)
        assert.deepEqual(grokSelectorDrift.pageErrors, [])
      } finally {
        await grokSelectorDrift.context.close()
      }
    }

    const grokAnswerDrift = await openProviderFixture(
      browser,
      'https://grok.com/',
      readText('test/fixtures/grok-real-dom-fixture.html')
    )
    try {
      const answerDriftRequest = {
        provider: 'grok',
        requestId: 'grok-answer-selector-drift',
        targetUrl: 'https://grok.com/',
        prompt: 'Answer selector contract drift.',
        readTimeoutMs: 0,
      }
      const submit = await grokAnswerDrift.page.evaluate((request) => globalThis.__dispatchTokenlessMessage({
        type: 'tokenless.bridge.submit',
        request: {
          ...request,
          composerTimeoutMs: 100,
          submitTimeoutMs: 100,
        },
      }), answerDriftRequest)
      assert.equal(submit.status, 'submitted')
      await grokAnswerDrift.page.waitForURL('https://grok.com/c/123e4567-e89b-12d3-a456-426614174003')
      await grokAnswerDrift.page.evaluate(() => {
        for (const answer of document.querySelectorAll('[data-testid="assistant-message"]')) {
          answer.dataset.testid = 'drifted-assistant-message'
        }
      })
      const proof = postSubmitTransitionProof(
        answerDriftRequest,
        submit.answerBaseline,
        'grok-answer-drift-proof-001'
      )
      const blocked = await dispatchPostSubmitRead(
        grokAnswerDrift.page,
        answerDriftRequest,
        submit.answerBaseline,
        proof
      )
      assert.equal(blocked.status, 'blocked')
      assert.equal(blocked.stopReason, 'response_unavailable')
      assert.doesNotMatch(JSON.stringify(blocked), /visible Grok real-DOM fixture answer/)
      assert.deepEqual(grokAnswerDrift.pageErrors, [])
    } finally {
      await grokAnswerDrift.context.close()
    }

    const landingTransition = await openProviderFixture(browser, 'https://chatgpt.com/', `
      <!doctype html>
      <html>
        <body>
          <div id="landing-composer" role="textbox" contenteditable="true"></div>
          <button id="landing-send" data-testid="send-button">Send</button>
          <main id="answers"></main>
          <script>
            document.querySelector('#landing-send').addEventListener('click', () => {
              history.pushState({}, '', '/c/123e4567-e89b-12d3-a456-426614174002?private-query-marker=yes#private-hash-marker')
              const answer = document.createElement('div')
              answer.setAttribute('data-message-author-role', 'assistant')
              answer.textContent = 'Landing transition answer'
              document.querySelector('#answers').append(answer)
            })
          </script>
        </body>
      </html>
    `)
    try {
      const request = {
        provider: 'chatgpt',
        requestId: 'landing-transition',
        targetUrl: 'https://chat.openai.com/',
        prompt: 'Start a new conversation.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 2000,
      }
      const submit = await landingTransition.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      assert.equal(submit.url, 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174002')

      const exactRead = await landingTransition.page.evaluate(({ contentRequest, answerBaseline }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: { ...contentRequest, answerBaseline },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline })
      assert.equal(exactRead.status, 'blocked')
      assert.equal(exactRead.stopReason, 'target_context_mismatch')

      const transitionProof = postSubmitTransitionProof(request, submit.answerBaseline)
      const transitionValidation = await dispatchPostSubmitValidation(
        landingTransition.page,
        request,
        submit.answerBaseline,
        transitionProof
      )
      assert.equal(transitionValidation.status, 'ready')
      const read = await landingTransition.page.evaluate(({ contentRequest, answerBaseline, proof }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: {
            ...contentRequest,
            answerBaseline,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: proof,
          },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline, proof: transitionProof })
      assert.equal(read.status, 'read')
      assert.equal(read.text, 'Landing transition answer')
      assert.equal(read.url, 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174002')
      assert.deepEqual(landingTransition.pageErrors, [])
    } finally {
      await landingTransition.context.close()
    }

    const customGptTransition = await openProviderFixture(browser, 'https://chatgpt.com/g/g-pmuQfob8d', `
      <!doctype html>
      <html>
        <body>
          <div role="textbox" contenteditable="true"></div>
          <button data-testid="send-button">Send</button>
          <main id="answers"></main>
          <script>
            document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
              history.pushState({}, '', '/g/g-pmuQfob8d/c/123e4567-e89b-12d3-a456-426614174003')
              const answer = document.createElement('div')
              answer.setAttribute('data-message-author-role', 'assistant')
              answer.textContent = 'Custom GPT conversation answer'
              document.querySelector('#answers').append(answer)
            })
          </script>
        </body>
      </html>
    `)
    try {
      const request = {
        provider: 'chatgpt',
        requestId: 'custom-gpt-transition',
        targetUrl: 'https://chatgpt.com/g/g-pmuQfob8d',
        prompt: 'Start the custom GPT conversation.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 2000,
      }
      const submit = await customGptTransition.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'custom-gpt-transition-proof')
      const validation = await dispatchPostSubmitValidation(
        customGptTransition.page,
        request,
        submit.answerBaseline,
        proof
      )
      assert.equal(validation.status, 'ready')
      const read = await customGptTransition.page.evaluate(({ contentRequest, answerBaseline, transitionProof }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: {
            ...contentRequest,
            answerBaseline,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: transitionProof,
          },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline, transitionProof: proof })
      assert.equal(read.status, 'read')
      assert.equal(read.text, 'Custom GPT conversation answer')
      assert.equal(read.url, 'https://chatgpt.com/g/g-pmuQfob8d/c/123e4567-e89b-12d3-a456-426614174003')
      await customGptTransition.page.evaluate(() => {
        history.replaceState({}, '', '/g/g-otherGPT9/c/123e4567-e89b-12d3-a456-426614174008')
        const answer = document.querySelector('[data-message-author-role="assistant"]')
        if (answer) answer.textContent = 'Mismatched custom GPT answer'
      })
      const mismatchedRead = await dispatchPostSubmitRead(
        customGptTransition.page,
        request,
        submit.answerBaseline,
        proof
      )
      assert.equal(mismatchedRead.status, 'blocked')
      assert.equal(mismatchedRead.stopReason, 'target_context_mismatch')
      assert.doesNotMatch(JSON.stringify(mismatchedRead), /Mismatched custom GPT answer/)
      assert.deepEqual(customGptTransition.pageErrors, [])
    } finally {
      await customGptTransition.context.close()
    }

    const projectTransition = await openProviderFixture(
      browser,
      'https://chatgpt.com/g/g-p-12345678/project',
      `
        <!doctype html>
        <html>
          <body>
            <div role="textbox" contenteditable="true"></div>
            <button data-testid="send-button">Send</button>
            <main id="answers"></main>
            <script>
              document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
                history.pushState({}, '', '/g/g-p-12345678/c/123e4567-e89b-12d3-a456-426614174010')
                const answer = document.createElement('div')
                answer.setAttribute('data-message-author-role', 'assistant')
                answer.textContent = 'Project-isolated conversation answer'
                document.querySelector('#answers').append(answer)
              })
            </script>
          </body>
        </html>
      `
    )
    try {
      const request = {
        provider: 'chatgpt',
        requestId: 'project-transition',
        targetUrl: 'https://chatgpt.com/g/g-p-12345678/project',
        prompt: 'Start a project-isolated conversation.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 2000,
      }
      const submit = await projectTransition.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'project-transition-proof-001')
      const validation = await dispatchPostSubmitValidation(
        projectTransition.page,
        request,
        submit.answerBaseline,
        proof
      )
      assert.equal(validation.status, 'ready')
      const read = await dispatchPostSubmitRead(
        projectTransition.page,
        request,
        submit.answerBaseline,
        proof
      )
      assert.equal(read.status, 'read')
      assert.equal(read.text, 'Project-isolated conversation answer')
      await projectTransition.page.evaluate(() => {
        history.replaceState({}, '', '/g/g-p-87654321/c/123e4567-e89b-12d3-a456-426614174011')
        const answer = document.querySelector('[data-message-author-role="assistant"]')
        if (answer) answer.textContent = 'Cross-project answer must remain private'
      })
      const crossProjectRead = await dispatchPostSubmitRead(
        projectTransition.page,
        request,
        submit.answerBaseline,
        proof
      )
      assert.equal(crossProjectRead.status, 'blocked')
      assert.equal(crossProjectRead.stopReason, 'target_context_mismatch')
      assert.doesNotMatch(JSON.stringify(crossProjectRead), /Cross-project answer must remain private/)
      assert.deepEqual(projectTransition.pageErrors, [])
    } finally {
      await projectTransition.context.close()
    }

    const rootToCustomGpt = await openProviderFixture(browser, 'https://chatgpt.com/', `
      <!doctype html>
      <html>
        <body>
          <div role="textbox" contenteditable="true"></div>
          <button data-testid="send-button">Send</button>
          <main id="answers"></main>
          <script>
            document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
              history.pushState({}, '', '/g/g-pmuQfob8d/c/123e4567-e89b-12d3-a456-426614174009')
              const answer = document.createElement('div')
              answer.setAttribute('data-message-author-role', 'assistant')
              answer.textContent = 'Root to custom GPT answer'
              document.querySelector('#answers').append(answer)
            })
          </script>
        </body>
      </html>
    `)
    try {
      const request = {
        provider: 'chatgpt',
        requestId: 'root-to-custom-gpt',
        targetUrl: 'https://chatgpt.com/',
        prompt: 'Root may not authorize a custom GPT conversation.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 100,
      }
      const submit = await rootToCustomGpt.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'root-custom-negative-proof')
      const read = await dispatchPostSubmitRead(rootToCustomGpt.page, request, submit.answerBaseline, proof)
      assert.equal(read.status, 'blocked')
      assert.equal(read.stopReason, 'target_context_mismatch')
      assert.doesNotMatch(JSON.stringify(read), /Root to custom GPT answer/)
      assert.deepEqual(rootToCustomGpt.pageErrors, [])
    } finally {
      await rootToCustomGpt.context.close()
    }

    const unsafeSpaTransition = await openProviderFixture(browser, 'https://chatgpt.com/', `
      <!doctype html>
      <html>
        <body>
          <div role="textbox" contenteditable="true"></div>
          <button data-testid="send-button">Send</button>
          <main id="answers"></main>
          <script>
            document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
              history.pushState({}, '', '/c/settings')
              const misleading = document.createElement('div')
              misleading.setAttribute('data-message-author-role', 'assistant')
              misleading.textContent = 'Misleading settings answer'
              document.querySelector('#answers').append(misleading)
            })
          </script>
        </body>
      </html>
    `)
    try {
      const request = {
        provider: 'chatgpt',
        requestId: 'unsafe-spa-transition',
        targetUrl: 'https://chatgpt.com/',
        prompt: 'Never authorize a settings page.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 100,
      }
      const submit = await unsafeSpaTransition.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'unsafe-spa-transition-proof')
      const read = await unsafeSpaTransition.page.evaluate(({ contentRequest, answerBaseline, transitionProof }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: {
            ...contentRequest,
            answerBaseline,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: transitionProof,
          },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline, transitionProof: proof })
      assert.equal(read.status, 'blocked')
      assert.equal(read.stopReason, 'target_context_mismatch')
      assert.doesNotMatch(JSON.stringify(read), /Misleading settings answer/)
      await unsafeSpaTransition.page.evaluate(() => {
        history.replaceState({}, '', '/c/settings123')
      })
      const suffixedRead = await dispatchPostSubmitRead(
        unsafeSpaTransition.page,
        request,
        submit.answerBaseline,
        proof
      )
      assert.equal(suffixedRead.status, 'blocked')
      assert.equal(suffixedRead.stopReason, 'target_context_mismatch')
      assert.doesNotMatch(JSON.stringify(suffixedRead), /Misleading settings answer/)
      assert.deepEqual(unsafeSpaTransition.pageErrors, [])
    } finally {
      await unsafeSpaTransition.context.close()
    }

    const fullNavigation = await openProviderFixture(browser, 'https://chat.openai.com/', `
      <!doctype html>
      <html>
        <body>
          <div role="textbox" contenteditable="true"></div>
          <button data-testid="send-button">Send</button>
          <script>
            document.querySelector('[data-testid="send-button"]').addEventListener('click', (event) => {
              event.currentTarget.disabled = true
              event.currentTarget.setAttribute('aria-disabled', 'true')
              setTimeout(() => {
                location.assign('https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174004?navigation-secret=yes#navigation-secret')
              }, 25)
            })
          </script>
        </body>
      </html>
    `)
    try {
      await fullNavigation.context.route('https://chatgpt.com/**', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <!doctype html>
          <html>
            <body>
              <div role="textbox" contenteditable="true"></div>
              <button data-testid="send-button">Send</button>
              <div data-message-author-role="assistant">Full navigation answer</div>
            </body>
          </html>
        `,
      }))
      const request = {
        provider: 'chatgpt',
        requestId: 'full-navigation-transition',
        targetUrl: 'https://chat.openai.com/',
        prompt: 'Navigate across the ChatGPT landing alias.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 2000,
      }
      const navigation = fullNavigation.page.waitForURL('https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174004?navigation-secret=yes#navigation-secret')
      const submit = await fullNavigation.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      await navigation
      await fullNavigation.page.addScriptTag({
        path: path.join(extensionDist, 'content/provider-content.js'),
      })
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'full-navigation-proof-0001')
      const transitionValidation = await dispatchPostSubmitValidation(
        fullNavigation.page,
        request,
        submit.answerBaseline,
        proof
      )
      assert.equal(transitionValidation.status, 'ready')
      const read = await fullNavigation.page.evaluate(({ contentRequest, answerBaseline, transitionProof }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: {
            ...contentRequest,
            answerBaseline,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: transitionProof,
          },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline, transitionProof: proof })
      assert.equal(read.status, 'read')
      assert.equal(read.text, 'Full navigation answer')
      assert.equal(read.url, 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174004')
      await fullNavigation.page.evaluate(() => {
        document.querySelector('[role="textbox"]')?.remove()
        document.querySelector('[data-testid="send-button"]')?.remove()
        const answer = document.querySelector('[data-message-author-role="assistant"]')
        if (answer) answer.textContent = 'Misleading answer without a composer'
      })
      const missingSurfaceRequest = { ...request, landingTimeoutMs: 100 }
      const missingSurfaceValidation = await dispatchPostSubmitValidation(
        fullNavigation.page,
        missingSurfaceRequest,
        submit.answerBaseline,
        proof
      )
      assert.equal(missingSurfaceValidation.status, 'blocked')
      assert.equal(missingSurfaceValidation.stopReason, 'provider_landing_unavailable')
      const missingSurfaceRead = await dispatchPostSubmitRead(
        fullNavigation.page,
        request,
        submit.answerBaseline,
        proof
      )
      assert.equal(missingSurfaceRead.status, 'blocked')
      assert.equal(missingSurfaceRead.stopReason, 'post_submit_surface_unavailable')
      assert.doesNotMatch(JSON.stringify(missingSurfaceRead), /Misleading answer without a composer/)
      assert.deepEqual(fullNavigation.pageErrors, [])
    } finally {
      await fullNavigation.context.close()
    }

    const unsafeFullNavigation = await openProviderFixture(browser, 'https://chat.openai.com/', `
      <!doctype html>
      <html>
        <body>
          <div role="textbox" contenteditable="true"></div>
          <button data-testid="send-button">Send</button>
          <script>
            document.querySelector('[data-testid="send-button"]').addEventListener('click', (event) => {
              event.currentTarget.disabled = true
              event.currentTarget.setAttribute('aria-disabled', 'true')
              setTimeout(() => {
                location.assign('https://chatgpt.com/auth/login')
              }, 25)
            })
          </script>
        </body>
      </html>
    `)
    try {
      await unsafeFullNavigation.context.route('https://chatgpt.com/**', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <!doctype html>
          <html>
            <body>
              <div data-message-author-role="assistant">Misleading login answer</div>
            </body>
          </html>
        `,
      }))
      const request = {
        provider: 'chatgpt',
        requestId: 'unsafe-full-navigation',
        targetUrl: 'https://chat.openai.com/',
        prompt: 'Never authorize a login page.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 100,
      }
      const navigation = unsafeFullNavigation.page.waitForURL('https://chatgpt.com/auth/login')
      const submit = await unsafeFullNavigation.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      await navigation
      await unsafeFullNavigation.page.addScriptTag({
        path: path.join(extensionDist, 'content/provider-content.js'),
      })
      const proof = postSubmitTransitionProof(request, submit.answerBaseline, 'unsafe-full-navigation-proof')
      const read = await unsafeFullNavigation.page.evaluate(({ contentRequest, answerBaseline, transitionProof }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: {
            ...contentRequest,
            answerBaseline,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: transitionProof,
          },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline, transitionProof: proof })
      assert.equal(read.status, 'blocked')
      assert.equal(read.stopReason, 'target_context_mismatch')
      assert.doesNotMatch(JSON.stringify(read), /Misleading login answer/)
      assert.deepEqual(unsafeFullNavigation.pageErrors, [])
    } finally {
      await unsafeFullNavigation.context.close()
    }

    const conversationTransition = await openProviderFixture(browser, 'https://chatgpt.com/c/existing', `
      <!doctype html>
      <html>
        <body>
          <div role="textbox" contenteditable="true"></div>
          <button data-testid="send-button">Send</button>
          <main id="answers"></main>
          <script>
            document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
              history.pushState({}, '', '/c/unexpected-conversation')
              const answer = document.createElement('div')
              answer.setAttribute('data-message-author-role', 'assistant')
              answer.textContent = 'Must remain blocked'
              document.querySelector('#answers').append(answer)
            })
          </script>
        </body>
      </html>
    `)
    try {
      const request = {
        provider: 'chatgpt',
        requestId: 'conversation-transition',
        targetUrl: 'https://chatgpt.com/c/existing',
        prompt: 'Stay in this conversation.',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
        readTimeoutMs: 100,
      }
      const submit = await conversationTransition.page.evaluate((contentRequest) => (
        globalThis.__dispatchTokenlessMessage({ type: 'tokenless.bridge.submit', request: contentRequest })
      ), request)
      assert.equal(submit.status, 'submitted')
      const transitionProof = postSubmitTransitionProof(request, submit.answerBaseline)
      const read = await conversationTransition.page.evaluate(({ contentRequest, answerBaseline, proof }) => (
        globalThis.__dispatchTokenlessMessage({
          type: 'tokenless.bridge.read',
          request: {
            ...contentRequest,
            answerBaseline,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: proof,
          },
        })
      ), { contentRequest: request, answerBaseline: submit.answerBaseline, proof: transitionProof })
      assert.equal(read.status, 'blocked')
      assert.equal(read.stopReason, 'target_context_mismatch')
      assert.deepEqual(conversationTransition.pageErrors, [])
    } finally {
      await conversationTransition.context.close()
    }
  } finally {
    await browser.close()
  }
})

test('provider reads return only visible external citations from the final assistant answer', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const chatgpt = await openProviderFixture(browser, 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174005', `
    <!doctype html>
    <html><body>
      <div data-message-author-role="assistant">
        Latest visible research answer.
        <a href="https://www.reddit.com/r/OpenAI/comments/abc123/latest/?utm_source=chatgpt.com&keep=yes#citation">Reddit evidence</a>
        <a href="https://www.reddit.com/r/OpenAI/comments/abc123/latest/?keep=yes">Duplicate source</a>
        <a href="https://chatgpt.com/c/private-conversation">Internal provider link</a>
        <a href="http://example.com/not-https">Insecure source</a>
      </div>
    </body></html>
  `)
  try {
    const read = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.read',
      request: {
        provider: 'chatgpt',
        requestId: 'visible-external-citations',
        readTimeoutMs: 2000,
      },
    }))
    assert.equal(read.status, 'read')
    assert.equal(read.text, 'Latest visible research answer. Reddit evidence Duplicate source Internal provider link Insecure source')
    assert.deepEqual(read.sources, [{
      url: 'https://www.reddit.com/r/OpenAI/comments/abc123/latest/?keep=yes',
      title: 'Reddit evidence',
      domain: 'www.reddit.com',
    }])
    assert.deepEqual(chatgpt.pageErrors, [])
  } finally {
    await chatgpt.context.close()
    await browser.close()
  }
})

test('provider controls preserve ChatGPT aliases, use exact labels, and fail closed before submission', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const chatgpt = await openProviderFixture(browser, 'https://chatgpt.com/', `
    <!doctype html>
    <html><body>
      <div role="banner">
        <div id="surface-toggle">
          <button role="radio" aria-checked="false" data-state="off">聊天</button>
          <button role="radio" aria-checked="true" data-state="on">工作</button>
        </div>
      </div>
      <main>
        <button id="worked" aria-expanded="false" aria-haspopup="menu" style="position: fixed; right: 4px; top: 4px">已工作 31 秒</button>
        <div id="prompt-textarea" role="textbox" contenteditable="true" style="height: 42px; width: 600px"></div>
        <button id="intelligence" aria-expanded="false" aria-haspopup="menu">中等</button>
        <button data-testid="send-button" disabled>发送</button>
      </main>
      <script>
        const radios = [...document.querySelectorAll('[role="radio"]')]
        radios.forEach((radio, selectedIndex) => radio.addEventListener('click', () => {
          radios.forEach((candidate, index) => {
            const selected = index === selectedIndex
            candidate.setAttribute('aria-checked', String(selected))
            candidate.setAttribute('data-state', selected ? 'on' : 'off')
          })
        }))
        const composer = document.querySelector('#prompt-textarea')
        const send = document.querySelector('[data-testid="send-button"]')
        composer.addEventListener('input', () => { send.disabled = composer.textContent.trim().length === 0 })
        send.addEventListener('click', () => {
          send.disabled = true
          send.setAttribute('aria-disabled', 'true')
        })
        const trigger = document.querySelector('#intelligence')
        const decoy = document.querySelector('#worked')
        let model = 'GPT-5.6 Sol'
        let effort = 1
        const effortLabels = ['即时', '中等', '高', '特高', '专业']
        const closeMenus = () => document.querySelectorAll('[role="menu"]').forEach((menu) => menu.remove())
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenus() })
        function updateTrigger() {
          trigger.textContent = model === 'GPT-5.6 Sol' ? effortLabels[effort] : model.replace('GPT-', '') + ' ' + effortLabels[effort]
          trigger.setAttribute('aria-expanded', 'false')
        }
        function modelMenu(parent) {
          const menu = document.createElement('div')
          menu.setAttribute('role', 'menu')
          for (const candidate of ['GPT-5.6 Sol', 'GPT-5.5', 'o3']) {
            const item = document.createElement('button')
            item.setAttribute('role', 'menuitemradio')
            item.setAttribute('aria-checked', String(candidate === model))
            item.textContent = candidate
            item.addEventListener('click', () => { model = candidate; closeMenus(); updateTrigger() })
            menu.append(item)
          }
          document.body.append(menu)
          return menu
        }
        function intelligenceMenu() {
          closeMenus()
          const menu = document.createElement('div')
          menu.setAttribute('role', 'menu')
          menu.setAttribute('aria-labelledby', trigger.id)
          for (const [index, label] of effortLabels.entries()) {
            const item = document.createElement('button')
            item.setAttribute('role', 'menuitemradio')
            item.setAttribute('aria-checked', String(index === effort))
            if (index >= 3) {
              item.disabled = true
              item.setAttribute('aria-disabled', 'true')
            }
            item.textContent = label
            item.addEventListener('click', () => { effort = index; closeMenus(); updateTrigger() })
            menu.append(item)
          }
          const submenu = document.createElement('button')
          submenu.setAttribute('role', 'menuitem')
          submenu.setAttribute('aria-haspopup', 'menu')
          submenu.textContent = model
          submenu.addEventListener('click', () => modelMenu(menu))
          menu.append(submenu)
          document.body.append(menu)
        }
        trigger.addEventListener('click', intelligenceMenu)
        decoy.addEventListener('click', () => { throw new Error('The worked-time menu is not the Intelligence control.') })
        updateTrigger()
      </script>
    </body></html>
  `)
  try {
    const inspect = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.inspect_controls',
      request: { provider: 'chatgpt', requestId: 'controls-inspect' },
    }))
    assert.equal(inspect.status, 'inspected')
    assert.deepEqual(inspect.controls.efforts.map((item) => item.id), ['instant', 'medium', 'high', 'extra_high', 'pro'])
    assert.deepEqual(inspect.controls.efforts.map((item) => item.available), [true, true, true, false, false])
    assert.deepEqual(inspect.controls.models.map((item) => item.label), ['GPT-5.6 Sol', 'GPT-5.5', 'o3'])
    const legacyInspect = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.inspect_chatgpt_controls',
      request: { provider: 'chatgpt', requestId: 'controls-legacy-inspect' },
    }))
    assert.deepEqual(legacyInspect.controls.models.map((item) => item.label), ['GPT-5.6 Sol', 'GPT-5.5', 'o3'])

    const configure = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.configure_controls',
      request: {
        provider: 'chatgpt',
        requestId: 'controls-configure',
        chatSurface: 'chat',
        model: 'GPT-5.4',
        modelFallbacks: ['GPT-5.5'],
        effort: 'pro',
      },
    }))
    assert.equal(configure.status, 'configured')
    assert.equal(configure.surface.status, 'chat_selected')
    assert.equal(configure.model.status, 'fallback_selected')
    assert.equal(configure.model.applied, 'GPT-5.5')
    assert.equal(configure.effort.status, 'fallback_selected')
    assert.equal(configure.effort.applied, 'high')
    const trustedClicks = await chatgpt.page.evaluate(() => (
      globalThis.__tokenlessRuntimeMessages.filter((message) => message.type === 'tokenless.bridge.trusted_click')
    ))
    assert.ok(trustedClicks.length > 0)
    assert.ok(trustedClicks.every((message) => (
      !Object.hasOwn(message.request, ['debugger', 'ControlExtensionId'].join(''))
    )))
    assert.equal(await chatgpt.page.locator('[role="radio"]').nth(0).getAttribute('aria-checked'), 'true')
    assert.match(await chatgpt.page.locator('#intelligence').innerText(), /5\.5/)

    const submit = await chatgpt.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.submit',
      request: {
        provider: 'chatgpt',
        requestId: 'controls-submit',
        prompt: 'This prompt must not be submitted with an unavailable model.',
        chatSurface: 'chat',
        model: 'GPT-5',
        effort: 'pro',
        composerTimeoutMs: 100,
        submitTimeoutMs: 100,
      },
    }))
    assert.equal(submit.status, 'blocked')
    assert.equal(submit.stopReason, 'model_control_unavailable')
    assert.equal(submit.model.status, 'unavailable')
    assert.equal(await chatgpt.page.locator('#prompt-textarea').textContent(), '')
    assert.match(await chatgpt.page.locator('#intelligence').innerText(), /5\.5/)
    assert.deepEqual(chatgpt.pageErrors, [])
  } finally {
    await chatgpt.context.close()
    await browser.close()
  }
})

test('generic controls report unavailable and block model selection when a provider adapter has no model DOM contract', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const gemini = await openProviderFixture(browser, 'https://gemini.google.com/app', `
    <!doctype html><html><body>
      <rich-textarea><div class="ql-editor" data-gramm="false" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Enter a prompt for Gemini"></div></rich-textarea>
      <button aria-label="Send message">Send</button>
    </body></html>
  `)
  try {
    const inspect = await gemini.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.inspect_controls',
      request: { provider: 'gemini', requestId: 'gemini-controls-inspect' },
    }))
    assert.equal(inspect.status, 'inspected')
    assert.equal(inspect.controls.available, false)

    const configure = await gemini.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.configure_controls',
      request: { provider: 'gemini', requestId: 'gemini-controls-configure', model: 'Flash' },
    }))
    assert.equal(configure.status, 'blocked')
    assert.equal(configure.stopReason, 'model_control_unavailable')

    const submit = await gemini.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.submit',
      request: {
        provider: 'gemini',
        requestId: 'gemini-controls-submit',
        model: 'Flash',
        prompt: 'Must remain out of the composer.',
      },
    }))
    assert.equal(submit.status, 'blocked')
    assert.equal(submit.stopReason, 'model_control_unavailable')
    assert.equal(await gemini.page.locator('[role="textbox"]').textContent(), '')
    assert.deepEqual(gemini.pageErrors, [])
  } finally {
    await gemini.context.close()
    await browser.close()
  }
})

test('Gemini and Grok model adapters inventory real DOM labels, switch visibly, and require exact matches', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const gemini = await openProviderFixture(
    browser,
    'https://gemini.google.com/app',
    readText('test/fixtures/gemini-real-dom-fixture.html')
  )
  const grok = await openProviderFixture(
    browser,
    'https://grok.com/',
    readText('test/fixtures/grok-real-dom-fixture.html')
  )
  try {
    await gemini.page.evaluate(() => {
      globalThis.__fixtureGeminiEnabledModels = ['3.5 Flash', '3.5 Thinking', '3.1 Pro']
    })
    const geminiInspect = await gemini.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.inspect_controls',
      request: { provider: 'gemini', requestId: 'gemini-model-inspect' },
    }))
    assert.deepEqual(
      geminiInspect.controls.models.map(({ label, selected, available }) => ({ label, selected, available })),
      [
        { label: '3.5 Flash', selected: true, available: true },
        { label: '3.5 Thinking', selected: false, available: true },
        { label: '3.1 Pro', selected: false, available: true },
      ]
    )
    const geminiSelection = await gemini.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.configure_controls',
      request: { provider: 'gemini', requestId: 'gemini-model-select', model: '3.5 Thinking' },
    }))
    assert.equal(geminiSelection.status, 'configured')
    assert.equal(geminiSelection.model.status, 'selected')
    assert.equal(geminiSelection.model.applied, '3.5 Thinking')
    assert.equal(await gemini.page.locator('[data-test-id="bard-mode-menu-button"]').innerText(), 'Thinking')

    const geminiExactFailure = await gemini.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.configure_controls',
      request: { provider: 'gemini', requestId: 'gemini-model-exact', model: '3.5' },
    }))
    assert.equal(geminiExactFailure.status, 'blocked')
    assert.equal(geminiExactFailure.stopReason, 'model_control_unavailable')

    const grokInspect = await grok.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.inspect_controls',
      request: { provider: 'grok', requestId: 'grok-model-inspect' },
    }))
    assert.deepEqual(grokInspect.controls.models.map((model) => model.label), ['Fast', 'Auto', 'Expert', 'Heavy'])
    assert.equal(grokInspect.controls.models.find((model) => model.label === 'Fast')?.selected, true)

    const grokSelection = await grok.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.configure_controls',
      request: { provider: 'grok', requestId: 'grok-model-select', model: 'Heavy' },
    }))
    assert.equal(grokSelection.status, 'configured')
    assert.equal(grokSelection.model.status, 'selected')
    assert.equal(grokSelection.model.applied, 'Heavy')
    assert.equal(await grok.page.locator('#model-select-trigger').innerText(), 'Heavy')

    const grokFallback = await grok.page.evaluate(() => globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.configure_controls',
      request: {
        provider: 'grok',
        requestId: 'grok-model-fallback',
        model: 'Not a visible model',
        modelFallbacks: ['Auto'],
      },
    }))
    assert.equal(grokFallback.status, 'configured')
    assert.equal(grokFallback.model.status, 'fallback_selected')
    assert.equal(grokFallback.model.applied, 'Auto')
    assert.equal(await grok.page.locator('#model-select-trigger').innerText(), 'Auto')
    assert.deepEqual(gemini.pageErrors, [])
    assert.deepEqual(grok.pageErrors, [])
  } finally {
    await gemini.context.close()
    await grok.context.close()
    await browser.close()
  }
})

test('background enables the Settings side panel and jobs create only approved provider tabs', async () => {
  const previousChrome = globalThis.chrome
  const installed = createChromeEvent()
  const startup = createChromeEvent()
  const runtimeMessage = createChromeEvent()
  const ports = []
  const createdTabs = []
  const providerMessages = []
  const sidePanelCalls = []
  let nextTabId = 1

  function connectNative(name) {
    assert.equal(name, 'dev.tokenless.native_host')
    const port = createNativePort()
    ports.push(port)
    return port
  }

  function createNativePort() {
    const onMessage = createChromeEvent()
    const onDisconnect = createChromeEvent()
    const posted = []
    return {
      onMessage,
      onDisconnect,
      posted,
      postMessage(message) {
        posted.push(message)
        if (message.type === 'tokenless.native.daemon_ready') {
          queueMicrotask(() => {
            void onMessage.emit(nativeSuccess(message.type, {
              status: 'ready',
              jobId: message.jobId,
            }, message.requestId))
          })
        } else if (message.type === 'tokenless.native.daemon_complete_job') {
          queueMicrotask(() => {
            void onMessage.emit({
              protocol: 'tokenless.native.v1',
              type: message.type,
              ok: true,
              result: {
                job_id: message.jobId,
                provider: 'chatgpt',
                action: 'submit_and_read',
                status: message.error ? 'failed' : 'succeeded',
              },
            })
          })
        }
      },
      disconnect() {},
    }
  }

  globalThis.chrome = {
    runtime: {
      onMessage: runtimeMessage,
      onInstalled: installed,
      onStartup: startup,
      connectNative,
      lastError: undefined,
    },
    sidePanel: {
      async setPanelBehavior(options) {
        sidePanelCalls.push(options)
      },
    },
    scripting: {
      async executeScript() {
        throw new Error('content script should already be available in this contract test')
      },
    },
    tabs: {
      async query() {
        return []
      },
      async create(details) {
        const tab = {
          id: nextTabId,
          windowId: 1,
          active: Boolean(details.active),
          status: 'complete',
          url: String(details.url),
        }
        nextTabId += 1
        createdTabs.push(tab)
        return tab
      },
      async get(tabId) {
        return createdTabs.find((tab) => tab.id === tabId)
      },
      async update(tabId, details) {
        const tab = createdTabs.find((candidate) => candidate.id === tabId)
        if (tab) Object.assign(tab, details)
        return tab
      },
      async sendMessage(tabId, message) {
        providerMessages.push({ tabId, message })
        if (message.type === 'tokenless.bridge.validate_landing') {
          if (message.request?.requestId === 'job-provider-drift') {
            const tab = createdTabs.find((candidate) => candidate.id === tabId)
            if (tab) tab.url = 'https://gemini.google.com/app'
          }
          if (message.request?.requestId === 'job-chatgpt-alias-transition') {
            const tab = createdTabs.find((candidate) => candidate.id === tabId)
            if (tab) tab.url = 'https://chatgpt.com/'
          }
          return { status: 'ready' }
        }
        if (message.type === 'tokenless.bridge.submit') {
          if (message.request?.requestId === 'job-visible-provider') {
            const tab = createdTabs.find((candidate) => candidate.id === tabId)
            if (tab) tab.url = 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174002?private-query=yes#private-hash'
          }
          if (message.request?.requestId === 'job-chatgpt-alias-transition') {
            const tab = createdTabs.find((candidate) => candidate.id === tabId)
            if (tab) tab.url = 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174005'
          }
          if (message.request?.requestId === 'job-unsafe-provider-path') {
            const tab = createdTabs.find((candidate) => candidate.id === tabId)
            if (tab) tab.url = 'https://chatgpt.com/c/settings123'
          }
          if (message.request?.requestId === 'job-custom-gpt-transition') {
            const tab = createdTabs.find((candidate) => candidate.id === tabId)
            if (tab) tab.url = 'https://chatgpt.com/g/g-pmuQfob8d/c/123e4567-e89b-12d3-a456-426614174010'
          }
          if (message.request?.requestId === 'job-custom-gpt-mismatch') {
            const tab = createdTabs.find((candidate) => candidate.id === tabId)
            if (tab) tab.url = 'https://chatgpt.com/g/g-otherGPT9/c/123e4567-e89b-12d3-a456-426614174011'
          }
          if (message.request?.requestId === 'job-root-custom-mismatch') {
            const tab = createdTabs.find((candidate) => candidate.id === tabId)
            if (tab) tab.url = 'https://chatgpt.com/g/g-pmuQfob8d/c/123e4567-e89b-12d3-a456-426614174012'
          }
          return {
            status: 'submitted',
            answerBaseline: { count: 1, lastText: 'old-private-answer-marker' },
          }
        }
        if (message.type === 'tokenless.bridge.read') {
          return {
            status: 'complete',
            provider: 'chatgpt',
            text: 'Visible DOM answer',
            url: 'https://chatgpt.com/',
          }
        }
        if (message.type === 'tokenless.bridge.inspect_controls') {
          return {
            status: 'inspected',
            provider: message.request.provider,
            controls: { available: false, efforts: [], models: [] },
          }
        }
        if (message.type === 'tokenless.bridge.configure_controls') {
          return {
            status: 'configured',
            provider: message.request.provider,
            model: { status: 'selected', requested: message.request.model, applied: message.request.model },
          }
        }
        throw new Error(`Unexpected provider message: ${message.type}`)
      },
    },
    windows: {
      async update() {},
    },
  }

  try {
    const serviceWorkerUrl = pathToFileURL(path.join(extensionDist, 'background/service-worker.js'))
    serviceWorkerUrl.searchParams.set('contract', String(Date.now()))
    await import(serviceWorkerUrl.href)

    assert.equal(ports.length, 1, 'service worker should establish one long-lived native port')
    const daemonPort = ports[0]
    assert.deepEqual(daemonPort.posted[0], {
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_connect',
    })
    await daemonPort.onMessage.emit(nativeSuccess('tokenless.native.daemon_connected', {
      status: 'connected',
      sessionId: 'contract-session',
    }))
    assert.deepEqual(sidePanelCalls, [{ openPanelOnActionClick: true }])
    assert.deepEqual(createdTabs, [])

    await installed.emit({ reason: 'install' })
    await startup.emit()
    await delay(0)
    assert.deepEqual(sidePanelCalls, [
      { openPanelOnActionClick: true },
      { openPanelOnActionClick: true },
      { openPanelOnActionClick: true },
    ], 'startup hooks configure the side panel without opening a tab')
    assert.deepEqual(createdTabs, [], 'install and startup must not open tabs')
    const sidePanelCallsBeforeJobs = sidePanelCalls.length

    const visibleJobMessage = {
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_job',
      ok: true,
      result: {
        job: {
          job_id: 'job-visible-provider',
          claim_token: 'provider-private-marker',
          provider: 'chatgpt',
          action: 'submit_and_read',
          status: 'claimed',
          request_json: {
            prompt: 'Read this through visible DOM.',
            targetUrl: 'https://chatgpt.com/',
            readDelayMs: 0,
            allowPostSubmitTargetTransition: true,
            postSubmitTargetTransitionProof: { nonce: 'daemon-forged-proof' },
            metadata: { taskId: 'task-visible-provider' },
          },
        },
      },
    }
    await daemonPort.onMessage.emit(visibleJobMessage)

    await waitFor(() => daemonPort.posted.filter((message) => message.type === 'tokenless.native.daemon_ready').length === 1)
    const daemonReady = daemonPort.posted.find((message) => message.type === 'tokenless.native.daemon_ready')
    assert.match(daemonReady.requestId, /^native-/)
    const { requestId: _correlationId, ...publicDaemonReady } = daemonReady
    assert.deepEqual(publicDaemonReady, {
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_ready',
      jobId: 'job-visible-provider',
      claimToken: 'provider-private-marker',
    })
    assert.deepEqual(createdTabs.map((tab) => tab.url), ['https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174002?private-query=yes#private-hash'])
    assert.ok(createdTabs.every((tab) => /^https:\/\/(chatgpt\.com|chat\.openai\.com|gemini\.google\.com|claude\.ai)\//.test(tab.url)))
    assert.deepEqual(
      providerMessages.map(({ message }) => message.type),
      [
        'tokenless.bridge.validate_landing',
        'tokenless.bridge.submit',
        'tokenless.bridge.validate_landing',
        'tokenless.bridge.read',
      ]
    )
    assert.deepEqual(
      providerMessages.map(({ message }) => message.request?.allowPostSubmitTargetTransition),
      [undefined, undefined, true, true],
      'only the service worker may add the landing-transition flag, and only after submit'
    )
    assert.equal(providerMessages[0].message.request?.postSubmitTargetTransitionProof, undefined)
    assert.equal(providerMessages[1].message.request?.postSubmitTargetTransitionProof, undefined)
    for (const messageIndex of [2, 3]) {
      assert.deepEqual(
        {
          requestId: providerMessages[messageIndex].message.request?.postSubmitTargetTransitionProof?.requestId,
          provider: providerMessages[messageIndex].message.request?.postSubmitTargetTransitionProof?.provider,
          targetUrl: providerMessages[messageIndex].message.request?.postSubmitTargetTransitionProof?.targetUrl,
          answerBaseline: providerMessages[messageIndex].message.request?.postSubmitTargetTransitionProof?.answerBaseline,
        },
        {
          requestId: 'job-visible-provider',
          provider: 'chatgpt',
          targetUrl: 'https://chatgpt.com/',
          answerBaseline: { count: 1, lastText: 'old-private-answer-marker' },
        }
      )
      assert.ok(providerMessages[messageIndex].message.request?.postSubmitTargetTransitionProof?.nonce.length >= 16)
    }
    assert.doesNotMatch(JSON.stringify(providerMessages), /provider-private-marker/)
    assert.equal(sidePanelCalls.length, sidePanelCallsBeforeJobs, 'job execution must not change Settings state')

    const messagesAfterFirstJob = daemonPort.posted.length
    await daemonPort.onMessage.emit(structuredClone(visibleJobMessage))
    await delay(25)
    assert.equal(daemonPort.posted.length, messagesAfterFirstJob, 'duplicate claimed jobs must not emit duplicate ready')

    await daemonPort.onMessage.emit({
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_job',
      ok: true,
      result: {
        job: {
          job_id: 'job-rejected-target',
          claim_token: 'rejected-private-marker',
          provider: 'chatgpt',
          action: 'submit_and_read',
          status: 'claimed',
          request_json: {
            prompt: 'Do not open this target.',
            targetUrl: 'chrome-extension://extension-id/settings/index.html',
            readDelayMs: 0,
          },
        },
      },
    })

    await waitFor(() => daemonPort.posted.filter((message) => message.type === 'tokenless.native.daemon_ready').length === 2)
    assert.deepEqual(createdTabs.map((tab) => tab.url), ['https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174002?private-query=yes#private-hash'])
    assert.equal(sidePanelCalls.length, sidePanelCallsBeforeJobs)

    await daemonPort.onMessage.emit({
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_job',
      ok: true,
      result: {
        job: {
          job_id: 'job-provider-drift',
          claim_token: 'drift-private-marker',
          provider: 'chatgpt',
          action: 'submit_and_read',
          status: 'claimed',
          request_json: {
            prompt: 'Must not submit after cross-provider navigation.',
            readDelayMs: 0,
          },
        },
      },
    })
    await waitFor(() => daemonPort.posted.filter((message) => message.type === 'tokenless.native.daemon_ready').length === 3)
    const driftMessages = providerMessages.filter(({ message }) => message.request?.requestId === 'job-provider-drift')
    assert.deepEqual(driftMessages.map(({ message }) => message.type), ['tokenless.bridge.validate_landing'])

    await daemonPort.onMessage.emit({
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_job',
      ok: true,
      result: {
        job: {
          job_id: 'job-chatgpt-alias-transition',
          claim_token: 'alias-private-marker',
          provider: 'chatgpt',
          action: 'submit_and_read',
          status: 'claimed',
          request_json: {
            prompt: 'Allow only the ChatGPT landing alias to transition.',
            targetUrl: 'https://chat.openai.com/',
            readDelayMs: 0,
          },
        },
      },
    })
    await waitFor(() => daemonPort.posted.filter((message) => message.type === 'tokenless.native.daemon_ready').length === 4)
    const aliasMessages = providerMessages.filter(({ message }) => (
      message.request?.requestId === 'job-chatgpt-alias-transition'
    ))
    assert.deepEqual(
      aliasMessages.map(({ message }) => ({
        type: message.type,
        allowTransition: message.request?.allowPostSubmitTargetTransition,
      })),
      [
        { type: 'tokenless.bridge.validate_landing', allowTransition: undefined },
        { type: 'tokenless.bridge.submit', allowTransition: undefined },
        { type: 'tokenless.bridge.validate_landing', allowTransition: true },
        { type: 'tokenless.bridge.read', allowTransition: true },
      ]
    )

    await daemonPort.onMessage.emit({
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_job',
      ok: true,
      result: {
        job: {
          job_id: 'job-submit-only-baseline-private',
          claim_token: 'submit-private-marker',
          provider: 'chatgpt',
          action: 'submit',
          status: 'claimed',
          request_json: {
            prompt: 'Do not persist the prior answer baseline.',
          },
        },
      },
    })
    await waitFor(() => daemonPort.posted.filter((message) => message.type === 'tokenless.native.daemon_ready').length === 5)

    await daemonPort.onMessage.emit({
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_job',
      ok: true,
      result: {
        job: {
          job_id: 'job-unsafe-provider-path',
          claim_token: 'unsafe-path-private-marker',
          provider: 'chatgpt',
          action: 'submit_and_read',
          status: 'claimed',
          request_json: {
            prompt: 'Do not read misleading provider settings content.',
            targetUrl: 'https://chatgpt.com/',
            readDelayMs: 0,
          },
        },
      },
    })
    await waitFor(() => daemonPort.posted.filter((message) => message.type === 'tokenless.native.daemon_ready').length === 6)
    const unsafePathMessages = providerMessages.filter(({ message }) => (
      message.request?.requestId === 'job-unsafe-provider-path'
    ))
    assert.deepEqual(
      unsafePathMessages.map(({ message }) => message.type),
      ['tokenless.bridge.validate_landing', 'tokenless.bridge.submit']
    )

    for (const job of [
      {
        job_id: 'job-custom-gpt-transition',
        claim_token: 'custom-positive-private-marker',
        targetUrl: 'https://chatgpt.com/g/g-pmuQfob8d',
      },
      {
        job_id: 'job-custom-gpt-mismatch',
        claim_token: 'custom-mismatch-private-marker',
        targetUrl: 'https://chatgpt.com/g/g-pmuQfob8d',
      },
      {
        job_id: 'job-root-custom-mismatch',
        claim_token: 'root-custom-private-marker',
        targetUrl: 'https://chatgpt.com/',
      },
    ]) {
      await daemonPort.onMessage.emit({
        protocol: 'tokenless.native.v1',
        type: 'tokenless.native.daemon_job',
        ok: true,
        result: {
          job: {
            ...job,
            provider: 'chatgpt',
            action: 'submit_and_read',
            status: 'claimed',
            request_json: {
              prompt: 'Verify custom GPT source and destination binding.',
              targetUrl: job.targetUrl,
              readDelayMs: 0,
            },
          },
        },
      })
    }
    await waitFor(() => daemonPort.posted.filter((message) => message.type === 'tokenless.native.daemon_ready').length === 9)
    const customPositiveMessages = providerMessages.filter(({ message }) => (
      message.request?.requestId === 'job-custom-gpt-transition'
    ))
    assert.deepEqual(
      customPositiveMessages.map(({ message }) => message.type),
      [
        'tokenless.bridge.validate_landing',
        'tokenless.bridge.submit',
        'tokenless.bridge.validate_landing',
        'tokenless.bridge.read',
      ]
    )
    for (const blockedJobId of ['job-custom-gpt-mismatch', 'job-root-custom-mismatch']) {
      const blockedMessages = providerMessages.filter(({ message }) => message.request?.requestId === blockedJobId)
      assert.deepEqual(
        blockedMessages.map(({ message }) => message.type),
        ['tokenless.bridge.validate_landing', 'tokenless.bridge.submit']
      )
    }

    for (const job of [
      { jobId: 'job-generic-controls-inspect', action: 'inspect_controls', requestJson: {} },
      { jobId: 'job-generic-controls-configure', action: 'configure_controls', requestJson: { model: 'Flash' } },
    ]) {
      await daemonPort.onMessage.emit({
        protocol: 'tokenless.native.v1',
        type: 'tokenless.native.daemon_job',
        ok: true,
        result: {
          job: {
            job_id: job.jobId,
            claim_token: `${job.jobId}-private-marker`,
            provider: 'gemini',
            action: job.action,
            status: 'claimed',
            request_json: job.requestJson,
          },
        },
      })
    }
    await waitFor(() => daemonPort.posted.filter((message) => message.type === 'tokenless.native.daemon_ready').length === 11)
    for (const [jobId, expectedType] of [
      ['job-generic-controls-inspect', 'tokenless.bridge.inspect_controls'],
      ['job-generic-controls-configure', 'tokenless.bridge.configure_controls'],
    ]) {
      const routed = providerMessages.filter(({ message }) => message.request?.requestId === jobId)
      assert.deepEqual(routed.map(({ message }) => message.type), [
        'tokenless.bridge.validate_landing',
        expectedType,
      ])
    }

    const allNativeMessages = ports.flatMap((port) => port.posted)
    assert.ok(allNativeMessages.length >= 5)
    assert.ok(allNativeMessages.every((message) => message.protocol === 'tokenless.native.v1'))
    const completionMessages = allNativeMessages.filter((message) => (
      message.type === 'tokenless.native.daemon_complete_job'
    ))
    assert.doesNotMatch(
      JSON.stringify(completionMessages),
      /old-private-answer-marker|answerBaseline|postSubmitTargetTransitionProof/,
      'submission correlation state must never reach public daemon results'
    )
    assert.ok(allNativeMessages.some((message) => (
      message.type === 'tokenless.native.daemon_complete_job' &&
      message.jobId === 'job-visible-provider' &&
      message.claimToken === 'provider-private-marker' &&
      message.result?.text === 'Visible DOM answer'
    )))
    assert.ok(allNativeMessages.some((message) => (
      message.type === 'tokenless.native.daemon_complete_job' &&
      message.jobId === 'job-rejected-target' &&
      message.error?.code === 'target_url_provider_mismatch'
    )))
    assert.ok(allNativeMessages.some((message) => (
      message.type === 'tokenless.native.daemon_complete_job' &&
      message.jobId === 'job-provider-drift' &&
      message.error?.code === 'provider_tab_mismatch'
    )))
    assert.ok(allNativeMessages.some((message) => (
      message.type === 'tokenless.native.daemon_complete_job' &&
      message.jobId === 'job-unsafe-provider-path' &&
      message.error?.code === 'target_tab_mismatch'
    )))
    for (const blockedJobId of ['job-custom-gpt-mismatch', 'job-root-custom-mismatch']) {
      assert.ok(allNativeMessages.some((message) => (
        message.type === 'tokenless.native.daemon_complete_job' &&
        message.jobId === blockedJobId &&
        message.error?.code === 'target_tab_mismatch'
      )))
    }
    assert.deepEqual(
      allNativeMessages
        .filter((message) => message.type === 'tokenless.native.daemon_ready')
        .map(({ jobId, claimToken }) => ({ jobId, claimToken })),
      [
        { jobId: 'job-visible-provider', claimToken: 'provider-private-marker' },
        { jobId: 'job-rejected-target', claimToken: 'rejected-private-marker' },
        { jobId: 'job-provider-drift', claimToken: 'drift-private-marker' },
        { jobId: 'job-chatgpt-alias-transition', claimToken: 'alias-private-marker' },
        { jobId: 'job-submit-only-baseline-private', claimToken: 'submit-private-marker' },
        { jobId: 'job-unsafe-provider-path', claimToken: 'unsafe-path-private-marker' },
        { jobId: 'job-custom-gpt-transition', claimToken: 'custom-positive-private-marker' },
        { jobId: 'job-custom-gpt-mismatch', claimToken: 'custom-mismatch-private-marker' },
        { jobId: 'job-root-custom-mismatch', claimToken: 'root-custom-private-marker' },
        { jobId: 'job-generic-controls-inspect', claimToken: 'job-generic-controls-inspect-private-marker' },
        { jobId: 'job-generic-controls-configure', claimToken: 'job-generic-controls-configure-private-marker' },
      ]
    )
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('background and provider content preserve visible-session safety boundaries', () => {
  const serviceWorker = readText('packages/extension/extension/background/service-worker.ts')
  const contentScript = readText('packages/extension/extension/content/provider-content.ts')
  const settingsScript = readText('packages/extension/extension/settings/index.ts')
  const builtContentScript = readText('packages/extension/dist/extension/content/provider-content.js')

  assert.doesNotMatch(serviceWorker, /onMessageExternal|externally_connectable/)
  assert.doesNotMatch(serviceWorker, /task\/task\.html|runner\.html|chrome\.runtime\.getURL/)
  assert.doesNotMatch(settingsScript, /chrome\.tabs\.create/)
  assert.match(serviceWorker, /getOrCreateProviderTab/)
  assert.match(serviceWorker, /focusTab\(tab\)/)
  assert.match(serviceWorker, /chrome\.tabs\.sendMessage/)
  assert.match(serviceWorker, /validateProviderLanding/)
  assert.match(serviceWorker, /isSafeProviderAuthority/)
  assert.match(serviceWorker, /chrome\.runtime\.onMessage\.addListener/)
  assert.match(serviceWorker, /tokenless\.provider_content_ready/)
  assert.match(contentScript, /chrome\.runtime\.sendMessage/)
  assert.match(contentScript, /tokenless\.provider_content_ready/)

  for (const source of [serviceWorker, contentScript]) {
    assert.doesNotMatch(source, /chrome\.cookies|document\.cookie|localStorage|sessionStorage/)
    assert.doesNotMatch(source, /provider.*fetch|fetch.*provider/i)
  }

  assert.match(contentScript, /__TOKENLESS_PROVIDER_CONTENT_LOADED__/)
  assert.doesNotMatch(builtContentScript, /\nexport \{\};/)
  assert.doesNotMatch(builtContentScript, /^import /m)
  assert.ok(
    contentScript.indexOf('__TOKENLESS_PROVIDER_CONTENT_LOADED__') < contentScript.search(/const SAFE_STRUCTURAL_STATE_VALUES\b/),
    'duplicate-injection guard must run before content-script declarations'
  )
  assert.doesNotMatch(contentScript, /const PROVIDERS\b/)
  assert.doesNotMatch(contentScript, /function providerTransitionSource\b/)
  assert.match(serviceWorker, /dispatchTrustedChatGptClick/)
  assert.match(serviceWorker, /Input\.dispatchMouseEvent/)
  assert.doesNotMatch(
    serviceWorker,
    /sendCommand\([^\n]*(?:Network|Storage|Fetch|Runtime|DOM|Page)\./
  )
  assert.doesNotMatch(serviceWorker, /chrome\.cookies|localStorage|sessionStorage/)
  assert.doesNotMatch(contentScript, /debuggerControlExtensionId|debugger-control-extension-id/)
})

test('primary extension validates, serializes, dispatches, and detaches trusted ChatGPT clicks', async () => {
  const previousChrome = globalThis.chrome
  const runtimeMessage = createChromeEvent()
  const nativePort = createBehaviorNativePort()
  const calls = []
  let blockAttach = false
  let releaseAttach
  let blockDetach = false
  let releaseDetach
  let failCommand = false
  let currentTabUrl = 'https://chatgpt.com/c/visible-chat?private=yes#fragment'
  let changeUrlOnAttach = false
  globalThis.chrome = {
    runtime: {
      onMessage: runtimeMessage,
      onInstalled: createChromeEvent(),
      onStartup: createChromeEvent(),
      connectNative() {
        return nativePort
      },
      lastError: undefined,
    },
    sidePanel: {
      async setPanelBehavior() {},
    },
    tabs: {
      async get(tabId) {
        return tabId === 42
          ? { id: 42, url: currentTabUrl }
          : undefined
      },
    },
    debugger: {
      async attach(target, version) {
        calls.push({ kind: 'attach', target, version })
        if (changeUrlOnAttach) currentTabUrl = 'https://chatgpt.com/c/navigated-away'
        if (blockAttach) await new Promise((resolve) => { releaseAttach = resolve })
      },
      async sendCommand(target, command, params) {
        calls.push({ kind: 'command', target, command, params })
        if (failCommand) throw new Error('simulated input failure')
      },
      async detach(target) {
        calls.push({ kind: 'detach', target })
        if (blockDetach) await new Promise((resolve) => { releaseDetach = resolve })
      },
    },
  }
  try {
    const workerUrl = pathToFileURL(path.join(extensionDist, 'background/service-worker.js'))
    workerUrl.searchParams.set('contract', String(Date.now()))
    await import(workerUrl.href)
    await nativePort.onMessage.emit(nativeSuccess('tokenless.native.daemon_connected', { status: 'connected' }))
    assert.equal(runtimeMessage.listeners().length, 1)
    const listener = runtimeMessage.listeners()[0]
    const sender = { frameId: 0, tab: { id: 42, url: 'https://chatgpt.com/c/visible-chat?sender=yes' } }
    const request = {
      type: 'tokenless.bridge.trusted_click',
      request: {
        provider: 'chatgpt',
        expectedUrl: 'https://chatgpt.com/c/visible-chat#content-script-fragment',
        x: 320,
        y: 640,
        viewportWidth: 1280,
        viewportHeight: 800,
      },
    }

    for (const [rejectedRequest, rejectedSender, code] of [
      [request, { frameId: 0, tab: { id: 42, url: 'https://gemini.google.com/app' } }, 'debugger_control_context_mismatch'],
      [{ ...request, request: { ...request.request, expectedUrl: 'https://chatgpt.com/c/other-chat' } }, sender, 'debugger_control_context_mismatch'],
      [{ ...request, request: { ...request.request, x: 1280 } }, sender, 'debugger_control_invalid_coordinate'],
      [{ ...request, request: { ...request.request, x: null } }, sender, 'debugger_control_invalid_coordinate'],
      [{ ...request, request: { ...request.request, x: false } }, sender, 'debugger_control_invalid_coordinate'],
      [{ ...request, request: { ...request.request, x: '' } }, sender, 'debugger_control_invalid_coordinate'],
      [{ ...request, request: { ...request.request, x: -0.4 } }, sender, 'debugger_control_invalid_coordinate'],
      [request, { ...sender, frameId: 1 }, 'debugger_control_context_mismatch'],
      [request, { tab: sender.tab }, 'debugger_control_context_mismatch'],
    ]) {
      const rejected = await invokeChromeMessageListener(listener, rejectedRequest, rejectedSender)
      assert.deepEqual(rejected, { ok: false, code })
    }
    assert.deepEqual(calls, [], 'invalid requests must not attach a debugger')

    currentTabUrl = 'https://chatgpt.com/c/navigated-before-attach'
    const rejectedBeforeAttach = await invokeChromeMessageListener(listener, request, sender)
    assert.deepEqual(rejectedBeforeAttach, { ok: false, code: 'debugger_control_tab_rejected' })
    assert.deepEqual(calls, [], 'a pre-attach URL mismatch must not attach a debugger')

    currentTabUrl = 'https://chatgpt.com/c/visible-chat'
    changeUrlOnAttach = true
    const rejectedAfterAttach = await invokeChromeMessageListener(listener, request, sender)
    assert.deepEqual(rejectedAfterAttach, { ok: false, code: 'debugger_control_tab_rejected' })
    assert.deepEqual(calls, [
      { kind: 'attach', target: { tabId: 42 }, version: '1.3' },
      { kind: 'detach', target: { tabId: 42 } },
    ], 'a post-attach URL mismatch must detach without dispatching Input')
    calls.length = 0
    currentTabUrl = 'https://chatgpt.com/c/visible-chat'
    changeUrlOnAttach = false

    blockAttach = true
    blockDetach = true
    const pending = invokeChromeMessageListener(listener, request, sender)
    while (!calls.some((call) => call.kind === 'attach')) await delay(0)
    const busy = await invokeChromeMessageListener(listener, request, sender)
    assert.deepEqual(busy, { ok: false, code: 'debugger_control_busy' })
    releaseAttach()
    while (!calls.some((call) => call.kind === 'detach')) await delay(0)
    const busyWhileDetaching = await invokeChromeMessageListener(listener, request, sender)
    assert.deepEqual(busyWhileDetaching, { ok: false, code: 'debugger_control_busy' })
    releaseDetach()
    const response = await pending
    assert.deepEqual(response, { ok: true })
    assert.deepEqual(calls, [
      { kind: 'attach', target: { tabId: 42 }, version: '1.3' },
      {
        kind: 'command',
        target: { tabId: 42 },
        command: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 320, y: 640, button: 'left', buttons: 1, clickCount: 1 },
      },
      {
        kind: 'command',
        target: { tabId: 42 },
        command: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 320, y: 640, button: 'left', buttons: 0, clickCount: 1 },
      },
      { kind: 'detach', target: { tabId: 42 } },
    ])

    blockAttach = false
    blockDetach = false
    failCommand = true
    const failed = await invokeChromeMessageListener(listener, request, sender)
    assert.deepEqual(failed, { ok: false, code: 'debugger_control_input_failed' })
    assert.deepEqual(calls.slice(-3), [
      { kind: 'attach', target: { tabId: 42 }, version: '1.3' },
      {
        kind: 'command',
        target: { tabId: 42 },
        command: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 320, y: 640, button: 'left', buttons: 1, clickCount: 1 },
      },
      { kind: 'detach', target: { tabId: 42 } },
    ], 'an Input command error must still detach')
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('browser bridge advertises sanitized DOM snapshot action', async () => {
  const {
    BRIDGE_ACTIONS,
    BRIDGE_PROTOCOL_VERSION,
    capabilitiesPayload,
    validateBridgeRequest,
  } = await import('../packages/extension/dist/extension/shared/bridge-protocol.js')

  assert.equal(BRIDGE_ACTIONS.SNAPSHOT_DOM, 'snapshot_dom')
  assert.ok(capabilitiesPayload().actions.includes('snapshot_dom'))
  assert.equal(BRIDGE_ACTIONS.INSPECT_CONTROLS, 'inspect_controls')
  assert.equal(BRIDGE_ACTIONS.CONFIGURE_CONTROLS, 'configure_controls')
  assert.ok(capabilitiesPayload().actions.includes('inspect_controls'))
  assert.ok(capabilitiesPayload().actions.includes('configure_controls'))
  assert.equal(BRIDGE_ACTIONS.INSPECT_CHATGPT_CONTROLS, 'inspect_chatgpt_controls')
  assert.equal(BRIDGE_ACTIONS.CONFIGURE_CHATGPT, 'configure_chatgpt')
  assert.ok(capabilitiesPayload().actions.includes('inspect_chatgpt_controls'))
  assert.ok(capabilitiesPayload().actions.includes('configure_chatgpt'))
  const baseRequest = {
    protocol: BRIDGE_PROTOCOL_VERSION,
    requestId: 'snapshot-1',
    provider: 'chatgpt',
    action: 'snapshot_dom',
  }
  assert.equal(validateBridgeRequest(baseRequest).ok, true)
  const chatGptControls = validateBridgeRequest({
    ...baseRequest,
    action: 'configure_chatgpt',
    chatSurface: 'chat',
    model: 'GPT-5.6 Sol',
    modelFallbacks: ['GPT-5.5', 'o3'],
    effort: 'extra_high',
  })
  assert.equal(chatGptControls.ok, true)
  assert.equal(chatGptControls.request.effort, 'extra_high')
  const providerControls = validateBridgeRequest({
    ...baseRequest,
    provider: 'gemini',
    action: 'configure_controls',
    model: '  Flash  ',
    modelFallbacks: ['  Pro  '],
  })
  assert.equal(providerControls.ok, true)
  assert.equal(providerControls.request.model, 'Flash')
  assert.deepEqual(providerControls.request.modelFallbacks, ['Pro'])
  assert.equal(validateBridgeRequest({
    ...baseRequest,
    provider: 'grok',
    action: 'inspect_controls',
  }).ok, true)
  for (const malformedControls of [
    { ...baseRequest, chatSurface: 'work' },
    { ...baseRequest, effort: 'maximum' },
    { ...baseRequest, model: '' },
    { ...baseRequest, modelFallbacks: 'GPT-5.5' },
    { ...baseRequest, modelFallbacks: Array.from({ length: 9 }, () => 'GPT-5.5') },
    { ...baseRequest, provider: 'gemini', effort: 'high' },
    { ...baseRequest, provider: 'gemini', action: 'read', model: 'Flash' },
    { ...baseRequest, provider: 'gemini', action: 'configure_controls', modelFallbacks: ['Pro'] },
    { ...baseRequest, provider: 'grok', action: 'configure_controls', model: 'Fast\nExpert' },
    { ...baseRequest, provider: 'gemini', action: 'inspect_chatgpt_controls' },
  ]) {
    const validation = validateBridgeRequest(malformedControls)
    assert.equal(validation.ok, false)
  }
  const daemonSuppliedTransition = validateBridgeRequest({
    ...baseRequest,
    allowPostSubmitTargetTransition: true,
    postSubmitTargetTransitionProof: { nonce: 'daemon-forged-proof' },
  })
  assert.equal(daemonSuppliedTransition.ok, true)
  assert.equal(daemonSuppliedTransition.request.allowPostSubmitTargetTransition, undefined)
  assert.equal(daemonSuppliedTransition.request.postSubmitTargetTransitionProof, undefined)
  assert.equal(validateBridgeRequest({ ...baseRequest, includeText: false }).ok, true)
  const metadataFallback = validateBridgeRequest({ ...baseRequest, metadata: { includeText: true } })
  assert.equal(metadataFallback.ok, true)
  assert.equal(metadataFallback.request.includeText, true)
  for (const malformed of [
    { ...baseRequest, includeText: 'false' },
    { ...baseRequest, includeText: 0 },
    { ...baseRequest, includeText: null },
    { ...baseRequest, metadata: { includeText: 'true' } },
  ]) {
    const validation = validateBridgeRequest(malformed)
    assert.equal(validation.ok, false)
    assert.equal(validation.error.code, 'invalid_include_text')
  }
  for (const malformedTarget of [null, false, '', 'not-an-absolute-url']) {
    const validation = validateBridgeRequest({ ...baseRequest, targetUrl: malformedTarget })
    assert.equal(validation.ok, false)
    assert.equal(validation.error.code, 'invalid_target_url')
  }
  for (const mismatchedTarget of [
    'https://gemini.google.com/app',
    'https://user:password@chatgpt.com/',
    'https://chatgpt.com:444/',
  ]) {
    const validation = validateBridgeRequest({ ...baseRequest, targetUrl: mismatchedTarget })
    assert.equal(validation.ok, false)
    assert.equal(validation.error.code, 'target_url_provider_mismatch')
  }
})

function postSubmitTransitionProof(request, answerBaseline, nonce = 'contract-transition-proof-0001') {
  const target = new URL(request.targetUrl)
  const pathname = target.pathname.replace(/\/+$/, '') || '/'
  const segments = pathname.split('/').filter(Boolean)
  const customGptId = (
    request.provider === 'chatgpt' &&
    segments.length === 2 &&
    segments[0] === 'g'
  ) ? segments[1] : undefined
  const projectId = request.provider === 'chatgpt' &&
    segments.length === 3 &&
    segments[0] === 'g' &&
    segments[1]?.startsWith('g-p-') &&
    segments[2] === 'project'
      ? segments[1]
      : request.provider === 'claude' &&
          segments.length === 2 &&
          segments[0] === 'project'
        ? segments[1]
        : undefined
  return {
    requestId: request.requestId,
    provider: request.provider,
    targetUrl: `${target.origin}${pathname}`,
    sourceKind: projectId ? 'project' : customGptId ? 'custom_gpt' : 'root',
    customGptId,
    projectId,
    answerBaseline,
    nonce,
  }
}

function dispatchPostSubmitRead(page, request, answerBaseline, proof) {
  return page.evaluate(({ contentRequest, baseline, transitionProof }) => (
    globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.read',
      request: {
        ...contentRequest,
        answerBaseline: baseline,
        allowPostSubmitTargetTransition: true,
        postSubmitTargetTransitionProof: transitionProof,
      },
    })
  ), { contentRequest: request, baseline: answerBaseline, transitionProof: proof })
}

function dispatchPostSubmitValidation(page, request, answerBaseline, proof) {
  return page.evaluate(({ contentRequest, baseline, transitionProof }) => (
    globalThis.__dispatchTokenlessMessage({
      type: 'tokenless.bridge.validate_landing',
      request: {
        ...contentRequest,
        answerBaseline: baseline,
        allowPostSubmitTargetTransition: true,
        postSubmitTargetTransitionProof: transitionProof,
      },
    })
  ), { contentRequest: request, baseline: answerBaseline, transitionProof: proof })
}

function createChromeEvent() {
  const listeners = []
  return {
    addListener(listener) {
      listeners.push(listener)
    },
    async emit(...args) {
      await Promise.all(listeners.map((listener) => listener(...args)))
    },
    listeners() {
      return [...listeners]
    },
  }
}

function invokeChromeMessageListener(listener, message, sender) {
  return new Promise((resolve, reject) => {
    let completed = false
    const timeout = setTimeout(() => {
      if (!completed) reject(new Error('Chrome message listener did not respond.'))
    }, 1000)
    const keepOpen = listener(message, sender, (response) => {
      completed = true
      clearTimeout(timeout)
      resolve(response)
    })
    if (keepOpen !== true && !completed) {
      clearTimeout(timeout)
      reject(new Error('Chrome message listener did not keep the response channel open.'))
    }
  })
}

function createManualScheduler() {
  let nextId = 1
  const tasks = new Map()
  return {
    setTimer(callback, delayMs) {
      assert.equal(this, globalThis, 'timer callbacks must be invoked with the Web API receiver')
      const id = nextId
      nextId += 1
      tasks.set(id, { callback, delayMs: Number(delayMs) })
      return id
    },
    clearTimer(id) {
      assert.equal(this, globalThis, 'timer clear callbacks must be invoked with the Web API receiver')
      tasks.delete(id)
    },
    pendingDelays() {
      return [...tasks.values()].map((task) => task.delayMs)
    },
    runDelay(delayMs) {
      const match = [...tasks.entries()].find(([, task]) => task.delayMs === delayMs)
      assert.ok(match, `No scheduled timer has delay ${delayMs}ms; pending: ${JSON.stringify(this.pendingDelays())}`)
      const [id, task] = match
      tasks.delete(id)
      task.callback()
    },
  }
}

function createBehaviorNativePort() {
  const onMessage = createChromeEvent()
  const onDisconnect = createChromeEvent()
  return {
    onMessage,
    onDisconnect,
    posted: [],
    disconnectCount: 0,
    postMessage(message) {
      this.posted.push(message)
    },
    disconnect() {
      this.disconnectCount += 1
      void onDisconnect.emit()
    },
  }
}

function nativeSuccess(type, result) {
  return {
    protocol: 'tokenless.native.v1',
    type,
    ok: true,
    result,
  }
}

function nativeFailure(type, message, code = 'native_test_error') {
  return {
    protocol: 'tokenless.native.v1',
    type,
    ok: false,
    error: { code, message, retryable: false },
  }
}

async function openSettingsPage(browser, baseUrl, plans) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript((initialPlans) => {
    function chromeEvent() {
      const listeners = []
      return {
        addListener(listener) {
          listeners.push(listener)
        },
        emit(value) {
          for (const listener of [...listeners]) listener(value)
        },
      }
    }

    const mock = {
      plans: structuredClone(initialPlans),
      requests: [],
      ports: [],
      respond(index, response) {
        const port = this.ports[index]
        if (!port || port.disconnected) throw new Error(`Native request ${index} is not pending.`)
        port.onMessage.emit(structuredClone(response))
      },
    }

    Object.defineProperty(globalThis, '__nativeMock', {
      configurable: true,
      value: mock,
    })
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          lastError: undefined,
          connectNative(hostName) {
            if (hostName !== 'dev.tokenless.native_host') {
              throw new Error(`Unexpected native host: ${hostName}`)
            }
            const onMessage = chromeEvent()
            const onDisconnect = chromeEvent()
            const port = {
              onMessage,
              onDisconnect,
              disconnected: false,
              postMessage(message) {
                if (port.disconnected) throw new Error('Native port is disconnected.')
                const requestIndex = mock.requests.push(structuredClone(message)) - 1
                mock.ports[requestIndex] = port
                const plan = mock.plans[requestIndex] ?? {}
                if (Object.hasOwn(plan, 'response')) {
                  setTimeout(() => {
                    if (!port.disconnected) onMessage.emit(structuredClone(plan.response))
                  }, Number(plan.delayMs ?? 0))
                }
              },
              disconnect() {
                if (port.disconnected) return
                port.disconnected = true
                onDisconnect.emit()
              },
            }
            return port
          },
        },
      },
    })
  }, plans)
  await page.goto(`${baseUrl}/settings/index.html`, { waitUntil: 'domcontentloaded' })
  return { context, page, pageErrors }
}

async function openProviderFixture(browser, url, html) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
  await context.addInitScript(() => {
    const listeners = []
    const runtimeMessages = []
    Object.defineProperty(globalThis, '__tokenlessRuntimeMessages', {
      configurable: true,
      value: runtimeMessages,
    })
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          onMessage: {
            addListener(listener) {
              listeners.push(listener)
            },
          },
          async sendMessage(message) {
            runtimeMessages.push(structuredClone(message))
            return message?.type === 'tokenless.bridge.trusted_click'
              ? { ok: false, code: 'debugger_control_unavailable' }
              : { ok: true }
          },
        },
      },
    })
    Object.defineProperty(globalThis, '__dispatchTokenlessMessage', {
      configurable: true,
      value(message) {
        return new Promise((resolve, reject) => {
          const listener = listeners[0]
          if (!listener) {
            reject(new Error('Provider content listener is not installed.'))
            return
          }
          let responded = false
          const keepChannelOpen = listener(message, {}, (response) => {
            responded = true
            resolve(response)
          })
          if (keepChannelOpen !== true && !responded) {
            reject(new Error('Provider content listener did not keep the response channel open.'))
          }
        })
      },
    })
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const parsed = new URL(url)
  await page.route(`${parsed.origin}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: html,
  }))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.addScriptTag({ path: path.join(extensionDist, 'content/provider-content.js') })
  return { context, page, pageErrors }
}

async function startStaticServer(directory) {
  const absoluteRoot = path.resolve(directory)
  const server = http.createServer((request, response) => {
    let filePath
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      filePath = path.resolve(absoluteRoot, pathname.replace(/^\/+/, ''))
    } catch {
      response.writeHead(400).end('Bad request')
      return
    }
    if (filePath !== absoluteRoot && !filePath.startsWith(`${absoluteRoot}${path.sep}`)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    fs.readFile(filePath, (error, contents) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code === 'ENOENT' ? 'Not found' : 'Read failed')
        return
      }
      response.writeHead(200, { 'content-type': contentType(filePath) })
      response.end(contents)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.json') || filePath.endsWith('.map')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function listRelativeFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return listRelativeFiles(absolute).map((file) => path.posix.join(entry.name, file))
    }
    return entry.isFile() ? [entry.name] : []
  }).sort()
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(5)
  }
  throw new Error('Timed out waiting for extension background behavior.')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
