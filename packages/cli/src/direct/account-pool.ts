import { createHash, randomUUID as createRandomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { tokenlessHome } from '../job-store.js'
import type { DirectProvider } from './types.js'

export const ACCOUNT_POOL_PROTOCOL = 'tokenless.account-pool.v2' as const

const LEGACY_ACCOUNT_POOL_PROTOCOL = 'tokenless.account-pool.v1' as const

const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ROUTING_DOMAIN_PATTERN = ACCOUNT_ID_PATTERN
const PROJECT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CODEX_IDENTITY_FINGERPRINT_PATTERN = /^tokenless\.codex-identity\.v1:[A-Za-z0-9_-]{43}$/
const MAX_REGISTRY_BYTES = 4 * 1_024 * 1_024
const MAX_LABEL_CHARACTERS = 128
const MAX_API_CONCURRENCY = 128
const MAX_MIGRATION_ATTEMPTS = 128
const MAX_SECRET_FIELD_SCAN_DEPTH = 128
const MAX_SECRET_FIELD_SCAN_NODES = 262_144
export const MAX_ACCOUNT_POOL_AUDIT_EVENTS = 1_024
export const MAX_ACCOUNT_POOL_AUDIT_PAGE_SIZE = 1_024

const PROVIDERS = Object.freeze<DirectProvider[]>([
  'chatgpt',
  'claude',
  'gemini',
  'grok',
  'antigravity',
])

const FORBIDDEN_SECRET_FIELD_NAMES = new Set([
  'apikey',
  'accesskey',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'token',
  'secret',
  'password',
  'cookie',
  'authorization',
  'authheader',
  'credential',
  'credentialvalue',
  'rawidentity',
  'email',
])

type JsonRecord = Record<string, unknown>

export type AccountPoolProtocol = typeof ACCOUNT_POOL_PROTOCOL
export type AccountStatus = 'pending' | 'ready'
export type ProjectFailoverPolicy = 'availability-first' | 'strict'
export type BindingAssignment = 'automatic' | 'explicit' | 'migration'
export type AccountUnavailableReason =
  | 'api_credential_invalid'
  | 'api_credential_missing'
  | 'api_credential_rejected'
  | 'codex_no_account'
  | 'codex_not_chatgpt'
  | 'codex_identity_unverifiable'
  | 'codex_identity_mismatch'
  | 'codex_profile_unsafe'

export type AccountHealth =
  | Readonly<{
      state: 'usable'
      generation: number
    }>
  | Readonly<{
      state: 'unavailable'
      generation: number
      reason: AccountUnavailableReason
      observedAt: string
    }>

type AccountRecordBase = Readonly<{
  provider: DirectProvider
  accountId: string
  internalId: string
  enabled: boolean
  maxConcurrency: number
  health: AccountHealth
  routingDomain: string | null
  label?: string | undefined
  createdAt: string
  updatedAt: string
}>

export type CodexAccountRecord = AccountRecordBase & Readonly<{
  provider: 'chatgpt'
  driver: 'official-codex'
  status: AccountStatus
  identityFingerprint?: string | undefined
}>

export type ApiAccountRecord = AccountRecordBase & Readonly<{
  driver: 'api'
  status: 'ready'
  credentialEnv: string
}>

export type AccountRecord = CodexAccountRecord | ApiAccountRecord

export type ProjectBinding = Readonly<{
  projectId: string
  provider: DirectProvider
  accountInternalId: string
  routingDomain: string | null
  failoverPolicy: ProjectFailoverPolicy
  assignedBy: BindingAssignment
  generation: number
  createdAt: string
  updatedAt: string
}>

export type AccountPoolSnapshot = Readonly<{
  protocol: AccountPoolProtocol
  revision: number
  updatedAt: string | null
  accounts: AccountRecord[]
  bindings: ProjectBinding[]
  audit: AccountPoolAuditLog
}>

export type AccountPoolAuditAction =
  | 'account_added'
  | 'account_removed'
  | 'account_enabled'
  | 'account_disabled'
  | 'account_routing_domain_changed'
  | 'binding_assigned'
  | 'binding_pinned'
  | 'binding_migrated'
  | 'binding_unpinned'
  | 'health_marked_unavailable'
  | 'health_cleared'

type AccountPoolAuditEventBase = Readonly<{
  sequence: number
  timestamp: string
  action: AccountPoolAuditAction
  provider: DirectProvider
  accountId: string
}>

export type AccountPoolAuditEvent = AccountPoolAuditEventBase & Readonly<{
  projectId?: string | undefined
  previousAccountId?: string | null | undefined
  bindingGeneration?: number | undefined
  routingDomain?: string | null | undefined
  previousRoutingDomain?: string | null | undefined
  healthGeneration?: number | undefined
  healthReason?: AccountUnavailableReason | undefined
}>

export type AccountPoolAuditLog = Readonly<{
  droppedThroughSequence: number
  nextSequence: number
  events: AccountPoolAuditEvent[]
}>

export type AccountPoolAuditPage = Readonly<{
  afterSequence: number
  gap: boolean
  droppedThroughSequence: number
  nextSequence: number
  events: AccountPoolAuditEvent[]
}>

export type AccountResolution = Readonly<{
  snapshotRevision: number
  binding: ProjectBinding
  account: AccountRecord
}>

export type MigrationResult = Readonly<{
  migrated: boolean
  resolution: AccountResolution
}>

export type AccountHealthMutationResult = Readonly<{
  changed: boolean
  account: AccountRecord
}>

export type AddCodexAccountInput = Readonly<{
  provider: 'chatgpt'
  accountId: string
  driver: 'official-codex'
  enabled?: boolean | undefined
  routingDomain?: string | null | undefined
  label?: string | undefined
}>

export type AddApiAccountInput = Readonly<{
  provider: DirectProvider
  accountId: string
  driver: 'api'
  routingDomain: string
  enabled?: boolean | undefined
  maxConcurrency?: number | undefined
  label?: string | undefined
}>

export type AddAccountInput = AddCodexAccountInput | AddApiAccountInput

export type AccountReference = Readonly<{
  provider: DirectProvider | string
  accountId: string
}>

export type ProjectReference = Readonly<{
  projectId: string
  provider: DirectProvider | string
}>

export type AccountPoolSerialization = <T>(
  stateFile: string,
  operation: () => Promise<T>,
) => Promise<T>

export type AccountPoolStoreOptions = Readonly<{
  homeDir?: string | undefined
  now?: (() => Date) | undefined
  randomUUID?: (() => string) | undefined
  serialize?: AccountPoolSerialization | undefined
}>

export type AccountPoolErrorCode =
  | 'account_pool_already_exists'
  | 'account_pool_bound_account'
  | 'account_pool_conflict'
  | 'account_pool_invalid'
  | 'account_pool_no_eligible_account'
  | 'account_pool_not_found'
  | 'account_pool_permission_denied'
  | 'account_pool_routing_domain_mismatch'
  | 'account_pool_secret_field_forbidden'
  | 'account_pool_unreadable'
  | 'account_pool_unsupported_protocol'

export class AccountPoolError extends Error {
  readonly code: AccountPoolErrorCode
  readonly retryable = false

  constructor(code: AccountPoolErrorCode, message: string) {
    super(message)
    this.name = 'AccountPoolError'
    this.code = code
  }
}

const PROCESS_LOCAL_MUTATION_TAILS = new Map<string, Promise<void>>()

/**
 * Serializes registry read-modify-write operations across store instances in this
 * process. Production wraps this seam with a caller-owned cross-process lock
 * without changing the registry mutation contract.
 */
export async function withProcessLocalAccountPoolSerialization<T>(
  stateFile: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(stateFile)
  const previous = PROCESS_LOCAL_MUTATION_TAILS.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  PROCESS_LOCAL_MUTATION_TAILS.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release?.()
    if (PROCESS_LOCAL_MUTATION_TAILS.get(key) === tail) {
      PROCESS_LOCAL_MUTATION_TAILS.delete(key)
    }
  }
}

export function accountPoolDirectDirectory(homeDir = tokenlessHome()) {
  return path.join(path.resolve(homeDir), 'direct')
}

export function accountPoolStatePath(homeDir = tokenlessHome()) {
  return path.join(accountPoolDirectDirectory(homeDir), 'account-pool.json')
}

export function accountPoolProfilePath(
  homeDir: string,
  provider: DirectProvider | string,
  internalId: string,
) {
  const normalizedProvider = normalizeProvider(provider)
  if (normalizedProvider !== 'chatgpt') {
    throw invalidError('Managed provider profiles are currently supported only for ChatGPT.')
  }
  const canonicalInternalId = requireCanonicalUuid(internalId)
  const profileRoot = path.join(
    accountPoolDirectDirectory(homeDir),
    'provider-profiles',
    normalizedProvider,
    canonicalInternalId,
  )
  return path.join(profileRoot, 'codex')
}

export function accountPoolAccountLockPath(
  homeDir: string,
  provider: DirectProvider | string,
  internalId: string,
) {
  const normalizedProvider = normalizeProvider(provider)
  const canonicalInternalId = requireCanonicalUuid(internalId)
  return path.join(
    accountPoolDirectDirectory(homeDir),
    'account-locks',
    normalizedProvider,
    `${canonicalInternalId}.lock`,
  )
}

export function normalizeAccountId(value: unknown) {
  if (typeof value !== 'string') throw invalidError('Account id must be a string.')
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-')
  if (!ACCOUNT_ID_PATTERN.test(normalized)) {
    throw invalidError('Account id must be a 1-63 character lowercase URL-safe slug.')
  }
  return normalized
}

export function normalizeRoutingDomain(value: unknown) {
  if (typeof value !== 'string') throw invalidError('Routing domain must be a string.')
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-')
  if (!ROUTING_DOMAIN_PATTERN.test(normalized)) {
    throw invalidError('Routing domain must be a 1-63 character lowercase URL-safe slug.')
  }
  return normalized
}

export function apiCredentialEnvironmentName(
  provider: DirectProvider | string,
  accountId: string,
) {
  const normalizedProvider = normalizeProvider(provider)
  const normalizedAccountId = normalizeAccountId(accountId)
  return `TOKENLESS_DIRECT_ACCOUNT_${normalizedProvider.toUpperCase()}_${normalizedAccountId.toUpperCase().replaceAll('-', '_')}_API_KEY`
}

export class AccountPoolStore {
  readonly homeDir: string
  readonly stateFile: string
  readonly #now: () => Date
  readonly #randomUUID: () => string
  readonly #serialize: AccountPoolSerialization

  constructor(options: AccountPoolStoreOptions = {}) {
    this.homeDir = path.resolve(options.homeDir ?? tokenlessHome())
    this.stateFile = accountPoolStatePath(this.homeDir)
    this.#now = options.now ?? (() => new Date())
    this.#randomUUID = options.randomUUID ?? createRandomUUID
    this.#serialize = options.serialize ?? withProcessLocalAccountPoolSerialization
  }

  async readSnapshot(): Promise<AccountPoolSnapshot> {
    return cloneSnapshot(await readSnapshotFile(this.homeDir, this.stateFile))
  }

  async readAudit(options: {
    afterSequence?: number | undefined
    limit?: number | undefined
    provider?: DirectProvider | string | undefined
    accountId?: string | undefined
  } = {}): Promise<AccountPoolAuditPage> {
    if (!isJsonRecord(options)) throw invalidError('Audit read options must be an object.')
    assertExactKeys(options, [], ['afterSequence', 'limit', 'provider', 'accountId'], 'audit read options')
    const snapshot = await this.readSnapshot()
    const provider = options.provider === undefined ? undefined : normalizeProvider(options.provider)
    const accountId = options.accountId === undefined ? undefined : normalizeAccountId(options.accountId)
    const afterSequence = boundedInteger(
      options.afterSequence,
      snapshot.audit.droppedThroughSequence,
      0,
      Number.MAX_SAFE_INTEGER,
      'audit after sequence',
    )
    const limit = boundedInteger(
      options.limit,
      MAX_ACCOUNT_POOL_AUDIT_PAGE_SIZE,
      1,
      MAX_ACCOUNT_POOL_AUDIT_PAGE_SIZE,
      'audit page size',
    )
    return {
      afterSequence,
      gap: afterSequence < snapshot.audit.droppedThroughSequence,
      droppedThroughSequence: snapshot.audit.droppedThroughSequence,
      nextSequence: snapshot.audit.nextSequence,
      events: snapshot.audit.events
        .filter((event) => (
          event.sequence > Math.max(afterSequence, snapshot.audit.droppedThroughSequence) &&
          (provider === undefined || event.provider === provider) &&
          (accountId === undefined || event.accountId === accountId)
        ))
        .slice(0, limit)
        .map(cloneAuditEvent),
    }
  }

  async listAccounts(filter: { provider?: DirectProvider | string | undefined } = {}) {
    const snapshot = await this.readSnapshot()
    const provider = filter.provider === undefined ? undefined : normalizeProvider(filter.provider)
    return snapshot.accounts
      .filter((account) => provider === undefined || account.provider === provider)
      .map(cloneAccount)
  }

  async listBindings(filter: {
    projectId?: string | undefined
    provider?: DirectProvider | string | undefined
  } = {}) {
    const snapshot = await this.readSnapshot()
    const projectId = filter.projectId === undefined ? undefined : requireProjectId(filter.projectId)
    const provider = filter.provider === undefined ? undefined : normalizeProvider(filter.provider)
    return snapshot.bindings
      .filter((binding) => (
        (projectId === undefined || binding.projectId === projectId) &&
        (provider === undefined || binding.provider === provider)
      ))
      .map(cloneBinding)
  }

  async addCodexAccount(input: Omit<AddCodexAccountInput, 'driver' | 'provider'> & {
    provider?: 'chatgpt' | undefined
  }): Promise<CodexAccountRecord> {
    const account = await this.addAccount({ ...input, provider: 'chatgpt', driver: 'official-codex' })
    return account
  }

  async addApiAccount(input: Omit<AddApiAccountInput, 'driver'>): Promise<ApiAccountRecord> {
    const account = await this.addAccount({ ...input, driver: 'api' })
    return account
  }

  async addAccount(input: AddCodexAccountInput): Promise<CodexAccountRecord>
  async addAccount(input: AddApiAccountInput): Promise<ApiAccountRecord>
  async addAccount(input: AddAccountInput): Promise<AccountRecord>
  async addAccount(input: AddAccountInput): Promise<AccountRecord> {
    if (!isJsonRecord(input)) throw invalidError('Account input must be an object.')
    rejectSecretFields(input, 'account input')
    if (input.driver === 'official-codex') {
      assertExactKeys(
        input,
        ['provider', 'accountId', 'driver'],
        ['enabled', 'label', 'routingDomain'],
        'account input',
      )
    } else if (input.driver === 'api') {
      assertExactKeys(
        input,
        ['provider', 'accountId', 'driver', 'routingDomain'],
        ['enabled', 'maxConcurrency', 'label'],
        'account input',
      )
    }
    const provider = normalizeProvider(input.provider)
    const accountId = normalizeAccountId(input.accountId)
    const label = normalizeOptionalLabel(input.label)
    const enabled = input.enabled ?? true
    if (typeof enabled !== 'boolean') throw invalidError('Account enabled must be a boolean.')
    if (input.driver !== 'official-codex' && input.driver !== 'api') {
      throw invalidError('Account driver is unsupported.')
    }
    if (input.driver === 'official-codex' && provider !== 'chatgpt') {
      throw invalidError('The official Codex driver is supported only for ChatGPT accounts.')
    }

    return this.#mutate((snapshot, timestamp) => {
      if (findAccountBySlug(snapshot, provider, accountId) !== undefined) {
        throw new AccountPoolError(
          'account_pool_already_exists',
          `Account ${provider}/${accountId} already exists.`,
        )
      }
      const internalId = this.#newInternalId(snapshot)
      let account: AccountRecord
      if (input.driver === 'official-codex') {
        const routingDomain = input.routingDomain === undefined || input.routingDomain === null
          ? null
          : normalizeRoutingDomain(input.routingDomain)
        account = {
          provider: 'chatgpt',
          accountId,
          internalId,
          driver: 'official-codex',
          status: 'pending',
          enabled,
          maxConcurrency: 1,
          health: usableHealth(),
          routingDomain,
          ...(label === undefined ? {} : { label }),
          createdAt: timestamp,
          updatedAt: timestamp,
        }
      } else {
        const routingDomain = normalizeRoutingDomain(input.routingDomain)
        const maxConcurrency = boundedInteger(
          input.maxConcurrency,
          1,
          1,
          MAX_API_CONCURRENCY,
          'API account max concurrency',
        )
        account = {
          provider,
          accountId,
          internalId,
          driver: 'api',
          status: 'ready',
          enabled,
          maxConcurrency,
          health: usableHealth(),
          ...(label === undefined ? {} : { label }),
          credentialEnv: apiCredentialEnvironmentName(provider, accountId),
          routingDomain,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
      }
      snapshot.accounts.push(account)
      appendAuditEvent(snapshot, timestamp, {
        action: 'account_added',
        provider: account.provider,
        accountId: account.accountId,
      })
      return { changed: true, value: cloneAccount(account) }
    })
  }

  async finalizeCodexIdentity(input: AccountReference & {
    expectedInternalId: string
    identityFingerprint: string
  }): Promise<CodexAccountRecord> {
    if (!isJsonRecord(input)) throw invalidError('Codex identity input must be an object.')
    rejectSecretFields(input, 'Codex identity input')
    assertExactKeys(
      input,
      ['provider', 'accountId', 'expectedInternalId', 'identityFingerprint'],
      [],
      'Codex identity input',
    )
    const provider = normalizeProvider(input.provider)
    if (provider !== 'chatgpt') {
      throw invalidError('Codex identity can be finalized only for ChatGPT accounts.')
    }
    const accountId = normalizeAccountId(input.accountId)
    const expectedInternalId = requireCanonicalUuid(input.expectedInternalId)
    const identityFingerprint = requireCodexIdentityFingerprint(input.identityFingerprint)
    return this.#mutate((snapshot, timestamp) => {
      const account = requireAccountBySlug(snapshot, provider, accountId)
      if (account.internalId !== expectedInternalId) {
        throw new AccountPoolError(
          'account_pool_conflict',
          'The account identity reservation changed before Codex onboarding completed.',
        )
      }
      if (account.driver !== 'official-codex') {
        throw new AccountPoolError('account_pool_conflict', 'Only an official Codex account has a Codex identity.')
      }
      const duplicate = snapshot.accounts.find((candidate) => (
        candidate.driver === 'official-codex' &&
        candidate.internalId !== account.internalId &&
        candidate.identityFingerprint === identityFingerprint
      ))
      if (duplicate !== undefined) {
        throw new AccountPoolError('account_pool_conflict', 'The Codex identity is already registered.')
      }
      if (account.status === 'ready') {
        if (account.identityFingerprint === identityFingerprint) return { changed: false, value: cloneAccount(account) }
        throw new AccountPoolError(
          'account_pool_conflict',
          'The registered Codex identity differs; explicitly relink the account before use.',
        )
      }
      const finalized: CodexAccountRecord = {
        ...account,
        status: 'ready',
        identityFingerprint,
        updatedAt: timestamp,
      }
      replaceAccount(snapshot, finalized)
      return { changed: true, value: cloneAccount(finalized) }
    })
  }

  async enableAccount(reference: AccountReference) {
    return this.#setAccountEnabled(reference, true)
  }

  async disableAccount(reference: AccountReference) {
    return this.#setAccountEnabled(reference, false)
  }

  async removeAccount(reference: AccountReference): Promise<AccountRecord> {
    const provider = normalizeProvider(reference.provider)
    const accountId = normalizeAccountId(reference.accountId)
    return this.#mutate((snapshot, timestamp) => {
      const account = requireAccountBySlug(snapshot, provider, accountId)
      if (snapshot.bindings.some((binding) => binding.accountInternalId === account.internalId)) {
        throw new AccountPoolError(
          'account_pool_bound_account',
          `Account ${provider}/${accountId} still has project bindings.`,
        )
      }
      snapshot.accounts = snapshot.accounts.filter((candidate) => candidate.internalId !== account.internalId)
      appendAuditEvent(snapshot, timestamp, {
        action: 'account_removed',
        provider: account.provider,
        accountId: account.accountId,
      })
      return { changed: true, value: cloneAccount(account) }
    })
  }

  async pinProject(input: ProjectReference & {
    accountId: string
    failoverPolicy?: ProjectFailoverPolicy | undefined
  }): Promise<AccountResolution> {
    const projectId = requireProjectId(input.projectId)
    const provider = normalizeProvider(input.provider)
    const accountId = normalizeAccountId(input.accountId)
    const failoverPolicy = requireFailoverPolicy(input.failoverPolicy ?? 'availability-first')
    return this.#mutate((snapshot, timestamp) => {
      const account = requireAccountBySlug(snapshot, provider, accountId)
      requireRoutableAccount(account)
      const current = findBinding(snapshot, projectId, provider)
      if (
        current !== undefined &&
        current.accountInternalId === account.internalId &&
        current.failoverPolicy === failoverPolicy
      ) {
        return {
          changed: false,
          value: resolution(snapshot.revision, current, account),
        }
      }
      const binding: ProjectBinding = {
        projectId,
        provider,
        accountInternalId: account.internalId,
        routingDomain: account.routingDomain,
        failoverPolicy,
        assignedBy: 'explicit',
        generation: (current?.generation ?? 0) + 1,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      replaceBinding(snapshot, binding)
      appendAuditEvent(snapshot, timestamp, {
        action: 'binding_pinned',
        provider,
        accountId: account.accountId,
        projectId,
        previousAccountId: current === undefined
          ? null
          : requireAccountByInternalId(snapshot, current.accountInternalId).accountId,
        bindingGeneration: binding.generation,
        routingDomain: binding.routingDomain,
      })
      return {
        changed: true,
        value: resolution(snapshot.revision + 1, binding, account),
      }
    })
  }

  async unpinProject(reference: ProjectReference): Promise<ProjectBinding | null> {
    const projectId = requireProjectId(reference.projectId)
    const provider = normalizeProvider(reference.provider)
    return this.#mutate((snapshot, timestamp) => {
      const current = findBinding(snapshot, projectId, provider)
      if (current === undefined) return { changed: false, value: null }
      const account = requireAccountByInternalId(snapshot, current.accountInternalId)
      snapshot.bindings = snapshot.bindings.filter((binding) => (
        binding.projectId !== projectId || binding.provider !== provider
      ))
      appendAuditEvent(snapshot, timestamp, {
        action: 'binding_unpinned',
        provider,
        accountId: account.accountId,
        projectId,
        bindingGeneration: current.generation,
        routingDomain: current.routingDomain,
      })
      return { changed: true, value: cloneBinding(current) }
    })
  }

  async resolve(reference: ProjectReference): Promise<AccountResolution | null> {
    const projectId = requireProjectId(reference.projectId)
    const provider = normalizeProvider(reference.provider)
    const snapshot = await this.readSnapshot()
    const binding = findBinding(snapshot, projectId, provider)
    if (binding === undefined) return null
    const account = requireAccountByInternalId(snapshot, binding.accountInternalId)
    return resolution(snapshot.revision, binding, account)
  }

  async resolveOrAssign(input: ProjectReference & {
    routingDomain: string
    failoverPolicy?: ProjectFailoverPolicy | undefined
  }): Promise<AccountResolution> {
    const projectId = requireProjectId(input.projectId)
    const provider = normalizeProvider(input.provider)
    const routingDomain = normalizeRoutingDomain(input.routingDomain)
    const failoverPolicy = requireFailoverPolicy(input.failoverPolicy ?? 'availability-first')
    return this.#mutate((snapshot, timestamp) => {
      const current = findBinding(snapshot, projectId, provider)
      if (current !== undefined) {
        const account = requireAccountByInternalId(snapshot, current.accountInternalId)
        if (account.driver !== 'api' || account.routingDomain !== routingDomain || current.routingDomain !== routingDomain) {
          throw new AccountPoolError(
            'account_pool_routing_domain_mismatch',
            'The existing project binding belongs to a different routing domain.',
          )
        }
        return { changed: false, value: resolution(snapshot.revision, current, account) }
      }
      const candidates = snapshot.accounts.filter((account): account is ApiAccountRecord => (
        account.provider === provider &&
        account.driver === 'api' &&
        account.status === 'ready' &&
        account.enabled &&
        account.health.state === 'usable' &&
        account.routingDomain === routingDomain
      ))
      const account = selectRendezvousAccount(candidates, projectId, provider, routingDomain)
      if (account === undefined) {
        throw new AccountPoolError(
          'account_pool_no_eligible_account',
          'No enabled public API account is eligible in the requested routing domain.',
        )
      }
      const binding: ProjectBinding = {
        projectId,
        provider,
        accountInternalId: account.internalId,
        routingDomain,
        failoverPolicy,
        assignedBy: 'automatic',
        generation: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      snapshot.bindings.push(binding)
      appendAuditEvent(snapshot, timestamp, {
        action: 'binding_assigned',
        provider,
        accountId: account.accountId,
        projectId,
        bindingGeneration: binding.generation,
        routingDomain,
      })
      return {
        changed: true,
        value: resolution(snapshot.revision + 1, binding, account),
      }
    })
  }

  async migrateIfCurrent(input: ProjectReference & {
    expectedAccountInternalId: string
    expectedGeneration: number
    nextAccountInternalId: string
  }): Promise<MigrationResult> {
    const projectId = requireProjectId(input.projectId)
    const provider = normalizeProvider(input.provider)
    const expectedAccountInternalId = requireCanonicalUuid(input.expectedAccountInternalId)
    const nextAccountInternalId = requireCanonicalUuid(input.nextAccountInternalId)
    const expectedGeneration = boundedInteger(
      input.expectedGeneration,
      undefined,
      1,
      Number.MAX_SAFE_INTEGER,
      'expected binding generation',
    )
    return this.#mutate<MigrationResult>((snapshot, timestamp) => {
      const current = findBinding(snapshot, projectId, provider)
      if (current === undefined) {
        throw new AccountPoolError('account_pool_not_found', 'Project binding was not found.')
      }
      const currentAccount = requireAccountByInternalId(snapshot, current.accountInternalId)
      if (
        current.accountInternalId !== expectedAccountInternalId ||
        current.generation !== expectedGeneration ||
        current.accountInternalId === nextAccountInternalId
      ) {
        return {
          changed: false,
          value: { migrated: false, resolution: resolution(snapshot.revision, current, currentAccount) },
        }
      }
      if (current.failoverPolicy === 'strict') {
        throw new AccountPoolError(
          'account_pool_conflict',
          'Strict project bindings cannot be migrated automatically; explicitly pin a different account.',
        )
      }
      if (currentAccount.enabled && currentAccount.health.state === 'usable') {
        throw new AccountPoolError(
          'account_pool_conflict',
          'A usable enabled account cannot be migrated automatically.',
        )
      }
      const nextAccount = requireAccountByInternalId(snapshot, nextAccountInternalId)
      if (nextAccount.provider !== provider) {
        throw new AccountPoolError('account_pool_conflict', 'Migration target belongs to a different provider.')
      }
      requireRoutableAccount(nextAccount)
      if (nextAccount.driver !== currentAccount.driver) {
        throw new AccountPoolError(
          'account_pool_conflict',
          'Migration target uses a different account driver; explicitly pin it instead.',
        )
      }
      requireAutomaticMigrationDomain(current, currentAccount)
      if (nextAccount.routingDomain !== current.routingDomain) {
        throw new AccountPoolError(
          'account_pool_routing_domain_mismatch',
          'Migration target belongs to a different routing domain.',
        )
      }
      const migrated: ProjectBinding = {
        ...current,
        accountInternalId: nextAccount.internalId,
        routingDomain: nextAccount.routingDomain,
        assignedBy: 'migration',
        generation: current.generation + 1,
        updatedAt: timestamp,
      }
      replaceBinding(snapshot, migrated)
      appendMigrationAudit(snapshot, timestamp, current, currentAccount, nextAccount, migrated)
      return {
        changed: true,
        value: {
          migrated: true,
          resolution: resolution(snapshot.revision + 1, migrated, nextAccount),
        },
      }
    })
  }

  async migrateToEligibleIfCurrent(input: ProjectReference & {
    expectedAccountInternalId: string
    expectedGeneration: number
    attemptedAccountInternalIds?: readonly string[] | undefined
  }): Promise<MigrationResult> {
    const projectId = requireProjectId(input.projectId)
    const provider = normalizeProvider(input.provider)
    const expectedAccountInternalId = requireCanonicalUuid(input.expectedAccountInternalId)
    const expectedGeneration = boundedInteger(
      input.expectedGeneration,
      undefined,
      1,
      Number.MAX_SAFE_INTEGER,
      'expected binding generation',
    )
    const attempted = requireAttemptedAccountIds(input.attemptedAccountInternalIds)
    attempted.add(expectedAccountInternalId)
    return this.#mutate<MigrationResult>((snapshot, timestamp) => {
      const current = findBinding(snapshot, projectId, provider)
      if (current === undefined) {
        throw new AccountPoolError('account_pool_not_found', 'Project binding was not found.')
      }
      const currentAccount = requireAccountByInternalId(snapshot, current.accountInternalId)
      if (
        current.accountInternalId !== expectedAccountInternalId ||
        current.generation !== expectedGeneration
      ) {
        return {
          changed: false,
          value: { migrated: false, resolution: resolution(snapshot.revision, current, currentAccount) },
        }
      }
      if (current.failoverPolicy === 'strict') {
        throw new AccountPoolError(
          'account_pool_conflict',
          'Strict project bindings cannot be migrated automatically; explicitly pin a different account.',
        )
      }
      if (currentAccount.enabled && currentAccount.health.state === 'usable') {
        throw new AccountPoolError(
          'account_pool_conflict',
          'A usable enabled account cannot be migrated automatically.',
        )
      }
      const routingDomain = requireAutomaticMigrationDomain(current, currentAccount)
      const candidates = snapshot.accounts.filter((account) => (
        account.provider === provider &&
        account.driver === currentAccount.driver &&
        account.status === 'ready' &&
        account.enabled &&
        account.health.state === 'usable' &&
        account.routingDomain === routingDomain &&
        !attempted.has(account.internalId)
      ))
      const nextAccount = selectRendezvousAccount(candidates, projectId, provider, routingDomain)
      if (nextAccount === undefined) {
        throw new AccountPoolError(
          'account_pool_no_eligible_account',
          'No enabled usable account is eligible in the existing routing domain.',
        )
      }
      const migrated: ProjectBinding = {
        ...current,
        accountInternalId: nextAccount.internalId,
        routingDomain,
        assignedBy: 'migration',
        generation: current.generation + 1,
        updatedAt: timestamp,
      }
      replaceBinding(snapshot, migrated)
      appendMigrationAudit(snapshot, timestamp, current, currentAccount, nextAccount, migrated)
      return {
        changed: true,
        value: {
          migrated: true,
          resolution: resolution(snapshot.revision + 1, migrated, nextAccount),
        },
      }
    })
  }

  async markUnavailableIfCurrent(input: {
    provider: DirectProvider | string
    accountInternalId: string
    expectedHealthGeneration: number
    reason: AccountUnavailableReason
  }): Promise<AccountHealthMutationResult> {
    if (!isJsonRecord(input)) throw invalidError('Account health input must be an object.')
    rejectSecretFields(input, 'account health input')
    assertExactKeys(
      input,
      ['provider', 'accountInternalId', 'expectedHealthGeneration', 'reason'],
      [],
      'account health input',
    )
    const provider = normalizeProvider(input.provider)
    const accountInternalId = requireCanonicalUuid(input.accountInternalId)
    const expectedHealthGeneration = boundedInteger(
      input.expectedHealthGeneration,
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
      'expected account health generation',
    )
    const reason = requireUnavailableReason(input.reason)
    return this.#mutate<AccountHealthMutationResult>((snapshot, timestamp) => {
      const account = requireAccountByInternalId(snapshot, accountInternalId)
      if (account.provider !== provider) {
        throw new AccountPoolError('account_pool_conflict', 'Account health provider does not match its account.')
      }
      requireUnavailableReasonForDriver(account.driver, reason)
      if (account.health.generation !== expectedHealthGeneration) {
        return { changed: false, value: { changed: false, account: cloneAccount(account) } }
      }
      const updated: AccountRecord = {
        ...account,
        health: {
          state: 'unavailable',
          generation: account.health.generation + 1,
          reason,
          observedAt: timestamp,
        },
        updatedAt: timestamp,
      }
      replaceAccount(snapshot, updated)
      appendAuditEvent(snapshot, timestamp, {
        action: 'health_marked_unavailable',
        provider,
        accountId: account.accountId,
        healthGeneration: updated.health.generation,
        healthReason: reason,
      })
      return { changed: true, value: { changed: true, account: cloneAccount(updated) } }
    })
  }

  async clearAccountHealth(reference: AccountReference): Promise<AccountRecord> {
    const provider = normalizeProvider(reference.provider)
    const accountId = normalizeAccountId(reference.accountId)
    return this.#mutate((snapshot, timestamp) => {
      const account = requireAccountBySlug(snapshot, provider, accountId)
      const updated: AccountRecord = {
        ...account,
        health: usableHealth(account.health.generation + 1),
        updatedAt: timestamp,
      }
      replaceAccount(snapshot, updated)
      appendAuditEvent(snapshot, timestamp, {
        action: 'health_cleared',
        provider,
        accountId,
        healthGeneration: updated.health.generation,
      })
      return { changed: true, value: cloneAccount(updated) }
    })
  }

  async setAccountRoutingDomain(input: AccountReference & {
    routingDomain: string | null
  }): Promise<AccountRecord> {
    if (!isJsonRecord(input)) throw invalidError('Account routing domain input must be an object.')
    rejectSecretFields(input, 'account routing domain input')
    assertExactKeys(input, ['provider', 'accountId', 'routingDomain'], [], 'account routing domain input')
    const provider = normalizeProvider(input.provider)
    const accountId = normalizeAccountId(input.accountId)
    const requestedDomain = input.routingDomain === null ? null : normalizeRoutingDomain(input.routingDomain)
    return this.#mutate((snapshot, timestamp) => {
      const account = requireAccountBySlug(snapshot, provider, accountId)
      if (account.driver === 'api' && requestedDomain === null) {
        throw invalidError('Public API accounts require a routing domain.')
      }
      if (account.routingDomain === requestedDomain) return { changed: false, value: cloneAccount(account) }
      if (snapshot.bindings.some((binding) => binding.accountInternalId === account.internalId)) {
        throw new AccountPoolError(
          'account_pool_bound_account',
          'An account routing domain cannot change while project bindings reference it.',
        )
      }
      const updated: AccountRecord = { ...account, routingDomain: requestedDomain, updatedAt: timestamp }
      replaceAccount(snapshot, updated)
      appendAuditEvent(snapshot, timestamp, {
        action: 'account_routing_domain_changed',
        provider,
        accountId,
        previousRoutingDomain: account.routingDomain,
        routingDomain: requestedDomain,
      })
      return { changed: true, value: cloneAccount(updated) }
    })
  }

  async #setAccountEnabled(reference: AccountReference, enabled: boolean): Promise<AccountRecord> {
    const provider = normalizeProvider(reference.provider)
    const accountId = normalizeAccountId(reference.accountId)
    return this.#mutate((snapshot, timestamp) => {
      const account = requireAccountBySlug(snapshot, provider, accountId)
      if (account.enabled === enabled) return { changed: false, value: cloneAccount(account) }
      const updated: AccountRecord = { ...account, enabled, updatedAt: timestamp }
      replaceAccount(snapshot, updated)
      appendAuditEvent(snapshot, timestamp, {
        action: enabled ? 'account_enabled' : 'account_disabled',
        provider,
        accountId,
      })
      return { changed: true, value: cloneAccount(updated) }
    })
  }

  #newInternalId(snapshot: MutableAccountPoolSnapshot) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = requireCanonicalUuid(this.#randomUUID())
      if (!snapshot.accounts.some((account) => account.internalId === candidate)) return candidate
    }
    throw new AccountPoolError('account_pool_conflict', 'Could not allocate a unique internal account id.')
  }

  async #mutate<T>(
    operation: (
      snapshot: MutableAccountPoolSnapshot,
      timestamp: string,
    ) => { changed: boolean; value: T },
  ): Promise<T> {
    return this.#serialize(this.stateFile, async () => {
      const current = await readSnapshotFile(this.homeDir, this.stateFile)
      const snapshot = mutableSnapshot(current)
      const timestamp = requireTimestamp(this.#now().toISOString())
      const result = operation(snapshot, timestamp)
      if (!result.changed) return cloneValue(result.value)
      snapshot.protocol = ACCOUNT_POOL_PROTOCOL
      snapshot.revision = current.revision + 1
      snapshot.updatedAt = timestamp
      const next = canonicalSnapshot(snapshot)
      validateSnapshot(next)
      await writeSnapshotAtomic(this.homeDir, this.stateFile, next)
      return cloneValue(result.value)
    })
  }
}

type MutableAccountPoolSnapshot = {
  protocol: AccountPoolProtocol
  revision: number
  updatedAt: string | null
  accounts: AccountRecord[]
  bindings: ProjectBinding[]
  audit: AccountPoolAuditLog
}

function emptySnapshot(): AccountPoolSnapshot {
  return {
    protocol: ACCOUNT_POOL_PROTOCOL,
    revision: 0,
    updatedAt: null,
    accounts: [],
    bindings: [],
    audit: emptyAuditLog(),
  }
}

async function readSnapshotFile(homeDir: string, stateFile: string): Promise<AccountPoolSnapshot> {
  const stateDirectory = path.dirname(stateFile)
  const directoryStat = await lstatOrNull(stateDirectory)
  if (directoryStat === null) return emptySnapshot()
  assertSecureDirectory(directoryStat, 'Tokenless direct state directory')

  const registryStat = await lstatOrNull(stateFile)
  if (registryStat === null) return emptySnapshot()
  assertSecureFile(registryStat, 'Tokenless account pool registry')

  let handle: fs.FileHandle | undefined
  try {
    const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0
    handle = await fs.open(stateFile, fsConstants.O_RDONLY | noFollow)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptySnapshot()
    if (error instanceof AccountPoolError) throw error
    throw new AccountPoolError('account_pool_unreadable', 'Cannot open the Tokenless account pool registry.')
  }

  try {
    const stat = await handle.stat()
    assertSecureFile(stat, 'Tokenless account pool registry')
    if (stat.size > MAX_REGISTRY_BYTES) {
      throw invalidError('Tokenless account pool registry exceeds the size limit.')
    }
    const contents = await handle.readFile({ encoding: 'utf8' })
    let payload: unknown
    try {
      payload = JSON.parse(contents) as unknown
    } catch {
      throw invalidError('Tokenless account pool registry is not valid JSON.')
    }
    rejectSecretFields(payload)
    return validateSnapshot(payload)
  } catch (error) {
    if (error instanceof AccountPoolError) throw error
    throw new AccountPoolError('account_pool_unreadable', 'Cannot read the Tokenless account pool registry.')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function writeSnapshotAtomic(homeDir: string, stateFile: string, snapshot: AccountPoolSnapshot) {
  const stateDirectory = path.dirname(stateFile)
  await ensureSecureDirectory(homeDir)
  await ensureSecureDirectory(stateDirectory)
  const temporary = path.join(
    stateDirectory,
    `.account-pool.${process.pid}.${createRandomUUID()}.tmp`,
  )
  let handle: fs.FileHandle | undefined
  try {
    const encoded = `${JSON.stringify(snapshot, null, 2)}\n`
    if (Buffer.byteLength(encoded, 'utf8') > MAX_REGISTRY_BYTES) {
      throw invalidError('Tokenless account pool registry exceeds the size limit.')
    }
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    await handle.writeFile(encoded, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, stateFile)
    const directoryHandle = await fs.open(stateDirectory, fsConstants.O_RDONLY)
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    if (error instanceof AccountPoolError) throw error
    throw new AccountPoolError('account_pool_unreadable', 'Cannot persist the Tokenless account pool registry.')
  }
}

async function ensureSecureDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const before = await fs.lstat(directory)
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new AccountPoolError('account_pool_permission_denied', 'Tokenless state path must be a real directory.')
  }
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700)
  assertSecureDirectory(await fs.lstat(directory), 'Tokenless state directory')
}

async function lstatOrNull(file: string) {
  try {
    return await fs.lstat(file)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw new AccountPoolError('account_pool_unreadable', 'Cannot inspect the Tokenless account pool path.')
  }
}

function assertSecureDirectory(stat: Awaited<ReturnType<typeof fs.lstat>>, name: string) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AccountPoolError('account_pool_permission_denied', `${name} must be a real directory.`)
  }
  assertCurrentUserAndPrivateMode(stat, name, 0o077)
}

function assertSecureFile(stat: Awaited<ReturnType<fs.FileHandle['stat']>>, name: string) {
  if (!stat.isFile()) {
    throw new AccountPoolError('account_pool_permission_denied', `${name} must be a regular file.`)
  }
  if (Number(stat.nlink) !== 1) {
    throw new AccountPoolError('account_pool_permission_denied', `${name} must not have hard links.`)
  }
  assertCurrentUserAndPrivateMode(stat, name, 0o077)
}

function assertCurrentUserAndPrivateMode(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  name: string,
  forbiddenMode: number,
) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new AccountPoolError('account_pool_permission_denied', `${name} must be owned by the current user.`)
  }
  if (process.platform !== 'win32' && (Number(stat.mode) & forbiddenMode) !== 0) {
    throw new AccountPoolError('account_pool_permission_denied', `${name} permissions are too broad.`)
  }
}

function validateSnapshot(payload: unknown): AccountPoolSnapshot {
  if (!isJsonRecord(payload)) throw invalidError('Account pool registry must be an object.')
  const commonKeys = ['protocol', 'revision', 'updatedAt', 'accounts', 'bindings']
  let legacyInput: boolean
  if (payload.protocol === ACCOUNT_POOL_PROTOCOL) {
    assertExactKeys(payload, [...commonKeys, 'audit'], [], 'registry')
    legacyInput = false
  } else if (payload.protocol === LEGACY_ACCOUNT_POOL_PROTOCOL) {
    assertExactKeys(payload, commonKeys, [], 'legacy registry')
    legacyInput = true
  } else {
    throw new AccountPoolError(
      'account_pool_unsupported_protocol',
      'Tokenless account pool registry protocol is unsupported.',
    )
  }
  const revision = boundedInteger(payload.revision, undefined, 0, Number.MAX_SAFE_INTEGER, 'registry revision')
  const updatedAt = payload.updatedAt === null ? null : requireTimestamp(payload.updatedAt)
  if ((revision === 0) !== (updatedAt === null)) {
    throw invalidError('Registry revision and updated timestamp are inconsistent.')
  }
  if (!Array.isArray(payload.accounts) || !Array.isArray(payload.bindings)) {
    throw invalidError('Registry accounts and bindings must be arrays.')
  }
  if (revision === 0 && (payload.accounts.length > 0 || payload.bindings.length > 0)) {
    throw invalidError('An uninitialized registry cannot contain records.')
  }

  if (legacyInput) requireCoherentLegacyAccountShape(payload.accounts)
  const accounts = payload.accounts.map((value, index) => validateAccount(value, index, legacyInput))
  const bindings = payload.bindings.map((value, index) => validateBinding(value, index))
  const audit = legacyInput ? legacyAuditLog(revision) : validateAuditLog(payload.audit)
  if (revision === 0 && audit.events.length > 0) {
    throw invalidError('An uninitialized registry cannot contain audit events.')
  }
  if (
    updatedAt !== null &&
    audit.events.some((event) => Date.parse(event.timestamp) > Date.parse(updatedAt))
  ) {
    throw invalidError('Registry audit contains an event newer than the registry update timestamp.')
  }
  const slugs = new Set<string>()
  const internalIds = new Set<string>()
  const credentialEnvironments = new Set<string>()
  const fingerprints = new Set<string>()
  for (const account of accounts) {
    const slugKey = `${account.provider}\0${account.accountId}`
    if (slugs.has(slugKey)) throw invalidError('Registry contains duplicate provider account ids.')
    if (internalIds.has(account.internalId)) throw invalidError('Registry contains duplicate internal account ids.')
    slugs.add(slugKey)
    internalIds.add(account.internalId)
    if (account.driver === 'api') {
      if (credentialEnvironments.has(account.credentialEnv)) {
        throw invalidError('Registry contains duplicate API credential environment names.')
      }
      credentialEnvironments.add(account.credentialEnv)
    } else if (account.identityFingerprint !== undefined) {
      if (fingerprints.has(account.identityFingerprint)) {
        throw invalidError('Registry contains duplicate Codex identity fingerprints.')
      }
      fingerprints.add(account.identityFingerprint)
    }
  }

  const bindingKeys = new Set<string>()
  for (const binding of bindings) {
    const bindingKey = `${binding.projectId}\0${binding.provider}`
    if (bindingKeys.has(bindingKey)) throw invalidError('Registry contains duplicate project/provider bindings.')
    bindingKeys.add(bindingKey)
    const account = accounts.find((candidate) => candidate.internalId === binding.accountInternalId)
    if (account === undefined) throw invalidError('Registry contains a dangling project binding.')
    if (account.provider !== binding.provider) throw invalidError('Project binding provider does not match its account.')
    if (account.status !== 'ready') throw invalidError('Project binding targets a pending account.')
    const expectedDomain = account.routingDomain
    if (binding.routingDomain !== expectedDomain) {
      throw invalidError('Project binding routing domain does not match its account.')
    }
  }
  return canonicalSnapshot({ protocol: ACCOUNT_POOL_PROTOCOL, revision, updatedAt, accounts, bindings, audit })
}

function requireCoherentLegacyAccountShape(accounts: unknown[]): void {
  for (const [index, account] of accounts.entries()) {
    if (!isJsonRecord(account)) continue
    if (Object.hasOwn(account, 'health')) {
      throw invalidError(`Legacy account ${index} cannot contain current-format health state without audit metadata.`)
    }
    if (account.driver === 'official-codex' && Object.hasOwn(account, 'routingDomain')) {
      throw invalidError(`Legacy Codex account ${index} cannot contain a routing domain without audit metadata.`)
    }
  }
}

function validateAccount(value: unknown, index: number, allowMissingHealth: boolean): AccountRecord {
  if (!isJsonRecord(value)) throw invalidError(`Account ${index} must be an object.`)
  const driver = value.driver
  const common = [
    'provider',
    'accountId',
    'internalId',
    'driver',
    'status',
    'enabled',
    'maxConcurrency',
    'createdAt',
    'updatedAt',
  ]
  if (driver === 'official-codex') {
    assertExactKeys(value, common, ['health', 'identityFingerprint', 'label', 'routingDomain'], `account ${index}`)
  } else if (driver === 'api') {
    assertExactKeys(value, [...common, 'credentialEnv', 'routingDomain'], ['health', 'label'], `account ${index}`)
  } else {
    throw invalidError(`Account ${index} has an unsupported driver.`)
  }

  const provider = requireCanonicalProvider(value.provider)
  const accountId = requireCanonicalAccountId(value.accountId)
  const internalId = requireCanonicalUuid(value.internalId)
  const enabled = requireBoolean(value.enabled, `Account ${index} enabled`)
  const label = value.label === undefined ? undefined : requireCanonicalLabel(value.label)
  const createdAt = requireTimestamp(value.createdAt)
  const updatedAt = requireTimestamp(value.updatedAt)
  if (value.health === undefined && !allowMissingHealth) {
    throw invalidError(`Account ${index} health is required in the current registry format.`)
  }
  const health = value.health === undefined ? usableHealth() : validateAccountHealth(value.health, index)
  if (health.state === 'unavailable') requireUnavailableReasonForDriver(driver, health.reason)
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw invalidError(`Account ${index} timestamps are inconsistent.`)
  if (health.state === 'unavailable' && (
    Date.parse(health.observedAt) < Date.parse(createdAt) ||
    Date.parse(health.observedAt) > Date.parse(updatedAt)
  )) {
    throw invalidError(`Account ${index} health timestamp is inconsistent.`)
  }

  if (driver === 'official-codex') {
    if (provider !== 'chatgpt') throw invalidError('Official Codex accounts must use the ChatGPT provider.')
    if (value.status !== 'pending' && value.status !== 'ready') {
      throw invalidError(`Account ${index} has an invalid Codex lifecycle status.`)
    }
    if (value.maxConcurrency !== 1) throw invalidError('Official Codex account concurrency must be one.')
    if (value.status === 'pending' && value.identityFingerprint !== undefined) {
      throw invalidError('Pending Codex accounts cannot have an identity fingerprint.')
    }
    if (value.status === 'ready' && value.identityFingerprint === undefined) {
      throw invalidError('Ready Codex accounts require an identity fingerprint.')
    }
    const routingDomain = value.routingDomain === undefined || value.routingDomain === null
      ? null
      : requireCanonicalRoutingDomain(value.routingDomain)
    return {
      provider: 'chatgpt',
      accountId,
      internalId,
      driver: 'official-codex',
      status: value.status,
      enabled,
      maxConcurrency: 1,
      health,
      routingDomain,
      ...(label === undefined ? {} : { label }),
      ...(value.identityFingerprint === undefined
        ? {}
        : { identityFingerprint: requireCodexIdentityFingerprint(value.identityFingerprint) }),
      createdAt,
      updatedAt,
    }
  }

  if (value.status !== 'ready') throw invalidError('Public API accounts must be ready.')
  const maxConcurrency = boundedInteger(
    value.maxConcurrency,
    undefined,
    1,
    MAX_API_CONCURRENCY,
    `Account ${index} max concurrency`,
  )
  const routingDomain = requireCanonicalRoutingDomain(value.routingDomain)
  const credentialEnv = value.credentialEnv
  if (credentialEnv !== apiCredentialEnvironmentName(provider, accountId)) {
    throw invalidError(`Account ${index} has a non-canonical credential environment name.`)
  }
  return {
    provider,
    accountId,
    internalId,
    driver: 'api',
    status: 'ready',
    enabled,
    maxConcurrency,
    health,
    ...(label === undefined ? {} : { label }),
    credentialEnv,
    routingDomain,
    createdAt,
    updatedAt,
  }
}

function validateBinding(value: unknown, index: number): ProjectBinding {
  if (!isJsonRecord(value)) throw invalidError(`Binding ${index} must be an object.`)
  assertExactKeys(value, [
    'projectId',
    'provider',
    'accountInternalId',
    'routingDomain',
    'failoverPolicy',
    'assignedBy',
    'generation',
    'createdAt',
    'updatedAt',
  ], [], `binding ${index}`)
  const createdAt = requireTimestamp(value.createdAt)
  const updatedAt = requireTimestamp(value.updatedAt)
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw invalidError(`Binding ${index} timestamps are inconsistent.`)
  return {
    projectId: requireProjectId(value.projectId),
    provider: requireCanonicalProvider(value.provider),
    accountInternalId: requireCanonicalUuid(value.accountInternalId),
    routingDomain: value.routingDomain === null ? null : requireCanonicalRoutingDomain(value.routingDomain),
    failoverPolicy: requireFailoverPolicy(value.failoverPolicy),
    assignedBy: requireBindingAssignment(value.assignedBy),
    generation: boundedInteger(
      value.generation,
      undefined,
      1,
      Number.MAX_SAFE_INTEGER,
      `Binding ${index} generation`,
    ),
    createdAt,
    updatedAt,
  }
}

function validateAccountHealth(value: unknown, accountIndex: number): AccountHealth {
  if (!isJsonRecord(value)) throw invalidError(`Account ${accountIndex} health must be an object.`)
  if (value.state === 'usable') {
    assertExactKeys(value, ['state', 'generation'], [], `account ${accountIndex} health`)
    return usableHealth(boundedInteger(
      value.generation,
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
      `Account ${accountIndex} health generation`,
    ))
  }
  if (value.state === 'unavailable') {
    assertExactKeys(
      value,
      ['state', 'generation', 'reason', 'observedAt'],
      [],
      `account ${accountIndex} health`,
    )
    return {
      state: 'unavailable',
      generation: boundedInteger(
        value.generation,
        undefined,
        1,
        Number.MAX_SAFE_INTEGER,
        `Account ${accountIndex} health generation`,
      ),
      reason: requireUnavailableReason(value.reason),
      observedAt: requireTimestamp(value.observedAt),
    }
  }
  throw invalidError(`Account ${accountIndex} health state is unsupported.`)
}

function validateAuditLog(value: unknown): AccountPoolAuditLog {
  if (!isJsonRecord(value)) throw invalidError('Registry audit must be an object.')
  assertExactKeys(
    value,
    ['droppedThroughSequence', 'nextSequence', 'events'],
    [],
    'registry audit',
  )
  const droppedThroughSequence = boundedInteger(
    value.droppedThroughSequence,
    undefined,
    0,
    Number.MAX_SAFE_INTEGER,
    'audit dropped-through sequence',
  )
  const nextSequence = boundedInteger(
    value.nextSequence,
    undefined,
    1,
    Number.MAX_SAFE_INTEGER,
    'audit next sequence',
  )
  if (!Array.isArray(value.events) || value.events.length > MAX_ACCOUNT_POOL_AUDIT_EVENTS) {
    throw invalidError(`Registry audit must contain at most ${MAX_ACCOUNT_POOL_AUDIT_EVENTS} events.`)
  }
  const events = value.events.map((event, index) => validateAuditEvent(event, index))
  let expected = droppedThroughSequence + 1
  let previousTimestamp = Number.NEGATIVE_INFINITY
  for (const event of events) {
    if (!Number.isSafeInteger(expected) || event.sequence !== expected) {
      throw invalidError('Registry audit event sequences must be contiguous after the dropped prefix.')
    }
    const timestamp = Date.parse(event.timestamp)
    if (timestamp < previousTimestamp) {
      throw invalidError('Registry audit event timestamps must be monotonic.')
    }
    previousTimestamp = timestamp
    expected += 1
  }
  if (expected !== nextSequence) {
    throw invalidError('Registry audit next sequence does not follow its retained events.')
  }
  return { droppedThroughSequence, nextSequence, events }
}

function validateAuditEvent(value: unknown, index: number): AccountPoolAuditEvent {
  if (!isJsonRecord(value)) throw invalidError(`Audit event ${index} must be an object.`)
  const common = ['sequence', 'timestamp', 'action', 'provider', 'accountId']
  const action = requireAuditAction(value.action)
  if (
    action === 'account_added' ||
    action === 'account_removed' ||
    action === 'account_enabled' ||
    action === 'account_disabled'
  ) {
    assertExactKeys(value, common, [], `audit event ${index}`)
  } else if (action === 'account_routing_domain_changed') {
    assertExactKeys(value, [...common, 'previousRoutingDomain', 'routingDomain'], [], `audit event ${index}`)
  } else if (action === 'binding_assigned') {
    assertExactKeys(value, [...common, 'projectId', 'bindingGeneration', 'routingDomain'], [], `audit event ${index}`)
  } else if (action === 'binding_pinned' || action === 'binding_migrated') {
    assertExactKeys(
      value,
      [...common, 'projectId', 'previousAccountId', 'bindingGeneration', 'routingDomain'],
      [],
      `audit event ${index}`,
    )
  } else if (action === 'binding_unpinned') {
    assertExactKeys(value, [...common, 'projectId', 'bindingGeneration', 'routingDomain'], [], `audit event ${index}`)
  } else if (action === 'health_marked_unavailable') {
    assertExactKeys(value, [...common, 'healthGeneration', 'healthReason'], [], `audit event ${index}`)
  } else {
    assertExactKeys(value, [...common, 'healthGeneration'], [], `audit event ${index}`)
  }

  const event: {
    -readonly [Key in keyof AccountPoolAuditEvent]: AccountPoolAuditEvent[Key]
  } = {
    sequence: boundedInteger(
      value.sequence,
      undefined,
      1,
      Number.MAX_SAFE_INTEGER,
      `Audit event ${index} sequence`,
    ),
    timestamp: requireTimestamp(value.timestamp),
    action,
    provider: requireCanonicalProvider(value.provider),
    accountId: requireCanonicalAccountId(value.accountId),
  }
  if (value.projectId !== undefined) event.projectId = requireProjectId(value.projectId)
  if (value.previousAccountId !== undefined) {
    event.previousAccountId = value.previousAccountId === null
      ? null
      : requireCanonicalAccountId(value.previousAccountId)
  }
  if (value.bindingGeneration !== undefined) {
    event.bindingGeneration = boundedInteger(
      value.bindingGeneration,
      undefined,
      1,
      Number.MAX_SAFE_INTEGER,
      `Audit event ${index} binding generation`,
    )
  }
  if (value.routingDomain !== undefined) {
    event.routingDomain = value.routingDomain === null ? null : requireCanonicalRoutingDomain(value.routingDomain)
  }
  if (value.previousRoutingDomain !== undefined) {
    event.previousRoutingDomain = value.previousRoutingDomain === null
      ? null
      : requireCanonicalRoutingDomain(value.previousRoutingDomain)
  }
  if (value.healthGeneration !== undefined) {
    event.healthGeneration = boundedInteger(
      value.healthGeneration,
      undefined,
      1,
      Number.MAX_SAFE_INTEGER,
      `Audit event ${index} health generation`,
    )
  }
  if (value.healthReason !== undefined) event.healthReason = requireUnavailableReason(value.healthReason)
  return event
}

function usableHealth(generation = 0): AccountHealth {
  return { state: 'usable', generation }
}

function emptyAuditLog(): AccountPoolAuditLog {
  return { droppedThroughSequence: 0, nextSequence: 1, events: [] }
}

function legacyAuditLog(revision: number): AccountPoolAuditLog {
  return revision === 0
    ? emptyAuditLog()
    : { droppedThroughSequence: 1, nextSequence: 2, events: [] }
}

function appendAuditEvent(
  snapshot: MutableAccountPoolSnapshot,
  timestamp: string,
  event: Omit<AccountPoolAuditEvent, 'sequence' | 'timestamp'>,
): void {
  if (snapshot.audit.nextSequence >= Number.MAX_SAFE_INTEGER) {
    throw invalidError('Registry audit sequence is exhausted.')
  }
  const appended: AccountPoolAuditEvent = {
    ...event,
    sequence: snapshot.audit.nextSequence,
    timestamp,
  }
  const events = [...snapshot.audit.events.map(cloneAuditEvent), appended]
  let droppedThroughSequence = snapshot.audit.droppedThroughSequence
  while (events.length > MAX_ACCOUNT_POOL_AUDIT_EVENTS) {
    const removed = events.shift()
    if (removed === undefined) throw invalidError('Registry audit pruning failed.')
    droppedThroughSequence = removed.sequence
  }
  snapshot.audit = {
    droppedThroughSequence,
    nextSequence: snapshot.audit.nextSequence + 1,
    events,
  }
}

function appendMigrationAudit(
  snapshot: MutableAccountPoolSnapshot,
  timestamp: string,
  current: ProjectBinding,
  currentAccount: AccountRecord,
  nextAccount: AccountRecord,
  migrated: ProjectBinding,
): void {
  appendAuditEvent(snapshot, timestamp, {
    action: 'binding_migrated',
    provider: migrated.provider,
    accountId: nextAccount.accountId,
    previousAccountId: currentAccount.accountId,
    projectId: migrated.projectId,
    bindingGeneration: migrated.generation,
    routingDomain: current.routingDomain,
  })
}

function requireAutomaticMigrationDomain(
  binding: ProjectBinding,
  account: AccountRecord,
): string {
  if (binding.routingDomain === null || account.routingDomain === null) {
    throw new AccountPoolError(
      'account_pool_routing_domain_mismatch',
      'Isolated accounts without a routing domain cannot migrate automatically.',
    )
  }
  if (binding.routingDomain !== account.routingDomain) {
    throw new AccountPoolError(
      'account_pool_routing_domain_mismatch',
      'The current account and project binding routing domains differ.',
    )
  }
  return binding.routingDomain
}

function requireAttemptedAccountIds(value: readonly string[] | undefined): Set<string> {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.length > MAX_MIGRATION_ATTEMPTS) {
    throw invalidError(`Attempted account ids must contain at most ${MAX_MIGRATION_ATTEMPTS} entries.`)
  }
  const attempted = new Set<string>()
  for (const entry of value) {
    const internalId = requireCanonicalUuid(entry)
    if (attempted.has(internalId)) throw invalidError('Attempted account ids must be unique.')
    attempted.add(internalId)
  }
  return attempted
}

function rejectSecretFields(value: unknown, location = 'registry') {
  const pending: Array<{ value: unknown; location: string; depth: number }> = [
    { value, location, depth: 0 },
  ]
  const seen = new WeakSet<object>()
  let scannedNodes = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    scannedNodes += 1
    if (scannedNodes > MAX_SECRET_FIELD_SCAN_NODES) {
      throw invalidError('Secret-field validation exceeds the input node limit.')
    }
    if (current.value === null || typeof current.value !== 'object') continue
    if (seen.has(current.value)) {
      throw invalidError('Secret-field validation requires acyclic JSON-compatible input.')
    }
    seen.add(current.value)

    let entries: [string, unknown][]
    try {
      entries = Object.entries(current.value)
    } catch {
      throw invalidError('Secret-field validation cannot inspect the input object.')
    }
    for (const [key, child] of entries) {
      scannedNodes += 1
      if (scannedNodes > MAX_SECRET_FIELD_SCAN_NODES) {
        throw invalidError('Secret-field validation exceeds the input node limit.')
      }
      const childLocation = `${current.location}.${key}`
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (FORBIDDEN_SECRET_FIELD_NAMES.has(normalized)) {
        throw new AccountPoolError(
          'account_pool_secret_field_forbidden',
          `Secret-bearing field ${childLocation} is forbidden in the account pool registry.`,
        )
      }
      if (child !== null && typeof child === 'object') {
        if (current.depth >= MAX_SECRET_FIELD_SCAN_DEPTH) {
          throw invalidError('Secret-field validation exceeds the input depth limit.')
        }
        pending.push({ value: child, location: childLocation, depth: current.depth + 1 })
      }
    }
  }
}

function selectRendezvousAccount<T extends AccountRecord>(
  candidates: T[],
  projectId: string,
  provider: DirectProvider,
  routingDomain: string,
): T | undefined {
  let selected: T | undefined
  let selectedScore: Buffer | undefined
  for (const candidate of candidates) {
    const hash = createHash('sha256')
    for (const value of [projectId, provider, routingDomain, candidate.internalId]) {
      const bytes = Buffer.from(value, 'utf8')
      const length = Buffer.allocUnsafe(4)
      length.writeUInt32BE(bytes.length)
      hash.update(length)
      hash.update(bytes)
    }
    const score = hash.digest()
    if (
      selectedScore === undefined ||
      Buffer.compare(score, selectedScore) > 0 ||
      (Buffer.compare(score, selectedScore) === 0 && candidate.internalId > (selected?.internalId ?? ''))
    ) {
      selected = candidate
      selectedScore = score
    }
  }
  return selected
}

function resolution(
  snapshotRevision: number,
  binding: ProjectBinding,
  account: AccountRecord,
): AccountResolution {
  return {
    snapshotRevision,
    binding: cloneBinding(binding),
    account: cloneAccount(account),
  }
}

function findAccountBySlug(
  snapshot: Pick<AccountPoolSnapshot, 'accounts'>,
  provider: DirectProvider,
  accountId: string,
) {
  return snapshot.accounts.find((account) => account.provider === provider && account.accountId === accountId)
}

function requireAccountBySlug(
  snapshot: Pick<AccountPoolSnapshot, 'accounts'>,
  provider: DirectProvider,
  accountId: string,
) {
  const account = findAccountBySlug(snapshot, provider, accountId)
  if (account === undefined) {
    throw new AccountPoolError('account_pool_not_found', `Account ${provider}/${accountId} was not found.`)
  }
  return account
}

function requireAccountByInternalId(
  snapshot: Pick<AccountPoolSnapshot, 'accounts'>,
  internalId: string,
) {
  const account = snapshot.accounts.find((candidate) => candidate.internalId === internalId)
  if (account === undefined) throw invalidError('Project binding references an unknown account.')
  return account
}

function findBinding(
  snapshot: Pick<AccountPoolSnapshot, 'bindings'>,
  projectId: string,
  provider: DirectProvider,
) {
  return snapshot.bindings.find((binding) => binding.projectId === projectId && binding.provider === provider)
}

function replaceAccount(snapshot: MutableAccountPoolSnapshot, replacement: AccountRecord) {
  snapshot.accounts = snapshot.accounts.map((account) => (
    account.internalId === replacement.internalId ? replacement : account
  ))
}

function replaceBinding(snapshot: MutableAccountPoolSnapshot, replacement: ProjectBinding) {
  const index = snapshot.bindings.findIndex((binding) => (
    binding.projectId === replacement.projectId && binding.provider === replacement.provider
  ))
  if (index === -1) snapshot.bindings.push(replacement)
  else snapshot.bindings[index] = replacement
}

function requireRoutableAccount(account: AccountRecord) {
  if (account.status !== 'ready') {
    throw new AccountPoolError('account_pool_conflict', 'Pending accounts cannot receive project bindings.')
  }
  if (!account.enabled) {
    throw new AccountPoolError('account_pool_conflict', 'Disabled accounts cannot receive new project bindings.')
  }
  if (account.health.state !== 'usable') {
    throw new AccountPoolError('account_pool_conflict', 'Unavailable accounts cannot receive new project bindings.')
  }
}

function canonicalSnapshot(snapshot: MutableAccountPoolSnapshot): AccountPoolSnapshot {
  return {
    protocol: ACCOUNT_POOL_PROTOCOL,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    accounts: snapshot.accounts.map(cloneAccount).sort((left, right) => (
      left.provider.localeCompare(right.provider) || left.accountId.localeCompare(right.accountId)
    )),
    bindings: snapshot.bindings.map(cloneBinding).sort((left, right) => (
      left.projectId.localeCompare(right.projectId) || left.provider.localeCompare(right.provider)
    )),
    audit: cloneAuditLog(snapshot.audit),
  }
}

function mutableSnapshot(snapshot: AccountPoolSnapshot): MutableAccountPoolSnapshot {
  return {
    protocol: snapshot.protocol,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    accounts: snapshot.accounts.map(cloneAccount),
    bindings: snapshot.bindings.map(cloneBinding),
    audit: cloneAuditLog(snapshot.audit),
  }
}

function cloneSnapshot(snapshot: AccountPoolSnapshot): AccountPoolSnapshot {
  return canonicalSnapshot(mutableSnapshot(snapshot))
}

function cloneAccount<T extends AccountRecord>(account: T): T {
  return { ...account, health: { ...account.health } } as T
}

function cloneBinding(binding: ProjectBinding): ProjectBinding {
  return { ...binding }
}

function cloneAuditEvent(event: AccountPoolAuditEvent): AccountPoolAuditEvent {
  return { ...event }
}

function cloneAuditLog(audit: AccountPoolAuditLog): AccountPoolAuditLog {
  return {
    droppedThroughSequence: audit.droppedThroughSequence,
    nextSequence: audit.nextSequence,
    events: audit.events.map(cloneAuditEvent),
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function normalizeProvider(value: unknown): DirectProvider {
  if (typeof value !== 'string') throw invalidError('Provider must be a string.')
  const normalized = value.trim().toLowerCase()
  if (!PROVIDERS.includes(normalized as DirectProvider)) throw invalidError('Provider is unsupported.')
  return normalized as DirectProvider
}

function requireCanonicalProvider(value: unknown) {
  const provider = normalizeProvider(value)
  if (value !== provider) throw invalidError('Provider id is not canonical.')
  return provider
}

function requireCanonicalAccountId(value: unknown) {
  const accountId = normalizeAccountId(value)
  if (value !== accountId) throw invalidError('Account id is not canonical.')
  return accountId
}

function requireCanonicalRoutingDomain(value: unknown) {
  const routingDomain = normalizeRoutingDomain(value)
  if (value !== routingDomain) throw invalidError('Routing domain is not canonical.')
  return routingDomain
}

function requireProjectId(value: unknown) {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw invalidError('Project id must be an exact 1-128 character URL-safe identifier.')
  }
  return value
}

function requireCanonicalUuid(value: unknown) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidError('Internal account id must be a canonical lowercase UUIDv4.')
  }
  return value
}

function requireCodexIdentityFingerprint(value: unknown) {
  if (typeof value !== 'string' || !CODEX_IDENTITY_FINGERPRINT_PATTERN.test(value)) {
    throw invalidError('Codex identity fingerprint has an invalid format.')
  }
  return value
}

function normalizeOptionalLabel(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidError('Account label must be a string.')
  const normalized = value.trim()
  if (
    normalized.length < 1 ||
    normalized.length > MAX_LABEL_CHARACTERS ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw invalidError(`Account label must be 1-${MAX_LABEL_CHARACTERS} printable characters.`)
  }
  return normalized
}

function requireCanonicalLabel(value: unknown) {
  const label = normalizeOptionalLabel(value)
  if (value !== label || label === undefined) throw invalidError('Account label is not canonical.')
  return label
}

function requireTimestamp(value: unknown) {
  if (typeof value !== 'string') throw invalidError('Timestamp must be a string.')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalidError('Timestamp must be a canonical ISO-8601 UTC timestamp.')
  }
  return value
}

function requireBoolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw invalidError(`${name} must be a boolean.`)
  return value
}

function requireFailoverPolicy(value: unknown): ProjectFailoverPolicy {
  if (value !== 'availability-first' && value !== 'strict') {
    throw invalidError('Project failover policy is unsupported.')
  }
  return value
}

function requireUnavailableReason(value: unknown): AccountUnavailableReason {
  if (
    value !== 'api_credential_invalid' &&
    value !== 'api_credential_missing' &&
    value !== 'api_credential_rejected' &&
    value !== 'codex_no_account' &&
    value !== 'codex_not_chatgpt' &&
    value !== 'codex_identity_unverifiable' &&
    value !== 'codex_identity_mismatch' &&
    value !== 'codex_profile_unsafe'
  ) {
    throw invalidError('Account unavailability reason is unsupported.')
  }
  return value
}

function requireUnavailableReasonForDriver(
  driver: AccountRecord['driver'],
  reason: AccountUnavailableReason,
): void {
  const apiReason = (
    reason === 'api_credential_invalid' ||
    reason === 'api_credential_missing' ||
    reason === 'api_credential_rejected'
  )
  if ((driver === 'api') !== apiReason) {
    throw invalidError('Account unavailability reason is incompatible with its account driver.')
  }
}

function requireAuditAction(value: unknown): AccountPoolAuditAction {
  if (
    value !== 'account_added' &&
    value !== 'account_removed' &&
    value !== 'account_enabled' &&
    value !== 'account_disabled' &&
    value !== 'account_routing_domain_changed' &&
    value !== 'binding_assigned' &&
    value !== 'binding_pinned' &&
    value !== 'binding_migrated' &&
    value !== 'binding_unpinned' &&
    value !== 'health_marked_unavailable' &&
    value !== 'health_cleared'
  ) {
    throw invalidError('Account pool audit action is unsupported.')
  }
  return value
}

function requireBindingAssignment(value: unknown): BindingAssignment {
  if (value !== 'automatic' && value !== 'explicit' && value !== 'migration') {
    throw invalidError('Binding assignment type is unsupported.')
  }
  return value
}

function boundedInteger(
  value: unknown,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
  name: string,
) {
  const selected = value === undefined ? fallback : value
  if (!Number.isSafeInteger(selected) || (selected as number) < minimum || (selected as number) > maximum) {
    throw invalidError(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return selected as number
}

function assertExactKeys(
  record: JsonRecord,
  required: string[],
  optional: string[],
  name: string,
) {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidError(`Unknown field ${name}.${key}.`)
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw invalidError(`Missing field ${name}.${key}.`)
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isErrno(error: unknown, code: string) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

function invalidError(message: string) {
  return new AccountPoolError('account_pool_invalid', message)
}
