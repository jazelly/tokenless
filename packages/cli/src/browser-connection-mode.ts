export const BROWSER_CONNECTION_MODES = Object.freeze([
  'playwright',
  'cdp',
] as const)

export type BrowserConnectionMode = (typeof BROWSER_CONNECTION_MODES)[number]

export function normalizeBrowserConnectionMode(value: unknown): BrowserConnectionMode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return BROWSER_CONNECTION_MODES.includes(normalized as BrowserConnectionMode)
    ? normalized as BrowserConnectionMode
    : null
}
