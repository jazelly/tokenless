import { VISIBLE_ACTIONS } from '../contracts.js'
import { tokenlessError } from '../../playwright/errors.js'
import {
  countVisibleLocators,
  firstEnabledLocator,
  firstVisibleLocator,
  waitForNextDomObservation,
  waitForVisibleLocator,
} from '../dom-locators.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderDomDefinition } from '../provider-definition.js'

export type PromptAction =
  | typeof VISIBLE_ACTIONS.PROMPT_INPUT
  | typeof VISIBLE_ACTIONS.PROMPT_CLEAR
  | typeof VISIBLE_ACTIONS.PROMPT_SUBMIT

export async function inputDomPrompt(
  provider: ProviderDomDefinition,
  page: Page,
  text: string,
  signal?: AbortSignal,
) {
  await dismissZaiAnnouncement(page, provider)
  const timeoutMs = provider.interactionTimings.promptControlTimeoutMs
  const deadline = Date.now() + timeoutMs
  let composerObserved = false
  let attempt = 0
  do {
    assertNotAborted(signal)
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
      await waitForNextDomObservation(page, deadline, attempt, signal)
      attempt += 1
    }
  } while (Date.now() < deadline)

  if (!composerObserved) {
    throw tokenlessError(
      'prompt_input_visibility_timeout',
      `Timed out after ${timeoutMs}ms waiting for a visible prompt input.`,
      { retryable: true },
    )
  }
  const finalComposer = await firstVisibleLocator(page, provider.composerSelectors)
  if (finalComposer && await composerHasExpectedText(finalComposer, text)) {
    return {
      visible: true as const,
      inputProof: 'prompt-text-visible',
    }
  }
  throw tokenlessError(
    'prompt_input_failed',
    'The visible prompt input remained empty after input.',
    { retryable: true },
  )
}

async function dismissZaiAnnouncement(page: Page, provider: ProviderDomDefinition) {
  if (provider.id !== 'zai') return
  const announcement = page.locator('[role="dialog"]')
    .filter({ visible: true })
    .filter({ hasText: 'Now Available' })
    .last()
  if (await announcement.count() === 0) return
  await page.keyboard.press('Escape').catch(() => undefined)
  await announcement.waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => undefined)
}

export async function submitDomPrompt(
  provider: ProviderDomDefinition,
  page: Page,
  signal?: AbortSignal,
) {
  const controlTimeoutMs = provider.interactionTimings.promptControlTimeoutMs
  const button = await waitForActionableSubmitControl(provider, page, signal)
  if (!button) {
    throw tokenlessError(
      'prompt_submit_actionability_timeout',
      `Timed out after ${controlTimeoutMs}ms waiting for an actionable visible prompt submit control.`,
      { retryable: true },
    )
  }
  const baseline = {
    answerCount: await countVisibleLocators(page, provider.answerSelectors),
    url: page.url(),
  }
  try {
    await button.click({ timeout: 5000 })
  } catch (error) {
    throw tokenlessError(
      'prompt_submit_failed',
      'The visible prompt submit control could not be clicked.',
      { retryable: false, cause: error },
    )
  }
  const acceptanceTimeoutMs = provider.interactionTimings.submissionAcceptanceTimeoutMs
  const deadline = Date.now() + acceptanceTimeoutMs
  let attempt = 0
  do {
    assertNotAborted(signal)
    if (await submissionTransitionIsVisible(provider, page, button, baseline)) {
      return {
        visible: true as const,
        submissionProof: 'visible-submission-transition',
      }
    }
    if (Date.now() < deadline) {
      await waitForNextDomObservation(page, deadline, attempt, signal)
      attempt += 1
    }
  } while (Date.now() < deadline)
  throw tokenlessError(
    'prompt_submit_not_accepted',
    `No visible provider submission transition followed the click within ${acceptanceTimeoutMs}ms.`,
    { retryable: false },
  )
}

async function waitForActionableSubmitControl(
  provider: ProviderDomDefinition,
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + provider.interactionTimings.promptControlTimeoutMs
  let attempt = 0
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    const button = await firstEnabledLocator(page, provider.submitSelectors)
    if (button) {
      const trialTimeoutMs = Math.min(2_000, Math.max(1, deadline - Date.now()))
      const actionable = await button.click({ trial: true, timeout: trialTimeoutMs })
        .then(() => true)
        .catch(() => false)
      if (actionable) return button
    }
    if (Date.now() >= deadline) break
    await waitForNextDomObservation(page, deadline, attempt, signal)
    attempt += 1
  }
  return null
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
}

async function submissionTransitionIsVisible(
  provider: ProviderDomDefinition,
  page: Page,
  clickedButton: Locator,
  baseline: { answerCount: number, url: string },
) {
  const conversationChanged = page.url() !== baseline.url
  const answerStarted = await countVisibleLocators(page, provider.answerSelectors) > baseline.answerCount
  const providerBusy = await countVisibleLocators(page, provider.busySelectors) > 0
  if (conversationChanged || answerStarted || providerBusy) return true
  if (provider.id === 'qwen') return false
  if (!await clickedButton.isVisible({ timeout: 50 }).catch(() => false)) return true
  if (!await clickedButton.isEnabled({ timeout: 50 }).catch(() => false)) return true
  const composer = await firstVisibleLocator(page, provider.composerSelectors, 50)
  if (!composer || await composerIsVisiblyEmpty(composer)) return true
  return false
}

async function composerHasExpectedText(locator: Locator, expectedText: string) {
  try {
    return await locator.evaluate((element, expected) => {
      const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : (element.textContent ?? '')
      const normalizedText = text.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/gu, '')
      const normalizedExpected = expected.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/gu, '')
      return normalizedExpected.length === 0
        ? normalizedText.length === 0
        : normalizedText.includes(normalizedExpected)
    }, expectedText)
  } catch {
    return false
  }
}

async function composerIsVisiblyEmpty(locator: Locator) {
  return await locator.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return normalizedPromptText(element.value).length === 0
    }
    const clone = element.cloneNode(true) as Element
    clone.querySelectorAll('[data-slate-placeholder="true"], [data-slate-zero-width]').forEach((node) => node.remove())
    return normalizedPromptText(clone.textContent ?? '').length === 0

    function normalizedPromptText(value: string) {
      return value.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/gu, '')
    }
  }).catch(() => false)
}

async function writePrompt(page: Page, composer: Locator, text: string) {
  if (await composerHasExpectedText(composer, text)) return true
  try {
    await composer.fill(text, { timeout: 2000 })
    if (await composerHasExpectedText(composer, text)) return true
  } catch {
    // Hydration can replace a visible fallback composer while it is being filled.
    if (await composerHasExpectedText(composer, text)) return true
  }
  try {
    if (!await composer.isVisible({ timeout: 250 })) return false
    await composer.click({ timeout: 1000 })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    if (text.length === 0) await page.keyboard.press('Backspace')
    else await page.keyboard.type(text)
    return await composerHasExpectedText(composer, text)
  } catch {
    return await composerHasExpectedText(composer, text)
  }
}
