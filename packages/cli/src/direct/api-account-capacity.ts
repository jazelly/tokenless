import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { accountPoolDirectDirectory } from './account-pool.js'
import { SqliteLockError, withSqliteLocks } from './sqlite-lock.js'
import type { DirectProvider } from './types.js'

export const DEFAULT_API_ACCOUNT_QUEUE_DEPTH = 64
export const DEFAULT_API_ACCOUNT_QUEUE_WAIT_MS = 30_000
export const MAX_API_ACCOUNT_QUEUE_DEPTH = 4_096
export const MAX_API_ACCOUNT_QUEUE_WAIT_MS = 300_000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PROVIDERS = new Set<DirectProvider>(['chatgpt', 'claude', 'gemini', 'grok', 'antigravity'])
const SLOT_POLL_INTERVAL_MS = 10
const MAX_ACCOUNT_CONCURRENCY = 128

export type ApiAccountCapacityErrorCode =
  | 'api_account_aborted'
  | 'api_account_lock_failed'
  | 'api_account_queue_full'
  | 'api_account_queue_timeout'

export class ApiAccountCapacityError extends Error {
  readonly code: ApiAccountCapacityErrorCode
  readonly retryable: boolean
  readonly deliveryUnknown = false

  constructor(code: ApiAccountCapacityErrorCode, message: string) {
    super(message)
    this.name = 'ApiAccountCapacityError'
    this.code = code
    this.retryable = code === 'api_account_queue_full' || code === 'api_account_queue_timeout'
  }
}

export type ApiAccountCapacityOptions = Readonly<{
  homeDir: string
  provider: DirectProvider
  accountInternalId: string
  maxConcurrency: number
  queueDepth?: number | undefined
  queueWaitMs?: number | undefined
  signal?: AbortSignal | undefined
}>

type QueueEntry = {
  readonly deadline: number
  readonly operation: () => Promise<unknown>
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly signal: AbortSignal | undefined
  abortListener?: (() => void) | undefined
  timer?: NodeJS.Timeout | undefined
}

type AccountScheduler = {
  active: number
  readonly key: string
  readonly maxConcurrency: number
  readonly pending: QueueEntry[]
  readonly slotFiles: readonly string[]
}

const PROCESS_ACCOUNT_SCHEDULERS = new Map<string, AccountScheduler>()
const CANONICAL_HOME_PROMISES = new Map<string, Promise<string>>()

/**
 * Runs one complete account operation under a process-local FIFO admission queue
 * and one of N cross-process SQLite writer slots. The slot remains held until the
 * supplied operation settles, so streaming response delivery is part of capacity.
 */
export async function withApiAccountCapacity<T>(
  options: ApiAccountCapacityOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const requested = normalizeOptions(options, operation)
  const normalized = {
    ...requested,
    homeDir: await canonicalHome(requested.homeDir),
  }
  const scheduler = schedulerFor(normalized)

  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry = {
      deadline: performance.now() + normalized.queueWaitMs,
      operation,
      resolve: (value) => resolve(value as T),
      reject,
      signal: normalized.signal,
    }
    if (entry.signal?.aborted === true) {
      reject(abortedError())
      return
    }
    if (scheduler.active < scheduler.maxConcurrency && scheduler.pending.length === 0) {
      startEntry(scheduler, entry)
      return
    }
    if (scheduler.pending.length >= normalized.queueDepth) {
      reject(new ApiAccountCapacityError(
        'api_account_queue_full',
        'The selected API account queue is full; its project binding was not changed.',
      ))
      return
    }

    const onAbort = () => removePendingEntry(scheduler, entry, abortedError())
    entry.abortListener = onAbort
    entry.signal?.addEventListener('abort', onAbort, { once: true })
    entry.timer = setTimeout(() => {
      removePendingEntry(scheduler, entry, queueTimeoutError())
    }, normalized.queueWaitMs)
    entry.timer.unref()
    scheduler.pending.push(entry)
  })
}

async function canonicalHome(homeDir: string): Promise<string> {
  let pending = CANONICAL_HOME_PROMISES.get(homeDir)
  if (pending === undefined) {
    pending = fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
      .then(() => fs.realpath(homeDir))
      .catch(() => {
        throw lockFailureError()
      })
    CANONICAL_HOME_PROMISES.set(homeDir, pending)
  }
  try {
    return await pending
  } catch (error) {
    if (CANONICAL_HOME_PROMISES.get(homeDir) === pending) {
      CANONICAL_HOME_PROMISES.delete(homeDir)
    }
    throw error
  }
}

export function apiAccountCapacitySlotPath(
  homeDir: string,
  provider: DirectProvider,
  accountInternalId: string,
  slot: number,
): string {
  const normalized = normalizeIdentity(homeDir, provider, accountInternalId)
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= MAX_ACCOUNT_CONCURRENCY) {
    throw lockFailureError()
  }
  return path.join(
    accountPoolDirectDirectory(normalized.homeDir),
    'api-account-slots',
    normalized.provider,
    normalized.accountInternalId,
    `${slot}.lock`,
  )
}

function normalizeOptions(options: ApiAccountCapacityOptions, operation: () => Promise<unknown>) {
  if (options === null || typeof options !== 'object' || typeof operation !== 'function') {
    throw lockFailureError()
  }
  const identity = normalizeIdentity(options.homeDir, options.provider, options.accountInternalId)
  const maxConcurrency = boundedInteger(options.maxConcurrency, 1, MAX_ACCOUNT_CONCURRENCY)
  const queueDepth = boundedInteger(
    options.queueDepth ?? DEFAULT_API_ACCOUNT_QUEUE_DEPTH,
    0,
    MAX_API_ACCOUNT_QUEUE_DEPTH,
  )
  const queueWaitMs = boundedInteger(
    options.queueWaitMs ?? DEFAULT_API_ACCOUNT_QUEUE_WAIT_MS,
    0,
    MAX_API_ACCOUNT_QUEUE_WAIT_MS,
  )
  return { ...identity, maxConcurrency, queueDepth, queueWaitMs, signal: options.signal }
}

function normalizeIdentity(
  homeDir: string,
  provider: DirectProvider,
  accountInternalId: string,
) {
  if (typeof homeDir !== 'string' || homeDir.includes('\0') || !path.isAbsolute(homeDir)) {
    throw lockFailureError()
  }
  if (!PROVIDERS.has(provider)) throw lockFailureError()
  if (typeof accountInternalId !== 'string' || !UUID_PATTERN.test(accountInternalId)) {
    throw lockFailureError()
  }
  return {
    homeDir: path.resolve(homeDir),
    provider,
    accountInternalId,
  }
}

function schedulerFor(options: ReturnType<typeof normalizeOptions>): AccountScheduler {
  const key = `${options.homeDir}\0${options.provider}\0${options.accountInternalId}`
  const existing = PROCESS_ACCOUNT_SCHEDULERS.get(key)
  if (existing !== undefined) {
    if (existing.maxConcurrency !== options.maxConcurrency) throw lockFailureError()
    return existing
  }
  const scheduler: AccountScheduler = {
    active: 0,
    key,
    maxConcurrency: options.maxConcurrency,
    pending: [],
    slotFiles: Array.from(
      { length: options.maxConcurrency },
      (_, slot) => apiAccountCapacitySlotPath(
        options.homeDir,
        options.provider,
        options.accountInternalId,
        slot,
      ),
    ),
  }
  PROCESS_ACCOUNT_SCHEDULERS.set(key, scheduler)
  return scheduler
}

function startEntry(scheduler: AccountScheduler, entry: QueueEntry): void {
  cleanupEntryWait(entry)
  scheduler.active += 1
  void acquireCrossProcessSlot(scheduler.slotFiles, entry)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      scheduler.active -= 1
      startPendingEntries(scheduler)
      if (scheduler.active === 0 && scheduler.pending.length === 0) {
        PROCESS_ACCOUNT_SCHEDULERS.delete(scheduler.key)
      }
    })
}

function startPendingEntries(scheduler: AccountScheduler): void {
  while (scheduler.active < scheduler.maxConcurrency && scheduler.pending.length > 0) {
    const entry = scheduler.pending.shift()!
    if (entry.signal?.aborted === true) {
      cleanupEntryWait(entry)
      entry.reject(abortedError())
      continue
    }
    if (performance.now() >= entry.deadline) {
      cleanupEntryWait(entry)
      entry.reject(queueTimeoutError())
      continue
    }
    startEntry(scheduler, entry)
  }
}

async function acquireCrossProcessSlot(
  slotFiles: readonly string[],
  entry: QueueEntry,
): Promise<unknown> {
  let offset = 0
  let firstPass = true
  while (true) {
    if (entry.signal?.aborted === true) throw abortedError()
    for (let index = 0; index < slotFiles.length; index += 1) {
      const slotFile = slotFiles[(offset + index) % slotFiles.length]!
      let entered = false
      try {
        return await withSqliteLocks(
          { lockFiles: [slotFile], timeoutMs: 0, signal: entry.signal },
          async () => {
            entered = true
            return entry.operation()
          },
        )
      } catch (error) {
        if (entered) throw error
        if (!(error instanceof SqliteLockError)) throw lockFailureError()
        if (error.code === 'sqlite_lock_aborted') throw abortedError()
        if (error.code !== 'sqlite_lock_timeout') throw lockFailureError()
      }
    }
    if (!firstPass && performance.now() >= entry.deadline) throw queueTimeoutError()
    firstPass = false
    const remaining = entry.deadline - performance.now()
    if (remaining <= 0) throw queueTimeoutError()
    await waitForSlot(Math.min(SLOT_POLL_INTERVAL_MS, remaining), entry.signal)
    offset = (offset + 1) % slotFiles.length
  }
}

function removePendingEntry(
  scheduler: AccountScheduler,
  entry: QueueEntry,
  error: ApiAccountCapacityError,
): void {
  const index = scheduler.pending.indexOf(entry)
  if (index < 0) return
  scheduler.pending.splice(index, 1)
  cleanupEntryWait(entry)
  entry.reject(error)
  startPendingEntries(scheduler)
  if (scheduler.active === 0 && scheduler.pending.length === 0) {
    PROCESS_ACCOUNT_SCHEDULERS.delete(scheduler.key)
  }
}

function cleanupEntryWait(entry: QueueEntry): void {
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  entry.timer = undefined
  if (entry.abortListener !== undefined) {
    entry.signal?.removeEventListener('abort', entry.abortListener)
  }
  entry.abortListener = undefined
}

function waitForSlot(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: ApiAccountCapacityError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = () => finish(abortedError())
    const timer = setTimeout(() => finish(), Math.max(0, Math.ceil(delayMs)))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) onAbort()
  })
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw lockFailureError()
  }
  return value
}

function abortedError(): ApiAccountCapacityError {
  return new ApiAccountCapacityError(
    'api_account_aborted',
    'The selected API account request was aborted; its project binding was not changed.',
  )
}

function queueTimeoutError(): ApiAccountCapacityError {
  return new ApiAccountCapacityError(
    'api_account_queue_timeout',
    'The selected API account stayed busy past the queue deadline; its project binding was not changed.',
  )
}

function lockFailureError(): ApiAccountCapacityError {
  return new ApiAccountCapacityError(
    'api_account_lock_failed',
    'The selected API account capacity lock failed; its project binding was not changed.',
  )
}
