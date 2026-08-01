import { VISIBLE_ACTIONS, validateProviderActionPreparation } from '../contracts.js'
import { countVisibleLocators, latestLocator } from '../dom-locators.js'
import { createHash } from 'node:crypto'
import type { Page } from 'playwright-core'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderActionObservation, ProviderActionPreparation } from '../contracts.js'
import type { VisibleCitation } from '../../playwright/actions.js'

export const RESPONSE_CURSOR_SCHEMA = 'tokenless.provider.response-cursor.v2'

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
  const hasNewAnswer = (
    observation.answerCount > baseline.answerCount &&
    observation.latestAnswerFingerprint !== null
  ) ||
    (
      baseline.latestAnswerFingerprint !== null &&
      observation.latestAnswerFingerprint !== null &&
      observation.latestAnswerFingerprint !== baseline.latestAnswerFingerprint
    )
  return {
    state: hasNewAnswer && !observation.busy ? 'ready' as const : 'pending' as const,
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

function sanitizeVisibleText(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 32_000)
}

function validateBaseline(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Response cursor baseline is invalid.')
  }
  return value
}

function fingerprintAnswer(text: string) {
  const normalized = sanitizeVisibleText(text)
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
