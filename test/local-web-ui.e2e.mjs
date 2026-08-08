import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright-core'

import { startDaemon } from '../packages/cli/dist/src/daemon/lifecycle.js'
import { readTokenlessConfig, writeTokenlessConfig } from '../packages/cli/dist/src/job-store.js'
import { PersistentContextManager } from '../packages/cli/dist/src/playwright/browser/context-manager.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'

test('Svelte Web UI completes setup, persists configuration, renders durable work, and remains responsive', async () => {
  await withDaemon(async ({ daemon, homeDir }) => {
    const consoleOrigin = daemon.origin.replace('127.0.0.1', 'localhost')
    const customExecutablePath = chromium.executablePath()
    const initialConfig = await readTokenlessConfig(homeDir)
    await writeTokenlessConfig({
      homeDir,
      browser: 'chrome-for-testing',
      browserExecutablePath: customExecutablePath,
      providerWhitelist: initialConfig.providerWhitelist.filter((provider) => provider !== 'gemini'),
    })
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
      fs.writeFileSync(path.join(importSourceDir, 'Last Version'), '145.0.7632.160')
      const context = await manager.ensureContext(browserProfile, 'headless')
      const page = await context.acquireReservedPage({ key: 'tokenless:control-plane:web-e2e' })
      await page.setViewportSize({ width: 1920, height: 1080 })
      page.on('console', (message) => {
        if (
          (message.type() === 'error' || message.type() === 'warning') &&
          !message.text().startsWith('Failed to load resource: the server responded with a status of 4')
        ) consoleFailures.push(message.text())
      })
      page.on('pageerror', (error) => consoleFailures.push(error.message))
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/ui-api/v1/snapshot') snapshotStatuses.push(response.status())
        if (response.url().includes('/ui-api/') && response.status() >= 500) consoleFailures.push(`${response.status()} ${response.url()}`)
      })

      await page.goto(`${consoleOrigin}/`, { waitUntil: 'networkidle' })
      assert.equal(await page.title(), 'Tokenless local console')
      await page.getByTestId('setup-view').waitFor()
      assert.equal(await page.locator('.boot-state').count(), 0)
      assert.equal(await page.locator('main').count(), 1)
      assert.equal(await page.locator('.skip-link').getAttribute('href'), '#main')
      assert.equal(await page.getByTestId('setup-view').getAttribute('id'), 'main')
      assert.deepEqual(
        await page.getByTestId('setup-browser').locator('option').evaluateAll((options) => options.map((option) => option.value)),
        ['chrome-for-testing', 'managed-chromium', 'cloak'],
      )
      await page.getByTestId('setup-browser').selectOption('chrome-for-testing')
      await page.getByTestId('setup-browser-path-toggle').click()
      await page.getByTestId('setup-browser-executable-path').fill(path.join(homeDir, 'missing-browser'))
      await page.getByTestId('setup-browser-path-inspect').click()
      await page.getByTestId('setup-browser-runtime-error').waitFor()
      assert.equal(await page.getByTestId('setup-browser-runtime-error').evaluate((element) => document.activeElement === element), true)
      await page.getByTestId('setup-browser-executable-path').fill(customExecutablePath)
      await page.getByTestId('setup-browser-path-inspect').click()
      await page.getByTestId('setup-browser-runtime-result').waitFor()
      await page.getByTestId('setup-slug').fill('work')
      await page.getByTestId('setup-label').fill('Work')
      await page.getByTestId('setup-role').fill('Research')
      await page.getByTestId('setup-visibility').selectOption('headless')
      await page.getByTestId('setup-browser').selectOption('cloak')
      await page.getByTestId('setup-profile-source-copy').click()
      assert.match(await page.getByTestId('setup-profile-source-copy').textContent(), /experimental/i)
      assert.match(await page.locator('.profile-source-panel .prominent-note').textContent(), /Google Chrome major 145.*Brave Chromium major 143 or 145/i)
      const unsupportedImportSource = await page.evaluate(async (userDataDir) => {
        const session = await (await fetch('/ui-api/v1/session')).json()
        const response = await fetch('/ui-api/v1/browser-profile-sources/discover', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tokenless-csrf': String(session.csrf),
          },
          body: JSON.stringify({ browser: 'edge', userDataDir }),
        })
        return { status: response.status, body: await response.json() }
      }, importSourceDir)
      assert.equal(unsupportedImportSource.status, 400)
      assert.equal(unsupportedImportSource.body.error.code, 'profile_import_browser_unsupported')
      await page.locator('.source-advanced summary').click()
      assert.equal(await page.getByTestId('setup-profile-source-browser').count(), 1)
      await page.getByTestId('setup-profile-source-root').fill(importSourceDir)
      await page.getByTestId('setup-profile-source-scan').click()
      await page.getByTestId('setup-profile-source-select').waitFor()
      assert.match(await page.getByTestId('setup-profile-source-select').locator('option:checked').textContent(), /Google Chrome · Default/)
      await page.getByTestId('setup-profile-source-browser').selectOption('brave')
      await page.getByTestId('setup-profile-source-scan').click()
      await page.getByTestId('setup-profile-source-select').waitFor()
      assert.match(await page.getByTestId('setup-profile-source-select').locator('option:checked').textContent(), /Brave · Default/)
      await page.getByTestId('setup-profile-source-consent').check()
      await page.getByTestId('setup-browser').selectOption('managed-chromium')
      assert.equal(await page.getByTestId('setup-profile-source-picker').count(), 1)
      await page.getByTestId('setup-browser').selectOption('chrome-for-testing')
      assert.equal(await page.getByTestId('setup-profile-source-picker').count(), 0)
      assert.equal(await page.locator('.provider-pill').filter({ hasText: 'ChatGPT' }).locator('input').isChecked(), true)
      assert.equal(await page.locator('.provider-pill').filter({ hasText: 'Gemini' }).locator('input').isChecked(), false)
      await page.getByTestId('finish-setup').click()
      await page.getByTestId('profiles-view').waitFor()
      assert.equal(await page.getByTestId('open-profile-work').count(), 1)
      const setupConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(setupConfig.browser, 'chrome-for-testing')
      assert.equal(setupConfig.browserExecutablePath, customExecutablePath)
      fs.accessSync(setupConfig.browserExecutablePath, fs.constants.X_OK)
      const importedWorkProfile = await new ManagedProfileRegistry(homeDir).resolveProfile('work')
      assert.equal(importedWorkProfile.import, undefined)
      assert.equal(fs.existsSync(path.join(importedWorkProfile.directory, 'Default')), false)
      const publicSnapshot = await page.evaluate(async () => await (await fetch('/ui-api/v1/snapshot')).json())
      assert.equal(JSON.stringify(publicSnapshot).includes(importSourceDir), false)

      assert.equal(await page.locator('.rail').evaluate((element) => Math.round(element.getBoundingClientRect().width)), 64)
      assert.equal(await page.locator('.profile-master').evaluate((element) => Math.round(element.getBoundingClientRect().width)), 302)
      assert.equal(await hasDocumentOverflow(page), false)
      assert.equal(await page.locator('.rail nav').getAttribute('aria-label'), 'Primary navigation')
      assert.equal(await page.locator('.rail [data-nav="jobs"]').evaluate((element) => element.tagName), 'A')
      assert.equal(new URL(page.url()).searchParams.get('profile'), 'work')
      assert.deepEqual(await page.locator('img').evaluateAll((images) => images.filter((image) => !image.hasAttribute('width') || !image.hasAttribute('height')).map((image) => image.getAttribute('src'))), [])

      await page.locator('.rail [data-nav="overview"]').click()
      await page.getByTestId('overview-view').waitFor()
      const defaultSavingsPanel = page.getByTestId('overview-output-savings')
      await defaultSavingsPanel.waitFor()
      assert.equal((await defaultSavingsPanel.getAttribute('class')).includes('disabled'), false)
      assert.equal(await defaultSavingsPanel.getAttribute('data-state'), 'pending')
      assert.match(await defaultSavingsPanel.textContent(), /Estimated output tokens saved|first visible response/)
      assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
      const readinessRefresh = page.getByTestId('overview-readiness-refresh')
      await readinessRefresh.waitFor()
      assert.equal(await readinessRefresh.getAttribute('aria-label'), 'Refresh provider readiness')
      assert.equal(await readinessRefresh.getAttribute('aria-busy'), 'false')
      assert.equal(await readinessRefresh.getAttribute('title'), 'Refresh provider readiness')
      assert.equal(await readinessRefresh.evaluate((element) => element.tagName), 'BUTTON')
      assert.equal(await page.getByTestId('overview-readiness-summary').textContent(), '0/9 signed in')
      await page.locator('.rail [data-nav="profiles"]').click()
      await page.getByTestId('profiles-view').waitFor()

      await page.getByTestId('add-profile').click()
      assert.equal(await page.getByTestId('modal-close').evaluate((element) => document.activeElement === element), true)
      await page.getByTestId('profile-submit').focus()
      await page.keyboard.press('Tab')
      assert.equal(await page.getByTestId('modal-close').evaluate((element) => document.activeElement === element), true)
      await page.getByTestId('profile-slug').fill('unsaved-draft')
      await page.getByTestId('profile-label').fill('Unsaved draft')
      await page.waitForTimeout(3300)
      assert.equal(await page.getByTestId('profile-slug').inputValue(), 'unsaved-draft')
      assert.equal(await page.getByTestId('profile-label').inputValue(), 'Unsaved draft')
      assert.equal(snapshotStatuses.includes(304), true)
      await page.getByTestId('profile-slug').fill('work')
      await page.getByTestId('profile-submit').click()
      await page.getByTestId('profile-form-error').waitFor()
      assert.equal(await page.getByTestId('profile-form-error').evaluate((element) => document.activeElement === element), true)
      await page.getByTestId('modal-close').click()

      await page.getByTestId('add-profile').click()
      await page.getByTestId('profile-slug').fill('personal')
      await page.getByTestId('profile-label').fill('Personal')
      await page.getByTestId('profile-submit').click()
      await page.getByTestId('modal').waitFor({ state: 'detached' })
      await page.getByTestId('profile-item-personal').waitFor()
      assert.equal(await page.getByTestId('open-profile-work').count(), 1)
      assert.equal(await page.getByTestId('open-profile-personal').count(), 1)
      assert.equal(new URL(page.url()).searchParams.get('profile'), 'personal')
      await page.reload({ waitUntil: 'networkidle' })
      await page.getByTestId('profiles-view').waitFor()
      assert.equal(await page.getByTestId('profile-item-personal').getAttribute('class').then((value) => value.includes('active')), true)
      const personalProfile = await new ManagedProfileRegistry(homeDir).resolveProfile('personal')
      await page.goto(`${consoleOrigin}/ui/?profile=${encodeURIComponent(personalProfile.id)}`, { waitUntil: 'networkidle' })
      await page.getByTestId('app-shell').waitFor()
      await page.waitForFunction(() => new URL(location.href).searchParams.get('profile') === 'personal')
      await page.locator('.rail [data-nav="profiles"]').click()
      await page.getByTestId('profiles-view').waitFor()
      assert.equal(await page.getByTestId('profile-item-personal').getAttribute('class').then((value) => value.includes('active')), true)
      await page.getByTestId('profile-item-work').click()
      assert.equal(new URL(page.url()).searchParams.get('profile'), 'work')

      await page.locator('.settings-section').first().locator('.text-button').click()
      await page.getByTestId('profile-label').fill('Work updated')
      await page.getByTestId('profile-role').fill('Operations')
      await page.getByTestId('profile-submit').click()
      await page.getByTestId('modal').waitFor({ state: 'detached' })
      await page.getByRole('heading', { name: 'Work updated' }).waitFor()

      await page.getByTestId('profile-menu').click()
      assert.equal(await page.locator('[role="menuitem"]').first().evaluate((element) => document.activeElement === element), true)
      assert.equal(await page.getByTestId('profile-reimport-open').count(), 0)
      await page.keyboard.press('Escape')
      assert.equal(await page.getByTestId('profile-menu').evaluate((element) => document.activeElement === element), true)

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
      await page.locator('.rail [data-nav="jobs"]').click()
      await page.getByTestId('job-search').fill('web-ui-durable-work')
      await page.getByTestId('job-status').selectOption('canceled')
      const workRow = page.getByTestId(`job-${work.job_id}`)
      await workRow.waitFor()
      assert.match(await workRow.textContent(), /Canceled/)
      await page.waitForFunction(() => new URL(location.href).searchParams.get('jobStatus') === 'canceled')
      assert.equal(new URL(page.url()).searchParams.get('jobSearch'), 'web-ui-durable-work')
      await workRow.click()
      assert.match(await page.getByTestId('job-detail').textContent(), /web-ui-durable-work|Canceled/)
      await page.getByTestId('modal-close').click()
      await page.reload({ waitUntil: 'networkidle' })
      await page.getByTestId('jobs-view').waitFor()
      assert.equal(await page.getByTestId('job-search').inputValue(), 'web-ui-durable-work')
      assert.equal(await page.getByTestId('job-status').inputValue(), 'canceled')
      await page.locator('.skip-link').evaluate((element) => element.click())
      assert.equal(new URL(page.url()).hash, '#jobs')
      assert.equal(await page.locator('#main').evaluate((element) => document.activeElement === element), true)

      await page.locator('.rail [data-nav="system"]').click()
      await page.getByTestId('output-savings-card').waitFor()
      assert.match(await page.getByTestId('output-savings-card').textContent(), /Output savings|enabled|10\.1 MB/i)
      assert.equal(await page.getByTestId('output-savings-install').isVisible(), true)
      assert.equal(await page.getByTestId('output-savings-disable').isVisible(), true)
      assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
      await page.getByTestId('output-savings-disable').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="output-savings-card"]')?.textContent?.includes('disabled'))
      await page.locator('.rail [data-nav="overview"]').click()
      const disabledSavingsPanel = page.getByTestId('overview-output-savings')
      await disabledSavingsPanel.waitFor()
      assert.equal((await disabledSavingsPanel.getAttribute('class')).includes('disabled'), true)
      assert.equal(await disabledSavingsPanel.getAttribute('data-state'), 'disabled')
      assert.match(await disabledSavingsPanel.textContent(), /Token summary statistics are unavailable|Turn it on to review/)
      assert.match(await disabledSavingsPanel.getAttribute('title'), /Turn it on to review/)
      assert.equal(await disabledSavingsPanel.getByRole('link').getAttribute('href'), '#system')
      assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
      await page.locator('.rail [data-nav="system"]').click()
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
      await page.getByTestId('config-error').waitFor()
      assert.match(await page.getByTestId('config-error').textContent(), /not runnable|not found|could not be verified/i)
      assert.equal(await page.getByTestId('config-error').evaluate((element) => document.activeElement === element), true)
      runtimeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(runtimeConfig.browserExecutablePath, customExecutablePath)

      await page.getByTestId('config-browser').selectOption('chrome')
      await page.getByTestId('config-browser-path-toggle').click()
      await page.getByTestId('config-browser-path-clear').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="config-browser-path-clear"]') === null)
      runtimeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(['chrome', 'chrome-for-testing'].includes(runtimeConfig.browser), true)
      assert.equal(runtimeConfig.browserExecutablePath, null)

      await page.getByTestId('config-language').selectOption('zh-CN')
      await page.getByTestId('config-visibility').selectOption('headed')
      await page.getByTestId('config-save').click()
      await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
      assert.equal(await page.title(), 'Tokenless 本地控制台')
      assert.match(await page.getByTestId('output-savings-card').textContent(), /输出节省|已停用|需要时才会下载/)
      await page.locator('.rail [data-nav="overview"]').click()
      assert.match(await page.getByTestId('overview-output-savings').textContent(), /Token 汇总统计不可用|开启后即可查看/)
      assert.match(await page.getByTestId('overview-output-savings').getAttribute('title'), /Token 汇总统计不可用/)
      await page.reload({ waitUntil: 'networkidle' })
      await page.getByTestId('app-shell').waitFor()
      await page.locator('.rail [data-nav="system"]').click()
      await page.getByTestId('system-view').waitFor()
      assert.equal(await page.getByTestId('config-language').inputValue(), 'zh-CN')
      assert.equal(await page.getByTestId('config-visibility').inputValue(), 'headed')
      await page.getByTestId('config-language').selectOption('en')
      await page.getByTestId('config-save').click()
      await page.waitForFunction(() => document.documentElement.lang === 'en')

      await page.locator('.rail [data-nav="profiles"]').click()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('.mobile-nav').waitFor()
      assert.equal(await hasDocumentOverflow(page), false)
      assert.equal(await page.locator('.mobile-nav').getAttribute('aria-label'), 'Primary navigation')
      assert.equal(await page.locator('.mobile-nav [data-nav="jobs"]').evaluate((element) => element.tagName), 'A')
      assert.equal(await page.locator('.profile-master').evaluate((element) => Math.round(element.getBoundingClientRect().width)), 390)
      assert.deepEqual(await page.locator('input, select, textarea').evaluateAll((controls) => controls.filter((control) => !control.getAttribute('name')).map((control) => control.outerHTML)), [])

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

async function hasDocumentOverflow(page) {
  return await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
}
