export const BROWSER_VISIBILITIES = Object.freeze(['auto', 'headed', 'headless'] as const)

export type BrowserVisibility = typeof BROWSER_VISIBILITIES[number]
export type EffectiveBrowserVisibility = Exclude<BrowserVisibility, 'auto'>

export function normalizeBrowserVisibility(
  value: unknown,
  fallback: BrowserVisibility | null = null
): BrowserVisibility | null {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (isBrowserVisibility(normalized)) return normalized
  return fallback
}

export function resolveEffectiveBrowserVisibility(visibility: BrowserVisibility): EffectiveBrowserVisibility {
  return visibility === 'headed' ? 'headed' : 'headless'
}

function isBrowserVisibility(value: string): value is BrowserVisibility {
  return (BROWSER_VISIBILITIES as readonly string[]).includes(value)
}
