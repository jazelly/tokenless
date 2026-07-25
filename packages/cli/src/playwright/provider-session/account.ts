import type { Locator, Page } from 'playwright-core'
import type { AuthStatusResult } from '../actions.js'
import type {
  ProviderAccountTier,
  ProviderConfig,
} from '../providers.js'
import { isProviderSignInNavigation } from './observe.js'

export async function inspectProviderAccountSession(
  page: Page,
  provider: ProviderConfig,
  signal: AbortSignal | undefined,
): Promise<AuthStatusResult> {
  for (let attempt = 0; attempt <= 50; attempt += 1) {
    assertNotAborted(signal)
    if (isProviderSignInNavigation(page.url())) {
      return {
        state: 'unauthenticated',
        access: 'sign_in_required',
        visibleProof: 'provider-sign-in-navigation',
      }
    }
    const loginVisible = await anyVisible(page, provider.loginIndicators)
    if (loginVisible) {
      const composerVisible = await anyVisible(page, provider.composerSelectors)
      const guestSupported = provider.access.guest === 'supported'
      const guest = guestSupported && composerVisible
      return {
        state: 'unauthenticated',
        access: guest
          ? 'guest'
          : guestSupported
            ? 'unknown'
            : 'sign_in_required',
        visibleProof: guest
          ? 'guest-composer-visible'
          : guestSupported
            ? 'login-invitation-visible-guest-surface-not-ready'
            : composerVisible
              ? 'sign-in-required-despite-composer'
              : 'login-indicator-visible',
      }
    }
    const accountControl = await firstLocator(page, provider.authIndicators)
    if (accountControl) {
      const account = await readProviderAccount(accountControl, provider)
      const observedAccount = provider.account.planStrategy === 'grok-entitlements'
        ? {
            ...account,
            ...grokSubscriptionEvidence(await inspectGrokSubscription(page, provider, signal)),
          }
        : account
      const tier = providerAccountTier(provider, observedAccount.subscription)
      return {
        state: 'authenticated',
        access: tier.class,
        visibleProof: 'authenticated-account-control-visible',
        account: {
          ...observedAccount,
          tier: {
            class: tier.class,
            label: tier.label,
          },
        },
      }
    }
    if (attempt < 50) await page.waitForTimeout(100)
  }
  const composerVisible = await anyVisible(page, provider.composerSelectors)
  const guest = provider.access.guest === 'supported' && composerVisible
  return {
    state: guest ? 'unauthenticated' : 'unknown',
    access: guest ? 'guest' : 'unknown',
    visibleProof: guest ? 'guest-composer-visible' : 'no-authenticated-account-control',
  }
}

function providerAccountTier(
  provider: ProviderConfig,
  subscription: string | null,
): ProviderAccountTier {
  if (subscription === null) {
    return {
      class: 'signed_in_unknown' as const,
      label: null,
    }
  }
  const normalized = normalizeAccountText(subscription).replace(/\s+plan$/i, '').toLowerCase()
  if (provider.account.freePlanLabels.some((label) => label.toLowerCase() === normalized)) {
    return {
      class: 'signed_in_free' as const,
      label: subscription,
    }
  }
  if (provider.account.paidPlanLabels.some((label) => label.toLowerCase() === normalized)) {
    return {
      class: 'signed_in_paid' as const,
      label: subscription,
    }
  }
  return {
    class: 'signed_in_unknown' as const,
    label: subscription,
  }
}

async function readProviderAccount(accountControl: Locator, provider: ProviderConfig) {
  const signal = await accountControl.evaluate((element) => ({
    ariaLabel: element.getAttribute('aria-label') ?? '',
    title: element.getAttribute('title') ?? '',
    text: element instanceof HTMLElement ? element.innerText : (element.textContent ?? ''),
  })).catch(() => ({ ariaLabel: '', title: '', text: '' }))
  const textLines = signal.text
    .split(/\r?\n/)
    .map(normalizeAccountText)
    .filter(Boolean)
  const ariaLines = signal.ariaLabel
    .split(/[,\n·]/)
    .map(normalizeAccountText)
    .filter(Boolean)
  const planCandidates = [...textLines, ...ariaLines]
  const subscription = provider.account.planStrategy === 'menu-label'
    ? planCandidates.find((line) => isSubscriptionLabel(line, provider)) ?? null
    : null
  const name = provider.account.nameStrategy === 'google-account-aria'
    ? googleAccountName(signal.ariaLabel)
    : firstAccountName(textLines.length > 0 ? textLines : ariaLines, subscription, provider)
  return {
    name,
    subscription,
    subscriptionEvidence: subscription === null
      ? {
          status: 'unknown' as const,
          source: null,
        }
      : {
          status: 'observed' as const,
          source: 'account-control-label',
        },
  }
}

function firstAccountName(lines: string[], subscription: string | null, provider: ProviderConfig) {
  const candidates = lines.filter((line) => (
    line !== subscription &&
    !looksLikeEmail(line) &&
    !isSubscriptionLabel(line, provider) &&
    !/^(?:profile image|download apps|get apps and extensions)$/i.test(line) &&
    /[\p{L}\p{N}]/u.test(line)
  ))
  return candidates.find((line) => line.length > 1) ?? candidates[0] ?? null
}

function googleAccountName(ariaLabel: string) {
  const normalized = normalizeAccountText(ariaLabel)
  const match = normalized.match(/^Google Account:\s*(.+?)(?:\s*\(|$)/i)
  return match ? normalizeAccountText(match[1] ?? '') || null : null
}

function isSubscriptionLabel(value: string, provider: ProviderConfig) {
  const normalized = value.replace(/\s+plan$/i, '').trim().toLowerCase()
  return [
    ...provider.account.freePlanLabels,
    ...provider.account.paidPlanLabels,
  ].some((label) => label.toLowerCase() === normalized)
}

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function normalizeAccountText(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

async function inspectGrokSubscription(
  page: Page,
  provider: ProviderConfig,
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

function grokSubscriptionEvidence(subscription: 'Free' | 'SuperGrok' | null) {
  if (subscription === null) {
    return {
      subscription,
      subscriptionEvidence: {
        status: 'unknown' as const,
        source: null,
      },
    }
  }
  return {
    subscription,
    subscriptionEvidence: {
      status: 'derived' as const,
      source: 'model-entitlement-rows',
    },
  }
}

async function collectGrokEntitlementRows(page: Page): Promise<Array<{ label: string, unavailable: boolean }>> {
  return page.locator('[role="menuitem"][data-radix-collection-item]').evaluateAll((elements) => {
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

async function anyVisible(page: Page, selectors: readonly string[]) {
  return await firstLocator(page, selectors) !== null
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Provider session inspection was aborted.')
}
