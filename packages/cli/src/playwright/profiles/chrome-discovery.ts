import { readdir, readFile, stat } from 'node:fs/promises'
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
  browserVersion: string | null
}

export type ChromeUserDataRoot = {
  userDataDir: string
  browserVersion: string | null
  profiles: readonly ChromeProfileCandidate[]
}

export const MANAGED_CHROMIUM_BROWSER_IDS = Object.freeze([
  'chrome',
  'brave',
  'edge',
  'arc',
  'chromium',
  'chrome-for-testing',
] as const)

export type ManagedChromiumBrowserId = typeof MANAGED_CHROMIUM_BROWSER_IDS[number]

export type ChromiumUserDataRoot = ChromeUserDataRoot & {
  browser: ManagedChromiumBrowserId
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

export function standardChromiumUserDataDirs(
  browser: ManagedChromiumBrowserId,
  osPlatform = platform(),
  home = homedir(),
  env = process.env
): string[] {
  if (browser === 'chrome') return standardChromeUserDataDirs(osPlatform, home, env)
  if (osPlatform === 'darwin') {
    const relativePaths: Record<Exclude<ManagedChromiumBrowserId, 'chrome'>, string> = {
      brave: join('BraveSoftware', 'Brave-Browser'),
      edge: 'Microsoft Edge',
      arc: join('Arc', 'User Data'),
      chromium: 'Chromium',
      'chrome-for-testing': join('Google', 'Chrome for Testing'),
    }
    return [join(home, 'Library', 'Application Support', relativePaths[browser])]
  }
  if (osPlatform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (!localAppData) return []
    const relativePaths: Record<Exclude<ManagedChromiumBrowserId, 'chrome' | 'arc'>, string> = {
      brave: join('BraveSoftware', 'Brave-Browser', 'User Data'),
      edge: join('Microsoft', 'Edge', 'User Data'),
      chromium: join('Chromium', 'User Data'),
      'chrome-for-testing': join('Google', 'Chrome for Testing', 'User Data'),
    }
    if (browser === 'arc') {
      return [
        join(localAppData, 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4', 'LocalCache', 'Local', 'Arc', 'User Data'),
        join(localAppData, 'TheBrowserCompany', 'Arc', 'User Data'),
      ]
    }
    return [join(localAppData, relativePaths[browser])]
  }
  if (browser === 'arc') return []
  const relativePaths: Record<Exclude<ManagedChromiumBrowserId, 'chrome' | 'arc'>, readonly string[]> = {
    brave: [join('BraveSoftware', 'Brave-Browser'), 'brave'],
    edge: ['microsoft-edge', 'microsoft-edge-stable'],
    chromium: ['chromium'],
    'chrome-for-testing': ['chrome-for-testing'],
  }
  return relativePaths[browser].map((relativePath) => join(home, '.config', relativePath))
}

export async function discoverKnownChromiumProfiles(options: {
  browsers?: readonly ManagedChromiumBrowserId[]
} = {}): Promise<ChromiumUserDataRoot[]> {
  const browsers = options.browsers ?? MANAGED_CHROMIUM_BROWSER_IDS
  const roots = await Promise.all(browsers.map((browser) => discoverChromiumProfiles({ browser })))
  return roots.flat()
}

export async function discoverChromeProfiles(options: { userDataDirs?: readonly string[] } = {}): Promise<ChromeUserDataRoot[]> {
  const roots = await discoverChromiumProfiles({
    browser: 'chrome',
    ...(options.userDataDirs ? { userDataDirs: options.userDataDirs } : {}),
  })
  return roots.map(({ userDataDir, browserVersion, profiles }) => ({ userDataDir, browserVersion, profiles }))
}

export async function discoverChromiumProfiles(options: {
  browser: ManagedChromiumBrowserId
  userDataDirs?: readonly string[]
}): Promise<ChromiumUserDataRoot[]> {
  const roots = options.userDataDirs ?? standardChromiumUserDataDirs(options.browser)
  const discovered: ChromeUserDataRoot[] = []
  for (const root of roots) {
    const userDataDir = resolve(root)
    try {
      const rootStat = await stat(userDataDir)
      if (!rootStat.isDirectory()) continue
      const browserVersion = await readChromeProfileVersion(userDataDir)
      const entries = await readdir(userDataDir, { withFileTypes: true })
      const profiles = entries
        .filter((entry) => entry.isDirectory() && isChromiumProfileDirectoryKey(entry.name))
        .map((entry): ChromeProfileCandidate => ({
          userDataDir,
          directoryKey: entry.name,
          profileDir: resolve(userDataDir, entry.name),
          name: entry.name,
          isDefault: entry.name === 'Default',
          browserVersion,
        }))
      discovered.push({
        userDataDir,
        browserVersion,
        profiles: profiles.sort((left, right) => left.directoryKey.localeCompare(right.directoryKey)),
      })
    } catch (error) {
      if (isIgnorableDiscoveryError(error)) continue
      throw error
    }
  }
  return discovered.map((root) => ({ ...root, browser: options.browser }))
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
  const browserVersion = await readChromeProfileVersion(root)
  return {
    userDataDir: root,
    directoryKey: key,
    profileDir,
    name: key,
    isDefault: key === 'Default',
    browserVersion,
  }
}

export async function readChromeProfileVersion(userDataDir: string): Promise<string | null> {
  try {
    const value = (await readFile(resolve(userDataDir, 'Last Version'), 'utf8')).trim()
    return /^\d+\.\d+\.\d+\.\d+$/.test(value) ? value : null
  } catch (error) {
    if (isIgnorableDiscoveryError(error)) return null
    throw error
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

function isChromiumProfileDirectoryKey(directoryKey: string) {
  return directoryKey === 'Default' || /^Profile \d+$/.test(directoryKey)
}

function isIgnorableDiscoveryError(error: unknown) {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'EACCES')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isSameOrChildPath(root: string, candidate: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}
