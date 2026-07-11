import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionPath = path.join(root, 'packages/extension/dist/extension')
const testResultsRoot = path.join(root, 'test-results', 'tokenless-live-chatgpt', 'runs')

test('live ChatGPT DOM is driven by Tokenless extension without fixture routing', {
  skip: process.env.TOKENLESS_LIVE_CHATGPT !== '1' ? 'set TOKENLESS_LIVE_CHATGPT=1 to run live ChatGPT E2E' : false,
  timeout: 180000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    readLiveBridgeMarker,
  } = await import('../packages/cli/dist/src/index.js')
  const { DEFAULT_EXTENSION_ID } = await import('../packages/cli/dist/src/default-extension-id.js')

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
  let context = null

  try {
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
    events.push({
      at: new Date().toISOString(),
      event: 'native_host_installed',
      manifests: installed.manifests,
      executable: installed.nativeHostExecutable,
    })

    context = await launchTokenlessContext(chromium, userDataDir, tokenlessHome)
    const extensionId = await discoverExtensionId(context)
    assert.equal(extensionId, DEFAULT_EXTENSION_ID)
    events.push({ at: new Date().toISOString(), event: 'extension_discovered', extensionId })
    const bridgeMarker = await waitForBridgeMarker(tokenlessHome, readLiveBridgeMarker)
    events.push({
      at: new Date().toISOString(),
      event: 'daemon_bridge_ready',
      sessionId: bridgeMarker.sessionId,
    })
    const timeoutMs = Number(process.env.TOKENLESS_LIVE_TIMEOUT_MS || 120000)
    const cliRun = spawnSync(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
      'run',
      '--prompt',
      prompt,
      '--provider',
      'chatgpt',
      '--home',
      tokenlessHome,
      '--target-url',
      'https://chatgpt.com/',
      '--read-delay-ms',
      '1500',
      '--read-timeout-ms',
      String(process.env.TOKENLESS_LIVE_READ_TIMEOUT_MS || 90000),
      '--timeout-ms',
      String(timeoutMs),
      '--no-open',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs + 30000,
    })
    const result = JSON.parse(cliRun.stdout || '{}')
    events.push({
      at: new Date().toISOString(),
      event: 'cli_finished',
      exitCode: cliRun.status,
      jobId: result.jobId,
      ok: result.ok,
      error: result.error,
    })
    await fs.writeFile(path.join(artifactDir, 'cli-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

    const realChatGptPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/'))
    if (realChatGptPage) {
      await realChatGptPage.bringToFront()
      await realChatGptPage.screenshot({
        path: path.join(artifactDir, '01-real-chatgpt-after-result.png'),
        animations: 'disabled',
      })
    }
    assert.ok(realChatGptPage, `extension did not open ChatGPT: ${JSON.stringify(context.pages().map((page) => page.url()))}`)
    await fs.writeFile(path.join(artifactDir, 'real-chatgpt-text.txt'), await realChatGptPage.locator('body').innerText().catch(() => ''), 'utf8')
    const pageUrls = context.pages().map((page) => page.url())
    assert.ok(pageUrls.every((url) => !url.startsWith('chrome-extension://')), JSON.stringify(pageUrls, null, 2))

    await writeSummary(artifactDir, {
      ok: cliRun.status === 0 && result.ok,
      artifactDir,
      mode: 'live-chatgpt',
      fixture: false,
      extensionId,
      jobId: result.jobId,
      provider: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      prompt,
      compactOutput: result.compactOutput,
      error: result.error,
      pageUrls,
      events,
    })

    assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout)
    assert.equal(result.ok, true, JSON.stringify(result, null, 2))
    assert.match(result.compactOutput || '', /TOKENLESS_LIVE_DOM_OK_48291/)
  } finally {
    const cleanupErrors = []
    await attemptCleanup(cleanupErrors, 'write live E2E artifacts', async () => {
      if (context) {
        await fs.writeFile(path.join(artifactDir, 'pages.json'), `${JSON.stringify(
          context.pages().map((page) => ({ url: page.url() })),
          null,
          2
        )}\n`, 'utf8')
      }
      await fs.writeFile(path.join(artifactDir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8')
    })
    await attemptCleanup(cleanupErrors, 'close live browser context', async () => context?.close())
    await attemptCleanup(cleanupErrors, 'restore live native host manifests', async () => restoreFiles(manifestBackup))
    await attemptCleanup(cleanupErrors, 'stop installed daemon', async () => stopInstalledDaemon(tokenlessHome))
    await attemptCleanup(cleanupErrors, 'remove temporary live E2E state', async () => {
      await fs.rm(tempRoot, { recursive: true, force: true })
    })
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Tokenless live ChatGPT E2E cleanup failed')
    }
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

async function writeSummary(artifactDir, payload) {
  await fs.writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`Tokenless live ChatGPT artifacts: ${artifactDir}`)
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

async function stopInstalledDaemon(homeDir) {
  const record = await fs.readFile(path.join(homeDir, 'daemon.pid.json'), 'utf8')
    .then((body) => JSON.parse(body))
    .catch(() => null)
  if (!Number.isInteger(record?.pid)) return
  try {
    process.kill(record.pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      process.kill(record.pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function waitForBridgeMarker(homeDir, readLiveBridgeMarker) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const marker = await readLiveBridgeMarker({ homeDir })
    if (marker) return marker
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Rust extension bridge did not become live before the live ChatGPT run.')
}
