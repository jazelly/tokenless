import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  PersistentContextManager,
} from '../packages/server/dist/src/browser/index.js'
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

test('CDP provider Page Refs allow concurrent callers without sharing independent work', async () => {
  await withManager(async ({ manager, profile }) => {
    const context = await manager.ensureContext(profile, 'auto')
    const pageRefA = `page:test:a:${randomUUID()}`
    const pageRefB = `page:test:b:${randomUUID()}`
    const pageRefC = `page:test:c:${randomUUID()}`

    const first = await context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefA })
    assert.equal(first.reused, false)
    const sameRef = await Promise.all([
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefA }),
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefA }),
    ])
    assert.equal(sameRef[0].page, first.page)
    assert.equal(sameRef[1].page, first.page)
    assert.equal(sameRef[0].reused, true)
    assert.equal(sameRef[1].reused, true)

    const continued = await context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefA })
    assert.equal(continued.page, first.page)
    assert.equal(continued.reused, true)

    const [independent, independentConcurrent] = await Promise.all([
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefB }),
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefC }),
    ])
    assert.notEqual(independent.page, first.page)
    assert.notEqual(independentConcurrent.page, first.page)
    assert.notEqual(independentConcurrent.page, independent.page)

    const sharedNewRef = `page:test:shared-new:${randomUUID()}`
    const sharedNewPages = await Promise.all([
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: sharedNewRef }),
      context.acquireProviderPage({ provider: 'chatgpt', pageRef: sharedNewRef }),
    ])
    assert.equal(sharedNewPages[0].page, sharedNewPages[1].page)
    assert.notEqual(sharedNewPages[0].page, independent.page)

    const independentContinued = await context.acquireProviderPage({ provider: 'chatgpt', pageRef: pageRefB })
    assert.equal(independentContinued.page, independent.page)
    assert.equal(independentContinued.reused, true)

    const replaced = await context.acquireProviderPage({
      provider: 'chatgpt',
      pageRef: pageRefA,
      policy: 'replace',
    })
    assert.notEqual(replaced.page, first.page)
    assert.equal(replaced.reused, false)
    assert.equal(first.page.isClosed(), true)
  })
})

test('CDP profile operations overlap without a profile execution lane', async () => {
  await withManager(async ({ manager, profile }) => {
    await manager.ensureContext(profile, 'auto')
    let entered = 0
    let active = 0
    let maximumActive = 0
    let resolveSecondEntry
    const secondEntry = new Promise((resolve) => { resolveSecondEntry = resolve })
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    const operation = async (context) => {
      entered += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (entered === 2) resolveSecondEntry()
      await gate
      active -= 1
      return context.browserContext
    }
    const first = manager.runWithProfile(profile, 'auto', operation)
    const second = manager.runWithProfile(profile, 'auto', operation)
    let overlapError
    let timeout
    try {
      await Promise.race([
        secondEntry,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out waiting for concurrent profile operations.')), 2_000)
        }),
      ])
    } catch (error) {
      overlapError = error
    } finally {
      clearTimeout(timeout)
      releaseGate()
    }
    const [firstContext, secondContext] = await Promise.all([first, second])
    if (overlapError) throw overlapError
    assert.equal(entered, 2)
    assert.equal(maximumActive, 2)
    assert.equal(firstContext, secondContext)
  })
})

test('CDP detach preserves provider tabs while runtime bindings are rebuilt', async () => {
  const primary = await resolveConfiguredBrowserTarget()
  const marker = `tokenless-detach-preserve-${randomUUID()}`
  const pageRef = `page:test:detach:${randomUUID()}`
  const manager = createManager(primary.runtime)
  try {
    const context = await manager.ensureContext(primary.profile, 'auto')
    const providerPage = await context.acquireProviderPage({ provider: 'chatgpt', pageRef })
    await providerPage.page.evaluate((title) => { document.title = title }, marker)
  } finally {
    await manager.detach()
  }

  const observer = createManager(primary.runtime)
  try {
    const reconnected = await observer.ensureContext(primary.profile, 'auto')
    const pages = reconnected.browserContext.pages()
    const titles = await Promise.all(pages.map((page) => page.title().catch(() => '')))
    assert.equal(titles.includes(marker), true)
    const rebound = await reconnected.acquireProviderPage({
      provider: 'chatgpt',
      pageRef,
      matchesExistingPage: (page) => page.url() === 'about:blank',
      isAvailablePage: async (page) => (await page.title().catch(() => '')) === marker,
    })
    assert.equal(await rebound.page.title(), marker)
    const continued = await reconnected.acquireProviderPage({ provider: 'chatgpt', pageRef })
    assert.equal(continued.page, rebound.page)
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
