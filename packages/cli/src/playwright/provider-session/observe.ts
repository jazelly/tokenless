import type { Page } from 'playwright-core'
import type { VisibleBlocker } from '../actions.js'
import type { ProviderDomDefinition } from '../../providers/provider-definition.js'
import type { ProviderSessionObservation } from './types.js'

export async function observeProviderSession(
  page: Page,
  provider: ProviderDomDefinition,
): Promise<ProviderSessionObservation> {
  const [composerVisible, loginVisible, authenticatedControlVisible, guestContinueAvailable, blockers] = await Promise.all([
    anyVisible(page, provider.composerSelectors),
    anyVisible(page, provider.loginIndicators),
    anyVisible(page, provider.authIndicators),
    anyNamedControlVisible(page, provider.access.guestContinueControlNames),
    detectStructuredBlockers(page, provider),
  ])
  const authentication = loginVisible
    ? 'unauthenticated' as const
    : authenticatedControlVisible
      ? 'authenticated' as const
      : 'unknown' as const
  const access = authentication === 'unauthenticated'
    ? provider.access.guest === 'supported' && composerVisible
      ? 'guest' as const
      : 'sign_in_required' as const
    : authentication === 'authenticated'
      ? 'signed_in_unknown' as const
      : provider.access.guest === 'supported' && composerVisible
        ? 'guest' as const
        : 'unknown' as const

  return {
    provider: provider.id,
    url: sanitizedNavigationOrigin(provider, page.url()),
    authentication,
    access,
    composerVisible,
    guestContinueAvailable,
    blockers,
  }
}

export async function clickGuestContinuation(
  page: Page,
  provider: ProviderDomDefinition,
) {
  for (const name of provider.access.guestContinueControlNames) {
    for (const role of ['button', 'link'] as const) {
      const control = page.getByRole(role, { name, exact: true }).first()
      if (!await control.isVisible({ timeout: 100 }).catch(() => false)) continue
      if (await control.click({ timeout: 1000 }).then(() => true).catch(() => false)) return true
    }
  }
  return false
}

async function detectStructuredBlockers(
  page: Page,
  provider: ProviderDomDefinition,
): Promise<VisibleBlocker[]> {
  const url = page.url()
  const navigation = provider.navigationPolicy.classify(url)
  const domBlockers = await page.evaluate(() => {
    type RawBlocker = {
      kind: 'challenge' | 'auth' | 'terminal'
      code: string
      message: string
      family?: string
      proof: string
    }
    const isVisibleElement = (element: Element | null): element is HTMLElement | SVGElement => {
      if (!element || !(element instanceof HTMLElement || element instanceof SVGElement)) return false
      let node: Element | null = element
      while (node && node instanceof Element) {
        const style = window.getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
        node = node.parentElement
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const ownText = (element: Element) => Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(' ')
    const visibleText = () => Array.from(document.body?.querySelectorAll('body, body *') ?? [])
      .filter(isVisibleElement)
      .map((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? [element.getAttribute('aria-label'), element.getAttribute('placeholder')].filter(Boolean).join(' ')
        : [
            ownText(element),
            element.getAttribute('aria-label'),
            element.getAttribute('placeholder'),
          ].filter(Boolean).join(' '))
      .join(' ')
    const text = visibleText().replace(/\s+/g, ' ').slice(0, 20_000)
    const lowerText = text.toLowerCase()
    const raw: RawBlocker[] = []
    const visibleFrames = Array.from(document.querySelectorAll('iframe')).filter(isVisibleElement)
    const visibleInputs = Array.from(document.querySelectorAll('input, button, a, [role="button"], [role="textbox"]')).filter(isVisibleElement)
    const visibleWithAttribute = (selector: string) => {
      try {
        return Array.from(document.querySelectorAll(selector)).some(isVisibleElement)
      } catch {
        return false
      }
    }
    for (const frame of visibleFrames) {
      const src = (frame.getAttribute('src') ?? '').toLowerCase()
      const title = (frame.getAttribute('title') ?? '').toLowerCase()
      if (src.includes('/recaptcha/') || title.includes('recaptcha')) {
        raw.push({ kind: 'challenge', code: 'visible_recaptcha', family: 'recaptcha', message: 'Visible reCAPTCHA verification is blocking the provider page.', proof: 'visible-recaptcha-frame' })
      } else if (src.includes('hcaptcha.com') || title.includes('hcaptcha')) {
        raw.push({ kind: 'challenge', code: 'visible_hcaptcha', family: 'hcaptcha', message: 'Visible hCaptcha verification is blocking the provider page.', proof: 'visible-hcaptcha-frame' })
      } else if (src.includes('challenges.cloudflare.com') || src.includes('/cdn-cgi/challenge-platform') || title.includes('cloudflare') || title.includes('turnstile')) {
        raw.push({ kind: 'challenge', code: 'visible_cloudflare_turnstile', family: 'cloudflare', message: 'Visible Cloudflare verification is blocking the provider page.', proof: 'visible-cloudflare-frame' })
      } else if (src.includes('arkoselabs') || src.includes('funcaptcha') || title.includes('arkose') || title.includes('funcaptcha')) {
        raw.push({ kind: 'challenge', code: 'visible_arkose_funcaptcha', family: 'arkose', message: 'Visible Arkose/FunCaptcha verification is blocking the provider page.', proof: 'visible-arkose-frame' })
      }
    }
    if (visibleWithAttribute('.cf-turnstile, [data-cf-turnstile], [data-turnstile-widget]')) {
      raw.push({ kind: 'challenge', code: 'visible_cloudflare_turnstile', family: 'cloudflare', message: 'Visible Cloudflare Turnstile is blocking the provider page.', proof: 'visible-turnstile-widget' })
    }
    if (/(checking if the site connection is secure|verify you are human|cloudflare ray id|needs to review the security of your connection)/i.test(text)) {
      raw.push({ kind: 'challenge', code: 'visible_cloudflare_interstitial', family: 'cloudflare', message: 'Visible Cloudflare interstitial is blocking the provider page.', proof: 'visible-cloudflare-interstitial-text' })
    }
    const signInControl = visibleInputs.find((element) => /log in|sign in|continue with|enter your email|email address/i.test([
      ownText(element),
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
    ].filter(Boolean).join(' ')))
    if (signInControl) {
      const blockingSurface = signInControl.closest('dialog, [role="dialog"], [aria-modal="true"]')
      raw.push(blockingSurface
        ? { kind: 'auth', code: 'provider_sign_in_required', family: 'provider_sign_in', message: 'A visible sign-in dialog is blocking the requested action.', proof: 'visible-provider-sign-in-dialog' }
        : { kind: 'auth', code: 'provider_sign_in_visible', family: 'provider_sign_in', message: 'Provider sign-in is visible but may be optional.', proof: 'visible-provider-sign-in-control' })
    }
    if (/(rate limit|too many requests|try again later|temporarily unavailable)/i.test(lowerText)) {
      raw.push({ kind: 'terminal', code: 'provider_rate_limited', family: 'rate_limit', message: 'The provider is showing a visible rate limit or temporary capacity blocker.', proof: 'visible-rate-limit-text' })
    }
    if (/(upgrade required|upgrade your plan|subscribe to|requires a paid plan|plan limit|usage limit)/i.test(lowerText)) {
      raw.push({ kind: 'terminal', code: 'provider_plan_limited', family: 'plan_limit', message: 'The provider is showing a visible plan or quota blocker.', proof: 'visible-plan-limit-text' })
    }
    return raw
  })

  const selectorBlockers: VisibleBlocker[] = []
  for (const selector of provider.loginIndicators) {
    if (!await firstVisibleFast(page, selector)) continue
    selectorBlockers.push(createBlocker({
      provider,
      url,
      kind: 'auth',
      code: 'provider_sign_in_visible',
      family: 'provider_sign_in',
      message: 'Provider sign-in is visible.',
      visibleProof: `visible-login-selector:${selectorReason(selector)}`,
    }))
    break
  }
  for (const selector of provider.blockerSelectors) {
    if (!await firstVisibleFast(page, selector)) continue
    const reason = selectorReason(selector)
    const requiresAuth = provider.loginIndicators.includes(selector)
    const terminal = /rate|upgrade|plan|too many requests/i.test(selector)
    selectorBlockers.push(createBlocker({
      provider,
      url,
      kind: requiresAuth ? 'auth' : (terminal ? 'terminal' : 'challenge'),
      code: requiresAuth
        ? 'provider_sign_in_required'
        : (terminal ? (/upgrade|plan/i.test(selector) ? 'provider_plan_limited' : 'provider_rate_limited') : 'visible_provider_blocker'),
      family: requiresAuth
        ? 'provider_sign_in'
        : (terminal ? (/upgrade|plan/i.test(selector) ? 'plan_limit' : 'rate_limit') : undefined),
      message: requiresAuth
        ? 'Provider sign-in is blocking the requested action and requires the user.'
        : terminal
          ? 'The provider is showing a visible terminal account or capacity blocker.'
          : 'A visible provider challenge or blocker is present.',
      visibleProof: `visible-selector:${reason}`,
    }))
  }
  if (navigation.kind === 'trusted_sign_in') {
    selectorBlockers.push(createBlocker({
      provider,
      url,
      kind: 'auth',
      code: 'provider_sign_in_url',
      family: 'provider_sign_in',
      message: 'Provider sign-in URL is visible and requires the user.',
      visibleProof: 'visible-provider-sign-in-url',
    }))
  }
  const all = [
    ...domBlockers.map((raw) => createBlocker({
      provider,
      url,
      kind: raw.kind,
      code: raw.code,
      family: raw.family as VisibleBlocker['family'],
      message: raw.message,
      visibleProof: raw.proof,
    })),
    ...selectorBlockers,
  ]
  const seen = new Set<string>()
  return all.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.code}:${candidate.visibleProof}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function createBlocker(input: {
  provider: ProviderDomDefinition
  url: string
  kind: VisibleBlocker['kind']
  code: string
  message: string
  visibleProof: string
  family?: VisibleBlocker['family']
}): VisibleBlocker {
  const userResolvable = input.kind === 'challenge' || input.kind === 'auth'
  return {
    kind: input.kind,
    code: input.code,
    message: input.message,
    userResolvable,
    retryable: userResolvable,
    visibleProof: input.visibleProof,
    provider: input.provider.id,
    url: sanitizedNavigationOrigin(input.provider, input.url),
    ...(input.family ? { family: input.family } : {}),
  }
}

async function anyVisible(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    if (await firstVisibleFast(page, selector)) return true
  }
  return false
}

async function anyNamedControlVisible(page: Page, names: readonly string[]) {
  for (const name of names) {
    for (const role of ['button', 'link'] as const) {
      if (await page.getByRole(role, { name, exact: true }).first().isVisible({ timeout: 100 }).catch(() => false)) return true
    }
  }
  return false
}

async function firstVisibleFast(page: Page, selector: string) {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 100 })
  } catch {
    return false
  }
}

function selectorReason(selector: string) {
  if (/captcha/i.test(selector)) return 'captcha'
  if (/rate limit|too many/i.test(selector)) return 'rate_limit'
  if (/upgrade|paywall|subscribe/i.test(selector)) return 'upgrade_or_paywall'
  return 'visible_blocker'
}

function sanitizedNavigationOrigin(provider: ProviderDomDefinition, value: string) {
  const classification = provider.navigationPolicy.classify(value)
  if (classification.kind === 'approved') return classification.target.origin
  if (classification.kind === 'trusted_sign_in') return classification.origin
  return ''
}
