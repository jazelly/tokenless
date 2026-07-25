import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { VISIBLE_ACTIONS, VISIBLE_ATTACHMENT_PROTOCOL_VERSION, validateAttachmentInput } from '../actions.js'
import { TokenlessPlaywrightError, tokenlessError } from '../errors.js'
import { PROVIDER_CAPABILITIES, assertProviderUrlAllowed, getProviderForUrl, trustedProviderSignInNavigation } from '../providers.js'
import type { AttachmentInput, Choice, CapabilityInspectResult, ProviderCapabilityInspection, VisibleActionRequest, VisibleActionResponse, VisibleActionResult, VisibleBlocker, VisibleCitation } from '../actions.js'
import type { ProviderCapabilityId, ProviderConfig } from '../providers.js'
import type { ProviderAdapter, VisibleAdapterContext } from './types.js'
import type { FileChooser, Locator, Page } from 'playwright-core'

const PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS = 15_000

export function createDomProviderAdapter(provider: ProviderConfig): ProviderAdapter {
  return {
    provider,
    async execute(page: Page, request: VisibleActionRequest, context: VisibleAdapterContext): Promise<VisibleActionResponse> {
      assertNotAborted(context.signal)
      if (request.provider !== provider.id) {
        return failure(request, 'provider_mismatch', 'The action provider does not match this adapter.', false)
      }
      const pageUrl = page.url()
      const navigation = assertProviderUrlAllowed(provider, pageUrl)
      if (!navigation.ok && request.action !== VISIBLE_ACTIONS.NAVIGATION_CHECK) {
        if (trustedProviderSignInNavigation(provider, pageUrl)) {
          if (request.action === VISIBLE_ACTIONS.AUTH_STATUS) {
            return success(request, {
              state: 'unauthenticated',
              visibleProof: 'provider-sign-in-navigation',
            })
          }
          return failure(request, 'provider_sign_in_navigation', 'Provider sign-in navigation is visible and requires the user.', true)
        }
        return failure(request, 'unsupported_provider_navigation', 'The visible page is outside the approved provider origin.', false)
      }
      if (request.action === VISIBLE_ACTIONS.CAPABILITY_INSPECT) return success(request, await inspectCapabilities(page, provider))
      if (request.action === VISIBLE_ACTIONS.AUTH_STATUS) return success(request, await inspectAuth(page, provider, context.signal))
      if (request.action === VISIBLE_ACTIONS.NAVIGATION_CHECK) return success(request, inspectNavigation(page, provider))
      if (request.action === VISIBLE_ACTIONS.BLOCKER_CHECK) return success(request, await inspectVisibleBlockers(page, provider))
      if (request.action === VISIBLE_ACTIONS.MODEL_INSPECT) return success(request, await inspectChoices(page, provider, 'model'))
      if (request.action === VISIBLE_ACTIONS.MODEL_SELECT) return success(request, await selectChoice(page, provider, 'model', request.payload.label))
      if (request.action === VISIBLE_ACTIONS.EFFORT_INSPECT) return success(request, await inspectChoices(page, provider, 'effort'))
      if (request.action === VISIBLE_ACTIONS.EFFORT_SELECT) return success(request, await selectChoice(page, provider, 'effort', request.payload.label))
      if (request.action === VISIBLE_ACTIONS.FILE_UPLOAD) return success(request, await uploadFiles(page, provider, request.payload.attachments, context))
      if (request.action === VISIBLE_ACTIONS.WORKSPACE_ENSURE) {
        if (request.payload.mode === 'native') {
          return failure(request, 'workspace_native_unavailable', 'Native workspace creation is unavailable from fixture-proven visible provider controls.', false)
        }
        return success(request, await ensureWorkspace(page, provider, request.payload))
      }
      if (request.action === VISIBLE_ACTIONS.PROMPT_INPUT) return success(request, await inputPrompt(page, provider, request.payload.text))
      if (request.action === VISIBLE_ACTIONS.PROMPT_CLEAR) return success(request, await clearPrompt(page, provider))
      if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) return success(request, await submitPrompt(page, provider))
      if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) return success(request, await readResponse(page, provider))
      if (request.action === VISIBLE_ACTIONS.SNAPSHOT_SANITIZED) return success(request, await sanitizedSnapshot(page))
      return failure(request, 'unknown_visible_action', 'Visible action is not supported.', false)
    },
  }
}

async function inspectAuth(page: Page, provider: ProviderConfig, signal: AbortSignal | undefined) {
  for (let attempt = 0; attempt <= 50; attempt += 1) {
    assertNotAborted(signal)
    const loginVisible = await anyVisible(page, provider.loginIndicators)
    if (loginVisible) {
      return {
        state: 'unauthenticated' as const,
        visibleProof: 'login-indicator-visible',
      }
    }
    const accountControl = await firstLocator(page, provider.authIndicators)
    if (accountControl) {
      const account = await readProviderAccount(accountControl, provider)
      const menuVerified = await verifyAccountControl(page, accountControl, provider, signal)
      if (!menuVerified) {
        return {
          state: 'unauthenticated' as const,
          visibleProof: 'account-control-action-unverified',
        }
      }
      const observedAccount = provider.id === 'grok'
        ? {
            ...account,
            ...grokSubscriptionEvidence(await inspectGrokSubscription(page, provider, signal)),
          }
        : account
      return {
        state: 'authenticated' as const,
        visibleProof: provider.authMenuIndicators.length > 0
          ? 'authenticated-account-menu-visible'
          : 'authenticated-account-control-clicked',
        account: observedAccount,
      }
    }
    if (attempt < 50) await page.waitForTimeout(100)
  }
  return {
    state: 'unauthenticated' as const,
    visibleProof: 'no-authenticated-account-control',
  }
}

async function verifyAccountControl(
  page: Page,
  accountControl: Locator,
  provider: ProviderConfig,
  signal: AbortSignal | undefined,
) {
  let opened = false
  let verified = false
  try {
    await accountControl.click({ timeout: 2000 })
    opened = true
    if (provider.authMenuIndicators.length === 0) {
      verified = await accountControl.isVisible({ timeout: 500 })
      return verified
    }
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      assertNotAborted(signal)
      if (await anyVisible(page, provider.authMenuIndicators)) {
        verified = true
        return true
      }
      if (attempt < 10) await page.waitForTimeout(100)
    }
    return false
  } catch {
    return false
  } finally {
    if (opened && verified) {
      await accountControl.click({ timeout: 1000 }).catch(() => undefined)
    }
  }
}

async function readProviderAccount(accountControl: Locator, provider: ProviderConfig) {
  const signal = await accountControl.evaluate((element) => ({
    ariaLabel: element.getAttribute('aria-label') ?? '',
    title: element.getAttribute('title') ?? '',
    text: element instanceof HTMLElement ? element.innerText : (element.textContent ?? ''),
  })).catch(() => ({ ariaLabel: '', title: '', text: '' }))
  const lines = signal.text
    .split(/\r?\n/)
    .map(normalizeAccountText)
    .filter(Boolean)
  const subscription = provider.id === 'chatgpt' || provider.id === 'claude'
    ? lines.find(isSubscriptionLabel) ?? null
    : null
  const name = provider.id === 'gemini'
    ? googleAccountName(signal.ariaLabel)
    : firstAccountName(lines, subscription)
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
          source: 'account-menu-label',
        },
  }
}

function firstAccountName(lines: string[], subscription: string | null) {
  const candidates = lines.filter((line) => (
    line !== subscription &&
    !looksLikeEmail(line) &&
    !isSubscriptionLabel(line) &&
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

function isSubscriptionLabel(value: string) {
  return /^(?:Free|Go|Plus|Pro|Max|Team|Business|Enterprise)(?:\s+plan)?$/i.test(value)
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
  }).catch(() => [])
}

async function inspectCapabilities(page: Page, provider: ProviderConfig): Promise<CapabilityInspectResult> {
  const entries = await Promise.all((Object.keys(provider.capabilities) as ProviderCapabilityId[]).map(async (capability) => [
    capability,
    await inspectCapability(page, provider, capability),
  ] as const))
  return {
    visibleProof: 'provider-capability-registry',
    capabilities: Object.fromEntries(entries) as Readonly<Record<ProviderCapabilityId, ProviderCapabilityInspection>>,
  }
}

async function inspectCapability(page: Page, provider: ProviderConfig, capability: ProviderCapabilityId): Promise<ProviderCapabilityInspection> {
  const strategy = provider.capabilities[capability]
  if (capability === PROVIDER_CAPABILITIES.FILE_UPLOAD) {
    const evidence = await inspectFileUploadAvailability(page, provider)
    return {
      ...strategy,
      availability: evidence.availability,
      visibleProof: evidence.visibleProof,
      reason: evidence.reason,
      native: {
        ...strategy.native,
        availability: evidence.availability,
        visibleProof: evidence.availability === 'unknown' ? strategy.native.visibleProof : evidence.visibleProof,
        reason: evidence.reason,
      },
    }
  }
  if (capability === PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE) {
    const composer = await firstLocator(page, provider.composerSelectors)
    const availability = composer ? 'available' as const : 'unknown' as const
    const visibleProof = composer ? 'conversation-composer-visible' : 'no-visible-conversation-composer'
    const reason = composer ? null : 'visible_composer_not_observed'
    return {
      ...strategy,
      availability,
      visibleProof,
      reason,
      native: {
        ...strategy.native,
        availability,
        visibleProof,
        reason,
      },
    }
  }
  if (capability === PROVIDER_CAPABILITIES.WORKSPACE_ENSURE) {
    const composer = await firstLocator(page, provider.composerSelectors)
    const availability = composer ? 'available' as const : 'unknown' as const
    const visibleProof = composer ? 'conversation-composer-visible' : 'no-visible-conversation-composer'
    const reason = composer ? strategy.reason : 'visible_composer_not_observed'
    return {
      ...strategy,
      availability,
      visibleProof,
      reason,
      fallback: {
        ...strategy.fallback,
        availability,
        visibleProof,
        reason: composer ? null : 'visible_composer_not_observed',
      },
    }
  }
  return strategy
}

async function inspectFileUploadAvailability(page: Page, provider: ProviderConfig) {
  const unavailable = await firstUnavailableLocator(page, [
    ...provider.fileUploadLocalSelectors,
    ...provider.fileUploadTriggerSelectors,
  ])
  if (unavailable) {
    return {
      availability: 'unavailable' as const,
      visibleProof: 'visible-upload-control-disabled-or-upgrade',
      reason: 'visible_upload_control_disabled_or_requires_upgrade',
    }
  }
  const localUpload = await firstEnabledLocator(page, provider.fileUploadLocalSelectors)
  if (localUpload) {
    return {
      availability: 'available' as const,
      visibleProof: 'visible-local-upload-control-enabled',
      reason: null,
    }
  }
  const trigger = await firstEnabledLocator(page, provider.fileUploadTriggerSelectors)
  if (trigger) {
    return {
      availability: 'available' as const,
      visibleProof: 'visible-upload-trigger-enabled',
      reason: null,
    }
  }
  const input = await firstFileInputLocator(page, provider)
  if (input && await fileInputAcceptsUserFiles(input)) {
    return {
      availability: 'unknown' as const,
      visibleProof: 'hidden-file-input-present-without-visible-upload-control',
      reason: 'hidden_file_input_is_not_visible_availability_evidence',
    }
  }
  return {
    availability: 'unknown' as const,
    visibleProof: 'no-visible-upload-control',
    reason: 'visible_upload_control_not_observed',
  }
}

async function ensureWorkspace(page: Page, provider: ProviderConfig, payload: Record<string, unknown>) {
  const name = payload.name
  const mode = payload.mode
  if (typeof name !== 'string' || (mode !== 'auto' && mode !== 'conversation')) {
    throw new Error('Validated request payload unexpectedly lacked workspace fields.')
  }
  const composer = await firstLocator(page, provider.composerSelectors)
  if (!composer) {
    throw tokenlessError(
      'workspace_conversation_unavailable',
      'No visible conversation composer is available for workspace fallback.',
      { retryable: true },
    )
  }
  const requestedMode = mode === 'auto' ? 'auto' as const : 'conversation' as const
  return {
    mode: 'conversation' as const,
    requestedMode,
    name,
    resource: {
      kind: 'conversation' as const,
      native: false as const,
    },
    availability: 'available' as const,
    visibleProof: 'conversation-composer-visible',
    reason: mode === 'auto' ? 'auto_fell_back_to_conversation' : null,
    fallback: mode === 'auto'
      ? {
          mode: 'conversation' as const,
          resourceKind: 'conversation' as const,
          availability: 'available' as const,
        }
      : null,
  }
}

function inspectNavigation(page: Page, provider: ProviderConfig) {
  const currentProvider = getProviderForUrl(page.url())
  if (!currentProvider) {
    return {
      allowed: false,
      provider: null,
      reason: 'unsupported_provider_navigation',
    }
  }
  const policy = assertProviderUrlAllowed(provider, page.url())
  return {
    allowed: policy.ok,
    provider: currentProvider.id,
    reason: policy.ok ? null : policy.reason,
  }
}

export async function inspectVisibleBlockers(page: Page, provider: ProviderConfig) {
  const blockers = await detectStructuredBlockers(page, provider)
  const reasons = blockers.map((blocker) => blocker.code)
  return {
    blocked: blockers.length > 0,
    reasons,
    blockers,
  }
}

async function detectStructuredBlockers(page: Page, provider: ProviderConfig): Promise<VisibleBlocker[]> {
  const url = page.url()
  const currentUrl = safeUrl(url)
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
      raw.push({ kind: 'challenge', code: 'visible_cloudflare_turnstile', family: 'cloudflare', message: 'Visible Cloudflare Turnstile verification is blocking the provider page.', proof: 'visible-turnstile-widget' })
    }
    if (/(checking if the site connection is secure|verify you are human|cloudflare ray id|needs to review the security of your connection)/i.test(text)) {
      raw.push({ kind: 'challenge', code: 'visible_cloudflare_interstitial', family: 'cloudflare', message: 'Visible Cloudflare interstitial is blocking the provider page.', proof: 'visible-cloudflare-interstitial-text' })
    }
    if (visibleInputs.some((element) => /log in|sign in|continue with|enter your email|email address/i.test([
      ownText(element),
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
    ].filter(Boolean).join(' ')))) {
      raw.push({ kind: 'auth', code: 'provider_sign_in_visible', family: 'provider_sign_in', message: 'Provider sign-in is visible and requires the user.', proof: 'visible-provider-sign-in-control' })
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
    if (await firstVisibleFast(page, selector)) {
      selectorBlockers.push(blocker({
        provider,
        url,
        kind: 'auth',
        code: 'provider_sign_in_visible',
        family: 'provider_sign_in',
        message: 'Provider sign-in is visible and requires the user.',
        visibleProof: `visible-login-selector:${selectorReason(selector)}`,
      }))
      break
    }
  }
  for (const selector of provider.blockerSelectors) {
    if (!await firstVisibleFast(page, selector)) continue
    const reason = selectorReason(selector)
    const terminal = /rate|upgrade|plan|too many requests/i.test(selector)
    selectorBlockers.push(blocker({
      provider,
      url,
      kind: terminal ? 'terminal' : 'challenge',
      code: terminal ? (/upgrade|plan/i.test(selector) ? 'provider_plan_limited' : 'provider_rate_limited') : 'visible_provider_blocker',
      family: terminal ? (/upgrade|plan/i.test(selector) ? 'plan_limit' : 'rate_limit') : undefined,
      message: terminal
        ? 'The provider is showing a visible terminal account or capacity blocker.'
        : 'A visible provider challenge or blocker is present.',
      visibleProof: `visible-selector:${reason}`,
    }))
  }
  if (currentUrl && isProviderSignInUrl(currentUrl)) {
    selectorBlockers.push(blocker({
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
    ...domBlockers.map((raw) => blocker({
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

function blocker(input: {
  provider: ProviderConfig
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
    url: sanitizeBlockerUrl(input.url),
    ...(input.family ? { family: input.family } : {}),
  }
}

async function inspectChoices(page: Page, provider: ProviderConfig, kind: 'model' | 'effort') {
  const selectors = kind === 'model' ? provider.modelControlSelectors : provider.effortControlSelectors
  if (selectors.length === 0) {
    return {
      supported: false as const,
      reason: 'unsupported_by_provider' as const,
    }
  }
  const trigger = await firstLocator(page, selectors)
  if (!trigger) {
    return {
      supported: false as const,
      reason: 'selector_not_available' as const,
    }
  }
  await trigger.click({ timeout: 5000 })
  const choices = await collectVisibleChoices(page, provider)
  return {
    supported: true as const,
    choices,
  }
}

async function selectChoice(page: Page, provider: ProviderConfig, kind: 'model' | 'effort', label: unknown) {
  if (typeof label !== 'string') {
    throw new Error('Validated request payload unexpectedly lacked a label.')
  }
  const inspection = await inspectChoices(page, provider, kind)
  if (!inspection.supported) return inspection
  const choice = inspection.choices.find((candidate) => candidate.label === label && candidate.enabled)
  if (!choice) {
    return {
      supported: true as const,
      selectedLabel: '',
      visibleProof: 'exact-label-not-found',
    }
  }
  await page.getByText(label, { exact: true }).click({ timeout: 5000 })
  return {
    supported: true as const,
    selectedLabel: label,
    visibleProof: 'exact-label-selected',
  }
}

async function uploadFiles(page: Page, provider: ProviderConfig, value: unknown, context: VisibleAdapterContext) {
  if (!Array.isArray(value)) throw new Error('Validated request payload unexpectedly lacked attachments.')
  const attachments = value.map((attachment) => validateAttachmentInput(attachment))
  const files = await Promise.all(attachments.map((attachment) => resolveAttachmentPayload(context.attachmentRoot, attachment)))
  const visibleEvidenceBeforeUpload = await visibleAttachmentEvidence(page, attachments)
  let fileInput = await firstFileInputLocator(page, provider)
  let selectedProof = 'hidden-file-input-filelist-selected'
  if (!fileInput) {
    const chooser = await openProviderFileChooser(page, provider)
    if (chooser) {
      await chooser.setFiles(files)
      selectedProof = 'file-chooser-selected'
    } else {
      fileInput = await firstFileInputLocator(page, provider)
    }
  }
  if (!fileInput && selectedProof !== 'file-chooser-selected') {
    throw new Error('No visible provider file input is available.')
  }
  if (fileInput) {
    await fileInput.setInputFiles(files)
    selectedProof = await fileInputContainsNames(fileInput, attachments)
      ? 'hidden-file-input-filelist-selected'
      : 'set-input-files-completed'
  }
  const acceptedProof = await waitForVisibleAttachmentProof(page, attachments, visibleEvidenceBeforeUpload, context.signal)
  const accepted = acceptedProof !== null
  return {
    acceptance: accepted ? 'accepted' as const : 'selected' as const,
    visibleProof: acceptedProof ?? selectedProof,
    attachments: attachments.map((attachment) => ({
      protocol: VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
      bundleId: attachment.bundleId,
      attachmentId: attachment.attachmentId,
      name: basename(attachment.name),
      type: attachment.type,
      size: attachment.size,
      sha256: attachment.sha256,
      visible: true as const,
    })),
  }
}

async function inputPrompt(page: Page, provider: ProviderConfig, text: unknown) {
  if (typeof text !== 'string') throw new Error('Validated request payload unexpectedly lacked prompt text.')
  const composer = await waitForVisibleLocator(page, provider.composerSelectors, PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS)
  if (!composer) {
    throw tokenlessError(
      'prompt_input_visibility_timeout',
      `Timed out after ${PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS}ms waiting for a visible prompt input.`,
      { retryable: true },
    )
  }
  if (!await writePrompt(page, composer, text)) {
    throw tokenlessError(
      'prompt_input_failed',
      'The visible prompt input remained empty after input.',
      { retryable: true },
    )
  }
  return {
    visible: true as const,
    inputProof: 'prompt-text-visible',
  }
}

async function clearPrompt(page: Page, provider: ProviderConfig) {
  await inputPrompt(page, provider, '')
  return {
    visible: true as const,
    inputProof: 'empty' as const,
  }
}

async function submitPrompt(page: Page, provider: ProviderConfig) {
  const button = await waitForVisibleLocator(page, provider.submitSelectors, PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS)
  if (!button) {
    throw tokenlessError(
      'prompt_submit_visibility_timeout',
      `Timed out after ${PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS}ms waiting for a visible prompt submit control.`,
      { retryable: true },
    )
  }
  try {
    await button.click({ timeout: 5000 })
  } catch (error) {
    throw tokenlessError(
      'prompt_submit_failed',
      'The visible prompt submit control could not be clicked.',
      { retryable: true, cause: error },
    )
  }
  return {
    visible: true as const,
    submissionProof: 'visible-submit-clicked',
  }
}

async function readResponse(page: Page, provider: ProviderConfig) {
  const answer = await latestLocator(page, provider.answerSelectors)
  if (!answer) {
    return {
      text: '',
      citations: [],
      visibleProof: 'no-visible-answer',
    }
  }
  const text = sanitizeVisibleText(await answer.innerText({ timeout: 5000 }))
  const citations = await answer.locator('a[href]').evaluateAll((anchors) => anchors.slice(0, 24).map((anchor) => ({
    label: (anchor.textContent ?? '').trim().slice(0, 120),
    href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
  })).filter((entry) => entry.href.startsWith('https://'))) as VisibleCitation[]
  return {
    text,
    citations,
    visibleProof: 'visible-answer-read',
  }
}

async function sanitizedSnapshot(page: Page) {
  return await page.evaluate(() => {
    const allowedRoles = new Set(['button', 'textbox', 'menuitem', 'option', 'combobox', 'listbox'])
    const allowedInputTypes = new Set(['button', 'checkbox', 'email', 'file', 'number', 'password', 'radio', 'search', 'submit', 'tel', 'text', 'url'])
    const controls = Array.from(document.querySelectorAll('button, [role="button"], input, textarea, select, [role="textbox"], [role="menuitem"], [role="option"]'))
      .slice(0, 80)
      .map((element) => {
        const tag = element.tagName.toLowerCase()
        const rawRole = (element.getAttribute('role') ?? '').toLowerCase()
        const role = allowedRoles.has(rawRole) ? rawRole : undefined
        const rawInputType = tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : ''
        const inputType = allowedInputTypes.has(rawInputType) ? rawInputType : undefined
        return {
          tag: ['button', 'input', 'textarea', 'select'].includes(tag) ? tag : 'control',
          ...(role ? { role } : {}),
          ...(inputType ? { inputType } : {}),
          disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
          visible: !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
        }
      })
    return {
      page: {
        origin: location.origin,
      },
      controls,
    }
  })
}

async function resolveAttachmentPayload(attachmentRoot: string | undefined, attachment: AttachmentInput) {
  try {
    return await resolveAttachmentPayloadUnsafe(attachmentRoot, attachment)
  } catch (error) {
    if (error instanceof TokenlessPlaywrightError) throw error
    throw tokenlessError(
      'invalid_visible_attachment',
      'Attachment file cannot be resolved or verified.',
      { cause: error }
    )
  }
}

async function openProviderFileChooser(page: Page, provider: ProviderConfig): Promise<FileChooser | null> {
  const trigger = await firstEnabledLocator(page, provider.fileUploadTriggerSelectors)
  if (trigger) {
    const expanded = await trigger.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') {
      await trigger.click({ timeout: 2000 }).catch(() => undefined)
    }
  }
  const localUpload = await firstEnabledLocator(page, provider.fileUploadLocalSelectors)
  if (!localUpload) return null

  const waitForEvent = (page as Page & {
    waitForEvent?: (event: 'filechooser', options?: { timeout?: number }) => Promise<FileChooser>
  }).waitForEvent
  if (typeof waitForEvent !== 'function') {
    await localUpload.click({ timeout: 2000 }).catch(() => undefined)
    return null
  }
  const chooser = waitForEvent.call(page, 'filechooser', { timeout: 1000 }).catch(() => null)
  await localUpload.click({ timeout: 2000 }).catch(() => undefined)
  return await chooser
}

async function fileInputContainsNames(fileInput: Locator, attachments: readonly AttachmentInput[]) {
  const expected = attachments.map((attachment) => basename(attachment.name)).sort()
  const actual = await fileInput.evaluate((element) => {
    if (!(element instanceof HTMLInputElement) || !element.files) return []
    return Array.from(element.files).map((file) => file.name).sort()
  }).catch(() => [])
  return expected.length === actual.length && expected.every((name, index) => name === actual[index])
}

async function visibleAttachmentEvidence(page: Page, attachments: readonly AttachmentInput[]) {
  const evaluate = (page as Page & {
    evaluate?: (callback: (expectedNames: string[]) => string[], expectedNames: string[]) => Promise<unknown>
  }).evaluate
  if (typeof evaluate !== 'function') return new Set<string>()
  const names = attachments.map((attachment) => basename(attachment.name))
  const result = await evaluate.call(page, (expectedNames) => {
    const isVisibleElement = (element: Element | null): element is HTMLElement | SVGElement => {
      if (!element || !(element instanceof HTMLElement || element instanceof SVGElement)) return false
      let node: Element | null = element
      while (node && node instanceof Element) {
        const style = window.getComputedStyle(node)
        if (
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.display === 'none' ||
          Number(style.opacity) === 0
        ) return false
        node = node.parentElement
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const selectors = [
      '[data-testid*="attachment" i]',
      '[data-testid*="upload" i]',
      '[data-testid*="file" i]',
      '[aria-label*="attachment" i]',
      '[aria-label*="upload" i]',
      '[aria-label*="file" i]',
      '[title]',
      '[role="listitem"]',
      '[role="status"]',
      'li',
    ]
    const elements = selectors.flatMap((selector) => {
      try {
        return Array.from(document.querySelectorAll(selector))
      } catch {
        return []
      }
    })
    const seen = new Set<Element>()
    return elements
      .filter((element) => {
        if (seen.has(element) || !isVisibleElement(element)) return false
        seen.add(element)
        return true
      })
      .slice(0, 200)
      .flatMap((element) => {
        const visibleText = [
          element.textContent ?? '',
          element.getAttribute('aria-label') ?? '',
          element.getAttribute('title') ?? '',
        ].join(' ').replace(/\s+/g, ' ').trim()
        if (!expectedNames.every((name) => visibleText.includes(name))) return []
        const tag = element.tagName.toLowerCase()
        const role = element.getAttribute('role') ?? ''
        const testId = element.getAttribute('data-testid') ?? ''
        return [`${tag}|${role}|${testId}|${visibleText.slice(0, 240)}`]
      })
  }, names).catch(() => [])
  return new Set(Array.isArray(result) ? result.filter((entry): entry is string => typeof entry === 'string') : [])
}

async function visibleAttachmentProof(
  page: Page,
  attachments: readonly AttachmentInput[],
  evidenceBeforeUpload: ReadonlySet<string>,
) {
  const evidence = await visibleAttachmentEvidence(page, attachments)
  for (const entry of evidence) {
    if (!evidenceBeforeUpload.has(entry)) return 'visible-attachment-filename'
  }
  return null
}

async function waitForVisibleAttachmentProof(
  page: Page,
  attachments: readonly AttachmentInput[],
  evidenceBeforeUpload: ReadonlySet<string>,
  signal: AbortSignal | undefined,
) {
  for (let attempt = 0; attempt <= 25; attempt += 1) {
    assertNotAborted(signal)
    const proof = await visibleAttachmentProof(page, attachments, evidenceBeforeUpload)
    if (proof) return proof
    if (attempt < 25) await waitForPageTimeout(page, 200)
  }
  return null
}

async function waitForPageTimeout(page: Page, ms: number) {
  const waitForTimeout = (page as Page & { waitForTimeout?: (timeout: number) => Promise<void> }).waitForTimeout
  if (typeof waitForTimeout === 'function') {
    await waitForTimeout.call(page, ms).catch(() => undefined)
  }
}

async function resolveAttachmentPayloadUnsafe(attachmentRoot: string | undefined, attachment: AttachmentInput) {
  if (attachmentRoot === undefined) {
    throw tokenlessError('invalid_visible_attachment_root', 'Attachment root is required for visible file uploads.')
  }
  if (attachmentRoot.includes('\u0000')) {
    throw tokenlessError('invalid_visible_attachment_root', 'Attachment root is invalid.')
  }
  const root = await realpath(resolve(attachmentRoot))
  const file = resolve(root, attachment.bundleId, `${attachment.attachmentId}.bin`)
  if (!isPathInside(root, file)) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment path escapes the attachment root.')
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const linked = await lstat(file)
    if (linked.isSymbolicLink() || !linked.isFile()) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file must be a regular non-symlink file.')
    }
    if (Number(linked.nlink) !== 1) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file must not have hard links.')
    }
    handle = await open(file, fsConstants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file changed while it was opened.')
    }
    if (Number(opened.nlink) !== 1) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file must not have hard links.')
    }
    if (opened.size !== attachment.size) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file size does not match its descriptor.')
    }
    const realFile = await realpath(file)
    if (!isPathInside(root, realFile)) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment path escapes the attachment root.')
    }
    const buffer = await handle.readFile()
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== attachment.sha256) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file digest does not match its descriptor.')
    }
    return {
      name: basename(attachment.name),
      mimeType: attachment.type,
      buffer,
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isPathInside(root: string, candidate: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

async function collectVisibleChoices(page: Page, provider: ProviderConfig): Promise<Choice[]> {
  const locators = [
    page.locator('[role="menuitem"], [role="option"], [cmdk-item], button'),
  ]
  const choices: Choice[] = []
  for (const locator of locators) {
    const values = await locator.evaluateAll((elements, providerId) => elements.slice(0, 80).map((element) => {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      const ariaSelected = element.getAttribute('aria-selected') === 'true' || element.getAttribute('data-state') === 'checked'
      const dataDisabled = element.getAttribute('data-disabled')
      const classTokens = new Set((element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
      const style = element instanceof HTMLElement ? window.getComputedStyle(element) : null
      const grokVisuallyUnavailable = (
        providerId === 'grok' &&
        (
          classTokens.has('cursor-not-allowed') ||
          (
            classTokens.has('text-secondary') &&
            (classTokens.has('opacity-75') || (style !== null && Number(style.opacity) < 1))
          )
        )
      )
      const disabled = (
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true' ||
        (dataDisabled !== null && dataDisabled !== 'false') ||
        grokVisuallyUnavailable
      )
      return {
        label: text.slice(0, 120),
        selected: ariaSelected,
        enabled: !disabled,
      }
    }).filter((entry) => entry.label.length > 0), provider.id)
    choices.push(...values)
  }
  const seen = new Set<string>()
  return choices.filter((choice) => {
    if (seen.has(choice.label)) return false
    seen.add(choice.label)
    return true
  })
}

async function anyVisible(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    if (await firstVisible(page, selector)) return true
  }
  return false
}

async function firstVisible(page: Page, selector: string) {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 500 })
  } catch {
    return false
  }
}

async function firstVisibleFast(page: Page, selector: string) {
  try {
    return await page.locator(selector).evaluateAll((elements) => elements.some((element) => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false
      let node: Element | null = element
      while (node && node instanceof Element) {
        const style = window.getComputedStyle(node)
        if (
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.display === 'none' ||
          Number(style.opacity) === 0
        ) return false
        node = node.parentElement
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }))
  } catch {
    return false
  }
}

async function firstFileInputLocator(page: Page, provider: ProviderConfig): Promise<Locator | null> {
  for (const selector of provider.fileInputSelectors) {
    const locator = page.locator(selector).first()
    try {
      const count = typeof (locator as Locator & { count?: unknown }).count === 'function'
        ? await locator.count()
        : (await locator.isVisible({ timeout: 250 }) ? 1 : 0)
      if (count > 0 && await fileInputAcceptsUserFiles(locator)) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

async function fileInputAcceptsUserFiles(locator: Locator) {
  return await locator.evaluate((element) => (
    element instanceof HTMLInputElement &&
    element.type === 'file' &&
    !element.disabled &&
    element.getAttribute('aria-disabled') !== 'true'
  )).catch(() => true)
}

async function firstEnabledLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true }).first()
    try {
      if (await locator.isVisible({ timeout: 500 }) && !await locatorIsUnavailable(locator)) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

async function firstUnavailableLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true }).first()
    try {
      if (await locator.isVisible({ timeout: 500 }) && await locatorIsUnavailable(locator)) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

async function locatorIsUnavailable(locator: Locator) {
  return await locator.evaluate((element) => {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').toLowerCase()
    const aria = (element.getAttribute('aria-label') ?? '').toLowerCase()
    const dataDisabled = element.getAttribute('data-disabled')
    return element.hasAttribute('disabled') ||
      element.getAttribute('aria-disabled') === 'true' ||
      (dataDisabled !== null && dataDisabled !== 'false') ||
      /upgrade|subscribe|requires paid|plan limit/.test(`${text} ${aria}`)
  }).catch(() => false)
}

async function firstLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true }).first()
    try {
      if (await locator.isVisible({ timeout: 1000 })) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

async function waitForVisibleLocator(page: Page, selectors: readonly string[], timeoutMs: number): Promise<Locator | null> {
  if (selectors.length === 0) return null
  const locator = page.locator(selectors.join(', ')).filter({ visible: true }).first()
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs })
    return await firstLocator(page, selectors)
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return null
    throw error
  }
}

async function latestLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector)
    try {
      const count = await locator.count()
      if (count > 0) return locator.nth(count - 1)
    } catch {
      // Try the next selector.
    }
  }
  return null
}

async function composerHasExpectedPresence(locator: Locator, expectEmpty: boolean) {
  try {
    return await locator.evaluate((element, shouldBeEmpty) => {
      const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : (element.textContent ?? '')
      const hasVisibleText = text.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/gu, '').length > 0
      return shouldBeEmpty ? !hasVisibleText : hasVisibleText
    }, expectEmpty)
  } catch {
    return false
  }
}

async function writePrompt(page: Page, composer: Locator, text: string) {
  const expectEmpty = text.length === 0
  try {
    await composer.fill(text, { timeout: 2000 })
    if (await composerHasExpectedPresence(composer, expectEmpty)) return true
  } catch {
    // Hydration can replace a visible fallback composer while it is being filled.
  }
  try {
    if (!await composer.isVisible({ timeout: 250 })) return false
    await composer.click({ timeout: 1000 })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.type(text)
    return await composerHasExpectedPresence(composer, expectEmpty)
  } catch {
    return false
  }
}

function sanitizeVisibleText(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 32_000)
}

function selectorReason(selector: string) {
  if (/captcha/i.test(selector)) return 'captcha'
  if (/rate limit|too many/i.test(selector)) return 'rate_limit'
  if (/upgrade|paywall|subscribe/i.test(selector)) return 'upgrade_or_paywall'
  return 'visible_blocker'
}

function safeUrl(value: string) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isProviderSignInUrl(url: URL) {
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  return host === 'accounts.google.com' ||
    host === 'auth.openai.com' ||
    host === 'auth0.openai.com' ||
    host === 'login.openai.com' ||
    path.includes('/auth/login') ||
    path.includes('/login') ||
    path.includes('/signin') ||
    path.includes('/sign-in')
}

function sanitizeBlockerUrl(value: string) {
  try {
    const url = new URL(value)
    return url.origin
  } catch {
    return ''
  }
}

function success(request: VisibleActionRequest, result: VisibleActionResult): VisibleActionResponse {
  return {
    protocol: request.protocol,
    requestId: request.requestId,
    provider: request.provider,
    action: request.action,
    ok: true,
    result,
    error: null,
  }
}

function failure(request: VisibleActionRequest, code: string, message: string, retryable: boolean): VisibleActionResponse {
  return {
    protocol: request.protocol,
    requestId: request.requestId,
    provider: request.provider,
    action: request.action,
    ok: false,
    result: null,
    error: {
      code,
      message,
      retryable,
    },
  }
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Visible provider action was aborted.')
}
