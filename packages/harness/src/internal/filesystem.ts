import { constants as fsConstants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { HarnessSkillError, type JsonValue } from '../contracts.js'

const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,96}$/

type FileIdentity = {
  dev: bigint
  ino: bigint
  size: bigint
  isFile(): boolean
}

export function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJson(value: JsonValue) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`
}

export function validateRunId(value: string) {
  if (typeof value !== 'string' || !SAFE_RUN_ID.test(value)) {
    throw new HarnessSkillError(
      'invalid_run_id',
      'runId must contain only letters, numbers, underscores, or hyphens and be at most 96 characters.',
    )
  }
  return value
}

export async function createRunDirectory(stagingRoot: string, runId: string) {
  const root = await ensureDirectory(stagingRoot)
  const directory = path.join(root, validateRunId(runId))
  assertExactChild(root, directory, 'run directory')
  try {
    await fs.mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (isFileSystemError(error, 'EEXIST')) {
      throw new HarnessSkillError('harness_run_exists', `Harness run already exists: ${runId}.`)
    }
    throw error
  }
  await fs.mkdir(path.join(directory, 'attachments'), { mode: 0o700 })
  return directory
}

export async function resolveRunDirectory(stagingRoot: string, runId: string) {
  const root = await existingSafeDirectory(stagingRoot, 'staging root')
  const directory = path.join(root, validateRunId(runId))
  assertExactChild(root, directory, 'run directory')
  const canonical = await existingSafeDirectory(directory, 'run directory')
  assertExactChild(root, canonical, 'run directory')
  return canonical
}

export async function ensureTurnDirectory(runDirectory: string, turn: number) {
  if (!Number.isSafeInteger(turn) || turn < 0) {
    throw new HarnessSkillError('invalid_turn', 'turn must be a nonnegative safe integer.')
  }
  const attachments = await existingSafeDirectory(path.join(runDirectory, 'attachments'), 'attachment directory')
  const directory = path.join(attachments, `turn-${turn}`)
  assertExactChild(attachments, directory, 'turn attachment directory')
  try {
    await fs.mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) throw error
    await existingSafeDirectory(directory, 'turn attachment directory')
  }
  return directory
}

export async function writePrivateFile(filePath: string, content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
  let handle: fs.FileHandle | undefined
  let created = false
  let cleanup = false
  try {
    handle = await fs.open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    created = true
    if (process.platform !== 'win32') await handle.chmod(0o600)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) {
      cleanup = created
      throw error
    }
    const existing = await fs.readFile(filePath)
    if (!existing.equals(bytes)) {
      throw new HarnessSkillError('attachment_collision', `Refusing to overwrite different staged content: ${path.basename(filePath)}.`)
    }
  } finally {
    await handle?.close().catch(() => undefined)
    if (cleanup) await fs.unlink(filePath).catch(() => undefined)
  }
  return { size: bytes.byteLength, sha256: sha256(bytes) }
}

export async function writePrivateJsonAtomic(filePath: string, value: JsonValue) {
  const content = canonicalJson(value)
  const temporary = `${filePath}.${randomUUID()}.tmp`
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    if (process.platform !== 'win32') await handle.chmod(0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, filePath)
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporary).catch(() => undefined)
  }
}

export async function readJsonFile(filePath: string) {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
}

export async function resolveOptionalSkillRoot(skillRoot: string) {
  const requested = path.resolve(skillRoot)
  let stat
  try {
    stat = await fs.lstat(requested)
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return { root: null, status: 'missing' as const }
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { root: null, status: 'unsafe' as const }
  return { root: await fs.realpath(requested), status: 'ready' as const }
}

export async function readRegularFilePrefix({
  filePath,
  root,
  maxFileBytes,
  maxPrefixBytes,
}: {
  filePath: string
  root: string
  maxFileBytes: number
  maxPrefixBytes: number
}) {
  const opened = await openRegularFile({ filePath, root, maxFileBytes })
  try {
    const bytesToRead = Math.min(Number(opened.identity.size), maxPrefixBytes + 1)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await opened.handle.read(buffer, 0, buffer.byteLength, 0)
    await verifyOpenIdentity(opened.handle, opened.identity)
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      fileSize: Number(opened.identity.size),
      canonicalPath: opened.canonicalPath,
      prefixExceeded: bytesRead > maxPrefixBytes,
    }
  } finally {
    await opened.handle.close()
  }
}

export async function readRegularFile({
  filePath,
  root,
  maxFileBytes,
}: {
  filePath: string
  root: string
  maxFileBytes: number
}) {
  const opened = await openRegularFile({ filePath, root, maxFileBytes })
  try {
    const bytes = await opened.handle.readFile()
    await verifyOpenIdentity(opened.handle, opened.identity)
    if (bytes.byteLength !== Number(opened.identity.size)) {
      throw new HarnessSkillError('skill_file_changed', 'Skill file changed while it was being read.')
    }
    return { bytes, canonicalPath: opened.canonicalPath }
  } finally {
    await opened.handle.close()
  }
}

export function isFileSystemError(error: unknown, code: string) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

async function openRegularFile({
  filePath,
  root,
  maxFileBytes,
}: {
  filePath: string
  root: string
  maxFileBytes: number
}) {
  const requested = path.resolve(filePath)
  assertWithin(root, requested, 'skill file')
  const lstat = await fs.lstat(requested)
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new HarnessSkillError('skill_file_unsafe', 'Skill file must be a regular, non-symlink file.')
  }
  if (lstat.size > maxFileBytes) {
    throw new HarnessSkillError('skill_file_too_large', `Skill file exceeds the ${maxFileBytes}-byte limit.`)
  }
  const canonicalPath = await fs.realpath(requested)
  assertWithin(root, canonicalPath, 'skill file')
  const handle = await fs.open(canonicalPath, fsConstants.O_RDONLY | noFollowFlag())
  const identity = await handle.stat({ bigint: true }) as FileIdentity
  if (!identity.isFile()) {
    await handle.close()
    throw new HarnessSkillError('skill_file_unsafe', 'Skill file must be a regular file.')
  }
  if (identity.size > BigInt(maxFileBytes)) {
    await handle.close()
    throw new HarnessSkillError('skill_file_too_large', `Skill file exceeds the ${maxFileBytes}-byte limit.`)
  }
  return { handle, identity, canonicalPath }
}

async function verifyOpenIdentity(handle: fs.FileHandle, original: FileIdentity) {
  const current = await handle.stat({ bigint: true }) as FileIdentity
  if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size) {
    throw new HarnessSkillError('skill_file_changed', 'Skill file changed while it was being read.')
  }
}

async function ensureDirectory(value: string) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new HarnessSkillError('invalid_staging_root', 'stagingRoot must be a nonempty path without NUL bytes.')
  }
  const requested = path.resolve(value)
  await fs.mkdir(requested, { recursive: true, mode: 0o700 })
  return await existingSafeDirectory(requested, 'staging root')
}

async function existingSafeDirectory(value: string, label: string) {
  const requested = path.resolve(value)
  const stat = await fs.lstat(requested)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new HarnessSkillError('unsafe_directory', `${label} must be a regular, non-symlink directory.`)
  }
  return await fs.realpath(requested)
}

function assertExactChild(parent: string, child: string, label: string) {
  if (path.dirname(child) !== parent) {
    throw new HarnessSkillError('unsafe_path', `${label} must be an exact child of its configured root.`)
  }
}

function assertWithin(root: string, candidate: string, label: string) {
  const relative = path.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HarnessSkillError('unsafe_path', `${label} resolves outside the configured Skill root.`)
  }
}

function noFollowFlag() {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, child]) => [key, sortJson(child)],
    ))
  }
  return value
}
