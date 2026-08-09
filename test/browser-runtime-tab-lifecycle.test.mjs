import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright-core'

import { startDaemon } from '../packages/cli/dist/src/daemon/lifecycle.js'
import {
  getDaemonJob,
  listDaemonJobs,
  openBrowserRuntimeProfile,
  openBrowserRuntimeProviderTabs,
  openTokenlessDashboard,
  quiesceBrowserRuntime,
} from '../packages/cli/dist/src/daemon-client.js'
import { writeTokenlessConfig } from '../packages/cli/dist/src/job-store.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'

test('packaged daemon keeps the implicit headless readiness browser resident after the batch', { timeout: 75_000 }, async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-headless-readiness-')))
  const previousExecutable = process.env.TOKENLESS_BROWSER_EXECUTABLE
  let daemon
  let observer
  try {
    process.env.TOKENLESS_BROWSER_EXECUTABLE = chromium.executablePath()
    const registry = new ManagedProfileRegistry(homeDir)
    const profile = await registry.addProfile({ slug: 'headless-readiness', lifecycle: 'ready', setDefault: true })
    await writeTokenlessConfig({
      homeDir,
      browser: 'profile',
      browserVisibility: 'auto',
      providerWhitelist: ['chatgpt'],
      profilePreferences: {
        [profile.slug]: {
          profileId: profile.slug,
          roleLabel: '',
          enabledProviders: ['chatgpt'],
          browserVisibility: 'auto',
          proxy: null,
        },
      },
    })
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })

    const readinessBatches = await Promise.all([
      requestProviderReadiness(daemon.origin, profile.slug),
      requestProviderReadiness(daemon.origin, profile.slug),
    ])
    const jobIds = readinessBatches.flatMap((readiness) => readiness.jobs.map((job) => job.jobId))
    assert.equal(jobIds.length, 2)
    for (const jobId of jobIds) {
      const readinessJob = await getDaemonJob({ daemonUrl: daemon.origin, homeDir, jobId })
      assert.equal(readinessJob.request_json.browserVisibility, 'auto')
      assert.equal(readinessJob.request_json.userHandoff, false)
    }

    observer = await connectToManagedBrowser(profile.directory)
    const session = await observer.newBrowserCDPSession()
    try {
      const commandLine = await session.send('Browser.getBrowserCommandLine')
      assert.equal(commandLine.arguments.includes('--headless=new'), true)
      assert.equal(commandLine.arguments.includes('--no-sandbox'), false)
    } finally {
      await session.detach().catch(() => undefined)
    }
    await Promise.all(jobIds.map((jobId) => waitFor(async () => {
      const job = await getDaemonJob({ daemonUrl: daemon.origin, homeDir, jobId })
      return job.status === 'succeeded' || job.status === 'failed' || job.status === 'waiting_for_user'
    })))
    assert.equal(observer.isConnected(), true)
    await new Promise((resolve) => setTimeout(resolve, 35_000))
    assert.equal(observer.isConnected(), true)
  } finally {
    await observer?.close().catch(() => undefined)
    if (daemon) {
      await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir }).catch(() => undefined)
    }
    await daemon?.close()
    if (previousExecutable === undefined) delete process.env.TOKENLESS_BROWSER_EXECUTABLE
    else process.env.TOKENLESS_BROWSER_EXECUTABLE = previousExecutable
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('daemon shutdown detaches and a replacement daemon reconnects to the resident browser', { timeout: 60_000 }, async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-daemon-browser-handoff-')))
  const previousExecutable = process.env.TOKENLESS_BROWSER_EXECUTABLE
  let daemon
  let observer
  try {
    process.env.TOKENLESS_BROWSER_EXECUTABLE = chromium.executablePath()
    const registry = new ManagedProfileRegistry(homeDir)
    const profile = await registry.addProfile({ slug: 'daemon-browser-handoff', lifecycle: 'ready', setDefault: true })
    await writeTokenlessConfig({ homeDir, browser: 'profile' })
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    observer = await connectToManagedBrowser(profile.directory)
    const browserContext = observer.contexts()[0]
    assert.ok(browserContext)
    const page = browserContext.pages()[0]
    assert.ok(page)
    await page.goto('data:text/html,<title>resident-browser</title>')
    const sessionBefore = await readBrowserRuntimeSession(profile.directory)

    await daemon.close()
    daemon = undefined
    assert.equal(observer.isConnected(), true)
    assert.equal(page.isClosed(), false)
    assert.equal(await page.title(), 'resident-browser')

    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    const reopened = await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'auto',
    })
    const sessionAfter = await readBrowserRuntimeSession(profile.directory)
    assert.equal(sessionAfter.pid, sessionBefore.pid)
    assert.equal(observer.isConnected(), true)
    assert.equal(page.isClosed(), false)
    assert.equal(await page.title(), 'resident-browser')
    assert.equal(reopened.effectiveBrowserVisibility, 'headed')
    assert.equal(reopened.pageCount, browserContext.pages().length)

    await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir })
    await waitFor(() => !observer.isConnected())
  } finally {
    if (!daemon) {
      daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 }).catch(() => undefined)
    }
    if (daemon) {
      await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir }).catch(() => undefined)
      await daemon.close().catch(() => undefined)
    }
    await observer?.close().catch(() => undefined)
    if (previousExecutable === undefined) delete process.env.TOKENLESS_BROWSER_EXECUTABLE
    else process.env.TOKENLESS_BROWSER_EXECUTABLE = previousExecutable
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('replacement daemon reconnects to a legacy resident browser without runtime session metadata', { timeout: 60_000 }, async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-legacy-daemon-browser-handoff-')))
  const previousExecutable = process.env.TOKENLESS_BROWSER_EXECUTABLE
  let daemon
  let observer
  try {
    process.env.TOKENLESS_BROWSER_EXECUTABLE = chromium.executablePath()
    const registry = new ManagedProfileRegistry(homeDir)
    const profile = await registry.addProfile({ slug: 'legacy-daemon-browser-handoff', lifecycle: 'ready', setDefault: true })
    await writeTokenlessConfig({ homeDir, browser: 'profile' })
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    observer = await connectToManagedBrowser(profile.directory)
    const browserContext = observer.contexts()[0]
    assert.ok(browserContext)
    const page = browserContext.pages()[0]
    assert.ok(page)
    await page.goto('data:text/html,<title>legacy-resident-browser</title>')
    const endpointPath = path.join(profile.directory, 'DevToolsActivePort')
    const sessionPath = path.join(profile.directory, 'tokenless-browser-runtime.json')
    const endpointBefore = await fs.readFile(endpointPath, 'utf8')
    const sessionBefore = await readBrowserRuntimeSession(profile.directory)

    await fs.unlink(sessionPath)
    await daemon.close()
    daemon = undefined
    assert.equal(observer.isConnected(), true)
    assert.equal(await page.title(), 'legacy-resident-browser')

    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    const reopened = await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    const migratedSession = await readBrowserRuntimeSession(profile.directory)
    assert.equal(await fs.readFile(endpointPath, 'utf8'), endpointBefore)
    assert.equal(migratedSession.pid, sessionBefore.pid)
    assert.equal(observer.isConnected(), true)
    assert.equal(page.isClosed(), false)
    assert.equal(await page.title(), 'legacy-resident-browser')
    assert.equal(reopened.effectiveBrowserVisibility, 'headed')

    await daemon.close()
    daemon = undefined
    await fs.unlink(sessionPath)
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    await assert.rejects(
      openBrowserRuntimeProfile({
        daemonUrl: daemon.origin,
        homeDir,
        profileId: profile.id,
        browserVisibility: 'headless',
      }),
      (error) => error?.code === 'playwright_legacy_resident_browser_unverified',
    )
    assert.equal(await fs.readFile(endpointPath, 'utf8'), endpointBefore)
    await assert.rejects(fs.access(sessionPath), { code: 'ENOENT' })
    assert.equal(observer.isConnected(), true)
    assert.equal(await page.title(), 'legacy-resident-browser')

    await fs.writeFile(sessionPath, `${JSON.stringify(migratedSession, null, 2)}\n`, { mode: 0o600 })
    await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir })
    await waitFor(() => !observer.isConnected())
  } finally {
    if (!daemon) {
      daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 }).catch(() => undefined)
    }
    if (daemon) {
      await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir }).catch(() => undefined)
      await daemon.close().catch(() => undefined)
    }
    await observer?.close().catch(() => undefined)
    if (previousExecutable === undefined) delete process.env.TOKENLESS_BROWSER_EXECUTABLE
    else process.env.TOKENLESS_BROWSER_EXECUTABLE = previousExecutable
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('invalid resident browser session metadata fails without overwriting the endpoint', { timeout: 60_000 }, async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-invalid-daemon-browser-session-')))
  const previousExecutable = process.env.TOKENLESS_BROWSER_EXECUTABLE
  let daemon
  let observer
  try {
    process.env.TOKENLESS_BROWSER_EXECUTABLE = chromium.executablePath()
    const registry = new ManagedProfileRegistry(homeDir)
    const profile = await registry.addProfile({ slug: 'invalid-daemon-browser-session', lifecycle: 'ready', setDefault: true })
    await writeTokenlessConfig({ homeDir, browser: 'profile' })
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    observer = await connectToManagedBrowser(profile.directory)
    const endpointPath = path.join(profile.directory, 'DevToolsActivePort')
    const sessionPath = path.join(profile.directory, 'tokenless-browser-runtime.json')
    const endpointBefore = await fs.readFile(endpointPath, 'utf8')
    const sessionBefore = await readBrowserRuntimeSession(profile.directory)

    await daemon.close()
    daemon = undefined
    const invalidSession = '{not-json}\n'
    await fs.writeFile(sessionPath, invalidSession, { mode: 0o600 })
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    await assert.rejects(
      openBrowserRuntimeProfile({
        daemonUrl: daemon.origin,
        homeDir,
        profileId: profile.id,
        browserVisibility: 'headed',
      }),
      (error) => error?.code === 'playwright_browser_runtime_session_invalid',
    )
    assert.equal(await fs.readFile(sessionPath, 'utf8'), invalidSession)
    assert.equal(await fs.readFile(endpointPath, 'utf8'), endpointBefore)
    assert.equal(observer.isConnected(), true)

    await fs.writeFile(sessionPath, `${JSON.stringify(sessionBefore, null, 2)}\n`, { mode: 0o600 })
    await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir })
    await waitFor(() => !observer.isConnected())
  } finally {
    if (!daemon) {
      daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 }).catch(() => undefined)
    }
    if (daemon) {
      await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir }).catch(() => undefined)
      await daemon.close().catch(() => undefined)
    }
    await observer?.close().catch(() => undefined)
    if (previousExecutable === undefined) delete process.env.TOKENLESS_BROWSER_EXECUTABLE
    else process.env.TOKENLESS_BROWSER_EXECUTABLE = previousExecutable
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('legacy resident browser with an unexpected launch flag is rejected without replacement', { timeout: 60_000 }, async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-unexpected-flag-browser-')))
  const previousExecutable = process.env.TOKENLESS_BROWSER_EXECUTABLE
  let daemon
  let observer
  let manualBrowser
  try {
    process.env.TOKENLESS_BROWSER_EXECUTABLE = chromium.executablePath()
    const registry = new ManagedProfileRegistry(homeDir)
    const profile = await registry.addProfile({ slug: 'unexpected-flag-browser', lifecycle: 'ready', setDefault: true })
    await writeTokenlessConfig({ homeDir, browser: 'profile' })
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    observer = await connectToManagedBrowser(profile.directory)
    const commandSession = await observer.newBrowserCDPSession()
    let originalArguments
    try {
      const commandLine = await commandSession.send('Browser.getBrowserCommandLine')
      originalArguments = commandLine.arguments.slice(1)
    } finally {
      await commandSession.detach().catch(() => undefined)
    }

    await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir })
    await waitFor(() => !observer.isConnected())
    await observer.close().catch(() => undefined)
    observer = undefined

    manualBrowser = spawn(chromium.executablePath(), [...originalArguments, '--disable-gpu'], {
      detached: true,
      stdio: 'ignore',
    })
    await waitForChildSpawn(manualBrowser)
    manualBrowser.unref()
    observer = await connectToManagedBrowser(profile.directory)
    const endpointPath = path.join(profile.directory, 'DevToolsActivePort')
    const sessionPath = path.join(profile.directory, 'tokenless-browser-runtime.json')
    const endpointBefore = await fs.readFile(endpointPath, 'utf8')

    await assert.rejects(
      openBrowserRuntimeProfile({
        daemonUrl: daemon.origin,
        homeDir,
        profileId: profile.id,
        browserVisibility: 'headed',
      }),
      (error) => error?.code === 'playwright_legacy_resident_browser_unverified',
    )
    assert.equal(await fs.readFile(endpointPath, 'utf8'), endpointBefore)
    await assert.rejects(fs.access(sessionPath), { code: 'ENOENT' })
    assert.equal(observer.isConnected(), true)

    await closeObservedBrowser(observer)
    await waitFor(() => manualBrowser.exitCode !== null || manualBrowser.signalCode !== null)
    manualBrowser = undefined
    await fs.unlink(endpointPath).catch((error) => {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error
    })

    manualBrowser = spawn(chromium.executablePath(), [...originalArguments, 'about:blank#unexpected'], {
      detached: true,
      stdio: 'ignore',
    })
    await waitForChildSpawn(manualBrowser)
    manualBrowser.unref()
    observer = await connectToManagedBrowser(profile.directory)
    const positionalEndpointBefore = await fs.readFile(endpointPath, 'utf8')

    await assert.rejects(
      openBrowserRuntimeProfile({
        daemonUrl: daemon.origin,
        homeDir,
        profileId: profile.id,
        browserVisibility: 'headed',
      }),
      (error) => error?.code === 'playwright_legacy_resident_browser_unverified',
    )
    assert.equal(await fs.readFile(endpointPath, 'utf8'), positionalEndpointBefore)
    await assert.rejects(fs.access(sessionPath), { code: 'ENOENT' })
    assert.equal(observer.isConnected(), true)

    await closeObservedBrowser(observer)
    await waitFor(() => manualBrowser.exitCode !== null || manualBrowser.signalCode !== null)
    manualBrowser = undefined
  } finally {
    await observer?.close().catch(() => undefined)
    if (manualBrowser && manualBrowser.exitCode === null && manualBrowser.signalCode === null) {
      manualBrowser.kill('SIGTERM')
      await waitFor(() => manualBrowser.exitCode !== null || manualBrowser.signalCode !== null).catch(() => undefined)
    }
    if (daemon) {
      await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir }).catch(() => undefined)
      await daemon.close().catch(() => undefined)
    }
    if (previousExecutable === undefined) delete process.env.TOKENLESS_BROWSER_EXECUTABLE
    else process.env.TOKENLESS_BROWSER_EXECUTABLE = previousExecutable
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('packaged daemon completes headed provider tabs and keeps the dashboard context live through readiness refresh', { timeout: 60_000 }, async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-tab-lifecycle-')))
  const previousEnvironment = new Map([
    ['TOKENLESS_BROWSER_EXECUTABLE', process.env.TOKENLESS_BROWSER_EXECUTABLE],
  ])
  let daemon
  try {
    process.env.TOKENLESS_BROWSER_EXECUTABLE = chromium.executablePath()
    const registry = new ManagedProfileRegistry(homeDir)
    const profile = await registry.addProfile({ slug: 'tab-lifecycle', lifecycle: 'ready', setDefault: true })
    await writeTokenlessConfig({
      homeDir,
      browser: 'profile',
      browserVisibility: 'auto',
      providerWhitelist: ['chatgpt'],
      profilePreferences: {
        [profile.slug]: {
          profileId: profile.slug,
          roleLabel: '',
          enabledProviders: ['chatgpt'],
          browserVisibility: 'auto',
          proxy: null,
        },
      },
    })
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    const profileOpened = await openBrowserRuntimeProfile({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    assert.equal(profileOpened.pageCount, 1)

    const observer = await connectToManagedBrowser(profile.directory)
    const browserContext = observer.contexts()[0]
    assert.ok(browserContext)

    const providers = ['chatgpt', 'claude']
    const opened = await openBrowserRuntimeProviderTabs({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      providers,
      browserVisibility: 'headed',
    })
    assert.deepEqual(opened.tabs.map((tab) => tab.provider), providers)
    assert.deepEqual(opened.failures, [])
    assert.equal(opened.pageCount, opened.tabs.length)
    await waitFor(() => browserContext.pages().length === opened.pageCount)

    const claude = await waitForValue(() => browserContext.pages().find((page) => page.url().includes('claude.ai')))
    const chatgpt = await waitForValue(() => browserContext.pages().find((page) => page.url().includes('chatgpt.com')))
    await claude.close()
    await waitFor(() => browserContext.pages().length === 1)
    assert.equal(observer.isConnected(), true)
    assert.equal(chatgpt.isClosed(), false)

    const dashboard = await openTokenlessDashboard({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      open: true,
    })
    assert.equal(dashboard.opened?.pageCount, 2)
    const dashboardPage = await waitForValue(() => browserContext.pages().find((page) => page.url().startsWith(daemon.origin)))
    await dashboardPage.reload({ waitUntil: 'domcontentloaded' })
    await dashboardPage.getByTestId('overview-view').waitFor()
    assert.equal(observer.isConnected(), true)
    assert.equal(chatgpt.isClosed(), false)
    assert.equal(dashboardPage.isClosed(), false)

    const reopenedDashboard = await openTokenlessDashboard({
      daemonUrl: daemon.origin,
      homeDir,
      profileId: profile.id,
      open: true,
    })
    assert.equal(reopenedDashboard.opened?.reused, true)
    assert.equal(reopenedDashboard.opened?.pageCount, 2)

    await dashboardPage.getByTestId('overview-view').waitFor()
    const readinessRefresh = dashboardPage.getByTestId('overview-readiness-refresh')
    await readinessRefresh.waitFor({ state: 'visible' })
    assert.equal(await readinessRefresh.isEnabled(), true)
    const boundsBefore = await readinessRefresh.boundingBox()
    assert.ok(boundsBefore)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const boundsAfter = await readinessRefresh.boundingBox()
    assert.ok(boundsAfter)
    assert.ok(Math.abs(boundsAfter.x - boundsBefore.x) < 0.5)
    assert.ok(Math.abs(boundsAfter.y - boundsBefore.y) < 0.5)
    assert.ok(Math.abs(boundsAfter.width - boundsBefore.width) < 0.5)
    assert.ok(Math.abs(boundsAfter.height - boundsBefore.height) < 0.5)
    const pointerTarget = await readinessRefresh.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return {
        centerVisible: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
        hitInsideButton: hit !== null && element.contains(hit),
        animationRunning: element.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running'),
      }
    })
    assert.deepEqual(pointerTarget, {
      centerVisible: true,
      hitInsideButton: true,
      animationRunning: false,
    })
    await dashboardPage.mouse.click(
      boundsAfter.x + boundsAfter.width / 2,
      boundsAfter.y + boundsAfter.height / 2,
    )
    const readinessSummary = await waitForValue(async () => {
      const jobs = await listDaemonJobs({
        daemonUrl: daemon.origin,
        homeDir,
        profileId: profile.id,
        provider: 'chatgpt',
      })
      return jobs.find((job) => typeof job.request_json?.taskId === 'string' && job.request_json.taskId.startsWith('ui:readiness:'))
    })
    const readinessJob = await getDaemonJob({ daemonUrl: daemon.origin, homeDir, jobId: readinessSummary.job_id })
    const readinessContext = await waitForValue(() => {
      if (!observer.isConnected()) return 'replaced'
      return browserContext.pages().length > 2 ? 'reused' : null
    })
    assert.equal(readinessContext, 'reused')
    assert.equal(readinessJob.request_json.browserVisibility, 'auto')
    assert.equal(observer.isConnected(), true)
    assert.equal(chatgpt.isClosed(), false)
    assert.equal(dashboardPage.isClosed(), false)
    assert.equal(await dashboardPage.evaluate(() => document.visibilityState), 'visible')
  } finally {
    if (daemon) {
      await quiesceBrowserRuntime({ daemonUrl: daemon.origin, homeDir }).catch(() => undefined)
    }
    await daemon?.close()
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

async function requestProviderReadiness(origin, profileSlug) {
  const sessionResponse = await fetch(`${origin}/ui-api/v1/session`)
  assert.equal(sessionResponse.status, 200)
  const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0]
  assert.match(cookie ?? '', /^tokenless_ui_session=/)
  const session = await sessionResponse.json()
  const response = await fetch(`${origin}/ui-api/v1/profiles/${encodeURIComponent(profileSlug)}/providers/actions/readiness`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'x-tokenless-csrf': session.csrf,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(response.status, 202)
  return await response.json()
}

async function connectToManagedBrowser(profileDirectory) {
  const endpoint = await waitForValue(async () => {
    try {
      const [port, websocketPath] = (await fs.readFile(path.join(profileDirectory, 'DevToolsActivePort'), 'utf8'))
        .trim()
        .split(/\r?\n/u)
      if (!/^\d+$/u.test(port ?? '') || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(websocketPath ?? '')) return null
      return `http://127.0.0.1:${port}`
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return null
      throw error
    }
  })
  return await chromium.connectOverCDP(endpoint)
}

async function readBrowserRuntimeSession(profileDirectory) {
  const session = JSON.parse(await fs.readFile(path.join(profileDirectory, 'tokenless-browser-runtime.json'), 'utf8'))
  assert.equal(session.protocol, 'tokenless.browser-runtime-session.v1')
  assert.equal(session.pid === null || Number.isSafeInteger(session.pid), true)
  return session
}

async function closeObservedBrowser(browser) {
  const session = await browser.newBrowserCDPSession()
  try {
    await session.send('Browser.close')
  } finally {
    await session.detach().catch(() => undefined)
  }
  await waitFor(() => !browser.isConnected())
}

async function waitForChildSpawn(child) {
  if (child.pid) return
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

async function waitFor(predicate, timeoutMs = 15_000) {
  await waitForValue(async () => (await predicate()) ? true : null, timeoutMs)
}

async function waitForValue(value, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const resolved = await value()
    if (resolved) return resolved
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for the managed browser state.`)
}
