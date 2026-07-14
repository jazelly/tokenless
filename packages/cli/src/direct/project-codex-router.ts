import path from 'node:path'

import {
  AccountPoolError,
  AccountPoolStore,
  type CodexAccountRecord,
  type ProjectBinding,
} from './account-pool.js'
import { createSqliteAccountPoolSerialization } from './account-pool-lock.js'
import type { ManagedResponsesRequest } from './managed-responses.js'

export const DEFAULT_MANAGED_PROJECT_QUEUE_DEPTH = 128
export const MAX_MANAGED_PROJECT_QUEUE_DEPTH = 1_024
export const DEFAULT_MANAGED_PROJECT_QUEUE_WAIT_MS = 5 * 60_000
export const MAX_MANAGED_PROJECT_QUEUE_WAIT_MS = 30 * 60_000
const MAX_MANAGED_FAILOVER_ATTEMPTS = 128

const PROJECT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?$/

export type ManagedProjectExecution = Readonly<{
  homeDir: string
  projectId: string
  initialBinding: ProjectBinding
  initialAccount: CodexAccountRecord
  request: ManagedResponsesRequest
  signal: AbortSignal
}>

export type ManagedProjectRequestLoader = (signal: AbortSignal) => Promise<ManagedResponsesRequest>

/**
 * The production executor must re-resolve and verify identity while holding the
 * durable account and global inference locks through provider-child completion.
 * initialBinding and initialAccount are advisory snapshots, not authorization.
 */
export type ManagedProjectExecutor = (execution: ManagedProjectExecution) => Promise<string>

export type ProjectCodexRouterOptions = Readonly<{
  homeDir: string
  executor: ManagedProjectExecutor
  accountPoolLockTimeoutMs?: number | undefined
  maxQueuedRequests?: number | undefined
  queueWaitTimeoutMs?: number | undefined
}>

export type ManagedProjectExecutorErrorCode =
  | 'managed_executor_aborted'
  | 'managed_executor_failed'
  | 'managed_executor_timeout'
  | 'managed_executor_unavailable'

export class ManagedProjectExecutorError extends Error {
  readonly code: ManagedProjectExecutorErrorCode
  readonly retryable: boolean
  readonly deliveryUnknown: boolean

  constructor(
    code: ManagedProjectExecutorErrorCode,
    message: string,
    options: Readonly<{ retryable?: boolean; deliveryUnknown: boolean }>,
  ) {
    super(message)
    this.name = 'ManagedProjectExecutorError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.deliveryUnknown = options.deliveryUnknown
  }
}

export type ProjectCodexRouterErrorCode =
  | 'managed_project_aborted'
  | 'managed_project_binding_missing'
  | 'managed_project_binding_unavailable'
  | 'managed_project_execution_failed'
  | 'managed_project_queue_full'
  | 'managed_project_queue_timeout'

export class ProjectCodexRouterError extends Error {
  readonly code: ProjectCodexRouterErrorCode
  readonly retryable: boolean
  readonly deliveryUnknown: boolean
  readonly executorCode?: ManagedProjectExecutorErrorCode | undefined

  constructor(
    code: ProjectCodexRouterErrorCode,
    message: string,
    retryable = false,
    deliveryUnknown = false,
    executorCode?: ManagedProjectExecutorErrorCode,
  ) {
    super(message)
    this.name = 'ProjectCodexRouterError'
    this.code = code
    this.retryable = retryable
    this.deliveryUnknown = deliveryUnknown
    if (executorCode !== undefined) this.executorCode = executorCode
  }
}

type QueueItem<T> = {
  readonly queueWaitTimeoutMs: number
  readonly operation: () => Promise<T>
  readonly signal: AbortSignal
  readonly resolve: (value: T) => void
  readonly reject: (error: ProjectCodexRouterError) => void
  onAbort?: (() => void) | undefined
  queueTimer?: NodeJS.Timeout | undefined
  started: boolean
}

/**
 * Routes the strict Responses subset through a sticky ChatGPT subscription
 * binding. It migrates only after durable, pre-dispatch unavailability is
 * proven and never spills on queue pressure or ambiguous provider failures.
 */
export class ProjectCodexRouter {
  readonly homeDir: string
  readonly #executor: ManagedProjectExecutor
  readonly #store: AccountPoolStore
  readonly #maxQueuedRequests: number
  readonly #queueWaitTimeoutMs: number

  constructor(options: ProjectCodexRouterOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('Managed project router options are required.')
    }
    if (typeof options.homeDir !== 'string' || options.homeDir.trim() === '' || options.homeDir.includes('\0')) {
      throw new TypeError('Managed project router homeDir must be a nonempty path without NUL bytes.')
    }
    if (typeof options.executor !== 'function') {
      throw new TypeError('Managed project router executor must be a function.')
    }
    this.homeDir = path.resolve(options.homeDir)
    this.#executor = options.executor
    this.#store = new AccountPoolStore({
      homeDir: this.homeDir,
      serialize: createSqliteAccountPoolSerialization({
        homeDir: this.homeDir,
        ...(options.accountPoolLockTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.accountPoolLockTimeoutMs }),
      }),
    })
    this.#maxQueuedRequests = boundedQueueDepth(options.maxQueuedRequests)
    this.#queueWaitTimeoutMs = boundedQueueWait(options.queueWaitTimeoutMs)
  }

  /** Queues process-globally across every managed account and broker instance. */
  execute(projectId: string, request: ManagedResponsesRequest, signal: AbortSignal): Promise<string> {
    return this.executeLazy(projectId, async () => request, signal)
  }

  /** Reserves bounded capacity before loading a potentially large request body. */
  executeLazy(
    projectId: string,
    loadRequest: ManagedProjectRequestLoader,
    signal: AbortSignal,
  ): Promise<string> {
    const canonicalProjectId = validateManagedProjectId(projectId)
    if (typeof loadRequest !== 'function') {
      throw new TypeError('Managed project request loader must be a function.')
    }
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('Managed project execution requires an AbortSignal.')
    }
    return GLOBAL_MANAGED_PROJECT_SCHEDULER.run(signal, async () => {
      if (signal.aborted) throw abortedError(false)
      await this.#resolve(canonicalProjectId)
      if (signal.aborted) throw abortedError(false)
      const request = await loadRequest(signal)
      if (signal.aborted) throw abortedError(false)
      const attemptedAccountInternalIds = new Set<string>()
      let resolution = await this.#resolve(canonicalProjectId, attemptedAccountInternalIds)
      if (signal.aborted) throw abortedError(false)
      for (let attempt = 0; attempt < MAX_MANAGED_FAILOVER_ATTEMPTS; attempt += 1) {
        attemptedAccountInternalIds.add(resolution.account.internalId)
        try {
          return await this.#executor({
            homeDir: this.homeDir,
            projectId: canonicalProjectId,
            initialBinding: resolution.binding,
            initialAccount: resolution.account,
            request,
            signal,
          })
        } catch (error) {
          if (
            error instanceof ManagedProjectExecutorError &&
            error.code === 'managed_executor_unavailable' &&
            !error.deliveryUnknown &&
            !signal.aborted
          ) {
            const next = await this.#resolve(canonicalProjectId, attemptedAccountInternalIds)
            if (
              next.binding.generation !== resolution.binding.generation ||
              next.account.internalId !== resolution.account.internalId
            ) {
              resolution = next
              continue
            }
          }
          throw projectExecutionError(error, signal)
        }
      }
      throw bindingUnavailableError()
    }, {
      maxQueuedRequests: this.#maxQueuedRequests,
      queueWaitTimeoutMs: this.#queueWaitTimeoutMs,
    })
  }

  async #resolve(
    projectId: string,
    attemptedAccountInternalIds = new Set<string>(),
  ): Promise<Readonly<{
    binding: ProjectBinding
    account: CodexAccountRecord
  }>> {
    for (let attempt = 0; attempt < MAX_MANAGED_FAILOVER_ATTEMPTS; attempt += 1) {
      let resolution
      try {
        resolution = await this.#store.resolve({ projectId, provider: 'chatgpt' })
      } catch (error) {
        throw bindingUnavailableError(error)
      }
      if (resolution === null) {
        throw new ProjectCodexRouterError(
          'managed_project_binding_missing',
          'The request requires an explicit managed ChatGPT project binding.',
        )
      }
      const { account, binding } = resolution
      if (
        binding.provider !== 'chatgpt' ||
        account.provider !== 'chatgpt' ||
        account.driver !== 'official-codex' ||
        account.status !== 'ready' ||
        account.identityFingerprint === undefined
      ) throw bindingUnavailableError()
      if (account.enabled && account.health.state === 'usable') return { binding, account }

      attemptedAccountInternalIds.add(account.internalId)
      try {
        await this.#store.migrateToEligibleIfCurrent({
          projectId,
          provider: 'chatgpt',
          expectedAccountInternalId: account.internalId,
          expectedGeneration: binding.generation,
          attemptedAccountInternalIds: [...attemptedAccountInternalIds],
        })
      } catch (error) {
        throw bindingUnavailableError(error)
      }
    }
    throw bindingUnavailableError()
  }
}

function projectExecutionError(error: unknown, signal: AbortSignal): ProjectCodexRouterError {
  if (error instanceof ProjectCodexRouterError) return error
  if (error instanceof ManagedProjectExecutorError) {
    return new ProjectCodexRouterError(
      'managed_project_execution_failed',
      'The managed ChatGPT execution failed.',
      error.retryable,
      error.deliveryUnknown,
      error.code,
    )
  }
  if (signal.aborted || isAbortError(error)) return abortedError(true)
  return new ProjectCodexRouterError(
    'managed_project_execution_failed',
    'The managed ChatGPT execution failed.',
    false,
    true,
    'managed_executor_failed',
  )
}

function bindingUnavailableError(error?: unknown): ProjectCodexRouterError {
  return new ProjectCodexRouterError(
    'managed_project_binding_unavailable',
    'The managed ChatGPT binding is unavailable.',
    error === undefined
      ? false
      : !(error instanceof AccountPoolError) || error.code === 'account_pool_unreadable',
  )
}

/** Validates without trimming or case-folding; project ids are semantic keys. */
export function validateManagedProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new ProjectCodexRouterError(
      'managed_project_binding_missing',
      'The managed project header must be an exact 1-128 character URL-safe identifier.',
    )
  }
  return value
}

class BoundedFifoSingleFlight {
  readonly #queue: QueueItem<unknown>[] = []
  #active = false

  run<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    limits: Readonly<{ maxQueuedRequests: number; queueWaitTimeoutMs: number }>,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(abortedError(false))
    if (this.#active && this.#queue.length >= limits.maxQueuedRequests) {
      return Promise.reject(new ProjectCodexRouterError(
        'managed_project_queue_full',
        'The managed ChatGPT queue is full.',
        true,
      ))
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        operation,
        queueWaitTimeoutMs: limits.queueWaitTimeoutMs,
        signal,
        resolve,
        reject,
        started: false,
      }
      item.onAbort = () => {
        if (item.started) return
        const index = this.#queue.indexOf(item as QueueItem<unknown>)
        if (index !== -1) this.#queue.splice(index, 1)
        if (item.queueTimer !== undefined) clearTimeout(item.queueTimer)
        item.signal.removeEventListener('abort', item.onAbort!)
        reject(abortedError(false))
      }
      signal.addEventListener('abort', item.onAbort, { once: true })
      this.#queue.push(item as QueueItem<unknown>)
      item.queueTimer = setTimeout(() => {
        if (item.started) return
        const index = this.#queue.indexOf(item as QueueItem<unknown>)
        if (index !== -1) this.#queue.splice(index, 1)
        item.signal.removeEventListener('abort', item.onAbort!)
        reject(new ProjectCodexRouterError(
          'managed_project_queue_timeout',
          'The managed ChatGPT request timed out while waiting in the queue.',
          true,
        ))
      }, item.queueWaitTimeoutMs)
      item.queueTimer.unref()
      this.#drain()
    })
  }

  #drain(): void {
    if (this.#active) return
    const item = this.#queue.shift()
    if (item === undefined) return
    if (item.signal.aborted) {
      if (item.queueTimer !== undefined) clearTimeout(item.queueTimer)
      item.signal.removeEventListener('abort', item.onAbort!)
      item.reject(abortedError(false))
      this.#drain()
      return
    }
    item.started = true
    if (item.queueTimer !== undefined) clearTimeout(item.queueTimer)
    item.signal.removeEventListener('abort', item.onAbort!)
    this.#active = true
    void Promise.resolve()
      .then(item.operation)
      .then(item.resolve, item.reject)
      .finally(() => {
        this.#active = false
        this.#drain()
      })
  }
}

const GLOBAL_MANAGED_PROJECT_SCHEDULER = new BoundedFifoSingleFlight()

function boundedQueueDepth(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MANAGED_PROJECT_QUEUE_DEPTH
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > MAX_MANAGED_PROJECT_QUEUE_DEPTH) {
    throw new TypeError(
      `Managed project maxQueuedRequests must be an integer between 0 and ${MAX_MANAGED_PROJECT_QUEUE_DEPTH}.`,
    )
  }
  return candidate
}

function boundedQueueWait(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MANAGED_PROJECT_QUEUE_WAIT_MS
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_MANAGED_PROJECT_QUEUE_WAIT_MS) {
    throw new TypeError(
      `Managed project queueWaitTimeoutMs must be an integer between 1 and ${MAX_MANAGED_PROJECT_QUEUE_WAIT_MS}.`,
    )
  }
  return candidate
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortedError(deliveryUnknown: boolean): ProjectCodexRouterError {
  return new ProjectCodexRouterError(
    'managed_project_aborted',
    'The managed ChatGPT request was aborted.',
    true,
    deliveryUnknown,
  )
}
