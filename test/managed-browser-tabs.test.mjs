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

async function withManager(connectionMode, operation) {
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `tokenless-${connectionMode}-capabilities-`))
  const manager = new PersistentContextManager({
    connectionMode,
    browser: {
      id: 'profile',
      executablePath: chromium.executablePath(),
    },
  })
  const profile = { id: 'default', directory: profileDirectory, lifecycle: 'ready' }
  try {
    return await operation({ manager, profile, profileDirectory })
  } finally {
    await manager.shutdown()
    fs.rmSync(profileDirectory, { recursive: true, force: true })
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
