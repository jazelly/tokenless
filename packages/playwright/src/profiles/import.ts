import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { tokenlessError } from '../errors.js'
import { resolveChromeProfile } from './chrome-discovery.js'
import { isPathInside } from './registry.js'

export type ChromeProfileImportOptions = {
  sourceUserDataDir: string
  profileDirectoryKey: string
  destinationDir: string
  tokenlessHome: string
  copyFile?: (source: string, destination: string) => Promise<void>
}

export type ChromeProfileImportResult = {
  destinationDir: string
  copiedFiles: number
  skippedEntries: readonly string[]
  syncDisabled: true
}

const PROFILE_EXCLUDE_EXACT = new Set([
  'Archived History',
  'AutofillStrikeDatabase',
  'Bookmarks',
  'Bookmarks.bak',
  'BrowserMetrics',
  'Cache',
  'Code Cache',
  'Current Session',
  'Current Tabs',
  'Crashpad',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Download Service',
  'Extension Rules',
  'Extension Scripts',
  'Extension State',
  'Extensions',
  'Favicons',
  'GPUCache',
  'GrShaderCache',
  'History',
  'History Provider Cache',
  'History-journal',
  'Login Data',
  'Login Data For Account',
  'Login Data For Account-journal',
  'Login Data-journal',
  'Media History',
  'Network Action Predictor',
  'Network Action Predictor-journal',
  'OptimizationHints',
  'Payments',
  'Preferences.backup',
  'Safe Browsing Cookies',
  'Safe Browsing Cookies-journal',
  'Last Session',
  'Last Tabs',
  'Service Worker/CacheStorage',
  'Sessions',
  'ShaderCache',
  'Shortcuts',
  'Sync Data',
  'Top Sites',
  'TransportSecurity',
  'Visited Links',
  'Web Data',
  'Web Data-journal',
])

const ROOT_INCLUDE_EXACT = new Set([
  'Local State',
  'First Run',
])
const MANAGED_PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function importChromeProfile(options: ChromeProfileImportOptions): Promise<ChromeProfileImportResult> {
  const tokenlessHome = resolve(options.tokenlessHome)
  const destinationDir = resolve(options.destinationDir)
  const profilesRoot = resolve(tokenlessHome, 'browser', 'profiles')
  if (dirname(destinationDir) !== profilesRoot || !MANAGED_PROFILE_ID_PATTERN.test(basename(destinationDir))) {
    throw tokenlessError(
      'unsafe_managed_profile_destination',
      'Managed Chrome profile destination must be a UUID directory directly inside Tokenless profiles root.'
    )
  }
  const source = await resolveChromeProfile(options.sourceUserDataDir, options.profileDirectoryKey)
  const sourceRoot = resolve(source.userDataDir)
  const sourceProfile = resolve(source.profileDir)
  if (isPathInside(tokenlessHome, sourceRoot)) {
    throw tokenlessError('chrome_profile_inside_tokenless_home', 'Refusing to import a Chrome profile from Tokenless home.')
  }
  const destinationParent = dirname(destinationDir)
  await mkdir(destinationParent, { recursive: true, mode: 0o700 })
  const staging = join(destinationParent, `.staging-${randomUUID()}`)
  const skippedEntries: string[] = []
  const copyFileImpl = options.copyFile ?? ((sourcePath, destinationPath) => copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL))
  let copiedFiles = 0
  try {
    await mkdir(staging, { mode: 0o700 })
    const sourceRootReal = await realpath(sourceRoot)
    const sourceProfileReal = await realpath(sourceProfile)
    await copySelectedRootFiles(sourceRoot, sourceRootReal, staging, skippedEntries, copyFileImpl, () => {
      copiedFiles += 1
    })
    const stagingProfile = join(staging, source.directoryKey)
    await mkdir(stagingProfile, { recursive: true, mode: 0o700 })
    await copyProfileTree(sourceProfile, sourceProfileReal, stagingProfile, skippedEntries, copyFileImpl, () => {
      copiedFiles += 1
    })
    await disableSyncInClone(staging, source.directoryKey)
    await rm(destinationDir, { recursive: true, force: true })
    await rename(staging, destinationDir)
    await chmod(destinationDir, 0o700)
    return {
      destinationDir,
      copiedFiles,
      skippedEntries,
      syncDisabled: true,
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

export function shouldCopyChromeEntry(relativeEntry: string, scope: 'root' | 'profile') {
  const normalized = normalizeRelativeEntry(relativeEntry)
  if (scope === 'root') return ROOT_INCLUDE_EXACT.has(normalized)
  if (PROFILE_EXCLUDE_EXACT.has(normalized)) return false
  const firstSegment = normalized.split('/')[0] ?? normalized
  if (PROFILE_EXCLUDE_EXACT.has(firstSegment)) return false
  if (/cache|crash|download|history|bookmark|password|autofill|payment|extension|sync/i.test(normalized)) return false
  return true
}

async function copySelectedRootFiles(
  sourceRoot: string,
  sourceRootReal: string,
  staging: string,
  skippedEntries: string[],
  copyFileImpl: (source: string, destination: string) => Promise<void>,
  onFileCopied: () => void
) {
  for (const entry of ROOT_INCLUDE_EXACT) {
    const source = resolve(sourceRoot, entry)
    const destination = resolve(staging, entry)
    await copySafeEntry(source, sourceRootReal, destination, 'root', skippedEntries, copyFileImpl, onFileCopied)
  }
}

async function copyProfileTree(
  sourceProfile: string,
  sourceProfileReal: string,
  stagingProfile: string,
  skippedEntries: string[],
  copyFileImpl: (source: string, destination: string) => Promise<void>,
  onFileCopied: () => void
) {
  await copySafeEntry(sourceProfile, sourceProfileReal, stagingProfile, 'profile', skippedEntries, copyFileImpl, onFileCopied)
}

async function copySafeEntry(
  source: string,
  sourceRootReal: string,
  destination: string,
  scope: 'root' | 'profile',
  skippedEntries: string[],
  copyFileImpl: (source: string, destination: string) => Promise<void>,
  onFileCopied: () => void
) {
  let sourceStat
  try {
    sourceStat = await lstat(source)
  } catch (error) {
    if (isMissingFile(error) && scope === 'root') return
    throw error
  }
  if (sourceStat.isSymbolicLink()) {
    throw tokenlessError('chrome_profile_symlink_rejected', 'Chrome profile import refuses symbolic links.')
  }
  const sourceReal = await realpath(source)
  if (!isPathInside(sourceRootReal, sourceReal)) {
    throw tokenlessError('chrome_profile_path_escape', 'Chrome profile import refuses path escapes.')
  }
  const relativeEntry = relative(sourceRootReal, sourceReal).split(sep).join('/')
  const scopedRelative = scope === 'profile' ? relativeEntry : basename(source)
  if (!shouldCopyChromeEntry(scopedRelative, scope)) {
    skippedEntries.push(scopedRelative)
    return
  }
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(source))
    for (const entry of entries) {
      await copySafeEntry(join(source, entry), sourceRootReal, join(destination, entry), scope, skippedEntries, copyFileImpl, onFileCopied)
    }
    return
  }
  if (!sourceStat.isFile()) {
    skippedEntries.push(scopedRelative)
    return
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFileImpl(source, destination)
  const copied = await lstat(destination)
  if (!copied.isFile() || copied.isSymbolicLink()) {
    throw tokenlessError('chrome_profile_copy_failed', 'Chrome profile copy did not produce a regular file.')
  }
  await chmod(destination, 0o600)
  onFileCopied()
}

async function disableSyncInClone(stagingRoot: string, profileDirectoryKey: string) {
  const localStatePath = join(stagingRoot, 'Local State')
  const localState = await readJsonIfPresent(localStatePath)
  if (localState) {
    const sync = isRecord(localState.sync) ? localState.sync : {}
    localState.sync = {
      ...sync,
      disabled: true,
    }
    await writeJson(localStatePath, localState)
  }
  const preferencesPath = join(stagingRoot, profileDirectoryKey, 'Preferences')
  const preferences = await readJsonIfPresent(preferencesPath)
  if (preferences) {
    preferences.sync = {
      ...(isRecord(preferences.sync) ? preferences.sync : {}),
      requested: false,
    }
    await writeJson(preferencesPath, preferences)
  }
}

async function readJsonIfPresent(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isRecord(value) ? value : null
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return null
    throw error
  }
}

async function writeJson(path: string, value: Record<string, unknown>) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

function normalizeRelativeEntry(value: string) {
  return value.split('\\').join('/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function isMissingFile(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export async function assertSourceUnchanged(before: readonly { path: string; size: number; mtimeMs: number; sha256?: string; dev?: number; ino?: number }[]) {
  for (const entry of before) {
    const after = await lstat(entry.path)
    if (!after.isFile() || after.isSymbolicLink()) {
      throw tokenlessError('chrome_source_profile_changed', 'Chrome source profile changed during import.')
    }
    if ((entry.dev !== undefined && after.dev !== entry.dev) || (entry.ino !== undefined && after.ino !== entry.ino)) {
      throw tokenlessError('chrome_source_profile_changed', 'Chrome source profile changed during import.')
    }
    if (after.size !== entry.size || after.mtimeMs !== entry.mtimeMs) {
      throw tokenlessError('chrome_source_profile_changed', 'Chrome source profile changed during import.')
    }
    if (entry.sha256 !== undefined) {
      const digest = createHash('sha256').update(await readFile(entry.path)).digest('hex')
      if (digest !== entry.sha256) {
        throw tokenlessError('chrome_source_profile_changed', 'Chrome source profile changed during import.')
      }
    }
  }
}
