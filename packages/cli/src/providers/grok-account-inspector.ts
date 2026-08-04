import type { Locator, Page } from 'playwright-core'
import {
  MenuTextAccountInspector,
  type ProviderAccountInspection,
  type ProviderAccountInspector,
} from './account-inspectors.js'
import type { ProviderDomDefinition } from './provider-definition.js'

export class GrokEntitlementAccountInspector implements ProviderAccountInspector {
  async inspect(
    page: Page,
    provider: ProviderDomDefinition,
    accountControl: Locator,
    signal: AbortSignal | undefined,
  ): Promise<ProviderAccountInspection> {
    const base = await new MenuTextAccountInspector().inspect(page, provider, accountControl, signal)
    const entitlement = await inspectGrokSubscription(page, provider, signal)
    if (entitlement === null) {
      return {
        ...base,
        subscription: null,
        subscriptionEvidence: {
          status: 'unknown',
          source: null,
        },
      }
    }
    return {
      ...base,
      subscription: entitlement,
      subscriptionEvidence: {
        status: 'derived',
        source: 'model-entitlement-rows',
      },
    }
  }
}

async function inspectGrokSubscription(
  page: Page,
  provider: ProviderDomDefinition,
  signal: AbortSignal | undefined,
): Promise<'Free' | 'SuperGrok' | null> {
  const trigger = await firstLocator(page, provider.modelControlSelectors)
  if (!trigger) return null

  let openedHere = false
  try {
    const expanded = await trigger.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') {
      await trigger.click({ timeout: 2000 })
      openedHere = true
    }
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      assertNotAborted(signal)
      const rows = await collectGrokEntitlementRows(page)
      if (rows.length === 3) {
        return rows.every((row) => row.unavailable) ? 'Free' : 'SuperGrok'
      }
      if (attempt < 10) await page.waitForTimeout(100)
    }
    return null
  } catch {
    return null
  } finally {
    if (openedHere) {
      await trigger.click({ timeout: 1000 }).catch(() => undefined)
    }
  }
}

async function collectGrokEntitlementRows(page: Page): Promise<Array<{ label: string, unavailable: boolean }>> {
  return await page.locator('[role="menuitem"][data-radix-collection-item]').evaluateAll((elements) => {
    const entitlementLabels = new Set(['auto', 'expert', 'heavy'])
    return elements.flatMap((element) => {
      if (!(element instanceof HTMLElement)) return []
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      if (
        rect.width === 0 ||
        rect.height === 0 ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) return []
      const label = (element.querySelector('.font-semibold')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!entitlementLabels.has(label.toLowerCase())) return []
      const classTokens = new Set((element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
      const dataDisabled = element.getAttribute('data-disabled')
      const explicitlyDisabled = (
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true' ||
        (dataDisabled !== null && dataDisabled !== 'false') ||
        Boolean(element.querySelector(':disabled, [aria-disabled="true"], [data-disabled]:not([data-disabled="false"])'))
      )
      const visuallyUnavailable = (
        classTokens.has('cursor-not-allowed') ||
        (
          classTokens.has('text-secondary') &&
          (classTokens.has('opacity-75') || Number(style.opacity) < 1)
        )
      )
      return [{
        label,
        unavailable: explicitlyDisabled || visuallyUnavailable,
      }]
    })
  })
}

async function firstLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.isVisible({ timeout: 500 }).catch(() => false)) return locator
  }
  return null
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Provider session inspection was aborted.')
}
