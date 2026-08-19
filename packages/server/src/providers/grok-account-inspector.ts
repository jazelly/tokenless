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
): Promise<'Free' | 'SuperGrok Lite' | 'SuperGrok' | null> {
  const trigger = await firstLocator(page, provider.modelControlSelectors)
  if (!trigger) return null

  let openedHere = false
  try {
    const expanded = await trigger.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') {
      await trigger.click({ timeout: 2000 })
      openedHere = true
    }
    await page.waitForTimeout(300)
    assertNotAborted(signal)
    const surface = await inspectGrokEntitlementSurface(page)
    if (surface.modeLabels.length === 1 && surface.modeLabels[0] === 'fast') {
      return 'Free'
    }
    if (surface.modeLabels.length > 1) {
      return surface.hasSuperGrokUpgrade ? 'SuperGrok Lite' : 'SuperGrok'
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

async function inspectGrokEntitlementSurface(page: Page): Promise<{
  modeLabels: string[]
  hasSuperGrokUpgrade: boolean
}> {
  return await page.locator('[role="menuitem"][data-radix-collection-item]').evaluateAll((elements) => {
    const modeLabels = new Set(['auto', 'fast', 'expert', 'heavy', 'build'])
    const visibleText = elements.flatMap((element) => {
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
      return [(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()]
    })
    return {
      modeLabels: visibleText.flatMap((text) => {
        const label = text.match(/^(Auto|Fast|Expert|Heavy|Build)\b/i)?.[1]?.toLowerCase()
        return label && modeLabels.has(label) ? [label] : []
      }),
      hasSuperGrokUpgrade: visibleText.some((text) => (
        /unlock extended capabilities/i.test(text) && /upgrade/i.test(text)
      )),
    }
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
