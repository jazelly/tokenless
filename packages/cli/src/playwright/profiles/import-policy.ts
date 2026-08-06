export const SUPPORTED_PROFILE_IMPORT_BROWSER = 'chrome' as const

export type CloakProfileCompatibility =
  | 'aligned'
  | 'not_aligned'
  | 'unknown'
  | 'unsupported_browser'

export function isSupportedProfileImportBrowser(
  browser: string,
): browser is typeof SUPPORTED_PROFILE_IMPORT_BROWSER {
  return browser === SUPPORTED_PROFILE_IMPORT_BROWSER
}

export function classifyCloakProfileCompatibility({
  browser,
  sourceVersion,
  cloakVersion,
}: {
  browser: string
  sourceVersion: string | null
  cloakVersion: string
}): CloakProfileCompatibility {
  if (!isSupportedProfileImportBrowser(browser)) return 'unsupported_browser'
  if (sourceVersion === null) return 'unknown'
  return sourceVersion === cloakVersion ? 'aligned' : 'not_aligned'
}
