import { VISIBLE_ACTIONS } from '../contracts.js'
import { tokenlessError } from '../../browser/errors.js'
import { observeProviderSession } from '../../browser/provider-session/observe.js'
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

export async function clearDomPrompt(
  provider: ProviderDomDefinition,
  page: Page,
  signal?: AbortSignal,
  resetDraft = false,
) {
  if (provider.descriptor.id === 'claude') {
    await clearClaudePromptDraft(provider, page, signal)
    await clearClaudeDraftAttachments(provider, page, signal)
    if (resetDraft) await reloadClearedClaudeDraft(provider, page, signal)
  } else await inputDomPrompt(provider, page, '', signal)
  return {
    visible: true as const,
    inputProof: 'empty' as const,
  }
}

async function clearClaudePromptDraft(
  provider: ProviderDomDefinition,
  page: Page,
  signal: AbortSignal | undefined,
) {
  await dismissProviderAnnouncement(page, provider)
  const composer = await waitForVisibleLocator(
    page,
    provider.composerSelectors,
    provider.interactionTimings.promptControlTimeoutMs,
  )
  if (!composer) {
    throw tokenlessError(
      'prompt_clear_failed',
      'No visible Claude composer was available to clear.',
      { retryable: true },
    )
  }
  if (await composerIsVisiblyEmpty(composer)) return
  await composer.evaluate((element) => {
    element.focus()
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select()
      return
    }
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.keyboard.press('Backspace')
  const deadline = Date.now() + provider.interactionTimings.promptControlTimeoutMs
  let attempt = 0
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    if (await composerIsVisiblyEmpty(composer)) return
    await waitForNextDomObservation(page, deadline, attempt, signal)
    attempt += 1
  }
  throw tokenlessError(
    'prompt_clear_failed',
    'The visible Claude prompt draft could not be cleared.',
    { retryable: true },
  )
}

async function reloadClearedClaudeDraft(
  provider: ProviderDomDefinition,
  page: Page,
  signal: AbortSignal | undefined,
) {
  assertNotAborted(signal)
  await page.waitForTimeout(1000)
  assertNotAborted(signal)
  try {
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: provider.interactionTimings.promptControlTimeoutMs,
    })
  } catch (error) {
    assertNotAborted(signal)
    throw tokenlessError(
      'prompt_clear_failed',
      'The cleared Claude draft could not be reloaded.',
      { retryable: true, cause: error },
    )
  }
  const composer = await waitForVisibleLocator(
    page,
    provider.composerSelectors,
    provider.interactionTimings.promptControlTimeoutMs,
  )
  const visibleAttachmentCount = await page.locator('[data-testid="file-thumbnail"]')
    .filter({ visible: true })
    .count()
  const composerEmpty = composer ? await composerIsVisiblyEmpty(composer) : null
  if (composerEmpty === true && visibleAttachmentCount === 0) return
  throw tokenlessError(
    'prompt_clear_failed',
    'The cleared Claude draft did not remain empty after reload.',
    {
      retryable: true,
      details: {
        composerVisible: composer !== null,
        composerEmpty,
        visibleAttachmentTiles: visibleAttachmentCount,
      },
    },
  )
}

export async function inputDomPrompt(
  provider: ProviderDomDefinition,
  page: Page,
  text: string,
  signal?: AbortSignal,
) {
  await dismissProviderAnnouncement(page, provider)
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
    if (await writePrompt(page, composer, text, provider.descriptor.id === 'claude')) {
      await dismissProviderAnnouncement(page, provider)
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
      { retryable: true, details: await promptInputDiagnostics(page) },
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

async function promptInputDiagnostics(page: Page) {
  return await page.evaluate(() => {
    const isVisible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
    }
    return Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"], [role="textbox"]'))
      .filter(isVisible)
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        placeholder: element.getAttribute('placeholder'),
        contentEditable: element.getAttribute('contenteditable'),
        id: element.id || null,
        classes: Array.from(element.classList).slice(0, 8),
      }))
  }).catch(() => [])
}

async function dismissProviderAnnouncement(page: Page, provider: ProviderDomDefinition) {
  if (provider.descriptor.id === 'claude') {
    const notNow = page.locator('button')
      .filter({ visible: true, hasText: /^\s*Not now\s*$/u })
      .last()
    if (!await notNow.isVisible({ timeout: 500 }).catch(() => false)) return
    if (!await notNow.isEnabled({ timeout: 500 }).catch(() => false)) return
    await notNow.click({ timeout: 5000 })
    await notNow.waitFor({ state: 'hidden', timeout: 2000 })
    return
  }
  if (provider.descriptor.id !== 'zai') return
  const dialog = page.locator('[role="dialog"]')
    .filter({ visible: true })
    .last()
  if (await dialog.count() === 0) return
  if (await dialog.filter({ hasText: 'Now Available' }).count() > 0) {
    await page.keyboard.press('Escape').catch(() => undefined)
    await dialog.waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => undefined)
  }
  if (!await dialog.isVisible({ timeout: 250 }).catch(() => false)) return
  const close = dialog.locator('button[aria-label="Close"]')
    .filter({ visible: true })
    .last()
  if (!await close.isEnabled({ timeout: 250 }).catch(() => false)) return
  await close.click({ timeout: 5_000 }).catch(() => undefined)
  await dialog.waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => undefined)
}

async function clearClaudeDraftAttachments(
  provider: ProviderDomDefinition,
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + provider.interactionTimings.promptControlTimeoutMs
  let attempt = 0
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    const tiles = page.locator('[data-testid="file-thumbnail"]')
      .filter({ visible: true })
    const tileCount = await tiles.count()
    if (tileCount === 0) return
    const tile = tiles.first()
    const remove = tile.locator('button[aria-label="Remove"]')
      .filter({ visible: true })
      .first()
    if (await remove.isEnabled({ timeout: 50 }).catch(() => false)) {
      await remove.click({ timeout: 5000 })
      const removalDeadline = Math.min(deadline, Date.now() + 2000)
      while (Date.now() <= removalDeadline && await tiles.count() >= tileCount) {
        await waitForNextDomObservation(page, removalDeadline, attempt, signal)
        attempt += 1
      }
      if (await tiles.count() >= tileCount) break
      continue
    }
    if (Date.now() < deadline) {
      await waitForNextDomObservation(page, deadline, attempt, signal)
      attempt += 1
    }
  }
  throw tokenlessError(
    'prompt_clear_failed',
    'The visible Claude draft attachments could not be removed.',
    { retryable: true },
  )
}

export async function submitDomPrompt(
  provider: ProviderDomDefinition,
  page: Page,
  signal?: AbortSignal,
) {
  await dismissProviderAnnouncement(page, provider)
  const controlTimeoutMs = provider.interactionTimings.promptControlTimeoutMs
  const button = await waitForActionableSubmitControl(provider, page, signal)
  const disabledClaudeSubmit = provider.descriptor.id === 'claude' && !button
    ? await firstVisibleLocator(page, provider.submitSelectors, 50)
    : null
  const keyboardSubmitComposer = !button && !disabledClaudeSubmit
    ? await claudeKeyboardSubmitComposer(provider, page)
    : null
  if (!button && !keyboardSubmitComposer) {
    throw tokenlessError(
      'prompt_submit_actionability_timeout',
      `Timed out after ${controlTimeoutMs}ms waiting for an actionable visible prompt submit control.`,
      { retryable: true, details: await promptSubmitDiagnostics(provider, page) },
    )
  }
  const baseline = {
    answerCount: await countVisibleLocators(page, provider.answerSelectors),
    url: page.url(),
  }
  try {
    if (button) await button.click({ timeout: 5000 })
    else {
      await keyboardSubmitComposer!.focus({ timeout: 5000 })
      await page.keyboard.press('Enter')
    }
  } catch (error) {
    throw tokenlessError(
      'prompt_submit_failed',
      'The visible prompt submit control could not be activated.',
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
  if (provider.descriptor.id === 'zai') {
    const composer = await firstVisibleLocator(page, provider.composerSelectors, 50)
    if (composer && !await composerIsVisiblyEmpty(composer)) {
      await composer.focus({ timeout: 5_000 })
      await page.keyboard.press('Enter')
      const keyboardDeadline = Date.now() + acceptanceTimeoutMs
      attempt = 0
      do {
        assertNotAborted(signal)
        if (await submissionTransitionIsVisible(provider, page, button, baseline)) {
          return {
            visible: true as const,
            submissionProof: 'visible-submission-transition',
          }
        }
        if (Date.now() < keyboardDeadline) {
          await waitForNextDomObservation(page, keyboardDeadline, attempt, signal)
          attempt += 1
        }
      } while (Date.now() < keyboardDeadline)
    }
  }
  throw tokenlessError(
    'prompt_submit_not_accepted',
    `No visible provider submission transition followed the activation within ${acceptanceTimeoutMs}ms.`,
    { retryable: false, details: await promptSubmitDiagnostics(provider, page) },
  )
}

async function claudeKeyboardSubmitComposer(
  provider: ProviderDomDefinition,
  page: Page,
) {
  if (provider.descriptor.id !== 'claude') return null
  const composer = await firstVisibleLocator(page, provider.composerSelectors, 50)
  return composer && !await composerIsVisiblyEmpty(composer) ? composer : null
}

async function promptSubmitDiagnostics(
  provider: ProviderDomDefinition,
  page: Page,
) {
  const button = await firstVisibleLocator(page, provider.submitSelectors, 50)
  const composer = await firstVisibleLocator(page, provider.composerSelectors, 50)
  const session = await observeProviderSession(page, provider).catch(() => null)
  const documentState = await page.evaluate(() => ({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  })).catch(() => ({ visibility: 'unknown', focused: false }))
  const submit = button
    ? await button.evaluate((element) => ({
        visible: true,
        disabled: element.hasAttribute('disabled'),
        ariaDisabled: element.getAttribute('aria-disabled'),
        dataDisabled: element.getAttribute('data-disabled'),
      })).catch(() => ({ visible: true, disabled: null, ariaDisabled: null, dataDisabled: null }))
    : { visible: false, disabled: null, ariaDisabled: null, dataDisabled: null }
  const disabledReason = button
    ? await (async () => {
        await button.hover({ timeout: 1000 }).catch(() => undefined)
        await page.waitForTimeout(250)
        return await button.evaluate((element) => {
          const isVisible = (candidate: Element | null): candidate is HTMLElement => {
            if (!(candidate instanceof HTMLElement)) return false
            const style = window.getComputedStyle(candidate)
            const rect = candidate.getBoundingClientRect()
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
          }
          const describedBy = (element.getAttribute('aria-describedby') ?? '')
            .split(/\s+/u)
            .filter(Boolean)
            .map((id) => document.getElementById(id))
            .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement)
          const tooltips = Array.from(document.querySelectorAll('[role="tooltip"]')).filter(isVisible)
          const parts = [
            element.getAttribute('title') ?? '',
            element.getAttribute('aria-description') ?? '',
            ...describedBy.map((candidate) => candidate.textContent ?? ''),
            ...tooltips.map((candidate) => candidate.textContent ?? ''),
          ].filter((value) => value.trim() !== '')
          const text = parts.join(' ').replace(/\s+/gu, ' ').trim().toLowerCase()
          const category = text === ''
            ? 'none'
            : /(?:upgrade|subscribe|paid plan|plan limit|usage limit|message limit)/u.test(text)
              ? 'plan_limit'
              : /(?:rate limit|too many requests|try again later|quota|(?:reached|hit).{0,80}limit|limit.{0,80}(?:reset|reached|hit))/u.test(text)
                ? 'rate_limit'
                : /(?:attachment|file).{0,80}(?:processing|uploading|parsing|failed|unsupported)/u.test(text)
                  ? 'attachment_processing'
                  : /(?:model).{0,80}(?:unavailable|unsupported|select|choose)/u.test(text)
                    ? 'model_unavailable'
                    : /(?:empty|write|enter|type).{0,80}(?:prompt|message)/u.test(text)
                      ? 'input_empty'
                      : /(?:unavailable|disabled|cannot|can't|unable)/u.test(text)
                        ? 'unavailable'
                        : 'unknown'
          return {
            category,
            sources: {
              attribute: element.hasAttribute('title') || element.hasAttribute('aria-description'),
              describedBy: describedBy.length > 0,
              visibleTooltip: tooltips.length > 0,
            },
          }
        }).catch(() => null)
      })()
    : null
  const surface = await page.evaluate(({ composerSelectors, submitSelectors }) => {
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
    }
    const submitControls = submitSelectors.flatMap((selector) => {
      try {
        return Array.from(document.querySelectorAll(selector))
      } catch {
        return []
      }
    }).filter(isVisible)
    const visibleSubmitControls = [...new Set(submitControls)]
    const visibleComposer = composerSelectors.flatMap((selector) => {
      try {
        return Array.from(document.querySelectorAll(selector))
      } catch {
        return []
      }
    }).find(isVisible) ?? null
    const selection = window.getSelection()
    const selectionInsideComposer = visibleComposer !== null && selection !== null && selection.rangeCount > 0
      ? visibleComposer.contains(selection.anchorNode) && visibleComposer.contains(selection.focusNode)
      : false
    return {
      submitControls: {
        visible: visibleSubmitControls.length,
        enabled: visibleSubmitControls.filter((control) => !control.hasAttribute('disabled') && control.getAttribute('aria-disabled') !== 'true').length,
        disabled: visibleSubmitControls.filter((control) => control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true').length,
      },
      composer: visibleComposer === null
        ? null
        : {
            editable: visibleComposer.getAttribute('contenteditable') === 'true' || visibleComposer instanceof HTMLInputElement || visibleComposer instanceof HTMLTextAreaElement,
            ariaDisabled: visibleComposer.getAttribute('aria-disabled'),
            active: visibleComposer === document.activeElement || visibleComposer.contains(document.activeElement),
            selectionInside: selectionInsideComposer,
          },
      visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]')).filter(isVisible).length,
      notNowVisible: Array.from(document.querySelectorAll('button')).some((candidate) => isVisible(candidate) && /^\s*Not now\s*$/u.test(candidate.textContent ?? '')),
      visibleAttachmentTiles: Array.from(document.querySelectorAll('[data-testid="file-thumbnail"]')).filter(isVisible).length,
    }
  }, { composerSelectors: provider.composerSelectors, submitSelectors: provider.submitSelectors }).catch(() => null)
  const composerCharacters = composer
    ? await composer.evaluate((element) => (
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value.length
          : (element.textContent ?? '').length
      )).catch(() => null)
    : null
  return {
    documentVisibility: documentState.visibility,
    documentFocused: documentState.focused,
    submit,
    disabledReason,
    composerVisible: composer !== null,
    composerCharacters,
    surface,
    session: session === null
      ? null
      : {
          authentication: session.authentication,
          access: session.access,
          composerVisible: session.composerVisible,
          guestContinueAvailable: session.guestContinueAvailable,
          blockers: session.blockers.map((blocker) => ({
            code: blocker.code,
            family: blocker.family ?? null,
            visibleProof: blocker.visibleProof,
            limitWindow: blocker.limitWindow ?? null,
            retryAfterSeconds: blocker.retryAfterSeconds ?? null,
          })),
        },
  }
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
      if (actionable || provider.descriptor.id === 'claude') return button
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
  clickedButton: Locator | null,
  baseline: { answerCount: number, url: string },
) {
  const conversationChanged = page.url() !== baseline.url
  const answerStarted = await countVisibleLocators(page, provider.answerSelectors) > baseline.answerCount
  const providerBusy = await countVisibleLocators(page, provider.busySelectors) > 0
  if (conversationChanged || answerStarted || providerBusy) return true
  if (provider.descriptor.id === 'qwen') return false
  if (clickedButton && !await clickedButton.isVisible({ timeout: 50 }).catch(() => false)) return true
  if (clickedButton && !await clickedButton.isEnabled({ timeout: 50 }).catch(() => false)) return true
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

async function writePrompt(page: Page, composer: Locator, text: string, preferKeyboardInput = false) {
  if (await composerHasExpectedText(composer, text)) return true
  if (!preferKeyboardInput) {
    try {
      await composer.fill(text, { timeout: 2000 })
      if (await composerHasExpectedText(composer, text)) return true
    } catch {
      // Hydration can replace a visible fallback composer while it is being filled.
      if (await composerHasExpectedText(composer, text)) return true
    }
  }
  try {
    if (!await composer.isVisible({ timeout: 250 })) return false
    await composer.click({ timeout: 1000 })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    if (text.length === 0) await page.keyboard.press('Backspace')
    else await page.keyboard.insertText(text)
    return await composerHasExpectedText(composer, text)
  } catch {
    return await composerHasExpectedText(composer, text)
  }
}
