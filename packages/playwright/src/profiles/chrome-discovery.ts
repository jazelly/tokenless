import { access, readFile, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { tokenlessError } from '../errors.js'
import { isPathInside } from './registry.js'

export type ChromeProfileCandidate = {
  userDataDir: string
  directoryKey: string
  profileDir: string
  name: string
  isDefault: boolean
}

export type ChromeUserDataRoot = {
  userDataDir: string
  profiles: readonly ChromeProfileCandidate[]
}

export function standardChromeUserDataDirs(osPlatform = platform(), home = homedir(), env = process.env): string[] {
  if (osPlatform === 'darwin') return [join(home, 'Library', 'Application Support', 'Google', 'Chrome')]
  if (osPlatform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    return localAppData ? [join(localAppData, 'Google', 'Chrome', 'User Data')] : []
  }
  return [
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'google-chrome-stable'),
  ]
}

export async function discoverChromeProfiles(options: { userDataDirs?: readonly string[] } = {}): Promise<ChromeUserDataRoot[]> {
  const roots = options.userDataDirs ?? standardChromeUserDataDirs()
  const discovered: ChromeUserDataRoot[] = []
  for (const root of roots) {
    const userDataDir = resolve(root)
    const localStatePath = join(userDataDir, 'Local State')
    try {
      await access(localStatePath)
      const parsed = JSON.parse(await readFile(localStatePath, 'utf8')) as unknown
      const profileCache = readProfileCache(parsed)
      const profiles: ChromeProfileCandidate[] = []
      for (const [directoryKey, metadata] of Object.entries(profileCache)) {
        const candidate = await chromeProfileCandidate(userDataDir, directoryKey, metadata)
        if (candidate) profiles.push(candidate)
      }
      discovered.push({
        userDataDir,
        profiles: profiles.sort((left, right) => left.directoryKey.localeCompare(right.directoryKey)),
      })
    } catch (error) {
      if (isIgnorableDiscoveryError(error)) continue
      throw error
    }
  }
  return discovered
}

export async function resolveChromeProfile(userDataDir: string, directoryKey: string): Promise<ChromeProfileCandidate> {
  const root = resolve(userDataDir)
  const key = validateChromeProfileDirectoryKey(directoryKey)
  const profileDir = resolve(root, key)
  if (!isPathInside(root, profileDir)) {
    throw tokenlessError('chrome_profile_path_escape', 'Chrome profile directory escapes its user data root.')
  }
  const profileStat = await stat(profileDir)
  if (!profileStat.isDirectory()) {
    throw tokenlessError('chrome_profile_not_found', 'Chrome profile directory is not a directory.')
  }
  const state = await readChromeLocalState(root)
  const metadata = readProfileCache(state)[key] ?? {}
  return {
    userDataDir: root,
    directoryKey: key,
    profileDir,
    name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : key,
    isDefault: metadata.is_using_default_name === true || key === 'Default',
  }
}

export function validateChromeProfileDirectoryKey(directoryKey: string): string {
  if (
    typeof directoryKey !== 'string' ||
    directoryKey.length < 1 ||
    directoryKey.length > 128 ||
    directoryKey !== basename(directoryKey) ||
    directoryKey.includes('/') ||
    directoryKey.includes('\\') ||
    directoryKey.includes('\u0000') ||
    directoryKey === '.' ||
    directoryKey === '..'
  ) {
    throw tokenlessError('invalid_chrome_profile_key', 'Chrome profile directory key must be an exact directory name.')
  }
  return directoryKey
}

export async function readChromeLocalState(userDataDir: string): Promise<Record<string, unknown>> {
  const root = resolve(userDataDir)
  const localStatePath = resolve(root, 'Local State')
  if (!isPathInside(root, localStatePath)) {
    throw tokenlessError('chrome_profile_path_escape', 'Chrome Local State path escapes its user data root.')
  }
  const localStateStat = await stat(localStatePath)
  if (!localStateStat.isFile()) {
    throw tokenlessError('chrome_local_state_missing', 'Chrome Local State is not a regular file.')
  }
  const parsed = JSON.parse(await readFile(localStatePath, 'utf8')) as unknown
  if (!isRecord(parsed)) throw tokenlessError('chrome_local_state_invalid', 'Chrome Local State is malformed.')
  return parsed
}

function readProfileCache(localState: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(localState)) return {}
  const profile = localState.profile
  if (!isRecord(profile)) return {}
  const infoCache = profile.info_cache
  if (!isRecord(infoCache)) return {}
  const cache: Record<string, Record<string, unknown>> = {}
  for (const [key, metadata] of Object.entries(infoCache)) {
    if (isRecord(metadata)) cache[key] = metadata
  }
  return cache
}

async function chromeProfileCandidate(userDataDir: string, directoryKey: string, metadata: Record<string, unknown>): Promise<ChromeProfileCandidate | null> {
  let key: string
  try {
    key = validateChromeProfileDirectoryKey(directoryKey)
  } catch {
    return null
  }
  const profileDir = resolve(userDataDir, key)
  if (!isPathInside(userDataDir, profileDir)) return null
  try {
    const profileStat = await stat(profileDir)
    if (!profileStat.isDirectory()) return null
  } catch {
    return null
  }
  return {
    userDataDir,
    directoryKey: key,
    profileDir,
    name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : key,
    isDefault: metadata.is_using_default_name === true || key === 'Default',
  }
}

function isIgnorableDiscoveryError(error: unknown) {
  return error instanceof SyntaxError || (isRecord(error) && (error.code === 'ENOENT' || error.code === 'EACCES'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isSameOrChildPath(root: string, candidate: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}
