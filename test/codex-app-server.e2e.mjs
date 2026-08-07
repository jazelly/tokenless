import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const harnessModule = '../packages/web-agent-harness/dist/src/index.js'

test('Harness resolves a persisted Codex thread and session tree through the real App Server', async () => {
  const codex = resolveCodexExecutable()
  const codexHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tokenless-real-codex-home-'))
  try {
    const client = createAppServerClient(codex, codexHome)
    try {
      await client.request('initialize', {
        clientInfo: {
          name: 'tokenless_e2e',
          title: 'Tokenless App Server E2E',
          version: '0.1.0',
        },
      })
      client.notify('initialized', {})
      const started = await client.request('thread/start', {
        cwd: root,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: false,
        sessionStartSource: 'startup',
      })
      assert.equal(typeof started.thread.id, 'string')
      assert.equal(started.thread.sessionId, started.thread.id)
      await client.request('thread/inject_items', {
        threadId: started.thread.id,
        items: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Tokenless App Server E2E context.' }],
        }],
      })
      await client.close()

      const { readCodexThreadFromAppServer } = await import(harnessModule)
      const resolved = await readCodexThreadFromAppServer({
        threadId: started.thread.id,
        codexHome,
        timeoutMs: 5_000,
      })
      assert.equal(resolved.id, started.thread.id)
      assert.equal(resolved.sessionId, started.thread.sessionId)
      assert.equal(resolved.cwd, root)
      assert.equal(resolved.parentThreadId, null)
    } finally {
      await client.close()
    }
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
})

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
  let closed = false
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
      if (closed) return
      closed = true
      child.stdin.end()
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}
