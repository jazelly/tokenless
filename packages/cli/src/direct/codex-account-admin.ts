import { spawn, spawnSync } from 'node:child_process'
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
  CODEX_ACCOUNT_CREDENTIAL_STORE,
  createManagedCodexHome,
  inspectCodexAccount,
  readCodexIdentityKey,
  readOrCreateCodexIdentityKey,
  resolveTrustedCodexCommand,
  type CodexAccountObservation,
  type TrustedCodexCommand,
} from './codex-profile.js'
import { withSqliteLocks } from './sqlite-lock.js'

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000
const MAX_LOGIN_TIMEOUT_MS = 30 * 60_000

const CODEX_LOGIN_ENVIRONMENT = [
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'OS',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const

export type CodexAccountAdminOptions = Readonly<{
  homeDir: string
  codexExecutable?: string | undefined
  lockTimeoutMs?: number | undefined
  loginTimeoutMs?: number | undefined
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
  const codexHome = await createManagedCodexHome(homeDir, account.internalId)
  const [command, identityKey] = await Promise.all([
    resolveTrustedCodexCommand(options.codexExecutable),
    identityKeyForSnapshot(store),
  ])
  const lockFiles = [
    accountPoolAccountLockPath(homeDir, 'chatgpt', account.internalId),
    chatGptLoginLockPath(homeDir),
  ]

  const result = await withSqliteLocks(
    {
      lockFiles,
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    async () => {
      const current = await requireCodexAccount(store, account.accountId)
      if (current.internalId !== account.internalId) {
        throw new CodexAccountAdminError(
          'codex_account_login_not_pending',
          'The pending Codex account reservation changed while login was waiting for its profile lock.',
        )
      }
      requirePendingCodexLogin(current)
      await runCodexLogin({
        command,
        codexHome,
        deviceAuth: options.deviceAuth === true,
        timeoutMs: loginTimeout(options.loginTimeoutMs),
        signal: options.signal,
      })
      const observation = await inspectCodexAccount({
        executable: command.source,
        codexHome,
        identityKey,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (observation.state !== 'ready') {
        throw new CodexAccountAdminError(
          'codex_account_not_ready',
          'The provider-owned login completed without a verifiable ChatGPT account.',
        )
      }
      const finalized = await store.finalizeCodexIdentity({
        provider: 'chatgpt',
        accountId: current.accountId,
        expectedInternalId: current.internalId,
        identityFingerprint: observation.fingerprint,
      })
      return { finalized, observation }
    },
  )
  return statusFromObservation(result.finalized, result.observation)
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
  const codexHome = await createManagedCodexHome(homeDir, account.internalId)
  const [command, identityKey] = await Promise.all([
    resolveTrustedCodexCommand(options.codexExecutable),
    identityKeyForSnapshot(store),
  ])
  const observation = await withSqliteLocks(
    {
      lockFiles: [accountPoolAccountLockPath(homeDir, 'chatgpt', account.internalId)],
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    () => inspectCodexAccount({
      executable: command.source,
      codexHome,
      identityKey,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  )
  return statusFromObservation(account, observation)
}

function statusFromObservation(
  account: CodexAccountRecord,
  observation: CodexAccountObservation,
): CodexAccountStatus {
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

async function identityKeyForSnapshot(store: AccountPoolStore): Promise<Buffer> {
  const snapshot = await store.readSnapshot()
  const hasRegisteredFingerprint = snapshot.accounts.some((account) => (
    account.driver === 'official-codex' && account.status === 'ready'
  ))
  return hasRegisteredFingerprint
    ? readCodexIdentityKey(store.homeDir)
    : readOrCreateCodexIdentityKey(store.homeDir)
}

async function canonicalHome(homeDir: string): Promise<string> {
  const resolved = path.resolve(homeDir)
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
  return fs.realpath(resolved)
}

function runCodexLogin({
  command,
  codexHome,
  deviceAuth,
  timeoutMs,
  signal,
}: {
  command: TrustedCodexCommand
  codexHome: string
  deviceAuth: boolean
  timeoutMs: number
  signal: AbortSignal | undefined
}): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new CodexAccountAdminError(
      'codex_account_login_aborted',
      'The provider-owned Codex login was aborted before launch.',
    ))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      command.executable,
      [
        ...command.argsPrefix,
        'login',
        '--config',
        `cli_auth_credentials_store="${CODEX_ACCOUNT_CREDENTIAL_STORE}"`,
        ...(deviceAuth ? ['--device-auth'] : []),
      ],
      {
        detached: process.platform !== 'win32',
        env: codexLoginEnvironment(process.env, codexHome),
        stdio: ['inherit', process.stderr, process.stderr],
      },
    )
    let settled = false
    let termination: 'aborted' | 'timeout' | undefined
    const timer = setTimeout(() => {
      termination = 'timeout'
      terminateProcessTree(child.pid)
    }, timeoutMs)
    timer.unref()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = () => {
      termination = 'aborted'
      terminateProcessTree(child.pid)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', () => finish(new CodexAccountAdminError(
      'codex_account_login_failed',
      'The provider-owned Codex login could not start.',
      true,
    )))
    child.once('exit', (code) => {
      if (termination === 'aborted') {
        finish(new CodexAccountAdminError('codex_account_login_aborted', 'The provider-owned Codex login was aborted.'))
      } else if (termination === 'timeout') {
        finish(new CodexAccountAdminError('codex_account_login_timeout', 'The provider-owned Codex login timed out.', true))
      } else if (code !== 0) {
        finish(new CodexAccountAdminError(
          'codex_account_login_failed',
          'The provider-owned Codex login exited unsuccessfully.',
          true,
        ))
      } else {
        finish()
      }
    })
  })
}

function codexLoginEnvironment(environment: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const available = new Map<string, string>()
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !available.has(key.toUpperCase())) available.set(key.toUpperCase(), value)
  }
  const result: NodeJS.ProcessEnv = {}
  for (const name of CODEX_LOGIN_ENVIRONMENT) {
    const value = available.get(name)
    if (value !== undefined) result[name] = value
  }
  result.CODEX_HOME = codexHome
  result.CODEX_EXEC_SERVER_URL = 'none'
  return result
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

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 2_000,
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The provider-owned login process already exited.
  }
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
