import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const enabled = process.env.TOKENLESS_LIVE_DIRECT === '1'

test('live direct public API returns a normalized result', {
  skip: enabled ? false : 'set TOKENLESS_LIVE_DIRECT=1 and the documented provider variables to spend a live API request',
  timeout: Number(process.env.TOKENLESS_LIVE_DIRECT_TEST_TIMEOUT_MS || 240_000),
}, async () => {
  const provider = requiredEnvironment('TOKENLESS_LIVE_DIRECT_PROVIDER')
  const model = requiredEnvironment('TOKENLESS_LIVE_DIRECT_MODEL')
  assert.equal(['chatgpt', 'claude', 'gemini', 'grok', 'antigravity'].includes(provider), true)
  const marker = `TOKENLESS_LIVE_DIRECT_OK_${Date.now()}`
  const prompt = process.env.TOKENLESS_LIVE_DIRECT_PROMPT || `Reply with exactly this text and nothing else: ${marker}`
  const arguments_ = [
    cliEntry,
    'run',
    '--mode', 'direct',
    '--direct-backend', 'api',
    '--provider', provider,
    '--model', model,
    '--prompt', prompt,
    '--json',
  ]
  if (process.env.TOKENLESS_LIVE_DIRECT_BASE_URL) {
    arguments_.push('--direct-base-url', process.env.TOKENLESS_LIVE_DIRECT_BASE_URL)
  }

  const result = await run(process.execPath, arguments_, {
    env: process.env,
    timeoutMs: Number(process.env.TOKENLESS_LIVE_DIRECT_TIMEOUT_MS || 180_000),
  })
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.protocol, 'tokenless.direct.v1')
  assert.equal(payload.mode, 'direct')
  assert.equal(payload.backend, 'api')
  assert.equal(payload.transport, 'direct-api')
  assert.equal(payload.provider, provider)
  assert.equal(typeof payload.text, 'string')
  assert.notEqual(payload.text.trim(), '')
  if (process.env.TOKENLESS_LIVE_DIRECT_PROMPT === undefined) assert.match(payload.text, new RegExp(marker))
})

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  assert.ok(value, `${name} is required when TOKENLESS_LIVE_DIRECT=1.`)
  return value
}

function run(command, arguments_, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let terminalError
    const maxOutputBytes = 2 * 1_024 * 1_024
    const timeout = setTimeout(() => {
      terminalError = new Error(`Live direct CLI exceeded its ${timeoutMs} ms deadline.`)
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const collect = (target) => (chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > maxOutputBytes) {
        terminalError = new Error('Live direct CLI output exceeded 2 MiB.')
        child.kill('SIGTERM')
        return
      }
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (terminalError) reject(terminalError)
      else resolve({ code, signal, stdout, stderr })
    })
  })
}
