export const TOKENLESS_LANGUAGES = Object.freeze(['en', 'zh-CN'] as const)

export type TokenlessLanguage = (typeof TOKENLESS_LANGUAGES)[number]

export const DEFAULT_TOKENLESS_LANGUAGE: TokenlessLanguage = 'en'

export function normalizeTokenlessLanguage(value: unknown): TokenlessLanguage | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/_/g, '-').toLowerCase()
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  return null
}

export function interpolateTokenlessMessage(template: string, params: Readonly<Record<string, string | number>> = {}) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`))
}
