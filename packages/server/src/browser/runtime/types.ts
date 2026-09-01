export const SYSTEM_BROWSER_IDS = Object.freeze([
  'chrome',
  'brave',
  'edge',
  'chromium',
  'chrome-for-testing',
] as const)

export const BROWSER_SELECTIONS = Object.freeze([
  'auto',
  ...SYSTEM_BROWSER_IDS,
  'managed-chromium',
  'cloak',
  'profile',
] as const)

export type SystemBrowserId = (typeof SYSTEM_BROWSER_IDS)[number]
export type BrowserSelection = (typeof BROWSER_SELECTIONS)[number]
export type ManagedBrowserFamily = 'managed-chromium' | 'cloak'
export type BrowserRuntimeFamily = 'system' | ManagedBrowserFamily | 'test'
export type BrowserLaunchPolicy = 'standard' | 'cloak' | 'test-profile'
export type BrowserRuntimePlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-x64'

export type BrowserRuntimeBinding = {
  runtimeId: string
  family: BrowserRuntimeFamily
  browserId: string
  executablePath: string
  createdWithVersion: string
  profileFormat: 1
}

export type BrowserCandidate = {
  selection: BrowserSelection
  runtimeId: string
  family: BrowserRuntimeFamily
  browserId: string
  displayName: string
  platform: BrowserRuntimePlatform
  version: string
  source: 'system' | 'tokenless-cache'
  executablePath: string
  managed: boolean
  installed: boolean
  downloadRequired: boolean
}

export type ResolvedBrowserRuntime = {
  selection: BrowserSelection
  runtimeId: string
  family: BrowserRuntimeFamily
  browserId: string
  displayName: string
  platform: BrowserRuntimePlatform
  executablePath: string
  actualVersion: string
  expectedVersion: string | null
  artifactVersion: string | null
  source: 'system' | 'tokenless-cache'
  managed: boolean
  checksumVerified: boolean | null
  launchPolicy: BrowserLaunchPolicy
}

export type BrowserRuntimeInspection = {
  ok: boolean
  selection: BrowserSelection | null
  runtime: ResolvedBrowserRuntime | null
  code: string | null
  message: string | null
}

export type BrowserRuntimeProgress = {
  phase: 'download' | 'verify' | 'extract' | 'version' | 'smoke-launch' | 'install'
  family: ManagedBrowserFamily
  displayName: string
  version: string
}

export type EnsureBrowserRuntimeOptions = {
  allowDownload?: boolean
  repair?: boolean
  browserExecutablePath?: string | null
  signal?: AbortSignal
  onProgress?: (progress: BrowserRuntimeProgress) => void
}

export function normalizeBrowserSelection(value: unknown): BrowserSelection | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-')
  if (!normalized) return null
  const aliases: Record<string, BrowserSelection> = {
    'google-chrome': 'chrome',
    googlechrome: 'chrome',
    'brave-browser': 'brave',
    bravebrowser: 'brave',
    'chrome-testing': 'chrome-for-testing',
    'chrome-for-testing-legacy': 'chrome-for-testing',
    'chromium-browser': 'chromium',
    'microsoft-edge': 'edge',
    msedge: 'edge',
    managed: 'managed-chromium',
    'tokenless-chromium': 'managed-chromium',
    cloakbrowser: 'cloak',
  }
  const selection = aliases[normalized] ?? normalized
  return BROWSER_SELECTIONS.includes(selection as BrowserSelection)
    ? selection as BrowserSelection
    : null
}

export function isSystemBrowserId(value: unknown): value is SystemBrowserId {
  return typeof value === 'string' && SYSTEM_BROWSER_IDS.includes(value as SystemBrowserId)
}
