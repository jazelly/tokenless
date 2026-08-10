import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PersistentContextManager,
} from '../packages/cli/dist/src/playwright/index.js'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'

test('CDP production launch allows configured Chromium executables to use native credential storage', async () => {
  await withManager(async ({ manager, profile }) => {
    const managed = await manager.ensureContext(profile, 'auto')
    const page = await managed.acquirePage({ key: 'browser-command-line' })
    await page.goto('chrome://version')
    const commandLine = await page.locator('#command_line').textContent()
    assert.doesNotMatch(commandLine ?? '', /(?:^|\s)--password-store=basic(?:\s|$)/u)
    assert.doesNotMatch(commandLine ?? '', /(?:^|\s)--use-mock-keychain(?:\s|$)/u)
  })
})

test('CDP managed browser reuses one persistent browser for one selected profile', async () => {
  await withManager(async ({ manager, profile }) => {
    const first = await manager.ensureContext(profile, 'auto')
    const second = await manager.ensureContext(profile, 'auto')

    assert.equal(second.browserContext, first.browserContext)
    assert.equal(second.browserContext.browser(), first.browserContext.browser())

    const firstPage = await first.acquirePage({ key: 'provider:chatgpt:task:first' })
    const secondPage = await second.acquirePage({ key: 'provider:gemini:task:second' })
    assert.notEqual(secondPage, firstPage)
  })
})

test('CDP profile open reuses an existing headed dashboard context', async () => {
  await withManager(async ({ manager, profile }) => {
    const first = await manager.ensureContext(profile, 'headed')
    const dashboard = await first.acquireReservedPage({ key: 'tokenless:control-plane:profile-open-regression' })
    await dashboard.evaluate(() => { document.title = 'Tokenless dashboard' })

    const reopened = await manager.ensureContext(profile, 'headed')

    assert.equal(reopened.browserContext, first.browserContext)
    assert.equal(reopened.browserContext.browser(), first.browserContext.browser())
    assert.equal(dashboard.isClosed(), false)
    assert.equal(await dashboard.title(), 'Tokenless dashboard')
  })
})

test('CDP managed browser preserves independent logical tabs in one profile', async () => {
  await withManager(async ({ manager, profile }) => {
    await manager.runWithProfile(profile, 'auto', async (context) => {
      const chatgpt = await context.acquirePage({ key: 'provider:chatgpt:task:chat-a' })
      await chatgpt.evaluate(() => { document.title = 'ChatGPT chat A' })

      const claude = await context.acquirePage({ key: 'provider:claude:task:chat-b' })
      await claude.evaluate(() => { document.title = 'Claude chat B' })

      assert.notEqual(claude, chatgpt)
      assert.equal(await chatgpt.title(), 'ChatGPT chat A')
      assert.equal(await claude.title(), 'Claude chat B')

      const resumedChatgpt = await context.acquirePage({ key: 'provider:chatgpt:task:chat-a' })
      assert.equal(resumedChatgpt, chatgpt)
      assert.equal(await resumedChatgpt.title(), 'ChatGPT chat A')

      const forcedReplacement = await context.acquirePage({
        key: 'provider:grok:task:chat-c',
        policy: 'replace',
      })
      assert.equal(forcedReplacement, claude)

      const restoredClaude = await context.acquirePage({ key: 'provider:claude:task:chat-b' })
      assert.notEqual(restoredClaude, forcedReplacement)
    })
  })
})

test('CDP provider soft leases reuse released tabs without sharing concurrent work', async () => {
  await withManager(async ({ manager, profile }) => {
    const context = await manager.ensureContext(profile, 'auto')
    const first = await context.acquireProviderPage({ provider: 'chatgpt', taskKey: 'task:first' })
    const generic = await context.acquirePage({ key: 'provider:generic:task:claim-guard' })
    const reserved = await context.acquireReservedPage({ key: 'tokenless:control-plane:provider-lease-guard' })
    assert.notEqual(generic, first.page)
    assert.notEqual(reserved, first.page)
    await first.release()

    const [reused, concurrent] = await Promise.all([
      context.acquireProviderPage({ provider: 'chatgpt', taskKey: 'task:second' }),
      context.acquireProviderPage({ provider: 'chatgpt', taskKey: 'task:third' }),
    ])
    assert.equal(reused.page, first.page)
    assert.notEqual(concurrent.page, reused.page)

    await reused.release()
    await concurrent.release()

    const replacement = await context.acquireProviderPage({
      provider: 'chatgpt',
      taskKey: 'task:second',
      policy: 'replace',
    })
    assert.equal(replacement.page, concurrent.page)
    await replacement.release()
  })
})

async function withManager(operation) {
  const primary = await resolveConfiguredBrowserTarget()
  const runtime = primary.runtime
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
    })
  } finally {
    await manager.detach()
  }
}
