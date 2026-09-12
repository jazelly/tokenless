import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

export class LovableProvider extends BaseProvider<'lovable'> {
  constructor() {
    super(defineProvider({
      descriptor: defineDescriptor({
        id: 'lovable',
        label: 'Lovable',
        stage: 'experimental',
        setupOrder: 16,
        subscriptionSupport: 'unsupported',
        navigation: PROVIDER_NAVIGATION_CATALOG.lovable,
        controls: Object.freeze({ chatSurface: false }),
      }),
      access: Object.freeze({ guest: 'unsupported', guestContinueControlNames: Object.freeze([]) }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        '[contenteditable="true"][aria-label="Chat input"]',
        '[contenteditable="true"][aria-label="Ask Lovable..."]',
      ]),
      submitSelectors: Object.freeze([
        'button[data-testid="chat-input-send-button"]',
        'button[data-testid="chat-input-send"]',
      ]),
      answerSelectors: Object.freeze([
        '[data-testid="agent-message"]:has([data-testid="agent-message-toolbar"]) > [data-selectable="true"]',
      ]),
      authIndicators: Object.freeze(['button[data-testid="workspace-menu-trigger"]']),
      loginIndicators: Object.freeze(['a[href="/signup"]', 'button:has-text("Continue with GitHub")']),
      busySelectors: Object.freeze([
        '[data-testid="agent-message"]:not(:has([data-testid="agent-message-toolbar"]))',
      ]),
      blockerSelectors: Object.freeze([]),
      fileInputSelectors: Object.freeze([]),
      fileUploadTriggerSelectors: Object.freeze([]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    }))
  }
}
