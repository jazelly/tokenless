import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Duplex } from 'node:stream'

import { consumeBoundedLines } from './bounded-line-reader.js'
import { resolveSqliteLockTimeout } from './sqlite-lock.js'

export const CODEX_SUPERVISOR_PROTOCOL = 'tokenless.codex-supervisor.v1' as const
export const CODEX_SUPERVISOR_MAX_REQUEST_LINE_BYTES = 6 * 1024 * 1024
const MAX_CONTROL_LINE_BYTES = 4 * 1024 * 1024
const EXIT_GRACE_MS = 2_000
const MAX_OPERATION_TIMEOUT_MS = 40 * 60_000
export const CODEX_CHILD_STOP_GRACE_MS = 500
export const CODEX_GROUP_QUIESCENCE_TIMEOUT_MS = 2_000
export const CODEX_SUPERVISOR_FIXED_OVERHEAD_MS = 2_000
export const CODEX_INSPECT_CLEANUP_BUDGET_MS = (3 * CODEX_CHILD_STOP_GRACE_MS) + CODEX_GROUP_QUIESCENCE_TIMEOUT_MS
export const CODEX_INFERENCE_CLEANUP_BUDGET_MS = CODEX_INSPECT_CLEANUP_BUDGET_MS + CODEX_GROUP_QUIESCENCE_TIMEOUT_MS
const CODEX_CHILD_ENVIRONMENT = new Set([
  'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'LOGNAME', 'OS', 'PATH', 'PATHEXT',
  'PROGRAMDATA', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'USER',
  'USERNAME', 'USERPROFILE', 'WINDIR',
])

export type CodexSupervisorOperation = 'infer-managed' | 'inspect-managed' | 'inspect-profile' | 'login-managed'

export type CodexSupervisorRequest = Readonly<{
  protocol: typeof CODEX_SUPERVISOR_PROTOCOL
  nonce: string
  clientPid: number
  operation: CodexSupervisorOperation
  homeDir: string
  codexExecutable: string
  lockFiles: readonly string[]
  lockTimeoutMs: number
  operationTimeoutMs: number
  accountReadTimeoutMs?: number | undefined
  loginTimeoutMs?: number | undefined
  accountId?: string | undefined
  expectedInternalId?: string | undefined
  expectedBindingGeneration?: number | undefined
  expectedIdentityFingerprint?: string | undefined
  projectId?: string | undefined
  promptBase64?: string | undefined
  model?: string | undefined
  inferenceTimeoutMs?: number | undefined
  codexHome?: string | undefined
  identityKey?: string | undefined
  deviceAuth?: boolean | undefined
  environment: Readonly<Record<string, string>>
}>

export type CodexSupervisorRunOptions = Readonly<{
  operation: CodexSupervisorOperation
  homeDir: string
  codexExecutable: string
  lockFiles: readonly string[]
  lockTimeoutMs?: number | undefined
  operationTimeoutMs: number
  accountReadTimeoutMs?: number | undefined
  loginTimeoutMs?: number | undefined
  accountId?: string | undefined
  expectedInternalId?: string | undefined
  expectedBindingGeneration?: number | undefined
  expectedIdentityFingerprint?: string | undefined
  projectId?: string | undefined
  prompt?: string | undefined
  model?: string | undefined
  inferenceTimeoutMs?: number | undefined
  codexHome?: string | undefined
  identityKey?: Buffer | undefined
  deviceAuth?: boolean | undefined
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal | undefined
}>

export class CodexChildSupervisorError extends Error {
  readonly code: string
  readonly reason?: string | undefined
  readonly retryable: boolean
  readonly deliveryUnknown: boolean

  constructor(code: string, message: string, options: { reason?: string; retryable?: boolean; deliveryUnknown?: boolean } = {}) {
    super(message)
    this.name = 'CodexChildSupervisorError'
    this.code = code
    this.reason = options.reason
    this.retryable = options.retryable === true
    this.deliveryUnknown = options.deliveryUnknown === true
  }
}

/** Runs one complete managed operation in a detached, lock-owning helper. */
export async function runCodexSupervisedOperation<T>(options: CodexSupervisorRunOptions): Promise<T> {
  if (process.platform === 'win32') {
    throw new CodexChildSupervisorError(
      'codex_supervisor_unsupported',
      'Managed Codex child supervision currently supports macOS and Linux.',
    )
  }
  if (options.signal !== undefined && options.signal.aborted) {
    throw new CodexChildSupervisorError('codex_supervisor_aborted', 'The managed Codex operation was aborted.')
  }
  const request = await buildRequest(options)
  const { executable, modulePath } = await resolveTrustedHelperLaunch()
  if (options.signal?.aborted === true) {
    throw new CodexChildSupervisorError('codex_supervisor_aborted', 'The managed Codex operation was aborted.')
  }
  const child = spawn(executable, [modulePath], {
    detached: true,
    env: helperEnvironment(process.env),
    stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
  })
  const control = child.stdio[3] as Duplex | null
  if (control === null) {
    killUnreapedHelperGroup(child)
    throw new CodexChildSupervisorError('codex_supervisor_start_failed', 'The managed Codex helper control pipe is unavailable.')
  }
  return await superviseHelper<T>(child, control, request, options.signal)
}

export function codexSupervisorLeasePath(lockFile: string): string {
  if (typeof lockFile !== 'string' || lockFile.includes('\0') || !path.isAbsolute(lockFile)) {
    throw new CodexChildSupervisorError('codex_supervisor_invalid', 'A supervisor lock path must be absolute.')
  }
  return `${path.resolve(lockFile)}.codex-lease.json`
}

export function codexSupervisorWallTimeoutMs(lockTimeoutMs: number, operationTimeoutMs: number): number {
  return (2 * resolveSqliteLockTimeout(lockTimeoutMs)) + operationTimeoutMs + EXIT_GRACE_MS
}

export function codexInspectOperationTimeoutMs(accountReadTimeoutMs: number): number {
  return accountReadTimeoutMs + CODEX_INSPECT_CLEANUP_BUDGET_MS + CODEX_SUPERVISOR_FIXED_OVERHEAD_MS
}

export function codexInferenceOperationTimeoutMs(
  accountReadTimeoutMs: number,
  inferenceTimeoutMs: number,
): number {
  return (
    accountReadTimeoutMs +
    inferenceTimeoutMs +
    CODEX_INFERENCE_CLEANUP_BUDGET_MS +
    CODEX_SUPERVISOR_FIXED_OVERHEAD_MS
  )
}

async function buildRequest(options: CodexSupervisorRunOptions): Promise<CodexSupervisorRequest> {
  if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs <= 0 || options.operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new CodexChildSupervisorError('codex_supervisor_invalid', 'The managed Codex operation timeout is invalid.')
  }
  const lockTimeoutMs = resolveSqliteLockTimeout(options.lockTimeoutMs)
  for (const [name, value] of [
    ['account read timeout', options.accountReadTimeoutMs],
    ['login timeout', options.loginTimeoutMs],
    ['inference timeout', options.inferenceTimeoutMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 30 * 60_000)) {
      throw new CodexChildSupervisorError('codex_supervisor_invalid', `The managed Codex ${name} is invalid.`)
    }
  }
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.environment)) {
    if (value !== undefined && CODEX_CHILD_ENVIRONMENT.has(key.toUpperCase())) environment[key.toUpperCase()] = value
  }
  const request: CodexSupervisorRequest = Object.freeze({
    protocol: CODEX_SUPERVISOR_PROTOCOL,
    nonce: randomBytes(32).toString('base64url'),
    clientPid: process.pid,
    operation: options.operation,
    homeDir: path.resolve(options.homeDir),
    codexExecutable: options.codexExecutable,
    lockFiles: [...options.lockFiles],
    lockTimeoutMs,
    operationTimeoutMs: options.operationTimeoutMs,
    ...(options.accountReadTimeoutMs === undefined ? {} : { accountReadTimeoutMs: options.accountReadTimeoutMs }),
    ...(options.loginTimeoutMs === undefined ? {} : { loginTimeoutMs: options.loginTimeoutMs }),
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    ...(options.expectedInternalId === undefined ? {} : { expectedInternalId: options.expectedInternalId }),
    ...(options.expectedBindingGeneration === undefined ? {} : { expectedBindingGeneration: options.expectedBindingGeneration }),
    ...(options.expectedIdentityFingerprint === undefined ? {} : { expectedIdentityFingerprint: options.expectedIdentityFingerprint }),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.prompt === undefined ? {} : { promptBase64: Buffer.from(options.prompt, 'utf8').toString('base64') }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.inferenceTimeoutMs === undefined ? {} : { inferenceTimeoutMs: options.inferenceTimeoutMs }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.identityKey === undefined ? {} : { identityKey: options.identityKey.toString('base64') }),
    ...(options.deviceAuth === undefined ? {} : { deviceAuth: options.deviceAuth }),
    environment,
  })
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') + 1 > CODEX_SUPERVISOR_MAX_REQUEST_LINE_BYTES) {
    throw new CodexChildSupervisorError('codex_supervisor_invalid', 'The managed Codex request is oversized.')
  }
  return request
}

async function superviseHelper<T>(
  child: ChildProcess,
  control: Duplex,
  request: CodexSupervisorRequest,
  signal: AbortSignal | undefined,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let locked = false
    let dispatching = false
    let completed = false
    let result: T | undefined
    let reportedError: Error | undefined
    let settled = false
    let abortForceTimer: NodeJS.Timeout | undefined
    const wallTimeoutMs = codexSupervisorWallTimeoutMs(request.lockTimeoutMs, request.operationTimeoutMs)
    const timer = setTimeout(() => {
      sendControl(control, { protocol: CODEX_SUPERVISOR_PROTOCOL, type: 'abort', nonce: request.nonce })
      const forceTimer = setTimeout(() => killUnreapedHelperGroup(child), EXIT_GRACE_MS)
      forceTimer.unref()
    }, wallTimeoutMs)
    timer.unref()

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abortForceTimer !== undefined) clearTimeout(abortForceTimer)
      signal?.removeEventListener('abort', onAbort)
      stopLines()
      control.destroy()
      if (error !== undefined) reject(error)
      else resolve(result as T)
    }
    const onAbort = () => {
      sendControl(control, { protocol: CODEX_SUPERVISOR_PROTOCOL, type: 'abort', nonce: request.nonce })
      abortForceTimer ??= setTimeout(() => killUnreapedHelperGroup(child), EXIT_GRACE_MS)
      abortForceTimer.unref()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const stopLines = consumeBoundedLines(control, {
      maxLineBytes: MAX_CONTROL_LINE_BYTES,
      maxLines: 16,
      onLine: (line) => {
      let message: unknown
      try {
        message = JSON.parse(line) as unknown
      } catch {
        reportedError = new CodexChildSupervisorError('codex_supervisor_protocol_error', 'The managed Codex helper returned invalid control data.')
        killUnreapedHelperGroup(child)
        return
      }
      if (!isRecord(message) || message.protocol !== CODEX_SUPERVISOR_PROTOCOL || message.nonce !== request.nonce) {
        reportedError = new CodexChildSupervisorError('codex_supervisor_protocol_error', 'The managed Codex helper returned an invalid control message.')
        killUnreapedHelperGroup(child)
        return
      }
      if (message.type === 'locked' && !locked && exactKeys(message, ['nonce', 'protocol', 'type'])) {
        locked = true
      } else if (message.type === 'dispatching' && locked && !completed && exactKeys(message, ['nonce', 'protocol', 'type'])) {
        dispatching = true
      } else if (message.type === 'completed' && locked && !completed && exactKeys(message, ['nonce', 'protocol', 'result', 'type'])) {
        completed = true
        result = message.result as T
      } else if (
        message.type === 'error' && !completed &&
        exactOptionalKeys(message, ['code', 'message', 'nonce', 'protocol', 'type'], ['deliveryUnknown', 'reason', 'retryable'])
      ) {
        reportedError = reviveHelperError(message)
      } else {
        reportedError = new CodexChildSupervisorError('codex_supervisor_protocol_error', 'The managed Codex helper returned an out-of-order control message.')
        killUnreapedHelperGroup(child)
      }
      },
      onError: () => {
        reportedError ??= new CodexChildSupervisorError('codex_supervisor_protocol_error', 'The managed Codex helper control pipe failed or exceeded its frame limit.')
        killUnreapedHelperGroup(child)
      },
    })
    child.once('error', () => {
      finish(new CodexChildSupervisorError('codex_supervisor_start_failed', 'The managed Codex helper could not start.', { retryable: true }))
    })
    child.once('close', (code, exitSignal) => {
      if (completed && code === 0 && exitSignal === null && reportedError === undefined) {
        finish()
        return
      }
      finish(reportedError ?? new CodexChildSupervisorError(
        dispatching ? 'codex_supervisor_lost' : 'codex_supervisor_failed',
        'The managed Codex helper exited before completing the operation.',
        { retryable: !dispatching, deliveryUnknown: dispatching },
      ))
    })
    sendControl(control, request)
    if (signal?.aborted === true) onAbort()
  })
}

function sendControl(control: Duplex, message: unknown): void {
  if (!control.writable || control.destroyed) return
  control.write(`${JSON.stringify(message)}\n`)
}

function reviveHelperError(message: Record<string, unknown>): CodexChildSupervisorError {
  const code = typeof message.code === 'string' ? message.code : 'codex_supervisor_failed'
  const text = typeof message.message === 'string' ? message.message : 'The managed Codex operation failed.'
  return new CodexChildSupervisorError(code, text, {
    ...(typeof message.reason === 'string' ? { reason: message.reason } : {}),
    retryable: message.retryable === true,
    deliveryUnknown: message.deliveryUnknown === true,
  })
}

async function resolveTrustedHelperLaunch(): Promise<{ executable: string; modulePath: string }> {
  const executable = await trustedFile(process.execPath, true)
  const modulePath = await trustedFile(fileURLToPath(new URL('./codex-child-supervisor-helper.mjs', import.meta.url)), false)
  await assertTrustedRuntimeTree(path.resolve(path.dirname(modulePath), '..'))
  return { executable, modulePath }
}

async function assertTrustedRuntimeTree(runtimeRoot: string): Promise<void> {
  await assertTrustedDirectoryChain(runtimeRoot)
  const pending = [runtimeRoot]
  let runtimeFiles = 0
  while (pending.length > 0) {
    const directory = pending.pop()!
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      const metadata = await fs.lstat(candidate)
      if (metadata.isSymbolicLink()) {
        throw new CodexChildSupervisorError('codex_supervisor_untrusted', 'The managed Codex runtime tree contains a symbolic link.')
      }
      if (entry.isDirectory()) {
        if (!trustedMetadata(metadata)) {
          throw new CodexChildSupervisorError('codex_supervisor_untrusted', 'The managed Codex runtime tree has an untrusted directory.')
        }
        pending.push(candidate)
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        if (!metadata.isFile() || !trustedMetadata(metadata)) {
          throw new CodexChildSupervisorError('codex_supervisor_untrusted', 'The managed Codex runtime tree has an untrusted module.')
        }
        runtimeFiles += 1
      }
    }
  }
  if (runtimeFiles === 0) throw new CodexChildSupervisorError('codex_supervisor_untrusted', 'The managed Codex runtime tree is empty.')
  await trustedFile(path.resolve(runtimeRoot, '..', '..', 'package.json'), false)
}

async function trustedFile(value: string, executable: boolean): Promise<string> {
  const linked = await fs.lstat(value)
  const canonical = await fs.realpath(value)
  const metadata = await fs.stat(canonical)
  if (linked.isSymbolicLink() || !metadata.isFile() || !trustedMetadata(metadata)) {
    throw new CodexChildSupervisorError('codex_supervisor_untrusted', 'The managed Codex helper launch path is untrusted.')
  }
  if (executable) await fs.access(canonical, fs.constants.X_OK)
  await assertTrustedDirectoryChain(path.dirname(canonical))
  return canonical
}

function trustedMetadata(metadata: { uid: number; mode: number }): boolean {
  return ownedByTrustedUser(metadata.uid) && (metadata.mode & 0o022) === 0
}

async function assertTrustedDirectoryChain(start: string): Promise<void> {
  let current = start
  while (true) {
    const metadata = await fs.stat(current)
    if (!metadata.isDirectory() || !ownedByTrustedUser(metadata.uid) || (metadata.mode & 0o022) !== 0) {
      throw new CodexChildSupervisorError('codex_supervisor_untrusted', 'The managed Codex helper is inside an untrusted directory.')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function helperEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    if (environment[key] !== undefined) result[key] = environment[key]
  }
  return result
}

function killUnreapedHelperGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The detached helper group was already reaped.
  }
}

function ownedByTrustedUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === 0 || uid === process.getuid()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}
