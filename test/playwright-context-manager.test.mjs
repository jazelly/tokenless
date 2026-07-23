import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  PersistentContextManager,
  TokenlessPlaywrightError,
  chromeLaunchOptions,
  managedBrowserLaunchOptions,
  normalizeBrowserVisibility,
} from '../packages/cli/dist/src/playwright/index.js'

test('persistent context manager serializes same-profile work and launches Chrome persistently', async () => {
  const launches = []
  const manager = new PersistentContextManager({
    launcher: async (userDataDir, options) => {
      launches.push({ userDataDir, options })
      return new FakeContext()
    },
  })
  const profile = { id: 'profile-a', directory: '/tmp/profile-a' }
  const events = []

  await Promise.all([
    manager.runWithProfile(profile, async () => {
      events.push('a-start')
      await delay(20)
      events.push('a-end')
    }),
    manager.runWithProfile(profile, async () => {
      events.push('b-start')
      events.push('b-end')
    }),
  ])

  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end'])
  assert.equal(launches.length, 1)
  assert.equal(launches[0].options.channel, 'chrome')
  assert.equal(launches[0].options.headless, false)
  assert.ok(launches[0].options.args.includes('--disable-sync'))
  await manager.shutdown()
})

test('persistent context manager caps active profiles at four and shuts down deterministically', async () => {
  const closed = []
  const manager = new PersistentContextManager({
    launcher: async (userDataDir) => new FakeContext(() => closed.push(userDataDir)),
  })
  for (let index = 0; index < 4; index += 1) {
    await manager.ensureContext({ id: `profile-${index}`, directory: `/tmp/profile-${index}` })
  }
  await assert.rejects(
    () => manager.ensureContext({ id: 'profile-4', directory: '/tmp/profile-4' }),
    matchCode('playwright_context_limit_reached')
  )
  assert.deepEqual(manager.activeProfileIds(), ['profile-0', 'profile-1', 'profile-2', 'profile-3'])
  await manager.shutdown()
  assert.equal(closed.length, 4)
  assert.deepEqual(manager.activeProfileIds(), [])
})

test('persistent context manager deduplicates concurrent direct launches for one profile', async () => {
  let launches = 0
  const manager = new PersistentContextManager({
    launcher: async () => {
      launches += 1
      await delay(20)
      return new FakeContext()
    },
  })
  const profile = { id: 'profile-a', directory: '/tmp/profile-a' }

  const contexts = await Promise.all(Array.from({ length: 8 }, () => manager.ensureContext(profile)))

  assert.equal(launches, 1)
  assert.equal(new Set(contexts.map((context) => context.browserContext)).size, 1)
  assert.deepEqual(manager.activeProfileIds(), ['profile-a'])
  await manager.shutdown()
})

test('persistent context manager enforces maxContexts under concurrent direct launches', async () => {
  let launches = 0
  const manager = new PersistentContextManager({
    maxContexts: 2,
    launcher: async () => {
      launches += 1
      await delay(20)
      return new FakeContext()
    },
  })

  const results = await Promise.allSettled([
    manager.ensureContext({ id: 'profile-a', directory: '/tmp/profile-a' }),
    manager.ensureContext({ id: 'profile-b', directory: '/tmp/profile-b' }),
    manager.ensureContext({ id: 'profile-c', directory: '/tmp/profile-c' }),
  ])

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(launches, 2)
  assert.deepEqual(manager.activeProfileIds(), ['profile-a', 'profile-b'])
  assert.equal(results[2].status, 'rejected')
  assert.equal(results[2].reason.code, 'playwright_context_limit_reached')
  await manager.shutdown()
})

test('persistent context manager reports browser closure as retryable and relaunches later', async () => {
  let launches = 0
  const manager = new PersistentContextManager({
    launcher: async () => {
      launches += 1
      return new FakeContext()
    },
  })
  const profile = { id: 'profile-a', directory: '/tmp/profile-a' }
  await assert.rejects(
    () => manager.runWithProfile(profile, async () => {
      throw new Error('browser has been closed')
    }),
    (error) => error instanceof TokenlessPlaywrightError && error.code === 'playwright_browser_closed' && error.retryable
  )
  await manager.runWithProfile(profile, async () => undefined)
  assert.equal(launches, 2)
  await manager.shutdown()
})

test('persistent context manager relaunches one profile when effective visibility changes', async () => {
  const closed = []
  const launches = []
  const manager = new PersistentContextManager({
    launcher: async (userDataDir, options) => {
      const context = new FakeContext(() => closed.push(`${userDataDir}:${options.headless ? 'headless' : 'headed'}`))
      launches.push({ userDataDir, options, context })
      return context
    },
  })
  const profile = { id: 'profile-a', directory: '/tmp/profile-a' }

  const auto = await manager.ensureContext(profile, 'auto')
  const headed = await manager.switchProfileVisibility(profile, 'headed')
  const headless = await manager.switchProfileVisibility(profile, 'headless')

  assert.notEqual(auto.browserContext, headed.browserContext)
  assert.notEqual(headed.browserContext, headless.browserContext)
  assert.equal(auto.browserVisibility, 'auto')
  assert.equal(auto.effectiveBrowserVisibility, 'headless')
  assert.equal(headed.effectiveBrowserVisibility, 'headed')
  assert.equal(headless.browserVisibility, 'headless')
  assert.equal(headless.effectiveBrowserVisibility, 'headless')
  assert.deepEqual(launches.map((launch) => launch.options.headless), [true, false, true])
  assert.deepEqual(launches.map((launch) => launch.options.chromiumSandbox), [true, true, true])
  assert.deepEqual(closed, ['/tmp/profile-a:headless', '/tmp/profile-a:headed'])
  assert.deepEqual(manager.activeProfileIds(), ['profile-a'])
  await manager.shutdown()
})

test('persistent context manager accepts per-run visibility while preserving legacy call shape', async () => {
  const launches = []
  const manager = new PersistentContextManager({
    launcher: async (_userDataDir, options) => {
      launches.push(options)
      return new FakeContext()
    },
  })
  const profile = { id: 'profile-a', directory: '/tmp/profile-a' }
  const observed = []

  await manager.runWithProfile(profile, async (context) => {
    observed.push(context.effectiveBrowserVisibility)
  })
  await manager.runWithProfile(profile, 'headless', async (context) => {
    observed.push(context.effectiveBrowserVisibility)
  })

  assert.deepEqual(observed, ['headed', 'headless'])
  assert.deepEqual(launches.map((options) => options.headless), [false, true])
  await manager.shutdown()
})

test('persistent context manager scheduled profile close is idle and context identity safe', async () => {
  const timers = new FakeTimers()
  const contexts = []
  const manager = new PersistentContextManager({
    timers,
    launcher: async () => {
      const context = new FakeContext()
      contexts.push(context)
      return context
    },
  })
  const profile = { id: 'profile-a', directory: '/tmp/profile-a' }

  const headed = await manager.ensureContext(profile, 'headed')
  manager.scheduleCloseProfile(profile.id, { delayMs: 30_000, browserContext: headed.browserContext })
  await manager.runWithProfile(profile, 'headed', async () => undefined)
  await timers.advance(30_000)
  assert.deepEqual(manager.activeProfileIds(), ['profile-a'])
  assert.equal(contexts[0].closed, false)

  manager.scheduleCloseProfile(profile.id, { delayMs: 30_000, browserContext: headed.browserContext })
  const headless = await manager.switchProfileVisibility(profile, 'headless')
  await timers.advance(30_000)
  assert.deepEqual(manager.activeProfileIds(), ['profile-a'])
  assert.equal(contexts[0].closed, true)
  assert.equal(contexts[1].closed, false)

  manager.scheduleCloseProfile(profile.id, { delayMs: 30_000, browserContext: headed.browserContext })
  await timers.advance(30_000)
  assert.deepEqual(manager.activeProfileIds(), ['profile-a'])
  assert.equal(contexts[1].closed, false)

  manager.scheduleCloseProfile(profile.id, { delayMs: 30_000, browserContext: headless.browserContext })
  await timers.advance(29_999)
  assert.deepEqual(manager.activeProfileIds(), ['profile-a'])
  await timers.advance(1)
  assert.deepEqual(manager.activeProfileIds(), [])
  assert.equal(contexts[1].closed, true)
})

test('Chrome launch options preserve imported OS credential state without exposing remote debugging', () => {
  const options = chromeLaunchOptions()
  assert.equal(options.channel, 'chrome')
  assert.equal(options.headless, false)
  assert.equal(options.chromiumSandbox, true)
  assert.deepEqual(options.ignoreDefaultArgs, [
    '--password-store=basic',
    '--use-mock-keychain',
  ])
  assert.equal(options.args.some((arg) => /remote-debugging/i.test(arg)), false)
})

test('headless launch options keep Chromium sandbox enabled', () => {
  const options = managedBrowserLaunchOptions({ id: 'chrome' }, 'headless')
  assert.equal(options.channel, 'chrome')
  assert.equal(options.headless, true)
  assert.equal(options.chromiumSandbox, true)
  assert.equal(options.args.some((arg) => /no-sandbox/i.test(arg)), false)
})

test('auto launch options use fresh headless mode with Chromium sandbox enabled', () => {
  const options = managedBrowserLaunchOptions({ id: 'chrome' }, 'auto')
  assert.equal(options.channel, 'chrome')
  assert.equal(options.headless, true)
  assert.equal(options.chromiumSandbox, true)
})

test('managed Brave launch uses the selected executable with the same visible persistent safety options', () => {
  const options = managedBrowserLaunchOptions({ id: 'brave', executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })
  assert.equal(options.channel, undefined)
  assert.equal(options.executablePath, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')
  assert.equal(options.headless, false)
  assert.equal(options.chromiumSandbox, true)
  assert.ok(options.args.includes('--disable-sync'))
  assert.equal(options.args.some((arg) => /remote-debugging/i.test(arg)), false)
})

test('browser visibility normalization accepts only public visibility policies', () => {
  assert.equal(normalizeBrowserVisibility(' AUTO '), 'auto')
  assert.equal(normalizeBrowserVisibility('headed'), 'headed')
  assert.equal(normalizeBrowserVisibility('headless'), 'headless')
  assert.equal(normalizeBrowserVisibility('hidden'), null)
})

class FakeContext extends EventEmitter {
  #pages = []
  #onClose

  constructor(onClose = () => undefined) {
    super()
    this.#onClose = onClose
    this.closed = false
  }

  pages() {
    return this.#pages
  }

  async newPage() {
    const page = {}
    this.#pages.push(page)
    return page
  }

  async close() {
    this.closed = true
    this.#onClose()
    this.emit('close')
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function matchCode(code) {
  return (error) => error instanceof TokenlessPlaywrightError && error.code === code
}

class FakeTimers {
  constructor() {
    this.now = 0
    this.timers = []
  }

  setTimeout(callback, ms) {
    const timer = {
      dueAt: this.now + ms,
      callback,
      cleared: false,
    }
    this.timers.push(timer)
    return timer
  }

  clearTimeout(timer) {
    timer.cleared = true
  }

  async advance(ms) {
    this.now += ms
    while (true) {
      const due = this.timers
        .filter((timer) => !timer.cleared && timer.dueAt <= this.now)
        .sort((left, right) => left.dueAt - right.dueAt)[0]
      if (!due) return
      due.cleared = true
      due.callback()
      await Promise.resolve()
    }
  }
}
