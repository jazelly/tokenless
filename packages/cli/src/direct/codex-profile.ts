import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import { DirectError } from './types.js'

export const CODEX_ACCOUNT_CREDENTIAL_STORE = 'file' as const
export const CODEX_IDENTITY_FINGERPRINT_VERSION = 'tokenless.codex-identity.v1' as const
export const CODEX_IDENTITY_KEY_BYTES = 32

const APP_SERVER_LINE_BYTES = 1024 * 1024
const APP_SERVER_MESSAGES = 64
const DEFAULT_ACCOUNT_READ_TIMEOUT_MS = 15_000
const INTERNAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ACCOUNT_IDENTITY_MAX_CHARACTERS = 320
const ACCOUNT_IDENTITY_MAX_BYTES = 1024
const MANAGED_PROFILE_FORBIDDEN_ENTRIES = new Set([
  'AGENTS.md',
  'AGENTS.override.md',
  'config.toml',
  'hooks',
  'plugins',
  'rules',
  'skills',
])

const APP_SERVER_ENVIRONMENT = [
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

export type CodexAccountObservation =
  | Readonly<{ state: 'ready'; fingerprint: string }>
  | Readonly<{ state: 'unavailable'; reason: 'no_account' | 'not_chatgpt' }>
  | Readonly<{ state: 'unverifiable'; reason: 'identity_missing' }>

export type InspectCodexAccountOptions = Readonly<{
  executable: string
  codexHome: string
  identityKey: Buffer
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}>

export type TrustedCodexCommand = Readonly<{
  executable: string
  argsPrefix: readonly string[]
  source: string
}>

export class CodexProfileError extends DirectError {
  readonly reason: string

  constructor(reason: string, message: string, retryable = false) {
    super('direct_configuration_error', message, { retryable })
    this.reason = reason
  }

  override toJSON() {
    return { ...super.toJSON(), reason: this.reason }
  }
}

export function directAccountStateDir(homeDir: string): string {
  return path.join(path.resolve(homeDir), 'direct')
}

export function codexIdentityKeyPath(homeDir: string): string {
  return path.join(directAccountStateDir(homeDir), 'identity-hmac.key')
}

export function managedCodexHome(homeDir: string, internalId: string): string {
  assertInternalId(internalId)
  return path.join(directAccountStateDir(homeDir), 'provider-profiles', 'chatgpt', internalId, 'codex')
}

export async function createManagedCodexHome(homeDir: string, internalId: string): Promise<string> {
  if (process.platform === 'win32') {
    throw profileError('codex_unsupported', 'Managed Codex profiles currently support macOS and Linux.')
  }
  const resolvedHome = path.resolve(homeDir)
  await fs.mkdir(resolvedHome, { recursive: true, mode: 0o700 })
  await assertPrivateOwnedDirectory(resolvedHome)
  const canonicalHome = await fs.realpath(resolvedHome)
  const directRoot = directAccountStateDir(canonicalHome)
  const providerRoot = path.join(directRoot, 'provider-profiles')
  const chatGptRoot = path.join(providerRoot, 'chatgpt')
  const profileRoot = path.join(chatGptRoot, internalId)
  const codexHome = managedCodexHome(canonicalHome, internalId)

  for (const directory of [directRoot, providerRoot, chatGptRoot, profileRoot, codexHome]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await assertPrivateOwnedDirectory(directory)
  }
  const canonical = await fs.realpath(codexHome)
  if (canonical !== codexHome) {
    throw profileError('codex_profile_unsafe', 'The managed Codex profile resolved outside its canonical path.')
  }
  await assertManagedCodexHome(canonical)
  return canonical
}

export async function assertManagedCodexHome(codexHome: string): Promise<void> {
  const canonical = path.resolve(codexHome)
  await assertPrivateOwnedDirectory(canonical)
  const entries = await fs.readdir(canonical)
  for (const entry of entries) {
    if (MANAGED_PROFILE_FORBIDDEN_ENTRIES.has(entry) || entry.endsWith('.config.toml')) {
      throw profileError(
        'codex_profile_configuration_forbidden',
        'Managed Codex profiles must not contain provider instructions or configuration files.',
      )
    }
  }
  const authPath = path.join(canonical, 'auth.json')
  const auth = await fs.lstat(authPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (auth !== undefined) {
    if (!auth.isFile() || auth.isSymbolicLink() || auth.nlink !== 1 || !ownedByCurrentUser(auth.uid) || (auth.mode & 0o077) !== 0) {
      throw profileError('codex_profile_unsafe', 'The provider-owned Codex authentication file has unsafe metadata.')
    }
  }
}

export async function readOrCreateCodexIdentityKey(homeDir: string): Promise<Buffer> {
  const stateDir = directAccountStateDir(homeDir)
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  await assertPrivateOwnedDirectory(stateDir)
  const keyPath = codexIdentityKeyPath(homeDir)
  const candidate = randomBytes(CODEX_IDENTITY_KEY_BYTES)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(keyPath, 'wx', 0o600)
    await handle.writeFile(candidate)
    await handle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await handle?.close()
  }
  return readCodexIdentityKey(homeDir)
}

export async function readCodexIdentityKey(homeDir: string): Promise<Buffer> {
  const keyPath = codexIdentityKeyPath(homeDir)
  const metadata = await fs.lstat(keyPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw profileError(
        'codex_identity_key_missing',
        'The Codex identity key is missing. Relink every managed account before inference.',
      )
    }
    throw error
  })
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    !ownedByCurrentUser(metadata.uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw profileError('codex_identity_key_unsafe', 'The Codex identity key has unsafe metadata.')
  }
  const key = await fs.readFile(keyPath)
  if (key.length !== CODEX_IDENTITY_KEY_BYTES) {
    throw profileError('codex_identity_key_invalid', 'The Codex identity key has an invalid length.')
  }
  return key
}

export function fingerprintCodexIdentity(identity: string, identityKey: Buffer): string {
  if (!Buffer.isBuffer(identityKey) || identityKey.length !== CODEX_IDENTITY_KEY_BYTES) {
    throw profileError('codex_identity_key_invalid', 'The Codex identity key has an invalid length.')
  }
  const canonicalIdentity = canonicalizeIdentity(identity)
  const hmac = createHmac('sha256', identityKey)
  for (const value of ['chatgpt', 'chatgpt', canonicalIdentity]) {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.length)
    hmac.update(length)
    hmac.update(bytes)
  }
  return `${CODEX_IDENTITY_FINGERPRINT_VERSION}:${hmac.digest('base64url')}`
}

export async function inspectCodexAccount(options: InspectCodexAccountOptions): Promise<CodexAccountObservation> {
  if (options.signal?.aborted) {
    throw profileError('codex_account_read_aborted', 'The Codex account identity check was aborted.', true)
  }
  await assertManagedCodexHome(options.codexHome)
  const command = await resolveTrustedCodexCommand(options.executable)
  const timeoutMs = resolvePositiveTimeout(options.timeoutMs)
  const workingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-codex-account-'))
  let child: ChildProcessWithoutNullStreams | undefined

  try {
    child = spawn(
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
        env: codexAccountEnvironment(process.env, options.codexHome),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const account = await readAccountFromAppServer(child, timeoutMs, options.signal)
    if (account === null) return Object.freeze({ state: 'unavailable', reason: 'no_account' })
    if (!isRecord(account) || account.type !== 'chatgpt') {
      return Object.freeze({ state: 'unavailable', reason: 'not_chatgpt' })
    }
    if (account.email === null || account.email === undefined) {
      return Object.freeze({ state: 'unverifiable', reason: 'identity_missing' })
    }
    if (typeof account.email !== 'string') {
      throw profileError('codex_account_invalid', 'Codex returned an invalid ChatGPT account identity.')
    }
    return Object.freeze({
      state: 'ready',
      fingerprint: fingerprintCodexIdentity(account.email, options.identityKey),
    })
  } catch (error) {
    if (error instanceof CodexProfileError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw profileError('codex_binary_missing', 'The configured Codex executable was not found.')
    }
    throw profileError('codex_account_read_failed', 'The official Codex account identity check failed.', true)
  } finally {
    if (child !== undefined) await stopChild(child)
    await fs.rm(workingRoot, { recursive: true, force: true, maxRetries: 3 })
  }
}

export async function resolveTrustedCodexExecutable(value = process.env.TOKENLESS_CODEX_BIN ?? 'codex'): Promise<string> {
  return (await resolveTrustedCodexCommand(value)).source
}

export async function resolveTrustedCodexCommand(
  value = process.env.TOKENLESS_CODEX_BIN ?? 'codex',
): Promise<TrustedCodexCommand> {
  if (process.platform === 'win32') {
    throw profileError('codex_unsupported', 'Managed Codex profiles currently support macOS and Linux.')
  }
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw profileError('codex_binary_invalid', 'The configured Codex executable must be a nonempty command or path.')
  }
  const candidate = value.includes(path.sep) ? path.resolve(value) : await findExecutable(value)
  const canonical = await fs.realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw profileError('codex_binary_missing', 'The configured Codex executable was not found.')
    throw error
  })
  const metadata = await fs.stat(canonical)
  if (!metadata.isFile() || !ownedByTrustedUser(metadata.uid) || (metadata.mode & 0o022) !== 0) {
    throw profileError('codex_binary_untrusted', 'The configured Codex executable is not a trusted regular file.')
  }
  await fs.access(canonical, fs.constants.X_OK)
  await assertTrustedDirectoryChain(path.dirname(canonical))
  const shebang = await executableShebang(canonical)
  if (shebang === undefined) {
    return Object.freeze({ executable: canonical, argsPrefix: [], source: canonical })
  }
  if (shebang !== '#!/usr/bin/env node' && shebang !== '#!/usr/bin/node') {
    throw profileError('codex_binary_untrusted', 'The configured Codex script uses an untrusted interpreter.')
  }
  const nodeExecutable = await resolveTrustedRuntimeExecutable(process.execPath)
  return Object.freeze({ executable: nodeExecutable, argsPrefix: [canonical], source: canonical })
}

function codexAccountEnvironment(environment: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  const available = new Map<string, string>()
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !available.has(key.toUpperCase())) available.set(key.toUpperCase(), value)
  }
  for (const name of APP_SERVER_ENVIRONMENT) {
    const value = available.get(name)
    if (value !== undefined) result[name] = value
  }
  result.CODEX_HOME = codexHome
  result.CODEX_EXEC_SERVER_URL = 'none'
  return result
}

async function readAccountFromAppServer(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    let messages = 0
    let stderrBytes = 0
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    const timer = setTimeout(() => finish(profileError('codex_account_read_timeout', 'The Codex account identity check timed out.', true)), timeoutMs)
    timer.unref()

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      signal?.removeEventListener('abort', onAbort)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.stdin.removeListener('error', onStdinError)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const send = (message: unknown) => {
      if (!child.stdin.writable) {
        finish(profileError('codex_account_read_failed', 'The Codex app-server input closed unexpectedly.', true))
        return
      }
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined) onStdinError()
      })
    }
    const onAbort = () => finish(profileError('codex_account_read_aborted', 'The Codex account identity check was aborted.', true))
    const onError = () => finish(profileError('codex_account_read_failed', 'The Codex app-server could not start.', true))
    const onExit = () => finish(profileError('codex_account_read_failed', 'The Codex app-server exited before returning account state.', true))
    const onStdinError = () => finish(profileError('codex_account_read_failed', 'The Codex app-server input closed unexpectedly.', true))

    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', onError)
    child.once('exit', onExit)
    child.stdin.once('error', onStdinError)
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > APP_SERVER_LINE_BYTES) {
        finish(profileError('codex_account_read_failed', 'The Codex app-server returned oversized diagnostics.', true))
      }
    })
    lines.on('line', (line) => {
      if (Buffer.byteLength(line, 'utf8') > APP_SERVER_LINE_BYTES || ++messages > APP_SERVER_MESSAGES) {
        finish(profileError('codex_account_read_failed', 'The Codex app-server returned oversized account data.', true))
        return
      }
      let message: unknown
      try {
        message = JSON.parse(line) as unknown
      } catch {
        finish(profileError('codex_account_read_failed', 'The Codex app-server returned invalid JSON.', true))
        return
      }
      if (!isRecord(message)) return
      if (message.id === 0) {
        if (message.error !== undefined || !isRecord(message.result)) {
          finish(profileError('codex_account_read_failed', 'The Codex app-server rejected initialization.', true))
          return
        }
        send({ method: 'initialized', params: {} })
        send({ method: 'account/read', id: 1, params: { refreshToken: false } })
        return
      }
      if (message.id === 1) {
        if (message.error !== undefined || !isRecord(message.result) || !Object.hasOwn(message.result, 'account')) {
          finish(profileError('codex_account_read_failed', 'The Codex app-server returned invalid account state.', true))
          return
        }
        finish(undefined, message.result.account)
      }
    })
    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'tokenless',
          title: 'Tokenless',
          version: '0.1.0',
        },
      },
    })
  })
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.stdin.end()
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  } else {
    child.kill('SIGTERM')
  }
  const timer = setTimeout(() => {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    } else {
      child.kill('SIGKILL')
    }
  }, 500)
  timer.unref()
  await exited
  clearTimeout(timer)
}

async function assertPrivateOwnedDirectory(directory: string): Promise<void> {
  const metadata = await fs.lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata.uid) || (metadata.mode & 0o077) !== 0) {
    throw profileError('codex_profile_unsafe', 'A managed Codex profile directory has unsafe metadata.')
  }
}

async function assertTrustedDirectoryChain(start: string): Promise<void> {
  let current = start
  while (true) {
    const metadata = await fs.stat(current)
    if (!metadata.isDirectory() || !ownedByTrustedUser(metadata.uid) || (metadata.mode & 0o022) !== 0) {
      throw profileError('codex_binary_untrusted', 'The Codex executable is inside an untrusted directory.')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

async function executableShebang(executable: string): Promise<string | undefined> {
  const noFollow = 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0
  const handle = await fs.open(executable, fs.constants.O_RDONLY | noFollow)
  try {
    const bytes = Buffer.alloc(256)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const firstLine = bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0]
    return firstLine?.startsWith('#!') === true ? firstLine.trim() : undefined
  } finally {
    await handle.close()
  }
}

async function resolveTrustedRuntimeExecutable(executable: string): Promise<string> {
  const canonical = await fs.realpath(executable)
  const metadata = await fs.stat(canonical)
  if (!metadata.isFile() || !ownedByTrustedUser(metadata.uid) || (metadata.mode & 0o022) !== 0) {
    throw profileError('codex_binary_untrusted', 'The Node runtime for the Codex launcher is not trusted.')
  }
  await fs.access(canonical, fs.constants.X_OK)
  await assertTrustedDirectoryChain(path.dirname(canonical))
  return canonical
}

async function findExecutable(command: string): Promise<string> {
  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === '') continue
    const candidate = path.join(directory, command)
    try {
      await fs.access(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Continue through the operator-provided PATH without invoking a shell.
    }
  }
  throw profileError('codex_binary_missing', 'The configured Codex executable was not found.')
}

function canonicalizeIdentity(identity: string): string {
  if (typeof identity !== 'string') {
    throw profileError('codex_identity_invalid', 'Codex returned an invalid ChatGPT account identity.')
  }
  const canonical = identity.trim().normalize('NFKC').toLowerCase()
  if (
    canonical.length === 0 ||
    canonical.length > ACCOUNT_IDENTITY_MAX_CHARACTERS ||
    Buffer.byteLength(canonical, 'utf8') > ACCOUNT_IDENTITY_MAX_BYTES ||
    /\p{Cc}/u.test(canonical)
  ) {
    throw profileError('codex_identity_invalid', 'Codex returned an invalid ChatGPT account identity.')
  }
  return canonical
}

function resolvePositiveTimeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_ACCOUNT_READ_TIMEOUT_MS
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 120_000) {
    throw profileError('codex_account_read_timeout_invalid', 'The Codex account identity timeout is invalid.')
  }
  return resolved
}

function assertInternalId(internalId: string): void {
  if (!INTERNAL_ID_PATTERN.test(internalId)) {
    throw profileError('codex_profile_id_invalid', 'The managed Codex profile id is invalid.')
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function ownedByTrustedUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === 0 || uid === process.getuid()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function profileError(reason: string, message: string, retryable = false): CodexProfileError {
  return new CodexProfileError(reason, message, retryable)
}
