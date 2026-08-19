import { CLI_ERROR_MESSAGES, CLI_MESSAGES, ERROR_SUMMARIES_ZH, type CliErrorMessageKey, type CliMessageKey } from './i18n/catalog.js'
import {
  DEFAULT_TOKENLESS_LANGUAGE,
  TOKENLESS_LANGUAGES,
  interpolateTokenlessMessage,
  normalizeTokenlessLanguage,
  type TokenlessLanguage,
} from '#tokenless-shared/i18n.js'

export { DEFAULT_TOKENLESS_LANGUAGE, TOKENLESS_LANGUAGES, normalizeTokenlessLanguage }
export type { TokenlessLanguage }

let activeLanguage: TokenlessLanguage = DEFAULT_TOKENLESS_LANGUAGE

export function detectSystemLanguage({
  env = process.env,
  locale,
}: {
  env?: NodeJS.ProcessEnv
  locale?: string | undefined
} = {}): TokenlessLanguage {
  const candidate = env.LC_ALL ||
    env.LC_MESSAGES ||
    env.LANG ||
    locale ||
    Intl.DateTimeFormat().resolvedOptions().locale
  return normalizeTokenlessLanguage(candidate.split('.')[0]) ?? DEFAULT_TOKENLESS_LANGUAGE
}

export function setActiveLanguage(language: TokenlessLanguage) {
  activeLanguage = language
}

export function activeTokenlessLanguage() {
  return activeLanguage
}

/**
 * Render a customer-facing message from the shared catalog. Business logic
 * supplies a stable key; the display boundary chooses the active language.
 */
type LegacyCliMessageKey = `cli${Capitalize<CliMessageKey>}`

export function t(key: CliMessageKey | LegacyCliMessageKey, params: Record<string, string | number> = {}, language = activeLanguage) {
  const canonicalKey = (key.startsWith('cli')
    ? `${key[3]!.toLowerCase()}${key.slice(4)}` as CliMessageKey
    : key) as CliMessageKey
  return interpolateTokenlessMessage(CLI_MESSAGES[language][canonicalKey], params)
}

export function localizedError(code: string, fallback?: string, language = activeLanguage) {
  if (language === 'zh-CN') {
    return Object.prototype.hasOwnProperty.call(ERROR_SUMMARIES_ZH, code)
      ? ERROR_SUMMARIES_ZH[code as keyof typeof ERROR_SUMMARIES_ZH]
      : `请求失败（${code || 'unknown'}）。`
  }
  return fallback ?? t('failed', {}, language)
}

export function tError(key: CliErrorMessageKey, params: Record<string, string | number> = {}, language = activeLanguage) {
  return interpolateTokenlessMessage(CLI_ERROR_MESSAGES[language][key], params)
}
