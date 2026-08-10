import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'

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
        '[role="group"] .prose.body-base',
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
    return super.inputPrompt(page, text, context)
  }
}
