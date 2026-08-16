import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright-core'

import { tokenlessError } from './errors.js'

export const IMAGE_ASSET_DIRECTORY = 'assets' as const
export const IMAGE_ASSET_REFERENCE_PREFIX = `${IMAGE_ASSET_DIRECTORY}/` as const
export const IMAGE_ASSET_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp'] as const)
export const MAX_IMAGE_ASSET_BYTES = 32 * 1024 * 1024

export type ImageAssetMediaType = typeof IMAGE_ASSET_MEDIA_TYPES[number]

export type VisibleImageSource = Readonly<{
  url: string
  mediaType: string | null
  alt: string | null
  width: number | null
  height: number | null
  visibleProof: string
}>

export type PersistedImageAsset = Readonly<{
  kind: 'image'
  assetRef: string
  mediaType: ImageAssetMediaType
  alt: string | null
  width: number
  height: number
  byteSize: number
  sha256: string
  createdAt: string
  provider: 'arena'
  jobId: string
  taskId: string | null
  conversationId: string
  downloadAvailable: true
  visibleProof: string
}>

export type ImageAssetIdentity = Readonly<{
  assetRoot: string
  jobId: string
  taskId: string | null
  provider: 'arena'
  now?: (() => Date) | undefined
  signal?: AbortSignal | undefined
}>

type VerifiedImage = Readonly<{
  mediaType: ImageAssetMediaType
  extension: 'png' | 'jpg' | 'webp'
}>

const SAFE_ASSET_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/**
 * Download an image through the Playwright API context attached to the live page,
 * verify the bytes, and persist one task-scoped local asset.
 */
export async function persistArenaImageAsset(
  page: Page,
  source: VisibleImageSource,
  identity: ImageAssetIdentity,
  index: number,
): Promise<PersistedImageAsset> {
  assertNotAborted(identity.signal)
  const sourceUrl = validateSourceUrl(source.url)
  const jobId = safeAssetComponent(identity.jobId, 'job id')
  const taskSegment = identity.taskId === null ? 'unscoped' : safeAssetComponent(identity.taskId, 'task id')
  const conversationId = deriveArenaConversationId(page.url())
  const conversationSegment = safeAssetComponent(conversationId, 'conversation id')
  if (!Number.isSafeInteger(index) || index < 0 || index > 9999) {
    throw tokenlessError('arena_image_asset_index_invalid', 'Arena image asset index is invalid.')
  }
  if (!identity.assetRoot || identity.assetRoot.includes('\u0000')) {
    throw tokenlessError('arena_image_asset_root_invalid', 'Arena image asset root is invalid.')
  }

  let response: Awaited<ReturnType<Page['request']['get']>>
  try {
    response = await page.request.get(sourceUrl, {
      timeout: 60_000,
      failOnStatusCode: false,
      headers: { referer: page.url() },
    })
  } catch (error) {
    throw tokenlessError(
      'arena_image_download_failed',
      'Arena image bytes could not be downloaded through the selected browser session.',
      { retryable: true, cause: error },
    )
  }
  assertNotAborted(identity.signal)
  if (!response.ok()) {
    throw tokenlessError(
      'arena_image_download_failed',
      'Arena image download returned a non-success HTTP response.',
      { retryable: true, details: { status: response.status() } },
    )
  }

  const contentLength = response.headers()['content-length']
  if (contentLength !== undefined) {
    const declaredLength = Number(contentLength)
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_IMAGE_ASSET_BYTES) {
      throw tokenlessError(
        'arena_image_bytes_too_large',
        'Arena image response exceeds the maximum asset size.',
        { retryable: false },
      )
    }
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(await response.body())
  } catch (error) {
    throw tokenlessError(
      'arena_image_download_failed',
      'Arena image response bytes could not be read.',
      { retryable: true, cause: error },
    )
  }
  assertNotAborted(identity.signal)
  if (bytes.byteLength > MAX_IMAGE_ASSET_BYTES) {
    throw tokenlessError(
      'arena_image_bytes_too_large',
      'Arena image response exceeds the maximum asset size.',
      { retryable: false },
    )
  }
  const declaredMediaType = normalizeMediaType(response.headers()['content-type'])
  if (declaredMediaType === 'invalid') {
    throw tokenlessError('arena_image_media_type_invalid', 'Arena image response declared a non-image media type.')
  }
  const verified = sniffImageBytes(bytes)
  if (!verified) {
    throw tokenlessError(
      'arena_image_bytes_invalid',
      'Arena image response is not a valid PNG, JPEG, or WebP image.',
    )
  }
  const decoded = await decodeImageBytes(page, bytes, verified.mediaType)
  if (!decoded) {
    throw tokenlessError(
      'arena_image_bytes_invalid',
      'Arena image response could not be decoded by the selected browser.',
    )
  }
  if (declaredMediaType && declaredMediaType !== 'generic' && declaredMediaType !== verified.mediaType) {
    throw tokenlessError(
      'arena_image_media_type_mismatch',
      'Arena image response media type does not match the verified image bytes.',
      { details: { declaredMediaType, verifiedMediaType: verified.mediaType } },
    )
  }
  if (source.mediaType && source.mediaType !== verified.mediaType) {
    throw tokenlessError(
      'arena_image_media_type_mismatch',
      'Arena visible image media type does not match the downloaded image bytes.',
      { details: { visibleMediaType: source.mediaType, verifiedMediaType: verified.mediaType } },
    )
  }
  if (
    (source.width !== null && source.width !== decoded.width) ||
    (source.height !== null && source.height !== decoded.height)
  ) {
    throw tokenlessError(
      'arena_image_metadata_mismatch',
      'Arena visible image dimensions do not match the downloaded image bytes.',
      {
        details: {
          visibleWidth: source.width,
          visibleHeight: source.height,
          downloadedWidth: decoded.width,
          downloadedHeight: decoded.height,
        },
      },
    )
  }

  const createdAt = (identity.now ?? (() => new Date()))().toISOString()
  const timestampSegment = createdAt
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z')
  const batchSegment = safeAssetComponent(`${timestampSegment}_${jobId}`, 'asset job directory')
  const extension = verified.extension
  const relativeAssetPath = path.posix.join(
    taskSegment,
    conversationSegment,
    batchSegment,
    `${index}.${extension}`,
  )
  const assetRef = path.posix.join(IMAGE_ASSET_DIRECTORY, relativeAssetPath)
  const assetRoot = await ensureAssetDirectory(identity.assetRoot)
  const canonicalAssetRoot = await fs.realpath(assetRoot)
  const taskDirectory = await ensureAssetDirectoryWithin(canonicalAssetRoot, path.join(assetRoot, taskSegment))
  const conversationDirectory = await ensureAssetDirectoryWithin(
    canonicalAssetRoot,
    path.join(taskDirectory, conversationSegment),
  )
  const batchDirectory = await ensureAssetDirectoryWithin(
    canonicalAssetRoot,
    path.join(conversationDirectory, batchSegment),
  )
  const assetPath = path.join(batchDirectory, `${index}.${extension}`)
  let persisted = false
  try {
    const handle = await fs.open(assetPath, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    const storedBytes = await fs.readFile(assetPath)
    const stat = await fs.stat(assetPath)
    const sha256 = createHash('sha256').update(storedBytes).digest('hex')
    if (
      stat.size !== storedBytes.byteLength ||
      storedBytes.byteLength !== bytes.byteLength ||
      !storedBytes.equals(bytes)
    ) {
      throw tokenlessError('arena_image_asset_metadata_mismatch', 'Arena image asset changed while being persisted.')
    }
    const storedVerified = sniffImageBytes(storedBytes)
    if (
      !storedVerified ||
      storedVerified.mediaType !== verified.mediaType
    ) {
      throw tokenlessError('arena_image_asset_metadata_mismatch', 'Persisted Arena image asset failed verification.')
    }
    persisted = true
    return {
      kind: 'image',
      assetRef,
      mediaType: verified.mediaType,
      alt: source.alt,
      width: decoded.width,
      height: decoded.height,
      byteSize: storedBytes.byteLength,
      sha256,
      createdAt,
      provider: identity.provider,
      jobId: identity.jobId,
      taskId: identity.taskId,
      conversationId,
      downloadAvailable: true,
      visibleProof: 'visible-arena-current-turn-image-downloaded-asset',
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EEXIST') {
      throw tokenlessError('arena_image_asset_collision', 'Arena image asset path already exists.', { retryable: false })
    }
    throw error
  } finally {
    if (!persisted) await fs.rm(assetPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Read a persisted image by the relative reference returned in a response.
 * The returned bytes are verified again before crossing the daemon boundary.
 */
export async function readPersistedImageAsset(homeDir: string, assetRef: string): Promise<{
  bytes: Buffer
  mediaType: ImageAssetMediaType
} | null> {
  const parsed = parseImageAssetReference(assetRef)
  if (!parsed) return null
  const canonicalHome = await fs.realpath(path.resolve(homeDir)).catch(() => null)
  if (!canonicalHome) return null
  const assetRoot = path.join(canonicalHome, IMAGE_ASSET_DIRECTORY)
  const assetRootStat = await fs.lstat(assetRoot).catch(() => null)
  if (!assetRootStat || !assetRootStat.isDirectory() || assetRootStat.isSymbolicLink()) return null
  const assetPath = path.join(assetRoot, ...parsed)
  const candidateStat = await fs.lstat(assetPath).catch(() => null)
  if (!candidateStat || !candidateStat.isFile() || candidateStat.isSymbolicLink()) return null
  if (candidateStat.size > MAX_IMAGE_ASSET_BYTES) return null
  const canonicalPath = await fs.realpath(assetPath).catch(() => null)
  if (!canonicalPath || !isPathInside(assetRoot, canonicalPath)) return null
  const bytes = await fs.readFile(canonicalPath).catch(() => null)
  if (!bytes) return null
  if (bytes.byteLength > MAX_IMAGE_ASSET_BYTES) return null
  const verified = sniffImageBytes(bytes)
  if (!verified || verified.extension !== path.extname(parsed[3]!).slice(1)) return null
  return { bytes, mediaType: verified.mediaType }
}

export function parseImageAssetReference(assetRef: string): readonly string[] | null {
  if (typeof assetRef !== 'string' || !assetRef.startsWith(IMAGE_ASSET_REFERENCE_PREFIX) || assetRef.includes('\u0000')) {
    return null
  }
  const parts = assetRef.slice(IMAGE_ASSET_REFERENCE_PREFIX.length).split('/')
  if (parts.length !== 4 || parts.some((part) => !SAFE_ASSET_COMPONENT.test(part))) return null
  const file = parts[3]!
  if (!/^(?:0|[1-9][0-9]{0,3})\.(?:png|jpg|webp)$/u.test(file)) return null
  return parts
}

function sniffImageBytes(bytes: Uint8Array): VerifiedImage | null {
  if (bytes.byteLength >= 8 && isPng(bytes)) return { mediaType: 'image/png', extension: 'png' }
  if (bytes.byteLength >= 2 && isJpeg(bytes)) return { mediaType: 'image/jpeg', extension: 'jpg' }
  if (bytes.byteLength >= 12 && isWebp(bytes)) return { mediaType: 'image/webp', extension: 'webp' }
  return null
}

function validateSourceUrl(value: string) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:') throw new Error('not https')
    return parsed.toString()
  } catch {
    throw tokenlessError('arena_image_url_invalid', 'Arena image URL must be a visible HTTPS URL.')
  }
}

function normalizeMediaType(value: string | undefined): ImageAssetMediaType | 'generic' | 'invalid' | null {
  if (!value) return null
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (IMAGE_ASSET_MEDIA_TYPES.includes(mediaType as ImageAssetMediaType)) return mediaType as ImageAssetMediaType
  if (mediaType === 'application/octet-stream') return 'generic'
  return 'invalid'
}

function deriveArenaConversationId(value: string) {
  try {
    const parsed = new URL(value)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if ((segments[0] === 'c' || segments[0] === 'conversation' || segments[0] === 'agent') && segments[1]) {
      return segments[1]
    }
  } catch {
    // The visible page URL is only an identity hint; use the explicit new marker when absent.
  }
  return 'new'
}

function safeAssetComponent(value: string, label: string) {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '')
    .slice(0, 120)
  if (!normalized || !SAFE_ASSET_COMPONENT.test(normalized)) {
    throw tokenlessError('arena_image_asset_identity_invalid', `Arena image ${label} is invalid.`)
  }
  return normalized
}

async function ensureAssetDirectory(directory: string) {
  const resolved = path.resolve(directory)
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw tokenlessError('arena_image_asset_root_invalid', 'Arena image asset path must be a real directory.')
  }
  return resolved
}

async function ensureAssetDirectoryWithin(canonicalRoot: string, directory: string) {
  const resolved = await ensureAssetDirectory(directory)
  const canonicalDirectory = await fs.realpath(resolved)
  if (!isPathInside(canonicalRoot, canonicalDirectory)) {
    throw tokenlessError('arena_image_asset_root_invalid', 'Arena image asset path escapes the Tokenless asset root.')
  }
  return canonicalDirectory
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
}

async function decodeImageBytes(
  page: Page,
  bytes: Uint8Array,
  mediaType: ImageAssetMediaType,
): Promise<{ width: number; height: number } | null> {
  try {
    const encodedBytes = Buffer.from(bytes).toString('base64')
    return await page.evaluate(async ({ encodedBytes: encoded, mediaType: type }) => {
      if (typeof createImageBitmap !== 'function') return null
      const binary = atob(encoded)
      const decodedBytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) decodedBytes[index] = binary.charCodeAt(index)
      const blob = new Blob([decodedBytes], { type })
      const bitmap = await createImageBitmap(blob)
      const dimensions = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return dimensions
    }, { encodedBytes, mediaType })
  } catch {
    return null
  }
}

function isPng(bytes: Uint8Array) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
}

function isJpeg(bytes: Uint8Array) {
  return bytes[0] === 0xff && bytes[1] === 0xd8
}

function isWebp(bytes: Uint8Array) {
  return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  let value = ''
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index] ?? 0)
  return value
}
