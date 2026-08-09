import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { MenuTextAccountInspector } from './account-inspectors.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

export class PerplexityProvider extends BaseProvider<'perplexity'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'perplexity',
      label: 'Perplexity',
      stage: 'experimental',
      setupOrder: 6,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.perplexity,
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['perplexity.ai']),
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
        freePlanLabels: Object.freeze(['Standard', 'Free']),
        paidPlanLabels: Object.freeze([
          'Pro',
          'Perplexity Pro',
          'Education Pro',
          'Max',
          'Perplexity Max',
          'Enterprise Pro',
          'Enterprise Max',
        ]),
      }),
      composerSelectors: Object.freeze([
        '#ask-input[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
      ]),
      submitSelectors: Object.freeze([
        'button[aria-label="Submit"]',
      ]),
      answerSelectors: Object.freeze([
        '.prose[data-renderer="lm"]',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"][multiple]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[aria-label="Add files or tools"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[role="menuitem"]:has-text("Upload files or images")',
      ]),
      modelControlSelectors: Object.freeze([
        'button[aria-label="Model"]',
      ]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        'button:has(img[alt="Profile avatar"])',
        'button[aria-label^="Profile avatar"]',
      ]),
      loginIndicators: Object.freeze([
        'button:has-text("Sign In")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/rate limit|too many requests/i',
        'text=/upgrade for additional document analysis/i',
        'text=/upgrade required|upgrade your plan/i',
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
    const declineOptional = page
      .getByRole('dialog')
      .filter({ hasText: 'Cookie Policy' })
      .getByRole('button', { name: 'Decline optional', exact: true })
    if (await declineOptional.isVisible().catch(() => false)) {
      await declineOptional.click({ timeout: 5_000 })
    }
    return super.inputPrompt(page, text, context)
  }
}
