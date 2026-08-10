import { BaseProvider } from './base-provider.js'
import { waitForVisibleLocator } from './dom-locators.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { MenuTextAccountInspector } from './account-inspectors.js'
import { tokenlessError } from '../playwright/errors.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { ProviderDomDefinition } from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

const QWEN_APP_HYDRATION_AGE_MS = 3_000

export class QwenProvider extends BaseProvider<'qwen'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'qwen',
      label: 'Qwen / 千问',
      stage: 'experimental',
      setupOrder: 4,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.qwen,
      controls: Object.freeze({
        chatSurface: false,
      }),
    })
    const provider = defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'supported',
        guestContinueControlNames: Object.freeze([]),
      }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        'textarea.message-input-textarea',
      ]),
      submitSelectors: Object.freeze([
        'button.send-button',
      ]),
      answerSelectors: Object.freeze([
        '.qwen-chat-message-assistant .chat-response-message .qwen-markdown',
        '.qwen-chat-message-assistant .qwen-markdown',
      ]),
      fileInputSelectors: Object.freeze([
        '#filesUpload[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        '[role="button"][aria-label="Select Mode"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[role="menuitem"].mode-select-common-item:has-text("Upload attachment")',
      ]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([
        '.qwen-select-thinking',
      ]),
      authIndicators: Object.freeze([
        'button:has(img[alt="User profile"])',
        'button[aria-label^="User profile"]',
      ]),
      loginIndicators: Object.freeze([
        'button:has-text("Log in")',
        'button:has-text("Sign up")',
        'button:has-text("登录")',
      ]),
      blockerSelectors: Object.freeze([]),
      busySelectors: Object.freeze([
        'button.stop-button',
        '.qwen-chat-message-awaiting-response',
      ]),
      interactionTimings: Object.freeze({
        attachmentReadyTimeoutMs: 120_000,
        promptControlTimeoutMs: 30_000,
        submissionAcceptanceTimeoutMs: 30_000,
      }),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }

  protected override async inputPrompt(page: Page, text: string, context: ProviderExecutionContext) {
    const timeoutMs = this.definition.interactionTimings.promptControlTimeoutMs
    const deadline = Date.now() + timeoutMs
    assertNotAborted(context.signal)
    await waitForQwenAppHydration(page, deadline)
    let composerObserved = false
    do {
      assertNotAborted(context.signal)
      const composer = await waitForVisibleLocator(
        page,
        this.definition.composerSelectors,
        Math.max(1, deadline - Date.now()),
      )
      if (!composer) break
      composerObserved = true
      if (await writeQwenPrompt(page, composer, this.definition, text, deadline)) {
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
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
}

async function waitForQwenAppHydration(page: Page, deadline: number) {
  const pageAgeMs = await page.evaluate(() => performance.now()).catch(() => 0)
  const remainingHydrationMs = Math.max(0, QWEN_APP_HYDRATION_AGE_MS - pageAgeMs)
  if (remainingHydrationMs > 0) {
    await page.waitForTimeout(Math.min(remainingHydrationMs, Math.max(1, deadline - Date.now())))
  }
}

async function writeQwenPrompt(
  page: Page,
  composer: Locator,
  provider: ProviderDomDefinition,
  text: string,
  deadline: number,
) {
  await composer.fill(text, { timeout: Math.min(2000, Math.max(1, deadline - Date.now())) }).catch(() => undefined)
  if (await qwenComposerHasExpectedText(page, provider, text, deadline)) return true

  const freshComposer = await waitForVisibleLocator(
    page,
    provider.composerSelectors,
    Math.max(1, deadline - Date.now()),
  )
  if (!freshComposer) return false
  try {
    await focusQwenComposer(freshComposer)
  } catch {
    return false
  }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => undefined)
  await page.keyboard.press('Backspace').catch(() => undefined)
  const clearedComposer = await waitForVisibleLocator(
    page,
    provider.composerSelectors,
    Math.max(1, deadline - Date.now()),
  )
  if (!clearedComposer) return false
  try {
    await focusQwenComposer(clearedComposer)
  } catch {
    return false
  }
  if (text.length > 0) {
    await page.keyboard.insertText(text).catch(() => undefined)
  }
  return await qwenComposerHasExpectedText(page, provider, text, deadline)
}

async function focusQwenComposer(composer: Locator) {
  await composer.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => undefined)
  await composer.click({ timeout: 1000 })
}

async function qwenComposerHasExpectedText(
  page: Page,
  provider: ProviderDomDefinition,
  expected: string,
  deadline: number,
) {
  const composer = await waitForVisibleLocator(
    page,
    provider.composerSelectors,
    Math.max(1, deadline - Date.now()),
  )
  if (!composer) return false
  return await composer.evaluate((element, value) => {
    const normalizeSlateText = (input: string) => input
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : (() => {
          const clone = element.cloneNode(true) as Element
          clone.querySelectorAll('[data-slate-placeholder="true"], [data-slate-zero-width]').forEach((node) => node.remove())
          return clone.textContent ?? ''
        })()
    const normalized = normalizeSlateText(text)
    const expected = normalizeSlateText(value)
    return expected.length === 0 ? normalized.length === 0 : normalized === expected
  }, expected).catch(() => false)
}
