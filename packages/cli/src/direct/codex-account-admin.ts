import fs from 'node:fs/promises'
import path from 'node:path'

import {
  AccountPoolError,
  AccountPoolStore,
  accountPoolAccountLockPath,
  accountPoolDirectDirectory,
  normalizeAccountId,
  type AccountRecord,
  type CodexAccountRecord,
} from './account-pool.js'
import { createSqliteAccountPoolSerialization } from './account-pool-lock.js'
import {
  createManagedCodexHome,
  resolveTrustedCodexExecutable,
  type CodexAccountObservation,
} from './codex-profile.js'
import {
  CODEX_GROUP_QUIESCENCE_TIMEOUT_MS,
  CODEX_INSPECT_CLEANUP_BUDGET_MS,
  CODEX_SUPERVISOR_FIXED_OVERHEAD_MS,
  codexInspectOperationTimeoutMs,
  runCodexSupervisedOperation,
} from './codex-child-supervisor.js'
import { resolveSqliteLockTimeout } from './sqlite-lock.js'

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000
const MAX_LOGIN_TIMEOUT_MS = 30 * 60_000
const DEFAULT_ACCOUNT_READ_TIMEOUT_MS = 15_000
const MAX_ACCOUNT_READ_TIMEOUT_MS = 120_000

export type CodexAccountAdminOptions = Readonly<{
  homeDir: string
  codexExecutable?: string | undefined
  lockTimeoutMs?: number | undefined
  loginTimeoutMs?: number | undefined
  accountReadTimeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}>

export type CodexAccountHealth =
  | 'disabled'
  | 'healthy'
  | 'identity_mismatch'
  | 'pending'
  | 'unavailable'
  | 'unverifiable'

export type CodexAccountStatus = Readonly<{
  provider: 'chatgpt'
  accountId: string
  enabled: boolean
  lifecycle: 'pending' | 'ready'
  health: CodexAccountHealth
  reason?: string | undefined
}>

export class CodexAccountAdminError extends Error {
  readonly code:
    | 'codex_account_login_aborted'
    | 'codex_account_login_failed'
    | 'codex_account_login_not_pending'
    | 'codex_account_login_timeout'
    | 'codex_account_not_ready'
    | 'codex_account_wrong_driver'
  readonly retryable: boolean

  constructor(code: CodexAccountAdminError['code'], message: string, retryable = false) {
    super(message)
    this.name = 'CodexAccountAdminError'
    this.code = code
    this.retryable = retryable
  }
}

export function createManagedAccountPoolStore(options: {
  homeDir: string
  lockTimeoutMs?: number | undefined
}): AccountPoolStore {
  const homeDir = path.resolve(options.homeDir)
  return new AccountPoolStore({
    homeDir,
    serialize: createSqliteAccountPoolSerialization({
      homeDir,
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
    }),
  })
}

export function chatGptLoginLockPath(homeDir: string): string {
  return path.join(accountPoolDirectDirectory(homeDir), 'global-locks', 'chatgpt-login.lock')
}

export function chatGptInferenceLockPath(homeDir: string): string {
  return path.join(accountPoolDirectDirectory(homeDir), 'global-locks', 'chatgpt-subscription-inference.lock')
}

export async function addManagedCodexAccount(
  input: { accountId: string; label?: string | undefined; enabled?: boolean | undefined },
  options: CodexAccountAdminOptions,
): Promise<CodexAccountRecord> {
  const store = createManagedAccountPoolStore(options)
  let account: CodexAccountRecord
  try {
    account = await store.addCodexAccount(input)
  } catch (error) {
    if (!(error instanceof AccountPoolError) || error.code !== 'account_pool_already_exists') throw error
    const accountId = normalizeAccountId(input.accountId)
    const existing = (await store.listAccounts({ provider: 'chatgpt' }))
      .find((candidate) => candidate.accountId === accountId)
    if (existing === undefined || existing.driver !== 'official-codex' || existing.status !== 'pending') throw error
    account = existing
  }
  // A failed filesystem preparation leaves a pending reservation that this
  // idempotent command can safely resume without allocating another identity.
  await createManagedCodexHome(options.homeDir, account.internalId)
  return account
}

/** Runs provider-owned login, verifies structured identity, then finalizes pending state. */
export async function loginManagedCodexAccount(
  accountId: string,
  options: CodexAccountAdminOptions & { deviceAuth?: boolean | undefined },
): Promise<CodexAccountStatus> {
  const homeDir = await canonicalHome(options.homeDir)
  const store = createManagedAccountPoolStore({ ...options, homeDir })
  const account = await requireCodexAccount(store, accountId)
  requirePendingCodexLogin(account)
  const lockFiles = [
    accountPoolAccountLockPath(homeDir, 'chatgpt', account.internalId),
    chatGptLoginLockPath(homeDir),
  ]
  const loginTimeoutMs = loginTimeout(options.loginTimeoutMs)
  const accountReadTimeoutMs = accountReadTimeout(options.accountReadTimeoutMs)
  const lockTimeoutMs = resolveSqliteLockTimeout(options.lockTimeoutMs)
  const codexExecutable = await resolveTrustedCodexExecutable(options.codexExecutable)
  const result = await runCodexSupervisedOperation<{
    account: CodexAccountRecord
    observation: CodexAccountObservation
  }>({
    operation: 'login-managed',
    homeDir,
    codexExecutable,
    lockFiles,
    lockTimeoutMs,
    operationTimeoutMs: managedCodexLoginOperationTimeoutMs({ loginTimeoutMs, accountReadTimeoutMs, lockTimeoutMs }),
    accountReadTimeoutMs,
    loginTimeoutMs,
    accountId: account.accountId,
    expectedInternalId: account.internalId,
    deviceAuth: options.deviceAuth === true,
    environment: process.env,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return statusFromObservation(result.account, result.observation)
}

export async function inspectManagedCodexAccount(
  accountId: string,
  options: CodexAccountAdminOptions,
): Promise<CodexAccountStatus> {
  const homeDir = await canonicalHome(options.homeDir)
  const store = createManagedAccountPoolStore({ ...options, homeDir })
  const account = await requireCodexAccount(store, accountId)
  if (!account.enabled) {
    return publicStatus(account, 'disabled', 'operator_disabled')
  }
  const codexExecutable = await resolveTrustedCodexExecutable(options.codexExecutable)
  const lockTimeoutMs = resolveSqliteLockTimeout(options.lockTimeoutMs)
  const result = await runCodexSupervisedOperation<{
    account: CodexAccountRecord
    observation: CodexAccountObservation
  }>({
    operation: 'inspect-managed',
    homeDir,
    codexExecutable,
    lockFiles: [
      accountPoolAccountLockPath(homeDir, 'chatgpt', account.internalId),
    ],
    lockTimeoutMs,
    operationTimeoutMs: codexInspectOperationTimeoutMs(accountReadTimeout(options.accountReadTimeoutMs)),
    accountReadTimeoutMs: accountReadTimeout(options.accountReadTimeoutMs),
    accountId: account.accountId,
    expectedInternalId: account.internalId,
    environment: process.env,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return statusFromObservation(result.account, result.observation)
}

function statusFromObservation(
  account: CodexAccountRecord,
  observation: CodexAccountObservation,
): CodexAccountStatus {
  if (!account.enabled) return publicStatus(account, 'disabled', 'operator_disabled')
  if (observation.state === 'unavailable') return publicStatus(account, 'unavailable', observation.reason)
  if (observation.state === 'unverifiable') return publicStatus(account, 'unverifiable', observation.reason)
  if (account.status === 'pending') return publicStatus(account, 'pending', 'identity_not_finalized')
  if (account.identityFingerprint !== observation.fingerprint) {
    return publicStatus(account, 'identity_mismatch', 'identity_changed')
  }
  return publicStatus(account, 'healthy')
}

function publicStatus(
  account: CodexAccountRecord,
  health: CodexAccountHealth,
  reason?: string,
): CodexAccountStatus {
  return {
    provider: 'chatgpt',
    accountId: account.accountId,
    enabled: account.enabled,
    lifecycle: account.status,
    health,
    ...(reason === undefined ? {} : { reason }),
  }
}

async function requireCodexAccount(store: AccountPoolStore, accountId: string): Promise<CodexAccountRecord> {
  const account = (await store.listAccounts({ provider: 'chatgpt' }))
    .find((candidate) => candidate.accountId === normalizeAccountId(accountId))
  if (account === undefined) {
    throw new AccountPoolError('account_pool_not_found', `Account chatgpt/${accountId} was not found.`)
  }
  if (account.driver !== 'official-codex') {
    throw new CodexAccountAdminError(
      'codex_account_wrong_driver',
      'The selected ChatGPT account does not use the official Codex driver.',
    )
  }
  return account
}

function requirePendingCodexLogin(account: CodexAccountRecord): void {
  if (account.status !== 'pending') {
    throw new CodexAccountAdminError(
      'codex_account_login_not_pending',
      'Codex login is allowed only while an account is pending. Identity replacement requires an explicit relink workflow.',
    )
  }
}

async function canonicalHome(homeDir: string): Promise<string> {
  const resolved = path.resolve(homeDir)
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
  return fs.realpath(resolved)
}

function loginTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_LOGIN_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_LOGIN_TIMEOUT_MS) {
    throw new CodexAccountAdminError(
      'codex_account_login_failed',
      `Codex login timeout must be an integer between 1 and ${MAX_LOGIN_TIMEOUT_MS}.`,
    )
  }
  return timeoutMs
}

function accountReadTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_ACCOUNT_READ_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_ACCOUNT_READ_TIMEOUT_MS) {
    throw new CodexAccountAdminError(
      'codex_account_login_failed',
      `Codex account read timeout must be an integer between 1 and ${MAX_ACCOUNT_READ_TIMEOUT_MS}.`,
    )
  }
  return timeoutMs
}

export function managedCodexLoginOperationTimeoutMs(options: {
  loginTimeoutMs: number
  accountReadTimeoutMs: number
  lockTimeoutMs: number
}): number {
  return (
    options.loginTimeoutMs +
    (2 * options.accountReadTimeoutMs) +
    options.lockTimeoutMs +
    (2 * CODEX_INSPECT_CLEANUP_BUDGET_MS) +
    CODEX_GROUP_QUIESCENCE_TIMEOUT_MS +
    CODEX_SUPERVISOR_FIXED_OVERHEAD_MS
  )
}

export function publicAccountRecord(account: AccountRecord): Record<string, unknown> {
  return {
    provider: account.provider,
    accountId: account.accountId,
    driver: account.driver,
    status: account.status,
    enabled: account.enabled,
    maxConcurrency: account.maxConcurrency,
    ...(account.label === undefined ? {} : { label: account.label }),
    ...(account.driver === 'api' ? {
      credentialEnv: account.credentialEnv,
      routingDomain: account.routingDomain,
    } : {}),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }
}
