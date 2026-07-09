import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
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
  timeout: 120000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    createDaemonJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
  } = await import('../packages/cli/dist/src/index.js')

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

  try {
    daemon = startDaemon({ homeDir: tokenlessHome, port })
    await waitForDaemonReady(daemonUrl, daemon)
    events.push({ at: new Date().toISOString(), event: 'daemon_ready', daemonUrl })

    context = await launchTokenlessContext(chromium, userDataDir, tokenlessHome)
    observeContextUrls(context, observedUrls)
    const extensionId = await discoverExtensionId(context)
    events.push({ at: new Date().toISOString(), event: 'extension_discovered', extensionId })
    await context.close()
    context = null

    const manifestHome = userDataDir
    const browsers = ['profile']
    manifestBackup = await snapshotFiles(browsers.flatMap((browser) => (
      nativeMessagingHostDirs(browser, manifestHome).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
    )))
    const installed = await installNativeHost({
      homeDir: tokenlessHome,
      manifestHome,
      extensionId,
      browsers,
    })
    assert.ok(installed.manifests.length >= 1)
    events.push({
      at: new Date().toISOString(),
      event: 'native_host_installed',
      manifests: installed.manifests,
      executable: installed.executable,
    })

    context = await launchTokenlessContext(chromium, userDataDir, tokenlessHome)
    observeContextUrls(context, observedUrls)
    const chatGptFixture = await fs.readFile(chatGptRealDomFixturePath, 'utf8')
    await context.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture,
      })
    })
    events.push({
      at: new Date().toISOString(),
      event: 'provider_fixture_route_registered',
      route: 'https://chatgpt.com/**',
      realProviderDom: true,
    })

    const providerFixturePage = await context.newPage()
    await providerFixturePage.goto('https://chatgpt.com/')
    await providerFixturePage.locator('[data-testid="composer"] [contenteditable="true"]').waitFor({ timeout: 5000 })
    await providerFixturePage.screenshot({ path: path.join(artifactDir, '01-chatgpt-fixture-before-daemon.png'), fullPage: true })

    const created = await createDaemonJob({
      daemonUrl,
      provider: 'chatgpt',
      action: 'submit_and_read',
      requestJson: {
        requestId: 'daemon-e2e-request',
        targetUrl: 'https://chatgpt.com/',
        prompt,
        readDelayMs: 0,
        readTimeoutMs: 10000,
      },
    })
    assert.equal(created.status, 'queued')
    assert.equal(typeof created.claim_token, 'string')
    events.push({ at: new Date().toISOString(), event: 'daemon_job_created', jobId: created.job_id })

    const extensionPage = await context.newPage()
    await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel/index.html`)
    const run = await extensionPage.evaluate((url) => new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'tokenless.daemon.run_next',
        daemonUrl: url,
        provider: 'chatgpt',
        action: 'submit_and_read',
      }, resolve)
    }), daemonUrl)
    events.push({ at: new Date().toISOString(), event: 'daemon_run_next_returned', ok: run?.ok, status: run?.status })
    await fs.writeFile(path.join(artifactDir, 'daemon-run-response.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8')

    assert.equal(run.ok, true, JSON.stringify(run, null, 2))
    assert.equal(run.status, 'completed')
    assert.equal(run.job.job_id, created.job_id)
    assert.equal(run.job.status, 'succeeded')
    assert.equal(run.job.claim_token, undefined)
    assert.equal(run.error, null)
    assert.match(run.result.text, /visible ChatGPT real-DOM fixture answer/)
    assert.match(run.result.text, /Tokenless daemon E2E DOM prompt 93742/)
    assert.doesNotMatch(run.result.text, /stale ChatGPT real-DOM fixture answer/)
    assert.doesNotMatch(run.result.text, /_streaming/)

    const completed = await fetch(`${daemonUrl}/jobs/${encodeURIComponent(created.job_id)}`).then((response) => response.json())
    assert.equal(completed.status, 'succeeded')
    assert.equal(completed.claim_token, undefined)
    assert.match(completed.result_json.text, /visible ChatGPT real-DOM fixture answer/)

    const providerPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/')) ?? providerFixturePage
    assert.match(await providerPage.locator('[data-message-author-role="user"]').last().innerText(), /Tokenless daemon E2E DOM prompt 93742/)
    assert.match(await providerPage.locator('[data-message-author-role="assistant"]').last().innerText(), /visible ChatGPT real-DOM fixture answer/)
    const pageUrlsAfterSuccess = context.pages().map((page) => page.url())
    assert.ok(pageUrlsAfterSuccess.every((url) => !url.includes('/task/task.html')), JSON.stringify(pageUrlsAfterSuccess, null, 2))
    assertNoTaskPageObserved(observedUrls)

    const invalid = await createDaemonJob({
      daemonUrl,
      provider: 'chatgpt',
      action: 'unsupported_for_e2e',
      requestJson: {
        requestId: 'daemon-e2e-invalid-request',
        targetUrl: 'https://chatgpt.com/',
        prompt: 'This invalid action must fail before provider submission.',
      },
    })
    const failedRun = await extensionPage.evaluate((url) => new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'tokenless.daemon.run_next',
        daemonUrl: url,
        provider: 'chatgpt',
        action: 'unsupported_for_e2e',
      }, resolve)
    }), daemonUrl)
    assert.equal(failedRun.ok, false, JSON.stringify(failedRun, null, 2))
    assert.equal(failedRun.status, 'failed')
    assert.equal(failedRun.job.job_id, invalid.job_id)
    assert.equal(failedRun.job.status, 'failed')
    assert.equal(failedRun.job.claim_token, undefined)
    assert.equal(failedRun.job.claimToken, undefined)
    assert.equal(failedRun.error.code, 'unsupported_action')
    const failedCompleted = await fetch(`${daemonUrl}/jobs/${encodeURIComponent(invalid.job_id)}`).then((response) => response.json())
    assert.equal(failedCompleted.status, 'failed')
    assert.equal(failedCompleted.claim_token, undefined)
    assert.equal(failedCompleted.claimToken, undefined)
    const pageUrlsAfterFailure = context.pages().map((page) => page.url())
    assert.ok(pageUrlsAfterFailure.every((url) => !url.includes('/task/task.html')), JSON.stringify(pageUrlsAfterFailure, null, 2))
    assertNoTaskPageObserved(observedUrls)

    await providerPage.screenshot({ path: path.join(artifactDir, '02-chatgpt-fixture-after-daemon.png'), fullPage: true })
    await extensionPage.screenshot({ path: path.join(artifactDir, '03-extension-page-after-daemon.png'), fullPage: true })
    await fs.writeFile(path.join(artifactDir, 'daemon-completed-job.json'), `${JSON.stringify(completed, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(artifactDir, 'daemon-failed-run-response.json'), `${JSON.stringify(failedRun, null, 2)}\n`, 'utf8')
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
      observedUrlCount: observedUrls.length,
      events,
    }, null, 2)}\n`, 'utf8')
    console.log(`Tokenless daemon fixture E2E artifacts: ${artifactDir}`)
  } finally {
    if (context) {
      await fs.writeFile(path.join(artifactDir, 'observed-urls.json'), `${JSON.stringify(observedUrls, null, 2)}\n`, 'utf8').catch(() => undefined)
      await fs.writeFile(path.join(artifactDir, 'pages.json'), `${JSON.stringify(
        context.pages().map((page) => ({ url: page.url() })),
        null,
        2
      )}\n`, 'utf8').catch(() => undefined)
    }
    await fs.writeFile(path.join(artifactDir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8').catch(() => undefined)
    await context?.close()
    await restoreFiles(manifestBackup)
    if (daemon) await stopDaemon(daemon)
    await fs.rm(tempRoot, { recursive: true, force: true })
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

async function createArtifactDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const artifactDir = path.join(testResultsRoot, `${stamp}-${process.pid}-daemon`)
  await fs.mkdir(artifactDir, { recursive: true })
  return artifactDir
}

async function launchTokenlessContext(chromium, userDataDir, tokenlessHome) {
  const options = {
    headless: process.env.TOKENLESS_E2E_HEADED === '1' ? false : false,
    env: {
      ...process.env,
      TOKENLESS_HOME: tokenlessHome,
    },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  }
  if (process.env.TOKENLESS_E2E_CHANNEL) {
    options.channel = process.env.TOKENLESS_E2E_CHANNEL
  }
  return chromium.launchPersistentContext(userDataDir, options)
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
      const response = await fetch(`${daemonUrl}/ready`)
      if (response.ok) return
      lastError = new Error(`ready returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`daemon did not become ready: ${lastError?.message || 'timeout'}\n${child.stderrText}`)
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
