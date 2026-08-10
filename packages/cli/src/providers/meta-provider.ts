import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

export class MetaProvider extends BaseProvider<'meta'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'meta',
      label: 'Meta AI',
      stage: 'experimental',
      setupOrder: 12,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.meta,
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
        'textarea[data-testid="composer-input"]',
        '[data-testid="composer-input"][contenteditable="true"]',
      ]),
      submitSelectors: Object.freeze([
        '[data-testid="composer-send-button"]',
      ]),
      answerSelectors: Object.freeze([
        '[data-testid="assistant-message"]',
      ]),
      fileInputSelectors: Object.freeze([
        '[data-testid="composer-attachment-dropzone"] input[type="file"][multiple]',
        'input[type="file"][multiple]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        '[data-testid="composer-add-attachment-button"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[data-testid="composer-attachment-dropzone"]',
      ]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([
        '[data-testid="composer-mode-dropdown-button"]',
      ]),
      authIndicators: Object.freeze([
        '[data-testid="user-menu-button"]',
      ]),
      loginIndicators: Object.freeze([]),
      blockerSelectors: Object.freeze([
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/rate limit|too many requests|service unavailable/i',
      ]),
      busySelectors: Object.freeze([
        '[data-testid="composer-stop-button"]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }
}
