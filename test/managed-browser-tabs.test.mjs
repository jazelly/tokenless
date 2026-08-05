import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright-core'

import {
  PersistentContextManager,
} from '../packages/cli/dist/src/playwright/index.js'

const connectionModes = ['playwright', 'cdp']

for (const connectionMode of connectionModes) {
  test(`${connectionMode} production launch keeps configured Chromium executables keychain-neutral`, async () => {
    await withManager(connectionMode, async ({ manager, profile }) => {
      const managed = await manager.ensureContext(profile, 'headless')
      const page = await managed.acquirePage({ key: 'browser-command-line' })
      await page.goto('chrome://version')
      const commandLine = await page.locator('#command_line').textContent()
      assert.match(commandLine ?? '', /(?:^|\s)--password-store=basic(?:\s|$)/u)
      assert.match(commandLine ?? '', /(?:^|\s)--use-mock-keychain(?:\s|$)/u)
    }, { browserId: 'chromium' })
  })

  test(`${connectionMode} managed browser reuses one persistent browser for one selected profile`, async () => {
    await withManager(connectionMode, async ({ manager, profile }) => {
      const first = await manager.ensureContext(profile, 'headless')
      const second = await manager.ensureContext(profile, 'headless')

      assert.equal(second.browserContext, first.browserContext)
      assert.equal(second.browserContext.browser(), first.browserContext.browser())

      const firstPage = await first.acquirePage({ key: 'provider:chatgpt:task:first' })
      const secondPage = await second.acquirePage({ key: 'provider:gemini:task:second' })
      assert.notEqual(secondPage, firstPage)
      assert.equal(first.browserContext.pages().length, 2)
    })
  })

  test(`${connectionMode} profile open reuses an existing headed dashboard context`, async () => {
    await withManager(connectionMode, async ({ manager, profile }) => {
      const first = await manager.ensureContext(profile, 'headed')
      const dashboard = await first.acquireReservedPage({ key: 'tokenless:control-plane:profile-open-regression' })
      await dashboard.setContent('<title>Tokenless dashboard</title>')

      const reopened = await manager.ensureContext(profile, 'headed')

      assert.equal(reopened.browserContext, first.browserContext)
      assert.equal(reopened.browserContext.browser(), first.browserContext.browser())
      assert.equal(dashboard.isClosed(), false)
      assert.equal(await dashboard.title(), 'Tokenless dashboard')
    })
  })

  test(`${connectionMode} managed browser keeps one stable browser instance per active profile`, async () => {
    await withManager(connectionMode, async ({ manager, profile, otherProfile }) => {
      const first = await manager.ensureContext(profile, 'headless')
      const firstBrowser = first.browserContext.browser()
      const second = await manager.ensureContext(otherProfile, 'headless')
      const secondBrowser = second.browserContext.browser()
      const reusedFirst = await manager.ensureContext(profile, 'headless')

      assert.deepEqual(manager.activeProfileIds(), [profile.id, otherProfile.id].sort())
      assert.notEqual(secondBrowser, firstBrowser)
      assert.equal(reusedFirst.browserContext, first.browserContext)
      assert.equal(reusedFirst.browserContext.browser(), firstBrowser)
      assert.equal(firstBrowser?.isConnected(), true)
      assert.equal(secondBrowser?.isConnected(), true)
    })
  })

  test(`${connectionMode} managed browser never evicts an active profile to make room`, async () => {
    await withManager(connectionMode, async ({ manager, profile, otherProfile, overflowProfile }) => {
      const first = await manager.ensureContext(profile, 'headless')
      const second = await manager.ensureContext(otherProfile, 'headless')
      const firstBrowser = first.browserContext.browser()
      const secondBrowser = second.browserContext.browser()

      await assert.rejects(
        manager.ensureContext(overflowProfile, 'headless'),
        (error) => error?.code === 'playwright_context_limit_reached' && error?.retryable === true,
      )

      assert.deepEqual(manager.activeProfileIds(), [profile.id, otherProfile.id].sort())
      assert.equal((await manager.ensureContext(profile, 'headless')).browserContext, first.browserContext)
      assert.equal((await manager.ensureContext(otherProfile, 'headless')).browserContext, second.browserContext)
      assert.equal(firstBrowser?.isConnected(), true)
      assert.equal(secondBrowser?.isConnected(), true)
    })
  })

  test(`${connectionMode} managed browser preserves independent logical tabs in one profile`, async () => {
    await withManager(connectionMode, async ({ manager, profile }) => {
      await manager.runWithProfile(profile, 'headless', async (context) => {
        const chatgpt = await context.acquirePage({ key: 'provider:chatgpt:task:chat-a' })
        await chatgpt.setContent('<title>ChatGPT chat A</title>')

        const claude = await context.acquirePage({ key: 'provider:claude:task:chat-b' })
        await claude.setContent('<title>Claude chat B</title>')

        assert.notEqual(claude, chatgpt)
        assert.equal(await chatgpt.title(), 'ChatGPT chat A')
        assert.equal(await claude.title(), 'Claude chat B')
        assert.equal(context.browserContext.pages().length, 2)

        const resumedChatgpt = await context.acquirePage({ key: 'provider:chatgpt:task:chat-a' })
        assert.equal(resumedChatgpt, chatgpt)
        assert.equal(await resumedChatgpt.title(), 'ChatGPT chat A')
        assert.equal(context.browserContext.pages().length, 2)

        const forcedReplacement = await context.acquirePage({
          key: 'provider:grok:task:chat-c',
          policy: 'replace',
        })
        assert.equal(forcedReplacement, claude)
        assert.equal(context.browserContext.pages().length, 2)

        const restoredClaude = await context.acquirePage({ key: 'provider:claude:task:chat-b' })
        assert.notEqual(restoredClaude, forcedReplacement)
        assert.equal(context.browserContext.pages().length, 3)
      })
    })
  })

  test(`${connectionMode} headed managed browser operates on background-created automation tabs`, async () => {
    await withCapabilityServer(async (origin) => {
      await withManager(connectionMode, async ({ manager, profile }) => {
        const managed = await manager.ensureContext(profile, 'headed')
        const selectedPage = await managed.acquirePage({ key: 'selected-tab' })
        await selectedPage.goto(`${origin}/start`)

        const backgroundPage = await managed.acquirePage({ key: 'background-tab' })
        assert.notEqual(backgroundPage, selectedPage)

        await backgroundPage.goto(`${origin}/navigated`)
        assert.equal(await backgroundPage.locator('h1').textContent(), 'Navigated')
        assert.equal(selectedPage.url(), `${origin}/start`)
      })
    })
  })

  test(`${connectionMode} managed browser closes capability gaps at a real Chromium boundary`, async () => {
    await withCapabilityServer(async (origin) => {
      await withManager(connectionMode, async ({ manager, profile, profileDirectory }) => {
        const upload = path.join(profileDirectory, 'capability-upload.txt')
        fs.writeFileSync(upload, `upload-${connectionMode}\n`, { mode: 0o600 })

        await manager.runWithProfile(profile, 'headless', async (context) => {
          await context.browserContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
          const page = await context.acquirePage({ key: 'capability-matrix' })
          await page.goto(`${origin}/start`)

          await page.getByLabel('Message').fill(`filled-${connectionMode}`)
          assert.equal(await page.getByLabel('Message').inputValue(), `filled-${connectionMode}`)
          assert.equal(await page.locator('[data-capability="dom-read"]').textContent(), 'DOM ready')

          await page.getByRole('link', { name: 'Navigate' }).click()
          await page.waitForURL(`${origin}/navigated`)
          assert.equal(await page.locator('h1').textContent(), 'Navigated')
          await page.goto(`${origin}/start`)

          await page.locator('#direct-file').setInputFiles(upload)
          assert.equal(await page.locator('#direct-file').evaluate((input) => input.files?.[0]?.name), path.basename(upload))

          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.locator('button', { hasText: 'Choose file' }).click(),
          ])
          await chooser.setFiles(upload)
          assert.equal(await page.locator('#chooser-file').evaluate((input) => input.files?.[0]?.name), path.basename(upload))

          const [popup] = await Promise.all([
            page.waitForEvent('popup'),
            page.getByRole('button', { name: 'Open popup' }).click(),
          ])
          await popup.waitForLoadState()
          assert.equal(await popup.locator('h1').textContent(), 'Popup')
          await popup.close()

          const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.getByRole('link', { name: 'Download' }).click(),
          ])
          assert.equal(download.suggestedFilename(), 'tokenless-capability.txt')
          assert.equal(await download.failure(), null)

          const clipboardValue = `clipboard-${connectionMode}`
          await page.evaluate(async (value) => await navigator.clipboard.writeText(value), clipboardValue)
          assert.equal(await page.evaluate(async () => await navigator.clipboard.readText()), clipboardValue)
        })
      })
    })
  })

  test(`${connectionMode} managed browser rebuilds page mapping after context loss and visibility changes`, async () => {
    await withManager(connectionMode, async ({ manager, profile }) => {
      const initial = await manager.ensureContext(profile, 'headless')
      const initialPage = await initial.acquirePage({ key: 'provider:chatgpt:task:reconnect' })
      await initialPage.setContent(`<title>${connectionMode} before reconnect</title>`)
      await initial.browserContext.close()

      const reconnected = await manager.ensureContext(profile, 'headless')
      const reconstructedPage = await reconnected.acquirePage({ key: 'provider:chatgpt:task:reconnect' })
      assert.notEqual(reconstructedPage, initialPage)
      assert.equal(reconstructedPage.isClosed(), false)

      const switched = await reconnected.switchVisibility('headed')
      assert.equal(switched.effectiveBrowserVisibility, 'headed')
      assert.notEqual(switched.browserContext, reconnected.browserContext)
    })
  })
}

async function withManager(connectionMode, operation, { browserId = 'profile' } = {}) {
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `tokenless-${connectionMode}-capabilities-`))
  const otherProfileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `tokenless-${connectionMode}-other-profile-`))
  const overflowProfileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `tokenless-${connectionMode}-overflow-profile-`))
  const manager = new PersistentContextManager({
    maxContexts: 2,
    connectionMode,
    browser: {
      id: browserId,
      executablePath: chromium.executablePath(),
    },
  })
  const profile = { id: 'default', directory: profileDirectory, lifecycle: 'ready' }
  const otherProfile = { id: 'secondary', directory: otherProfileDirectory, lifecycle: 'ready' }
  const overflowProfile = { id: 'overflow', directory: overflowProfileDirectory, lifecycle: 'ready' }
  try {
    return await operation({ manager, profile, otherProfile, overflowProfile, profileDirectory })
  } finally {
    await manager.shutdown()
    fs.rmSync(profileDirectory, { recursive: true, force: true })
    fs.rmSync(otherProfileDirectory, { recursive: true, force: true })
    fs.rmSync(overflowProfileDirectory, { recursive: true, force: true })
  }
}

async function withCapabilityServer(operation) {
  const server = http.createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, {
        'content-disposition': 'attachment; filename="tokenless-capability.txt"',
        'content-type': 'text/plain; charset=utf-8',
      })
      response.end('download-ready\n')
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/popup') {
      response.end('<!doctype html><h1>Popup</h1>')
      return
    }
    if (request.url === '/navigated') {
      response.end('<!doctype html><h1>Navigated</h1>')
      return
    }
    response.end(`<!doctype html>
      <label>Message <textarea></textarea></label>
      <p data-capability="dom-read">DOM ready</p>
      <a href="/navigated">Navigate</a>
      <input id="direct-file" type="file">
      <input id="chooser-file" type="file" hidden>
      <button type="button" onclick="document.querySelector('#chooser-file').click()">Choose file</button>
      <button type="button" onclick="window.open('/popup', '_blank')">Open popup</button>
      <a href="/download" download>Download</a>
    `)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await operation(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}
