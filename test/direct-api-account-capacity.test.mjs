import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const directModuleRootPath = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)
  : fileURLToPath(new URL('../packages/cli/dist/src/direct/', import.meta.url))
const directModuleRoot = pathToFileURL(`${directModuleRootPath}${path.sep}`)
const { withApiAccountCapacity } = await import(new URL('api-account-capacity.js', directModuleRoot))

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000111'

test('API account capacity starts local work FIFO up to maxConcurrency', async () => {
  await withTemporaryHome(async (homeDir) => {
    const started = []
    const releases = []
    let active = 0
    let maximumActive = 0
    const tasks = Array.from({ length: 4 }, (_, index) => withApiAccountCapacity({
      homeDir,
      provider: 'chatgpt',
      accountInternalId: ACCOUNT_ID,
      maxConcurrency: 2,
      queueDepth: 4,
      queueWaitMs: 2_000,
    }, async () => {
      started.push(index)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => releases[index] = resolve)
      active -= 1
      return index
    }))

    await waitFor(() => started.length === 2)
    assert.deepEqual([...started].sort(), [0, 1])
    releases[0]()
    await waitFor(() => started.length === 3)
    assert.equal(started[2], 2)
    releases[1]()
    await waitFor(() => started.length === 4)
    assert.equal(started[3], 3)
    releases[2]()
    releases[3]()
    assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3])
    assert.equal(maximumActive, 2)
  })
})

test('API account busy queue is bounded and times out without dispatch', async () => {
  await withTemporaryHome(async (homeDir) => {
    let release
    let dispatches = 0
    const holding = withApiAccountCapacity({
      homeDir,
      provider: 'claude',
      accountInternalId: ACCOUNT_ID,
      maxConcurrency: 1,
      queueDepth: 1,
      queueWaitMs: 2_000,
    }, async () => {
      dispatches += 1
      await new Promise((resolve) => release = resolve)
    })
    await waitFor(() => dispatches === 1)

    const queued = withApiAccountCapacity({
      homeDir,
      provider: 'claude',
      accountInternalId: ACCOUNT_ID,
      maxConcurrency: 1,
      queueDepth: 1,
      queueWaitMs: 30,
    }, async () => {
      dispatches += 1
    })
    await assert.rejects(
      withApiAccountCapacity({
        homeDir,
        provider: 'claude',
        accountInternalId: ACCOUNT_ID,
        maxConcurrency: 1,
        queueDepth: 1,
        queueWaitMs: 2_000,
      }, async () => {
        dispatches += 1
      }),
      hasCode('api_account_queue_full'),
    )
    await assert.rejects(queued, hasCode('api_account_queue_timeout'))
    assert.equal(dispatches, 1)
    release()
    await holding
  })
})

test('SQLite slots enforce fixed maxConcurrency across broker processes', async () => {
  await withTemporaryHome(async (homeDir) => {
    const children = []
    try {
      const first = startCapacityChild(homeDir, 2)
      children.push(first)
      await first.waitForLine('acquired')
      const second = startCapacityChild(homeDir, 2)
      children.push(second)
      await second.waitForLine('acquired')
      const third = startCapacityChild(homeDir, 2)
      children.push(third)

      await assert.rejects(
        third.waitForLine('acquired', 150),
        hasCode('line_timeout'),
      )
      first.child.stdin.end('release\n')
      await first.waitForLine('released')
      await first.waitForExit()
      await third.waitForLine('acquired', 2_000)
      second.child.stdin.end('release\n')
      third.child.stdin.end('release\n')
      await Promise.all([
        second.waitForLine('released'),
        third.waitForLine('released'),
      ])
      await Promise.all([second.waitForExit(), third.waitForExit()])
    } finally {
      for (const item of children) item.child.kill('SIGKILL')
    }
  })
})

function startCapacityChild(homeDir, maxConcurrency) {
  const helper = fileURLToPath(new URL('./helpers/api-capacity-child.mjs', import.meta.url))
  const child = spawn(process.execPath, [
    helper,
    directModuleRootPath,
    homeDir,
    'gemini',
    ACCOUNT_ID,
    String(maxConcurrency),
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []
  const waiters = []
  let buffered = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    while (buffered.includes('\n')) {
      const index = buffered.indexOf('\n')
      lines.push(buffered.slice(0, index))
      buffered = buffered.slice(index + 1)
    }
    flushWaiters()
  })
  child.stderr.on('data', (chunk) => stderr += chunk)

  const flushWaiters = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (!lines.includes(waiter.expected)) continue
      waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }
  return {
    child,
    waitForLine(expected, timeoutMs = 2_000) {
      if (lines.includes(expected)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const waiter = { expected, resolve, reject, timer: undefined }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          const error = new Error(`Timed out waiting for ${expected}; stderr=${stderr}`)
          error.code = 'line_timeout'
          reject(error)
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    waitForExit() {
      if (child.exitCode !== null) {
        assert.equal(child.exitCode, 0, stderr)
        return Promise.resolve()
      }
      return new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => {
          try {
            assert.equal(code, 0, stderr)
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })
    },
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for capacity state.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function hasCode(code) {
  return (error) => error?.code === code
}

async function withTemporaryHome(run) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-api-capacity-'))
  try {
    await run(homeDir)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
}
