import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { codexInspectOperationTimeoutMs, runCodexSupervisedOperation } from './codex-child-supervisor.js'
import { DirectError } from './types.js'

export const CODEX_ACCOUNT_CREDENTIAL_STORE = 'file' as const
export const CODEX_IDENTITY_FINGERPRINT_VERSION = 'tokenless.codex-identity.v1' as const
export const CODEX_IDENTITY_KEY_BYTES = 32

const DEFAULT_ACCOUNT_READ_TIMEOUT_MS = 15_000
const INTERNAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ACCOUNT_IDENTITY_MAX_CHARACTERS = 320
const ACCOUNT_IDENTITY_MAX_BYTES = 1024
const MANAGED_PROFILE_FORBIDDEN_ENTRIES = new Set([
  'agents.md',
  'agents.override.md',
  'config.toml',
  'hooks',
  'plugins',
  'rules',
  'skills',
])

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
  const profileRoot = path.dirname(canonical)
  const internalId = path.basename(profileRoot)
  const chatGptRoot = path.dirname(profileRoot)
  const providerRoot = path.dirname(chatGptRoot)
  const directRoot = path.dirname(providerRoot)
  const homeRoot = path.dirname(directRoot)
  assertInternalId(internalId)
  if (
    path.basename(canonical) !== 'codex' || path.basename(chatGptRoot) !== 'chatgpt' ||
    path.basename(providerRoot) !== 'provider-profiles' || path.basename(directRoot) !== 'direct'
  ) throw profileError('codex_profile_unsafe', 'The managed Codex profile is outside the Tokenless profile layout.')
  for (const directory of [homeRoot, directRoot, providerRoot, chatGptRoot, profileRoot, canonical]) {
    await assertPrivateOwnedDirectory(directory)
    if (await fs.realpath(directory) !== directory) {
      throw profileError('codex_profile_unsafe', 'A managed Codex profile ancestor is aliased or symbolic.')
    }
  }
  const entries = await fs.readdir(canonical)
  for (const entry of entries) {
    const normalizedEntry = entry.toLowerCase()
    if (MANAGED_PROFILE_FORBIDDEN_ENTRIES.has(normalizedEntry) || normalizedEntry.endsWith('.config.toml')) {
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
  const timeoutMs = resolvePositiveTimeout(options.timeoutMs)
  const location = managedProfileLocation(options.codexHome)
  const executable = await resolveTrustedCodexExecutable(options.executable)
  return runCodexSupervisedOperation<CodexAccountObservation>({
    operation: 'inspect-profile',
    homeDir: location.homeDir,
    codexExecutable: executable,
    lockFiles: [location.accountLock],
    operationTimeoutMs: codexInspectOperationTimeoutMs(timeoutMs),
    accountReadTimeoutMs: timeoutMs,
    codexHome: options.codexHome,
    identityKey: options.identityKey,
    environment: process.env,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

function managedProfileLocation(codexHome: string): { homeDir: string; accountLock: string } {
  const canonical = path.resolve(codexHome)
  const profileRoot = path.dirname(canonical)
  const internalId = path.basename(profileRoot)
  assertInternalId(internalId)
  const chatGptRoot = path.dirname(profileRoot)
  const providerRoot = path.dirname(chatGptRoot)
  const directRoot = path.dirname(providerRoot)
  const homeDir = path.dirname(directRoot)
  if (
    path.basename(canonical) !== 'codex' ||
    path.basename(chatGptRoot) !== 'chatgpt' ||
    path.basename(providerRoot) !== 'provider-profiles' ||
    path.basename(directRoot) !== 'direct'
  ) throw profileError('codex_profile_unsafe', 'The managed Codex profile is outside the Tokenless profile layout.')
  return {
    homeDir,
    accountLock: path.join(directRoot, 'account-locks', 'chatgpt', `${internalId}.lock`),
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

function profileError(reason: string, message: string, retryable = false): CodexProfileError {
  return new CodexProfileError(reason, message, retryable)
}
