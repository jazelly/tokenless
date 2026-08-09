import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { MenuTextAccountInspector } from './account-inspectors.js'
import { waitForVisibleLocator } from './dom-locators.js'
import {
  DeepSeekAttachmentCapability,
  DeepSeekModeCapability,
  DeepSeekToggleCapability,
} from './capabilities/deepseek-controls.js'
import type { Page } from 'playwright-core'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

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
      navigation: PROVIDER_NAVIGATION_CATALOG.deepseek,
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
        freePlanLabels: Object.freeze(['Free']),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        'textarea[placeholder="Message DeepSeek"]',
      ]),
      submitSelectors: Object.freeze([
        'div.ds-button.ds-button--primary.ds-button--filled:not(.ds-button--disabled)',
      ]),
      answerSelectors: Object.freeze([
        '.ds-markdown.ds-assistant-message-main-content',
        '.ds-message > .ds-markdown',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"][multiple][accept*=".md"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'div.ds-button.ds-button--iconLabelPrimary',
      ]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        'textarea[name="search"][placeholder="Message DeepSeek"]',
      ]),
      loginIndicators: Object.freeze([
        'input[placeholder="Phone number / email address"]',
        'input[type="password"][placeholder="Password"]',
        'div[role="button"]:has-text("Log in")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="hcaptcha.com" i]',
        'iframe[title*="hcaptcha" i]',
        '.h-captcha',
        'text=/server is busy|server busy|please try again later/i',
        'text=/rate limit|too many requests/i',
      ]),
      busySelectors: Object.freeze([
        'button[aria-label*="Stop" i]',
        'div[role="button"][aria-label*="Stop" i]',
        '.ds-loading',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities({ deepSeekControls: true }),
    })
    super(provider, {
      fileUpload: new DeepSeekAttachmentCapability(provider),
      extensions: Object.freeze([
        new DeepSeekModeCapability(provider),
        new DeepSeekToggleCapability(provider, 'DeepThink'),
        new DeepSeekToggleCapability(provider, 'Search'),
      ]),
    })
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
