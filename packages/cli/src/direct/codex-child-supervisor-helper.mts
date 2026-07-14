import { spawn, type ChildProcessWithoutNullStreams, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'

import {
  AccountPoolError,
  AccountPoolStore,
  accountPoolAccountLockPath,
  accountPoolDirectDirectory,
  normalizeAccountId,
  type AccountResolution,
  type CodexAccountRecord,
} from './account-pool.js'
import {
  accountPoolLockPath,
  createSqliteAccountPoolSerialization,
} from './account-pool-lock.js'
import { consumeBoundedLines } from './bounded-line-reader.js'
import {
  CODEX_ACCOUNT_CREDENTIAL_STORE,
  CODEX_IDENTITY_KEY_BYTES,
  CodexProfileError,
  assertManagedCodexHome,
  createManagedCodexHome,
  fingerprintCodexIdentity,
  readCodexIdentityKey,
  readOrCreateCodexIdentityKey,
  managedCodexHome,
  resolveTrustedCodexCommand,
  type CodexAccountObservation,
  type TrustedCodexCommand,
} from './codex-profile.js'
import { runManagedOfficialCodex } from './official-client.js'
import {
  CODEX_SUPERVISOR_PROTOCOL,
  CODEX_SUPERVISOR_MAX_REQUEST_LINE_BYTES,
  CODEX_CHILD_STOP_GRACE_MS,
  CODEX_GROUP_QUIESCENCE_TIMEOUT_MS,
  codexSupervisorLeasePath,
  type CodexSupervisorRequest,
} from './codex-child-supervisor.js'
import { SqliteLockError, withSqliteLocks } from './sqlite-lock.js'

const LEASE_PROTOCOL = 'tokenless.codex-lease.v1'
const MAX_RESPONSE_CONTROL_LINE_BYTES = 4 * 1024 * 1024
const MAX_APP_SERVER_LINE_BYTES = 1024 * 1024
const MAX_APP_SERVER_MESSAGES = 64
const LEASE_RETRY_MS = 25
const MAX_OPERATION_TIMEOUT_MS = 40 * 60_000
const MAX_LOCK_TIMEOUT_MS = 300_000
const trustedSystemTools = new Map<string, Promise<string>>()
const CODEX_ENVIRONMENT_KEYS = new Set([
  'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'LOGNAME', 'OS', 'PATH', 'PATHEXT',
  'PROGRAMDATA', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'USER',
  'USERNAME', 'USERPROFILE', 'WINDIR',
])

type Lease = Readonly<{
  protocol: typeof LEASE_PROTOCOL
  nonce: string
  helperPgid: number
  clientPid: number
  bootId: string
  createdAt: string
}>

class BoundedFrameQueue {
  readonly #frames: string[] = []
  readonly #waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = []
  #error: Error | undefined

  constructor(stream: Readable, maxLineBytes: number, maxLines: number) {
    consumeBoundedLines(stream, {
      maxLineBytes,
      maxLines,
      onLine: (line) => {
        const waiter = this.#waiters.shift()
        if (waiter === undefined) this.#frames.push(line)
        else waiter.resolve(line)
      },
      onError: (error) => this.#fail(error),
      onEnd: () => this.#fail(helperError('codex_supervisor_protocol_error', 'The managed Codex control pipe closed.')),
    })
  }

  next(): Promise<string> {
    const line = this.#frames.shift()
    if (line !== undefined) return Promise.resolve(line)
    if (this.#error !== undefined) return Promise.reject(this.#error)
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }

  #fail(error: Error): void {
    if (this.#error !== undefined) return
    this.#error = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }
}

const control = new net.Socket({ fd: 3, readable: true, writable: true })
const controlFrames = new BoundedFrameQueue(control, CODEX_SUPERVISOR_MAX_REQUEST_LINE_BYTES, 32)

let activeNonce = ''

await main().catch(async (error: unknown) => {
  await writeFrame({
    protocol: CODEX_SUPERVISOR_PROTOCOL,
    type: 'error',
    nonce: activeNonce,
    ...publicError(error),
  }).catch(() => undefined)
  await endControl().catch(() => undefined)
  process.exitCode = 1
})

async function main(): Promise<void> {
  if (process.platform === 'win32') throw helperError('codex_supervisor_unsupported', 'Managed Codex supervision is POSIX-only.')
  const request = await readInitialRequest()
  activeNonce = request.nonce
  await assertExpectedLockSet(request)
  const abortController = new AbortController()
  let activeChild: ChildProcess | undefined
  let dispatched = false
  const abort = () => {
    if (abortController.signal.aborted) return
    abortController.abort()
    if (activeChild?.pid !== undefined && activeChild.exitCode === null && activeChild.signalCode === null) {
      try {
        process.kill(activeChild.pid, 'SIGTERM')
      } catch {
        // Direct child already exited; descendants remain fenced by tombstone.
      }
    }
    setTimeout(() => {
      try {
        process.kill(-process.pid, 'SIGKILL')
      } catch {
        process.abort()
      }
    }, 1_000)
  }
  let watchControl = true
  void (async () => {
    while (watchControl) {
      const line = await controlFrames.next()
      try {
        const message = JSON.parse(line) as unknown
        if (
          isRecord(message) && message.protocol === CODEX_SUPERVISOR_PROTOCOL &&
          message.type === 'abort' && message.nonce === request.nonce
        ) abort()
      } catch {
        // An invalid post-init frame cannot authorize any action.
      }
    }
  })().catch(() => undefined)
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)

  const operationTimer = setTimeout(abort, (2 * request.lockTimeoutMs) + request.operationTimeoutMs)
  operationTimer.unref()
  let result: unknown
  try {
    result = await withSqliteLocks(
      {
        lockFiles: request.lockFiles,
        timeoutMs: request.lockTimeoutMs,
        signal: abortController.signal,
      },
      async () => {
        await establishTombstones(request, abortController.signal)
        await writeFrame({ protocol: CODEX_SUPERVISOR_PROTOCOL, type: 'locked', nonce: request.nonce })
        const trackChild = async <T,>(operation: (setChild: (child: ChildProcess | undefined) => void) => Promise<T>) => {
          throwIfAborted(abortController.signal)
          return operation((child) => { activeChild = child })
        }
        const dispatch = async <T,>(operation: (setChild: (child: ChildProcess | undefined) => void) => Promise<T>) => {
          throwIfAborted(abortController.signal)
          dispatched = true
          await writeFrame({ protocol: CODEX_SUPERVISOR_PROTOCOL, type: 'dispatching', nonce: request.nonce })
          throwIfAborted(abortController.signal)
          return trackChild(operation)
        }
        const markPromptDispatch = async () => {
          throwIfAborted(abortController.signal)
          if (dispatched) throw helperError('codex_supervisor_protocol_error', 'The prompt dispatch boundary was entered twice.')
          dispatched = true
          await writeFrame({ protocol: CODEX_SUPERVISOR_PROTOCOL, type: 'dispatching', nonce: request.nonce })
          throwIfAborted(abortController.signal)
        }
        return runOperation(request, abortController.signal, { dispatch, markPromptDispatch, trackChild })
      },
    )
  } catch (error) {
    const code = errorCode(error)
    const reason = errorReason(error)
    if (
      code === 'codex_supervisor_timeout' || code === 'codex_supervisor_descendant_fenced' ||
      reason === 'codex_account_read_timeout'
    ) abort()
    if (dispatched && error instanceof Error && !('deliveryUnknown' in error)) {
      Object.defineProperty(error, 'deliveryUnknown', { value: true })
    }
    if (dispatched) abort()
    throw error
  } finally {
    clearTimeout(operationTimer)
    watchControl = false
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }

  await writeFrame({
    protocol: CODEX_SUPERVISOR_PROTOCOL,
    type: 'completed',
    nonce: request.nonce,
    result,
  })
  await endControl()
}

async function runOperation(
  request: CodexSupervisorRequest,
  signal: AbortSignal,
  supervision: Readonly<{
    dispatch: <T>(operation: (setChild: (child: ChildProcess | undefined) => void) => Promise<T>) => Promise<T>
    markPromptDispatch: () => Promise<void>
    trackChild: <T>(operation: (setChild: (child: ChildProcess | undefined) => void) => Promise<T>) => Promise<T>
  }>,
): Promise<unknown> {
  const { dispatch, markPromptDispatch, trackChild } = supervision
  if (request.operation === 'inspect-profile') {
    if (request.codexHome === undefined || request.identityKey === undefined) {
      throw helperError('codex_supervisor_invalid', 'Profile inspection parameters are missing.')
    }
    const key = Buffer.from(request.identityKey, 'base64')
    if (key.length !== CODEX_IDENTITY_KEY_BYTES) {
      throw helperError('codex_supervisor_invalid', 'The profile identity key is invalid.')
    }
    const command = await resolveTrustedCodexCommand(request.codexExecutable)
    await assertManagedCodexHome(request.codexHome)
    return dispatch((setChild) => inspectAccount(
      command,
      request.codexHome!,
      key,
      request.environment,
      request.accountReadTimeoutMs ?? request.operationTimeoutMs,
      signal,
      setChild,
    ))
  }

  if (request.accountId === undefined || request.expectedInternalId === undefined) {
    throw helperError('codex_supervisor_invalid', 'Managed account operation parameters are missing.')
  }
  const store = new AccountPoolStore({
    homeDir: request.homeDir,
    serialize: createSqliteAccountPoolSerialization({
      homeDir: request.homeDir,
      timeoutMs: request.lockTimeoutMs,
    }),
  })
  if (request.operation === 'infer-managed') {
    return runManagedInference(request, store, signal, trackChild, markPromptDispatch)
  }
  const account = await requireCodexAccount(store, request.accountId, request.expectedInternalId)
  if (!account.enabled && request.operation === 'inspect-managed') {
    return { account, observation: { state: 'unavailable', reason: 'no_account' } }
  }
  const codexHome = await createManagedCodexHome(request.homeDir, account.internalId)
  const command = await resolveTrustedCodexCommand(request.codexExecutable)

  if (request.operation === 'login-managed') {
    if (account.status !== 'pending') {
      throw helperError(
        'codex_account_login_not_pending',
        'Codex login is allowed only while an account is pending. Identity replacement requires an explicit relink workflow.',
      )
    }
    const identityKey = await identityKeyForSnapshot(store)
    let observation = await dispatch((setChild) => inspectAccount(
      command,
      codexHome,
      identityKey,
      request.environment,
      request.accountReadTimeoutMs ?? Math.min(120_000, request.operationTimeoutMs),
      signal,
      setChild,
    ))
    if (observation.state === 'unavailable') {
      await dispatch((setChild) => runLogin(
        command,
        codexHome,
        request.deviceAuth === true,
        request.environment,
        request.loginTimeoutMs ?? request.operationTimeoutMs,
        signal,
        setChild,
      ))
      await waitForGroupQuiescence(process.pid, Date.now() + CODEX_GROUP_QUIESCENCE_TIMEOUT_MS, signal)
      observation = await dispatch((setChild) => inspectAccount(
        command,
        codexHome,
        identityKey,
        request.environment,
        request.accountReadTimeoutMs ?? Math.min(120_000, request.operationTimeoutMs),
        signal,
        setChild,
      ))
    }
    if (observation.state !== 'ready') {
      throw helperError('codex_account_not_ready', 'The provider-owned login completed without a verifiable ChatGPT account.')
    }
    const finalized = await store.finalizeCodexIdentity({
      provider: 'chatgpt',
      accountId: account.accountId,
      expectedInternalId: account.internalId,
      identityFingerprint: observation.fingerprint,
    })
    return { account: finalized, observation }
  }

  const identityKey = await identityKeyForSnapshot(store)
  const observation = await dispatch((setChild) => inspectAccount(
    command,
    codexHome,
    identityKey,
    request.environment,
    request.accountReadTimeoutMs ?? request.operationTimeoutMs,
    signal,
    setChild,
  ))
  return { account, observation }
}

async function runManagedInference(
  request: CodexSupervisorRequest,
  store: AccountPoolStore,
  signal: AbortSignal,
  trackChild: <T>(operation: (setChild: (child: ChildProcess | undefined) => void) => Promise<T>) => Promise<T>,
  markPromptDispatch: () => Promise<void>,
): Promise<Readonly<{
  textBase64: string
  model?: string | undefined
  usage?: Readonly<{
    inputTokens?: number | undefined
    outputTokens?: number | undefined
    totalTokens?: number | undefined
  }> | undefined
}>> {
  if (
    request.accountId === undefined || request.expectedInternalId === undefined ||
    request.expectedBindingGeneration === undefined || request.expectedIdentityFingerprint === undefined ||
    request.projectId === undefined || request.promptBase64 === undefined || request.inferenceTimeoutMs === undefined
  ) throw helperError('codex_supervisor_invalid', 'Managed inference parameters are missing.')

  const resolution = await store.resolve({ projectId: request.projectId, provider: 'chatgpt' })
  const account = requireCurrentManagedResolution(resolution, request)

  const prompt = decodePrompt(request.promptBase64)
  const codexHome = managedCodexHome(request.homeDir, account.internalId)
  try {
    await assertManagedCodexHome(codexHome)
  } catch (error) {
    if (
      error instanceof CodexProfileError &&
      (error.reason === 'codex_profile_unsafe' || error.reason === 'codex_profile_configuration_forbidden')
    ) {
      throw inferenceUnavailable('profile_invalid')
    }
    throw error
  }
  let identityKey: Buffer
  try {
    identityKey = await readCodexIdentityKey(store.homeDir)
  } catch {
    throw inferenceUnavailable('identity_key_invalid')
  }
  const command = await resolveTrustedCodexCommand(request.codexExecutable)
  const observation = await trackChild((setChild) => inspectAccount(
    command,
    codexHome,
    identityKey,
    request.environment,
    request.accountReadTimeoutMs ?? request.operationTimeoutMs,
    signal,
    setChild,
  ))
  if (observation.state !== 'ready') throw inferenceUnavailable(observation.reason)
  if (observation.fingerprint !== account.identityFingerprint) throw inferenceUnavailable('identity_mismatch')

  let result: Awaited<ReturnType<typeof runManagedOfficialCodex>>
  try {
    result = await trackChild((setChild) => runManagedOfficialCodex({
      command,
      codexHome,
      environment: request.environment,
      prompt,
      ...(request.model === undefined ? {} : { model: request.model }),
      timeoutMs: request.inferenceTimeoutMs!,
      signal,
      setChild,
      dispatchPrompt: (dispatch) => dispatchManagedPrompt(
        store,
        request,
        signal,
        markPromptDispatch,
        dispatch,
      ),
    }))
  } finally {
    await waitForGroupQuiescence(process.pid, Date.now() + CODEX_GROUP_QUIESCENCE_TIMEOUT_MS, signal)
  }
  return Object.freeze({
    textBase64: Buffer.from(result.text, 'utf8').toString('base64'),
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.usage === undefined ? {} : { usage: Object.freeze({ ...result.usage }) }),
  })
}

function requireCurrentManagedResolution(
  resolution: AccountResolution | null,
  request: CodexSupervisorRequest,
): CodexAccountRecord {
  if (resolution === null) throw inferenceUnavailable('binding_missing')
  const { account, binding } = resolution
  if (
    binding.projectId !== request.projectId || binding.provider !== 'chatgpt' ||
    binding.generation !== request.expectedBindingGeneration ||
    binding.accountInternalId !== request.expectedInternalId ||
    account.provider !== 'chatgpt' || account.accountId !== normalizeAccountId(request.accountId) ||
    account.internalId !== request.expectedInternalId
  ) throw inferenceUnavailable('binding_changed')
  if (account.driver !== 'official-codex' || account.status !== 'ready') {
    throw inferenceUnavailable('account_not_ready')
  }
  if (!account.enabled) throw inferenceUnavailable('operator_disabled')
  if (account.health.state !== 'usable') throw inferenceUnavailable('health_unavailable')
  if (
    account.identityFingerprint === undefined ||
    account.identityFingerprint !== request.expectedIdentityFingerprint
  ) throw inferenceUnavailable('identity_changed')
  return account
}

async function dispatchManagedPrompt(
  store: AccountPoolStore,
  request: CodexSupervisorRequest,
  signal: AbortSignal,
  markPromptDispatch: () => Promise<void>,
  dispatch: () => void,
): Promise<void> {
  try {
    await withSqliteLocks({
      lockFiles: [accountPoolLockPath(store.homeDir)],
      timeoutMs: request.lockTimeoutMs,
      signal,
    }, async () => {
      const current = await store.resolve({ projectId: request.projectId!, provider: 'chatgpt' })
      requireCurrentManagedResolution(current, request)
      await markPromptDispatch()
      dispatch()
    })
  } catch (error) {
    if (!(error instanceof SqliteLockError)) throw error
    throw helperError(
      'codex_supervisor_registry_lock_failed',
      'The managed account registry could not be locked at the prompt dispatch boundary.',
      error.code === 'sqlite_lock_timeout',
    )
  }
}

function decodePrompt(encoded: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw helperError('codex_supervisor_protocol_error', 'The managed inference prompt encoding is invalid.')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== encoded) {
    throw helperError('codex_supervisor_protocol_error', 'The managed inference prompt encoding is invalid.')
  }
  let prompt: string
  try {
    prompt = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw helperError('codex_supervisor_protocol_error', 'The managed inference prompt is not valid UTF-8.')
  }
  if (!/\S/u.test(prompt)) throw helperError('codex_supervisor_protocol_error', 'The managed inference prompt is empty.')
  return prompt
}

function inferenceUnavailable(reason: string): Error & { code: string; reason: string; retryable: boolean } {
  return Object.assign(
    new Error('The managed ChatGPT account is unavailable before prompt dispatch.'),
    { code: 'codex_inference_unavailable', reason, retryable: false },
  )
}

async function runLogin(
  command: TrustedCodexCommand,
  codexHome: string,
  deviceAuth: boolean,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal: AbortSignal,
  setChild: (child: ChildProcess | undefined) => void,
): Promise<void> {
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
      detached: false,
      env: codexEnvironment(environment, codexHome),
      stdio: ['inherit', 'inherit', 'inherit'],
    },
  )
  setChild(child)
  try {
    const outcome = await waitForChild(child, timeoutMs, signal)
    if (outcome.code !== 0) {
      throw helperError('codex_account_login_failed', 'The provider-owned Codex login exited unsuccessfully.', true)
    }
  } finally {
    setChild(undefined)
  }
}

async function inspectAccount(
  command: TrustedCodexCommand,
  codexHome: string,
  identityKey: Buffer,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal: AbortSignal,
  setChild: (child: ChildProcess | undefined) => void,
): Promise<CodexAccountObservation> {
  const workingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-codex-account-'))
  const child = spawn(
    command.executable,
    [
      ...command.argsPrefix,
      'app-server',
      '--listen',
      'stdio://',
      '--strict-config',
      '--config',
      `cli_auth_credentials_store="${CODEX_ACCOUNT_CREDENTIAL_STORE}"`,
      '--config',
      'analytics.enabled=false',
    ],
    {
      cwd: workingRoot,
      detached: false,
      env: codexEnvironment(environment, codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as ChildProcessWithoutNullStreams
  setChild(child)
  try {
    const account = await readAccountFromAppServer(child, timeoutMs, signal)
    if (account === null) return Object.freeze({ state: 'unavailable', reason: 'no_account' })
    if (!isRecord(account)) {
      throw profileFailure('codex_account_invalid', 'Codex returned malformed account state.')
    }
    if (account.type === 'apiKey') {
      return Object.freeze({ state: 'unavailable', reason: 'not_chatgpt' })
    }
    if (account.type !== 'chatgpt') {
      throw profileFailure('codex_account_invalid', 'Codex returned an unsupported account type.')
    }
    if (account.email === null || account.email === undefined) {
      return Object.freeze({ state: 'unverifiable', reason: 'identity_missing' })
    }
    if (typeof account.email !== 'string') {
      throw profileFailure('codex_account_invalid', 'Codex returned an invalid ChatGPT account identity.')
    }
    return Object.freeze({
      state: 'ready',
      fingerprint: fingerprintCodexIdentity(account.email, identityKey),
    })
  } finally {
    await stopChild(child)
    setChild(undefined)
    await fs.rm(workingRoot, { recursive: true, force: true, maxRetries: 3 })
    await waitForGroupQuiescence(process.pid, Date.now() + CODEX_GROUP_QUIESCENCE_TIMEOUT_MS, signal)
  }
}

async function readAccountFromAppServer(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let settled = false
    let stderrBytes = 0
    let stopLines: () => void = () => undefined
    const timer = setTimeout(() => finish(profileFailure('codex_account_read_timeout', 'The Codex account identity check timed out.', true)), timeoutMs)
    timer.unref()
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopLines()
      signal.removeEventListener('abort', onAbort)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      if (error === undefined) resolve(value)
      else reject(error)
    }
    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined) finish(profileFailure('codex_account_read_failed', 'The Codex app-server input closed unexpectedly.', true))
      })
    }
    const onAbort = () => finish(profileFailure('codex_account_read_aborted', 'The Codex account identity check was aborted.', true))
    const onError = () => finish(profileFailure('codex_account_read_failed', 'The Codex app-server could not start.', true))
    const onExit = () => finish(profileFailure('codex_account_read_failed', 'The Codex app-server exited before returning account state.', true))
    const onStdinError = () => finish(profileFailure('codex_account_read_failed', 'The Codex app-server input closed unexpectedly.', true))
    child.once('error', onError)
    child.once('exit', onExit)
    child.stdin.once('error', onStdinError)
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_APP_SERVER_LINE_BYTES) finish(profileFailure('codex_account_read_failed', 'The Codex app-server returned oversized diagnostics.', true))
    })
    stopLines = consumeBoundedLines(child.stdout, {
      maxLineBytes: MAX_APP_SERVER_LINE_BYTES,
      maxLines: MAX_APP_SERVER_MESSAGES,
      onLine: (line) => {
      let message: unknown
      try {
        message = JSON.parse(line) as unknown
      } catch {
        finish(profileFailure('codex_account_read_failed', 'The Codex app-server returned invalid JSON.', true))
        return
      }
      if (!isRecord(message)) return
      if (message.id === 0) {
        if (message.error !== undefined || !isRecord(message.result)) {
          finish(profileFailure('codex_account_read_failed', 'The Codex app-server rejected initialization.', true))
          return
        }
        send({ method: 'initialized', params: {} })
        send({ method: 'account/read', id: 1, params: { refreshToken: false } })
      } else if (message.id === 1) {
        if (message.error !== undefined || !isRecord(message.result) || !Object.hasOwn(message.result, 'account')) {
          finish(profileFailure('codex_account_read_failed', 'The Codex app-server returned invalid account state.', true))
          return
        }
        finish(undefined, message.result.account)
      }
      },
      onError: () => finish(profileFailure('codex_account_read_failed', 'The Codex app-server returned oversized or unterminated account data.', true)),
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    if (!settled) send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'tokenless', title: 'Tokenless', version: '0.1.0' } },
    })
  })
}

async function establishTombstones(request: CodexSupervisorRequest, signal: AbortSignal): Promise<void> {
  const bootId = await currentBootId()
  const deadline = Date.now() + request.lockTimeoutMs
  for (const lockFile of [...request.lockFiles].sort(comparePaths)) {
    const leasePath = codexSupervisorLeasePath(lockFile)
    while (true) {
      if (signal.aborted) throw helperError('codex_supervisor_aborted', 'The managed Codex operation was aborted.')
      const existing = await readLease(leasePath)
      if (existing === undefined) break
      if (existing.bootId !== bootId || existing.helperPgid === process.pid || !processGroupAlive(existing.helperPgid)) {
        await removeLease(leasePath, existing)
        break
      }
      if (Date.now() >= deadline) {
        throw helperError('codex_supervisor_fenced', 'A previous managed Codex process group is still alive.', true)
      }
      await delay(LEASE_RETRY_MS, signal)
    }
    const lease: Lease = {
      protocol: LEASE_PROTOCOL,
      nonce: request.nonce,
      helperPgid: process.pid,
      clientPid: request.clientPid,
      bootId,
      createdAt: new Date().toISOString(),
    }
    await writeLeaseAtomic(leasePath, lease)
  }
}

async function readLease(leasePath: string): Promise<Lease | undefined> {
  let pathMetadata: Awaited<ReturnType<typeof fs.lstat>>
  try {
    pathMetadata = await fs.lstat(leasePath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw helperError('codex_supervisor_lease_unsafe', 'Cannot inspect a managed Codex lease tombstone.')
  }
  assertPrivateFile(pathMetadata)
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  let handle: fs.FileHandle | undefined
  let contents: string
  try {
    handle = await fs.open(leasePath, fsConstants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    assertPrivateFile(opened)
    if (opened.dev !== pathMetadata.dev || opened.ino !== pathMetadata.ino) {
      throw helperError('codex_supervisor_lease_unsafe', 'A managed Codex lease tombstone changed while opening.')
    }
    if (Number(opened.size) > 4096) throw helperError('codex_supervisor_lease_unsafe', 'A managed Codex lease tombstone is oversized.')
    contents = await handle.readFile({ encoding: 'utf8' })
    const after = await fs.lstat(leasePath)
    assertPrivateFile(after)
    if (opened.dev !== after.dev || opened.ino !== after.ino) {
      throw helperError('codex_supervisor_lease_unsafe', 'A managed Codex lease tombstone changed while reading.')
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'codex_supervisor_lease_unsafe') throw error
    throw helperError('codex_supervisor_lease_unsafe', 'Cannot securely open a managed Codex lease tombstone.')
  } finally {
    await handle?.close().catch(() => undefined)
  }
  let value: unknown
  try {
    value = JSON.parse(contents) as unknown
  } catch {
    throw helperError('codex_supervisor_lease_unsafe', 'A managed Codex lease tombstone is malformed.')
  }
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'bootId,clientPid,createdAt,helperPgid,nonce,protocol') {
    throw helperError('codex_supervisor_lease_unsafe', 'A managed Codex lease tombstone has an invalid schema.')
  }
  if (
    value.protocol !== LEASE_PROTOCOL ||
    typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce) ||
    !validPid(value.helperPgid) || !validPid(value.clientPid) ||
    typeof value.bootId !== 'string' || value.bootId.length < 8 || value.bootId.length > 256 ||
    typeof value.createdAt !== 'string'
  ) throw helperError('codex_supervisor_lease_unsafe', 'A managed Codex lease tombstone has invalid values.')
  return value as Lease
}

async function writeLeaseAtomic(leasePath: string, lease: Lease): Promise<void> {
  const directory = path.dirname(leasePath)
  const temporary = `${leasePath}.${process.pid}.${lease.nonce}.tmp`
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, leasePath)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw helperError('codex_supervisor_lease_unsafe', 'Cannot persist a managed Codex lease tombstone.')
  }
}

async function removeLease(leasePath: string, expected: Lease): Promise<void> {
  const current = await readLease(leasePath)
  if (current === undefined || JSON.stringify(current) !== JSON.stringify(expected)) {
    throw helperError('codex_supervisor_lease_unsafe', 'A managed Codex lease tombstone changed before reclaim.')
  }
  await fs.unlink(leasePath)
  await syncDirectory(path.dirname(leasePath))
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function assertPrivateFile(metadata: Awaited<ReturnType<typeof fs.lstat>>): void {
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
    (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
    (Number(metadata.mode) & 0o7777) !== 0o600
  ) throw helperError('codex_supervisor_lease_unsafe', 'A managed Codex lease tombstone has unsafe metadata.')
}

async function currentBootId(): Promise<string> {
  if (process.platform === 'linux') {
    const value = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    if (/^[0-9a-f-]{36}$/i.test(value)) return `linux:${value.toLowerCase()}`
  }
  if (process.platform === 'darwin') {
    const output = await runTrustedTool('/usr/sbin/sysctl', ['-n', 'kern.boottime'], 4096)
    const match = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(output)
    if (match !== null) return `darwin:${match[1]}:${match[2]}`
  }
  throw helperError('codex_supervisor_boot_id_failed', 'Cannot establish the current boot identity.')
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false
    if (isErrno(error, 'EPERM')) return true
    throw helperError('codex_supervisor_fence_failed', 'Cannot probe a managed Codex process group.')
  }
}

async function waitForGroupQuiescence(helperPgid: number, deadline: number, signal: AbortSignal): Promise<void> {
  while (true) {
    const members = await processGroupMembers(helperPgid)
    if (members.every((pid) => pid === process.pid)) return
    if (signal.aborted || Date.now() >= deadline) {
      throw helperError('codex_supervisor_descendant_fenced', 'A managed Codex descendant remains alive.', true)
    }
    await delay(LEASE_RETRY_MS, signal)
  }
}

async function processGroupMembers(pgid: number): Promise<number[]> {
  const executable = await resolveTrustedSystemTool('/bin/ps')
  return await new Promise((resolve, reject) => {
    const probe = spawn(executable, ['-ax', '-o', 'pid=,pgid='], {
      detached: false,
      env: { LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    probe.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= 4 * 1024 * 1024) chunks.push(chunk)
      else probe.kill('SIGKILL')
    })
    probe.once('error', () => reject(helperError('codex_supervisor_fence_failed', 'Cannot inspect the managed Codex process group.')))
    probe.once('exit', (code) => {
      if (code !== 0 || bytes > 4 * 1024 * 1024) {
        reject(helperError('codex_supervisor_fence_failed', 'Cannot inspect the managed Codex process group.'))
        return
      }
      const members = Buffer.concat(chunks).toString('utf8').trim().split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (match === null || Number(match[2]) !== pgid) return []
        return [Number(match[1])]
      })
      resolve(members.filter((pid) => pid !== probe.pid))
    })
  })
}

async function runTrustedTool(tool: string, args: readonly string[], maxBytes: number): Promise<string> {
  const executable = await resolveTrustedSystemTool(tool)
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      detached: false,
      env: { LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= maxBytes) chunks.push(chunk)
      else child.kill('SIGKILL')
    })
    child.once('error', () => reject(helperError('codex_supervisor_system_tool_failed', 'A trusted system probe could not start.')))
    child.once('exit', (code) => {
      if (code !== 0 || bytes > maxBytes) {
        reject(helperError('codex_supervisor_system_tool_failed', 'A trusted system probe failed.'))
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
  })
}

function resolveTrustedSystemTool(tool: string): Promise<string> {
  let resolution = trustedSystemTools.get(tool)
  if (resolution !== undefined) return resolution
  resolution = (async () => {
    const canonical = await fs.realpath(tool)
    const metadata = await fs.stat(canonical)
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw helperError('codex_supervisor_system_tool_failed', 'A required system probe is untrusted.')
    }
    await fs.access(canonical, fsConstants.X_OK)
    let directory = path.dirname(canonical)
    while (true) {
      const directoryMetadata = await fs.stat(directory)
      if (!directoryMetadata.isDirectory() || directoryMetadata.uid !== 0 || (directoryMetadata.mode & 0o022) !== 0) {
        throw helperError('codex_supervisor_system_tool_failed', 'A required system probe has an untrusted path.')
      }
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    return canonical
  })()
  trustedSystemTools.set(tool, resolution)
  return resolution
}

async function requireCodexAccount(
  store: AccountPoolStore,
  accountId: string,
  expectedInternalId: string,
): Promise<CodexAccountRecord> {
  const account = (await store.listAccounts({ provider: 'chatgpt' }))
    .find((candidate) => candidate.accountId === normalizeAccountId(accountId))
  if (account === undefined) throw new AccountPoolError('account_pool_not_found', `Account chatgpt/${accountId} was not found.`)
  if (account.driver !== 'official-codex') throw helperError('codex_account_wrong_driver', 'The selected ChatGPT account does not use the official Codex driver.')
  if (account.internalId !== expectedInternalId) throw helperError('codex_account_changed', 'The managed Codex account changed while waiting for its locks.')
  return account
}

async function identityKeyForSnapshot(store: AccountPoolStore): Promise<Buffer> {
  const snapshot = await store.readSnapshot()
  return snapshot.accounts.some((account) => account.driver === 'official-codex' && account.status === 'ready')
    ? readCodexIdentityKey(store.homeDir)
    : readOrCreateCodexIdentityKey(store.homeDir)
}

function codexEnvironment(environment: Readonly<Record<string, string>>, codexHome: string): NodeJS.ProcessEnv {
  return { ...environment, CODEX_HOME: codexHome, CODEX_EXEC_SERVER_URL: 'none' }
}

function waitForChild(child: ChildProcess, timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, result?: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve(result!)
      else reject(error)
    }
    const terminate = () => {
      if (child.pid !== undefined) {
        try { process.kill(child.pid, 'SIGTERM') } catch { /* already exited */ }
      }
    }
    const onAbort = () => {
      terminate()
      finish(helperError('codex_supervisor_aborted', 'The managed Codex operation was aborted.', true))
    }
    const timer = setTimeout(() => {
      terminate()
      finish(helperError('codex_supervisor_timeout', 'The managed Codex child timed out.', true))
    }, timeoutMs)
    timer.unref()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    child.once('error', () => finish(helperError('codex_supervisor_spawn_failed', 'The managed Codex child could not start.', true)))
    child.once('exit', (code, exitSignal) => finish(undefined, { code, signal: exitSignal }))
  })
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.stdin.end()
  let didClose = false
  const closed = new Promise<void>((resolve) => child.once('close', () => {
    didClose = true
    resolve()
  }))
  if (child.pid === undefined) {
    await Promise.race([closed, delayWithoutSignal(CODEX_CHILD_STOP_GRACE_MS)])
    return
  }
  child.kill('SIGTERM')
  const forceTimer = setTimeout(() => child.kill('SIGKILL'), CODEX_CHILD_STOP_GRACE_MS)
  forceTimer.unref()
  await Promise.race([closed, delayWithoutSignal(CODEX_CHILD_STOP_GRACE_MS * 3)])
  clearTimeout(forceTimer)
  if (!didClose) throw helperError('codex_supervisor_descendant_fenced', 'The managed Codex child did not terminate.', true)
}

async function readInitialRequest(): Promise<CodexSupervisorRequest> {
  const timeout = delayWithoutSignal(5_000).then(() => {
    throw helperError('codex_supervisor_protocol_error', 'The managed Codex helper did not receive a request.')
  })
  const line = await Promise.race([controlFrames.next(), timeout])
  let value: unknown
  try { value = JSON.parse(line) as unknown } catch { throw helperError('codex_supervisor_protocol_error', 'The managed Codex request is invalid.') }
  return validateRequest(value)
}

function validateRequest(value: unknown): CodexSupervisorRequest {
  if (!isRecord(value) || value.protocol !== CODEX_SUPERVISOR_PROTOCOL) throw helperError('codex_supervisor_protocol_error', 'The managed Codex protocol is invalid.')
  if (typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce)) throw helperError('codex_supervisor_protocol_error', 'The managed Codex nonce is invalid.')
  if (!validPid(value.clientPid)) throw helperError('codex_supervisor_protocol_error', 'The managed Codex client pid is invalid.')
  if (!['infer-managed', 'inspect-managed', 'inspect-profile', 'login-managed'].includes(String(value.operation))) throw helperError('codex_supervisor_protocol_error', 'The managed Codex operation is invalid.')
  if (
    typeof value.homeDir !== 'string' || value.homeDir.includes('\0') || !path.isAbsolute(value.homeDir) ||
    typeof value.codexExecutable !== 'string' || value.codexExecutable.includes('\0')
  ) throw helperError('codex_supervisor_protocol_error', 'The managed Codex paths are invalid.')
  if (!Array.isArray(value.lockFiles) || value.lockFiles.length < 1 || value.lockFiles.length > 16 || value.lockFiles.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) throw helperError('codex_supervisor_protocol_error', 'The managed Codex lock set is invalid.')
  if (
    !Number.isSafeInteger(value.lockTimeoutMs) || Number(value.lockTimeoutMs) < 0 || Number(value.lockTimeoutMs) > MAX_LOCK_TIMEOUT_MS ||
    !Number.isSafeInteger(value.operationTimeoutMs) || Number(value.operationTimeoutMs) <= 0 || Number(value.operationTimeoutMs) > MAX_OPERATION_TIMEOUT_MS
  ) throw helperError('codex_supervisor_protocol_error', 'The managed Codex timeouts are invalid.')
  if (
    (value.accountReadTimeoutMs !== undefined && (!Number.isSafeInteger(value.accountReadTimeoutMs) || Number(value.accountReadTimeoutMs) <= 0)) ||
    (value.loginTimeoutMs !== undefined && (!Number.isSafeInteger(value.loginTimeoutMs) || Number(value.loginTimeoutMs) <= 0)) ||
    (value.inferenceTimeoutMs !== undefined && (!Number.isSafeInteger(value.inferenceTimeoutMs) || Number(value.inferenceTimeoutMs) <= 0 || Number(value.inferenceTimeoutMs) > 30 * 60_000))
  ) throw helperError('codex_supervisor_protocol_error', 'The managed Codex child timeouts are invalid.')
  if (
    !isRecord(value.environment) ||
    Object.entries(value.environment).some(([key, item]) => !CODEX_ENVIRONMENT_KEYS.has(key) || typeof item !== 'string')
  ) throw helperError('codex_supervisor_protocol_error', 'The managed Codex environment is invalid.')
  const commonRequired = [
    'clientPid', 'codexExecutable', 'environment', 'homeDir', 'lockFiles',
    'lockTimeoutMs', 'nonce', 'operation', 'operationTimeoutMs', 'protocol',
  ]
  const allowedByOperation: Record<string, readonly string[]> = {
    'infer-managed': [
      'accountId', 'accountReadTimeoutMs', 'expectedBindingGeneration', 'expectedIdentityFingerprint',
      'expectedInternalId', 'inferenceTimeoutMs', 'model', 'projectId', 'promptBase64',
    ],
    'inspect-managed': ['accountId', 'accountReadTimeoutMs', 'expectedInternalId'],
    'inspect-profile': ['accountReadTimeoutMs', 'codexHome', 'identityKey'],
    'login-managed': ['accountId', 'accountReadTimeoutMs', 'deviceAuth', 'expectedInternalId', 'loginTimeoutMs'],
  }
  const operationKeys = allowedByOperation[String(value.operation)] ?? []
  if (
    !commonRequired.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => commonRequired.includes(key) || operationKeys.includes(key))
  ) throw helperError('codex_supervisor_protocol_error', 'The managed Codex request schema is invalid.')
  if (value.operation === 'inspect-profile') {
    if (typeof value.codexHome !== 'string' || value.codexHome.includes('\0') || !path.isAbsolute(value.codexHome) || typeof value.identityKey !== 'string') {
      throw helperError('codex_supervisor_protocol_error', 'The managed profile parameters are invalid.')
    }
  } else if (typeof value.accountId !== 'string' || typeof value.expectedInternalId !== 'string') {
    throw helperError('codex_supervisor_protocol_error', 'The managed account parameters are invalid.')
  }
  if (value.operation === 'login-managed' && typeof value.deviceAuth !== 'boolean') {
    throw helperError('codex_supervisor_protocol_error', 'The managed login parameters are invalid.')
  }
  if (value.operation === 'infer-managed' && (
    !Number.isSafeInteger(value.expectedBindingGeneration) || Number(value.expectedBindingGeneration) < 1 ||
    typeof value.expectedIdentityFingerprint !== 'string' ||
    !/^tokenless\.codex-identity\.v1:[A-Za-z0-9_-]{43}$/.test(value.expectedIdentityFingerprint) ||
    typeof value.projectId !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?$/.test(value.projectId) ||
    typeof value.promptBase64 !== 'string' || value.promptBase64.length > 5_592_408 ||
    !Number.isSafeInteger(value.inferenceTimeoutMs) || Number(value.inferenceTimeoutMs) <= 0 ||
    (value.model !== undefined && (
      typeof value.model !== 'string' || value.model.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value.model) ||
      Buffer.byteLength(value.model, 'utf8') > 256
    ))
  )) throw helperError('codex_supervisor_protocol_error', 'The managed inference parameters are invalid.')
  return value as CodexSupervisorRequest
}

async function assertExpectedLockSet(request: CodexSupervisorRequest): Promise<void> {
  const resolvedHome = path.resolve(request.homeDir)
  const canonicalHome = await fs.realpath(resolvedHome)
  if (canonicalHome !== resolvedHome) {
    throw helperError('codex_supervisor_protocol_error', 'The managed Codex home must be canonical.')
  }
  let expected: string[]
  if (request.operation === 'inspect-profile') {
    if (request.codexHome === undefined) throw helperError('codex_supervisor_protocol_error', 'The managed profile path is missing.')
    const codexHome = path.resolve(request.codexHome)
    const profileRoot = path.dirname(codexHome)
    const internalId = path.basename(profileRoot)
    const chatGptRoot = path.dirname(profileRoot)
    const providerRoot = path.dirname(chatGptRoot)
    const directRoot = path.dirname(providerRoot)
    if (
      path.basename(codexHome) !== 'codex' || path.basename(chatGptRoot) !== 'chatgpt' ||
      path.basename(providerRoot) !== 'provider-profiles' || path.basename(directRoot) !== 'direct' ||
      path.dirname(directRoot) !== canonicalHome
    ) throw helperError('codex_supervisor_protocol_error', 'The managed profile path is outside the expected home.')
    expected = [accountPoolAccountLockPath(canonicalHome, 'chatgpt', internalId)]
  } else {
    if (request.expectedInternalId === undefined) throw helperError('codex_supervisor_protocol_error', 'The managed account id is missing.')
    expected = [accountPoolAccountLockPath(canonicalHome, 'chatgpt', request.expectedInternalId)]
    if (request.operation === 'login-managed') {
      expected.push(path.join(accountPoolDirectDirectory(canonicalHome), 'global-locks', 'chatgpt-login.lock'))
    } else if (request.operation === 'infer-managed') {
      expected.push(path.join(accountPoolDirectDirectory(canonicalHome), 'global-locks', 'chatgpt-subscription-inference.lock'))
    }
  }
  const actual = [...request.lockFiles].map((file) => path.resolve(file)).sort(comparePaths)
  expected.sort(comparePaths)
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw helperError('codex_supervisor_protocol_error', 'The managed Codex helper refused an incomplete lock set.')
  }
}

function publicError(error: unknown): Record<string, unknown> {
  if (error instanceof CodexProfileError) {
    return {
      code: error.code,
      reason: error.reason,
      message: error.message,
      retryable: error.retryable,
      ...((error as CodexProfileError & { deliveryUnknown?: unknown }).deliveryUnknown === true ? { deliveryUnknown: true } : {}),
    }
  }
  if (error instanceof SqliteLockError || error instanceof AccountPoolError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  if (error instanceof Error) {
    const details = error as Error & { code?: unknown; reason?: unknown; retryable?: unknown; deliveryUnknown?: unknown }
    return {
      code: typeof details.code === 'string' ? details.code : 'codex_supervisor_failed',
      message: error.message,
      retryable: details.retryable === true,
      ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
      ...(details.deliveryUnknown === true ? { deliveryUnknown: true } : {}),
    }
  }
  return { code: 'codex_supervisor_failed', message: 'The managed Codex operation failed.', retryable: false }
}

function helperError(code: string, message: string, retryable = false): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), { code, retryable })
}

function profileFailure(reason: string, message: string, retryable = false): CodexProfileError {
  return new CodexProfileError(reason, message, retryable)
}

function writeFrame(message: unknown): Promise<void> {
  const line = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(line, 'utf8') > MAX_RESPONSE_CONTROL_LINE_BYTES) return Promise.reject(helperError('codex_supervisor_protocol_error', 'The managed Codex response is oversized.'))
  return new Promise((resolve, reject) => control.write(line, (error) => error === null || error === undefined ? resolve() : reject(error)))
}

function endControl(): Promise<void> {
  return new Promise((resolve) => control.end(resolve))
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds)
    const onAbort = () => finish(helperError('codex_supervisor_aborted', 'The managed Codex operation was aborted.', true))
    function finish(error?: Error) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function delayWithoutSignal(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })
}

function comparePaths(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function errorReason(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'reason' in error && typeof error.reason === 'string'
    ? error.reason
    : undefined
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw helperError('codex_supervisor_aborted', 'The managed Codex operation was aborted.', true)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
