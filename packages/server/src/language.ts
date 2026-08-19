export const TOKENLESS_LANGUAGES = Object.freeze(['en', 'zh-CN'] as const)

export type TokenlessLanguage = (typeof TOKENLESS_LANGUAGES)[number]

export function normalizeTokenlessLanguage(value: unknown): TokenlessLanguage | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/_/g, '-').toLowerCase()
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  return null
}
