import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { tokenlessError } from '../playwright/errors.js'
import { withPrivateSqliteWriterLock } from '../playwright/profiles/sqlite-lock.js'
import {
  OUTPUT_SAVINGS_RUNTIME_CATALOG,
  OUTPUT_SAVINGS_RUNTIME_LICENSE_FILE,
  OUTPUT_SAVINGS_RUNTIME_LICENSE_TEXT,
} from './catalog.js'
import { OUTPUT_SAVINGS_MEASUREMENT_SCHEMA, type OutputSavingsResult } from './measurement.js'

const execFileAsync = promisify(execFile)
const RUNTIME_MANIFEST_FILE = 'runtime.json'
const DOWNLOAD_TIMEOUT_MS = 120_000
const ARCHIVE_TIMEOUT_MS = 60_000
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_LIST_BYTES = 4 * 1024 * 1024
const WORKER_TIMEOUT_MS = 10_000
const MAX_MEASUREMENT_BYTES = 4 * 1024 * 1024
const WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url))
let measurementQueue: Promise<void> = Promise.resolve()

type RuntimeManifest = {
  schema: 'tokenless.output-savings-runtime.v1'
  runtimeId: string
  version: string
  estimator: string
  downloadUrl: string
  archiveSha256: string
  license: 'MIT'
  repository: string
  installedAt: string
  checksumVerified: true
  selfTestVerified: true
}

type RuntimeInspectionBase = {
  runtimeId: string
  installed: boolean
  downloadBytes: number
  installedBytes: number
}

export type OutputSavingsRuntimeInspection = RuntimeInspectionBase & (
  | { state: 'not_installed' | 'invalid' }
  | { state: 'ready'; checksumVerified: true; selfTestVerified: true }
)

export class OutputSavingsRuntimeManager {
  readonly homeDir: string
  readonly tokenizerRoot: string
  readonly runtimesRoot: string
  readonly runtimeDirectory: string
  readonly installLockFile: string
  private verifiedReadyCache: { fingerprint: string; inspection: OutputSavingsRuntimeInspection } | undefined

  constructor(homeDir: string) {
    this.homeDir = path.resolve(homeDir)
    this.tokenizerRoot = path.join(this.homeDir, 'tokenizers')
    this.runtimesRoot = path.join(this.tokenizerRoot, 'runtimes')
    this.runtimeDirectory = path.join(this.runtimesRoot, OUTPUT_SAVINGS_RUNTIME_CATALOG.runtimeId)
    this.installLockFile = path.join(this.tokenizerRoot, 'install.writer.sqlite')
  }

  async inspect(): Promise<OutputSavingsRuntimeInspection> {
    const base = runtimeInspectionBase()
    try {
      const directoryMetadata = await fs.lstat(this.runtimeDirectory)
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        return { ...base, state: 'invalid', installed: false }
      }
      const fingerprintBefore = await runtimeFingerprint(this.runtimeDirectory)
      if (this.verifiedReadyCache?.fingerprint === fingerprintBefore) {
        return this.verifiedReadyCache.inspection
      }
      const manifest = parseManifest(JSON.parse(await fs.readFile(
        path.join(this.runtimeDirectory, RUNTIME_MANIFEST_FILE),
        'utf8',
      )))
      if (!manifest) return { ...base, state: 'invalid', installed: false }
      if (await fs.readFile(path.join(this.runtimeDirectory, OUTPUT_SAVINGS_RUNTIME_LICENSE_FILE), 'utf8') !== OUTPUT_SAVINGS_RUNTIME_LICENSE_TEXT) {
        return { ...base, state: 'invalid', installed: false }
      }
      for (const file of OUTPUT_SAVINGS_RUNTIME_CATALOG.files) {
        if (!await verifyRuntimeFile(this.runtimeDirectory, file)) {
          return { ...base, state: 'invalid', installed: false }
        }
      }
      const fingerprintAfter = await runtimeFingerprint(this.runtimeDirectory)
      if (fingerprintBefore !== fingerprintAfter) {
        this.verifiedReadyCache = undefined
        return { ...base, state: 'invalid', installed: false }
      }
      const inspection: OutputSavingsRuntimeInspection = {
        ...base,
        state: 'ready',
        installed: true,
        checksumVerified: true,
        selfTestVerified: true,
      }
      this.verifiedReadyCache = { fingerprint: fingerprintAfter, inspection }
      return inspection
    } catch (error) {
      this.verifiedReadyCache = undefined
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...base, state: 'not_installed', installed: false }
      }
      return { ...base, state: 'invalid', installed: false }
    }
  }

  async ensureInstalled(): Promise<OutputSavingsRuntimeInspection> {
    const cached = await this.inspect()
    if (cached.state === 'ready') return cached
    await fs.mkdir(this.tokenizerRoot, { recursive: true, mode: 0o700 })
    await fs.chmod(this.tokenizerRoot, 0o700).catch(() => undefined)
    return await withPrivateSqliteWriterLock(this.installLockFile, async () => {
      const afterLock = await this.inspect()
      if (afterLock.state === 'ready') return afterLock
      if (afterLock.state === 'invalid') {
        await fs.rm(this.runtimeDirectory, { recursive: true, force: true })
      }
      await this.install()
      const installed = await this.inspect()
      if (installed.state !== 'ready') {
        throw tokenlessError(
          'output_savings_runtime_install_invalid',
          'The output savings runtime did not pass installed-state verification.',
        )
      }
      return installed
    })
  }

  async remove(): Promise<OutputSavingsRuntimeInspection> {
    this.verifiedReadyCache = undefined
    await fs.rm(this.tokenizerRoot, { recursive: true, force: true })
    return await this.inspect()
  }

  async measure(
    text: string,
    options: { signal?: AbortSignal; installIfMissing?: boolean } = {},
  ): Promise<OutputSavingsResult> {
    const unavailable = (reason: Extract<OutputSavingsResult, { state: 'unavailable' }>['reason']): OutputSavingsResult => ({
      schema: OUTPUT_SAVINGS_MEASUREMENT_SCHEMA,
      state: 'unavailable',
      basis: 'visible_assistant_text',
      estimator: OUTPUT_SAVINGS_RUNTIME_CATALOG.estimator,
      estimatorRevision: OUTPUT_SAVINGS_RUNTIME_CATALOG.runtimeId,
      reason,
    })
    if (options.signal?.aborted) return unavailable('measurement_canceled')
    if (Buffer.byteLength(text, 'utf8') > MAX_MEASUREMENT_BYTES) return unavailable('text_too_large')
    let inspection = await this.inspect()
    if (inspection.state !== 'ready' && options.installIfMissing) {
      try {
        inspection = await this.ensureInstalled()
      } catch {
        return unavailable(options.signal?.aborted ? 'measurement_canceled' : 'runtime_not_ready')
      }
    }
    if (options.signal?.aborted) return unavailable('measurement_canceled')
    if (inspection.state !== 'ready') return unavailable('runtime_not_ready')
    try {
      const estimatedOutputTokens = await serializeMeasurement(() => runWorker(
        this.runtimeDirectory,
        text,
        options.signal,
      ))
      if (options.signal?.aborted) return unavailable('measurement_canceled')
      return {
        schema: OUTPUT_SAVINGS_MEASUREMENT_SCHEMA,
        state: 'measured',
        basis: 'visible_assistant_text',
        estimator: OUTPUT_SAVINGS_RUNTIME_CATALOG.estimator,
        estimatorRevision: OUTPUT_SAVINGS_RUNTIME_CATALOG.runtimeId,
        estimatedOutputTokens,
        visibleCharacters: [...text].length,
        sourceTextSha256: createHash('sha256').update(text).digest('hex'),
        measuredAt: new Date().toISOString(),
      }
    } catch {
      return unavailable(options.signal?.aborted ? 'measurement_canceled' : 'measurement_failed')
    }
  }

  private async install() {
    const temporaryRoot = path.join(this.tokenizerRoot, `.install-${randomUUID()}`)
    const archivePath = path.join(temporaryRoot, 'tiktoken.tgz')
    const extractedDirectory = path.join(temporaryRoot, 'extracted')
    const payloadDirectory = path.join(temporaryRoot, 'payload')
    await fs.mkdir(temporaryRoot, { recursive: false, mode: 0o700 })
    try {
      await downloadArtifact(archivePath)
      const archiveSha256 = await sha256File(archivePath)
      if (archiveSha256 !== OUTPUT_SAVINGS_RUNTIME_CATALOG.archiveSha256) {
        throw tokenlessError(
          'output_savings_runtime_checksum_mismatch',
          'The output savings runtime checksum did not match the pinned catalog.',
        )
      }
      await validateArchivePaths(archivePath)
      await fs.mkdir(extractedDirectory, { recursive: false, mode: 0o700 })
      await execFileAsync('tar', [
        '-xzf',
        archivePath,
        '-C',
        extractedDirectory,
        ...OUTPUT_SAVINGS_RUNTIME_CATALOG.files.map((file) => file.archivePath),
      ], { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: MAX_ARCHIVE_LIST_BYTES })
      await fs.mkdir(payloadDirectory, { recursive: false, mode: 0o700 })
      for (const file of OUTPUT_SAVINGS_RUNTIME_CATALOG.files) {
        const source = path.join(extractedDirectory, file.archivePath)
        if (!await verifyStandaloneFile(source, file)) {
          throw tokenlessError(
            'output_savings_runtime_file_invalid',
            `The output savings runtime file failed verification: ${file.relativePath}.`,
          )
        }
        const destination = path.join(payloadDirectory, file.relativePath)
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
        await fs.copyFile(source, destination)
        await fs.chmod(destination, 0o600).catch(() => undefined)
      }
      const selfTestTokens = await runWorker(payloadDirectory, 'hello world')
      if (selfTestTokens !== 2) {
        throw tokenlessError(
          'output_savings_runtime_self_test_failed',
          `The output savings runtime self-test returned ${selfTestTokens}; expected 2.`,
        )
      }
      const manifest: RuntimeManifest = {
        schema: 'tokenless.output-savings-runtime.v1',
        runtimeId: OUTPUT_SAVINGS_RUNTIME_CATALOG.runtimeId,
        version: OUTPUT_SAVINGS_RUNTIME_CATALOG.version,
        estimator: OUTPUT_SAVINGS_RUNTIME_CATALOG.estimator,
        downloadUrl: OUTPUT_SAVINGS_RUNTIME_CATALOG.downloadUrl,
        archiveSha256: OUTPUT_SAVINGS_RUNTIME_CATALOG.archiveSha256,
        license: OUTPUT_SAVINGS_RUNTIME_CATALOG.license,
        repository: OUTPUT_SAVINGS_RUNTIME_CATALOG.repository,
        installedAt: new Date().toISOString(),
        checksumVerified: true,
        selfTestVerified: true,
      }
      await fs.writeFile(
        path.join(payloadDirectory, OUTPUT_SAVINGS_RUNTIME_LICENSE_FILE),
        OUTPUT_SAVINGS_RUNTIME_LICENSE_TEXT,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      )
      await writeJsonAtomic(path.join(payloadDirectory, RUNTIME_MANIFEST_FILE), manifest)
      await fs.mkdir(this.runtimesRoot, { recursive: true, mode: 0o700 })
      await fs.rename(payloadDirectory, this.runtimeDirectory)
    } catch (error) {
      if (isOutputSavingsRuntimeError(error)) throw error
      throw tokenlessError(
        'output_savings_runtime_install_failed',
        'The output savings runtime could not be installed.',
        { cause: error, retryable: true },
      )
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function runtimeFingerprint(runtimeDirectory: string) {
  const paths = [
    runtimeDirectory,
    path.join(runtimeDirectory, RUNTIME_MANIFEST_FILE),
    path.join(runtimeDirectory, OUTPUT_SAVINGS_RUNTIME_LICENSE_FILE),
    ...OUTPUT_SAVINGS_RUNTIME_CATALOG.files.map((file) => path.join(runtimeDirectory, file.relativePath)),
  ]
  const parts: string[] = []
  for (const candidate of paths) {
    const metadata = await fs.lstat(candidate)
    parts.push([
      path.relative(runtimeDirectory, candidate) || '.',
      metadata.mode,
      metadata.size,
      metadata.mtimeMs,
      metadata.ctimeMs,
      metadata.ino,
      metadata.isSymbolicLink() ? 'symlink' : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other',
    ].join(':'))
  }
  return parts.join('|')
}

function runtimeInspectionBase(): RuntimeInspectionBase {
  return {
    runtimeId: OUTPUT_SAVINGS_RUNTIME_CATALOG.runtimeId,
    installed: false,
    downloadBytes: OUTPUT_SAVINGS_RUNTIME_CATALOG.downloadBytes,
    installedBytes: OUTPUT_SAVINGS_RUNTIME_CATALOG.installedBytes,
  }
}

async function downloadArtifact(destination: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(OUTPUT_SAVINGS_RUNTIME_CATALOG.downloadUrl, {
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      throw tokenlessError(
        'output_savings_runtime_download_failed',
        `The output savings runtime download failed with HTTP ${response.status}.`,
        { retryable: response.status === 429 || response.status >= 500 },
      )
    }
    let downloadedBytes = 0
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length
        if (downloadedBytes > MAX_DOWNLOAD_BYTES) {
          callback(tokenlessError(
            'output_savings_runtime_download_too_large',
            'The output savings runtime exceeded its maximum accepted download size.',
          ))
          return
        }
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as never),
      limit,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    )
  } catch (error) {
    if (isOutputSavingsRuntimeError(error)) throw error
    throw tokenlessError(
      controller.signal.aborted
        ? 'output_savings_runtime_download_timeout'
        : 'output_savings_runtime_download_failed',
      controller.signal.aborted
        ? 'The output savings runtime download timed out.'
        : 'The output savings runtime download failed.',
      { cause: error, retryable: !controller.signal.aborted },
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function validateArchivePaths(archivePath: string) {
  const listing = await execFileAsync('tar', ['-tf', archivePath], {
    timeout: ARCHIVE_TIMEOUT_MS,
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
  })
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (entries.length === 0) {
    throw tokenlessError('output_savings_runtime_archive_invalid', 'The output savings runtime archive is empty.')
  }
  const available = new Set(entries)
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (
      normalized.startsWith('/') ||
      /^[a-zA-Z]:\//.test(normalized) ||
      normalized.split('/').includes('..') ||
      normalized.includes('\u0000')
    ) {
      throw tokenlessError(
        'output_savings_runtime_archive_unsafe',
        `The output savings runtime archive contains an unsafe path: ${entry}.`,
      )
    }
  }
  for (const file of OUTPUT_SAVINGS_RUNTIME_CATALOG.files) {
    if (!available.has(file.archivePath)) {
      throw tokenlessError(
        'output_savings_runtime_archive_invalid',
        `The output savings runtime archive is missing ${file.archivePath}.`,
      )
    }
  }
}

async function verifyRuntimeFile(root: string, file: (typeof OUTPUT_SAVINGS_RUNTIME_CATALOG.files)[number]) {
  return await verifyStandaloneFile(path.join(root, file.relativePath), file, root)
}

async function verifyStandaloneFile(
  filePath: string,
  expected: (typeof OUTPUT_SAVINGS_RUNTIME_CATALOG.files)[number],
  expectedRoot?: string,
) {
  try {
    const metadata = await fs.lstat(filePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expected.size) return false
    if (expectedRoot) {
      const [canonicalRoot, canonicalFile] = await Promise.all([
        fs.realpath(expectedRoot),
        fs.realpath(filePath),
      ])
      const relative = path.relative(canonicalRoot, canonicalFile)
      if (relative.startsWith('..') || path.isAbsolute(relative)) return false
    }
    return await sha256File(filePath) === expected.sha256
  } catch {
    return false
  }
}

async function sha256File(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function runWorker(runtimeDirectory: string, text: string, signal?: AbortSignal) {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH, runtimeDirectory], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const output: Buffer[] = []
    let outputBytes = 0
    let errorBytes = 0
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, WORKER_TIMEOUT_MS)
    const abort = () => child.kill()
    const cleanupSignal = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes <= 1024 * 1024) output.push(chunk)
      else child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length
      if (errorBytes > 1024 * 1024) child.kill()
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      cleanupSignal()
      reject(error)
    })
    child.once('close', (code, closeSignal) => {
      clearTimeout(timeout)
      cleanupSignal()
      if (code === 0 && closeSignal === null && outputBytes <= 1024 * 1024) {
        resolve(Buffer.concat(output).toString('utf8'))
        return
      }
      reject(tokenlessError(
        'output_savings_runtime_worker_failed',
        timedOut
          ? 'The output savings runtime worker timed out.'
          : 'The output savings runtime worker failed.',
      ))
    })
    child.stdin.end(text)
  })
  const payload = JSON.parse(stdout) as unknown
  if (!isRecord(payload) || typeof payload.tokens !== 'number' || !Number.isSafeInteger(payload.tokens) || payload.tokens < 0) {
    throw tokenlessError('output_savings_runtime_worker_invalid', 'The output savings runtime returned an invalid result.')
  }
  return payload.tokens
}

async function serializeMeasurement<T>(operation: () => Promise<T>): Promise<T> {
  const result = measurementQueue.then(operation, operation)
  measurementQueue = result.then(() => undefined, () => undefined)
  return await result
}

function parseManifest(value: unknown): RuntimeManifest | null {
  if (!isRecord(value)) return null
  if (
    value.schema !== 'tokenless.output-savings-runtime.v1' ||
    value.runtimeId !== OUTPUT_SAVINGS_RUNTIME_CATALOG.runtimeId ||
    value.version !== OUTPUT_SAVINGS_RUNTIME_CATALOG.version ||
    value.estimator !== OUTPUT_SAVINGS_RUNTIME_CATALOG.estimator ||
    value.downloadUrl !== OUTPUT_SAVINGS_RUNTIME_CATALOG.downloadUrl ||
    value.archiveSha256 !== OUTPUT_SAVINGS_RUNTIME_CATALOG.archiveSha256 ||
    value.license !== OUTPUT_SAVINGS_RUNTIME_CATALOG.license ||
    value.repository !== OUTPUT_SAVINGS_RUNTIME_CATALOG.repository ||
    typeof value.installedAt !== 'string' ||
    value.checksumVerified !== true ||
    value.selfTestVerified !== true
  ) return null
  return value as RuntimeManifest
}

async function writeJsonAtomic(file: string, payload: unknown) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function isOutputSavingsRuntimeError(error: unknown) {
  return isRecord(error) && typeof error.code === 'string' && error.code.startsWith('output_savings_runtime_')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
