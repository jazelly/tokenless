import type { Locator, Page } from 'playwright-core'
import {
  MenuTextAccountInspector,
  type ProviderAccountInspection,
  type ProviderAccountInspector,
} from './account-inspectors.js'
import type { ProviderDomDefinition } from './provider-definition.js'

export class DoubaoAccountInspector implements ProviderAccountInspector {
  async inspect(
    page: Page,
    provider: ProviderDomDefinition,
    accountControl: Locator,
    signal: AbortSignal | undefined,
  ): Promise<ProviderAccountInspection> {
    const base = await new MenuTextAccountInspector().inspect(page, provider, accountControl, signal)
    const subscription = await inspectDoubaoSubscription(page, accountControl, signal)
    if (subscription === null) {
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
      subscription,
      subscriptionEvidence: {
        status: 'derived',
        source: 'upgrade-to-professional-menu-item',
      },
    }
  }
}

async function inspectDoubaoSubscription(
  page: Page,
  accountControl: Locator,
  signal: AbortSignal | undefined,
): Promise<'免费版' | null> {
  const upgradeItem = page.getByRole('menuitem', { name: '升级到专业版', exact: true })
  let openedHere = false
  try {
    if (!await upgradeItem.isVisible({ timeout: 300 }).catch(() => false)) {
      assertNotAborted(signal)
      await accountControl.click({ timeout: 2000 })
      openedHere = true
    }
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      assertNotAborted(signal)
      if (await upgradeItem.isVisible({ timeout: 100 }).catch(() => false)) return '免费版'
      if (attempt < 10) await page.waitForTimeout(100)
    }
    return null
  } catch {
    return null
  } finally {
    if (openedHere) await page.keyboard.press('Escape').catch(() => undefined)
  }
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Provider session inspection was aborted.')
}
