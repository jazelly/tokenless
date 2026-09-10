import { BaseProvider } from './base-provider.js'
import { MenuTextAccountInspector } from './account-inspectors.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import {
  countVisibleLocators,
  firstVisibleLocator,
  waitForNextDomObservation,
  waitForVisibleLocator,
} from './dom-locators.js'
import { tokenlessError } from '../browser/errors.js'
import type { Page } from 'playwright-core'
import type { AuthStatusResult } from '../browser/actions.js'
import type { VisibleActionResult } from '../browser/actions.js'
import type { ProviderExecutionContext } from './execution-context.js'

const MONICA_SESSION_HYDRATION_TIMEOUT_MS = 10_000

/**
 * Monica (monica.im) is a consumer AI assistant that aggregates OpenAI,
 * Anthropic, Gemini, and other models behind a single web chat surface.
 *
 * Verified against the live web app on 2026-09-10:
 * - The composer is a `<textarea data-input_node="monica-chat-input">` (stable
 *   attribute) with placeholder "Ask me anything...".
 * - The web chat has no visible submit button; messages are submitted with the
 *   Enter key only (the toolbar icons are compose actions, not send). Because
 *   the shared prompt submit flow requires a clickable control, submitPrompt is
 *   overridden below to focus the composer and press Enter.
 * - Assistant answers render into `.__markdown` elements (a global, stable
 *   class); the hashed `markdown--*` companion class changes across builds.
 * - While generating, a `.stop-btn-wrapper` element is visible and disappears
 *   once the reply completes. A persistent `geist-loading` spinner elsewhere in
 *   the UI must NOT be used as a busy signal.
 * - Conversation URLs are `https://monica.im/home/chat/<agent>/<botUid>` with a
 *   `convId` query parameter carrying the conversation id.
 */
export class MonicaProvider extends BaseProvider<'monica'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'monica',
      label: 'Monica',
      stage: 'experimental',
      setupOrder: 15,
      subscriptionSupport: 'supported',
      navigation: PROVIDER_NAVIGATION_CATALOG.monica,
      controls: Object.freeze({
        chatSurface: false,
      }),
    })
    const provider = defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'unsupported',
        guestContinueControlNames: Object.freeze([]),
      }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        'textarea[data-input_node="monica-chat-input"]',
        'textarea[placeholder="Ask me anything..."]',
      ]),
      // Monica's web chat has no visible submit control; submission is
      // Enter-key only (see submitPrompt override below).
      submitSelectors: Object.freeze([]),
      answerSelectors: Object.freeze([
        '.__markdown',
      ]),
      fileInputSelectors: Object.freeze([]),
      fileUploadTriggerSelectors: Object.freeze([]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        '[class*="avatar-wrapper"]',
        'textarea[data-input_node="monica-chat-input"]',
      ]),
      loginIndicators: Object.freeze([
        'button:has-text("Sign In")',
        'button:has-text("Sign Up")',
        'text=Sign In',
        'text=Sign Up',
      ]),
      blockerSelectors: Object.freeze([
        'text=/too many requests|rate limit|异常高的流量/i',
        'text=/该模型已下线|model.*offline/i',
      ]),
      busySelectors: Object.freeze([
        '[class*="stop-btn-wrapper"]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities({}),
    })
    super(provider)
  }

  protected override async inspectAccount(page: Page, signal: AbortSignal | undefined): Promise<AuthStatusResult> {
    await waitForVisibleLocator(
      page,
      [
        ...this.definition.loginIndicators,
        ...this.definition.authIndicators,
        ...this.definition.composerSelectors,
      ],
      MONICA_SESSION_HYDRATION_TIMEOUT_MS,
    )
    const inspected = await super.inspectAccount(page, signal)
    const suspension = (await this.inspectBlockers(page)).blockers
      .find((blocker) => blocker.code === 'provider_account_suspended')
    if (!suspension) return inspected
    return {
      state: 'authenticated',
      access: 'account_blocked',
      visibleProof: suspension.visibleProof,
    }
  }

  protected override async submitPrompt(page: Page, context: ProviderExecutionContext): Promise<VisibleActionResult> {
    const composer = await firstVisibleLocator(page, this.definition.composerSelectors, 50)
    if (!composer) {
      throw tokenlessError(
        'prompt_submit_actionability_timeout',
        'Timed out waiting for the Monica composer for keyboard submission.',
        { retryable: true },
      )
    }
    await composer.focus({ timeout: 5_000 })
    const baseline = {
      answerCount: await countVisibleLocators(page, this.definition.answerSelectors),
      url: page.url(),
    }
    await page.keyboard.press('Enter')
    const deadline = Date.now() + this.definition.interactionTimings.submissionAcceptanceTimeoutMs
    let attempt = 0
    do {
      if (context.signal?.aborted) {
        throw context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error('Visible provider action was aborted.')
      }
      if (await monicaSubmissionTransitionIsVisible(page, baseline, this.definition.answerSelectors, this.definition.busySelectors)) {
        return { visible: true, submissionProof: 'visible-submission-transition' }
      }
      if (Date.now() < deadline) {
        await waitForNextDomObservation(page, deadline, attempt, context.signal)
        attempt += 1
      }
    } while (Date.now() < deadline)
    throw tokenlessError(
      'prompt_submit_not_accepted',
      'No visible Monica submission transition followed the Enter key activation.',
      { retryable: false },
    )
  }
}

async function monicaSubmissionTransitionIsVisible(
  page: Page,
  baseline: { answerCount: number, url: string },
  answerSelectors: readonly string[],
  busySelectors: readonly string[],
) {
  const conversationChanged = page.url() !== baseline.url
  const answerStarted = await countVisibleLocators(page, answerSelectors) > baseline.answerCount
  const providerBusy = await countVisibleLocators(page, busySelectors) > 0
  return conversationChanged || answerStarted || providerBusy
}