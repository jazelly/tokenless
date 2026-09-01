import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const harnessModule = '../packages/harness/dist/src/index.js'
const model = 'gpt-5.6-luna'
const reasoningEffort = 'xhigh'
const gracefulCloseTimeoutMs = 500

test('Harness resolves real Codex threads across workspaces, chats, and a fork without a model request', async () => {
  const codex = resolveCodexExecutable()
  const fixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tokenless-real-codex-matrix-'))
  const codexHome = path.join(fixtureRoot, 'codex-home')
  const projectOne = path.join(fixtureRoot, 'project-one')
  const projectTwo = path.join(fixtureRoot, 'project-two')
  fs.mkdirSync(codexHome)
  fs.mkdirSync(projectOne)
  fs.mkdirSync(projectTwo)
  try {
    const client = createAppServerClient(codex, codexHome)
    try {
      await client.request('initialize', {
        clientInfo: {
          name: 'tokenless_e2e',
          title: 'Tokenless App Server E2E',
          version: '0.1.0',
        },
        capabilities: {
          optOutNotificationMethods: [],
        },
      })
      client.notify('initialized', {})
      const chatA = await startThread(client, projectOne)
      const chatB = await startThread(client, projectOne)
      const chatC = await startThread(client, projectTwo)
      const rootChats = [chatA, chatB, chatC]
      for (const chat of rootChats) {
        await client.request('thread/inject_items', {
          threadId: chat.thread.id,
          items: [{
            type: 'message',
            role: 'assistant',
            content: [],
          }],
        })
      }
      const forkA = await client.request('thread/fork', {
        ...threadConfiguration(projectOne),
        threadId: chatA.thread.id,
      })

      const allChats = [...rootChats, forkA]
      assert.equal(new Set(allChats.map(({ thread }) => thread.id)).size, allChats.length)
      assert.equal(chatA.cwd, projectOne)
      assert.equal(chatB.cwd, projectOne)
      assert.equal(chatC.cwd, projectTwo)
      assert.notEqual(chatA.cwd, chatC.cwd)
      for (const chat of rootChats) {
        assertConfiguredThread(chat)
        assert.equal(chat.thread.sessionId, chat.thread.id)
        assert.equal(chat.thread.parentThreadId, null)
        assert.equal(chat.thread.forkedFromId, null)
      }
      assertConfiguredThread(forkA)
      assert.equal(forkA.cwd, projectOne)
      assert.equal(forkA.thread.sessionId, forkA.thread.id)
      assert.notEqual(forkA.thread.sessionId, chatA.thread.sessionId)
      assert.equal(forkA.thread.parentThreadId, null)
      assert.equal(forkA.thread.forkedFromId, chatA.thread.id)

      const expectedThreads = [
        expectedThread(chatA, projectOne),
        expectedThread(chatB, projectOne),
        expectedThread(chatC, projectTwo),
        expectedThread(forkA, projectOne),
      ]
      for (const expected of expectedThreads) {
        const read = await client.request('thread/read', {
          threadId: expected.id,
          includeTurns: false,
        })
        assertThreadMetadata(read.thread, expected)
        assert.deepEqual(read.thread.turns, [])
      }
      await client.close()

      const { readCodexThreadFromAppServer } = await import(harnessModule)
      for (const expected of expectedThreads) {
        const resolved = await readCodexThreadFromAppServer({
          threadId: expected.id,
          codexHome,
          timeoutMs: 5_000,
        })
        assertThreadMetadata(resolved, expected)
      }
    } finally {
      await client.close()
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
    assert.equal(fs.existsSync(fixtureRoot), false)
  }
})

function startThread(client, cwd) {
  return client.request('thread/start', threadConfiguration(cwd))
}

function threadConfiguration(cwd) {
  return {
    model,
    cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: { model_reasoning_effort: reasoningEffort },
    ephemeral: false,
    sessionStartSource: 'startup',
  }
}

function assertConfiguredThread(response) {
  assert.equal(typeof response.thread.id, 'string')
  assert.equal(response.model, model)
  assert.equal(response.reasoningEffort, reasoningEffort)
  assert.equal(response.thread.cwd, response.cwd)
}

function expectedThread(response, cwd) {
  return {
    id: response.thread.id,
    sessionId: response.thread.sessionId,
    parentThreadId: response.thread.parentThreadId,
    forkedFromId: response.thread.forkedFromId,
    cwd,
  }
}

function assertThreadMetadata(thread, expected) {
  assert.equal(thread.id, expected.id)
  assert.equal(thread.sessionId, expected.sessionId)
  assert.equal(thread.parentThreadId, expected.parentThreadId)
  assert.equal(thread.forkedFromId, expected.forkedFromId)
  assert.equal(thread.cwd, expected.cwd)
}

function resolveCodexExecutable() {
  const candidate = process.env.TOKENLESS_CODEX_EXECUTABLE || 'codex'
  const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || `Cannot execute ${candidate}`)
  return candidate
}

function createAppServerClient(executable, codexHome) {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  let nextId = 1
  let buffer = ''
  let processClosed = false
  let closePromise
  const pending = new Map()
  const diagnostics = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => diagnostics.push(chunk))
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n')
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.id === undefined) continue
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }
  })
  child.on('exit', (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`Codex App Server exited ${String(code)}. ${diagnostics.join('')}`))
    }
    pending.clear()
  })
  child.on('close', () => {
    processClosed = true
  })
  return {
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timed out waiting for ${method}. ${diagnostics.join('')}`))
        }, 10_000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`)
    },
    async close() {
      if (closePromise) return closePromise
      if (processClosed) return
      closePromise = new Promise((resolve) => {
        let forceCloseTimer
        child.once('close', () => {
          clearTimeout(forceCloseTimer)
          resolve()
        })
        child.stdin.end()
        if (!processClosed) {
          forceCloseTimer = setTimeout(() => {
            if (!processClosed) child.kill()
          }, gracefulCloseTimeoutMs)
        }
      })
      return closePromise
    },
  }
}
