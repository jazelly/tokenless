import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startDaemon } from '../packages/server/dist/src/runtime/lifecycle.js'
import { writeTokenlessConfig } from '../packages/server/dist/src/persistence/config.js'
import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'
import {
  createConfiguredBrowserContextManager,
  resolveConfiguredBrowserTarget,
} from './helpers/configured-browser-profile.mjs'

const gate = process.env.TOKENLESS_LOCAL_WEB_UI_E2E_GATE
assert.equal(
  gate,
  'configured-persistent-visible-browser',
  'To authorize this test to use the configured persistent visible browser, run: TOKENLESS_LOCAL_WEB_UI_E2E_GATE=configured-persistent-visible-browser npm run test:e2e:web',
)

test('Svelte Web UI completes setup, persists configuration, renders durable work, and remains responsive', async () => {
  await withDaemon(async ({ daemon, homeDir }) => {
    const browserTarget = await resolveConfiguredBrowserTarget()
    const consoleOrigin = daemon.origin.replace('127.0.0.1', 'localhost')
    await writeTokenlessConfig({
      homeDir,
      browser: 'chrome',
    })
    const manager = createConfiguredBrowserContextManager(browserTarget)
    const browserProfile = browserTarget.profile
    const consoleFailures = []
    const snapshotStatuses = []
    let page
    let bindingConfigPage

    try {
      const context = await manager.ensureContext(browserProfile, 'auto')
      page = await context.acquireReservedPage({ key: 'tokenless:control-plane:web-e2e' })
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
      const browserOptions = await page.getByTestId('setup-browser').locator('option').evaluateAll((options) => options.map((option) => option.value))
      assert.equal(browserOptions.includes('chrome'), true)
      assert.equal(browserOptions.includes('brave'), true)
      const browserBeforeManual = browserOptions.includes('cloak') ? 'cloak' : 'brave'
      await page.getByTestId('setup-browser').selectOption(browserBeforeManual)
      const detectedPathBeforeManual = await page.getByTestId('setup-browser-executable-path').inputValue()
      await page.getByTestId('setup-add-browser').click()
      assert.equal(await page.getByTestId('setup-manual-browser').count(), 1)
      await page.getByTestId('setup-add-browser').click()
      assert.equal(await page.getByTestId('setup-manual-browser').count(), 0)
      assert.equal(await page.getByTestId('setup-browser').inputValue(), browserBeforeManual)
      assert.equal(await page.getByTestId('setup-browser-executable-path').inputValue(), detectedPathBeforeManual)
      await page.getByTestId('setup-browser').selectOption('chrome')
      const selectedChromeExecutablePath = await page.getByTestId('setup-browser-executable-path').inputValue()
      await page.getByTestId('setup-slug').fill('work')
      await page.getByTestId('setup-role').fill('Research')
      assert.equal(await page.locator('.provider-pill').filter({ hasText: 'ChatGPT' }).locator('input').isChecked(), true)
      assert.equal(await page.locator('.provider-pill').filter({ hasText: 'Gemini' }).locator('input').isChecked(), false)
      await page.getByTestId('finish-setup').click()
      await page.getByTestId('profiles-view').waitFor()
      assert.equal(await page.getByTestId('open-profile-work').count(), 1)
      assert.match(await page.getByTestId('profile-browser-binding').textContent(), /chrome · system:chrome/)
      const setupConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(setupConfig.browser, 'chrome')
      assert.equal(setupConfig.browserExecutablePath, selectedChromeExecutablePath || null)
      const importedWorkProfile = await new ManagedProfileRegistry(homeDir).resolveProfile('work')
      assert.equal(importedWorkProfile.import, undefined)
      assert.equal(fs.existsSync(path.join(importedWorkProfile.directory, 'Default')), false)

      assert.equal(await page.locator('.rail nav').getAttribute('aria-label'), 'Primary navigation')
      assert.equal(await page.locator('.rail [data-nav="jobs"]').evaluate((element) => element.tagName), 'A')
      assert.equal(new URL(page.url()).searchParams.get('profile'), 'work')
      assert.deepEqual(await page.locator('img').evaluateAll((images) => images.filter((image) => !image.hasAttribute('width') || !image.hasAttribute('height')).map((image) => image.getAttribute('src'))), [])

      await activateNavigation(page, 'overview')
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
      assert.match(await page.getByTestId('overview-readiness-summary').textContent(), /^0\/\d+ signed in$/)
      await readinessRefresh.click()
      await page.getByTestId('overview-readiness-status').waitFor()
      assert.equal(await readinessRefresh.getAttribute('aria-busy'), 'true')
      assert.match(await page.getByTestId('overview-readiness-status').textContent(), /Checking provider sign-in…/)
      await page.getByTestId('overview-readiness-status').waitFor({ state: 'detached', timeout: 130_000 })
      assert.equal(await readinessRefresh.getAttribute('aria-busy'), 'false')
      await activateNavigation(page, 'profiles')
      await page.getByTestId('profiles-view').waitFor()

      await page.getByTestId('add-profile').click()
      assert.equal(await page.getByTestId('modal-close').evaluate((element) => document.activeElement === element), true)
      await page.getByTestId('profile-submit').focus()
      await page.keyboard.press('Tab')
      assert.equal(await page.getByTestId('modal-close').evaluate((element) => document.activeElement === element), true)
      await page.getByTestId('profile-slug').fill('unsaved-draft')
      await page.waitForTimeout(3300)
      assert.equal(await page.getByTestId('profile-slug').inputValue(), 'unsaved-draft')
      assert.equal(await page.getByTestId('profile-label').count(), 0)
      assert.equal(snapshotStatuses.includes(304), true)
      await page.getByTestId('profile-slug').fill('work')
      await page.getByTestId('profile-submit').click()
      await page.getByTestId('profile-form-error').waitFor()
      assert.equal(await page.getByTestId('profile-form-error').evaluate((element) => document.activeElement === element), true)
      await page.getByTestId('modal-close').click()

      await page.getByTestId('add-profile').click()
      await page.getByTestId('profile-slug').fill('personal')
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
      await activateNavigation(page, 'profiles')
      await page.getByTestId('profiles-view').waitFor()
      assert.equal(await page.getByTestId('profile-item-personal').getAttribute('class').then((value) => value.includes('active')), true)
      await page.getByTestId('profile-item-work').click()
      assert.equal(new URL(page.url()).searchParams.get('profile'), 'work')

      await page.locator('.settings-section').first().locator('.text-button').click()
      assert.equal(await page.getByTestId('profile-form-browser-binding').textContent(), 'chrome · system:chrome')
      await page.getByTestId('profile-role').fill('Operations')
      await page.getByTestId('profile-submit').click()
      await page.getByTestId('modal').waitFor({ state: 'detached' })
      await page.getByRole('heading', { name: 'work' }).waitFor()

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
        request_json: {
          taskId: 'api-proxy:web-ui-durable-work',
          executionMode: 'browser',
          actions: [{ action: 'prompt.input', payload: { text: 'Summarize the dashboard work.' } }],
        },
        execution_backend: 'playwright',
        profile_id: workProfile.id,
      })
      await daemon.store.cancelJob(work.job_id, { source: 'web-ui-e2e' })
      await page.waitForTimeout(3300)
      await activateNavigation(page, 'jobs')
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

      await activateNavigation(page, 'system')
      await page.getByTestId('output-savings-card').waitFor()
      assert.match(await page.getByTestId('output-savings-card').textContent(), /Output savings|enabled|10\.1 MB/i)
      assert.equal(await page.getByTestId('output-savings-install').isVisible(), true)
      assert.equal(await page.getByTestId('output-savings-disable').isVisible(), true)
      assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
      await page.getByTestId('output-savings-disable').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="output-savings-card"]')?.textContent?.includes('disabled'))
      await activateNavigation(page, 'overview')
      const disabledSavingsPanel = page.getByTestId('overview-output-savings')
      await disabledSavingsPanel.waitFor()
      assert.equal((await disabledSavingsPanel.getAttribute('class')).includes('disabled'), true)
      assert.equal(await disabledSavingsPanel.getAttribute('data-state'), 'disabled')
      assert.match(await disabledSavingsPanel.textContent(), /Token summary statistics are unavailable|Turn it on to review/)
      assert.match(await disabledSavingsPanel.getAttribute('title'), /Turn it on to review/)
      assert.equal(await disabledSavingsPanel.getByRole('link').getAttribute('href'), '#system')
      assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
      await activateNavigation(page, 'system')
      assert.equal(await page.getByTestId('config-browser').inputValue(), 'chrome')
      await page.getByTestId('config-save').click()
      const runtimeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
      assert.equal(runtimeConfig.browser, 'chrome')
      assert.equal(runtimeConfig.browserExecutablePath, selectedChromeExecutablePath || null)

      assert.equal(await page.locator('.rail [data-nav="routing"]').count(), 0)
      await activateNavigation(page, 'providers')
      await page.getByTestId('providers-view').waitFor()
      await page.getByTestId('routing-view').waitFor()
      const providerGridBox = await page.locator('.provider-card-grid').boundingBox()
      const routerBox = await page.getByTestId('routing-view').boundingBox()
      assert.equal(providerGridBox !== null && routerBox !== null && providerGridBox.y < routerBox.y, true)
      assert.equal(await page.getByTestId('router-enabled').isChecked(), false)
      assert.equal(await page.getByTestId('router-availability').locator('strong').textContent(), 'disabled')
      assert.match(await page.getByTestId('router-compatibility').textContent(), /Google Chrome 148\+/)
      assert.match(await page.getByTestId('router-chrome-setup').textContent(), /on-device-internals|experimental AI/i)

      bindingConfigPage = await context.acquireReservedPage({ key: 'tokenless:control-plane:web-e2e-binding' })
      await bindingConfigPage.goto(`${consoleOrigin}/`, { waitUntil: 'networkidle' })
      await bindingConfigPage.getByTestId('app-shell').waitFor()
      await activateNavigation(bindingConfigPage, 'system')
      await bindingConfigPage.getByTestId('config-browser').selectOption('brave')
      const braveConfigSaved = bindingConfigPage.waitForResponse((response) => (
        new URL(response.url()).pathname === '/ui-api/v1/config' &&
        response.request().method() === 'PATCH'
      ))
      await bindingConfigPage.getByTestId('config-save').click()
      assert.equal((await braveConfigSaved).status(), 200)
      assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).browser, 'brave')
      await page.reload({ waitUntil: 'networkidle' })
      await page.getByTestId('providers-view').waitFor()
      await page.getByTestId('routing-view').waitFor()
      assert.equal(await page.getByTestId('router-compatibility').locator('strong').first().textContent(), 'system · chrome')

      await activateNavigation(bindingConfigPage, 'providers')
      await bindingConfigPage.getByTestId('routing-view').waitFor()
      const routerEnabledSaved = bindingConfigPage.waitForResponse((response) => (
        new URL(response.url()).pathname === '/ui-api/v1/config' &&
        response.request().method() === 'PATCH'
      ))
      await bindingConfigPage.getByTestId('router-enabled-control').click()
      assert.equal((await routerEnabledSaved).status(), 200)
      await page.waitForFunction(() => document.querySelector('[data-testid="router-enabled"]')?.checked === true)

      await activateNavigation(bindingConfigPage, 'system')
      await bindingConfigPage.getByTestId('config-browser').selectOption('chrome')
      const chromeConfigSaved = bindingConfigPage.waitForResponse((response) => (
        new URL(response.url()).pathname === '/ui-api/v1/config' &&
        response.request().method() === 'PATCH'
      ))
      await bindingConfigPage.getByTestId('config-save').click()
      assert.equal((await chromeConfigSaved).status(), 200)
      assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).browser, 'chrome')
      assert.equal(await page.getByTestId('router-compatibility').locator('strong').first().textContent(), 'system · chrome')

      const promptApiExposed = await page.evaluate(() => typeof window.LanguageModel !== 'undefined')
      const googleChromeMajor = await page.evaluate(() => {
        const chrome = navigator.userAgentData?.brands?.find((brand) => brand.brand === 'Google Chrome')
        return chrome ? Number.parseInt(chrome.version, 10) : null
      })
      await page.waitForFunction(() => document.querySelector('[data-testid="router-availability"] strong')?.textContent !== 'checking')
      const routerAvailability = await page.getByTestId('router-availability').locator('strong').textContent()
      if (googleChromeMajor === null || googleChromeMajor < 148) {
        assert.equal(routerAvailability, 'blocked')
        assert.equal(await page.getByTestId('router-run').isDisabled(), true)
      } else {
        assert.equal(promptApiExposed ? ['available', 'downloadable', 'downloading', 'unavailable'].includes(routerAvailability) : routerAvailability === 'unsupported', true)
      }

      await activateNavigation(bindingConfigPage, 'providers')
      const routerDisabledSaved = bindingConfigPage.waitForResponse((response) => (
        new URL(response.url()).pathname === '/ui-api/v1/config' &&
        response.request().method() === 'PATCH'
      ))
      await bindingConfigPage.getByTestId('router-enabled-control').click()
      assert.equal((await routerDisabledSaved).status(), 200)
      await page.waitForFunction(() => document.querySelector('[data-testid="router-enabled"]')?.checked === false)
      assert.equal(await page.getByTestId('router-availability').locator('strong').textContent(), 'disabled')
      assert.equal(await page.locator('.routing-api-card [role="alert"]').count(), 0)
      assert.equal(await page.getByTestId('router-run').isDisabled(), true)

      const routerReenabledSaved = bindingConfigPage.waitForResponse((response) => (
        new URL(response.url()).pathname === '/ui-api/v1/config' &&
        response.request().method() === 'PATCH'
      ))
      await bindingConfigPage.getByTestId('router-enabled-control').click()
      assert.equal((await routerReenabledSaved).status(), 200)
      await page.waitForFunction(() => document.querySelector('[data-testid="router-enabled"]')?.checked === true)
      assert.equal(await page.getByTestId('router-enabled').isChecked(), true)
      await page.waitForFunction(() => document.querySelector('[data-testid="router-availability"] strong')?.textContent !== 'checking')

      await bindingConfigPage.getByTestId('provider-details-chatgpt').click()
      await bindingConfigPage.getByTestId('provider-role-chatgpt').fill('Externally configured writing tasks')
      const externalRoleSaved = bindingConfigPage.waitForResponse((response) => (
        new URL(response.url()).pathname === '/ui-api/v1/config' &&
        response.request().method() === 'PATCH'
      ))
      await bindingConfigPage.getByTestId('provider-role-save-chatgpt').click()
      assert.equal((await externalRoleSaved).status(), 200)
      await page.waitForFunction(() => document.querySelector('[data-testid="provider-card-chatgpt"] .provider-routing-summary strong')?.textContent === 'Externally configured writing tasks')

      assert.equal(await page.getByTestId('provider-readiness-chatgpt').isEnabled(), true)
      await page.getByTestId('provider-details-chatgpt').click()
      await page.getByTestId('provider-detail-chatgpt').waitFor()
      assert.equal(await page.getByTestId('provider-detail-readiness-chatgpt').isEnabled(), true)
      assert.equal(await page.getByTestId('provider-detail-controls-chatgpt').isEnabled(), true)
      assert.equal(await page.getByTestId('provider-role-chatgpt').isEnabled(), true)
      await page.getByTestId('provider-role-chatgpt').fill('Writing, editing, and tone-sensitive content')
      const chatgptRoleSaved = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/ui-api/v1/config' &&
        response.request().method() === 'PATCH'
      ))
      await page.getByTestId('provider-role-save-chatgpt').click()
      assert.equal((await chatgptRoleSaved).status(), 200)
      await page.getByTestId('provider-detail-back').click()

      await page.getByTestId('provider-details-gemini').click()
      await page.getByTestId('provider-detail-gemini').waitFor()
      assert.equal(await page.getByTestId('provider-role-gemini').isDisabled(), true)
      assert.equal(await page.getByTestId('provider-role-save-gemini').isDisabled(), true)
      assert.match(await page.getByTestId('provider-role-disabled').textContent(), /disabled|Enable it/i)
      await page.getByTestId('provider-detail-back').click()

      await page.getByTestId('provider-details-claude').click()
      await page.getByTestId('provider-detail-claude').waitFor()
      await page.getByTestId('provider-role-claude').fill('Coding and complex analysis')
      const claudeRoleSaved = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/ui-api/v1/config' &&
        response.request().method() === 'PATCH'
      ))
      await page.getByTestId('provider-role-save-claude').click()
      assert.equal((await claudeRoleSaved).status(), 200)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).router, {
        enabled: true,
        engine: 'chrome-prompt-api',
        providers: [
          { id: 'chatgpt', suitableTasks: 'Writing, editing, and tone-sensitive content' },
          { id: 'claude', suitableTasks: 'Coding and complex analysis' },
        ],
      })
      await page.reload({ waitUntil: 'networkidle' })
      await page.getByTestId('providers-view').waitFor()
      assert.equal(await page.getByTestId('router-enabled').isChecked(), true)
      assert.equal(await page.getByTestId('router-engine').inputValue(), 'chrome-prompt-api')
      await page.getByTestId('provider-details-chatgpt').click()
      assert.equal(await page.getByTestId('provider-role-chatgpt').inputValue(), 'Writing, editing, and tone-sensitive content')
      await page.getByTestId('provider-detail-back').click()
      await page.getByTestId('provider-details-claude').click()
      assert.equal(await page.getByTestId('provider-role-claude').inputValue(), 'Coding and complex analysis')
      await page.getByTestId('provider-detail-back').click()

      while (await page.locator('.provider-card .switch:has(input:checked)').count() > 0) {
        const providerUpdated = page.waitForResponse((response) => (
          new URL(response.url()).pathname === '/ui-api/v1/profiles/work' &&
          response.request().method() === 'PATCH'
        ))
        await page.locator('.provider-card .switch:has(input:checked)').first().click()
        assert.equal((await providerUpdated).status(), 200)
      }
      await page.waitForFunction(() => document.querySelector('[data-testid="router-provider-block"]')?.textContent?.includes('Enable at least one AI provider'))
      assert.match(await page.getByTestId('router-provider-block').textContent(), /Enable at least one AI provider/)
      assert.equal(await page.getByTestId('router-run').isDisabled(), true)

      await activateNavigation(page, 'system')

      await page.getByTestId('config-language').selectOption('zh-CN')
      await page.getByTestId('config-save').click()
      await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
      assert.equal(await page.title(), 'Tokenless 本地控制台')
      assert.match(await page.getByTestId('output-savings-card').textContent(), /输出节省|已停用|需要时才会下载/)
      await activateNavigation(page, 'overview')
      assert.match(await page.getByTestId('overview-output-savings').textContent(), /Token 汇总统计不可用|开启后即可查看/)
      assert.match(await page.getByTestId('overview-output-savings').getAttribute('title'), /Token 汇总统计不可用/)
      await page.reload({ waitUntil: 'networkidle' })
      await page.getByTestId('app-shell').waitFor()
      await activateNavigation(page, 'providers')
      assert.match(await page.getByTestId('router-chrome-setup').textContent(), /启用 Chrome 实验性 AI|模型信息/)
      await activateNavigation(page, 'system')
      await page.getByTestId('system-view').waitFor()
      assert.equal(await page.getByTestId('config-language').inputValue(), 'zh-CN')
      await page.getByTestId('config-language').selectOption('en')
      await page.getByTestId('config-save').click()
      await page.waitForFunction(() => document.documentElement.lang === 'en')

      await activateNavigation(page, 'profiles')

      const providerPage = await context.acquirePage({
        key: 'provider:chatgpt:task:web-ui-replacement-proof',
        policy: 'replace',
      })
      assert.notEqual(providerPage, page)
      assert.equal(page.isClosed(), false)
      assert.equal(new URL(page.url()).pathname, '/ui/')
      assert.deepEqual(consoleFailures, [])
    } finally {
      await bindingConfigPage?.goto('about:blank').catch(() => undefined)
      await page?.goto('about:blank').catch(() => undefined)
      await manager.detach()
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

async function activateNavigation(page, destination) {
  await page.locator(`.rail [data-nav="${destination}"]`).evaluate((element) => element.click())
}
