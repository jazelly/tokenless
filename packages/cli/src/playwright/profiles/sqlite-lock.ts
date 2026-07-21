import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { tokenlessError } from '../errors.js'
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'

const SQLITE_BUSY = 5
const LOCK_RETRY_INTERVAL_MS = 10
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000

type HeldSqliteLock = {
  database: SqliteDatabase
}

let sqliteModulePromise: Promise<typeof import('node:sqlite')> | undefined

export async function withPrivateSqliteWriterLock<T>(
  lockFile: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  if (typeof lockFile !== 'string' || lockFile.includes('\u0000') || !isAbsolute(lockFile)) {
    throw tokenlessError('sqlite_lock_failed', 'SQLite lock file must be an absolute path without NUL bytes.')
  }
  const timeoutMs = resolveLockTimeout(options.timeoutMs)
  const file = await preparePrivateLockFile(lockFile)
  const deadline = performance.now() + timeoutMs
  const held = await acquireSqliteLock(file, deadline, options.signal)
  let hasPrimaryError = false
  try {
    if (options.signal?.aborted) throw tokenlessError('sqlite_lock_aborted', 'SQLite lock operation was aborted.')
    return await operation()
  } catch (error) {
    hasPrimaryError = true
    throw error
  } finally {
    const releaseError = releaseSqliteLock(held)
    if (!hasPrimaryError && releaseError) throw releaseError
  }
}

function resolveLockTimeout(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw tokenlessError('sqlite_lock_failed', `SQLite lock timeout must be an integer between 0 and ${MAX_TIMEOUT_MS}.`)
  }
  return timeoutMs
}

async function preparePrivateLockFile(input: string) {
  const parent = resolve(dirname(input))
  await ensurePrivateDirectory(parent)
  const canonicalParent = await realpath(parent)
  if (canonicalParent !== parent) {
    throw tokenlessError('sqlite_lock_failed', 'The SQLite lock parent cannot contain path aliases or symbolic links.')
  }
  const file = resolve(input)
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    try {
      handle = await open(file, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600)
      if (process.platform !== 'win32') await handle.chmod(0o600)
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      await validatePrivateLockFile(file)
      handle = await open(file, fsConstants.O_RDWR | noFollow)
    }
    const opened = await handle.stat()
    const linked = await lstat(file)
    assertPrivateFile(opened)
    assertPrivateFile(linked)
    if (opened.dev !== linked.dev || opened.ino !== linked.ino) {
      throw tokenlessError('sqlite_lock_failed', 'The SQLite lock path changed while it was opened.')
    }
  } catch (error) {
    if (isTokenlessError(error)) throw error
    throw tokenlessError('sqlite_lock_failed', 'Cannot create or validate a private SQLite lock file.', { cause: error })
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return file
}

async function ensurePrivateDirectory(directory: string) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    const metadata = await lstat(directory)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw tokenlessError('sqlite_lock_failed', 'The SQLite lock parent must be a real directory.')
    }
    assertCurrentUser(metadata)
    if (process.platform !== 'win32' && (metadata.mode & 0o7777) !== 0o700) {
      throw tokenlessError('sqlite_lock_failed', 'The SQLite lock parent must have mode 0700.')
    }
  } catch (error) {
    if (isTokenlessError(error)) throw error
    throw tokenlessError('sqlite_lock_failed', 'Cannot create or validate the private SQLite lock directory.', { cause: error })
  }
}

async function validatePrivateLockFile(file: string) {
  try {
    assertPrivateFile(await lstat(file))
  } catch (error) {
    if (isTokenlessError(error)) throw error
    throw tokenlessError('sqlite_lock_failed', 'Cannot inspect the SQLite lock file.', { cause: error })
  }
}

async function acquireSqliteLock(file: string, deadline: number, signal: AbortSignal | undefined): Promise<HeldSqliteLock> {
  let database: SqliteDatabase | undefined
  try {
    const { DatabaseSync } = await loadSqliteModule()
    database = new DatabaseSync(file)
    await validatePrivateLockFile(file)
    database.exec('PRAGMA busy_timeout = 0')
    let firstAttempt = true
    while (true) {
      if (signal?.aborted) throw tokenlessError('sqlite_lock_aborted', 'SQLite lock operation was aborted while waiting.')
      if (!firstAttempt && performance.now() >= deadline) throw tokenlessError('sqlite_lock_timeout', 'Timed out waiting for a Tokenless SQLite lock.', { retryable: true })
      firstAttempt = false
      try {
        database.exec('BEGIN IMMEDIATE')
        return { database }
      } catch (error) {
        if (!isSqliteBusy(error)) {
          throw tokenlessError('sqlite_lock_failed', 'Cannot acquire a SQLite writer lock.', { cause: error })
        }
      }
      const remainingMs = deadline - performance.now()
      if (remainingMs <= 0) throw tokenlessError('sqlite_lock_timeout', 'Timed out waiting for a Tokenless SQLite lock.', { retryable: true })
      await waitForRetry(Math.min(LOCK_RETRY_INTERVAL_MS, remainingMs), signal)
    }
  } catch (error) {
    try {
      database?.close()
    } catch {
      // Preserve the acquisition error.
    }
    throw error
  }
}

function loadSqliteModule(): Promise<typeof import('node:sqlite')> {
  sqliteModulePromise ??= import('node:sqlite')
  return sqliteModulePromise
}

function releaseSqliteLock(held: HeldSqliteLock) {
  try {
    held.database.exec('ROLLBACK')
  } catch (error) {
    try {
      held.database.close()
    } catch {
      // The rollback failure is more actionable.
    }
    return tokenlessError('sqlite_lock_failed', 'Cannot roll back a SQLite lock transaction.', { cause: error })
  }
  try {
    held.database.close()
  } catch (error) {
    return tokenlessError('sqlite_lock_failed', 'Cannot close a SQLite lock database.', { cause: error })
  }
  return undefined
}

function assertPrivateFile(metadata: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number; uid: number; mode: number }) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw tokenlessError('sqlite_lock_failed', 'The SQLite lock must be a regular non-symlink file.')
  }
  if (Number(metadata.nlink) !== 1) {
    throw tokenlessError('sqlite_lock_failed', 'The SQLite lock file must not have hard links.')
  }
  assertCurrentUser(metadata)
  if (process.platform !== 'win32' && (metadata.mode & 0o7777) !== 0o600) {
    throw tokenlessError('sqlite_lock_failed', 'The SQLite lock file must have mode 0600.')
  }
}

function assertCurrentUser(metadata: { uid: number }) {
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw tokenlessError('sqlite_lock_failed', 'The SQLite lock path must be owned by the current user.')
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolvePromise()
    }
    const onAbort = () => finish(tokenlessError('sqlite_lock_aborted', 'SQLite lock operation was aborted while waiting.'))
    const timer = setTimeout(() => finish(), Math.max(0, Math.ceil(delayMs)))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function isSqliteBusy(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'errcode' in error && error.errcode === SQLITE_BUSY)
}

function isErrno(error: unknown, code: string) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function isTokenlessError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'TokenlessPlaywrightError')
}
