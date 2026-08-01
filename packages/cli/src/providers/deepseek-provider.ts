import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { MenuTextAccountInspector } from './account-inspectors.js'
import { waitForVisibleLocator } from './dom-locators.js'
import type { Page } from 'playwright-core'

const DEEPSEEK_SESSION_HYDRATION_TIMEOUT_MS = 10_000

export class DeepSeekProvider extends BaseProvider<'deepseek'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'deepseek',
      label: 'DeepSeek',
      stage: 'experimental',
      setupOrder: 5,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: Object.freeze({
        homeUrl: 'https://chat.deepseek.com/',
        origins: Object.freeze(['https://chat.deepseek.com']),
        trustedSignInOrigins: Object.freeze([
          Object.freeze({ origin: 'https://accounts.google.com' }),
          Object.freeze({ origin: 'https://appleid.apple.com' }),
        ]),
      }),
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['deepseek.com']),
      }),
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
        'textarea#chat-input',
        'textarea[placeholder="Message DeepSeek"]',
      ]),
      submitSelectors: Object.freeze([
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
        'div[role="button"].ds-button.ds-button--primary',
      ]),
      answerSelectors: Object.freeze([
        '.ds-markdown.ds-markdown--block',
        '.ds-markdown',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
        'div[role="button"][aria-label*="Attach" i]',
        'div[role="button"][aria-label*="Upload" i]',
      ]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([
        'button:has-text("Instant Mode")',
        'button:has-text("Expert Mode")',
        'div[role="button"]:has-text("Instant Mode")',
        'div[role="button"]:has-text("Expert Mode")',
      ]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        'textarea#chat-input',
      ]),
      loginIndicators: Object.freeze([
        'input[placeholder="Phone number / email address"]',
        'input[type="password"][placeholder="Password"]',
        'div[role="button"]:has-text("Log in")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="captcha" i]',
        '[aria-label*="captcha" i]',
        'text=/server is busy|server busy|please try again later/i',
        'text=/rate limit|too many requests/i',
      ]),
      busySelectors: Object.freeze([
        'button[aria-label*="Stop" i]',
        'div[role="button"][aria-label*="Stop" i]',
        '.ds-loading',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }

  protected override async inspectAccount(page: Page, signal: AbortSignal | undefined) {
    await waitForVisibleLocator(
      page,
      [
        ...this.definition.loginIndicators,
        ...this.definition.authIndicators,
        ...this.definition.composerSelectors,
      ],
      DEEPSEEK_SESSION_HYDRATION_TIMEOUT_MS,
    )
    return await super.inspectAccount(page, signal)
  }
}
