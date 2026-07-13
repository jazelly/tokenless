import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

const LOCK_HANDSHAKE = 'tokenless.native-lock.v1\n'
const LOCK_DIAGNOSTIC_BYTES = 16 * 1024
export const DEFAULT_NATIVE_LOCK_TIMEOUT_MS = 30_000
export const MAX_NATIVE_LOCK_TIMEOUT_MS = 300_000

const LOCK_GUARD_SOURCE = [
  `const marker=${JSON.stringify(LOCK_HANDSHAKE)}`,
  'let released=false',
  'const release=()=>{if(released)return;released=true;process.exit(0)}',
  "process.stdin.once('end',release)",
  "process.stdin.once('error',()=>process.exit(1))",
  'process.stdin.resume()',
  'process.stdout.write(marker)',
].join(';')

export type NativeLockErrorCode =
  | 'native_lock_aborted'
  | 'native_lock_failed'
  | 'native_lock_lost'
  | 'native_lock_timeout'

export class NativeLockError extends Error {
  readonly code: NativeLockErrorCode
  readonly retryable: boolean

  constructor(code: NativeLockErrorCode, message: string) {
    super(message)
    this.name = 'NativeLockError'
    this.code = code
    this.retryable = code === 'native_lock_timeout'
  }
}

export type WithNativeLocksOptions = Readonly<{
  runner: string
  lockFiles: readonly string[]
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}>

/** Holds a sorted set of native advisory locks for one in-process operation. */
export async function withNativeLocks<T>(
  options: WithNativeLocksOptions,
  operation: () => Promise<T>,
): Promise<T> {
  if (options === null || typeof options !== 'object' || typeof operation !== 'function') {
    throw lockFailure('Native lock options and an operation are required.')
  }
  if (options.signal?.aborted === true) {
    throw new NativeLockError('native_lock_aborted', 'The native lock operation was aborted before dispatch.')
  }
  const runner = requireAbsolutePath(options.runner, 'Native lock runner')
  const lockFiles = [...new Set(options.lockFiles.map((file) => requireAbsolutePath(file, 'Native lock file')))]
  if (lockFiles.length === 0 || lockFiles.length !== options.lockFiles.length || lockFiles.length > 16) {
    throw lockFailure('Native lock operations require 1-16 unique absolute lock files.')
  }
  const timeoutMs = resolveNativeLockTimeout(options.timeoutMs)
  const child = spawn(
    runner,
    [
      ...lockFiles.flatMap((file) => ['--lock', file]),
      '--timeout-ms',
      String(timeoutMs),
      '--',
      process.execPath,
      '-e',
      LOCK_GUARD_SOURCE,
    ],
    {
      detached: process.platform !== 'win32',
      env: lockGuardEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  let operationError: unknown
  try {
    await waitForLockHandshake(child, timeoutMs, options.signal)
    return await operation()
  } catch (error) {
    operationError = error
    throw error
  } finally {
    const releaseError = await releaseLockGuard(child)
    if (operationError === undefined && releaseError !== undefined) throw releaseError
  }
}

export function resolveNativeLockTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_NATIVE_LOCK_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_NATIVE_LOCK_TIMEOUT_MS) {
    throw lockFailure(`Native lock timeout must be an integer between 0 and ${MAX_NATIVE_LOCK_TIMEOUT_MS}.`)
  }
  return timeoutMs
}

function waitForLockHandshake(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const timer = setTimeout(
      () => finish(lockFailure('The native lock handshake timed out.')),
      Math.min(MAX_NATIVE_LOCK_TIMEOUT_MS + 5_000, timeoutMs + 5_000),
    )
    timer.unref()

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = () => {
      terminateLockGuard(child)
      finish(new NativeLockError('native_lock_aborted', 'The native lock wait was aborted.'))
    }
    const onError = () => finish(lockFailure('The native lock runner could not start.'))
    const onExit = (code: number | null) => finish(new NativeLockError(
      code === 75 ? 'native_lock_timeout' : 'native_lock_failed',
      code === 75
        ? 'Timed out waiting for the Tokenless advisory lock.'
        : 'The native lock runner exited before acquiring its locks.',
    ))
    const onStdout = (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk)
      const expected = Buffer.from(LOCK_HANDSHAKE)
      if (stdout.length > expected.length || !expected.subarray(0, stdout.length).equals(stdout)) {
        finish(lockFailure('The native lock runner returned an invalid handshake.'))
        return
      }
      if (stdout.length === expected.length) finish()
    }
    const onStderr = (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
      if (stderr.length >= LOCK_DIAGNOSTIC_BYTES) {
        finish(lockFailure('The native lock runner returned oversized diagnostics.'))
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', onError)
    child.once('exit', onExit)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
  })
}

async function releaseLockGuard(child: ChildProcessWithoutNullStreams): Promise<Error | undefined> {
  if (child.pid === undefined) return lockFailure('The native lock runner did not start.')
  if (child.exitCode !== null || child.signalCode !== null) {
    return new NativeLockError('native_lock_lost', 'The native advisory lock was lost before the operation completed.')
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  child.stdin.end()
  let timedOut = false
  const releaseTimer = setTimeout(() => {
    timedOut = true
    terminateLockGuard(child)
  }, 2_000)
  releaseTimer.unref()
  const result = await exited
  clearTimeout(releaseTimer)
  if (timedOut) return lockFailure('The native lock runner did not release within its cleanup budget.')
  if (result.code === 0) return undefined
  return lockFailure('The native lock runner did not release cleanly.')
}

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  if (current.length >= LOCK_DIAGNOSTIC_BYTES) return current
  return Buffer.concat([current, chunk.subarray(0, LOCK_DIAGNOSTIC_BYTES - current.length)])
}

function terminateLockGuard(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 2_000,
      windowsHide: true,
    })
    if (result.error !== undefined || result.status !== 0) child.kill('SIGKILL')
    return
  }
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall through when the process group has already exited.
    }
  }
  child.kill('SIGKILL')
}

function lockGuardEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'OS',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'WINDIR',
  ])
  return Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())),
  )
}

function requireAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) {
    throw lockFailure(`${name} must be an absolute path without NUL bytes.`)
  }
  return path.resolve(value)
}

function lockFailure(message: string): NativeLockError {
  return new NativeLockError('native_lock_failed', message)
}
