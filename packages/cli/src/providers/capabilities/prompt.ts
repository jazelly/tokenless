import { VISIBLE_ACTIONS } from '../contracts.js'
import { tokenlessError } from '../../playwright/errors.js'
import { waitForVisibleLocator } from '../dom-locators.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { VisibleActionResult } from '../../playwright/actions.js'

const PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS = 15_000

type PromptAction =
  | typeof VISIBLE_ACTIONS.PROMPT_INPUT
  | typeof VISIBLE_ACTIONS.PROMPT_CLEAR
  | typeof VISIBLE_ACTIONS.PROMPT_SUBMIT

export class PromptCapability implements ProviderActionCapability<PromptAction> {
  readonly capability = 'prompt'
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.PROMPT_INPUT,
    VISIBLE_ACTIONS.PROMPT_CLEAR,
    VISIBLE_ACTIONS.PROMPT_SUBMIT,
  ])
  protected readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
    Object.freeze(this)
  }

  async execute(page: Page, request: Extract<VisibleActionRequest, { action: PromptAction }>, _context: ProviderExecutionContext): Promise<VisibleActionResult> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_INPUT) return await this.input(page, request.payload.text)
    if (request.action === VISIBLE_ACTIONS.PROMPT_CLEAR) return await this.clear(page)
    return await this.submit(page)
  }

  async input(page: Page, text: string) {
    const deadline = Date.now() + PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS
    let composerObserved = false
    do {
      const composer = await waitForVisibleLocator(
        page,
        this.provider.composerSelectors,
        Math.max(1, deadline - Date.now()),
      )
      if (!composer) break
      composerObserved = true
      if (await writePrompt(page, composer, text)) {
        return {
          visible: true as const,
          inputProof: 'prompt-text-visible',
        }
      }
      if (Date.now() < deadline) {
        await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())))
      }
    } while (Date.now() < deadline)

    if (!composerObserved) {
      throw tokenlessError(
        'prompt_input_visibility_timeout',
        `Timed out after ${PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS}ms waiting for a visible prompt input.`,
        { retryable: true },
      )
    }
    throw tokenlessError(
      'prompt_input_failed',
      'The visible prompt input remained empty after input.',
      { retryable: true },
    )
  }

  async clear(page: Page) {
    await this.input(page, '')
    return {
      visible: true as const,
      inputProof: 'empty' as const,
    }
  }

  async submit(page: Page) {
    const button = await waitForVisibleLocator(page, this.provider.submitSelectors, PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS)
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
