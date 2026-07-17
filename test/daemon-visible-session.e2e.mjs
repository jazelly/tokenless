import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import fs from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionPath = path.join(root, 'packages/extension/dist/extension')
const chatGptRealDomFixturePath = path.join(root, 'test/fixtures/chatgpt-real-dom-fixture.html')
const claudeRealDomFixturePath = path.join(root, 'test/fixtures/claude-real-dom-fixture.html')
const geminiRealDomFixturePath = path.join(root, 'test/fixtures/gemini-real-dom-fixture.html')
const grokRealDomFixturePath = path.join(root, 'test/fixtures/grok-real-dom-fixture.html')
const providerAttachmentDomFixturePath = path.join(root, 'test/fixtures/provider-attachment-dom-fixture.html')
const testResultsRoot = path.join(root, 'test-results', 'tokenless-e2e', 'runs')

test('daemon job completes through extension service worker and ChatGPT real-DOM fixture without task page', {
  skip: process.env.TOKENLESS_E2E !== '1' ? 'set TOKENLESS_E2E=1 to run fixture browser E2E' : false,
  timeout: 180000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    createDaemonJob,
    getDaemonJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    readLiveBridgeMarker,
  } = await import('../packages/cli/dist/src/index.js')
  const { DEFAULT_EXTENSION_ID } = await import('../packages/cli/dist/src/default-extension-id.js')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-daemon-e2e-'))
  const artifactDir = await createArtifactDir()
  const userDataDir = path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const prompt = 'Tokenless daemon E2E DOM prompt 93742'
  const events = []
  const observedUrls = []
  let manifestBackup = []
  let registryBackup = []
  let daemon
  let context
  let providerFixture

  try {
    daemon = startDaemon({ homeDir: tokenlessHome, port })
    await waitForDaemonReady(daemonUrl, daemon)
    events.push({ at: new Date().toISOString(), event: 'daemon_ready', daemonUrl })

    // Install before the first browser process starts. Chromium discovers
    // user-level Native Messaging manifests at startup.
    const manifestHome = userDataDir
    const browsers = fixtureNativeHostBrowsers()
    registryBackup = snapshotWindowsNativeHostRegistry(
      browsers,
      NATIVE_HOST_NAME,
      windowsNativeHostManifestPath(tokenlessHome, NATIVE_HOST_NAME)
    )
    manifestBackup = await snapshotFiles(browsers.flatMap((browser) => (
      nativeMessagingHostDirs(browser, manifestHome).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
    )))
    const installed = await installNativeHost({
      homeDir: tokenlessHome,
      manifestHome,
      extensionId: DEFAULT_EXTENSION_ID,
      browsers,
    })
    assert.ok(installed.manifests.length >= 1)
    events.push({
      at: new Date().toISOString(),
      event: 'native_host_installed',
      manifests: installed.manifests,
      executable: installed.nativeHostExecutable,
    })

    const chatGptFixture = await fs.readFile(chatGptRealDomFixturePath, 'utf8')
    providerFixture = await startHttpsFixtureServer({
      body: chatGptFixture,
      events,
      providerHost: 'chatgpt.com',
    })
    events.push({
      at: new Date().toISOString(),
      event: 'provider_fixture_https_started',
      port: providerFixture.port,
      realProviderDom: true,
    })

    context = await launchTokenlessContext(
      chromium,
      userDataDir,
      tokenlessHome,
      daemonUrl,
      providerFixture,
      'chatgpt.com'
    )
    observeContextUrls(context, observedUrls)
    const extensionId = await discoverExtensionId(context)
    assert.equal(extensionId, DEFAULT_EXTENSION_ID)
    events.push({ at: new Date().toISOString(), event: 'extension_discovered', extensionId })

    await ensureDaemonBridgeStarted(context)
    const bridgeMarker = await waitForBridgeMarker({ tokenlessHome, readLiveBridgeMarker, context })
    events.push({
      at: new Date().toISOString(),
      event: 'daemon_bridge_ready',
      sessionId: bridgeMarker.sessionId,
    })
    const pagesBeforeRun = new Set(context.pages())

    const cliRun = await runProcess(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'run',
      '--prompt',
      prompt,
      '--provider',
      'chatgpt',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      'https://chatgpt.com/',
      '--model',
      'GPT-5.5',
      '--model-fallback',
      'o3',
      '--effort',
      'high',
      '--read-delay-ms',
      '0',
      '--read-timeout-ms',
      '10000',
      '--no-open',
      '--json',
    ], { cwd: root })

    assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout)
    const cliPayload = JSON.parse(cliRun.stdout)
    assert.equal(cliPayload.transport, 'daemon')
    assert.equal(cliPayload.provider, 'chatgpt')
    assert.equal(cliPayload.taskUrl, undefined)
    assert.equal(cliPayload.runnerUrl, undefined)
    assert.deepEqual(cliPayload.result?.result?.read?.sources, [{
      url: 'https://example.com/tokenless-fixture-source?keep=fixture',
      title: 'Fixture citation',
      domain: 'example.com',
    }])
    assert.match(
      cliPayload.compactOutput,
      /Sources:\n- Fixture citation: https:\/\/example\.com\/tokenless-fixture-source\?keep=fixture/
    )
    assert.doesNotMatch(cliRun.stdout, /taskUrl|task\/task\.html|runnerUrl|daemon\/runner\.html/)

    const created = await getDaemonJob({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: cliPayload.jobId,
    })
    assert.ok(['queued', 'claimed', 'succeeded'].includes(created.status), JSON.stringify(created, null, 2))
    assert.equal(created.claim_token, undefined)
    assert.match(created.request_json.prompt, /Tokenless daemon E2E DOM prompt 93742/)
    await fs.writeFile(path.join(artifactDir, 'cli-daemon-run-payload.json'), `${JSON.stringify(cliPayload, null, 2)}\n`, 'utf8')
    events.push({ at: new Date().toISOString(), event: 'cli_daemon_job_created', jobId: created.job_id })

    const completed = await waitForDaemonJobStatus({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: created.job_id,
      statuses: ['succeeded', 'failed'],
      daemon,
      getDaemonJob,
    })
    await fs.writeFile(
      path.join(artifactDir, 'daemon-terminal-job.json'),
      `${JSON.stringify(completed, null, 2)}\n`,
      'utf8'
    )
    if (completed.status !== 'succeeded') {
      const failedProviderPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/'))
      if (failedProviderPage) {
        await failedProviderPage.screenshot({
          path: path.join(artifactDir, '00-chatgpt-fixture-failure.png'),
          fullPage: true,
        })
        const providerDiagnostic = await failedProviderPage.evaluate(() => {
          const describe = (selector) => [...document.querySelectorAll(selector)].map((node) => {
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            return {
              selector,
              connected: node.isConnected,
              checkVisibility: node.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? null,
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
              style: { display: style.display, visibility: style.visibility, opacity: style.opacity, contentVisibility: style.contentVisibility },
            }
          })
          return {
            url: location.href,
            viewport: { width: innerWidth, height: innerHeight },
            readyState: document.readyState,
            composer: describe('#prompt-textarea'),
            send: describe('[data-testid="composer-send-button"]'),
          }
        })
        await fs.writeFile(
          path.join(artifactDir, 'provider-failure-diagnostic.json'),
          `${JSON.stringify(providerDiagnostic, null, 2)}\n`,
          'utf8'
        )
      }
    }
    assert.equal(completed.status, 'succeeded')
    assert.equal(completed.claim_token, undefined)
    assert.match(completed.result_json.text, /visible ChatGPT real-DOM fixture answer/)
    assert.match(completed.result_json.text, /Tokenless daemon E2E DOM prompt 93742/)
    assert.doesNotMatch(completed.result_json.text, /stale ChatGPT real-DOM fixture answer/)
    assert.doesNotMatch(completed.result_json.text, /_streaming/)
    assert.deepEqual(completed.result_json.read.sources, [{
      url: 'https://example.com/tokenless-fixture-source?keep=fixture',
      title: 'Fixture citation',
      domain: 'example.com',
    }])
    assert.equal(completed.result_json.submit.configuration.surface.status, 'chat_selected')
    assert.equal(completed.result_json.submit.configuration.model.status, 'selected')
    assert.equal(completed.result_json.submit.configuration.model.applied, 'GPT-5.5')
    assert.equal(completed.result_json.submit.configuration.effort.status, 'selected')
    assert.equal(completed.result_json.submit.configuration.effort.applied, 'High')

    const providerPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/'))
    assert.ok(providerPage, `extension did not open the visible ChatGPT page: ${JSON.stringify(context.pages().map((page) => page.url()))}`)
    await providerPage.bringToFront()
    await providerPage.screenshot({
      path: path.join(artifactDir, '01-chatgpt-fixture-opened-by-extension.png'),
      animations: 'disabled',
    })
    assert.match(await providerPage.locator('[data-message-author-role="user"]').last().innerText(), /Tokenless daemon E2E DOM prompt 93742/)
    assert.match(await providerPage.locator('[data-message-author-role="assistant"]').last().innerText(), /visible ChatGPT real-DOM fixture answer/)
    const pageUrlsAfterSuccess = context.pages().map((page) => page.url())
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/task/task.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/daemon/runner.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/settings/')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    const pagesOpenedByRun = context.pages().filter((page) => !pagesBeforeRun.has(page))
    assert.deepEqual(pagesOpenedByRun.map((page) => page.url()), [providerPage.url()],
      'task execution must open exactly one visible provider page')
    assertNoTaskPageObserved(observedUrls)
    assertNoRunnerPageObserved(observedUrls)

    const pagesBeforeControlInspection = new Set(context.pages())
    const controlInspection = spawnSync(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'chatgpt-controls',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      providerPage.url(),
      '--no-open',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
    })
    assert.equal(controlInspection.status, 0, controlInspection.stderr || controlInspection.stdout)
    const controlInspectionPayload = JSON.parse(controlInspection.stdout)
    const controls = controlInspectionPayload.result?.result?.controls ?? controlInspectionPayload.result?.controls
    assert.equal(controls.available, true)
    assert.deepEqual(controls.efforts.map((item) => item.id), ['instant', 'medium', 'high', 'extra_high', 'pro'])
    assert.deepEqual(controls.models.map((item) => item.label), ['GPT-5.6 Sol', 'GPT-5.5', 'GPT-5.4', 'GPT-5.3', 'o3'])
    assert.deepEqual(
      context.pages().filter((page) => !pagesBeforeControlInspection.has(page)).map((page) => page.url()),
      [],
      'chatgpt-controls must reuse the visible provider tab without opening another page'
    )

    const pagesBeforeSnapshot = new Set(context.pages())
    const snapshotRun = spawnSync(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'snapshot-dom',
      '--provider',
      'chatgpt',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      providerPage.url(),
      '--no-open',
      '--timeout-ms',
      '15000',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
    })
    assert.equal(snapshotRun.status, 0, snapshotRun.stderr || snapshotRun.stdout)
    const snapshotPayload = JSON.parse(snapshotRun.stdout)
    assert.equal(snapshotPayload.transport, 'daemon')
    assert.equal(snapshotPayload.snapshot.sanitized, true)
    assert.equal(snapshotPayload.snapshot.visibleTextPath, null)
    const snapshotHtml = await fs.readFile(snapshotPayload.snapshot.htmlPath, 'utf8')
    assert.doesNotMatch(snapshotHtml, /Tokenless daemon E2E DOM prompt 93742/)
    assert.doesNotMatch(snapshotHtml, /visible ChatGPT real-DOM fixture answer/)
    assert.deepEqual(
      context.pages().filter((page) => !pagesBeforeSnapshot.has(page)).map((page) => page.url()),
      [],
      'snapshot-dom must reuse the provider tab without opening another page'
    )
    events.push({
      at: new Date().toISOString(),
      event: 'snapshot_completed_without_new_page',
      jobId: snapshotPayload.jobId,
      htmlPath: snapshotPayload.snapshot.htmlPath,
    })

    const invalid = await createDaemonJob({
      daemonUrl,
      homeDir: tokenlessHome,
      provider: 'chatgpt',
      action: 'unsupported_for_e2e',
      requestJson: {
        requestId: 'daemon-e2e-invalid-request',
        targetUrl: 'https://chatgpt.com/',
        prompt: 'This invalid action must fail before provider submission.',
      },
    })
    await ensureDaemonBridgeStarted(context)
    events.push({ at: new Date().toISOString(), event: 'daemon_bridge_ready', jobId: invalid.job_id })
    const failedCompleted = await waitForDaemonJobStatus({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: invalid.job_id,
      statuses: ['failed'],
      daemon,
      getDaemonJob,
    })
    assert.equal(failedCompleted.status, 'failed')
    assert.equal(failedCompleted.claim_token, undefined)
    assert.equal(failedCompleted.claimToken, undefined)
    assert.equal(failedCompleted.error_json.code, 'unsupported_action')
    const pageUrlsAfterFailure = context.pages().map((page) => page.url())
    assert.ok(pageUrlsAfterFailure.every((url) => !url.includes('/task/task.html')), JSON.stringify(pageUrlsAfterFailure, null, 2))
    assert.ok(pageUrlsAfterFailure.every((url) => !url.includes('/daemon/runner.html')), JSON.stringify(pageUrlsAfterFailure, null, 2))
    assertNoTaskPageObserved(observedUrls)
    assertNoRunnerPageObserved(observedUrls)

    const settingsPageOpenedAutomatically = observedUrls.some((entry) => entry.url.includes('/settings/'))
    assert.equal(settingsPageOpenedAutomatically, false, JSON.stringify(observedUrls, null, 2))
    const settingsPage = await context.newPage()
    await settingsPage.goto(`chrome-extension://${extensionId}/settings/index.html`)
    await settingsPage.locator('#history .job-id').getByText(`Job ID: ${created.job_id}`, { exact: true })
      .waitFor({ timeout: 10000 })
    await settingsPage.screenshot({ path: path.join(artifactDir, '02-settings-history-opened-explicitly.png'), fullPage: true })

    await providerPage.bringToFront()
    await providerPage.screenshot({
      path: path.join(artifactDir, '03-chatgpt-fixture-after-daemon.png'),
      animations: 'disabled',
    })
    await fs.writeFile(path.join(artifactDir, 'daemon-completed-job.json'), `${JSON.stringify(completed, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'daemon-failed-job.json'), `${JSON.stringify(failedCompleted, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify({
      ok: true,
      artifactDir,
      mode: 'daemon-fixture-chatgpt',
      fixture: true,
      realProviderDom: true,
      extensionId,
      daemonUrl,
      jobId: created.job_id,
      provider: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      prompt,
      taskPageOpened: observedUrls.some((entry) => entry.url.includes('/task/task.html')),
      runnerPageOpened: observedUrls.some((entry) => entry.url.includes('/daemon/runner.html')),
      settingsPageOpenedAutomatically,
      settingsPageOpenedExplicitly: true,
      observedUrlCount: observedUrls.length,
      events,
    }, null, 2)}\n`, 'utf8')
    console.log(`Tokenless daemon fixture E2E artifacts: ${artifactDir}`)
  } finally {
    const cleanupErrors = []
    await attemptCleanup(cleanupErrors, 'write observed URL artifacts', async () => {
      await fs.writeFile(path.join(artifactDir, 'observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8')
      if (context) {
        await fs.writeFile(path.join(artifactDir, 'pages.json'), `${JSON.stringify(
          context.pages().map((page) => ({ url: page.url() })),
          null,
          2
        )}\n`, 'utf8')
      }
      await fs.writeFile(path.join(artifactDir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8')
    })
    await attemptCleanup(cleanupErrors, 'close browser context', async () => context?.close())
    await attemptCleanup(cleanupErrors, 'close provider fixture', async () => providerFixture?.close())
    const manifestsRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host manifests',
      async () => restoreFiles(manifestBackup)
    )
    const registryRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host registry',
      async () => restoreWindowsNativeHostRegistry(registryBackup)
    )
    await attemptCleanup(cleanupErrors, 'stop daemon', async () => {
      if (daemon) await stopDaemon(daemon)
    })
    if (manifestsRestored && registryRestored) {
      await attemptCleanup(cleanupErrors, 'remove temporary E2E state', async () => {
        await fs.rm(tempRoot, { recursive: true, force: true })
      })
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless fixture E2E cleanup failed')
    }
  }
})

test('visible attachment bytes traverse CLI, daemon, native host, extension, and ChatGPT DOM before prompt submission', {
  skip: process.env.TOKENLESS_E2E !== '1' ? 'set TOKENLESS_E2E=1 to run fixture browser E2E' : false,
  timeout: 180000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    getDaemonJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    readLiveBridgeMarker,
  } = await import('../packages/cli/dist/src/index.js')
  const { DEFAULT_EXTENSION_ID } = await import('../packages/cli/dist/src/default-extension-id.js')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-attachment-e2e-'))
  const userDataDir = path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const nativePackageRoot = path.join(
    root,
    'packages/cli/npm',
    `tokenless-native-${process.platform}-${process.arch}`
  )
  const privateSourceMarker = 'private-source-path-must-not-cross-57419'
  const sourceDir = path.join(tempRoot, privateSourceMarker)
  const sourcePath = path.join(sourceDir, 'visible-e2e-note.txt')
  const attachmentBytes = Buffer.from([
    'Tokenless visible attachment E2E bytes.\n',
    'This payload proves the browser FileList received the exact source bytes.\n',
    'Unicode: π, 中文, مرحبا.\n',
  ].join(''), 'utf8')
  const expectedSha256 = createHash('sha256').update(attachmentBytes).digest('hex')
  const prompt = 'Read the locally attached E2E note 57419.'
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const events = []
  let manifestBackup = []
  let registryBackup = []
  let daemon
  let context
  let providerFixture

  try {
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.writeFile(sourcePath, attachmentBytes)

    daemon = startDaemon({ homeDir: tokenlessHome, port })
    await waitForDaemonReady(daemonUrl, daemon)

    // Install before Chromium starts so the real Manifest V3 service worker can
    // connect to the real Rust native host for this isolated test profile.
    const browsers = fixtureNativeHostBrowsers()
    registryBackup = snapshotWindowsNativeHostRegistry(
      browsers,
      NATIVE_HOST_NAME,
      windowsNativeHostManifestPath(tokenlessHome, NATIVE_HOST_NAME)
    )
    manifestBackup = await snapshotFiles(browsers.flatMap((browser) => (
      nativeMessagingHostDirs(browser, userDataDir).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
    )))
    const installed = await installNativeHost({
      homeDir: tokenlessHome,
      manifestHome: userDataDir,
      extensionId: DEFAULT_EXTENSION_ID,
      browsers,
      packageRoot: nativePackageRoot,
    })
    assert.ok(installed.manifests.length >= 1)

    providerFixture = await startHttpsFixtureServer({
      body: await fs.readFile(providerAttachmentDomFixturePath, 'utf8'),
      events,
      providerHost: 'chatgpt.com',
    })
    context = await launchTokenlessContext(
      chromium,
      userDataDir,
      tokenlessHome,
      daemonUrl,
      providerFixture,
      'chatgpt.com'
    )
    assert.equal(await discoverExtensionId(context), DEFAULT_EXTENSION_ID)
    await ensureDaemonBridgeStarted(context)
    await waitForBridgeMarker({ tokenlessHome, readLiveBridgeMarker, context })

    const cliRun = await runProcess(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'run',
      '--prompt',
      prompt,
      '--provider',
      'chatgpt',
      '--attach-file',
      sourcePath,
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      'https://chatgpt.com/',
      '--read-delay-ms',
      '0',
      '--read-timeout-ms',
      '10000',
      '--no-open',
      '--json',
    ], { cwd: root })
    assert.equal(cliRun.status, 0, `${cliRun.stderr}\n${cliRun.stdout}`)

    const cliPayload = JSON.parse(cliRun.stdout)
    assert.equal(cliPayload.transport, 'daemon')
    assert.equal(cliPayload.provider, 'chatgpt')
    assert.match(cliPayload.compactOutput, /visible attachment fixture answer/)
    const completed = await waitForDaemonJobStatus({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: cliPayload.jobId,
      statuses: ['succeeded', 'failed'],
      daemon,
      getDaemonJob,
    })
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error_json, null, 2))
    assert.match(completed.result_json.text, /visible attachment fixture answer/)

    const attachments = completed.request_json.attachments
    assert.equal(attachments.length, 1)
    const descriptor = attachments[0]
    assert.deepEqual(Object.keys(descriptor).sort(), [
      'attachmentId',
      'bundleId',
      'name',
      'protocol',
      'sha256',
      'size',
      'type',
    ])
    assert.deepEqual(descriptor, {
      protocol: 'tokenless.visible-attachment.v1',
      bundleId: descriptor.bundleId,
      attachmentId: descriptor.attachmentId,
      name: path.basename(sourcePath),
      type: 'text/plain',
      size: attachmentBytes.byteLength,
      sha256: expectedSha256,
    })

    const providerPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/'))
    assert.ok(providerPage, `extension did not open the ChatGPT fixture: ${JSON.stringify(context.pages().map((page) => page.url()))}`)
    const visibleEvidence = await providerPage.evaluate(async () => {
      const input = document.querySelector('input#upload-files[type="file"][multiple]')
      const file = input?.files?.[0]
      if (!file) return null
      const bytes = [...new Uint8Array(await file.arrayBuffer())]
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
      const sha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      const fixture = globalThis.__attachmentFixture
      return {
        assistantText: document.querySelector('[data-message-author-role="assistant"]')?.textContent ?? '',
        bytes,
        chipText: document.querySelector('#attachment-evidence .attachment-chip')?.textContent ?? '',
        events: [...fixture.events],
        file: { name: file.name, size: file.size, type: file.type, sha256 },
        records: fixture.records,
        submissions: fixture.submissions,
        userText: document.querySelector('[data-message-author-role="user"]')?.textContent ?? '',
      }
    })
    assert.ok(visibleEvidence, 'the exact ChatGPT file input must retain a FileList entry')
    assert.deepEqual(visibleEvidence.file, {
      name: path.basename(sourcePath),
      size: attachmentBytes.byteLength,
      type: 'text/plain',
      sha256: expectedSha256,
    })
    assert.deepEqual(visibleEvidence.bytes, [...attachmentBytes])
    assert.equal(visibleEvidence.chipText, path.basename(sourcePath))
    assert.deepEqual(visibleEvidence.records, [{
      bytes: [...attachmentBytes],
      name: path.basename(sourcePath),
      size: attachmentBytes.byteLength,
      type: 'text/plain',
    }])
    assert.equal(visibleEvidence.submissions.length, 1)
    assert.equal(visibleEvidence.submissions[0].fileName, path.basename(sourcePath))
    assert.equal(visibleEvidence.submissions[0].submittedAfterVisibleAttachment, true)
    assert.match(visibleEvidence.submissions[0].prompt, /Read the locally attached E2E note 57419/)
    assert.match(visibleEvidence.userText, /Read the locally attached E2E note 57419/)
    assert.match(visibleEvidence.assistantText, /visible attachment fixture answer/)
    const chipVisibleIndex = visibleEvidence.events.indexOf('chip-visible')
    const submitIndex = visibleEvidence.events.indexOf('submit')
    assert.ok(chipVisibleIndex >= 0, JSON.stringify(visibleEvidence.events))
    assert.ok(submitIndex > chipVisibleIndex, JSON.stringify(visibleEvidence.events))
    assert.ok(
      visibleEvidence.events.slice(chipVisibleIndex + 1, submitIndex).includes('prompt-input'),
      JSON.stringify(visibleEvidence.events)
    )

    const stagedBundlePath = path.join(tokenlessHome, 'attachments', descriptor.bundleId)
    const stagedFilePath = path.join(stagedBundlePath, `${descriptor.attachmentId}.bin`)
    await waitForPathAbsent(stagedBundlePath)
    assert.equal(await pathExists(stagedBundlePath), false, 'terminal completion must remove the staged bundle')
    assert.equal(await pathExists(sourcePath), true, 'terminal cleanup must not remove the source file')

    const pagesBeforeUnifiedFile = new Set(context.pages())
    const unifiedFileRun = await runProcess(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'provider-action',
      '--action',
      'file.upload',
      '--provider',
      'chatgpt',
      '--attach-file',
      sourcePath,
      '--task-id',
      'unified-file-upload-e2e-57419',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      'https://chatgpt.com/',
      '--no-open',
      '--json',
    ], { cwd: root })
    assert.equal(unifiedFileRun.status, 0, `${unifiedFileRun.stderr}\n${unifiedFileRun.stdout}`)
    const unifiedFilePayload = JSON.parse(unifiedFileRun.stdout)
    const unifiedFileJob = await waitForDaemonJobStatus({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: unifiedFilePayload.jobId,
      statuses: ['succeeded', 'failed'],
      daemon,
      getDaemonJob,
    })
    assert.equal(unifiedFileJob.status, 'succeeded', JSON.stringify(unifiedFileJob.error_json, null, 2))
    assert.equal(unifiedFileJob.action, 'visible_provider_action')
    assert.deepEqual(unifiedFileJob.request_json.visibleAction, {
      protocol: 'tokenless.visible-provider-action.v1',
      requestId: 'unified-file-upload-e2e-57419',
      provider: 'chatgpt',
      action: 'file.upload',
      payload: { attachments: unifiedFileJob.request_json.attachments },
    })
    assert.deepEqual(unifiedFileJob.result_json.attachments, [{
      attachmentId: unifiedFileJob.request_json.attachments[0].attachmentId,
      name: path.basename(sourcePath),
      visible: true,
    }])
    const unifiedFilePages = context.pages().filter((page) => !pagesBeforeUnifiedFile.has(page))
    assert.equal(unifiedFilePages.length, 1, 'standalone file.upload must create exactly one clean provider page')
    const unifiedProviderPage = unifiedFilePages[0]
    assert.ok(unifiedProviderPage.url().startsWith('https://chatgpt.com/'))
    const unifiedFileEvidence = await unifiedProviderPage.evaluate(async () => {
      const file = document.querySelector('input#upload-files[type="file"][multiple]')?.files?.[0]
      if (!file) return null
      return {
        bytes: [...new Uint8Array(await file.arrayBuffer())],
        chipText: document.querySelector('#attachment-evidence .attachment-chip')?.textContent ?? '',
        events: [...globalThis.__attachmentFixture.events],
        file: { name: file.name, size: file.size, type: file.type },
        submissions: [...globalThis.__attachmentFixture.submissions],
      }
    })
    assert.ok(unifiedFileEvidence, 'standalone file.upload must retain the exact FileList bytes')
    assert.deepEqual(unifiedFileEvidence.file, {
      name: path.basename(sourcePath),
      size: attachmentBytes.byteLength,
      type: 'text/plain',
    })
    assert.deepEqual(unifiedFileEvidence.bytes, [...attachmentBytes])
    assert.equal(unifiedFileEvidence.chipText, path.basename(sourcePath))
    assert.deepEqual(unifiedFileEvidence.submissions, [], 'file.upload must not implicitly submit a prompt')

    const pagesBeforeUnifiedInput = context.pages().length
    const unifiedInputRun = await runProcess(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'provider-action',
      '--action',
      'prompt.input',
      '--provider',
      'chatgpt',
      '--prompt',
      'Draft beside the unified E2E attachment.',
      '--task-id',
      'unified-prompt-input-e2e-57419',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      'https://chatgpt.com/',
      '--no-open',
      '--json',
    ], { cwd: root })
    assert.equal(unifiedInputRun.status, 0, `${unifiedInputRun.stderr}\n${unifiedInputRun.stdout}`)
    assert.equal(context.pages().length, pagesBeforeUnifiedInput, 'prompt.input must reuse the file.upload affinity page')
    assert.equal(
      await unifiedProviderPage.locator('#prompt-textarea').innerText(),
      'Draft beside the unified E2E attachment.'
    )

    const unifiedSubmitRun = await runProcess(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'provider-action',
      '--action',
      'prompt.submit',
      '--provider',
      'chatgpt',
      '--prompt',
      'Submit the unified E2E attachment 57419.',
      '--task-id',
      'unified-prompt-submit-e2e-57419',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      'https://chatgpt.com/',
      '--no-open',
      '--json',
    ], { cwd: root })
    assert.equal(unifiedSubmitRun.status, 0, `${unifiedSubmitRun.stderr}\n${unifiedSubmitRun.stdout}`)
    assert.equal(context.pages().length, pagesBeforeUnifiedInput, 'prompt.submit must reuse the file.upload affinity page')
    const unifiedSubmitPayload = JSON.parse(unifiedSubmitRun.stdout)
    assert.deepEqual(unifiedSubmitPayload.result?.result, {
      submissionProof: 'visible-submit-unified-prompt-submit-e2e-57419',
      visible: true,
      provider: 'chatgpt',
    })
    const unifiedSubmissionEvidence = await unifiedProviderPage.evaluate(() => ({
      events: [...globalThis.__attachmentFixture.events],
      submissions: [...globalThis.__attachmentFixture.submissions],
      userText: document.querySelector('[data-message-author-role="user"]')?.textContent ?? '',
    }))
    assert.equal(unifiedSubmissionEvidence.submissions.length, 1)
    assert.equal(unifiedSubmissionEvidence.submissions[0].fileName, path.basename(sourcePath))
    assert.equal(unifiedSubmissionEvidence.submissions[0].submittedAfterVisibleAttachment, true)
    assert.match(unifiedSubmissionEvidence.userText, /Submit the unified E2E attachment 57419/)
    assert.ok(
      unifiedSubmissionEvidence.events.indexOf('submit') > unifiedSubmissionEvidence.events.indexOf('chip-visible'),
      JSON.stringify(unifiedSubmissionEvidence.events)
    )

    const externallyVisible = JSON.stringify({
      cliPayload,
      cliStderr: cliRun.stderr,
      daemonStdout: daemon.stdoutText,
      daemonStderr: daemon.stderrText,
      fixture: visibleEvidence,
      request: completed.request_json,
      result: completed.result_json,
      unifiedFilePayload,
      unifiedFileResult: unifiedFileJob.result_json,
      unifiedInputPayload: JSON.parse(unifiedInputRun.stdout),
      unifiedSubmitPayload,
    })
    assertNoPrivateAttachmentPaths(externallyVisible, [sourceDir, sourcePath, stagedBundlePath, stagedFilePath])
    assert.doesNotMatch(externallyVisible, /sourcePath|stagedPath|private-source-path-must-not-cross-57419/)
  } finally {
    const cleanupErrors = []
    await attemptCleanup(cleanupErrors, 'close browser context', async () => context?.close())
    await attemptCleanup(cleanupErrors, 'close provider fixture', async () => providerFixture?.close())
    const manifestsRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host manifests',
      async () => restoreFiles(manifestBackup)
    )
    const registryRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host registry',
      async () => restoreWindowsNativeHostRegistry(registryBackup)
    )
    await attemptCleanup(cleanupErrors, 'stop daemon', async () => {
      if (daemon) await stopDaemon(daemon)
    })
    if (manifestsRestored && registryRestored) {
      await attemptCleanup(cleanupErrors, 'remove temporary E2E state', async () => {
        await fs.rm(tempRoot, { recursive: true, force: true })
      })
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless visible attachment E2E cleanup failed')
    }
  }
})

test('daemon job completes through extension service worker and Claude real-DOM fixture without internal pages', {
  skip: process.env.TOKENLESS_E2E !== '1' ? 'set TOKENLESS_E2E=1 to run fixture browser E2E' : false,
  timeout: 180000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    getDaemonJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    readLiveBridgeMarker,
  } = await import('../packages/cli/dist/src/index.js')
  const { DEFAULT_EXTENSION_ID } = await import('../packages/cli/dist/src/default-extension-id.js')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-claude-daemon-e2e-'))
  const artifactDir = await createArtifactDir()
  const userDataDir = path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const prompt = 'Tokenless Claude daemon E2E DOM prompt 68421'
  const targetUrl = 'https://claude.ai/new'
  const conversationUrl = 'https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174001'
  const events = []
  const observedUrls = []
  let manifestBackup = []
  let registryBackup = []
  let daemon
  let context
  let providerFixture

  try {
    daemon = startDaemon({ homeDir: tokenlessHome, port })
    await waitForDaemonReady(daemonUrl, daemon)
    events.push({ at: new Date().toISOString(), event: 'daemon_ready', daemonUrl })

    const browsers = fixtureNativeHostBrowsers()
    registryBackup = snapshotWindowsNativeHostRegistry(
      browsers,
      NATIVE_HOST_NAME,
      windowsNativeHostManifestPath(tokenlessHome, NATIVE_HOST_NAME)
    )
    manifestBackup = await snapshotFiles(browsers.flatMap((browser) => (
      nativeMessagingHostDirs(browser, userDataDir).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
    )))
    const installed = await installNativeHost({
      homeDir: tokenlessHome,
      manifestHome: userDataDir,
      extensionId: DEFAULT_EXTENSION_ID,
      browsers,
    })
    assert.ok(installed.manifests.length >= 1)
    events.push({
      at: new Date().toISOString(),
      event: 'native_host_installed',
      manifests: installed.manifests,
      executable: installed.nativeHostExecutable,
    })

    const claudeFixture = await fs.readFile(claudeRealDomFixturePath, 'utf8')
    providerFixture = await startHttpsFixtureServer({
      body: claudeFixture,
      events,
      providerHost: 'claude.ai',
    })
    context = await launchTokenlessContext(
      chromium,
      userDataDir,
      tokenlessHome,
      daemonUrl,
      providerFixture,
      'claude.ai'
    )
    observeContextUrls(context, observedUrls)
    const extensionId = await discoverExtensionId(context)
    assert.equal(extensionId, DEFAULT_EXTENSION_ID)

    await ensureDaemonBridgeStarted(context)
    const bridgeMarker = await waitForBridgeMarker({ tokenlessHome, readLiveBridgeMarker, context })
    assert.equal(bridgeMarker.protocol, 'tokenless.extension-bridge-state.v1')
    events.push({
      at: new Date().toISOString(),
      event: 'daemon_bridge_ready',
      sessionId: bridgeMarker.sessionId,
    })
    const pagesBeforeRun = new Set(context.pages())
    const observedUrlCountBeforeRun = observedUrls.length

    const cliRun = await runProcess(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'run',
      '--prompt',
      prompt,
      '--provider',
      'claude',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      targetUrl,
      '--read-delay-ms',
      '0',
      '--read-timeout-ms',
      '10000',
      '--no-open',
      '--json',
    ], { cwd: root })

    assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout)
    const cliPayload = JSON.parse(cliRun.stdout)
    assert.equal(cliPayload.transport, 'daemon')
    assert.equal(cliPayload.provider, 'claude')
    assert.equal(cliPayload.taskUrl, undefined)
    assert.equal(cliPayload.runnerUrl, undefined)
    assert.match(cliPayload.compactOutput, /visible Claude real-DOM fixture answer/)
    assert.match(cliPayload.compactOutput, /Tokenless Claude daemon E2E DOM prompt 68421/)
    assert.doesNotMatch(cliRun.stdout, /taskUrl|task\/task\.html|runnerUrl|daemon\/runner\.html/)

    const created = await getDaemonJob({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: cliPayload.jobId,
    })
    assert.ok(['queued', 'claimed', 'succeeded'].includes(created.status), JSON.stringify(created, null, 2))
    assert.equal(created.claim_token, undefined)
    assert.match(created.request_json.prompt, /Tokenless Claude daemon E2E DOM prompt 68421/)
    events.push({ at: new Date().toISOString(), event: 'cli_daemon_job_created', jobId: created.job_id })

    const completed = await waitForDaemonJobStatus({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: created.job_id,
      statuses: ['succeeded', 'failed'],
      daemon,
      getDaemonJob,
    })
    await fs.writeFile(
      path.join(artifactDir, 'claude-daemon-terminal-job.json'),
      `${JSON.stringify(completed, null, 2)}\n`,
      'utf8'
    )
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed, null, 2))
    assert.equal(completed.claim_token, undefined)
    assert.equal(completed.result_json.read.url, conversationUrl)
    assert.match(completed.result_json.text, /visible Claude real-DOM fixture answer/)
    assert.match(completed.result_json.text, /Tokenless Claude daemon E2E DOM prompt 68421/)
    assert.doesNotMatch(completed.result_json.text, /stale Claude real-DOM fixture answer/)
    assert.doesNotMatch(completed.result_json.text, /_streaming/)

    const providerPage = context.pages().find((page) => page.url().startsWith('https://claude.ai/'))
    assert.ok(providerPage, `extension did not open the visible Claude page: ${JSON.stringify(context.pages().map((page) => page.url()))}`)
    assert.equal(providerPage.url(), conversationUrl)
    await providerPage.bringToFront()
    await providerPage.screenshot({
      path: path.join(artifactDir, '01-claude-fixture-after-daemon.png'),
      animations: 'disabled',
    })
    const userMessage = providerPage.locator(
      '[data-testid="virtual-message-list"] [data-role="user"]'
    ).last()
    assert.match(await userMessage.innerText(), /Tokenless Claude daemon E2E DOM prompt 68421/)
    const assistantMessage = providerPage.locator(
      '[data-testid="virtual-message-list"] .font-claude-response-body'
    ).last()
    assert.match(await assistantMessage.innerText(), /visible Claude real-DOM fixture answer/)
    assert.match(await assistantMessage.innerText(), /Tokenless Claude daemon E2E DOM prompt 68421/)
    assert.equal(await providerPage.locator('[data-is-streaming="true"]').count(), 0)

    const pageUrlsAfterSuccess = context.pages().map((page) => page.url())
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/task/task.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/daemon/runner.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/settings/')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    const pagesOpenedByRun = context.pages().filter((page) => !pagesBeforeRun.has(page))
    assert.deepEqual(
      pagesOpenedByRun.map((page) => page.url()),
      [conversationUrl],
      'Claude task execution must open exactly one visible provider page'
    )
    const urlsObservedDuringRun = observedUrls
      .slice(observedUrlCountBeforeRun)
      .map((entry) => entry.url)
    assert.ok(
      urlsObservedDuringRun.every((url) => url === 'about:blank' || url.startsWith('https://claude.ai/')),
      `Claude task execution opened a non-provider page: ${JSON.stringify(urlsObservedDuringRun, null, 2)}`
    )
    assertNoTaskPageObserved(observedUrls)
    assertNoRunnerPageObserved(observedUrls)
    assert.equal(
      observedUrls.some((entry) => entry.url.includes('/settings/')),
      false,
      JSON.stringify(observedUrls, null, 2)
    )

    await fs.writeFile(path.join(artifactDir, 'claude-observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'claude-summary.json'), `${JSON.stringify({
      ok: true,
      mode: 'daemon-fixture-claude',
      fixture: true,
      realProviderDom: true,
      extensionId,
      daemonUrl,
      jobId: completed.job_id,
      provider: 'claude',
      targetUrl,
      conversationUrl,
      prompt,
      taskPageOpened: observedUrls.some((entry) => entry.url.includes('/task/task.html')),
      runnerPageOpened: observedUrls.some((entry) => entry.url.includes('/daemon/runner.html')),
      settingsPageOpened: observedUrls.some((entry) => entry.url.includes('/settings/')),
      events,
    }, null, 2)}\n`, 'utf8')
    console.log(`Tokenless Claude daemon fixture E2E artifacts: ${artifactDir}`)
  } finally {
    const cleanupErrors = []
    await attemptCleanup(cleanupErrors, 'write Claude observed URL artifacts', async () => {
      await fs.writeFile(path.join(artifactDir, 'claude-observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8')
    })
    await attemptCleanup(cleanupErrors, 'close browser context', async () => context?.close())
    await attemptCleanup(cleanupErrors, 'close provider fixture', async () => providerFixture?.close())
    const manifestsRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host manifests',
      async () => restoreFiles(manifestBackup)
    )
    const registryRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host registry',
      async () => restoreWindowsNativeHostRegistry(registryBackup)
    )
    await attemptCleanup(cleanupErrors, 'stop daemon', async () => {
      if (daemon) await stopDaemon(daemon)
    })
    if (manifestsRestored && registryRestored) {
      await attemptCleanup(cleanupErrors, 'remove temporary Claude E2E state', async () => {
        await fs.rm(tempRoot, { recursive: true, force: true })
      })
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless Claude fixture E2E cleanup failed')
    }
  }
})

test('daemon job completes through extension service worker and Gemini real-DOM fixture without internal pages', {
  skip: process.env.TOKENLESS_E2E !== '1' ? 'set TOKENLESS_E2E=1 to run fixture browser E2E' : false,
  timeout: 180000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    getDaemonJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    readLiveBridgeMarker,
  } = await import('../packages/cli/dist/src/index.js')
  const { DEFAULT_EXTENSION_ID } = await import('../packages/cli/dist/src/default-extension-id.js')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-gemini-daemon-e2e-'))
  const artifactDir = await createArtifactDir()
  const userDataDir = path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const prompt = 'Tokenless Gemini daemon E2E DOM prompt 52963'
  const targetUrl = 'https://gemini.google.com/app'
  const conversationUrl = 'https://gemini.google.com/app/4b9f2c7d1e6a'
  const events = []
  const observedUrls = []
  let manifestBackup = []
  let registryBackup = []
  let daemon
  let context
  let providerFixture

  try {
    daemon = startDaemon({ homeDir: tokenlessHome, port })
    await waitForDaemonReady(daemonUrl, daemon)
    events.push({ at: new Date().toISOString(), event: 'daemon_ready', daemonUrl })

    const browsers = fixtureNativeHostBrowsers()
    registryBackup = snapshotWindowsNativeHostRegistry(
      browsers,
      NATIVE_HOST_NAME,
      windowsNativeHostManifestPath(tokenlessHome, NATIVE_HOST_NAME)
    )
    manifestBackup = await snapshotFiles(browsers.flatMap((browser) => (
      nativeMessagingHostDirs(browser, userDataDir).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
    )))
    const installed = await installNativeHost({
      homeDir: tokenlessHome,
      manifestHome: userDataDir,
      extensionId: DEFAULT_EXTENSION_ID,
      browsers,
    })
    assert.ok(installed.manifests.length >= 1)
    events.push({
      at: new Date().toISOString(),
      event: 'native_host_installed',
      manifests: installed.manifests,
      executable: installed.nativeHostExecutable,
    })

    const geminiFixture = await fs.readFile(geminiRealDomFixturePath, 'utf8')
    providerFixture = await startHttpsFixtureServer({
      body: geminiFixture,
      events,
      providerHost: 'gemini.google.com',
    })
    context = await launchTokenlessContext(
      chromium,
      userDataDir,
      tokenlessHome,
      daemonUrl,
      providerFixture,
      'gemini.google.com'
    )
    observeContextUrls(context, observedUrls)
    const extensionId = await discoverExtensionId(context)
    assert.equal(extensionId, DEFAULT_EXTENSION_ID)

    await ensureDaemonBridgeStarted(context)
    const bridgeMarker = await waitForBridgeMarker({ tokenlessHome, readLiveBridgeMarker, context })
    assert.equal(bridgeMarker.protocol, 'tokenless.extension-bridge-state.v1')
    events.push({
      at: new Date().toISOString(),
      event: 'daemon_bridge_ready',
      sessionId: bridgeMarker.sessionId,
    })
    const pagesBeforeRun = new Set(context.pages())
    const observedUrlCountBeforeRun = observedUrls.length

    const cliRun = await runProcess(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'run',
      '--prompt',
      prompt,
      '--provider',
      'gemini',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      targetUrl,
      '--read-delay-ms',
      '0',
      '--read-timeout-ms',
      '10000',
      '--no-open',
      '--json',
    ], { cwd: root })

    assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout)
    const cliPayload = JSON.parse(cliRun.stdout)
    assert.equal(cliPayload.transport, 'daemon')
    assert.equal(cliPayload.provider, 'gemini')
    assert.equal(cliPayload.taskUrl, undefined)
    assert.equal(cliPayload.runnerUrl, undefined)
    assert.equal(cliPayload.result?.result?.submit?.provider, 'gemini')
    assert.equal(cliPayload.result?.result?.submit?.url, targetUrl)
    assert.equal(cliPayload.result?.result?.read?.provider, 'gemini')
    assert.equal(cliPayload.result?.result?.read?.url, conversationUrl)
    assert.match(cliPayload.compactOutput, /visible Gemini real-DOM fixture answer/)
    assert.match(cliPayload.compactOutput, /Tokenless Gemini daemon E2E DOM prompt 52963/)
    assert.doesNotMatch(cliRun.stdout, /taskUrl|task\/task\.html|runnerUrl|daemon\/runner\.html/)

    const created = await getDaemonJob({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: cliPayload.jobId,
    })
    assert.ok(['queued', 'claimed', 'succeeded'].includes(created.status), JSON.stringify(created, null, 2))
    assert.equal(created.provider, 'gemini')
    assert.equal(created.claim_token, undefined)
    assert.equal(created.request_json.targetUrl, targetUrl)
    assert.match(created.request_json.prompt, /Tokenless Gemini daemon E2E DOM prompt 52963/)
    events.push({ at: new Date().toISOString(), event: 'cli_daemon_job_created', jobId: created.job_id })

    const completed = await waitForDaemonJobStatus({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: created.job_id,
      statuses: ['succeeded', 'failed'],
      daemon,
      getDaemonJob,
    })
    await fs.writeFile(
      path.join(artifactDir, 'gemini-daemon-terminal-job.json'),
      `${JSON.stringify(completed, null, 2)}\n`,
      'utf8'
    )
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed, null, 2))
    assert.equal(completed.provider, 'gemini')
    assert.equal(completed.claim_token, undefined)
    assert.equal(completed.result_json.provider, 'gemini')
    assert.equal(completed.result_json.submit.provider, 'gemini')
    assert.equal(completed.result_json.submit.url, targetUrl)
    assert.equal(completed.result_json.read.provider, 'gemini')
    assert.equal(completed.result_json.read.url, conversationUrl)
    assert.match(completed.result_json.text, /visible Gemini real-DOM fixture answer/)
    assert.match(completed.result_json.text, /Tokenless Gemini daemon E2E DOM prompt 52963/)
    assert.doesNotMatch(completed.result_json.text, /stale Gemini real-DOM fixture answer/)
    assert.doesNotMatch(completed.result_json.text, /_streaming/)

    const providerPage = context.pages().find((page) => page.url().startsWith('https://gemini.google.com/'))
    assert.ok(providerPage, `extension did not open the visible Gemini page: ${JSON.stringify(context.pages().map((page) => page.url()))}`)
    assert.equal(providerPage.url(), conversationUrl)
    await providerPage.bringToFront()
    await providerPage.screenshot({
      path: path.join(artifactDir, '01-gemini-fixture-after-daemon.png'),
      animations: 'disabled',
    })
    const userMessage = providerPage.locator('user-query .query-text').last()
    assert.match(await userMessage.innerText(), /Tokenless Gemini daemon E2E DOM prompt 52963/)
    const assistantMessage = providerPage.locator('response-container message-content').last()
    assert.match(await assistantMessage.innerText(), /visible Gemini real-DOM fixture answer/)
    assert.match(await assistantMessage.innerText(), /Tokenless Gemini daemon E2E DOM prompt 52963/)
    assert.equal(await providerPage.locator('button[aria-label="Stop response"]').count(), 0)

    const pageUrlsAfterSuccess = context.pages().map((page) => page.url())
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/task/task.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/daemon/runner.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/settings/')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    const pagesOpenedByRun = context.pages().filter((page) => !pagesBeforeRun.has(page))
    assert.deepEqual(
      pagesOpenedByRun.map((page) => page.url()),
      [conversationUrl],
      'Gemini task execution must open exactly one visible provider page'
    )
    const urlsObservedDuringRun = observedUrls
      .slice(observedUrlCountBeforeRun)
      .map((entry) => entry.url)
    assert.ok(
      urlsObservedDuringRun.every((url) => url === 'about:blank' || url.startsWith('https://gemini.google.com/')),
      `Gemini task execution opened a non-provider page: ${JSON.stringify(urlsObservedDuringRun, null, 2)}`
    )
    assertNoTaskPageObserved(observedUrls)
    assertNoRunnerPageObserved(observedUrls)
    assert.equal(
      observedUrls.some((entry) => entry.url.includes('/settings/')),
      false,
      JSON.stringify(observedUrls, null, 2)
    )

    await fs.writeFile(path.join(artifactDir, 'gemini-cli-daemon-run-payload.json'), `${JSON.stringify(cliPayload, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'gemini-observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'gemini-summary.json'), `${JSON.stringify({
      ok: true,
      mode: 'daemon-fixture-gemini',
      fixture: true,
      realProviderDom: true,
      extensionId,
      daemonUrl,
      jobId: completed.job_id,
      provider: 'gemini',
      targetUrl,
      conversationUrl,
      prompt,
      taskPageOpened: observedUrls.some((entry) => entry.url.includes('/task/task.html')),
      runnerPageOpened: observedUrls.some((entry) => entry.url.includes('/daemon/runner.html')),
      settingsPageOpened: observedUrls.some((entry) => entry.url.includes('/settings/')),
      observedProviderOnly: urlsObservedDuringRun.every((url) => (
        url === 'about:blank' || url.startsWith('https://gemini.google.com/')
      )),
      events,
    }, null, 2)}\n`, 'utf8')
    console.log(`Tokenless Gemini daemon fixture E2E artifacts: ${artifactDir}`)
  } finally {
    const cleanupErrors = []
    await attemptCleanup(cleanupErrors, 'write Gemini observed URL artifacts', async () => {
      await fs.writeFile(path.join(artifactDir, 'gemini-observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8')
    })
    await attemptCleanup(cleanupErrors, 'close browser context', async () => context?.close())
    await attemptCleanup(cleanupErrors, 'close provider fixture', async () => providerFixture?.close())
    const manifestsRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host manifests',
      async () => restoreFiles(manifestBackup)
    )
    const registryRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host registry',
      async () => restoreWindowsNativeHostRegistry(registryBackup)
    )
    await attemptCleanup(cleanupErrors, 'stop daemon', async () => {
      if (daemon) await stopDaemon(daemon)
    })
    if (manifestsRestored && registryRestored) {
      await attemptCleanup(cleanupErrors, 'remove temporary Gemini E2E state', async () => {
        await fs.rm(tempRoot, { recursive: true, force: true })
      })
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless Gemini fixture E2E cleanup failed')
    }
  }
})

test('daemon job completes through extension service worker and Grok real-DOM fixture without internal pages', {
  skip: process.env.TOKENLESS_E2E !== '1' ? 'set TOKENLESS_E2E=1 to run fixture browser E2E' : false,
  timeout: 180000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    getDaemonJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    readLiveBridgeMarker,
  } = await import('../packages/cli/dist/src/index.js')
  const { DEFAULT_EXTENSION_ID } = await import('../packages/cli/dist/src/default-extension-id.js')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-grok-daemon-e2e-'))
  const artifactDir = await createArtifactDir()
  const userDataDir = path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const port = await freePort()
  const daemonUrl = `http://127.0.0.1:${port}`
  const prompt = 'Tokenless Grok daemon E2E DOM prompt 73184'
  const targetUrl = 'https://grok.com/'
  const conversationUrl = 'https://grok.com/c/123e4567-e89b-12d3-a456-426614174003'
  const events = []
  const observedUrls = []
  let manifestBackup = []
  let registryBackup = []
  let daemon
  let context
  let providerFixture

  try {
    daemon = startDaemon({ homeDir: tokenlessHome, port })
    await waitForDaemonReady(daemonUrl, daemon)
    events.push({ at: new Date().toISOString(), event: 'daemon_ready', daemonUrl })

    const browsers = fixtureNativeHostBrowsers()
    registryBackup = snapshotWindowsNativeHostRegistry(
      browsers,
      NATIVE_HOST_NAME,
      windowsNativeHostManifestPath(tokenlessHome, NATIVE_HOST_NAME)
    )
    manifestBackup = await snapshotFiles(browsers.flatMap((browser) => (
      nativeMessagingHostDirs(browser, userDataDir).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
    )))
    const installed = await installNativeHost({
      homeDir: tokenlessHome,
      manifestHome: userDataDir,
      extensionId: DEFAULT_EXTENSION_ID,
      browsers,
    })
    assert.ok(installed.manifests.length >= 1)
    events.push({
      at: new Date().toISOString(),
      event: 'native_host_installed',
      manifests: installed.manifests,
      executable: installed.nativeHostExecutable,
    })

    const grokFixture = await fs.readFile(grokRealDomFixturePath, 'utf8')
    providerFixture = await startHttpsFixtureServer({
      body: grokFixture,
      events,
      providerHost: 'grok.com',
    })
    context = await launchTokenlessContext(
      chromium,
      userDataDir,
      tokenlessHome,
      daemonUrl,
      providerFixture,
      'grok.com'
    )
    observeContextUrls(context, observedUrls)
    const extensionId = await discoverExtensionId(context)
    assert.equal(extensionId, DEFAULT_EXTENSION_ID)

    await ensureDaemonBridgeStarted(context)
    const bridgeMarker = await waitForBridgeMarker({ tokenlessHome, readLiveBridgeMarker, context })
    assert.equal(bridgeMarker.protocol, 'tokenless.extension-bridge-state.v1')
    events.push({
      at: new Date().toISOString(),
      event: 'daemon_bridge_ready',
      sessionId: bridgeMarker.sessionId,
    })
    const pagesBeforeRun = new Set(context.pages())
    const observedUrlCountBeforeRun = observedUrls.length

    const cliRun = await runProcess(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'run',
      '--prompt',
      prompt,
      '--provider',
      'grok',
      '--home',
      tokenlessHome,
      '--daemon-url',
      daemonUrl,
      '--target-url',
      targetUrl,
      '--read-delay-ms',
      '0',
      '--read-timeout-ms',
      '10000',
      '--no-open',
      '--json',
    ], { cwd: root })

    assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout)
    const cliPayload = JSON.parse(cliRun.stdout)
    assert.equal(cliPayload.transport, 'daemon')
    assert.equal(cliPayload.provider, 'grok')
    assert.equal(cliPayload.taskUrl, undefined)
    assert.equal(cliPayload.runnerUrl, undefined)
    assert.equal(cliPayload.result?.result?.submit?.provider, 'grok')
    assert.equal(cliPayload.result?.result?.submit?.url, conversationUrl)
    assert.equal(cliPayload.result?.result?.read?.provider, 'grok')
    assert.equal(cliPayload.result?.result?.read?.url, conversationUrl)
    assert.match(cliPayload.compactOutput, /visible Grok real-DOM fixture answer/)
    assert.match(cliPayload.compactOutput, /Tokenless Grok daemon E2E DOM prompt 73184/)
    assert.doesNotMatch(cliRun.stdout, /taskUrl|task\/task\.html|runnerUrl|daemon\/runner\.html/)
    assert.doesNotMatch(cliRun.stdout, /claim_token|claimToken/)

    const created = await getDaemonJob({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: cliPayload.jobId,
    })
    assert.ok(['queued', 'claimed', 'succeeded'].includes(created.status), JSON.stringify(created, null, 2))
    assert.equal(created.provider, 'grok')
    assert.equal(created.claim_token, undefined)
    assert.equal(created.claimToken, undefined)
    assert.doesNotMatch(JSON.stringify(created), /claim_token|claimToken/)
    assert.equal(created.request_json.targetUrl, targetUrl)
    assert.match(created.request_json.prompt, /Tokenless Grok daemon E2E DOM prompt 73184/)
    events.push({ at: new Date().toISOString(), event: 'cli_daemon_job_created', jobId: created.job_id })

    const completed = await waitForDaemonJobStatus({
      daemonUrl,
      homeDir: tokenlessHome,
      jobId: created.job_id,
      statuses: ['succeeded', 'failed'],
      daemon,
      getDaemonJob,
    })
    await fs.writeFile(
      path.join(artifactDir, 'grok-daemon-terminal-job.json'),
      `${JSON.stringify(completed, null, 2)}\n`,
      'utf8'
    )
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed, null, 2))
    assert.equal(completed.provider, 'grok')
    assert.equal(completed.claim_token, undefined)
    assert.equal(completed.claimToken, undefined)
    assert.doesNotMatch(JSON.stringify(completed), /claim_token|claimToken/)
    assert.equal(completed.result_json.provider, 'grok')
    assert.equal(completed.result_json.submit.provider, 'grok')
    assert.equal(completed.result_json.submit.url, conversationUrl)
    assert.equal(completed.result_json.read.provider, 'grok')
    assert.equal(completed.result_json.read.url, conversationUrl)
    assert.match(completed.result_json.text, /visible Grok real-DOM fixture answer/)
    assert.match(completed.result_json.text, /Tokenless Grok daemon E2E DOM prompt 73184/)
    assert.doesNotMatch(completed.result_json.text, /stale Grok real-DOM fixture answer/)

    const providerPage = context.pages().find((page) => page.url().startsWith('https://grok.com/'))
    assert.ok(providerPage, `extension did not open the visible Grok page: ${JSON.stringify(context.pages().map((page) => page.url()))}`)
    assert.equal(providerPage.url(), conversationUrl)
    await providerPage.bringToFront()
    await providerPage.screenshot({
      path: path.join(artifactDir, '01-grok-fixture-after-daemon.png'),
      animations: 'disabled',
    })
    const userMessage = providerPage.locator('[data-testid="user-message"]').last()
    assert.match(await userMessage.innerText(), /Tokenless Grok daemon E2E DOM prompt 73184/)
    const assistantMessage = providerPage.locator('[data-testid="assistant-message"]').last()
    assert.match(await assistantMessage.innerText(), /visible Grok real-DOM fixture answer/)
    assert.match(await assistantMessage.innerText(), /Tokenless Grok daemon E2E DOM prompt 73184/)

    const pageUrlsAfterSuccess = context.pages().map((page) => page.url())
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/task/task.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/daemon/runner.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/settings/')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    const pagesOpenedByRun = context.pages().filter((page) => !pagesBeforeRun.has(page))
    assert.deepEqual(
      pagesOpenedByRun.map((page) => page.url()),
      [conversationUrl],
      'Grok task execution must open exactly one visible provider page'
    )
    const urlsObservedDuringRun = observedUrls
      .slice(observedUrlCountBeforeRun)
      .map((entry) => entry.url)
    assert.ok(
      urlsObservedDuringRun.every((url) => url === 'about:blank' || url.startsWith('https://grok.com/')),
      `Grok task execution opened a non-provider page: ${JSON.stringify(urlsObservedDuringRun, null, 2)}`
    )
    assertNoTaskPageObserved(observedUrls)
    assertNoRunnerPageObserved(observedUrls)
    assert.equal(
      observedUrls.some((entry) => entry.url.includes('/settings/')),
      false,
      JSON.stringify(observedUrls, null, 2)
    )

    await fs.writeFile(path.join(artifactDir, 'grok-cli-daemon-run-payload.json'), `${JSON.stringify(cliPayload, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'grok-observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'grok-summary.json'), `${JSON.stringify({
      ok: true,
      mode: 'daemon-fixture-grok',
      fixture: true,
      realProviderDom: true,
      extensionId,
      daemonUrl,
      jobId: completed.job_id,
      provider: 'grok',
      targetUrl,
      conversationUrl,
      prompt,
      taskPageOpened: observedUrls.some((entry) => entry.url.includes('/task/task.html')),
      runnerPageOpened: observedUrls.some((entry) => entry.url.includes('/daemon/runner.html')),
      settingsPageOpened: observedUrls.some((entry) => entry.url.includes('/settings/')),
      observedProviderOnly: urlsObservedDuringRun.every((url) => (
        url === 'about:blank' || url.startsWith('https://grok.com/')
      )),
      events,
    }, null, 2)}\n`, 'utf8')
    console.log(`Tokenless Grok daemon fixture E2E artifacts: ${artifactDir}`)
  } finally {
    const cleanupErrors = []
    await attemptCleanup(cleanupErrors, 'write Grok observed URL artifacts', async () => {
      await fs.writeFile(path.join(artifactDir, 'grok-observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8')
    })
    await attemptCleanup(cleanupErrors, 'close browser context', async () => context?.close())
    await attemptCleanup(cleanupErrors, 'close provider fixture', async () => providerFixture?.close())
    const manifestsRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host manifests',
      async () => restoreFiles(manifestBackup)
    )
    const registryRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host registry',
      async () => restoreWindowsNativeHostRegistry(registryBackup)
    )
    await attemptCleanup(cleanupErrors, 'stop daemon', async () => {
      if (daemon) await stopDaemon(daemon)
    })
    if (manifestsRestored && registryRestored) {
      await attemptCleanup(cleanupErrors, 'remove temporary Grok E2E state', async () => {
        await fs.rm(tempRoot, { recursive: true, force: true })
      })
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless Grok fixture E2E cleanup failed')
    }
  }
})

test('an already-open browser extension reconnects after setup installs its native host', {
  skip: process.env.TOKENLESS_E2E !== '1' ? 'set TOKENLESS_E2E=1 to run fixture browser E2E' : false,
  timeout: 90000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    readLiveBridgeMarker,
  } = await import('../packages/cli/dist/src/index.js')
  const { DEFAULT_EXTENSION_ID } = await import('../packages/cli/dist/src/default-extension-id.js')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-setup-reconnect-e2e-'))
  const userDataDir = path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const events = []
  let context
  let providerFixture
  let manifestBackup = []
  let registryBackup = []

  try {
    const chatGptFixture = await fs.readFile(chatGptRealDomFixturePath, 'utf8')
    providerFixture = await startHttpsFixtureServer({
      body: chatGptFixture,
      events,
      providerHost: 'chatgpt.com',
    })
    context = await launchTokenlessContext(
      chromium,
      userDataDir,
      tokenlessHome,
      'http://127.0.0.1:7331',
      providerFixture,
      'chatgpt.com'
    )
    const extensionId = await discoverExtensionId(context)
    assert.equal(extensionId, DEFAULT_EXTENSION_ID)

    await ensureDaemonBridgeStarted(context)
    await delay(500)
    assert.equal(await readLiveBridgeMarker({ homeDir: tokenlessHome }), null)

    const browsers = fixtureNativeHostBrowsers()
    registryBackup = snapshotWindowsNativeHostRegistry(
      browsers,
      NATIVE_HOST_NAME,
      windowsNativeHostManifestPath(tokenlessHome, NATIVE_HOST_NAME)
    )
    manifestBackup = await snapshotFiles(browsers.flatMap((browser) => (
      nativeMessagingHostDirs(browser, userDataDir).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
    )))
    await installNativeHost({
      homeDir: tokenlessHome,
      manifestHome: userDataDir,
      extensionId,
      browsers,
    })

    const providerPage = await context.newPage()
    await providerPage.goto('https://chatgpt.com/')
    await ensureDaemonBridgeStarted(context)
    const marker = await waitForBridgeMarker({ tokenlessHome, readLiveBridgeMarker, context })
    assert.equal(marker.protocol, 'tokenless.extension-bridge-state.v1')
    assert.ok(marker.pid > 0)
  } finally {
    const cleanupErrors = []
    await attemptCleanup(cleanupErrors, 'close browser context', async () => context?.close())
    await attemptCleanup(cleanupErrors, 'close provider fixture', async () => providerFixture?.close())
    const manifestsRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host manifests',
      async () => restoreFiles(manifestBackup)
    )
    const registryRestored = await attemptCleanup(
      cleanupErrors,
      'restore native host registry',
      async () => restoreWindowsNativeHostRegistry(registryBackup)
    )
    if (manifestsRestored && registryRestored) {
      await attemptCleanup(cleanupErrors, 'remove temporary setup reconnect state', async () => {
        await fs.rm(tempRoot, { recursive: true, force: true })
      })
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless setup reconnect E2E cleanup failed')
    }
  }
})

test('Windows native host registry restore planning preserves concurrent state', () => {
  const installedDefaultValue = {
    exists: true,
    type: 'REG_SZ',
    data: 'C:\\tokenless-test\\dev.tokenless.native_host.json',
  }
  const currentTestValue = {
    keyExisted: true,
    defaultValue: installedDefaultValue,
  }
  const previousDefaultValue = {
    exists: true,
    type: 'REG_EXPAND_SZ',
    data: '%USERPROFILE%\\existing-native-host.json',
  }

  assert.deepEqual(windowsNativeHostRegistryRestorePlan({
    keyExisted: true,
    defaultValue: previousDefaultValue,
    installedDefaultValue,
  }, currentTestValue), {
    action: 'restore_default',
    deleteKeyIfEmpty: false,
    value: previousDefaultValue,
  })
  assert.deepEqual(windowsNativeHostRegistryRestorePlan({
    keyExisted: true,
    defaultValue: missingWindowsRegistryDefaultValue(),
    installedDefaultValue,
  }, currentTestValue), {
    action: 'delete_default',
    deleteKeyIfEmpty: false,
  })
  assert.deepEqual(windowsNativeHostRegistryRestorePlan({
    keyExisted: false,
    defaultValue: missingWindowsRegistryDefaultValue(),
    installedDefaultValue,
  }, currentTestValue), {
    action: 'delete_default',
    deleteKeyIfEmpty: true,
  })
  assert.deepEqual(windowsNativeHostRegistryRestorePlan({
    keyExisted: false,
    defaultValue: missingWindowsRegistryDefaultValue(),
    installedDefaultValue,
  }, {
    keyExisted: true,
    defaultValue: { ...installedDefaultValue, data: 'C:\\another-process\\manifest.json' },
  }), {
    action: 'none',
    deleteKeyIfEmpty: false,
  })
})

test('Windows native host registry parsing retains type/data and validates structured state', () => {
  const key = 'HKEY_CURRENT_USER\\Software\\TokenlessRegistryTest'
  assert.deepEqual(parseWindowsRegistryDefaultValue([
    key,
    '    (Default)    REG_EXPAND_SZ    %USERPROFILE%\\existing native host.json',
  ].join('\r\n'), key), {
    exists: true,
    type: 'REG_EXPAND_SZ',
    data: '%USERPROFILE%\\existing native host.json',
  })
  assert.deepEqual(parseWindowsRegistryState(
    '{"keyExisted":true,"defaultValueExisted":false,"keyIsEmpty":true}',
    key
  ), {
    keyExisted: true,
    defaultValueExisted: false,
    keyIsEmpty: true,
  })
  assert.throws(
    () => parseWindowsRegistryState(
      '{"keyExisted":true,"defaultValueExisted":true,"keyIsEmpty":true}',
      key
    ),
    /invalid state/
  )
})

function observeContextUrls(context, observedUrls) {
  const record = (event, url) => {
    observedUrls.push({ at: new Date().toISOString(), event, url })
  }
  for (const page of context.pages()) {
    record('existing_page', page.url())
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        record('navigation', frame.url())
      }
    })
  }
  context.on('page', (page) => {
    record('page', page.url())
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        record('navigation', frame.url())
      }
    })
  })
}

function assertNoTaskPageObserved(observedUrls) {
  assert.ok(
    observedUrls.every((entry) => !entry.url.includes('/task/task.html')),
    JSON.stringify(observedUrls, null, 2)
  )
}

function assertNoRunnerPageObserved(observedUrls) {
  assert.ok(
    observedUrls.every((entry) => !entry.url.includes('/daemon/runner.html')),
    JSON.stringify(observedUrls, null, 2)
  )
}

async function createArtifactDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const artifactDir = path.join(testResultsRoot, `${stamp}-${process.pid}-daemon`)
  await fs.mkdir(artifactDir, { recursive: true })
  return artifactDir
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
}

async function launchTokenlessContext(
  chromium,
  userDataDir,
  tokenlessHome,
  daemonUrl,
  providerFixture,
  providerHost
) {
  const headed = process.env.TOKENLESS_E2E_HEADED === '1'
  const options = {
    headless: !headed,
    env: {
      ...process.env,
      TOKENLESS_HOME: tokenlessHome,
      TOKENLESS_DAEMON_URL: daemonUrl,
    },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--host-resolver-rules=MAP ${providerHost}:443 127.0.0.1:${providerFixture.port},EXCLUDE localhost`,
      `--ignore-certificate-errors-spki-list=${providerFixture.spkiSha256}`,
      '--disable-quic',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  }
  if (process.env.TOKENLESS_E2E_CHANNEL) {
    options.channel = process.env.TOKENLESS_E2E_CHANNEL
  } else if (!headed) {
    // Playwright's `chromium` channel opts into new headless mode, which is the
    // bundled full browser required for Manifest V3 extension service workers.
    options.channel = 'chromium'
  }
  return chromium.launchPersistentContext(userDataDir, options)
}

async function startHttpsFixtureServer({ body, events, providerHost }) {
  const { generate } = await import('selfsigned')
  const notBeforeDate = new Date()
  const notAfterDate = new Date(notBeforeDate.getTime() + 24 * 60 * 60 * 1000)
  const certificate = await generate([{ name: 'commonName', value: providerHost }], {
    algorithm: 'sha256',
    keySize: 2048,
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: providerHost }] },
    ],
  })
  const publicKeyDer = createPublicKey(certificate.public).export({ type: 'spki', format: 'der' })
  const spkiSha256 = createHash('sha256').update(publicKeyDer).digest('base64')

  const server = https.createServer({ key: certificate.private, cert: certificate.cert }, (request, response) => {
    const host = request.headers.host?.toLowerCase() ?? null
    events.push({
      at: new Date().toISOString(),
      event: 'provider_fixture_request_served',
      host,
      method: request.method ?? null,
      path: request.url ?? null,
    })
    if (host !== providerHost && host !== `${providerHost}:443`) {
      response.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Misdirected Request')
      return
    }
    if (request.url === '/favicon.ico') {
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    response.end(body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  return {
    port: address.port,
    spkiSha256,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function attemptCleanup(errors, label, action) {
  try {
    await action()
    return true
  } catch (error) {
    errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    }))
    return false
  }
}

async function waitForBridgeMarker({ tokenlessHome, readLiveBridgeMarker, context }) {
  const deadline = Date.now() + 15000
  let lastRawMarker = null
  while (Date.now() < deadline) {
    const marker = await readLiveBridgeMarker({ homeDir: tokenlessHome })
    if (marker) return marker
    lastRawMarker = await fs.readFile(path.join(tokenlessHome, 'extension-bridge.json'), 'utf8').catch(() => null)
    await delay(100)
  }
  const workers = context.serviceWorkers()
  const nativeDiagnostic = workers[0]
    ? await workers[0].evaluate((hostName) => new Promise((resolve) => {
        const port = chrome.runtime.connectNative(hostName)
        const timeout = setTimeout(() => {
          port.disconnect()
          resolve({ status: 'timeout' })
        }, 2000)
        port.onMessage.addListener((message) => {
          clearTimeout(timeout)
          port.disconnect()
          resolve({ status: 'message', message })
        })
        port.onDisconnect.addListener(() => {
          clearTimeout(timeout)
          resolve({ status: 'disconnected', error: chrome.runtime.lastError?.message ?? null })
        })
        port.postMessage({
          protocol: 'tokenless.native.v1',
          type: 'tokenless.native.daemon_connect',
        })
      }), 'dev.tokenless.native_host')
    : null
  throw new Error(
    `Rust extension bridge did not become live; service workers: ${JSON.stringify(workers.map((worker) => worker.url()))}; last raw marker: ${lastRawMarker}; native diagnostic: ${JSON.stringify(nativeDiagnostic)}`
  )
}

async function ensureDaemonBridgeStarted(context) {
  await getServiceWorker(context)
}

async function getServiceWorker(context) {
  let [worker] = context.serviceWorkers()
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10000 })
  }
  return worker
}

async function discoverExtensionId(context) {
  let [worker] = context.serviceWorkers()
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10000 })
  }
  const url = new URL(worker.url())
  assert.equal(url.protocol, 'chrome-extension:')
  return url.hostname
}

function fixtureNativeHostBrowsers() {
  return process.platform === 'win32' ? ['chrome-for-testing'] : ['profile']
}

function windowsNativeHostManifestPath(homeDir, hostName) {
  return path.join(homeDir, 'native-messaging', `${hostName}.json`)
}

function snapshotWindowsNativeHostRegistry(browsers, hostName, installedManifestPath) {
  if (process.platform !== 'win32') return []
  const installedDefaultValue = {
    exists: true,
    type: 'REG_SZ',
    data: installedManifestPath,
  }
  return windowsNativeHostRegistryKeys(browsers, hostName).map((key) => {
    const previous = inspectWindowsNativeHostRegistryKey(key)
    return {
      key,
      keyExisted: previous.keyExisted,
      defaultValue: previous.defaultValue,
      installedDefaultValue,
    }
  })
}

function restoreWindowsNativeHostRegistry(entries) {
  if (process.platform !== 'win32') return
  for (const entry of [...entries].reverse()) {
    const current = inspectWindowsNativeHostRegistryKey(entry.key)
    const plan = windowsNativeHostRegistryRestorePlan(entry, current)
    if (plan.action === 'none') continue
    if (plan.action === 'restore_default') {
      setWindowsNativeHostRegistryDefault(entry.key, plan.value)
      continue
    }
    deleteWindowsNativeHostRegistryDefault(entry.key)
    if (!plan.deleteKeyIfEmpty) continue
    const withoutTestDefault = inspectWindowsNativeHostRegistryKey(entry.key)
    if (withoutTestDefault.keyExisted && withoutTestDefault.keyIsEmpty) {
      deleteEmptyWindowsNativeHostRegistryKey(entry.key)
    }
  }
}

function inspectWindowsNativeHostRegistryKey(key) {
  const state = inspectWindowsNativeHostRegistryState(key)
  if (!state.keyExisted) {
    return {
      keyExisted: false,
      defaultValue: missingWindowsRegistryDefaultValue(),
      keyIsEmpty: false,
    }
  }
  if (!state.defaultValueExisted) {
    return {
      keyExisted: true,
      defaultValue: missingWindowsRegistryDefaultValue(),
      keyIsEmpty: state.keyIsEmpty,
    }
  }
  const defaultQuery = spawnWindowsRegistry(['QUERY', key, '/ve'])
  assertWindowsRegistryCommandSucceeded(defaultQuery, `inspect native host registry default value ${key}`)
  return {
    keyExisted: true,
    defaultValue: parseWindowsRegistryDefaultValue(defaultQuery.stdout, key),
    keyIsEmpty: state.keyIsEmpty,
  }
}

function inspectWindowsNativeHostRegistryState(key) {
  const inspected = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    [
      "$ErrorActionPreference = 'Stop'",
      '$fullPath = $env:TOKENLESS_TEST_REGISTRY_KEY',
      "$prefix = 'HKCU\\'",
      "if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Expected an HKCU registry key.' }",
      '$relativePath = $fullPath.Substring($prefix.Length)',
      '$registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relativePath, $false)',
      'if ($null -eq $registryKey) {',
      "  [Console]::Out.Write('{\"keyExisted\":false,\"defaultValueExisted\":false,\"keyIsEmpty\":false}')",
      '  exit 0',
      '}',
      'try {',
      '  $valueNames = @($registryKey.GetValueNames())',
      '  $subkeyNames = @($registryKey.GetSubKeyNames())',
      '  $result = [ordered]@{',
      '    keyExisted = $true',
      "    defaultValueExisted = ($valueNames -contains '')",
      '    keyIsEmpty = ($valueNames.Count -eq 0 -and $subkeyNames.Count -eq 0)',
      '  }',
      '  [Console]::Out.Write(($result | ConvertTo-Json -Compress))',
      '} finally {',
      '  $registryKey.Dispose()',
      '}',
    ].join('\n'),
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      TOKENLESS_TEST_REGISTRY_KEY: key,
    },
  })
  assertWindowsRegistryCommandSucceeded(inspected, `inspect native host registry state ${key}`)
  return parseWindowsRegistryState(inspected.stdout, key)
}

function windowsNativeHostRegistryRestorePlan(entry, current) {
  if (
    !current.keyExisted ||
    !sameWindowsRegistryDefaultValue(current.defaultValue, entry.installedDefaultValue)
  ) {
    return { action: 'none', deleteKeyIfEmpty: false }
  }
  if (entry.defaultValue.exists) {
    return {
      action: 'restore_default',
      deleteKeyIfEmpty: false,
      value: entry.defaultValue,
    }
  }
  return {
    action: 'delete_default',
    deleteKeyIfEmpty: !entry.keyExisted,
  }
}

function setWindowsNativeHostRegistryDefault(key, value) {
  const restored = spawnWindowsRegistry([
    'ADD',
    key,
    '/ve',
    '/t',
    value.type,
    '/d',
    value.data,
    '/f',
  ])
  assertWindowsRegistryCommandSucceeded(restored, `restore native host registry default value ${key}`)
}

function deleteWindowsNativeHostRegistryDefault(key) {
  const deleted = spawnWindowsRegistry(['DELETE', key, '/ve', '/f'])
  if (deleted.status === 0) return
  const current = inspectWindowsNativeHostRegistryKey(key)
  if (!current.keyExisted || !current.defaultValue.exists) return
  assertWindowsRegistryCommandSucceeded(deleted, `delete test native host registry default value ${key}`)
}

function deleteEmptyWindowsNativeHostRegistryKey(key) {
  const current = inspectWindowsNativeHostRegistryKey(key)
  if (!current.keyExisted || !current.keyIsEmpty) return
  const deleted = spawnWindowsRegistry(['DELETE', key, '/f'])
  if (deleted.status === 0) return
  const afterDelete = inspectWindowsNativeHostRegistryKey(key)
  if (!afterDelete.keyExisted) return
  assertWindowsRegistryCommandSucceeded(deleted, `delete empty test-created native host registry key ${key}`)
}

function spawnWindowsRegistry(args) {
  return spawnSync('reg.exe', args, { encoding: 'utf8' })
}

function assertWindowsRegistryCommandSucceeded(result, action) {
  if (result.error) {
    throw new Error(`Could not ${action}: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(`Could not ${action}: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
}

function missingWindowsRegistryDefaultValue() {
  return { exists: false, type: null, data: null }
}

function parseWindowsRegistryDefaultValue(output, key) {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\s(REG_[A-Z0-9_]+)(?:\s+(.*))?$/i)
    if (!match) continue
    return {
      exists: true,
      type: match[1].toUpperCase(),
      data: (match[2] ?? '').trimEnd(),
    }
  }
  throw new Error(`Native host registry key ${key} returned an unparseable default value.`)
}

function parseWindowsRegistryState(output, key) {
  let state
  try {
    state = JSON.parse(output)
  } catch (error) {
    throw new Error(`Native host registry key ${key} returned an unparseable state.`, { cause: error })
  }
  if (
    typeof state?.keyExisted !== 'boolean' ||
    typeof state?.defaultValueExisted !== 'boolean' ||
    typeof state?.keyIsEmpty !== 'boolean' ||
    (!state.keyExisted && (state.defaultValueExisted || state.keyIsEmpty)) ||
    (state.defaultValueExisted && state.keyIsEmpty)
  ) {
    throw new Error(`Native host registry key ${key} returned an invalid state.`)
  }
  return state
}

function sameWindowsRegistryDefaultValue(left, right) {
  return Boolean(
    left?.exists &&
    right?.exists &&
    left.type === right.type &&
    left.data === right.data
  )
}

function windowsNativeHostRegistryKeys(browsers, hostName) {
  const roots = {
    chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    'chrome-for-testing': 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
    edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    arc: 'HKCU\\Software\\The Browser Company\\Arc\\NativeMessagingHosts',
  }
  return [...new Set(browsers
    .map((browser) => roots[browser])
    .filter(Boolean)
    .map((root) => `${root}\\${hostName}`))]
}

async function snapshotFiles(files) {
  return Promise.all(files.map(async (file) => {
    const previous = await fs.readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return { file, previous }
  }))
}

async function restoreFiles(entries) {
  for (const entry of entries.reverse()) {
    if (entry.previous === null) {
      await fs.rm(entry.file, { force: true })
    } else {
      await fs.writeFile(entry.file, entry.previous)
    }
  }
}

function startDaemon({ homeDir, port }) {
  const child = spawn('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    path.join(root, 'packages/daemon/Cargo.toml'),
    '--bin',
    'tokenless-daemon',
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
      const response = await fetch(`${daemonUrl}/health`)
      if (response.ok) return
      lastError = new Error(`ready returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`daemon did not become ready: ${lastError?.message || 'timeout'}\n${child.stderrText}`)
}

async function waitForDaemonJobStatus({ daemonUrl, homeDir, jobId, statuses, daemon: child, getDaemonJob }) {
  const started = Date.now()
  const expected = new Set(statuses)
  let lastJob
  let lastError
  while (Date.now() - started < 120000) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited with ${child.exitCode}: ${child.stderrText}`)
    }
    try {
      lastJob = await getDaemonJob({ daemonUrl, homeDir, jobId })
      if (expected.has(lastJob.status)) return lastJob
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`daemon job ${jobId} did not reach ${statuses.join(', ')}; last=${JSON.stringify(lastJob)} error=${lastError?.message || 'timeout'}\n${child.stderrText}`)
}

async function waitForPathAbsent(targetPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await pathExists(targetPath)) return
    await delay(50)
  }
}

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function assertNoPrivateAttachmentPaths(value, privatePaths) {
  const normalizedValue = value
    .replaceAll('\\\\', '/')
    .replaceAll('\\', '/')
    .toLowerCase()
  for (const privatePath of privatePaths) {
    const normalizedPath = privatePath.replaceAll('\\', '/').toLowerCase()
    assert.equal(
      normalizedValue.includes(normalizedPath),
      false,
      `private attachment path crossed the visible bridge: ${privatePath}`
    )
  }
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
