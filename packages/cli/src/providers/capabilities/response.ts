import { VISIBLE_ACTIONS, validateProviderActionPreparation } from '../contracts.js'
import { countVisibleLocators, latestLocator } from '../dom-locators.js'
import type { Page } from 'playwright-core'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderActionObservation, ProviderActionPreparation } from '../contracts.js'
import type { VisibleCitation } from '../../playwright/actions.js'

export const RESPONSE_CURSOR_SCHEMA = 'tokenless.provider.response-cursor.v1'

export type ResponseCursorObservation = {
  answerCount: number
  busy: boolean
}

export async function prepareDomResponseCursor(provider: ProviderDomDefinition, page: Page): Promise<ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ>> {
  return createResponsePreparation(provider, await countVisibleLocators(page, provider.answerSelectors))
}

export function legacyDomResponsePreparationFromBaseline(
  provider: ProviderDomDefinition,
  baseline: number,
): ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ> {
  return createResponsePreparation(provider, validateBaseline(baseline))
}

export async function observeDomResponseCursor(provider: ProviderDomDefinition, page: Page): Promise<ResponseCursorObservation> {
  return {
    answerCount: await countVisibleLocators(page, provider.answerSelectors),
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
  return {
    state: observation.answerCount > baseline && !observation.busy ? 'ready' as const : 'pending' as const,
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
  if (!isPlainRecord(validated.value) || !hasExactKeys(validated.value, ['answerCount'])) {
    throw new Error('Response cursor value is invalid.')
  }
  return validateBaseline(validated.value.answerCount)
}

export async function readDomResponse(provider: ProviderDomDefinition, page: Page) {
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

function createResponsePreparation(
  provider: ProviderDomDefinition,
  answerCount: number,
): ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ> {
  return Object.freeze({
    provider: provider.id,
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    schema: RESPONSE_CURSOR_SCHEMA,
    value: Object.freeze({
      answerCount: validateBaseline(answerCount),
    }),
  })
}

function sanitizeVisibleText(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 32_000)
}

function validateBaseline(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Response cursor baseline is invalid.')
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
