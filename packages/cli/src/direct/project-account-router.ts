import path from 'node:path'

import {
  AccountPoolError,
  AccountPoolStore,
  normalizeRoutingDomain,
  type AccountResolution,
  type AccountUnavailableReason,
  type ApiAccountRecord,
} from './account-pool.js'
import { createSqliteAccountPoolSerialization } from './account-pool-lock.js'
import {
  DEFAULT_API_ACCOUNT_QUEUE_DEPTH,
  DEFAULT_API_ACCOUNT_QUEUE_WAIT_MS,
  withApiAccountCapacity,
} from './api-account-capacity.js'
import type { DirectProvider } from './types.js'

const PROVIDERS = Object.freeze<DirectProvider[]>([
  'chatgpt',
  'claude',
  'gemini',
  'grok',
  'antigravity',
])
const PROVIDER_SET = new Set<DirectProvider>(PROVIDERS)
const MAX_ROUTING_ATTEMPTS = 128
const MAX_API_KEY_CHARACTERS = 8_192

export type ProjectAccountRouterErrorCode =
  | 'project_api_binding_missing'
  | 'project_api_binding_unavailable'
  | 'project_api_driver_mismatch'
  | 'project_api_routing_failed'

export class ProjectAccountRouterError extends Error {
  readonly code: ProjectAccountRouterErrorCode
  readonly retryable: boolean
  readonly deliveryUnknown = false

  constructor(code: ProjectAccountRouterErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'ProjectAccountRouterError'
    this.code = code
    this.retryable = retryable
  }
}

export type ProjectApiAccountExecution = Readonly<{
  provider: DirectProvider
  credential: string
  accountInternalId: string
  accountHealthGeneration: number
  bindingGeneration: number
  routingDomain: string
  maxConcurrency: number
  reportCredentialRejection: () => Promise<boolean>
}>

export type ProjectAccountRouterOptions = Readonly<{
  homeDir: string
  routingDomains?: Partial<Record<DirectProvider, string>> | undefined
  environment?: Readonly<Record<string, string | undefined>> | undefined
  accountPool?: AccountPoolStore | undefined
  accountPoolLockTimeoutMs?: number | undefined
  queueDepth?: number | undefined
  queueWaitMs?: number | undefined
}>

type CredentialState =
  | Readonly<{ state: 'ready'; value: string }>
  | Readonly<{
      state: 'unavailable'
      reason: Extract<AccountUnavailableReason, 'api_credential_invalid' | 'api_credential_missing'>
    }>

class RetryResolution extends Error {
  readonly unavailable?: Readonly<{
    resolution: AccountResolution
    reason: Extract<AccountUnavailableReason, 'api_credential_invalid' | 'api_credential_missing'>
  }> | undefined
}

/** Routes one project/provider pair to a durable public-API account binding. */
export class ProjectAccountRouter {
  readonly homeDir: string
  readonly #accountPool: AccountPoolStore
  readonly #environment: Readonly<Record<string, string | undefined>>
  readonly #queueDepth: number
  readonly #queueWaitMs: number
  readonly #routingDomains: Readonly<Partial<Record<DirectProvider, string>>>

  constructor(options: ProjectAccountRouterOptions) {
    if (options === null || typeof options !== 'object') throw routingFailure()
    if (typeof options.homeDir !== 'string' || options.homeDir.includes('\0') || !path.isAbsolute(options.homeDir)) {
      throw routingFailure()
    }
    this.homeDir = path.resolve(options.homeDir)
    const environment = options.environment ?? process.env
    if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
      throw routingFailure()
    }
    this.#environment = environment
    this.#queueDepth = boundedInteger(
      options.queueDepth,
      DEFAULT_API_ACCOUNT_QUEUE_DEPTH,
      0,
      4_096,
    )
    this.#queueWaitMs = boundedInteger(
      options.queueWaitMs,
      DEFAULT_API_ACCOUNT_QUEUE_WAIT_MS,
      0,
      300_000,
    )
    this.#routingDomains = normalizeRoutingDomains(options.routingDomains)

    if (options.accountPool !== undefined) {
      if (!(options.accountPool instanceof AccountPoolStore)) throw routingFailure()
      if (path.resolve(options.accountPool.homeDir) !== this.homeDir) throw routingFailure()
      this.#accountPool = options.accountPool
    } else {
      this.#accountPool = new AccountPoolStore({
        homeDir: this.homeDir,
        serialize: createSqliteAccountPoolSerialization({
          homeDir: this.homeDir,
          timeoutMs: options.accountPoolLockTimeoutMs,
        }),
      })
    }
  }

  async execute<T>(
    projectId: string,
    provider: DirectProvider,
    operation: (execution: ProjectApiAccountExecution) => Promise<T>,
    signal?: AbortSignal | undefined,
  ): Promise<T> {
    if (!PROVIDER_SET.has(provider) || typeof operation !== 'function') throw routingFailure()
    if (signalIsAborted(signal)) throw abortedRoutingError()

    const attempted = new Set<string>()
    let resolution = await this.#resolveInitial(projectId, provider)
    for (let attempt = 0; attempt < MAX_ROUTING_ATTEMPTS; attempt += 1) {
      if (signalIsAborted(signal)) throw abortedRoutingError()
      resolution = await this.#requireUsableResolution(projectId, provider, resolution, attempted)
      const account = requireApiAccount(resolution)
      const credential = credentialState(this.#environment[account.credentialEnv])
      if (credential.state === 'unavailable') {
        resolution = await this.#markAndMigratePredispatch(
          projectId,
          provider,
          resolution,
          attempted,
        )
        continue
      }

      try {
        return await withApiAccountCapacity({
          homeDir: this.homeDir,
          provider,
          accountInternalId: account.internalId,
          maxConcurrency: account.maxConcurrency,
          queueDepth: this.#queueDepth,
          queueWaitMs: this.#queueWaitMs,
          signal,
        }, async () => {
          const fresh = await this.#accountPool.resolve({ projectId, provider })
          if (!sameAdmittedResolution(resolution, fresh)) throw new RetryResolution()
          const freshAccount = requireApiAccount(fresh)
          if (!freshAccount.enabled || freshAccount.health.state !== 'usable') {
            throw new RetryResolution()
          }
          const freshCredential = credentialState(this.#environment[freshAccount.credentialEnv])
          if (freshCredential.state === 'unavailable') {
            const retry = new RetryResolution()
            Object.defineProperty(retry, 'unavailable', {
              configurable: false,
              enumerable: false,
              value: { resolution: fresh, reason: freshCredential.reason },
              writable: false,
            })
            throw retry
          }
          return operation(this.#executionFor(fresh, freshAccount, freshCredential.value))
        })
      } catch (error) {
        if (!(error instanceof RetryResolution)) throw error
        if (error.unavailable !== undefined) {
          resolution = await this.#markAndMigratePredispatch(
            projectId,
            provider,
            error.unavailable.resolution,
            attempted,
          )
        } else {
          resolution = await this.#resolveInitial(projectId, provider)
        }
      }
    }
    throw new ProjectAccountRouterError(
      'project_api_routing_failed',
      'Public API project routing exceeded its bounded pre-dispatch attempt budget.',
      true,
    )
  }

  async #resolveInitial(projectId: string, provider: DirectProvider): Promise<AccountResolution> {
    let existing: AccountResolution | null
    try {
      existing = await this.#accountPool.resolve({ projectId, provider })
    } catch (error) {
      throw publicPoolFailure(error)
    }
    if (existing !== null) return existing
    const routingDomain = this.#routingDomains[provider]
    if (routingDomain === undefined) {
      throw new ProjectAccountRouterError(
        'project_api_binding_missing',
        'This project/provider pair has no binding and no operator-authorized API routing domain.',
      )
    }
    try {
      return await this.#accountPool.resolveOrAssign({ projectId, provider, routingDomain })
    } catch (error) {
      throw publicPoolFailure(error)
    }
  }

  async #requireUsableResolution(
    projectId: string,
    provider: DirectProvider,
    resolution: AccountResolution,
    attempted: Set<string>,
  ): Promise<AccountResolution> {
    const account = requireApiAccount(resolution)
    requireBindingDomain(resolution, account)
    if (account.enabled && account.health.state === 'usable') return resolution
    return this.#migrateUnavailable(projectId, provider, resolution, attempted)
  }

  async #markAndMigratePredispatch(
    projectId: string,
    provider: DirectProvider,
    resolution: AccountResolution,
    attempted: Set<string>,
  ): Promise<AccountResolution> {
    const account = requireApiAccount(resolution)
    const currentCredential = credentialState(this.#environment[account.credentialEnv])
    if (currentCredential.state === 'ready') {
      return this.#resolveInitial(projectId, provider)
    }
    try {
      const marked = await this.#accountPool.markUnavailableIfCurrent({
        provider,
        accountInternalId: account.internalId,
        expectedHealthGeneration: account.health.generation,
        reason: currentCredential.reason,
      })
      if (!marked.changed) return this.#resolveInitial(projectId, provider)
    } catch (error) {
      throw publicPoolFailure(error)
    }
    return this.#migrateUnavailable(projectId, provider, resolution, attempted)
  }

  async #migrateUnavailable(
    projectId: string,
    provider: DirectProvider,
    resolution: AccountResolution,
    attempted: Set<string>,
  ): Promise<AccountResolution> {
    attempted.add(resolution.account.internalId)
    if (resolution.binding.failoverPolicy === 'strict') {
      throw new ProjectAccountRouterError(
        'project_api_binding_unavailable',
        'The strict public API project binding is unavailable and was not changed.',
      )
    }
    try {
      const migrated = await this.#accountPool.migrateToEligibleIfCurrent({
        projectId,
        provider,
        expectedAccountInternalId: resolution.account.internalId,
        expectedGeneration: resolution.binding.generation,
        attemptedAccountInternalIds: [...attempted],
      })
      return migrated.resolution
    } catch (error) {
      throw publicPoolFailure(error)
    }
  }

  #executionFor(
    resolution: AccountResolution,
    account: ApiAccountRecord,
    credential: string,
  ): ProjectApiAccountExecution {
    const provider = account.provider
    const expectedHealthGeneration = account.health.generation
    const accountInternalId = account.internalId
    return Object.freeze({
      provider,
      credential,
      accountInternalId,
      accountHealthGeneration: expectedHealthGeneration,
      bindingGeneration: resolution.binding.generation,
      routingDomain: requireBindingDomain(resolution, account),
      maxConcurrency: account.maxConcurrency,
      reportCredentialRejection: async () => {
        const currentCredential = credentialState(this.#environment[account.credentialEnv])
        if (currentCredential.state !== 'ready' || currentCredential.value !== credential) return false
        try {
          const result = await this.#accountPool.markUnavailableIfCurrent({
            provider,
            accountInternalId,
            expectedHealthGeneration,
            reason: 'api_credential_rejected',
          })
          return result.changed
        } catch (error) {
          throw publicPoolFailure(error)
        }
      },
    })
  }
}

function normalizeRoutingDomains(
  value: Partial<Record<DirectProvider, string>> | undefined,
): Readonly<Partial<Record<DirectProvider, string>>> {
  if (value === undefined) return Object.freeze({})
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw routingFailure()
  const normalized: Partial<Record<DirectProvider, string>> = {}
  for (const key of Object.keys(value)) {
    if (!PROVIDER_SET.has(key as DirectProvider)) throw routingFailure()
    normalized[key as DirectProvider] = normalizeRoutingDomain(value[key as DirectProvider])
  }
  return Object.freeze(normalized)
}

function requireApiAccount(resolution: AccountResolution): ApiAccountRecord {
  if (resolution.account.driver !== 'api' || resolution.account.status !== 'ready') {
    throw new ProjectAccountRouterError(
      'project_api_driver_mismatch',
      'The project binding does not use the public API account driver.',
    )
  }
  return resolution.account
}

function requireBindingDomain(
  resolution: AccountResolution,
  account: ApiAccountRecord,
): string {
  if (
    account.routingDomain === null ||
    resolution.binding.routingDomain === null ||
    account.routingDomain !== resolution.binding.routingDomain
  ) {
    throw new ProjectAccountRouterError(
      'project_api_routing_failed',
      'The public API project binding has an invalid routing domain.',
    )
  }
  return account.routingDomain
}

function sameAdmittedResolution(
  expected: AccountResolution,
  actual: AccountResolution | null,
): actual is AccountResolution {
  return (
    actual !== null &&
    actual.binding.accountInternalId === expected.binding.accountInternalId &&
    actual.binding.generation === expected.binding.generation &&
    actual.account.internalId === expected.account.internalId &&
    actual.account.health.generation === expected.account.health.generation &&
    actual.account.driver === 'api'
  )
}

function credentialState(value: unknown): CredentialState {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { state: 'unavailable', reason: 'api_credential_missing' }
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_API_KEY_CHARACTERS ||
    /[\u0000-\u0020\u007f-\uffff]/.test(value)
  ) {
    return { state: 'unavailable', reason: 'api_credential_invalid' }
  }
  return { state: 'ready', value }
}

function publicPoolFailure(error: unknown): ProjectAccountRouterError {
  if (error instanceof ProjectAccountRouterError) return error
  if (error instanceof AccountPoolError) {
    if (error.code === 'account_pool_no_eligible_account') {
      return new ProjectAccountRouterError(
        'project_api_binding_unavailable',
        'No enabled usable public API account is eligible in the binding routing domain.',
        true,
      )
    }
    if (error.code === 'account_pool_not_found') {
      return new ProjectAccountRouterError(
        'project_api_binding_missing',
        'The public API project binding was not found.',
      )
    }
    if (error.code === 'account_pool_conflict') {
      return new ProjectAccountRouterError(
        'project_api_binding_unavailable',
        'The public API project binding could not migrate safely.',
      )
    }
  }
  return routingFailure()
}

function abortedRoutingError(): ProjectAccountRouterError {
  return new ProjectAccountRouterError(
    'project_api_routing_failed',
    'The public API project request was aborted before dispatch.',
    true,
  )
}

function routingFailure(): ProjectAccountRouterError {
  return new ProjectAccountRouterError(
    'project_api_routing_failed',
    'The public API project routing operation failed closed.',
  )
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw routingFailure()
  }
  return resolved
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
