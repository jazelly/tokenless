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

const QWEN_PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS = 15_000

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
      navigation: Object.freeze({
        homeUrl: 'https://www.qianwen.com/',
        origins: Object.freeze(['https://www.qianwen.com']),
        trustedSignInOrigins: Object.freeze([]),
      }),
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['qianwen.com']),
      }),
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
        'div[contenteditable="true"][role="textbox"][aria-multiline="true"][data-slate-editor="true"]',
      ]),
      submitSelectors: Object.freeze([
        'button[aria-label="发送消息"]',
      ]),
      answerSelectors: Object.freeze([
        '.chat-answers-card-wrap .qk-markdown',
      ]),
      fileInputSelectors: Object.freeze([]),
      fileUploadTriggerSelectors: Object.freeze([]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([]),
      loginIndicators: Object.freeze([
        'button:has-text("登录")',
      ]),
      blockerSelectors: Object.freeze([]),
      busySelectors: Object.freeze([
        '.chat-answers-card-wrap .qk-markdown:not(.qk-markdown-complete)',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }

  protected override async inputPrompt(page: Page, text: string, _context: ProviderExecutionContext) {
    const deadline = Date.now() + QWEN_PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS
    let composerObserved = false
    do {
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
        `Timed out after ${QWEN_PROMPT_CONTROL_VISIBILITY_TIMEOUT_MS}ms waiting for a visible prompt input.`,
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
      : (element.textContent ?? '')
    const normalized = normalizeSlateText(text)
    const expected = normalizeSlateText(value)
    return expected.length === 0 ? normalized.length === 0 : normalized === expected
  }, expected).catch(() => false)
}
