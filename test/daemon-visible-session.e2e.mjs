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
    const browsers = ['profile']
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
    providerFixture = await startHttpsFixtureServer({ body: chatGptFixture, events })
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
      providerFixture
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
    assert.equal(completed.result_json.submit.configuration.effort.applied, 'high')

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
    await attemptCleanup(cleanupErrors, 'restore native host manifests', async () => restoreFiles(manifestBackup))
    await attemptCleanup(cleanupErrors, 'stop daemon', async () => {
      if (daemon) await stopDaemon(daemon)
    })
    await attemptCleanup(cleanupErrors, 'remove temporary E2E state', async () => {
      await fs.rm(tempRoot, { recursive: true, force: true })
    })
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless fixture E2E cleanup failed')
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

  try {
    const chatGptFixture = await fs.readFile(chatGptRealDomFixturePath, 'utf8')
    providerFixture = await startHttpsFixtureServer({ body: chatGptFixture, events })
    context = await launchTokenlessContext(
      chromium,
      userDataDir,
      tokenlessHome,
      'http://127.0.0.1:7331',
      providerFixture
    )
    const extensionId = await discoverExtensionId(context)
    assert.equal(extensionId, DEFAULT_EXTENSION_ID)

    await ensureDaemonBridgeStarted(context)
    await delay(500)
    assert.equal(await readLiveBridgeMarker({ homeDir: tokenlessHome }), null)

    const browsers = ['profile']
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
    await attemptCleanup(cleanupErrors, 'restore native host manifests', async () => restoreFiles(manifestBackup))
    await attemptCleanup(cleanupErrors, 'remove temporary setup reconnect state', async () => {
      await fs.rm(tempRoot, { recursive: true, force: true })
    })
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless setup reconnect E2E cleanup failed')
    }
  }
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

async function launchTokenlessContext(chromium, userDataDir, tokenlessHome, daemonUrl, providerFixture) {
  const options = {
    headless: process.env.TOKENLESS_E2E_HEADED === '1' ? false : false,
    env: {
      ...process.env,
      TOKENLESS_HOME: tokenlessHome,
      TOKENLESS_DAEMON_URL: daemonUrl,
    },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${providerFixture.port},EXCLUDE localhost`,
      `--ignore-certificate-errors-spki-list=${providerFixture.spkiSha256}`,
      '--disable-quic',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  }
  if (process.env.TOKENLESS_E2E_CHANNEL) {
    options.channel = process.env.TOKENLESS_E2E_CHANNEL
  }
  return chromium.launchPersistentContext(userDataDir, options)
}

async function startHttpsFixtureServer({ body, events }) {
  const { generate } = await import('selfsigned')
  const notBeforeDate = new Date()
  const notAfterDate = new Date(notBeforeDate.getTime() + 24 * 60 * 60 * 1000)
  const certificate = await generate([{ name: 'commonName', value: 'chatgpt.com' }], {
    algorithm: 'sha256',
    keySize: 2048,
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'chatgpt.com' }] },
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
    if (host !== 'chatgpt.com' && host !== 'chatgpt.com:443') {
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
  } catch (error) {
    errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    }))
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
