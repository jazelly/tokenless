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
    const importSourceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-web-ui-import-source-')))
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
      await createClosedChromiumProfile(importSourceDir)
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
      assert.equal(await page.locator('.boot-state').count(), 0)
      assert.equal(await page.locator('main').count(), 1)
      const customExecutablePath = chromium.executablePath()
      await page.getByTestId('setup-browser').selectOption('chrome-for-testing')
      await page.getByTestId('setup-browser-path-toggle').click()
      await page.getByTestId('setup-browser-executable-path').fill(customExecutablePath)
      await page.getByTestId('setup-browser-path-inspect').click()
      await page.getByTestId('setup-browser-runtime-result').waitFor()
      await page.getByTestId('setup-slug').fill('work')
      await page.getByTestId('setup-label').fill('Work')
      await page.getByTestId('setup-role').fill('Research')
      await page.getByTestId('setup-visibility').selectOption('headless')
      await page.getByTestId('setup-profile-source-copy').click()
      await page.locator('.source-advanced summary').click()
      await page.getByTestId('setup-profile-source-browser').selectOption('chrome-for-testing')
      await page.getByTestId('setup-profile-source-root').fill(importSourceDir)
      await page.getByTestId('setup-profile-source-scan').click()
      await page.getByTestId('setup-profile-source-select').waitFor()
      assert.match(await page.getByTestId('setup-profile-source-select').locator('option:checked').textContent(), /Google Chrome for Testing · Default/)
      await page.getByTestId('setup-profile-source-consent').check()
      assert.equal(await page.locator('.provider-pill').filter({ hasText: 'ChatGPT' }).locator('input').isChecked(), true)
      assert.equal(await page.locator('.provider-pill').filter({ hasText: 'Gemini' }).locator('input').isChecked(), false)
      await page.getByTestId('finish-setup').click()
      await page.getByTestId('profiles-view').waitFor()
      const setupConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(setupConfig.browser, 'chrome-for-testing')
      assert.equal(setupConfig.browserExecutablePath, customExecutablePath)
      fs.accessSync(setupConfig.browserExecutablePath, fs.constants.X_OK)
      const importedWorkProfile = await new ManagedProfileRegistry(homeDir).resolveProfile('work')
      assert.equal(importedWorkProfile.import?.source, importSourceDir)
      assert.equal(importedWorkProfile.import?.profileDirectoryKey, 'Default')
      fs.accessSync(path.join(importedWorkProfile.directory, 'Default'), fs.constants.R_OK)
      const publicSnapshot = await page.evaluate(async () => await (await fetch('/ui-api/v1/snapshot')).json())
      assert.equal(JSON.stringify(publicSnapshot).includes(importSourceDir), false)

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

      const importedAt = (await new ManagedProfileRegistry(homeDir).resolveProfile('work')).import?.importedAt
      await page.waitForTimeout(20)
      await page.getByTestId('profile-menu').click()
      await page.getByTestId('profile-reimport-open').click()
      await page.getByTestId('profile-reimport-consent').check()
      await page.getByTestId('profile-reimport-confirm').click()
      await page.getByTestId('modal').waitFor({ state: 'detached' })
      const reimportedAt = (await new ManagedProfileRegistry(homeDir).resolveProfile('work')).import?.importedAt
      assert.notEqual(reimportedAt, importedAt)

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
      await page.getByTestId('config-browser').selectOption('chrome-for-testing')
      await page.getByTestId('config-browser-path-toggle').click()
      await page.getByTestId('config-browser-executable-path').fill(customExecutablePath)
      await page.getByTestId('config-browser-path-inspect').click()
      await page.getByTestId('config-browser-runtime-result').waitFor()
      assert.match(await page.getByTestId('config-browser-runtime-result').textContent(), /Executable verified/)
      await page.getByTestId('config-save').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="config-browser-executable-path"]')?.value === '')
      let runtimeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(runtimeConfig.browser, 'chrome-for-testing')
      assert.equal(runtimeConfig.browserExecutablePath, customExecutablePath)

      const missingExecutablePath = path.join(homeDir, 'missing-browser-executable')
      await page.getByTestId('config-browser-executable-path').fill(missingExecutablePath)
      await page.getByTestId('config-save').click()
      await page.waitForFunction(() => /not runnable|not found|could not be verified/i.test(document.querySelector('.toast')?.textContent ?? ''))
      assert.match(await page.locator('.toast').textContent(), /not runnable|not found|could not be verified/i)
      runtimeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(runtimeConfig.browserExecutablePath, customExecutablePath)

      await page.getByTestId('config-browser').selectOption('chrome')
      await page.getByTestId('config-browser-path-toggle').click()
      await page.getByTestId('config-browser-path-clear').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="config-browser-path-clear"]') === null)
      await page.waitForFunction(() => document.querySelector('.toast')?.textContent === 'Changes saved.')
      runtimeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(runtimeConfig.browser, 'chrome')
      assert.equal(runtimeConfig.browserExecutablePath, null)

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
      fs.rmSync(importSourceDir, { recursive: true, force: true })
    }
  })
})

async function createClosedChromiumProfile(directory) {
  const manager = new PersistentContextManager({
    browser: {
      id: 'profile',
      executablePath: chromium.executablePath(),
    },
  })
  try {
    const context = await manager.ensureContext({ id: 'profile-source', directory, lifecycle: 'ready' }, 'headless')
    const page = await context.acquireReservedPage({ key: 'tokenless:control-plane:web-e2e-profile-source' })
    await page.goto('data:text/html,<title>Tokenless import source</title>')
  } finally {
    await manager.shutdown()
  }
}

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
