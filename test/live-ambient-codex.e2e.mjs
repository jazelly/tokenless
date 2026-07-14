import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const LIVE_MODEL = 'gpt-5.3-codex-spark'
const enabled = process.env.TOKENLESS_LIVE_AMBIENT_CODEX === '1'
const requestedCommandTimeoutMs = Number(process.env.TOKENLESS_LIVE_AMBIENT_CODEX_TIMEOUT_MS || 240_000)
const requestedTestTimeoutMs = process.env.TOKENLESS_LIVE_AMBIENT_CODEX_TEST_TIMEOUT_MS === undefined
  ? Math.max(
      300_000,
      Number.isSafeInteger(requestedCommandTimeoutMs) ? requestedCommandTimeoutMs + 30_000 : 300_000,
    )
  : Number(process.env.TOKENLESS_LIVE_AMBIENT_CODEX_TEST_TIMEOUT_MS)
const testHarnessTimeoutMs = Number.isSafeInteger(requestedTestTimeoutMs) && requestedTestTimeoutMs > 0
  ? requestedTestTimeoutMs
  : 300_000

test('live ambient Codex uses the exact approved Spark model through the official client', {
  skip: enabled ? false : 'set TOKENLESS_LIVE_AMBIENT_CODEX=1 to spend one ChatGPT subscription request',
  timeout: testHarnessTimeoutMs,
}, async () => {
  assert.equal(
    process.env.TOKENLESS_LIVE_AMBIENT_CODEX_CONFIRM,
    'I_ACCEPT_SUBSCRIPTION_USAGE',
    'Set TOKENLESS_LIVE_AMBIENT_CODEX_CONFIRM=I_ACCEPT_SUBSCRIPTION_USAGE to authorize this live subscription request.',
  )
  const marker = `TOKENLESS_LIVE_AMBIENT_CODEX_OK_${Date.now()}`
  const timeoutMs = requestedCommandTimeoutMs
  assert.equal(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000, true)
  assert.equal(
    Number.isSafeInteger(requestedTestTimeoutMs) && requestedTestTimeoutMs > timeoutMs,
    true,
    'The live ambient Codex test timeout must be an integer greater than its command timeout.',
  )

  const result = await run(process.execPath, [
    cliEntry,
    'run',
    '--mode', 'direct',
    '--direct-backend', 'official-client',
    '--provider', 'chatgpt',
    '--model', LIVE_MODEL,
    '--timeout-ms', String(timeoutMs),
    '--prompt', `Reply with exactly this text and nothing else: ${marker}`,
    '--json',
  ], {
    cwd: root,
    env: process.env,
    timeoutMs,
  })

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.protocol, 'tokenless.direct.v1')
  assert.equal(payload.mode, 'direct')
  assert.equal(payload.backend, 'official-client')
  assert.equal(payload.transport, 'official-codex')
  assert.equal(payload.provider, 'chatgpt')
  assert.equal(payload.model, LIVE_MODEL)
  assert.match(payload.text, new RegExp(marker))
})

function run(command, arguments_, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let terminalError
    let forceKillTimer
    const maxOutputBytes = 2 * 1_024 * 1_024
    const terminate = (error) => {
      if (terminalError) return
      terminalError = error
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      forceKillTimer.unref()
    }
    const timeout = setTimeout(() => {
      terminate(new Error(`Live ambient Codex CLI exceeded its ${timeoutMs} ms deadline.`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const collect = (target) => (chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > maxOutputBytes) {
        terminate(new Error('Live ambient Codex CLI output exceeded 2 MiB.'))
        return
      }
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.once('error', (error) => {
      clearTimeout(timeout)
      clearTimeout(forceKillTimer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      clearTimeout(forceKillTimer)
      if (terminalError) reject(terminalError)
      else resolve({ code, signal, stdout, stderr })
    })
  })
}
