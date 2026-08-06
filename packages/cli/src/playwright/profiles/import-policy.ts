import type {
  BrowserRuntimeFamily,
  BrowserRuntimePlatform,
} from '../../browser-runtime/types.js'

export const DEFAULT_PROFILE_IMPORT_BROWSER = 'chrome' as const

export const SUPPORTED_PROFILE_IMPORT_BROWSERS = Object.freeze([
  DEFAULT_PROFILE_IMPORT_BROWSER,
  'brave',
] as const)

export type SupportedProfileImportBrowser = typeof SUPPORTED_PROFILE_IMPORT_BROWSERS[number]

export type ProfileImportCompatibility =
  | 'aligned'
  | 'not_aligned'
  | 'unknown'
  | 'unsupported_browser'
  | 'unsupported_platform'
  | 'unsupported_target'

export function isSupportedProfileImportBrowser(
  browser: string,
): browser is SupportedProfileImportBrowser {
  return SUPPORTED_PROFILE_IMPORT_BROWSERS.includes(browser as SupportedProfileImportBrowser)
}

export function classifyProfileImportCompatibility({
  browser,
  sourceVersion,
  targetVersion,
  targetPlatform,
  targetFamily,
}: {
  browser: string
  sourceVersion: string | null
  targetVersion: string
  targetPlatform: BrowserRuntimePlatform
  targetFamily: BrowserRuntimeFamily
}): ProfileImportCompatibility {
  if (!isSupportedProfileImportBrowser(browser)) return 'unsupported_browser'
  if (targetFamily !== 'managed-chromium' && targetFamily !== 'cloak') return 'unsupported_target'
  if (targetPlatform !== 'darwin-arm64') return 'unsupported_platform'
  if (sourceVersion === null) return 'unknown'

  const sourceMajor = chromiumMajor(sourceVersion)
  const targetMajor = chromiumMajor(targetVersion)
  if (sourceMajor === null || targetMajor === null) return 'unknown'
  if (targetMajor !== 145) return 'not_aligned'
  if (browser === 'chrome') return sourceMajor === 145 ? 'aligned' : 'not_aligned'
  return sourceMajor === 143 || sourceMajor === 145 ? 'aligned' : 'not_aligned'
}

function chromiumMajor(version: string) {
  const match = /^(0|[1-9]\d*)\./.exec(version)
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}
