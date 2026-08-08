import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright-core'

import { startDaemon } from '../packages/cli/dist/src/daemon/lifecycle.js'
import {
  openBrowserRuntimeProfile,
  openBrowserRuntimeProviderTabs,
  openTokenlessDashboard,
} from '../packages/cli/dist/src/daemon-client.js'
import { writeTokenlessConfig } from '../packages/cli/dist/src/job-store.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'

test('packaged daemon completes headed provider tab creation and keeps the dashboard context live', { timeout: 60_000 }, async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-tab-lifecycle-')))
  const previousEnvironment = new Map([
    ['TOKENLESS_BROWSER_EXECUTABLE', process.env.TOKENLESS_BROWSER_EXECUTABLE],
    ['TOKENLESS_E2E_BROWSER_INSPECTION', process.env.TOKENLESS_E2E_BROWSER_INSPECTION],
    ['TOKENLESS_E2E_RUN_ID', process.env.TOKENLESS_E2E_RUN_ID],
    ['TOKENLESS_E2E_NONCE', process.env.TOKENLESS_E2E_NONCE],
    ['TOKENLESS_E2E_OBSERVER_TIMEOUT_MS', process.env.TOKENLESS_E2E_OBSERVER_TIMEOUT_MS],
  ])
  let daemon
  try {
    process.env.TOKENLESS_BROWSER_EXECUTABLE = chromium.executablePath()
    process.env.TOKENLESS_E2E_BROWSER_INSPECTION = '1'
    process.env.TOKENLESS_E2E_RUN_ID = `tab-lifecycle-${randomUUID()}`
    process.env.TOKENLESS_E2E_NONCE = randomBytes(32).toString('base64url')
    process.env.TOKENLESS_E2E_OBSERVER_TIMEOUT_MS = '30000'
    await writeTokenlessConfig({ homeDir, browser: 'profile' })
    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })

    const registry = new ManagedProfileRegistry(homeDir)
    const profile = await registry.addProfile({ slug: 'tab-lifecycle', lifecycle: 'ready', setDefault: true })
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
  } finally {
    await daemon?.close()
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

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
