import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright-core'

import { startDaemon } from '../packages/cli/dist/src/daemon/lifecycle.js'
import { PersistentContextManager } from '../packages/cli/dist/src/playwright/browser/context-manager.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'

test('Svelte Web UI completes setup, persists configuration, renders durable work, and remains responsive', async () => {
  await withDaemon(async ({ daemon, homeDir }) => {
    const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
    const minted = await mintTicket(daemon.origin, token)
    const browserProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-web-ui-browser-'))
    const manager = new PersistentContextManager({
      browser: {
        id: 'profile',
        executablePath: chromium.executablePath(),
      },
    })
    const browserProfile = { id: 'web-ui-browser', directory: browserProfileDir, lifecycle: 'ready' }
    const consoleFailures = []
    const snapshotStatuses = []

    try {
      const context = await manager.ensureContext(browserProfile, 'headless')
      const page = await context.acquireReservedPage({ key: 'tokenless:control-plane:web-e2e' })
      await page.setViewportSize({ width: 1920, height: 1080 })
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') consoleFailures.push(message.text())
      })
      page.on('pageerror', (error) => consoleFailures.push(error.message))
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/ui-api/v1/snapshot') snapshotStatuses.push(response.status())
      })

      await page.goto(minted.body.bootstrapUrl, { waitUntil: 'networkidle' })
      assert.equal(await page.title(), 'Tokenless local console')
      await page.getByTestId('setup-view').waitFor()
      await page.getByTestId('setup-slug').fill('work')
      await page.getByTestId('setup-label').fill('Work')
      await page.getByTestId('setup-role').fill('Research')
      await page.getByTestId('setup-visibility').selectOption('headless')
      assert.equal(await page.locator('.provider-pill').filter({ hasText: 'ChatGPT' }).locator('input').isChecked(), true)
      assert.equal(await page.locator('.provider-pill').filter({ hasText: 'Gemini' }).locator('input').isChecked(), false)
      await page.getByTestId('finish-setup').click()
      await page.getByTestId('profiles-view').waitFor()

      assert.equal(await page.locator('.rail').evaluate((element) => Math.round(element.getBoundingClientRect().width)), 64)
      assert.equal(await page.locator('.profile-master').evaluate((element) => Math.round(element.getBoundingClientRect().width)), 302)
      assert.equal(await hasDocumentOverflow(page), false)
      assert.equal(await page.locator('.rail nav').getAttribute('aria-label'), 'Primary navigation')

      await page.getByTestId('add-profile').click()
      await page.getByTestId('profile-slug').fill('unsaved-draft')
      await page.getByTestId('profile-label').fill('Unsaved draft')
      await page.waitForTimeout(3300)
      assert.equal(await page.getByTestId('profile-slug').inputValue(), 'unsaved-draft')
      assert.equal(await page.getByTestId('profile-label').inputValue(), 'Unsaved draft')
      assert.equal(snapshotStatuses.includes(304), true)
      await page.getByTestId('modal-close').click()

      await page.locator('.settings-section').first().locator('.text-button').click()
      await page.getByTestId('profile-label').fill('Work updated')
      await page.getByTestId('profile-role').fill('Operations')
      await page.getByTestId('profile-submit').click()
      await page.getByTestId('modal').waitFor({ state: 'detached' })
      await page.getByRole('heading', { name: 'Work updated' }).waitFor()

      const registry = new ManagedProfileRegistry(homeDir)
      const workProfile = await registry.resolveProfile('work')
      const work = daemon.store.createJob({
        provider: 'chatgpt',
        action: 'web-ui-display-check',
        request_json: { taskId: 'web-ui-durable-work' },
        execution_backend: 'playwright',
        profile_id: workProfile.id,
      })
      await daemon.store.cancelJob(work.job_id, { source: 'web-ui-e2e' })
      await page.waitForTimeout(3300)
      await page.locator('.rail button[data-nav="jobs"]').click()
      await page.getByTestId('job-search').fill('web-ui-durable-work')
      const workRow = page.getByTestId(`job-${work.job_id}`)
      await workRow.waitFor()
      assert.match(await workRow.textContent(), /canceled/)
      await workRow.click()
      assert.match(await page.getByTestId('job-detail').textContent(), /web-ui-durable-work|canceled/)
      await page.getByTestId('modal-close').click()

      await page.locator('.rail button[data-nav="system"]').click()
      await page.getByTestId('config-language').selectOption('zh-CN')
      await page.getByTestId('config-visibility').selectOption('headed')
      await page.getByTestId('config-save').click()
      await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
      assert.equal(await page.title(), 'Tokenless 本地控制台')
      await page.reload({ waitUntil: 'networkidle' })
      await page.getByTestId('app-shell').waitFor()
      await page.locator('.rail button[data-nav="system"]').click()
      await page.getByTestId('system-view').waitFor()
      assert.equal(await page.getByTestId('config-language').inputValue(), 'zh-CN')
      assert.equal(await page.getByTestId('config-visibility').inputValue(), 'headed')
      await page.getByTestId('config-language').selectOption('en')
      await page.getByTestId('config-save').click()
      await page.waitForFunction(() => document.documentElement.lang === 'en')

      await page.locator('.rail button[data-nav="profiles"]').click()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('.mobile-nav').waitFor()
      assert.equal(await hasDocumentOverflow(page), false)
      assert.equal(await page.locator('.mobile-nav').getAttribute('aria-label'), 'Primary navigation')
      assert.equal(await page.locator('.profile-master').evaluate((element) => Math.round(element.getBoundingClientRect().width)), 390)

      const providerPage = await context.acquirePage({
        key: 'provider:chatgpt:task:web-ui-replacement-proof',
        policy: 'replace',
      })
      assert.notEqual(providerPage, page)
      assert.equal(page.isClosed(), false)
      assert.equal(new URL(page.url()).pathname, '/ui/')
      assert.deepEqual(consoleFailures, [])
    } finally {
      await manager.shutdown()
      fs.rmSync(browserProfileDir, { recursive: true, force: true })
    }
  })
})

async function withDaemon(operation) {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-web-ui-e2e-')))
  const daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
  try {
    return await operation({ daemon, homeDir })
  } finally {
    await daemon.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
}

async function mintTicket(origin, token) {
  const response = await fetch(`${origin}/control/ui-bootstrap`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(response.status, 200)
  return { response, body: await response.json() }
}

async function hasDocumentOverflow(page) {
  return await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
}
