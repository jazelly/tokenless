import assert from 'node:assert/strict'
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
} from '../packages/cli/dist/src/daemon-client.js'
import { writeTokenlessConfig } from '../packages/cli/dist/src/job-store.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'

test('packaged daemon runs implicit readiness headlessly and closes its temporary context after the batch', { timeout: 75_000 }, async () => {
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
      browserConnectionMode: 'cdp',
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
    await waitFor(() => !observer.isConnected(), 40_000)
  } finally {
    await observer?.close().catch(() => undefined)
    await daemon?.close()
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
      browserConnectionMode: 'cdp',
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

    await dashboardPage.getByTestId('overview-readiness-refresh').click()
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
