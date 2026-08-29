import type { Locator, Page } from 'playwright-core'
import type { AuthStatusResult } from '../browser/actions.js'
import type { ProviderAccountTier, ProviderDomDefinition } from './provider-definition.js'

export type ProviderAccountInspection = {
  readonly name: string | null
  readonly subscription: string | null
  readonly subscriptionEvidence: {
    readonly status: 'observed' | 'derived' | 'unknown'
    readonly source: string | null
  }
}

export interface ProviderAccountInspector {
  inspect(
    page: Page,
    provider: ProviderDomDefinition,
    accountControl: Locator,
    signal: AbortSignal | undefined,
  ): Promise<ProviderAccountInspection>
}

type AccountControlSignal = {
  readonly ariaLabel: string
  readonly title: string
  readonly text: string
}

export class MenuTextAccountInspector implements ProviderAccountInspector {
  async inspect(
    _page: Page,
    provider: ProviderDomDefinition,
    accountControl: Locator,
    _signal: AbortSignal | undefined,
  ): Promise<ProviderAccountInspection> {
    const signal = await readAccountControlSignal(accountControl)
    const lines = accountSignalLines(signal)
    const subscription = findSubscriptionLabel(lines.planCandidates, provider)
    return {
      name: firstAccountName(lines.textLines.length > 0 ? lines.textLines : lines.ariaLines, subscription, provider),
      subscription,
      subscriptionEvidence: subscriptionEvidence('observed', subscription, 'account-control-label'),
    }
  }
}

export async function inspectProviderAccountSession(
  page: Page,
  provider: ProviderDomDefinition,
  signal: AbortSignal | undefined,
): Promise<AuthStatusResult> {
  const maximumAttempts = 50
  for (let attempt = 0; attempt <= maximumAttempts; attempt += 1) {
    assertNotAborted(signal)
    if (isConfiguredSignInNavigation(page.url(), provider)) {
      return {
        state: 'unauthenticated',
        access: 'sign_in_required',
        visibleProof: 'provider-sign-in-navigation',
      }
    }
    const accountControl = await firstLocator(page, provider.authIndicators)
    if (accountControl) {
      const account = await provider.account.inspector.inspect(page, provider, accountControl, signal)
      const tier = providerAccountTier(provider, account.subscription)
      return {
        state: 'authenticated',
        access: tier.class,
        visibleProof: 'authenticated-account-control-visible',
        account: {
          ...account,
          tier: {
            class: tier.class,
            label: tier.label,
          },
        },
      }
    }
    const loginVisible = await anyVisible(page, provider.loginIndicators)
    if (loginVisible) {
      if (provider.id === 'gemini' && attempt < maximumAttempts) {
        await page.waitForTimeout(100)
        continue
      }
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
    if (attempt < maximumAttempts) await page.waitForTimeout(100)
  }
  return {
    state: 'unknown',
    access: 'unknown',
    visibleProof: 'no-authenticated-account-control',
  }
}

export function providerAccountTier(
  provider: ProviderDomDefinition,
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

async function readAccountControlSignal(accountControl: Locator): Promise<AccountControlSignal> {
  return await accountControl.evaluate((element) => ({
    ariaLabel: element.getAttribute('aria-label') ?? '',
    title: element.getAttribute('title') ?? '',
    text: element instanceof HTMLElement ? element.innerText : (element.textContent ?? ''),
  })).catch(() => ({ ariaLabel: '', title: '', text: '' }))
}

function accountSignalLines(signal: AccountControlSignal) {
  const textLines = signal.text
    .split(/\r?\n/)
    .map(normalizeAccountText)
    .filter(Boolean)
  const ariaLines = signal.ariaLabel
    .split(/[,\n·]/)
    .map(normalizeAccountText)
    .filter(Boolean)
  return {
    textLines,
    ariaLines,
    planCandidates: [...textLines, ...ariaLines],
  }
}

function subscriptionEvidence(
  status: ProviderAccountInspection['subscriptionEvidence']['status'],
  subscription: string | null,
  source: string | null,
) {
  return subscription === null
    ? {
        status: 'unknown' as const,
        source: null,
      }
    : {
        status,
        source,
      }
}

function firstAccountName(lines: readonly string[], subscription: string | null, provider: ProviderDomDefinition) {
  const candidates = lines.filter((line) => (
    line !== subscription &&
    !looksLikeEmail(line) &&
    !isSubscriptionLabel(line, provider) &&
    !/^(?:profile image|download apps|get apps and extensions)$/i.test(line) &&
    /[\p{L}\p{N}]/u.test(line)
  ))
  return candidates.find((line) => line.length > 1) ?? candidates[0] ?? null
}

function findSubscriptionLabel(values: readonly string[], provider: ProviderDomDefinition) {
  return values.find((line) => isSubscriptionLabel(line, provider)) ?? null
}

function isSubscriptionLabel(value: string, provider: ProviderDomDefinition) {
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

function isConfiguredSignInNavigation(value: unknown, provider: ProviderDomDefinition) {
  return provider.navigationPolicy.classify(value).kind === 'trusted_sign_in'
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Provider session inspection was aborted.')
}
