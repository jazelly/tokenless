import { VISIBLE_ACTIONS } from '../contracts.js'
import { tokenlessError } from '../../playwright/errors.js'
import { waitForVisibleLocator } from '../dom-locators.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderDomDefinition } from '../provider-definition.js'

const PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS = 15_000

export type PromptAction =
  | typeof VISIBLE_ACTIONS.PROMPT_INPUT
  | typeof VISIBLE_ACTIONS.PROMPT_CLEAR
  | typeof VISIBLE_ACTIONS.PROMPT_SUBMIT

export async function inputDomPrompt(provider: ProviderDomDefinition, page: Page, text: string) {
  const deadline = Date.now() + PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS
  let composerObserved = false
  do {
    const composer = await waitForVisibleLocator(
      page,
      provider.composerSelectors,
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

export async function submitDomPrompt(provider: ProviderDomDefinition, page: Page) {
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
