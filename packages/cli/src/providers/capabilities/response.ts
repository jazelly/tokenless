import { VISIBLE_ACTIONS, validateProviderActionPreparation } from '../contracts.js'
import { countVisibleLocators, latestLocator } from '../dom-locators.js'
import { tokenlessError } from '../../playwright/errors.js'
import { createHash } from 'node:crypto'
import type { Page } from 'playwright-core'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderActionObservation, ProviderActionPreparation } from '../contracts.js'
import type { ResponseDecisionDiagnostics, ResponseDecisionElement, VisibleCitation } from '../../playwright/actions.js'
import type { CaptureVisibleOutput } from '../../output-savings/index.js'

export const RESPONSE_CURSOR_SCHEMA = 'tokenless.provider.response-cursor.v2'
const RESPONSE_CONFIRMATION_WINDOW_MS = 3_000

const GENERATION_STOP_SELECTOR = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop generating" i]',
  'button[aria-label="Stop response" i]',
  'button[aria-label="Cancel generation" i]',
  '[role="button"][aria-label="Stop generating" i]',
  '[role="button"][aria-label="Cancel generation" i]',
].join(', ')

export type ResponseCursorObservation = {
  answerCount: number
  latestAnswerFingerprint: string | null
  busy: boolean
}

export async function prepareDomResponseCursor(provider: ProviderDomDefinition, page: Page): Promise<ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ>> {
  const observation = await observeDomResponseCursor(provider, page)
  return createResponsePreparation(provider, observation.answerCount, observation.latestAnswerFingerprint)
}

export function legacyDomResponsePreparationFromBaseline(
  provider: ProviderDomDefinition,
  baseline: number,
): ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ> {
  return createResponsePreparation(provider, validateBaseline(baseline), null)
}

export async function observeDomResponseCursor(provider: ProviderDomDefinition, page: Page): Promise<ResponseCursorObservation> {
  const latestAnswer = await latestLocator(page, provider.answerSelectors)
  return {
    answerCount: await countVisibleLocators(page, provider.answerSelectors),
    latestAnswerFingerprint: latestAnswer
      ? fingerprintAnswer(await latestAnswer.innerText({ timeout: 1000 }).catch(() => ''))
      : null,
    busy: await countVisibleLocators(page, provider.busySelectors) > 0,
  }
}

export async function observeDomResponseAction(
  provider: ProviderDomDefinition,
  page: Page,
  preparation: ProviderActionPreparation,
): Promise<ProviderActionObservation> {
  const baseline = validateDomResponsePreparation(provider, preparation)
  const observation = await observeDomResponseCursor(provider, page)
  if (!isReadyResponseObservation(observation, baseline)) return { state: 'pending' as const }
  await page.waitForTimeout(RESPONSE_CONFIRMATION_WINDOW_MS)
  const confirmation = await observeDomResponseCursor(provider, page)
  return {
    state: isReadyResponseObservation(confirmation, baseline) &&
      confirmation.answerCount === observation.answerCount &&
      confirmation.latestAnswerFingerprint === observation.latestAnswerFingerprint
      ? 'ready' as const
      : 'pending' as const,
  }
}

export async function observeDomResponseCompletion(provider: ProviderDomDefinition, page: Page, baseline: number) {
  return (await observeDomResponseAction(provider, page, legacyDomResponsePreparationFromBaseline(provider, baseline))).state === 'ready'
}

export function validateDomResponsePreparation(provider: ProviderDomDefinition, preparation: unknown) {
  const validated = validateProviderActionPreparation(preparation, {
    provider: provider.id,
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    schema: RESPONSE_CURSOR_SCHEMA,
  })
  if (!isPlainRecord(validated.value) || !hasExactKeys(validated.value, ['answerCount', 'latestAnswerFingerprint'])) {
    throw new Error('Response cursor value is invalid.')
  }
  return {
    answerCount: validateBaseline(validated.value.answerCount),
    latestAnswerFingerprint: validateFingerprint(validated.value.latestAnswerFingerprint),
  }
}

export async function readDomResponse(
  provider: ProviderDomDefinition,
  page: Page,
  captureVisibleOutput?: CaptureVisibleOutput,
) {
  const answer = await latestLocator(page, provider.answerSelectors)
  const observations = responseDecisionObservations(page, provider)
  if (!answer) {
    throw tokenlessError(
      'response_not_visible',
      'No provider answer is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-answer', ...await observations } },
    )
  }
  const response = await answer.evaluate((element, answerTextExcludeSelectors) => {
    const visibleTextExcluding = (root: HTMLElement, excludeSelectors: readonly string[]) => {
      if (excludeSelectors.length === 0) return root.innerText
      const excluded = [...new Set(excludeSelectors.flatMap((selector) => (
        [...root.querySelectorAll(selector)].filter((node): node is HTMLElement => node instanceof HTMLElement)
      )))]
      const styles = excluded.map((node) => node.getAttribute('style'))
      try {
        excluded.forEach((node) => node.style.setProperty('display', 'none', 'important'))
        return root.innerText
      } finally {
        excluded.forEach((node, index) => {
          const style = styles[index] ?? null
          if (style === null) {
            node.style.removeProperty('display')
            const styleAttribute = node.getAttributeNode('style')
            if (styleAttribute) node.removeAttributeNode(styleAttribute)
          } else {
            node.setAttribute('style', style)
          }
        })
      }
    }
    const text = element instanceof HTMLElement
      ? visibleTextExcluding(element, answerTextExcludeSelectors)
      : ''
    try {
      const tags = new Set<ResponseDecisionElement['tag']>(['article', 'blockquote', 'button', 'code', 'div', 'element', 'li', 'main', 'ol', 'p', 'pre', 'section', 'span', 'ul'])
      const roles = new Set<NonNullable<ResponseDecisionElement['role']>>(['button', 'textbox', 'menuitem', 'option', 'combobox', 'listbox'])
      const live = new Set<NonNullable<ResponseDecisionElement['ariaLive']>>(['assertive', 'off', 'polite'])
      const states = new Set<NonNullable<ResponseDecisionElement['dataState']>>(['active', 'closed', 'complete', 'idle', 'inactive', 'loading', 'open', 'pending'])
      const booleans = new Set<NonNullable<ResponseDecisionElement['ariaBusy']>>(['true', 'false'])
      const describe = (node: Element): ResponseDecisionElement => {
        const tag = node.tagName.toLowerCase()
        const role = (node.getAttribute('role') ?? '').toLowerCase()
        const enumAttribute = <T extends string>(name: string, values: Set<T>) => {
          const value = (node.getAttribute(name) ?? '').toLowerCase()
          return values.has(value as T) ? value as T : undefined
        }
        const ariaBusy = enumAttribute('aria-busy', booleans)
        const ariaLive = enumAttribute('aria-live', live)
        const dataIsStreaming = enumAttribute('data-is-streaming', booleans)
        const dataState = enumAttribute('data-state', states)
        return {
          tag: tags.has(tag as ResponseDecisionElement['tag']) ? tag as ResponseDecisionElement['tag'] : 'element',
          ...(roles.has(role as NonNullable<ResponseDecisionElement['role']>) ? { role: role as NonNullable<ResponseDecisionElement['role']> } : {}),
          ...(ariaBusy ? { ariaBusy } : {}),
          ...(ariaLive ? { ariaLive } : {}),
          ...(dataIsStreaming ? { dataIsStreaming } : {}),
          ...(dataState ? { dataState } : {}),
        }
      }
      const ancestors: ResponseDecisionElement[] = []
      for (let parent = element.parentElement; parent && ancestors.length < 3; parent = parent.parentElement) ancestors.push(describe(parent))
      return { text, selected: { ...describe(element), ancestors } }
    } catch {
      return { text, selected: null }
    }
  }, provider.answerTextExcludeSelectors ?? [], { timeout: 5000 })
  const completeText = normalizeVisibleText(response.text)
  captureVisibleOutput?.(completeText)
  const text = boundVisibleText(completeText)
  const citations = await answer.locator('a[href]').evaluateAll((anchors) => anchors.slice(0, 24).map((anchor) => ({
    label: (anchor.textContent ?? '').trim().slice(0, 120),
    href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
  })).filter((entry) => entry.href.startsWith('https://'))) as VisibleCitation[]
  return {
    text,
    citations,
    visibleProof: 'visible-answer-read',
    decisionDiagnostics: { selected: response.selected, ...await observations },
  }
}

async function responseDecisionObservations(
  page: Page,
  provider: ProviderDomDefinition,
): Promise<Omit<ResponseDecisionDiagnostics, 'selected'>> {
  const [visibleAnswerCount, visibleBusyCount, generationStopVisible] = await Promise.all([
    countVisibleLocators(page, provider.answerSelectors).catch(() => 0),
    countVisibleLocators(page, provider.busySelectors).catch(() => 0),
    page.locator(GENERATION_STOP_SELECTOR).filter({ visible: true }).first().isVisible({ timeout: 100 }).catch(() => false),
  ])
  return { visibleAnswerCount, visibleBusyCount, generationStopVisible }
}

function createResponsePreparation(
  provider: ProviderDomDefinition,
  answerCount: number,
  latestAnswerFingerprint: string | null,
): ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ> {
  return Object.freeze({
    provider: provider.id,
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    schema: RESPONSE_CURSOR_SCHEMA,
    value: Object.freeze({
      answerCount: validateBaseline(answerCount),
      latestAnswerFingerprint: validateFingerprint(latestAnswerFingerprint),
    }),
  })
}

function isReadyResponseObservation(
  observation: ResponseCursorObservation,
  baseline: { answerCount: number, latestAnswerFingerprint: string | null },
) {
  const hasNewAnswer = (
    observation.answerCount > baseline.answerCount &&
    observation.latestAnswerFingerprint !== null
  ) ||
    (
      baseline.latestAnswerFingerprint !== null &&
      observation.latestAnswerFingerprint !== null &&
      observation.latestAnswerFingerprint !== baseline.latestAnswerFingerprint
    )
  return hasNewAnswer && !observation.busy
}

function normalizeVisibleText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function boundVisibleText(text: string) {
  return text.slice(0, 32_000)
}

function validateBaseline(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Response cursor baseline is invalid.')
  }
  return value
}

function fingerprintAnswer(text: string) {
  const normalized = boundVisibleText(normalizeVisibleText(text))
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null
}

function validateFingerprint(value: unknown) {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Response cursor fingerprint is invalid.')
  }
  return value
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(input).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}
