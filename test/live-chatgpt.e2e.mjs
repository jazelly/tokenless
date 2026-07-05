import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionPath = path.join(root, 'packages/extension/extension')
const testResultsRoot = path.join(root, 'test-results', 'tokenless-live-chatgpt', 'runs')

test('live ChatGPT DOM is driven by Tokenless extension without fixture routing', {
  skip: process.env.TOKENLESS_LIVE_CHATGPT !== '1' ? 'set TOKENLESS_LIVE_CHATGPT=1 to run live ChatGPT E2E' : false,
  timeout: 180000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    createLocalJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    waitLocalJobResult,
  } = await import('../packages/cli/src/index.js')

  const artifactDir = await createArtifactDir()
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-live-chatgpt-'))
  const userDataDir = process.env.TOKENLESS_LIVE_USER_DATA_DIR
    ? path.resolve(process.env.TOKENLESS_LIVE_USER_DATA_DIR)
    : path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const prompt = process.env.TOKENLESS_LIVE_PROMPT || [
    'Tokenless live DOM smoke test.',
    'Reply with exactly: TOKENLESS_LIVE_DOM_OK_48291',
  ].join('\n')
  const events = []
  let manifestBackup = []
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
    events.push({
      at: new Date().toISOString(),
      event: 'native_host_installed',
      manifests: installed.manifests,
      executable: installed.executable,
    })

    context = await launchTokenlessContext(chromium, userDataDir, tokenlessHome)
    const providerPage = await context.newPage()
    await providerPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await providerPage.screenshot({ path: path.join(artifactDir, '01-real-chatgpt-opened.png'), fullPage: true })
    await fs.writeFile(path.join(artifactDir, '01-real-chatgpt-opened.html'), await providerPage.content(), 'utf8')
    events.push({ at: new Date().toISOString(), event: 'real_chatgpt_opened', url: providerPage.url() })

    const job = await createLocalJob({
      homeDir: tokenlessHome,
      provider: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      prompt,
      readDelayMs: 1500,
      readTimeoutMs: Number(process.env.TOKENLESS_LIVE_READ_TIMEOUT_MS || 90000),
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
      timeoutMs: Number(process.env.TOKENLESS_LIVE_TIMEOUT_MS || 120000),
    }).catch(async (error) => {
      await task.screenshot({ path: path.join(artifactDir, '03-extension-task-timeout.png'), fullPage: true }).catch(() => undefined)
      const realChatGptPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/')) ?? providerPage
      await realChatGptPage.screenshot({ path: path.join(artifactDir, '04-real-chatgpt-timeout.png'), fullPage: true }).catch(() => undefined)
      await fs.writeFile(path.join(artifactDir, 'task-text-timeout.txt'), await task.locator('body').innerText().catch(() => ''), 'utf8')
      await fs.writeFile(path.join(artifactDir, 'real-chatgpt-text-timeout.txt'), await realChatGptPage.locator('body').innerText().catch(() => ''), 'utf8')
      await copyJobFiles(tokenlessHome, job.jobId, artifactDir, 'timeout')
      await writeSummary(artifactDir, {
        ok: false,
        artifactDir,
        mode: 'live-chatgpt',
        fixture: false,
        extensionId,
        jobId: job.jobId,
        provider: 'chatgpt',
        targetUrl: 'https://chatgpt.com/',
        prompt,
        error: {
          code: error.code || 'live_timeout',
          message: error.message || 'Live ChatGPT run timed out.',
        },
        events,
      })
      throw error
    })
    events.push({ at: new Date().toISOString(), event: 'job_result_received', ok: result.ok, error: result.error })

    const realChatGptPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/')) ?? providerPage
    await task.screenshot({ path: path.join(artifactDir, '03-extension-task-after-result.png'), fullPage: true })
    await realChatGptPage.screenshot({ path: path.join(artifactDir, '04-real-chatgpt-after-result.png'), fullPage: true })
    await fs.writeFile(path.join(artifactDir, 'real-chatgpt-text.txt'), await realChatGptPage.locator('body').innerText().catch(() => ''), 'utf8')
    await copyJobFiles(tokenlessHome, job.jobId, artifactDir, 'after')

    await writeSummary(artifactDir, {
      ok: result.ok,
      artifactDir,
      mode: 'live-chatgpt',
      fixture: false,
      extensionId,
      jobId: job.jobId,
      provider: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      prompt,
      compactOutput: result.compactOutput,
      error: result.error,
      events,
    })

    if (!result.ok) {
      throw new Error(`Live ChatGPT run did not complete: ${result.error?.code || 'unknown'} ${result.error?.message || ''}`)
    }
    assert.match(result.compactOutput || '', /TOKENLESS_LIVE_DOM_OK_48291/)
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

async function launchTokenlessContext(chromium, userDataDir, tokenlessHome) {
  const options = {
    headless: false,
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
  if (process.env.TOKENLESS_LIVE_CHANNEL) {
    options.channel = process.env.TOKENLESS_LIVE_CHANNEL
  }
  return chromium.launchPersistentContext(userDataDir, options)
}

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

async function writeSummary(artifactDir, payload) {
  await fs.writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`Tokenless live ChatGPT artifacts: ${artifactDir}`)
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
