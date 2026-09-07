import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

export class MicrosoftCopilotProvider extends BaseProvider<'microsoft-copilot'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'microsoft-copilot',
      label: 'Microsoft Copilot',
      stage: 'experimental',
      setupOrder: 13,
      subscriptionSupport: 'unsupported',
      navigation: PROVIDER_NAVIGATION_CATALOG['microsoft-copilot'],
      controls: Object.freeze({
        chatSurface: true,
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
        'textarea#userInput[data-testid="composer-input"]',
      ]),
      submitSelectors: Object.freeze([
        'button[aria-label="Submit message"]',
      ]),
      answerSelectors: Object.freeze([
        'div[data-testid="ai-message-body"]',
      ]),
      fileInputSelectors: Object.freeze([
        'input[data-testid="composer-file-input"][type="file"][multiple]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        '#composer-create-button',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[data-testid="add-images-files"]',
      ]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        'button[data-testid="sidebar-settings-button"][role="tab"][title="Account"]',
      ]),
      loginIndicators: Object.freeze([
        'button[title="Sign in with Microsoft"]',
        'button[title="Sign in with Apple"]',
        'button[title="Sign in with Google"]',
      ]),
      blockerSelectors: Object.freeze([]),
      busySelectors: Object.freeze([
        'button[data-testid="stop-button"]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }
}
