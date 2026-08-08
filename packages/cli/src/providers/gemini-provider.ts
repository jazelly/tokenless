import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { GeminiAccountInspector } from './gemini-account-inspector.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

export class GeminiProvider extends BaseProvider<'gemini'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'gemini',
      label: 'Gemini',
      stage: 'supported',
      setupOrder: 2,
      protocolCompatibility: Object.freeze({
        legacyRequests: true,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.gemini,
      profileImport: Object.freeze({
        cookieDomains: Object.freeze([]),
      }),
      controls: Object.freeze({
        chatSurface: false,
      }),
    })
    const provider = defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'supported',
        guestContinueControlNames: Object.freeze([
          'Continue as guest',
          'Stay in guest mode',
          'Continue without signing in',
          'Continue without an account',
          'Use without an account',
        ]),
      }),
      account: Object.freeze({
        inspector: new GeminiAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        'rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea',
      ]),
      submitSelectors: Object.freeze([
        'button[aria-label="Send message"]',
      ]),
      answerSelectors: Object.freeze([
        'response-container message-content',
        'message-content',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"][name="Filedata"]',
        'input[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[aria-label="Upload and tools"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        'button[role="menuitem"][data-test-id="local-images-files-uploader-button"][aria-label^="Upload files"]',
        '[role="menuitem"][aria-label^="Upload files"]',
        '[role="menuitem"]:has-text("Upload files")',
      ]),
      modelControlSelectors: Object.freeze([
        'button[data-test-id="bard-mode-menu-button"]',
        'button[aria-label*="model" i]',
        'button:has-text("Gemini")',
      ]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        'a[href*="accounts.google.com/SignOutOptions"]',
        'a[href="/search"][aria-label="Search chats"]',
      ]),
      loginIndicators: Object.freeze([
        'a[href*="accounts.google.com/ServiceLogin"]',
        'a[href*="/signin"]',
        'a[aria-label="Sign in"]',
        'button[aria-label="Sign in"]',
        'button:has-text("Sign in")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src^="https://www.google.com/recaptcha/"][title="reCAPTCHA"]',
        'text=/rate limit|too many requests/i',
        'text=/upgrade required|upgrade your plan/i',
      ]),
      busySelectors: Object.freeze([
        'button[aria-label="Stop response"]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }
}
