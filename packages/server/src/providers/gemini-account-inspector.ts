import type { Locator, Page } from 'playwright-core'
import type { ProviderAccountInspection, ProviderAccountInspector } from './account-inspectors.js'
import type { ProviderDomDefinition } from './provider-definition.js'

export class GeminiAccountInspector implements ProviderAccountInspector {
  async inspect(
    _page: Page,
    _provider: ProviderDomDefinition,
    accountControl: Locator,
    _signal: AbortSignal | undefined,
  ): Promise<ProviderAccountInspection> {
    const ariaLabel = await accountControl.evaluate((element) => (
      element.getAttribute('aria-label') ?? ''
    )).catch(() => '')
    return {
      name: geminiGoogleAccountName(ariaLabel),
      subscription: null,
      subscriptionEvidence: {
        status: 'unknown',
        source: null,
      },
    }
  }
}

function geminiGoogleAccountName(ariaLabel: string) {
  const normalized = normalizeAccountText(ariaLabel)
  const match = normalized.match(/^Google Account:\s*(.+?)(?:\s*\(|$)/i)
  return match ? normalizeAccountText(match[1] ?? '') || null : null
}

function normalizeAccountText(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}
