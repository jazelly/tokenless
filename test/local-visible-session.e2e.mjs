import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionPath = path.join(root, 'packages/extension/extension')
const chatGptRealDomFixturePath = path.join(root, 'test/fixtures/chatgpt-real-dom-fixture.html')
const testResultsRoot = path.join(root, 'test-results', 'tokenless-e2e', 'runs')

test('Tokenless CLI job completes through extension task page and ChatGPT real-DOM fixture', {
  skip: process.env.TOKENLESS_E2E !== '1' ? 'set TOKENLESS_E2E=1 to run fixture browser E2E' : false,
  timeout: 120000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    createLocalJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    waitLocalJobResult,
  } = await import('../packages/cli/src/index.js')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-e2e-'))
  const artifactDir = await createArtifactDir()
  const userDataDir = path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const prompt = 'Tokenless E2E DOM prompt 48291'
  let manifestBackup = []
  const events = []

  let context = await launchTokenlessContext(chromium, userDataDir, tokenlessHome)

  try {
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
    const chatGptFixture = await chatGptRealDomFixtureHtml()
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
      fixture: true,
      realProviderDom: true,
      fixturePath: chatGptRealDomFixturePath,
    })
    const providerFixturePage = await context.newPage()
    await providerFixturePage.goto('https://chatgpt.com/')
    await providerFixturePage.locator('[data-testid="composer"] [contenteditable="true"]').waitFor({ timeout: 5000 })
    assert.equal(await providerFixturePage.locator('[data-testid="composer"]').count(), 1)
    assert.equal(await providerFixturePage.locator('[data-testid="composer-send-button"]').count(), 1)
    await providerFixturePage.screenshot({ path: path.join(artifactDir, '01-chatgpt-fixture-before-empty-composer.png'), fullPage: true })
    events.push({ at: new Date().toISOString(), event: 'provider_fixture_ready', url: providerFixturePage.url(), fixture: true, realProviderDom: true })

    const job = await createLocalJob({
      homeDir: tokenlessHome,
      provider: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      prompt,
      readDelayMs: 0,
      readTimeoutMs: 10000,
    })
    events.push({ at: new Date().toISOString(), event: 'job_created', jobId: job.jobId })
    await copyJobFiles(tokenlessHome, job.jobId, artifactDir, 'before')

    const task = await context.newPage()
    await task.goto(`chrome-extension://${extensionId}/task/task.html?jobId=${job.jobId}&nonce=${job.nonce}`)
    await task.screenshot({ path: path.join(artifactDir, '02-extension-task-started.png'), fullPage: true })

    const result = await waitLocalJobResult({
      homeDir: tokenlessHome,
      jobId: job.jobId,
      nonce: job.nonce,
      timeoutMs: 30000,
    })
    events.push({ at: new Date().toISOString(), event: 'job_result_received', ok: result.ok })

    assert.equal(result.ok, true)
    assert.match(result.compactOutput, /visible ChatGPT real-DOM fixture answer/)
    assert.match(result.compactOutput, /Tokenless E2E DOM prompt 48291/)
    assert.doesNotMatch(result.compactOutput, /stale ChatGPT real-DOM fixture answer/)
    assert.doesNotMatch(result.compactOutput, /_streaming/)

    const providerPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/')) ?? providerFixturePage
    assert.ok(providerPage, 'provider tab should be opened')
    assert.equal(await providerPage.locator('[data-testid="composer"] [contenteditable="true"]').innerText(), '')
    assert.match(await providerPage.locator('[data-message-author-role="user"]').last().innerText(), /Tokenless E2E DOM prompt 48291/)
    assert.match(await providerPage.locator('[data-message-author-role="assistant"]').last().innerText(), /visible ChatGPT real-DOM fixture answer/)

    const snapshotJob = await createLocalJob({
      homeDir: tokenlessHome,
      provider: 'chatgpt',
      action: 'snapshot_dom',
      targetUrl: providerPage.url(),
      includeText: false,
    })
    events.push({ at: new Date().toISOString(), event: 'snapshot_job_created', jobId: snapshotJob.jobId })
    const snapshotTask = await context.newPage()
    await snapshotTask.goto(`chrome-extension://${extensionId}/task/task.html?jobId=${snapshotJob.jobId}&nonce=${snapshotJob.nonce}`)
    const snapshotResult = await waitLocalJobResult({
      homeDir: tokenlessHome,
      jobId: snapshotJob.jobId,
      nonce: snapshotJob.nonce,
      timeoutMs: 30000,
    })
    events.push({ at: new Date().toISOString(), event: 'snapshot_result_received', ok: snapshotResult.ok })
    assert.equal(snapshotResult.ok, true)
    assert.equal(snapshotResult.result.snapshot.provider, 'chatgpt')
    assert.match(snapshotResult.result.snapshot.htmlPath, /snapshots\/chatgpt\/.*\/dom\.sanitized\.html$/)
    assert.match(snapshotResult.compactOutput, /snapshots\/chatgpt\/.*\/dom\.sanitized\.html$/)
    const snapshotHtml = await fs.readFile(snapshotResult.result.snapshot.htmlPath, 'utf8')
    const selectorProbeText = await fs.readFile(snapshotResult.result.snapshot.selectorProbesPath, 'utf8')
    const selectorProbes = JSON.parse(selectorProbeText)
    assert.match(snapshotHtml, /data-testid="composer"/)
    assert.doesNotMatch(snapshotHtml, /Tokenless E2E DOM prompt 48291/)
    assert.doesNotMatch(selectorProbeText, /Tokenless E2E DOM prompt 48291/)
    assert.ok(selectorProbes.composers.some((probe) => probe.count > 0))
    assert.ok(selectorProbes.submits.some((probe) => probe.count > 0))
    assert.ok(selectorProbes.answers.some((probe) => probe.count > 0))

    await task.screenshot({ path: path.join(artifactDir, '03-extension-task-completed.png'), fullPage: true })
    await providerPage.screenshot({ path: path.join(artifactDir, '04-chatgpt-fixture-after-prompt-and-response.png'), fullPage: true })
    await snapshotTask.screenshot({ path: path.join(artifactDir, '05-extension-snapshot-completed.png'), fullPage: true })
    await fs.writeFile(path.join(artifactDir, 'provider-fixture-text.txt'), await providerPage.locator('body').innerText(), 'utf8')
    await fs.writeFile(path.join(artifactDir, 'task-text.txt'), await task.locator('body').innerText(), 'utf8')
    await copyJobFiles(tokenlessHome, job.jobId, artifactDir, 'after')
    await fs.writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify({
      ok: true,
      artifactDir,
      mode: 'fixture-chatgpt',
      fixture: true,
      fixtureRoute: 'https://chatgpt.com/**',
      realProviderDom: true,
      fixturePath: chatGptRealDomFixturePath,
      extensionId,
      jobId: job.jobId,
      provider: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      prompt,
      compactOutput: result.compactOutput,
      events,
    }, null, 2)}\n`, 'utf8')
    console.log(`Tokenless fixture E2E artifacts: ${artifactDir}`)
  } finally {
    if (context) {
      await fs.writeFile(path.join(artifactDir, 'pages.json'), `${JSON.stringify(
        context.pages().map((page) => ({ url: page.url() })),
        null,
        2
      )}\n`, 'utf8').catch(() => undefined)
    }
    await fs.writeFile(path.join(artifactDir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8')
    await context?.close()
    await restoreFiles(manifestBackup)
  }
})

async function createArtifactDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const artifactDir = path.join(testResultsRoot, `${stamp}-${process.pid}`)
  await fs.mkdir(artifactDir, { recursive: true })
  return artifactDir
}

async function copyJobFiles(tokenlessHome, jobId, artifactDir, phase) {
  const jobDir = path.join(tokenlessHome, 'jobs')
  for (const kind of ['request', 'state', 'result']) {
    const source = path.join(jobDir, `${jobId}.${kind}.json`)
    const destination = path.join(artifactDir, `${phase}-${kind}.json`)
    await fs.copyFile(source, destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
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

async function discoverExtensionId(context) {
  let [worker] = context.serviceWorkers()
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10000 })
  }
  const url = new URL(worker.url())
  assert.equal(url.protocol, 'chrome-extension:')
  return url.hostname
}

async function chatGptRealDomFixtureHtml() {
  return fs.readFile(chatGptRealDomFixturePath, 'utf8')
}
