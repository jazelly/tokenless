import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'

export class ZaiProvider extends BaseProvider<'zai'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'zai',
      label: 'Z.ai / GLM',
      stage: 'experimental',
      setupOrder: 7,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: Object.freeze({
        homeUrl: 'https://chat.z.ai/',
        origins: Object.freeze(['https://chat.z.ai']),
        trustedSignInOrigins: Object.freeze([]),
      }),
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['z.ai']),
      }),
      controls: Object.freeze({
        chatSurface: false,
      }),
    })
    const provider = defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'supported',
        guestContinueControlNames: Object.freeze(['Skip for now']),
      }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        '#chat-input[placeholder="How can I help you today?"]',
      ]),
      submitSelectors: Object.freeze([
        'button.sendMessageButton[type="submit"]',
      ]),
      answerSelectors: Object.freeze([
        '.chat-assistant.markdown-prose',
      ]),
      fileInputSelectors: Object.freeze([]),
      fileUploadTriggerSelectors: Object.freeze([]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([]),
      loginIndicators: Object.freeze([
        'button:has-text("Continue with Google")',
        'button:has-text("Continue with Email")',
        'button:has-text("Continue with Github")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/rate limit|too many requests/i',
        'text=/service unavailable|server is busy/i',
        'text=/upgrade required|upgrade your plan/i',
      ]),
      busySelectors: Object.freeze([
        'div[class*="message-"]:has(.chat-assistant.markdown-prose):not(:has(button.regenerate-response-button))',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }
}
