import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

export class HuggingChatProvider extends BaseProvider<'hugging-face'> {
  constructor() {
    super(defineProvider({
      descriptor: defineDescriptor({
        id: 'hugging-face',
        label: 'HuggingChat',
        stage: 'experimental',
        setupOrder: 15,
        subscriptionSupport: 'supported',
        navigation: PROVIDER_NAVIGATION_CATALOG['hugging-face'],
        controls: Object.freeze({ chatSurface: false }),
      }),
      access: Object.freeze({ guest: 'unsupported', guestContinueControlNames: Object.freeze([]) }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([]),
      submitSelectors: Object.freeze([]),
      answerSelectors: Object.freeze([]),
      fileInputSelectors: Object.freeze([]),
      fileUploadTriggerSelectors: Object.freeze([]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([]),
      loginIndicators: Object.freeze([]),
      blockerSelectors: Object.freeze([]),
      busySelectors: Object.freeze([]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    }))
  }
}
