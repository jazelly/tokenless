import { VISIBLE_ACTIONS, validateProviderActionPreparation } from '../contracts.js'
import { countVisibleLocators, latestLocator } from '../dom-locators.js'
import type { Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderActionObservation, ProviderActionPreparation, VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { VisibleActionResult, VisibleCitation } from '../../playwright/actions.js'

export const RESPONSE_CURSOR_SCHEMA = 'tokenless.provider.response-cursor.v1'

export type ResponseCursorObservation = {
  answerCount: number
  busy: boolean
}

export class ResponseCapability implements ProviderActionCapability<typeof VISIBLE_ACTIONS.RESPONSE_READ> {
  readonly capability = 'response'
  readonly actions = Object.freeze([VISIBLE_ACTIONS.RESPONSE_READ])
  protected readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
    Object.freeze(this)
  }

  async execute(page: Page, _request: Extract<VisibleActionRequest, { action: typeof VISIBLE_ACTIONS.RESPONSE_READ }>, _context: ProviderExecutionContext): Promise<VisibleActionResult> {
    return await this.read(page)
  }

  async prepareCursor(page: Page): Promise<ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ>> {
    return this.createPreparation(await countVisibleLocators(page, this.provider.answerSelectors))
  }

  captureCursor(page: Page) {
    return this.prepareCursor(page)
  }

  async observeCursor(page: Page): Promise<ResponseCursorObservation> {
    return {
      answerCount: await countVisibleLocators(page, this.provider.answerSelectors),
      busy: await countVisibleLocators(page, this.provider.busySelectors) > 0,
    }
  }

  async observeAction(page: Page, preparation: ProviderActionPreparation): Promise<ProviderActionObservation> {
    const baseline = this.validatePreparation(preparation)
    const observation = await this.observeCursor(page)
    return {
      state: observation.answerCount > baseline && !observation.busy ? 'ready' as const : 'pending' as const,
    }
  }

  validatePreparation(preparation: unknown) {
    const validated = validateProviderActionPreparation(preparation, {
      provider: this.provider.id,
      action: VISIBLE_ACTIONS.RESPONSE_READ,
      schema: RESPONSE_CURSOR_SCHEMA,
    })
    if (!isPlainRecord(validated.value) || !hasExactKeys(validated.value, ['answerCount'])) {
      throw new Error('Response cursor value is invalid.')
    }
    return validateBaseline(validated.value.answerCount)
  }

  async read(page: Page) {
    const answer = await latestLocator(page, this.provider.answerSelectors)
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

  private createPreparation(answerCount: number): ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ> {
    return Object.freeze({
      provider: this.provider.id,
      action: VISIBLE_ACTIONS.RESPONSE_READ,
      schema: RESPONSE_CURSOR_SCHEMA,
      value: Object.freeze({
        answerCount: validateBaseline(answerCount),
      }),
    })
  }
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
