import { spawn } from 'node:child_process'

import type { CodexAppServerThread } from './agent-contracts.js'

const DEFAULT_TIMEOUT_MS = 1_500
const MAX_LINE_BYTES = 2 * 1024 * 1024

export async function readCodexThreadFromAppServer({
  threadId,
  codexHome,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  threadId: string
  codexHome: string
  timeoutMs?: number | undefined
}): Promise<CodexAppServerThread> {
  const executable = process.env.TOKENLESS_CODEX_EXECUTABLE || 'codex'
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdoutBuffer = ''
  let stderrBytes = 0
  let initialized = false
  let settled = false

  return await new Promise<CodexAppServerThread>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Codex App Server thread/read timed out.')), timeoutMs)

    const finish = (error: Error | null, value?: CodexAppServerThread) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(value!)
    }

    child.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`Codex App Server exited before thread/read completed (${String(code)}).`))
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > MAX_LINE_BYTES) finish(new Error('Codex App Server stderr exceeded the bounded diagnostic limit.'))
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_LINE_BYTES) {
        finish(new Error('Codex App Server response exceeded the bounded response limit.'))
        return
      }
      while (stdoutBuffer.includes('\n')) {
        const newline = stdoutBuffer.indexOf('\n')
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (!line) continue
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          finish(new Error('Codex App Server returned invalid JSONL.'))
          return
        }
        const record = jsonRecord(message)
        if (!record) continue
        if (record.id === 1) {
          if (record.error) {
            finish(new Error('Codex App Server initialization failed.'))
            return
          }
          initialized = true
          writeMessage(child, { method: 'initialized', params: {} })
          writeMessage(child, {
            method: 'thread/read',
            id: 2,
            params: { threadId, includeTurns: false },
          })
          continue
        }
        if (record.id !== 2 || !initialized) continue
        if (record.error) {
          const appServerError = jsonRecord(record.error)
          const code = appServerError?.code === undefined ? 'unknown' : String(appServerError.code)
          const message = typeof appServerError?.message === 'string'
            ? appServerError.message.slice(0, 500)
            : 'unknown error'
          finish(new Error(`Codex App Server could not read the current thread (${code}: ${message}).`))
          return
        }
        try {
          finish(null, validateThread(record.result, threadId))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })

    writeMessage(child, {
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'tokenless',
          title: 'Tokenless Agent Context Resolver',
          version: '0.1.0',
        },
        capabilities: {
          optOutNotificationMethods: [],
        },
      },
    })
  })
}

function writeMessage(child: ReturnType<typeof spawn>, message: unknown) {
  const stdin = child.stdin
  if (!stdin?.writable) throw new Error('Codex App Server stdin is not writable.')
  stdin.write(`${JSON.stringify(message)}\n`)
}

function validateThread(value: unknown, expectedId: string): CodexAppServerThread {
  const result = jsonRecord(value)
  const thread = jsonRecord(result?.thread)
  if (
    !thread ||
    thread.id !== expectedId ||
    typeof thread.sessionId !== 'string' ||
    typeof thread.cwd !== 'string'
  ) {
    throw new Error('Codex App Server returned an invalid thread/read response.')
  }
  return {
    id: thread.id,
    sessionId: thread.sessionId,
    parentThreadId: nullableString(thread.parentThreadId),
    forkedFromId: nullableString(thread.forkedFromId),
    cwd: thread.cwd,
    source: thread.source ?? null,
    gitInfo: thread.gitInfo ?? null,
  }
}

function nullableString(value: unknown) {
  return typeof value === 'string' && value ? value : null
}

function jsonRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null
}
