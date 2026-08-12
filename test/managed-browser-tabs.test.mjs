import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  PersistentContextManager,
} from '../packages/cli/dist/src/playwright/index.js'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'

test('CDP production launch allows configured Chromium executables to use native credential storage', async () => {
  await withManager(async ({ manager, profile }) => {
    const managed = await manager.ensureContext(profile, 'auto')
    const baselinePages = managed.browserContext.pages()
    const baselineVersionPages = baselinePages.filter((page) => page.url() === 'chrome://version/').length
    const temporary = await managed.acquireTemporaryPage()
    try {
      await temporary.page.goto('chrome://version')
      const commandLine = await temporary.page.locator('#command_line').textContent()
      assert.doesNotMatch(commandLine ?? '', /(?:^|\s)--password-store=basic(?:\s|$)/u)
      assert.doesNotMatch(commandLine ?? '', /(?:^|\s)--use-mock-keychain(?:\s|$)/u)
    } finally {
      await temporary.close()
    }
    const remainingPages = managed.browserContext.pages()
    assert.equal(remainingPages.length, baselinePages.length)
    assert.equal(
      remainingPages.filter((page) => page.url() === 'chrome://version/').length,
      baselineVersionPages,
    )
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

test('CDP provider Page Refs reuse stable live bindings without sharing independent work', async () => {
  await withManager(async ({ manager, profile }) => {
    const context = await manager.ensureContext(profile, 'auto')
    const pageRefA = `page:test:a:${randomUUID()}`
    const pageRefB = `page:test:b:${randomUUID()}`
    const pageRefC = `page:test:c:${randomUUID()}`

    const first = await context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefA })
    assert.equal(first.reused, false)
    await assert.rejects(
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefA }),
      (error) => error?.code === 'managed_provider_page_busy',
    )
    await first.release()

    const continued = await context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefA })
    assert.equal(continued.page, first.page)
    assert.equal(continued.reused, true)
    await continued.release()

    const independent = await context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefB })
    assert.notEqual(independent.page, first.page)
    await independent.release()

    const independentContinued = await context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefB })
    assert.equal(independentContinued.page, independent.page)
    assert.equal(independentContinued.reused, true)
    await independentContinued.release()

    const concurrentFirstAcquires = await Promise.allSettled([
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefC }),
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefC }),
    ])
    const acquired = concurrentFirstAcquires.filter((result) => result.status === 'fulfilled')
    const rejected = concurrentFirstAcquires.filter((result) => result.status === 'rejected')
    assert.equal(acquired.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason?.code, 'managed_provider_page_busy')
    await acquired[0].value.release()

    const replaced = await context.acquireProviderPage({
      provider: 'chatgpt',
      pageRef: pageRefA,
      policy: 'replace',
    })
    assert.notEqual(replaced.page, first.page)
    assert.equal(replaced.reused, false)
    assert.equal(first.page.isClosed(), true)
    await replaced.release()
  })
})

test('CDP detach removes released blank provider pages before their runtime bindings are lost', async () => {
  const primary = await resolveConfiguredBrowserTarget()
  const marker = `tokenless-detach-cleanup-${randomUUID()}`
  const manager = createManager(primary.runtime)
  let baselinePageCount
  try {
    const context = await manager.ensureContext(primary.profile, 'auto')
    baselinePageCount = context.browserContext.pages().length
    for (const suffix of ['a', 'b']) {
      const lease = await context.acquireProviderPage({
        provider: 'chatgpt',
        pageRef: `page:test:detach:${suffix}:${randomUUID()}`,
      })
      await lease.page.evaluate((title) => { document.title = title }, `${marker}-${suffix}`)
      await lease.release()
    }
  } finally {
    await manager.detach()
  }

  const observer = createManager(primary.runtime)
  try {
    const reconnected = await observer.ensureContext(primary.profile, 'auto')
    const pages = reconnected.browserContext.pages()
    const titles = await Promise.all(pages.map((page) => page.title().catch(() => '')))
    assert.equal(titles.some((title) => title.startsWith(marker)), false)
    assert.ok(pages.length <= Math.max(1, baselinePageCount))
  } finally {
    await observer.detach()
  }
})

async function withManager(operation) {
  const primary = await resolveConfiguredBrowserTarget()
  const manager = createManager(primary.runtime)
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

function createManager(runtime) {
  return new PersistentContextManager({
    maxContexts: 2,
    browser: {
      id: runtime.browserId,
      executablePath: runtime.executablePath,
      runtimeId: runtime.runtimeId,
      launchPolicy: runtime.launchPolicy,
    },
  })
}
