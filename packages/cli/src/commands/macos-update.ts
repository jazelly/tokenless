import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { tokenlessPackageVersion } from '#tokenless-server/platform-package.js'
import { stopDaemon } from '../bootstrap/runtime.js'
import { installTokenlessSkills, type TokenlessSkillCheck } from '../bootstrap/setup-workflow.js'
import { compareSemanticVersions, isSemanticVersion } from '../http/version-check.js'
import {
  findRunningMenuPids,
  readMacOSAppPackageVersion,
  readMacOSAppVersion,
  replaceMacOSApp,
  stopRunningMenuApp,
  validateMacOSAppBundle,
} from './macos-app-replacement.mjs'

const execFile = promisify(execFileCallback)

export const MACOS_APP_RELEASE_API_URL = 'https://api.github.com/repos/jazelly/tokenless/releases/latest'
export const MACOS_APP_RELEASE_ASSET_PREFIX = 'tokenless-macos-darwin-arm64-v'
export const MACOS_APP_RELEASE_REPOSITORY = 'jazelly/tokenless'

const CHECK_TIMEOUT_MS = 5_000
const UPDATE_TIMEOUT_MS = 120_000
const MAX_RELEASE_RESPONSE_BYTES = 512 * 1024
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024

export type MacOSAppUpdateAsset = {
  name: string
  url: string
  version: string
  sha256: string
  size: number
  releaseUrl: string
  checksumUrl: string
}

export type MacOSAppUpdateCheck = {
  ok: boolean
  channel: 'macos'
  current: string
  latest: string | null
  updateAvailable: boolean | null
  status: 'up_to_date' | 'update_available' | 'check_unavailable' | 'asset_unavailable' | 'unsupported_platform' | 'package_available'
  asset?: MacOSAppUpdateAsset
  releaseUrl?: string
  error?: UpdateError
}

export type MacOSAppRuntimeProof = {
  ok: true
  version: string
  databaseVersion: number
  skills: TokenlessSkillCheck
  daemon: { version: string; pid: number; url: string }
  api: { ok: true }
}

export type MacOSAppUpdateResult = {
  ok: boolean
  channel: 'macos'
  status?: 'up_to_date' | 'updated'
  beforeVersion: string
  afterVersion: string | null
  asset?: MacOSAppUpdateAsset
  runtime?: MacOSAppRuntimeProof
  skills?: TokenlessSkillCheck
  error?: UpdateError
}

export type UpdateError = { code: string; message: string; retryable: boolean }

export type MacOSAppContext = {
  appPath: string
  nodePath: string
  cliEntrypoint: string
  updateRuntimeEntrypoint: string
}

export type MacOSAppUpdateOptions = {
  homeDir: string
  currentVersion?: string
  packagePath?: string
  daemonUrl?: string
  timeoutMs?: number
}

export function macOSAppReleaseAssetName(version: string) {
  return `${MACOS_APP_RELEASE_ASSET_PREFIX}${version}.zip`
}

/** Detect the embedded runtime without relying on an environment switch. */
export function detectEmbeddedMacOSApp(entrypoint = process.argv[1]): MacOSAppContext | null {
  if (process.platform !== 'darwin' || typeof entrypoint !== 'string' || entrypoint.length === 0) return null
  const resolved = path.resolve(entrypoint)
  const suffix = path.join('Contents', 'Resources', 'runtime', 'cli', 'dist', 'src', 'tokenless.mjs')
  if (!resolved.endsWith(suffix)) return null
  const appPath = resolved.slice(0, -suffix.length).replace(/[\\/]$/, '')
  if (!appPath.endsWith('.app')) return null
  const runtime = path.join(appPath, 'Contents', 'Resources', 'runtime')
  return {
    appPath,
    nodePath: path.join(runtime, 'node'),
    cliEntrypoint: resolved,
    updateRuntimeEntrypoint: path.join(runtime, 'cli', 'dist', 'src', 'bootstrap', 'update-runtime.mjs'),
  }
}

export async function checkMacOSAppUpdate({
  currentVersion = tokenlessPackageVersion(),
  packagePath,
  timeoutMs = CHECK_TIMEOUT_MS,
}: { currentVersion?: string; packagePath?: string; timeoutMs?: number } = {}): Promise<MacOSAppUpdateCheck> {
  const base = { channel: 'macos' as const, current: currentVersion }
  if (process.platform !== 'darwin') {
    return {
      ...base,
      ok: false,
      latest: null,
      updateAvailable: null,
      status: 'unsupported_platform',
      error: errorValue('macos_app_unsupported_platform', 'The macOS app update is only available on macOS.', false),
    }
  }
  try {
    if (packagePath !== undefined) {
      const local = await inspectArchive(packagePath, currentVersion)
      return { ...base, ok: true, latest: local.version, updateAvailable: true, status: 'package_available', asset: local.asset }
    }

    const release = await readRelease(timeoutMs)
    const archiveName = macOSAppReleaseAssetName(release.version)
    const archive = release.assets.find((item) => item.name === archiveName)
    const checksum = release.assets.find((item) => item.name === `${archiveName}.sha256`)
    if (archive === undefined || checksum === undefined) {
      throw codedError(
        'macos_app_release_asset_unavailable',
        `GitHub release ${release.version} does not contain ${archiveName} and its SHA-256 checksum.`,
        false,
      )
    }
    const checksumText = await fetchReleaseText(checksum.url, timeoutMs)
    const sha256 = parseChecksum(checksumText, archiveName)
    if (sha256 === null) throw codedError('macos_app_release_checksum_invalid', `GitHub release ${release.version} has an invalid SHA-256 checksum for ${archiveName}.`, false)
    const comparison = compareSemanticVersions(currentVersion, release.version)
    if (comparison === null) throw codedError('macos_app_current_version_invalid', 'The running Tokenless version is invalid.', false)
    const asset: MacOSAppUpdateAsset = {
      ...archive,
      version: release.version,
      sha256,
      checksumUrl: checksum.url,
      releaseUrl: release.releaseUrl,
    }
    return {
      ...base,
      ok: true,
      latest: release.version,
      updateAvailable: comparison < 0,
      status: comparison < 0 ? 'update_available' : 'up_to_date',
      releaseUrl: release.releaseUrl,
      asset,
    }
  } catch (error) {
    const detail = readError(error, 'macos_app_release_unavailable', true)
    return {
      ...base,
      ok: false,
      latest: null,
      updateAvailable: null,
      status: detail.code === 'macos_app_release_asset_unavailable' || detail.code === 'macos_app_release_checksum_invalid' ? 'asset_unavailable' : 'check_unavailable',
      error: detail,
    }
  }
}

/** Replace the complete embedded app and prove the newly installed runtime. */
export async function runMacOSAppUpdate(options: MacOSAppUpdateOptions): Promise<MacOSAppUpdateResult> {
  const beforeVersion = options.currentVersion ?? tokenlessPackageVersion()
  const context = detectEmbeddedMacOSApp()
  if (context === null) return failedResult(beforeVersion, errorValue('macos_app_context_required', 'The macOS app update must run from the embedded Tokenless app runtime.', false))

  let temporaryRoot: string | undefined
  let asset: MacOSAppUpdateAsset | undefined
  try {
    validateMacOSAppBundle(context.appPath, 'current macOS app', true)
    if (readMacOSAppVersion(context.appPath) !== beforeVersion || readMacOSAppPackageVersion(context.appPath) !== beforeVersion) {
      throw codedError('macos_app_version_mismatch', 'The current macOS app version does not match its embedded Tokenless CLI.', false)
    }
    let archivePath: string
    let targetVersion: string
    if (options.packagePath !== undefined) {
      const local = await inspectArchive(options.packagePath, beforeVersion)
      archivePath = local.archivePath
      targetVersion = local.version
      asset = local.asset
    } else {
      const check = await checkMacOSAppUpdate({
        currentVersion: beforeVersion,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      if (!check.ok || check.asset === undefined || check.updateAvailable !== true || check.latest === null) {
        if (check.ok && check.latest !== null) {
          const comparison = compareSemanticVersions(beforeVersion, check.latest)
          if (comparison === 0) {
            return { ok: true, channel: 'macos', status: 'up_to_date', beforeVersion, afterVersion: beforeVersion, skills: (await installTokenlessSkills()).check, ...(check.asset === undefined ? {} : { asset: check.asset }) }
          }
          if (comparison !== null && comparison > 0) {
            throw codedError('macos_app_downgrade_rejected', 'The selected macOS app release is older than the running version.', false)
          }
        }
        throw codedError(
          check.error?.code ?? 'macos_app_no_update_available',
          check.error?.message ?? 'No macOS app update is available.',
          check.error?.retryable ?? false,
        )
      }
      targetVersion = check.latest
      asset = check.asset
      temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-macos-update-'))
      archivePath = path.join(temporaryRoot, macOSAppReleaseAssetName(targetVersion))
      await downloadArchive(asset, archivePath, options.timeoutMs)
    }

    let proof: MacOSAppRuntimeProof | undefined
    await replaceMacOSApp({
      archivePath,
      installedAppPath: context.appPath,
      // This runs while the candidate is staged, before stopping the old app.
      beforeReplace: (candidate) => {
        validateMacOSAppBundle(candidate, 'staged macOS app', true)
        if (readMacOSAppVersion(candidate) !== targetVersion || readMacOSAppPackageVersion(candidate) !== targetVersion) throw codedError('macos_app_version_mismatch', 'The app bundle version did not match the release metadata.', false)
        const oldExecutable = path.join(context.appPath, 'Contents', 'MacOS', 'TokenlessMenuBar')
        if (findRunningMenuPids(oldExecutable).length > 0) stopRunningMenuApp(oldExecutable)
        return stopDaemon({
          homeDir: options.homeDir,
          ...(options.daemonUrl === undefined ? {} : { daemonUrl: options.daemonUrl }),
          timeoutMs: normalizeTimeout(options.timeoutMs, 5_000),
        }).then(() => undefined)
      },
      // Once this callback starts, the new runtime may have migrated SQLite;
      // replacement deliberately never restores the old bundle after failure.
      beforeLaunch: async (installed) => {
        proof = await activateNewRuntime({
          appPath: installed,
          homeDir: options.homeDir,
          ...(options.daemonUrl === undefined ? {} : { daemonUrl: options.daemonUrl }),
          timeoutMs: normalizeTimeout(options.timeoutMs, UPDATE_TIMEOUT_MS),
          expectedVersion: targetVersion,
        })
      },
      launchArguments: ['--home', options.homeDir],
    })
    if (proof === undefined) throw codedError('macos_app_runtime_proof_missing', 'The new Tokenless runtime did not return activation proof.', false)
    return { ok: true, channel: 'macos', status: 'updated', beforeVersion, afterVersion: proof.version, asset, runtime: proof }
  } catch (error) {
    const detail = readError(error, 'macos_app_update_failed', true)
    showNativeUpdateFailure(detail)
    return { ...failedResult(beforeVersion, detail), ...(asset === undefined ? {} : { asset }) }
  } finally {
    if (temporaryRoot !== undefined) await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function readRelease(timeoutMs: number) {
  const text = await fetchReleaseText(MACOS_APP_RELEASE_API_URL, timeoutMs, true)
  let value: any
  try { value = JSON.parse(text) } catch { throw codedError('macos_app_release_invalid_response', 'GitHub returned invalid release JSON.', false) }
  if (!isRecord(value) || typeof value.tag_name !== 'string' || typeof value.html_url !== 'string' || !Array.isArray(value.assets)) throw codedError('macos_app_release_invalid_response', 'GitHub returned an invalid Tokenless release payload.', false)
  const version = value.tag_name.replace(/^v/, '')
  if (!isSemanticVersion(version) || !isTrustedReleaseUrl(value.html_url)) throw codedError('macos_app_release_invalid_response', 'GitHub returned an invalid Tokenless release version or URL.', false)
  const assets: ReleaseAsset[] = []
  for (const item of value.assets) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.browser_download_url !== 'string') continue
    if (!isTrustedAssetUrl(item.browser_download_url)) throw codedError('macos_app_release_invalid_response', 'GitHub returned an untrusted macOS asset URL.', false)
    assets.push({
      name: item.name,
      url: item.browser_download_url,
      size: typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : 0,
    })
  }
  return { version, releaseUrl: value.html_url, assets }
}

type ReleaseAsset = { name: string; url: string; size: number }

async function inspectArchive(archivePath: string, currentVersion: string) {
  if (path.extname(archivePath).toLowerCase() !== '.zip') throw new Error('The macOS app package must be a .zip archive.')
  const canonical = await fsp.realpath(archivePath)
  const stat = await fsp.stat(canonical)
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) throw new Error('The macOS app package is missing, invalid, or too large.')
  const version = await readArchiveVersion(canonical)
  const comparison = compareSemanticVersions(version, currentVersion)
  if (comparison === null) throw new Error('The running Tokenless version is invalid.')
  if (comparison < 0) throw codedError('macos_app_downgrade_rejected', 'The selected macOS app package is older than the running version.', false)
  const sha256 = await hashFile(canonical)
  const fileUrl = pathToFileURL(canonical).toString()
  return {
    archivePath: canonical,
    version,
    asset: { name: path.basename(canonical), url: fileUrl, version, sha256, size: stat.size, releaseUrl: fileUrl, checksumUrl: fileUrl },
  }
}

async function readArchiveVersion(archivePath: string) {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-archive-info-'))
  const plistPath = path.join(temporaryRoot, 'Info.plist')
  try {
    const { stdout } = await execFile('/usr/bin/unzip', ['-p', archivePath, 'Tokenless.app/Contents/Info.plist'], { timeout: 10_000, maxBuffer: MAX_PROCESS_OUTPUT_BYTES, encoding: 'utf8' })
    if (!stdout.trim()) throw new Error('The macOS app archive has no readable Info.plist.')
    await fsp.writeFile(plistPath, stdout)
    const converted = await execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plistPath], { timeout: 10_000, maxBuffer: MAX_PROCESS_OUTPUT_BYTES, encoding: 'utf8' })
    const parsed = JSON.parse(converted.stdout) as { CFBundleShortVersionString?: unknown; CFBundleVersion?: unknown }
    const version = typeof parsed.CFBundleShortVersionString === 'string' ? parsed.CFBundleShortVersionString : parsed.CFBundleVersion
    if (!isSemanticVersion(version)) throw new Error('The macOS app archive has no valid app version.')
    return version
  } catch (error) {
    if (isRecord(error) && typeof error.code === 'string' && error.code.startsWith('macos_')) throw error
    throw new Error(`The macOS app archive has an invalid Info.plist: ${formatError(error)}`)
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function downloadArchive(asset: MacOSAppUpdateAsset, destination: string, timeoutMs: number | undefined) {
  let response: Response
  try {
    response = await fetch(asset.url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'tokenless-cli' },
      redirect: 'follow',
      signal: AbortSignal.timeout(normalizeTimeout(timeoutMs, UPDATE_TIMEOUT_MS)),
    })
  } catch (error) {
    throw codedError('macos_app_download_unavailable', formatError(error), true)
  }
  if (!isTrustedAssetFetchUrl(response.url)) throw codedError('macos_app_download_untrusted_redirect', 'The macOS app download redirected to an untrusted host.', false)
  if (!response.ok || response.body === null) throw codedError('macos_app_download_http_error', `GitHub returned HTTP ${response.status} for the macOS app.`, true)
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > MAX_ARCHIVE_BYTES) throw codedError('macos_app_archive_too_large', 'The macOS app archive is too large.', false)
  const file = await fsp.open(destination, 'w', 0o600)
  const hash = createHash('sha256')
  const reader = response.body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > MAX_ARCHIVE_BYTES) throw codedError('macos_app_archive_too_large', 'The macOS app archive is too large.', false)
      hash.update(value)
      await file.write(value)
    }
    await file.close()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    await file.close().catch(() => undefined)
    await fsp.rm(destination, { force: true }).catch(() => undefined)
    throw error
  }
  if (hash.digest('hex') !== asset.sha256) {
    await fsp.rm(destination, { force: true }).catch(() => undefined)
    throw codedError('macos_app_checksum_mismatch', 'The downloaded macOS app checksum did not match the release metadata.', false)
  }
}

async function activateNewRuntime({
  appPath,
  homeDir,
  daemonUrl,
  timeoutMs,
  expectedVersion,
}: { appPath: string; homeDir: string; daemonUrl?: string; timeoutMs: number; expectedVersion: string }) {
  const context = detectEmbeddedMacOSApp(path.join(appPath, 'Contents', 'Resources', 'runtime', 'cli', 'dist', 'src', 'tokenless.mjs'))
  if (context === null) throw codedError('macos_app_candidate_invalid', 'The staged macOS app runtime could not be located.', false)
  validateMacOSAppBundle(appPath, 'staged macOS app', true)
  const { stdout } = await execFile(context.nodePath, [context.updateRuntimeEntrypoint, homeDir, daemonUrl ?? '', String(timeoutMs)], {
    timeout: timeoutMs + 30_000,
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    encoding: 'utf8',
  }).catch((error) => { throw activationError(error) })
  let payload: any
  try { payload = JSON.parse(stdout) } catch { throw codedError('macos_app_runtime_proof_invalid', 'The new Tokenless runtime returned invalid activation proof.', false) }
  const daemon = isRecord(payload?.daemon) ? payload.daemon : null
  if (payload?.ok !== true || typeof payload.version !== 'string' || !Number.isInteger(payload.databaseVersion) || payload.databaseVersion < 0 || typeof daemon?.version !== 'string' || !Number.isInteger(daemon.pid) || daemon.pid <= 0 || typeof daemon.url !== 'string' || payload.api?.ok !== true || payload.skills?.ok !== true) throw codedError('macos_app_runtime_proof_invalid', 'The new Tokenless runtime did not prove daemon, database, and API readiness.', false)
  if (payload.version !== expectedVersion || daemon.version !== payload.version) throw codedError('macos_app_runtime_version_mismatch', 'The activated Tokenless runtime version did not match the release.', false)
  return {
    ok: true as const,
    version: payload.version,
    databaseVersion: payload.databaseVersion,
    skills: payload.skills as TokenlessSkillCheck,
    daemon: { version: daemon.version, pid: daemon.pid, url: daemon.url },
    api: { ok: true as const },
  }
}

async function fetchReleaseText(url: string, timeoutMs: number | undefined, api = false) {
  const response = await fetch(url, {
    headers: { Accept: api ? 'application/vnd.github+json' : 'text/plain, application/octet-stream', 'User-Agent': 'tokenless-cli' },
    redirect: 'follow',
    signal: AbortSignal.timeout(normalizeTimeout(timeoutMs, CHECK_TIMEOUT_MS)),
  })
  if (!api && !isTrustedAssetFetchUrl(response.url)) throw new Error('GitHub asset redirected to an untrusted host.')
  if (api && !isTrustedApiUrl(response.url)) throw new Error('GitHub API redirected to an untrusted host.')
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`)
  return await readResponseText(response, MAX_RELEASE_RESPONSE_BYTES)
}

async function readResponseText(response: Response, maxBytes: number) {
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes.`)
  const reader = response.body?.getReader()
  if (reader === undefined) return await response.text()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes.`)
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(output)
}

function parseChecksum(value: string, archiveName: string) {
  const match = /^([0-9a-f]{64})\s+[*]?(.+?)\s*$/im.exec(value.trim())
  return match?.[2] === archiveName ? match[1]?.toLowerCase() ?? null : null
}

async function hashFile(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Uint8Array)
  return hash.digest('hex')
}

function isTrustedApiUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'api.github.com' && url.username === '' && url.password === '' } catch { return false }
}

function isTrustedReleaseUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/jazelly/tokenless/releases/tag/') && url.username === '' && url.password === '' } catch { return false }
}

function isTrustedAssetUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/jazelly/tokenless/releases/download/') && url.username === '' && url.password === '' } catch { return false }
}

function isTrustedAssetFetchUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(url.hostname) && url.username === '' && url.password === '' } catch { return false }
}

function normalizeTimeout(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 2_147_483_647 ? Math.floor(value) : fallback
}

function codedError(code: string, message: string, retryable: boolean) {
  return Object.assign(new Error(message), { code, retryable })
}

function errorValue(code: string, message: string, retryable: boolean): UpdateError { return { code, message, retryable } }

function readError(error: unknown, fallbackCode: string, fallbackRetryable: boolean): UpdateError {
  if (isRecord(error) && typeof error.code === 'string') return errorValue(error.code, formatError(error), typeof error.retryable === 'boolean' ? error.retryable : fallbackRetryable)
  return errorValue(fallbackCode, formatError(error), fallbackRetryable)
}

function failedResult(beforeVersion: string, error: UpdateError): MacOSAppUpdateResult {
  return { ok: false, channel: 'macos', beforeVersion, afterVersion: null, error }
}

function activationError(error: unknown) {
  const output = isRecord(error) && typeof error.stdout === 'string' ? error.stdout : ''
  if (output !== '') {
    try {
      const payload = JSON.parse(output)
      if (typeof payload?.error?.code === 'string') {
        return codedError(
          payload.error.code,
          typeof payload.error.message === 'string' ? payload.error.message : 'The new Tokenless runtime could not be activated.',
          payload.error.retryable === true,
        )
      }
    } catch {
      // Keep subprocess output private when no structured proof is available.
    }
  }
  return codedError('macos_app_runtime_activation_failed', 'The new Tokenless runtime could not be activated. / 新版 Tokenless runtime 无法激活。', true)
}

function showNativeUpdateFailure(error: UpdateError) {
  if (detectEmbeddedMacOSApp() === null) return
  const message = `Tokenless update failed / Tokenless 更新失败。 Code / 错误代码：${error.code}`
  const script = `display dialog ${JSON.stringify(message)} with title "Tokenless Update / Tokenless 更新" buttons {"OK"} default button "OK" giving up after 30`
  try { const child = spawn('/usr/bin/osascript', ['-e', script], { detached: true, stdio: 'ignore' }); child.unref() } catch { /* CLI output remains authoritative. */ }
}

function formatError(error: unknown) { return error instanceof Error ? error.message : String(error) }

function isRecord(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
