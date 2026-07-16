import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

export const VISIBLE_ATTACHMENT_PROTOCOL = 'tokenless.visible-attachment.v1' as const
export const VISIBLE_ATTACHMENT_DIRECTORY = 'attachments' as const
export const DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES = 512 * 1024 * 1024
export const DEFAULT_VISIBLE_ATTACHMENT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000

const COPY_BUFFER_BYTES = 256 * 1024
const MAX_ATTACHMENT_NAME_BYTES = 512
const MAX_ATTACHMENT_TYPE_BYTES = 255
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/

type BigIntFileStat = {
  dev: bigint
  ino: bigint
  size: bigint
  isFile(): boolean
}

export type VisibleAttachmentDescriptor = {
  protocol: typeof VISIBLE_ATTACHMENT_PROTOCOL
  bundleId: string
  attachmentId: string
  name: string
  type: string
  size: number
  sha256: string
}

export type StageVisibleAttachmentOptions = {
  homeDir: string
  sourcePath: string
  bundleId?: string | undefined
  attachmentId?: string | undefined
  name?: string | undefined
  type?: string | undefined
  maxBytes?: number | undefined
}

export type StageVisibleAttachmentsOptions = {
  homeDir: string
  files: Array<Omit<StageVisibleAttachmentOptions, 'homeDir' | 'bundleId'>>
  bundleId?: string | undefined
  maxBytes?: number | undefined
}

export function createVisibleAttachmentId() {
  return randomUUID()
}

export function visibleAttachmentRoot(homeDir: string) {
  return path.join(validateHomeDir(homeDir), VISIBLE_ATTACHMENT_DIRECTORY)
}

export function visibleAttachmentBundlePath(homeDir: string, bundleId: string) {
  return path.join(visibleAttachmentRoot(homeDir), validateSafeId(bundleId, 'bundleId'))
}

export function visibleAttachmentPath(homeDir: string, bundleId: string, attachmentId: string) {
  return path.join(
    visibleAttachmentBundlePath(homeDir, bundleId),
    `${validateSafeId(attachmentId, 'attachmentId')}.bin`
  )
}

export function validateVisibleAttachmentDescriptor(value: unknown): VisibleAttachmentDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Visible attachment descriptor must be an object.')
  }
  const descriptor = value as Partial<VisibleAttachmentDescriptor> & Record<string, unknown>
  const allowedKeys = new Set(['protocol', 'bundleId', 'attachmentId', 'name', 'type', 'size', 'sha256'])
  for (const key of Object.keys(descriptor)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`Visible attachment descriptor contains unsupported field: ${key}.`)
    }
  }
  if (descriptor.protocol !== VISIBLE_ATTACHMENT_PROTOCOL) {
    throw new TypeError(`Visible attachment descriptor protocol must be ${VISIBLE_ATTACHMENT_PROTOCOL}.`)
  }
  const bundleId = validateSafeId(descriptor.bundleId, 'bundleId')
  const attachmentId = validateSafeId(descriptor.attachmentId, 'attachmentId')
  const name = validateAttachmentName(descriptor.name)
  const type = validateMediaType(descriptor.type)
  const size = validateNonnegativeSafeInteger(descriptor.size, 'size')
  if (typeof descriptor.sha256 !== 'string' || !SHA256_PATTERN.test(descriptor.sha256)) {
    throw new TypeError('Visible attachment descriptor sha256 must be 64 lowercase hexadecimal characters.')
  }
  return {
    protocol: VISIBLE_ATTACHMENT_PROTOCOL,
    bundleId,
    attachmentId,
    name,
    type,
    size,
    sha256: descriptor.sha256,
  }
}

export async function stageVisibleAttachment({
  homeDir,
  sourcePath,
  bundleId = createVisibleAttachmentId(),
  attachmentId = createVisibleAttachmentId(),
  name,
  type = 'application/octet-stream',
  maxBytes = DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES,
}: StageVisibleAttachmentOptions): Promise<VisibleAttachmentDescriptor> {
  validateSafeId(bundleId, 'bundleId')
  validateSafeId(attachmentId, 'attachmentId')
  const byteLimit = validatePositiveSafeInteger(maxBytes, 'maxBytes')
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '' || sourcePath.includes('\0')) {
    throw new TypeError('sourcePath must be a nonempty path without NUL bytes.')
  }
  const requestedSource = path.resolve(sourcePath)
  const displayName = validateAttachmentName(name ?? path.basename(requestedSource))
  const mediaType = validateMediaType(type)
  const { root, bundle } = await ensureAttachmentBundle(homeDir, bundleId)
  const destination = path.join(bundle, `${attachmentId}.bin`)

  let sourceHandle: fs.FileHandle | undefined
  let destinationHandle: fs.FileHandle | undefined
  let staged = false
  try {
    const sourceLstat = await fs.lstat(requestedSource)
    if (sourceLstat.isSymbolicLink() || !sourceLstat.isFile()) {
      throw new Error('Visible attachment source must be a regular, non-symlink file.')
    }
    const canonicalSource = await fs.realpath(requestedSource)
    sourceHandle = await fs.open(canonicalSource, fsConstants.O_RDONLY | noFollowFlag())
    const openedSourceStat = await sourceHandle.stat({ bigint: true }) as BigIntFileStat
    if (!openedSourceStat.isFile()) {
      throw new Error('Visible attachment source must be a regular file.')
    }
    if (openedSourceStat.size > BigInt(byteLimit)) {
      throw new Error(`Visible attachment exceeds the ${byteLimit}-byte staging limit.`)
    }
    await verifyOpenedSourceIdentity({
      requestedSource,
      canonicalSource,
      openedStat: openedSourceStat,
    })

    destinationHandle = await fs.open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600
    )
    if (process.platform !== 'win32') await destinationHandle.chmod(0o600)
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let size = 0
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      if (size + bytesRead > byteLimit) {
        throw new Error(`Visible attachment exceeds the ${byteLimit}-byte staging limit.`)
      }
      const chunk = buffer.subarray(0, bytesRead)
      digest.update(chunk)
      await writeAll(destinationHandle, chunk)
      size += bytesRead
    }
    await destinationHandle.sync()
    await verifyOpenedSourceIdentity({
      requestedSource,
      canonicalSource,
      openedStat: openedSourceStat,
    })
    const finalSourceStat = await sourceHandle.stat({ bigint: true })
    if (!sameFileIdentity(openedSourceStat, finalSourceStat) || finalSourceStat.size !== BigInt(size)) {
      throw new Error('Visible attachment source changed while it was being staged.')
    }
    await verifyOpenedDestinationIdentity({ destination, root, handle: destinationHandle, expectedSize: size })
    staged = true
    return validateVisibleAttachmentDescriptor({
      protocol: VISIBLE_ATTACHMENT_PROTOCOL,
      bundleId,
      attachmentId,
      name: displayName,
      type: mediaType,
      size,
      sha256: digest.digest('hex'),
    })
  } finally {
    await destinationHandle?.close().catch(() => undefined)
    await sourceHandle?.close().catch(() => undefined)
    if (!staged) {
      await fs.rm(destination, { force: true }).catch(() => undefined)
      await fs.rmdir(bundle).catch(() => undefined)
    }
  }
}

export async function stageVisibleAttachments({
  homeDir,
  files,
  bundleId = createVisibleAttachmentId(),
  maxBytes = DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES,
}: StageVisibleAttachmentsOptions) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError('files must contain at least one visible attachment.')
  }
  validateSafeId(bundleId, 'bundleId')
  const descriptors: VisibleAttachmentDescriptor[] = []
  try {
    for (const file of files) {
      descriptors.push(await stageVisibleAttachment({
        ...file,
        homeDir,
        bundleId,
        maxBytes: file.maxBytes ?? maxBytes,
      }))
    }
    return descriptors
  } catch (error) {
    await removeStagedVisibleAttachmentBundle({ homeDir, bundleId }).catch(() => undefined)
    throw error
  }
}

export async function removeStagedVisibleAttachmentBundle({
  homeDir,
  bundleId,
}: {
  homeDir: string
  bundleId: string
}) {
  const safeBundleId = validateSafeId(bundleId, 'bundleId')
  const root = await existingCanonicalAttachmentRoot(homeDir)
  if (!root) return false
  const bundle = path.join(root, safeBundleId)
  let bundleStat
  try {
    bundleStat = await fs.lstat(bundle)
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return false
    throw error
  }
  if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
    throw new Error('Refusing to recursively remove an unsafe visible attachment bundle.')
  }
  const canonicalBundle = await fs.realpath(bundle)
  assertExactChild(root, canonicalBundle, safeBundleId, 'visible attachment bundle')
  const entries = await fs.readdir(canonicalBundle, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(canonicalBundle, entry.name)
    if (!/^[A-Za-z0-9_-]{1,64}\.bin$/.test(entry.name)) {
      throw new Error(`Refusing to remove unexpected visible attachment bundle entry: ${entry.name}.`)
    }
    const entryStat = await fs.lstat(entryPath)
    if (entryStat.isDirectory()) {
      throw new Error(`Refusing to remove nested visible attachment directory: ${entry.name}.`)
    }
    await fs.unlink(entryPath)
  }
  await fs.rmdir(canonicalBundle)
  return true
}

export async function cleanupOrphanedVisibleAttachmentBundles({
  homeDir,
  ttlMs = DEFAULT_VISIBLE_ATTACHMENT_ORPHAN_TTL_MS,
  nowMs = Date.now(),
}: {
  homeDir: string
  ttlMs?: number | undefined
  nowMs?: number | undefined
}) {
  const lifetime = validateNonnegativeSafeInteger(ttlMs, 'ttlMs')
  const now = validateNonnegativeSafeInteger(nowMs, 'nowMs')
  const root = await existingCanonicalAttachmentRoot(homeDir)
  if (!root) return []
  const removed: string[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!SAFE_ID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const bundle = path.join(root, entry.name)
    const stat = await fs.stat(bundle)
    if (now - stat.mtimeMs < lifetime) continue
    if (await removeStagedVisibleAttachmentBundle({ homeDir, bundleId: entry.name })) {
      removed.push(entry.name)
    }
  }
  return removed
}

async function ensureAttachmentBundle(homeDir: string, bundleId: string) {
  const requestedHome = validateHomeDir(homeDir)
  await fs.mkdir(requestedHome, { recursive: true, mode: 0o700 })
  const home = await fs.realpath(requestedHome)
  if (process.platform !== 'win32') await fs.chmod(home, 0o700)
  const rootCandidate = path.join(home, VISIBLE_ATTACHMENT_DIRECTORY)
  await fs.mkdir(rootCandidate, { mode: 0o700 })
  await assertRegularDirectory(rootCandidate, 'visible attachment root')
  const root = await fs.realpath(rootCandidate)
  assertExactChild(home, root, VISIBLE_ATTACHMENT_DIRECTORY, 'visible attachment root')
  if (process.platform !== 'win32') await fs.chmod(root, 0o700)
  const bundleCandidate = path.join(root, validateSafeId(bundleId, 'bundleId'))
  await fs.mkdir(bundleCandidate, { mode: 0o700 })
  await assertRegularDirectory(bundleCandidate, 'visible attachment bundle')
  const bundle = await fs.realpath(bundleCandidate)
  assertExactChild(root, bundle, bundleId, 'visible attachment bundle')
  if (process.platform !== 'win32') await fs.chmod(bundle, 0o700)
  return { root, bundle }
}

async function existingCanonicalAttachmentRoot(homeDir: string) {
  const requestedHome = validateHomeDir(homeDir)
  let home
  try {
    home = await fs.realpath(requestedHome)
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return null
    throw error
  }
  const rootCandidate = path.join(home, VISIBLE_ATTACHMENT_DIRECTORY)
  try {
    await assertRegularDirectory(rootCandidate, 'visible attachment root')
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return null
    throw error
  }
  const root = await fs.realpath(rootCandidate)
  assertExactChild(home, root, VISIBLE_ATTACHMENT_DIRECTORY, 'visible attachment root')
  return root
}

async function assertRegularDirectory(directory: string, label: string) {
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular, non-symlink directory.`)
  }
}

async function verifyOpenedSourceIdentity({
  requestedSource,
  canonicalSource,
  openedStat,
}: {
  requestedSource: string
  canonicalSource: string
  openedStat: BigIntFileStat
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sourceLstat = await fs.lstat(requestedSource)
    if (sourceLstat.isSymbolicLink() || !sourceLstat.isFile()) continue
    const firstRealPath = await fs.realpath(requestedSource)
    const firstStat = await fs.stat(firstRealPath, { bigint: true })
    const secondRealPath = await fs.realpath(requestedSource)
    const secondStat = await fs.stat(secondRealPath, { bigint: true })
    if (
      firstRealPath === canonicalSource &&
      secondRealPath === canonicalSource &&
      sameFileIdentity(openedStat, firstStat) &&
      sameFileIdentity(openedStat, secondStat)
    ) return
  }
  throw new Error('Visible attachment source changed while enforcing file identity.')
}

async function verifyOpenedDestinationIdentity({
  destination,
  root,
  handle,
  expectedSize,
}: {
  destination: string
  root: string
  handle: fs.FileHandle
  expectedSize: number
}) {
  const openedStat = await handle.stat({ bigint: true }) as BigIntFileStat
  const pathStat = await fs.lstat(destination, { bigint: true })
  const canonicalDestination = await fs.realpath(destination)
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    !isPathWithin(root, canonicalDestination) ||
    openedStat.size !== BigInt(expectedSize) ||
    !sameFileIdentity(openedStat, pathStat)
  ) {
    throw new Error('Visible attachment destination changed while enforcing staging containment.')
  }
}

async function writeAll(handle: fs.FileHandle, bytes: Uint8Array) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten <= 0) throw new Error('Visible attachment staging write made no progress.')
    offset += bytesWritten
  }
}

function validateHomeDir(homeDir: string) {
  if (typeof homeDir !== 'string' || homeDir.trim() === '' || homeDir.includes('\0')) {
    throw new TypeError('homeDir must be a nonempty path without NUL bytes.')
  }
  return path.resolve(homeDir)
}

function validateSafeId(value: unknown, field: string) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    throw new TypeError(`${field} must contain 1-64 ASCII letters, digits, underscores, or hyphens.`)
  }
  return value
}

function validateAttachmentName(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    Buffer.byteLength(value, 'utf8') > MAX_ATTACHMENT_NAME_BYTES
  ) {
    throw new TypeError('Visible attachment name must be a path-free name of at most 512 UTF-8 bytes.')
  }
  return value
}

function validateMediaType(value: unknown) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_ATTACHMENT_TYPE_BYTES ||
    !MEDIA_TYPE_PATTERN.test(value)
  ) {
    throw new TypeError('Visible attachment type must be a valid media type of at most 255 bytes.')
  }
  return value.toLowerCase()
}

function validatePositiveSafeInteger(value: unknown, field: string) {
  const integer = validateNonnegativeSafeInteger(value, field)
  if (integer === 0) throw new TypeError(`${field} must be a positive safe integer.`)
  return integer
}

function validateNonnegativeSafeInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`)
  }
  return value
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint }
) {
  return left.dev === right.dev && left.ino === right.ino
}

function assertExactChild(parent: string, candidate: string, childName: string, label: string) {
  const expected = path.join(parent, childName)
  if (path.resolve(candidate) !== path.resolve(expected) || !isPathWithin(parent, candidate)) {
    throw new Error(`${label} escaped its canonical parent.`)
  }
}

function isPathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function noFollowFlag() {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
