import { countVisibleLocators } from '../dom-locators.js'
import { assertProviderUrlAllowed } from '../navigation-policy.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  NavigationCheckResult,
  ProviderCapabilityInspection,
  SnapshotDiagnosticElement,
  SnapshotResponseCandidate,
  SnapshotResponseDiagnostics,
  SnapshotResponseSelectorDiagnostics,
  SnapshotResult,
} from '../../playwright/actions.js'

type DiagnosticsAction = typeof VISIBLE_ACTIONS.NAVIGATION_CHECK | typeof VISIBLE_ACTIONS.SNAPSHOT_SANITIZED

function responseStructureSelectors(selectors: readonly string[]) {
  const dataTestIds = new Set<string>()
  const classTokens = new Set<string>()
  for (const selector of selectors) {
    let quote = ''
    let attributeDepth = 0
    for (let index = 0; index < selector.length; index += 1) {
      const character = selector[index]
      if (quote) {
        if (character === quote && selector[index - 1] !== '\\') quote = ''
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        continue
      }
      if (character === '[') {
        const match = attributeDepth === 0 ? /^\[data-testid="([A-Za-z0-9._:-]{1,80})"\]/.exec(selector.slice(index)) : null
        if (match?.[1]) dataTestIds.add(match[1])
        attributeDepth += 1
        continue
      }
      if (character === ']') {
        attributeDepth = Math.max(0, attributeDepth - 1)
        continue
      }
      if (attributeDepth !== 0 || character !== '.' || selector[index - 1] === '\\') continue
      const match = /^[A-Za-z][A-Za-z0-9_-]{0,31}/.exec(selector.slice(index + 1))
      const next = index + 1 + (match?.[0].length ?? 0)
      if (match && selector[next] !== '\\' && !/[A-Za-z0-9_-]/.test(selector[next] ?? '')) classTokens.add(match[0])
    }
  }
  return { dataTestIds: [...dataTestIds], classTokens: [...classTokens] }
}

export class DiagnosticsCapability implements ProviderActionCapability<DiagnosticsAction> {
  readonly capability = PROVIDER_CAPABILITIES.DIAGNOSTICS
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.NAVIGATION_CHECK,
    VISIBLE_ACTIONS.SNAPSHOT_SANITIZED,
  ])
  private readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
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
  const responseStructure = responseStructureSelectors([...provider.answerSelectors, ...provider.busySelectors])
  const selectorProbes = {
    composer: await countVisibleLocators(page, provider.composerSelectors),
    authenticatedAccount: await countVisibleLocators(page, provider.authIndicators),
    login: await countVisibleLocators(page, provider.loginIndicators),
    blocker: await countVisibleLocators(page, provider.blockerSelectors),
  }
  return await page.evaluate((providerSnapshot) => {
    const allowedRoles = new Set(['button', 'textbox', 'menuitem', 'option', 'combobox', 'listbox'])
    const allowedInputTypes = new Set(['button', 'checkbox', 'email', 'file', 'number', 'password', 'radio', 'search', 'submit', 'tel', 'text', 'url'])
    const allowedTags = new Set<SnapshotDiagnosticElement['tag']>(['article', 'blockquote', 'button', 'code', 'div', 'element', 'li', 'main', 'ol', 'p', 'pre', 'section', 'span', 'ul'])
    const allowedLive = new Set<NonNullable<SnapshotDiagnosticElement['ariaLive']>>(['assertive', 'off', 'polite'])
    const allowedStates = new Set<NonNullable<SnapshotDiagnosticElement['dataState']>>(['active', 'closed', 'complete', 'idle', 'inactive', 'loading', 'open', 'pending'])
    const allowedBoolean = new Set<NonNullable<SnapshotDiagnosticElement['ariaBusy']>>(['true', 'false'])
    const allowedDataTestIds = new Set(providerSnapshot.responseStructure.dataTestIds)
    const allowedClassTokens = new Set(providerSnapshot.responseStructure.classTokens)
    const maxSelectors = 8
    const maxCandidates = 3
    const maxAncestors = 3
    const maxBytes = 64 * 1024
    const operationalText = /^(?:log in|sign in|sign up(?: for free)?|continue(?: with email| as guest| without signing in| without an account| your conversation)?|stay in guest mode|use without an account|accept(?: all)?|i agree|agree|not now|close|dismiss|start chatting|ask anything|send message|enter your email)$/i
    const safeOperationalText = (value: string | null) => {
      const normalized = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      return operationalText.test(normalized) ? normalized : undefined
    }
    const safeDataTestId = (value: string | null) => {
      const normalized = value ?? ''
      return allowedDataTestIds.has(normalized) ? normalized : undefined
    }
    const visible = (element: Element) => {
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hasAttribute('hidden') || ancestor.getAttribute('aria-hidden')?.toLowerCase() === 'true') return false
        const style = getComputedStyle(ancestor)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) <= 0) return false
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0
        && rect.height > 0
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < innerWidth
        && rect.top < innerHeight
    }
    const describe = (element: Element): SnapshotDiagnosticElement => {
      const rawTag = element.tagName.toLowerCase()
      const rawRole = (element.getAttribute('role') ?? '').toLowerCase()
      const tag = allowedTags.has(rawTag as SnapshotDiagnosticElement['tag'])
        ? rawTag as SnapshotDiagnosticElement['tag']
        : 'element'
      const role = allowedRoles.has(rawRole)
        ? rawRole as NonNullable<SnapshotDiagnosticElement['role']>
        : undefined
      const classTokens = Array.from(element.classList)
        .filter((token) => allowedClassTokens.has(token)).slice(0, 6)
      const enumAttribute = <T extends string>(name: string, values: Set<T>) => {
        const value = (element.getAttribute(name) ?? '').toLowerCase()
        return values.has(value as T) ? value as T : undefined
      }
      const dataTestId = safeDataTestId(element.getAttribute('data-testid'))
      const ariaBusy = enumAttribute('aria-busy', allowedBoolean)
      const ariaLive = enumAttribute('aria-live', allowedLive)
      const dataIsStreaming = enumAttribute('data-is-streaming', allowedBoolean)
      const dataState = enumAttribute('data-state', allowedStates)
      return {
        tag,
        ...(role ? { role } : {}),
        ...(dataTestId ? { dataTestId } : {}),
        ...(ariaBusy ? { ariaBusy } : {}),
        ...(ariaLive ? { ariaLive } : {}),
        ...(dataIsStreaming ? { dataIsStreaming } : {}),
        ...(dataState ? { dataState } : {}),
        ...(classTokens.length > 0 ? { classTokens } : {}),
      }
    }
    const ancestors = (element: Element) => {
      const result: SnapshotDiagnosticElement[] = []
      for (let parent = element.parentElement; parent && result.length < maxAncestors; parent = parent.parentElement) result.push(describe(parent))
      return result
    }
    const candidate = (element: Element): SnapshotResponseCandidate => {
      let visibleTextLength = 0
      if (visible(element) && element instanceof HTMLElement) {
        try {
          visibleTextLength = element.innerText.replace(/\s+/g, ' ').trim().length
        } catch {}
      }
      return { ...describe(element), visibleTextLength, ancestors: ancestors(element) }
    }
    const responseDiagnostics = (answerSelectors: readonly string[], busySelectors: readonly string[]): SnapshotResponseDiagnostics => {
      const group = (selectors: readonly string[]) => {
        const groupTruncated = selectors.length > maxSelectors
        return {
          configured: selectors.length,
          truncated: groupTruncated,
          selectors: selectors.slice(0, maxSelectors).map((selector, selectorIndex) => {
            try {
              const matches = Array.from(document.querySelectorAll(selector))
              const candidates = matches.slice(-maxCandidates).map(candidate)
              const selectorTruncated = matches.length > candidates.length
              return { selectorIndex, total: matches.length, visible: matches.filter(visible).length, truncated: selectorTruncated, candidates }
            } catch {
              return { selectorIndex, total: 0, visible: 0, truncated: true, candidates: [] }
            }
          }) satisfies SnapshotResponseSelectorDiagnostics[],
        }
      }
      const answer = group(answerSelectors)
      const busy = group(busySelectors)
      const diagnostics = {
        truncated: answer.truncated || busy.truncated || answer.selectors.some((entry) => entry.truncated) || busy.selectors.some((entry) => entry.truncated),
        answerSelectors: answer,
        busySelectors: busy,
      } satisfies SnapshotResponseDiagnostics
      if (JSON.stringify(diagnostics).length <= maxBytes) return diagnostics
      const withoutCandidates = (entry: SnapshotResponseSelectorDiagnostics) => ({ ...entry, truncated: true, candidates: [] })
      return {
        truncated: true,
        answerSelectors: { ...answer, truncated: true, selectors: answer.selectors.map(withoutCandidates) },
        busySelectors: { ...busy, truncated: true, selectors: busy.selectors.map(withoutCandidates) },
      }
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
      responseDiagnostics: responseDiagnostics(providerSnapshot.answerSelectors, providerSnapshot.busySelectors),
      page: {
        origin: location.origin,
      },
      controls,
    }
  }, {
    id: provider.id,
    label: provider.label,
    selectorProbes,
    answerSelectors: provider.answerSelectors,
    busySelectors: provider.busySelectors,
    responseStructure,
  })
}
