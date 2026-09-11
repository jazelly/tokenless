import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { chromium } from 'playwright-core'
import { tokenlessError } from '../errors.js'
import {
  allManagedBrowserCatalogEntries,
  currentBrowserRuntimePlatform,
  managedBrowserCatalogEntry,
  type ManagedBrowserArchiveFormat,
  type ManagedBrowserCatalogEntry,
} from './catalog.js'
import {
  SYSTEM_BROWSER_IDS,
  isSystemBrowserId,
  normalizeBrowserSelection,
  type BrowserCandidate,
  type BrowserRuntimeBinding,
  type BrowserRuntimeInspection,
  type BrowserRuntimePlatform,
  type BrowserRuntimeProgress,
  type BrowserSelection,
  type EnsureBrowserRuntimeOptions,
  type ManagedBrowserFamily,
  type ResolvedBrowserRuntime,
  type SystemBrowserId,
} from './types.js'

const RUNTIME_MANIFEST_FILE = 'runtime.json'
const INSTALLED_INDEX_FILE = 'installed.json'
const MAX_ARCHIVE_LIST_BYTES = 32 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 800 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const ARCHIVE_TIMEOUT_MS = 10 * 60_000
const VERSION_TIMEOUT_MS = 15_000
const SMOKE_LAUNCH_TIMEOUT_MS = 45_000

type RuntimeManifest = {
  version: 1
  runtimeId: string
  family: ManagedBrowserFamily
  browserId: ManagedBrowserFamily
  platform: BrowserRuntimePlatform
  artifactVersion: string
  browserVersion: string
  sha256: string
  downloadUrl: string
  executableRelativePath: string
  installedAt: string
  checksumVerified: true
  smokeLaunchVerified: true
}

type ProfileWithRuntimeBinding = {
  slug: string
  runtimeBinding?: BrowserRuntimeBinding | undefined
}

type BrowserRuntimeManagerOptions = {
  homeDir: string
}

export class BrowserRuntimeManager {
  readonly homeDir: string
  readonly browserRoot: string
  readonly runtimesRoot: string
  readonly installedIndexFile: string

  constructor(options: BrowserRuntimeManagerOptions) {
    this.homeDir = path.resolve(options.homeDir)
    this.browserRoot = path.join(this.homeDir, 'browser')
    this.runtimesRoot = path.join(this.browserRoot, 'runtimes')
    this.installedIndexFile = path.join(this.browserRoot, INSTALLED_INDEX_FILE)
  }

  async discover(): Promise<BrowserCandidate[]> {
    const platform = supportedPlatform()
    const system = (await Promise.all(SYSTEM_BROWSER_IDS.map(async (browserId) => (
      await this.resolveSystemBrowser(browserId, platform).catch(() => null)
    )))).filter((candidate): candidate is ResolvedBrowserRuntime => candidate !== null)

    const managed = (await Promise.all(allManagedBrowserCatalogEntries()
      .filter((entry) => entry.platform === platform)
      .map(async (entry) => (
        await this.resolveCachedManagedRuntime(entry).catch(() => null)
      )))).filter((candidate): candidate is ResolvedBrowserRuntime => candidate !== null)

    return [...system, ...managed].map(runtimeCandidate)
  }

  async ensure(
    requested: BrowserSelection | string,
    options: EnsureBrowserRuntimeOptions = {},
  ): Promise<ResolvedBrowserRuntime> {
    const selection = normalizeBrowserSelection(requested)
    if (!selection) {
      throw tokenlessError(
        'invalid_browser',
        'Browser must be auto, a supported system browser, managed-chromium, or cloak.',
      )
    }
    const platform = supportedPlatform()
    if (options.repair === true && selection !== 'managed-chromium' && selection !== 'cloak') {
      throw tokenlessError(
        'browser_runtime_repair_requires_managed_selection',
        'Browser runtime repair requires an explicit managed-chromium or cloak selection.',
      )
    }
    if (selection === 'auto') {
      return await this.ensureManagedRuntime('managed-chromium', platform, options)
    }
    if (selection === 'profile') return await this.resolveTestProfile(platform, options.browserExecutablePath)
    if (isSystemBrowserId(selection)) {
      return await this.requireSystemBrowser(selection, platform, options.browserExecutablePath)
    }
    return await this.ensureManagedRuntime(selection, platform, options)
  }

  async resolveForProfile(
    profile: ProfileWithRuntimeBinding,
    options: EnsureBrowserRuntimeOptions = {},
  ): Promise<ResolvedBrowserRuntime> {
    const binding = profile.runtimeBinding
    if (!binding) {
      throw tokenlessError(
        'profile_runtime_binding_required',
        `Managed profile '${profile.slug}' predates browser runtime binding. Rerun tokenless setup and explicitly select a compatible browser.`,
      )
    }
    const selection = selectionForBinding(binding)
    const runtime = await this.ensure(selection, {
      ...options,
      allowDownload: false,
      browserExecutablePath: binding.executablePath,
    })
    if (
      runtime.runtimeId !== binding.runtimeId ||
      runtime.family !== binding.family ||
      runtime.browserId !== binding.browserId ||
      runtime.executablePath !== binding.executablePath
    ) {
      throw tokenlessError(
        'profile_runtime_mismatch',
        `Managed profile '${profile.slug}' is bound to browser runtime ${binding.runtimeId} at ${binding.executablePath}, but Tokenless resolved ${runtime.runtimeId} at ${runtime.executablePath}.`,
      )
    }
    if (compareBrowserVersions(runtime.actualVersion, binding.createdWithVersion) < 0) {
      throw tokenlessError(
        'profile_browser_downgrade_blocked',
        `Managed profile '${profile.slug}' was created with browser ${binding.createdWithVersion}; refusing to open it with older browser ${runtime.actualVersion}.`,
      )
    }
    return runtime
  }

  async inspect(
    selectionOrProfile: BrowserSelection | string | ProfileWithRuntimeBinding,
    options: EnsureBrowserRuntimeOptions = {},
  ): Promise<BrowserRuntimeInspection> {
    try {
      const runtime = typeof selectionOrProfile === 'object'
        ? await this.resolveForProfile(selectionOrProfile, options)
        : await this.ensure(selectionOrProfile, { ...options, allowDownload: false })
      return {
        ok: true,
        selection: runtime.selection,
        runtime,
        code: null,
        message: null,
      }
    } catch (error) {
      return {
        ok: false,
        selection: typeof selectionOrProfile === 'object'
          ? null
          : normalizeBrowserSelection(selectionOrProfile),
        runtime: null,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async ensureManagedRuntime(
    family: ManagedBrowserFamily,
    platform: BrowserRuntimePlatform,
    options: EnsureBrowserRuntimeOptions,
  ) {
    let entry: ManagedBrowserCatalogEntry
    try {
      entry = managedBrowserCatalogEntry(family, platform)
    } catch {
      throw tokenlessError(
        'browser_runtime_catalog_entry_missing',
        `Tokenless has no managed browser catalog entry for ${family} on ${platform}.`,
      )
    }
    const cached = options.repair === true
      ? null
      : await this.resolveCachedManagedRuntime(entry).catch((error) => {
          if (errorCode(error) === 'browser_runtime_not_installed') return null
          throw error
        })
    if (cached) return cached
    if (options.allowDownload !== true) {
      throw tokenlessError(
        'browser_runtime_download_required',
        `${entry.displayName} ${entry.artifactVersion} is not installed. Run tokenless setup with browser downloads enabled.`,
      )
    }
    await fs.mkdir(this.browserRoot, { recursive: true, mode: 0o700 })
    await fs.chmod(this.browserRoot, 0o700).catch(() => undefined)
    if (options.repair !== true) {
      const afterWrite = await this.resolveCachedManagedRuntime(entry).catch((error) => {
        if (errorCode(error) === 'browser_runtime_not_installed') return null
        throw error
      })
      if (afterWrite) return afterWrite
      return await this.installManagedRuntime(entry, options)
    }
    return await this.reinstallManagedRuntime(entry, options)
  }

  private async reinstallManagedRuntime(
    entry: ManagedBrowserCatalogEntry,
    options: EnsureBrowserRuntimeOptions,
  ) {
    const finalDirectory = this.managedRuntimeDirectory(entry)
    const backupDirectory = path.join(
      path.dirname(finalDirectory),
      `.${path.basename(finalDirectory)}.repair-${randomUUID()}`,
    )
    let backupCreated = false
    try {
      await fs.rename(finalDirectory, backupDirectory)
      backupCreated = true
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    try {
      const runtime = await this.installManagedRuntime(entry, options)
      if (backupCreated) await fs.rm(backupDirectory, { recursive: true, force: true })
      return runtime
    } catch (error) {
      if (backupCreated) {
        await fs.rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined)
        await fs.rename(backupDirectory, finalDirectory).catch(() => undefined)
      }
      throw error
    }
  }

  private async installManagedRuntime(
    entry: ManagedBrowserCatalogEntry,
    options: EnsureBrowserRuntimeOptions,
  ): Promise<ResolvedBrowserRuntime> {
    const finalDirectory = this.managedRuntimeDirectory(entry)
    const temporaryRoot = path.join(this.browserRoot, `.install-${randomUUID()}`)
    const payloadDirectory = path.join(temporaryRoot, 'payload')
    const archivePath = path.join(temporaryRoot, `browser.${entry.archiveFormat}`)
    const emit = (phase: Parameters<NonNullable<EnsureBrowserRuntimeOptions['onProgress']>>[0]['phase']) => {
      options.onProgress?.({
        phase,
        family: entry.family,
        displayName: entry.displayName,
        version: entry.artifactVersion,
      })
    }

    await fs.mkdir(temporaryRoot, { recursive: false, mode: 0o700 })
    try {
      emit('download')
      await downloadArtifact(entry.downloadUrl, archivePath, options.signal)
      await verifyAndExtractManagedBrowserArtifact({
        entry,
        archivePath,
        payloadDirectory,
        temporaryRoot,
        ...(options.signal ? { signal: options.signal } : {}),
        onPhase: emit,
      })
      const installedAt = new Date().toISOString()
      const manifest: RuntimeManifest = {
        version: 1,
        runtimeId: managedRuntimeId(entry),
        family: entry.family,
        browserId: entry.browserId,
        platform: entry.platform,
        artifactVersion: entry.artifactVersion,
        browserVersion: entry.browserVersion,
        sha256: entry.sha256,
        downloadUrl: entry.downloadUrl,
        executableRelativePath: entry.executableRelativePath,
        installedAt,
        checksumVerified: true,
        smokeLaunchVerified: true,
      }
      await writeJsonAtomic(path.join(payloadDirectory, RUNTIME_MANIFEST_FILE), manifest)
      await fs.mkdir(path.dirname(finalDirectory), { recursive: true, mode: 0o700 })
      emit('install')
      await fs.rename(payloadDirectory, finalDirectory)
      await this.updateInstalledIndex(manifest)
      return await this.resolveCachedManagedRuntime(entry)
    } catch (error) {
      throw isBrowserRuntimeError(error)
        ? error
        : tokenlessError(
            'browser_runtime_install_failed',
            `Cannot install ${entry.displayName} ${entry.artifactVersion}.`,
            { cause: error, retryable: isRetryableInstallError(error) },
          )
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async resolveCachedManagedRuntime(
    entry: ManagedBrowserCatalogEntry,
  ): Promise<ResolvedBrowserRuntime> {
    const runtimeDirectory = this.managedRuntimeDirectory(entry)
    const manifestPath = path.join(runtimeDirectory, RUNTIME_MANIFEST_FILE)
    let manifest: RuntimeManifest
    try {
      const runtimeMetadata = await fs.lstat(runtimeDirectory)
      if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
        throw tokenlessError('browser_runtime_cache_invalid', 'Managed browser runtime cache is not a real directory.')
      }
      manifest = parseRuntimeManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), entry)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw tokenlessError('browser_runtime_not_installed', `${entry.displayName} is not installed.`)
      }
      if (isBrowserRuntimeError(error)) throw error
      throw tokenlessError('browser_runtime_cache_invalid', `${entry.displayName} cache metadata is invalid.`, { cause: error })
    }
    const executablePath = path.join(runtimeDirectory, manifest.executableRelativePath)
    await assertExecutableInside(runtimeDirectory, executablePath)
    const actualVersion = await browserExecutableVersion(executablePath)
    if (actualVersion !== entry.browserVersion) {
      throw tokenlessError(
        'browser_runtime_version_mismatch',
        `${entry.displayName} cache reported browser ${actualVersion}; expected ${entry.browserVersion}.`,
      )
    }
    return {
      selection: entry.family,
      runtimeId: manifest.runtimeId,
      family: entry.family,
      browserId: entry.browserId,
      displayName: entry.displayName,
      platform: entry.platform,
      executablePath,
      actualVersion,
      expectedVersion: entry.browserVersion,
      artifactVersion: entry.artifactVersion,
      source: 'tokenless-cache',
      managed: true,
      checksumVerified: true,
      launchPolicy: entry.family === 'cloak' ? 'cloak' : 'standard',
    }
  }

  private async requireSystemBrowser(
    browserId: SystemBrowserId,
    platform: BrowserRuntimePlatform,
    browserExecutablePath: string | null | undefined,
  ) {
    if (browserExecutablePath) {
      return await this.resolveSystemBrowserAtPath(
        browserId,
        platform,
        browserExecutablePath,
      )
    }
    const runtime = await this.resolveSystemBrowser(browserId, platform)
    if (runtime) return runtime
    throw tokenlessError(
      'browser_executable_not_found',
      `Browser executable for '${browserId}' was not found. Set it with tokenless config --browser ${browserId} --browser-executable-path "/absolute/path/to/browser" --json, or open tokenless dashboard and update System > Browser executable path.`,
    )
  }

  private async resolveSystemBrowser(
    browserId: SystemBrowserId,
    platform: BrowserRuntimePlatform,
  ): Promise<ResolvedBrowserRuntime | null> {
    const executablePath = await systemBrowserExecutable(browserId, platform)
    if (!executablePath) return null
    return await this.resolveSystemBrowserAtPath(browserId, platform, executablePath)
  }

  private async resolveSystemBrowserAtPath(
    browserId: SystemBrowserId,
    platform: BrowserRuntimePlatform,
    executablePath: string,
  ): Promise<ResolvedBrowserRuntime> {
    if (!path.isAbsolute(executablePath)) {
      throw tokenlessError(
        'browser_executable_path_invalid',
        'Browser executable path must be absolute.',
      )
    }
    const canonicalExecutablePath = await fs.realpath(executablePath).catch(() => executablePath)
    await assertExecutable(canonicalExecutablePath)
    assertSystemBrowserIdentity(browserId, canonicalExecutablePath)
    const actualVersion = await browserExecutableVersion(canonicalExecutablePath, browserId)
    return {
      selection: browserId,
      runtimeId: `system:${browserId}`,
      family: 'system',
      browserId,
      displayName: systemBrowserDisplayName(browserId),
      platform,
      executablePath: canonicalExecutablePath,
      actualVersion,
      expectedVersion: null,
      artifactVersion: null,
      source: 'system',
      managed: false,
      checksumVerified: null,
      launchPolicy: 'standard',
    }
  }

  private async resolveTestProfile(
    platform: BrowserRuntimePlatform,
    configuredExecutablePath?: string | null,
  ): Promise<ResolvedBrowserRuntime> {
    const executablePath = configuredExecutablePath?.trim() || process.env.TOKENLESS_BROWSER_EXECUTABLE?.trim()
    if (!executablePath) {
      throw tokenlessError(
        'browser_not_found',
        'The profile browser is test-only and requires TOKENLESS_BROWSER_EXECUTABLE.',
      )
    }
    const canonicalExecutablePath = await fs.realpath(executablePath).catch(() => executablePath)
    await assertExecutable(canonicalExecutablePath)
    return {
      selection: 'profile',
      runtimeId: 'test:profile',
      family: 'test',
      browserId: 'profile',
      displayName: 'test browser profile',
      platform,
      executablePath: canonicalExecutablePath,
      actualVersion: await browserExecutableVersion(canonicalExecutablePath),
      expectedVersion: null,
      artifactVersion: null,
      source: 'system',
      managed: false,
      checksumVerified: null,
      launchPolicy: 'test-profile',
    }
  }

  private managedRuntimeDirectory(entry: ManagedBrowserCatalogEntry) {
    return path.join(this.runtimesRoot, entry.family, entry.platform, entry.artifactVersion)
  }

  private async updateInstalledIndex(manifest: RuntimeManifest) {
    let current: { version: 1; runtimes: Record<string, RuntimeManifest> } = { version: 1, runtimes: {} }
    try {
      const parsed = JSON.parse(await fs.readFile(this.installedIndexFile, 'utf8')) as unknown
      if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.runtimes)) {
        current = { version: 1, runtimes: parsed.runtimes as Record<string, RuntimeManifest> }
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    await writeJsonAtomic(this.installedIndexFile, {
      version: 1,
      runtimes: {
        ...current.runtimes,
        [manifest.runtimeId]: manifest,
      },
    })
  }
}

function assertSystemBrowserIdentity(browserId: SystemBrowserId, executablePath: string) {
  if (browserId !== 'chrome' && browserId !== 'brave') return
  const normalized = executablePath.replaceAll('\\', '/').toLowerCase()
  const looksLikeChrome = /(?:google chrome|google-chrome|chrome\.exe(?:$|\/)|\/chrome(?:$|\/))/.test(normalized)
  const looksLikeBrave = /(?:brave browser|brave-browser|brave\.com|brave\.exe(?:$|\/)|\/brave(?:$|\/))/.test(normalized)
  const mismatch = browserId === 'chrome' ? looksLikeBrave : looksLikeChrome
  if (mismatch) {
    throw tokenlessError(
      'browser_executable_identity_mismatch',
      `The selected ${systemBrowserDisplayName(browserId)} executable does not match the requested browser.`,
    )
  }
}

export async function verifyAndExtractManagedBrowserArtifact(options: {
  entry: ManagedBrowserCatalogEntry
  archivePath: string
  payloadDirectory: string
  temporaryRoot: string
  signal?: AbortSignal
  onPhase?: (phase: BrowserRuntimeProgress['phase']) => void
}) {
  const { entry, archivePath, payloadDirectory, temporaryRoot } = options
  const executablePath = path.join(payloadDirectory, entry.executableRelativePath)

  options.onPhase?.('verify')
  const actualChecksum = await sha256File(archivePath)
  if (actualChecksum !== entry.sha256) {
    throw tokenlessError(
      'browser_runtime_checksum_mismatch',
      `${entry.displayName} download checksum mismatch; refusing to extract the artifact.`,
      { details: { expected: entry.sha256, actual: actualChecksum } },
    )
  }

  options.onPhase?.('extract')
  await fs.mkdir(payloadDirectory, { recursive: false, mode: 0o700 })
  await validateArchivePaths(archivePath, entry.archiveFormat)
  const extractWithUnzip = usesUnzip(entry.archiveFormat)
  await runCommand(
    extractWithUnzip ? 'unzip' : 'tar',
    extractWithUnzip
      ? ['-qq', '-o', archivePath, '-d', payloadDirectory]
      : ['-xf', archivePath, '-C', payloadDirectory],
    {
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      maxOutputBytes: MAX_ARCHIVE_LIST_BYTES,
    },
  )
  await normalizeCloakWindowsArchive(entry, payloadDirectory)
  if (process.platform !== 'win32') await fs.chmod(executablePath, 0o755)
  await assertExecutableInside(payloadDirectory, executablePath)
  if (process.platform === 'darwin') {
    await runCommand('/usr/bin/xattr', ['-cr', payloadDirectory], {
      timeoutMs: VERSION_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
    }).catch(() => undefined)
  }

  options.onPhase?.('version')
  const actualVersion = await browserExecutableVersion(executablePath)
  if (actualVersion !== entry.browserVersion) {
    throw tokenlessError(
      'browser_runtime_version_mismatch',
      `${entry.displayName} reported browser ${actualVersion}; expected ${entry.browserVersion}.`,
    )
  }

  options.onPhase?.('smoke-launch')
  await smokeLaunchBrowser(executablePath, entry.family, temporaryRoot, options.signal)
  return { executablePath, actualVersion }
}

function supportedPlatform() {
  try {
    return currentBrowserRuntimePlatform()
  } catch (error) {
    throw tokenlessError(
      'browser_runtime_platform_unsupported',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function managedRuntimeId(entry: ManagedBrowserCatalogEntry) {
  return `${entry.family}:${entry.platform}:${entry.artifactVersion}`
}

function selectionForBinding(binding: BrowserRuntimeBinding): BrowserSelection {
  if (binding.family === 'managed-chromium') return 'managed-chromium'
  if (binding.family === 'cloak') return 'cloak'
  if (binding.family === 'test') return 'profile'
  if (isSystemBrowserId(binding.browserId)) return binding.browserId
  throw tokenlessError('profile_runtime_binding_invalid', `Profile runtime binding '${binding.runtimeId}' is invalid.`)
}

function runtimeCandidate(runtime: ResolvedBrowserRuntime): BrowserCandidate {
  return {
    selection: runtime.selection,
    runtimeId: runtime.runtimeId,
    family: runtime.family,
    browserId: runtime.browserId,
    displayName: runtime.displayName,
    platform: runtime.platform,
    version: runtime.actualVersion,
    source: runtime.source,
    executablePath: runtime.executablePath,
    managed: runtime.managed,
    installed: true,
    downloadRequired: false,
  }
}

async function systemBrowserExecutable(
  browserId: SystemBrowserId,
  platform: BrowserRuntimePlatform,
) {
  if (platform === 'darwin-arm64' || platform === 'darwin-x64') {
    const applicationNames: Record<SystemBrowserId, string> = {
      chrome: 'Google Chrome.app',
      brave: 'Brave Browser.app',
      edge: 'Microsoft Edge.app',
      chromium: 'Chromium.app',
      'chrome-for-testing': 'Google Chrome for Testing.app',
    }
    const executableNames: Record<SystemBrowserId, string> = {
      chrome: 'Google Chrome',
      brave: 'Brave Browser',
      edge: 'Microsoft Edge',
      chromium: 'Chromium',
      'chrome-for-testing': 'Google Chrome for Testing',
    }
    for (const applicationsRoot of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const executablePath = path.join(
        applicationsRoot,
        applicationNames[browserId],
        'Contents',
        'MacOS',
        executableNames[browserId],
      )
      if (await isExecutable(executablePath)) return executablePath
    }
    return null
  }

  if (platform === 'linux-x64') {
    const absoluteExecutables: Record<SystemBrowserId, readonly string[]> = {
      chrome: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'],
      brave: ['/opt/brave.com/brave/brave', '/usr/bin/brave-browser', '/usr/bin/brave'],
      edge: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge'],
      chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
      'chrome-for-testing': ['/opt/chrome-for-testing/chrome'],
    }
    for (const executablePath of absoluteExecutables[browserId]) {
      if (await isExecutable(executablePath)) return executablePath
    }
    return null
  }

  const relativeExecutables: Record<SystemBrowserId, readonly string[]> = {
    chrome: ['Google/Chrome/Application/chrome.exe'],
    brave: ['BraveSoftware/Brave-Browser/Application/brave.exe'],
    edge: ['Microsoft/Edge/Application/msedge.exe'],
    chromium: ['Chromium/Application/chrome.exe'],
    'chrome-for-testing': ['Google/Chrome for Testing/Application/chrome.exe'],
  }
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
    .filter((value): value is string => Boolean(value))
  for (const root of roots) {
    for (const relativePath of relativeExecutables[browserId]) {
      const executablePath = path.join(root, relativePath)
      if (await isExecutable(executablePath)) return executablePath
    }
  }
  return null
}

function systemBrowserDisplayName(browserId: SystemBrowserId) {
  const names: Record<SystemBrowserId, string> = {
    chrome: 'Google Chrome',
    brave: 'Brave Browser',
    edge: 'Microsoft Edge',
    chromium: 'Chromium',
    'chrome-for-testing': 'Google Chrome for Testing',
  }
  return names[browserId]
}

async function browserExecutableVersion(executablePath: string, expectedBrowserId?: SystemBrowserId) {
  let output: string
  if (process.platform === 'win32') {
    const result = await runCommand('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:TOKENLESS_BROWSER_EXE).ProductVersion',
    ], {
      timeoutMs: VERSION_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      env: { ...process.env, TOKENLESS_BROWSER_EXE: executablePath },
    })
    output = result.stdout
  } else {
    output = (await runCommand(executablePath, ['--version'], {
      timeoutMs: VERSION_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
    })).stdout
  }
  if (expectedBrowserId && process.platform !== 'win32') {
    assertSystemBrowserProduct(expectedBrowserId, output)
  }
  const match = output.match(/\d+\.\d+\.\d+\.\d+(?:\.\d+)?/)
  if (!match) {
    throw tokenlessError(
      'browser_runtime_version_unreadable',
      `Cannot determine browser version for ${executablePath}.`,
    )
  }
  return match[0]
}

function assertSystemBrowserProduct(browserId: SystemBrowserId, output: string) {
  if (browserId !== 'chrome' && browserId !== 'brave') return
  const normalized = output.toLowerCase()
  const looksLikeChrome = /(?:google chrome|google-chrome|chromium|chrome)/.test(normalized)
  const looksLikeBrave = /brave/.test(normalized)
  const mismatch = browserId === 'chrome' ? looksLikeBrave : looksLikeChrome
  if (mismatch) {
    throw tokenlessError(
      'browser_executable_identity_mismatch',
      `The selected ${systemBrowserDisplayName(browserId)} executable does not match the requested browser.`,
    )
  }
}

async function downloadArtifact(url: string, destination: string, signal: AbortSignal | undefined) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body) {
      throw tokenlessError(
        'browser_runtime_download_failed',
        `Browser download failed with HTTP ${response.status}.`,
        { retryable: response.status >= 500 || response.status === 429 },
      )
    }
    let downloadedBytes = 0
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length
        if (downloadedBytes > MAX_DOWNLOAD_BYTES) {
          callback(tokenlessError('browser_runtime_download_too_large', 'Browser download exceeded the maximum accepted size.'))
          return
        }
        callback(null, chunk)
      },
    })
    const readable = Readable.fromWeb(response.body as never)
    await pipeline(readable, limit, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  } catch (error) {
    if (isBrowserRuntimeError(error)) throw error
    const aborted = controller.signal.aborted || signal?.aborted
    throw tokenlessError(
      aborted ? 'browser_runtime_download_aborted' : 'browser_runtime_download_failed',
      aborted ? 'Browser download was aborted.' : 'Browser download failed.',
      { cause: error, retryable: !aborted },
    )
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function sha256File(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * GNU tar cannot read zip archives, so Linux needs unzip for the zip catalog
 * entries. The bsdtar that ships with macOS and Windows reads both formats.
 */
function usesUnzip(archiveFormat: ManagedBrowserArchiveFormat) {
  return archiveFormat === 'zip' && process.platform === 'linux'
}

async function validateArchivePaths(
  archivePath: string,
  archiveFormat: ManagedBrowserArchiveFormat,
) {
  const listWithUnzip = usesUnzip(archiveFormat)
  const listing = await runCommand(
    listWithUnzip ? 'unzip' : 'tar',
    listWithUnzip ? ['-Z1', archivePath] : ['-tf', archivePath],
    {
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      maxOutputBytes: MAX_ARCHIVE_LIST_BYTES,
    },
  )
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (entries.length === 0) {
    throw tokenlessError('browser_runtime_archive_invalid', 'Browser archive is empty.')
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    const segments = normalized.split('/')
    if (
      normalized.startsWith('/') ||
      /^[a-zA-Z]:\//.test(normalized) ||
      segments.includes('..') ||
      normalized.includes('\u0000')
    ) {
      throw tokenlessError('browser_runtime_archive_unsafe', `Browser archive contains an unsafe path: ${entry}`)
    }
  }
}

async function normalizeCloakWindowsArchive(
  entry: ManagedBrowserCatalogEntry,
  payloadDirectory: string,
) {
  if (entry.family !== 'cloak' || entry.platform !== 'win32-x64') return
  if (await isExecutable(path.join(payloadDirectory, entry.executableRelativePath))) return
  const children = await fs.readdir(payloadDirectory, { withFileTypes: true })
  if (children.length !== 1 || !children[0]!.isDirectory() || children[0]!.isSymbolicLink()) return
  const wrapperDirectory = path.join(payloadDirectory, children[0]!.name)
  if (!await isExecutable(path.join(wrapperDirectory, entry.executableRelativePath))) return
  for (const child of await fs.readdir(wrapperDirectory)) {
    await fs.rename(path.join(wrapperDirectory, child), path.join(payloadDirectory, child))
  }
  await fs.rmdir(wrapperDirectory)
}

async function smokeLaunchBrowser(
  executablePath: string,
  family: ManagedBrowserFamily,
  temporaryRoot: string,
  signal: AbortSignal | undefined,
) {
  if (signal?.aborted) throw tokenlessError('browser_runtime_install_aborted', 'Browser installation was aborted.')
  const smokeProfile = path.join(temporaryRoot, 'smoke-profile')
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), SMOKE_LAUNCH_TIMEOUT_MS)
  const abort = () => timeoutController.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
  try {
    const launch = chromium.launchPersistentContext(smokeProfile, {
      executablePath,
      headless: true,
      chromiumSandbox: true,
      args: [
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ...(family === 'cloak'
        ? { ignoreDefaultArgs: ['--enable-automation', '--enable-unsafe-swiftshader'] }
        : {}),
      timeout: SMOKE_LAUNCH_TIMEOUT_MS,
    })
    context = await Promise.race([
      launch,
      new Promise<never>((_resolve, reject) => {
        timeoutController.signal.addEventListener('abort', () => {
          reject(tokenlessError('browser_runtime_smoke_launch_timeout', 'Browser smoke launch timed out.'))
        }, { once: true })
      }),
    ])
    const page = context.pages()[0] ?? await context.newPage()
    if (await page.evaluate(() => navigator.userAgent.length > 0) !== true) {
      throw tokenlessError('browser_runtime_smoke_launch_failed', 'Browser smoke launch did not produce a usable page.')
    }
  } catch (error) {
    if (isBrowserRuntimeError(error)) throw error
    throw tokenlessError('browser_runtime_smoke_launch_failed', 'Browser smoke launch failed.', { cause: error })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    await context?.close().catch(() => undefined)
    await fs.rm(smokeProfile, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function assertExecutableInside(root: string, executablePath: string) {
  const canonicalRoot = await fs.realpath(root)
  const canonicalExecutable = await fs.realpath(executablePath).catch((error) => {
    throw tokenlessError('browser_runtime_executable_missing', `Browser executable is missing: ${executablePath}.`, { cause: error })
  })
  if (!isPathInside(canonicalRoot, canonicalExecutable)) {
    throw tokenlessError('browser_runtime_executable_unsafe', 'Browser executable resolves outside its runtime cache.')
  }
  await assertExecutable(canonicalExecutable)
}

async function assertExecutable(executablePath: string) {
  try {
    const metadata = await fs.stat(executablePath)
    if (!metadata.isFile()) throw new Error('not a regular file')
    await fs.access(executablePath, process.platform === 'win32' ? 0 : 1)
  } catch (error) {
    throw tokenlessError('browser_runtime_executable_missing', `Browser executable is not runnable: ${executablePath}.`, { cause: error })
  }
}

async function isExecutable(executablePath: string) {
  try {
    await assertExecutable(executablePath)
    return true
  } catch {
    return false
  }
}

function parseRuntimeManifest(value: unknown, entry: ManagedBrowserCatalogEntry): RuntimeManifest {
  if (!isRecord(value)) throw tokenlessError('browser_runtime_cache_invalid', 'Managed browser runtime manifest is malformed.')
  const expected: RuntimeManifest = {
    version: 1,
    runtimeId: managedRuntimeId(entry),
    family: entry.family,
    browserId: entry.browserId,
    platform: entry.platform,
    artifactVersion: entry.artifactVersion,
    browserVersion: entry.browserVersion,
    sha256: entry.sha256,
    downloadUrl: entry.downloadUrl,
    executableRelativePath: entry.executableRelativePath,
    installedAt: typeof value.installedAt === 'string' ? value.installedAt : '',
    checksumVerified: true,
    smokeLaunchVerified: true,
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      throw tokenlessError('browser_runtime_cache_invalid', `Managed browser runtime manifest field '${key}' is invalid.`)
    }
  }
  if (!expected.installedAt || Number.isNaN(Date.parse(expected.installedAt))) {
    throw tokenlessError('browser_runtime_cache_invalid', 'Managed browser runtime install timestamp is invalid.')
  }
  return expected
}

async function writeJsonAtomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs: number
    maxOutputBytes: number
    env?: NodeJS.ProcessEnv
  },
) {
  return await new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    }
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > options.maxOutputBytes) {
        child.kill('SIGKILL')
        finish(tokenlessError('browser_runtime_command_output_limit', `Command output exceeded its limit: ${command}.`))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => {
      if (code === 0) finish()
      else finish(new Error(`${command} exited with ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8').trim()}`))
    })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`${command} timed out after ${options.timeoutMs}ms.`))
    }, options.timeoutMs)
  })
}

function compareBrowserVersions(left: string, right: string) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isErrno(error: unknown, code: string) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'browser_runtime_unexpected_error'
}

function isBrowserRuntimeError(error: unknown) {
  return error instanceof Error && error.name === 'TokenlessPlaywrightError'
}

function isRetryableInstallError(error: unknown) {
  return errorCode(error) === 'browser_runtime_download_failed'
}
