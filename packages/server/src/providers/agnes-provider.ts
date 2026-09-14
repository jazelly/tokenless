import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderDomDefinition } from './provider-definition.js'

class AgnesAccountInspector extends MenuTextAccountInspector {
  override async inspect(page: Page, provider: ProviderDomDefinition, accountControl: Locator, signal: AbortSignal | undefined) {
    const menu = page.locator('.ant-dropdown.dropdown-container-bg:not(.ant-dropdown-hidden)').last()
    const alreadyOpen = await menu.isVisible()
    if (!alreadyOpen) await accountControl.click({ timeout: 2_000 })
    try {
      await menu.waitFor({ state: 'visible', timeout: 2_000 })
      return await super.inspect(page, provider, menu, signal)
    } finally {
      if (!alreadyOpen) await accountControl.click({ timeout: 2_000 })
    }
  }
}

export class AgnesProvider extends BaseProvider<'agnes'> {
  constructor() {
    super(defineProvider({
      descriptor: defineDescriptor({
        id: 'agnes',
        label: 'Agnes AI',
        stage: 'experimental',
        setupOrder: 18,
        subscriptionSupport: 'supported',
        navigation: PROVIDER_NAVIGATION_CATALOG.agnes,
        controls: Object.freeze({ chatSurface: false }),
        executionModes: Object.freeze(['browser']),
      }),
      access: Object.freeze({ guest: 'supported', guestContinueControlNames: Object.freeze([]) }),
      account: Object.freeze({
        inspector: new AgnesAccountInspector(),
        freePlanLabels: Object.freeze(['Free']),
        paidPlanLabels: Object.freeze(['Starter', 'Plus', 'Pro']),
      }),
      composerSelectors: Object.freeze(['[contenteditable="true"][data-lexical-editor="true"][role="textbox"]']),
      submitSelectors: Object.freeze(['button[title="Send"]']),
      answerSelectors: Object.freeze(['.animate-message-in:not(.justify-end) .prose-agent']),
      busySelectors: Object.freeze(['button[title="Cancel"]', '.animate-message-in [role="status"]']),
      fileInputSelectors: Object.freeze(['input[type="file"][name="file"]']),
      fileUploadTriggerSelectors: Object.freeze([]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze(['.ant-dropdown-trigger:has(img[alt="avatar"])']),
      loginIndicators: Object.freeze([]),
      blockerSelectors: Object.freeze([]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    }))
  }
}
