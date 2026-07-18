import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  PersistentContextManager,
  TokenlessPlaywrightError,
  chromeLaunchOptions,
} from '../packages/playwright/dist/src/index.js'

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

test('Chrome launch options preserve imported OS credential state without exposing remote debugging', () => {
  const options = chromeLaunchOptions()
  assert.equal(options.channel, 'chrome')
  assert.equal(options.headless, false)
  assert.deepEqual(options.ignoreDefaultArgs, [
    '--password-store=basic',
    '--use-mock-keychain',
  ])
  assert.equal(options.args.some((arg) => /remote-debugging/i.test(arg)), false)
})

class FakeContext extends EventEmitter {
  #pages = []
  #onClose

  constructor(onClose = () => undefined) {
    super()
    this.#onClose = onClose
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
