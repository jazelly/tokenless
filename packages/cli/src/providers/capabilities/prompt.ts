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
  throw tokenlessError(
    'prompt_input_failed',
    'The visible prompt input remained empty after input.',
    { retryable: true },
  )
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
  const qwenDraftBeforeFirstClick = provider.id === 'qwen'
    ? await normalizedVisibleComposerText(provider, page)
    : null
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
  if (await waitForVisibleSubmissionTransition(provider, page, button, baseline, acceptanceTimeoutMs, signal)) {
    return {
      visible: true as const,
      submissionProof: 'visible-submission-transition',
    }
  }
  if (
    provider.id === 'qwen' &&
    qwenDraftBeforeFirstClick !== null &&
    qwenDraftBeforeFirstClick.length > 0 &&
    await qwenRetryStateIsUnchanged(provider, page, baseline, qwenDraftBeforeFirstClick, signal)
  ) {
    const retryButton = await waitForActionableSubmitControl(provider, page, signal)
    if (
      retryButton &&
      await qwenRetryStateIsUnchanged(provider, page, baseline, qwenDraftBeforeFirstClick, signal)
    ) {
      try {
        await retryButton.click({ timeout: 5000 })
      } catch (error) {
        throw tokenlessError(
          'prompt_submit_failed',
          'The visible Qwen prompt submit control could not be clicked again.',
          { retryable: false, cause: error },
        )
      }
      if (await waitForVisibleSubmissionTransition(provider, page, retryButton, baseline, acceptanceTimeoutMs, signal)) {
        return {
          visible: true as const,
          submissionProof: 'visible-submission-transition',
        }
      }
    }
  }
  throw tokenlessError(
    'prompt_submit_not_accepted',
    `No visible provider submission transition followed the click within ${acceptanceTimeoutMs}ms.`,
    { retryable: false },
  )
}

async function waitForVisibleSubmissionTransition(
  provider: ProviderDomDefinition,
  page: Page,
  button: Locator,
  baseline: { answerCount: number, url: string },
  timeoutMs: number,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  do {
    assertNotAborted(signal)
    if (await submissionTransitionIsVisible(provider, page, button, baseline)) return true
    if (Date.now() < deadline) {
      await waitForNextDomObservation(page, deadline, attempt, signal)
      attempt += 1
    }
  } while (Date.now() < deadline)
  return false
}

async function qwenRetryStateIsUnchanged(
  provider: ProviderDomDefinition,
  page: Page,
  baseline: { answerCount: number, url: string },
  expectedDraft: string,
  signal: AbortSignal | undefined,
) {
  assertNotAborted(signal)
  const observed = await page.evaluate(({ answerSelectors, busySelectors, composerSelectors }) => {
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const normalizedText = (element: Element) => {
      const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : element.textContent ?? ''
      return text.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/gu, '')
    }
    const visibleCount = (selectors: readonly string[]) => selectors.reduce(
      (total, selector) => total + Array.from(document.querySelectorAll(selector)).filter(isVisible).length,
      0,
    )
    const composer = composerSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find(isVisible)
    return {
      url: window.location.href,
      answerCount: visibleCount(answerSelectors),
      busy: visibleCount(busySelectors) > 0,
      draft: composer ? normalizedText(composer) : null,
    }
  }, {
    answerSelectors: provider.answerSelectors,
    busySelectors: provider.busySelectors,
    composerSelectors: provider.composerSelectors,
  }).catch(() => null)
  return observed !== null &&
    observed.url === baseline.url &&
    observed.answerCount === baseline.answerCount &&
    !observed.busy &&
    observed.draft === expectedDraft
}

async function normalizedVisibleComposerText(provider: ProviderDomDefinition, page: Page) {
  const composer = await firstVisibleLocator(page, provider.composerSelectors, 50)
  if (!composer) return null
  return await composer.evaluate((element) => {
    const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : element.textContent ?? ''
    return text.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/gu, '')
  }).catch(() => null)
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
