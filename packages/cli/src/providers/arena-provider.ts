import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import { tokenlessError } from '../playwright/errors.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { VisibleActionResult } from '../playwright/actions.js'

const ARENA_DIRECT_TURN_SELECTOR = 'ol.flex-col-reverse > :first-child + div'

export class ArenaProvider extends BaseProvider<'arena'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'arena',
      label: 'Arena',
      stage: 'supported',
      setupOrder: 11,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.arena,
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
        'textarea[placeholder="Ask anything…"]',
        'textarea[placeholder="Ask followup…"]',
      ]),
      submitSelectors: Object.freeze([
        'button[type="submit"][aria-label="Send message"]',
      ]),
      answerSelectors: Object.freeze([
        ARENA_DIRECT_TURN_SELECTOR,
      ]),
      fileInputSelectors: Object.freeze([]),
      fileUploadTriggerSelectors: Object.freeze([]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        '[data-sidebar="footer"] button:has(img)',
      ]),
      loginIndicators: Object.freeze([
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/rate limit|too many requests|service unavailable/i',
      ]),
      busySelectors: Object.freeze([
        'button[aria-label*="Stop" i]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }

  protected override async inputPrompt(page: Page, text: string, context: ProviderExecutionContext) {
    const onboarding = page
      .getByRole('dialog')
      .filter({ hasText: 'Terms of Use & Privacy Policy' })
    const agree = onboarding.getByRole('button', { name: 'Agree', exact: true })
    if (await agree.isVisible().catch(() => false)) {
      await agree.click({ timeout: 5_000 })
    }
    await ensureArenaDirectMode(page)
    return super.inputPrompt(page, text, context)
  }

  protected override async readResponse(
    page: Page,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    const turn = page.locator(ARENA_DIRECT_TURN_SELECTOR).filter({ visible: true }).first()
    if (!await turn.isVisible().catch(() => false)) {
      throw tokenlessError(
        'response_not_visible',
        'No Arena Direct answer is visibly available to read.',
        { retryable: true, details: { visibleProof: 'no-visible-arena-direct-answer' } },
      )
    }
    const responses = await turn.locator('.prose.body-base').filter({ visible: true }).allInnerTexts()
    const unique = [...new Set(responses.map(normalizeVisibleText).filter(Boolean))]
    if (unique.length !== 1) {
      throw tokenlessError(
        'arena_direct_response_ambiguous',
        'Arena Direct exposed multiple different visible answers.',
        { retryable: false, details: { visibleProof: 'multiple-distinct-arena-direct-answers' } },
      )
    }
    const completeText = unique[0]!
    context.captureVisibleOutput?.(completeText)
    const citations = await turn.locator('a[href]').evaluateAll((anchors) => anchors.slice(0, 24).map((anchor) => ({
      label: (anchor.textContent ?? '').trim().slice(0, 120),
      href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
    })).filter((entry) => entry.href.startsWith('https://')))
    const visibleBusyCount = await page.locator('button[aria-label*="Stop" i]').filter({ visible: true }).count()
    return {
      text: completeText.slice(0, 32_000),
      citations,
      visibleProof: 'visible-arena-direct-answer-read',
      decisionDiagnostics: {
        selected: null,
        visibleAnswerCount: await page.locator(ARENA_DIRECT_TURN_SELECTOR).filter({ visible: true }).count(),
        visibleBusyCount,
        generationStopVisible: visibleBusyCount > 0,
      },
    }
  }
}

async function ensureArenaDirectMode(page: Page) {
  const mode = page.getByRole('combobox').first()
  const selected = (await mode.innerText({ timeout: 5_000 })).replace(/\s+/g, ' ').trim()
  if (selected === 'Direct') return
  await mode.click({ timeout: 5_000 })
  await page.getByRole('option', {
    name: 'Direct Chat with 1 model at a time',
    exact: true,
  }).click({ timeout: 5_000 })
  await page.getByRole('combobox').filter({ hasText: /^Direct$/ }).waitFor({
    state: 'visible',
    timeout: 5_000,
  })
}

function normalizeVisibleText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}
