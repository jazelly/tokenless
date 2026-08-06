import type {
  BrowserRuntimePlatform,
  ManagedBrowserFamily,
} from './types.js'

export type ManagedBrowserArchiveFormat = 'tar.gz' | 'zip'

export type ManagedBrowserCatalogEntry = {
  family: ManagedBrowserFamily
  browserId: ManagedBrowserFamily
  displayName: string
  platform: BrowserRuntimePlatform
  artifactVersion: string
  browserVersion: string
  downloadUrl: string
  sha256: string
  archiveFormat: ManagedBrowserArchiveFormat
  executableRelativePath: string
}

const MANAGED_BROWSER_CATALOG = Object.freeze({
  'managed-chromium:darwin-arm64': {
    family: 'managed-chromium',
    browserId: 'managed-chromium',
    displayName: 'Tokenless-managed Chrome for Testing',
    platform: 'darwin-arm64',
    artifactVersion: '145.0.7632.6',
    browserVersion: '145.0.7632.6',
    downloadUrl: 'https://storage.googleapis.com/chrome-for-testing-public/145.0.7632.6/mac-arm64/chrome-mac-arm64.zip',
    sha256: '3dbf04e28a02079148e9c7417840a0c1d3903361eceeee7e7eb59ef77021bdb2',
    archiveFormat: 'zip',
    executableRelativePath: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  },
  'managed-chromium:win32-x64': {
    family: 'managed-chromium',
    browserId: 'managed-chromium',
    displayName: 'Tokenless-managed Chrome for Testing',
    platform: 'win32-x64',
    artifactVersion: '146.0.7680.165',
    browserVersion: '146.0.7680.165',
    downloadUrl: 'https://storage.googleapis.com/chrome-for-testing-public/146.0.7680.165/win64/chrome-win64.zip',
    sha256: '65d1d4d993da8b24fc871f59f7c8100ffc3719afd58cbf843d81d6ada9bc9880',
    archiveFormat: 'zip',
    executableRelativePath: 'chrome-win64/chrome.exe',
  },
  'cloak:darwin-arm64': {
    family: 'cloak',
    browserId: 'cloak',
    displayName: 'CloakBrowser',
    platform: 'darwin-arm64',
    artifactVersion: '145.0.7632.109.2',
    browserVersion: '145.0.7632.109',
    downloadUrl: 'https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v145.0.7632.109.2/cloakbrowser-darwin-arm64.tar.gz',
    sha256: '505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c',
    archiveFormat: 'tar.gz',
    executableRelativePath: 'Chromium.app/Contents/MacOS/Chromium',
  },
  'cloak:win32-x64': {
    family: 'cloak',
    browserId: 'cloak',
    displayName: 'CloakBrowser',
    platform: 'win32-x64',
    artifactVersion: '146.0.7680.177.5',
    browserVersion: '146.0.7680.177',
    downloadUrl: 'https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip',
    sha256: 'b213795cb32c3169f766c74ce1d0275fc89d3df256de39c04da7fb4c23b7fdbe',
    archiveFormat: 'zip',
    executableRelativePath: 'chrome.exe',
  },
} satisfies Record<string, ManagedBrowserCatalogEntry>)

export function managedBrowserCatalogEntry(
  family: ManagedBrowserFamily,
  platform = currentBrowserRuntimePlatform(),
): ManagedBrowserCatalogEntry {
  const entry = MANAGED_BROWSER_CATALOG[`${family}:${platform}` as keyof typeof MANAGED_BROWSER_CATALOG]
  if (!entry) throw new Error(`No managed browser catalog entry exists for ${family} on ${platform}.`)
  return entry
}

export function currentBrowserRuntimePlatform(): BrowserRuntimePlatform {
  const key = `${process.platform}-${process.arch}`
  if (key === 'darwin-arm64' || key === 'win32-x64') return key
  throw new Error(`Unsupported Tokenless browser platform: ${key}. Supported platforms are darwin-arm64 and win32-x64.`)
}

export function allManagedBrowserCatalogEntries(): readonly ManagedBrowserCatalogEntry[] {
  return Object.values(MANAGED_BROWSER_CATALOG)
}
