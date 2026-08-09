import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import {
  PersistentContextManager,
} from '../packages/cli/dist/src/playwright/index.js'
import { resolveConfiguredDedicatedTestTarget } from './helpers/live-provider-test-profile.mjs'

test('CDP production launch allows configured Chromium executables to use native credential storage', async () => {
  await withManager(async ({ manager, profile }) => {
    const managed = await manager.ensureContext(profile, 'auto')
    await withTestPages(managed, async (context) => {
      const page = await context.acquirePage({ key: 'browser-command-line' })
      await page.goto('chrome://version')
      const commandLine = await page.locator('#command_line').textContent()
      assert.doesNotMatch(commandLine ?? '', /(?:^|\s)--password-store=basic(?:\s|$)/u)
      assert.doesNotMatch(commandLine ?? '', /(?:^|\s)--use-mock-keychain(?:\s|$)/u)
    })
  })
})

test('CDP managed browser reuses one persistent browser for one selected profile', async () => {
  await withManager(async ({ manager, profile }) => {
    const first = await manager.ensureContext(profile, 'auto')
    const second = await manager.ensureContext(profile, 'auto')

    assert.equal(second.browserContext, first.browserContext)
    assert.equal(second.browserContext.browser(), first.browserContext.browser())

    await withTestPages(first, async (context) => {
      const firstPage = await context.acquirePage({ key: 'provider:chatgpt:task:first' })
      const secondPage = await context.acquirePage({ key: 'provider:gemini:task:second' })
      assert.notEqual(secondPage, firstPage)
      assert.equal(first.browserContext.pages().length, 2)
    })
  })
})

test('CDP profile open reuses an existing headed dashboard context', async () => {
  await withManager(async ({ manager, profile }) => {
    const first = await manager.ensureContext(profile, 'headed')
    await withTestPages(first, async (context) => {
      const dashboard = await context.acquireReservedPage({ key: 'tokenless:control-plane:profile-open-regression' })
      await dashboard.setContent('<title>Tokenless dashboard</title>')

      const reopened = await manager.ensureContext(profile, 'headed')

      assert.equal(reopened.browserContext, first.browserContext)
      assert.equal(reopened.browserContext.browser(), first.browserContext.browser())
      assert.equal(dashboard.isClosed(), false)
      assert.equal(await dashboard.title(), 'Tokenless dashboard')
    })
  })
})

test('headed managed pages use the real browser window viewport without emulation', async () => {
  await withManager(async ({ manager, profile }) => {
    const managed = await manager.ensureContext(profile, 'headed')
    await withTestPages(managed, async (context) => {
      const page = await context.acquirePage({ key: 'tokenless:control-plane:responsive-regression' })
      const session = await managed.browserContext.newCDPSession(page)
      try {
        const target = await session.send('Browser.getWindowForTarget')
        const { bounds } = await session.send('Browser.getWindowBounds', { windowId: target.windowId })
        const viewport = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }))

        assert.equal(page.viewportSize(), null)
        assert.ok(viewport.width > 0)
        assert.ok(viewport.height > 0)
        assert.ok(typeof bounds.width === 'number' && viewport.width <= bounds.width)
        assert.ok(typeof bounds.height === 'number' && viewport.height <= bounds.height)
      } finally {
        await session.detach().catch(() => undefined)
      }
    })
  })
})

test('CDP managed browser preserves independent logical tabs in one profile', async () => {
  await withManager(async ({ manager, profile }) => {
    await manager.runWithProfile(profile, 'auto', async (context) => {
      await withTestPages(context, async (managed) => {
        const chatgpt = await managed.acquirePage({ key: 'provider:chatgpt:task:chat-a' })
        await chatgpt.setContent('<title>ChatGPT chat A</title>')

        const claude = await managed.acquirePage({ key: 'provider:claude:task:chat-b' })
        await claude.setContent('<title>Claude chat B</title>')

        assert.notEqual(claude, chatgpt)
        assert.equal(await chatgpt.title(), 'ChatGPT chat A')
        assert.equal(await claude.title(), 'Claude chat B')
        assert.equal(context.browserContext.pages().length, 2)

        const resumedChatgpt = await managed.acquirePage({ key: 'provider:chatgpt:task:chat-a' })
        assert.equal(resumedChatgpt, chatgpt)
        assert.equal(await resumedChatgpt.title(), 'ChatGPT chat A')
        assert.equal(context.browserContext.pages().length, 2)

        const forcedReplacement = await managed.acquirePage({
          key: 'provider:grok:task:chat-c',
          policy: 'replace',
        })
        assert.equal(forcedReplacement, claude)
        assert.equal(context.browserContext.pages().length, 2)

        const restoredClaude = await managed.acquirePage({ key: 'provider:claude:task:chat-b' })
        assert.notEqual(restoredClaude, forcedReplacement)
        assert.equal(context.browserContext.pages().length, 3)
      })
    })
  })
})

test('CDP headed managed browser operates on background-created automation tabs', async () => {
  await withCapabilityServer(async (origin) => {
    await withManager(async ({ manager, profile }) => {
      const managed = await manager.ensureContext(profile, 'headed')
      await withTestPages(managed, async (context) => {
        const selectedPage = await context.acquirePage({ key: 'selected-tab' })
        await selectedPage.goto(`${origin}/start`)

        const backgroundPage = await context.acquirePage({ key: 'background-tab' })
        assert.notEqual(backgroundPage, selectedPage)

        await backgroundPage.goto(`${origin}/navigated`)
        assert.equal(await backgroundPage.locator('h1').textContent(), 'Navigated')
        assert.equal(selectedPage.url(), `${origin}/start`)
      })
    })
  })
})

test('CDP readiness observations close three task-owned background tabs without touching existing pages', async () => {
  await withCapabilityServer(async (origin) => {
    await withManager(async ({ manager, profile }) => {
      const managed = await manager.ensureContext(profile, 'headed')
      await withTestPages(managed, async (context) => {
        const existing = await context.acquirePage({ key: 'readiness-existing-page' })
        await existing.goto(`${origin}/start`)
        const existingUrl = existing.url()
        const leases = []
        try {
          const results = await Promise.allSettled(Array.from({ length: 3 }, async (_, index) => (
            manager.runWithProfileObservation(profile, 'auto', async (observed) => {
              const lease = await observed.acquireTemporaryPage()
              leases.push(lease)
              await lease.page.goto(`${origin}/readiness-${index}`)
            })
          )))
          const failed = results.find((result) => result.status === 'rejected')
          if (failed?.status === 'rejected') throw failed.reason
          assert.equal(new Set(leases.map((lease) => lease.page)).size, 3)
          assert.equal(leases.every((lease) => lease.ownership === 'task-owned' && !lease.page.isClosed()), true)
          assert.equal(existing.isClosed(), false)
          assert.equal(existing.url(), existingUrl)
        } finally {
          await Promise.all(leases.map((lease) => lease.close()))
        }
        assert.equal(leases.every((lease) => lease.page.isClosed()), true)
        assert.equal(existing.isClosed(), false)
      })
    })
  })
})

test('CDP managed browser closes capability gaps at a real Chromium boundary', async () => {
  await withCapabilityServer(async (origin) => {
    await withManager(async ({ manager, profile, profileDirectory }) => {
      const upload = path.join(profileDirectory, 'capability-upload.txt')
      fs.writeFileSync(upload, 'upload-cdp\n', { mode: 0o600 })

      await manager.runWithProfile(profile, 'auto', async (context) => {
        await withTestPages(context, async (managed) => {
          await context.browserContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
          const page = await managed.acquirePage({ key: 'capability-matrix' })
          await page.goto(`${origin}/start`)

          await page.getByLabel('Message').fill('filled-cdp')
          assert.equal(await page.getByLabel('Message').inputValue(), 'filled-cdp')
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
          try {
            await popup.waitForLoadState()
            assert.equal(await popup.locator('h1').textContent(), 'Popup')
          } finally {
            await popup.close().catch((error) => {
              if (!popup.isClosed()) throw error
            })
          }

          const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.getByRole('link', { name: 'Download' }).click(),
          ])
          assert.equal(download.suggestedFilename(), 'tokenless-capability.txt')
          assert.equal(await download.failure(), null)

          const clipboardValue = 'clipboard-cdp'
          await page.evaluate(async (value) => await navigator.clipboard.writeText(value), clipboardValue)
          assert.equal(await page.evaluate(async () => await navigator.clipboard.readText()), clipboardValue)
        })
      })
    })
  })
})

async function withTestPages(context, operation) {
  const existingPages = new Map(context.browserContext.pages().map((page) => [page, page.url()]))
  const pages = new Set()
  const track = (page) => {
    pages.add(page)
    return page
  }
  const testContext = {
    ...context,
    acquirePage: async (request) => track(await context.acquirePage(request)),
    acquireReservedPage: async (request) => track(await context.acquireReservedPage(request)),
    acquireTemporaryPage: async () => {
      const lease = await context.acquireTemporaryPage()
      track(lease.page)
      return lease
    },
  }
  try {
    return await operation(testContext)
  } finally {
    const pagesToClose = [...pages].filter((page) => !existingPages.has(page))
    if (context.browserContext.pages().every((page) => pagesToClose.includes(page))) {
      await context.browserContext.newPage()
    }
    await Promise.all([...pages].map(async (page) => {
      const existingUrl = existingPages.get(page)
      if (existingUrl !== undefined) {
        if (!page.isClosed() && page.url() !== existingUrl) await page.goto(existingUrl)
        return
      }
      await page.close().catch((error) => {
        if (!page.isClosed()) throw error
      })
    }))
  }
}

async function withManager(operation) {
  const primary = await resolveConfiguredDedicatedTestTarget()
  const runtime = primary.runtime
  assert.equal(runtime.selection, 'chrome', 'Managed browser tabs require production-discovered stable Google Chrome.')
  assert.equal(runtime.runtimeId, 'system:chrome', 'Managed browser tabs require the stable Google Chrome system runtime.')
  assert.equal(runtime.family, 'system', 'Managed browser tabs must not use a managed or test browser runtime.')
  assert.equal(runtime.browserId, 'chrome', 'Managed browser tabs must not use Cloak or another browser family.')
  assert.equal(runtime.launchPolicy, 'standard', 'Managed browser tabs require the standard Chrome launch policy.')
  const manager = new PersistentContextManager({
    maxContexts: 2,
    browser: {
      id: runtime.browserId,
      executablePath: runtime.executablePath,
      runtimeId: runtime.runtimeId,
      launchPolicy: runtime.launchPolicy,
    },
  })
  const profile = primary.profile
  try {
    return await operation({
      manager,
      profile,
      profileDirectory: profile.directory,
    })
  } finally {
    await manager.detach()
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
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}
