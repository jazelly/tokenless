import { countVisibleLocators } from '../dom-locators.js'
import { assertProviderUrlAllowed } from '../navigation-policy.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { NavigationCheckResult, ProviderCapabilityInspection, SnapshotResult } from '../../playwright/actions.js'

type DiagnosticsAction = typeof VISIBLE_ACTIONS.NAVIGATION_CHECK | typeof VISIBLE_ACTIONS.SNAPSHOT_SANITIZED

export class DiagnosticsCapability implements ProviderActionCapability<DiagnosticsAction> {
  readonly capability = PROVIDER_CAPABILITIES.DIAGNOSTICS
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.NAVIGATION_CHECK,
    VISIBLE_ACTIONS.SNAPSHOT_SANITIZED,
  ])
  private readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
    Object.freeze(this)
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: DiagnosticsAction }>,
    _context: ProviderExecutionContext,
  ): Promise<NavigationCheckResult | SnapshotResult> {
    if (request.action === VISIBLE_ACTIONS.NAVIGATION_CHECK) return inspectNavigation(page, this.provider)
    return await sanitizedSnapshot(page, this.provider)
  }

  async inspect(_page: Page): Promise<ProviderCapabilityInspection> {
    return {
      ...this.provider.capabilities[PROVIDER_CAPABILITIES.DIAGNOSTICS],
      actions: this.actions,
    }
  }
}

async function inspectNavigation(page: Page, provider: ProviderDomDefinition): Promise<NavigationCheckResult> {
  const classification = provider.navigationPolicy.classify(page.url())
  if (classification.kind !== 'approved') {
    return {
      allowed: false,
      provider: null,
      reason: classification.kind === 'rejected'
        ? classification.reason
        : 'unsupported_provider_navigation',
    }
  }
  const policy = assertProviderUrlAllowed(provider, page.url())
  return {
    allowed: policy.ok,
    provider: provider.id,
    reason: policy.ok ? null : policy.reason,
  }
}

async function sanitizedSnapshot(page: Page, provider: ProviderDomDefinition): Promise<SnapshotResult> {
  const selectorProbes = {
    composer: await countVisibleLocators(page, provider.composerSelectors),
    authenticatedAccount: await countVisibleLocators(page, provider.authIndicators),
    login: await countVisibleLocators(page, provider.loginIndicators),
    blocker: await countVisibleLocators(page, provider.blockerSelectors),
  }
  return await page.evaluate((providerSnapshot) => {
    const allowedRoles = new Set(['button', 'textbox', 'menuitem', 'option', 'combobox', 'listbox'])
    const allowedInputTypes = new Set(['button', 'checkbox', 'email', 'file', 'number', 'password', 'radio', 'search', 'submit', 'tel', 'text', 'url'])
    const operationalText = /^(?:log in|sign in|sign up(?: for free)?|continue(?: with email| as guest| without signing in| without an account| your conversation)?|stay in guest mode|use without an account|accept(?: all)?|i agree|agree|not now|close|dismiss|start chatting|ask anything|send message|enter your email)$/i
    const safeOperationalText = (value: string | null) => {
      const normalized = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      return operationalText.test(normalized) ? normalized : undefined
    }
    const controls = Array.from(document.querySelectorAll('button, [role="button"], input, textarea, select, [role="textbox"], [role="menuitem"], [role="option"]'))
      .slice(0, 80)
      .map((element) => {
        const tag = element.tagName.toLowerCase()
        const rawRole = (element.getAttribute('role') ?? '').toLowerCase()
        const role = allowedRoles.has(rawRole) ? rawRole : undefined
        const rawInputType = tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : ''
        const inputType = allowedInputTypes.has(rawInputType) ? rawInputType : undefined
        const dataTestId = (element.getAttribute('data-testid') ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 100) || undefined
        const ariaLabel = safeOperationalText(element.getAttribute('aria-label'))
        const placeholder = safeOperationalText(element.getAttribute('placeholder'))
        const text = safeOperationalText(element.textContent)
        return {
          tag: ['button', 'input', 'textarea', 'select'].includes(tag) ? tag : 'control',
          ...(role ? { role } : {}),
          ...(inputType ? { inputType } : {}),
          ...(dataTestId ? { dataTestId } : {}),
          ...(ariaLabel ? { ariaLabel } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...(text ? { text } : {}),
          disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
          visible: !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
        }
      })
    const escapeAttribute = (value: string) => value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    const html = [
      `<tokenless-sanitized-dom provider="${escapeAttribute(providerSnapshot.id)}">`,
      ...controls.map((control) => {
        const attributes = [
          `tag="${escapeAttribute(control.tag)}"`,
          ...(control.role ? [`role="${escapeAttribute(control.role)}"`] : []),
          ...(control.inputType ? [`input-type="${escapeAttribute(control.inputType)}"`] : []),
          ...(control.dataTestId ? [`data-testid="${escapeAttribute(control.dataTestId)}"`] : []),
          ...(control.ariaLabel ? [`aria-label="${escapeAttribute(control.ariaLabel)}"`] : []),
          ...(control.placeholder ? [`placeholder="${escapeAttribute(control.placeholder)}"`] : []),
          ...(control.text ? [`text="${escapeAttribute(control.text)}"`] : []),
          `disabled="${control.disabled ? 'true' : 'false'}"`,
          `visible="${control.visible ? 'true' : 'false'}"`,
        ]
        return `  <control ${attributes.join(' ')} />`
      }),
      '</tokenless-sanitized-dom>',
    ].join('\n')
    const currentUrl = new URL(location.href)
    return {
      status: 'snapshotted' as const,
      provider: providerSnapshot.id,
      capturedAt: new Date().toISOString(),
      url: currentUrl.origin,
      title: providerSnapshot.label,
      sanitized: true as const,
      includeText: false as const,
      html,
      selectorProbes: providerSnapshot.selectorProbes,
      page: {
        origin: location.origin,
      },
      controls,
    }
  }, {
    id: provider.id,
    label: provider.label,
    selectorProbes,
  })
}
