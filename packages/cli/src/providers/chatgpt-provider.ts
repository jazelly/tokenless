import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  createBaseProviderCapabilities,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { MenuTextAccountInspector } from './account-inspectors.js'

export class ChatGptProvider extends BaseProvider<'chatgpt'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'chatgpt',
      label: 'ChatGPT',
      stage: 'supported',
      setupOrder: 0,
      navigation: Object.freeze({
        homeUrl: 'https://chatgpt.com/',
        origins: Object.freeze(['https://chatgpt.com', 'https://chat.openai.com']),
        trustedSignInOrigins: Object.freeze([
          Object.freeze({ origin: 'https://accounts.google.com' }),
          Object.freeze({ origin: 'https://auth.openai.com' }),
          Object.freeze({ origin: 'https://auth0.openai.com' }),
          Object.freeze({ origin: 'https://login.openai.com' }),
        ]),
      }),
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['chatgpt.com', 'openai.com']),
      }),
      controls: Object.freeze({
        chatSurface: true,
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
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze(['Free']),
        paidPlanLabels: Object.freeze(['Go', 'Plus', 'Pro', 'Team', 'Business', 'Enterprise']),
      }),
      composerSelectors: Object.freeze([
        'div#prompt-textarea[contenteditable="true"]',
        '#prompt-textarea[contenteditable="true"]',
        '[data-testid="composer"] [contenteditable="true"]',
        'div[contenteditable="true"][data-id="root"]',
        'div.ProseMirror[contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'textarea[placeholder*="Message" i]',
        'textarea[data-testid="prompt-textarea"]',
        'textarea',
      ]),
      submitSelectors: Object.freeze([
        'button[data-testid="send-button"]',
        'button[data-testid="composer-send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
        'button[type="submit"]',
      ]),
      answerSelectors: Object.freeze([
        '[data-message-author-role="assistant"]',
        'article[data-testid*="conversation-turn"]',
        'main article',
      ]),
      fileInputSelectors: Object.freeze([
        'input#upload-files[type="file"]',
        'input[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[data-testid="composer-plus-btn"][aria-label="Add files and more"]',
        'button[aria-label="Add files and more"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[role="menuitem"]:has-text("Upload from computer")',
        '.__menu-item:has-text("Upload from computer")',
      ]),
      modelControlSelectors: Object.freeze([
        'button[data-testid="model-switcher-dropdown-button"]',
        'button[aria-label*="model" i]',
        'button:has-text("GPT")',
      ]),
      effortControlSelectors: Object.freeze([
        'button[aria-label*="thinking" i]',
        'button:has-text("Thinking")',
      ]),
      authIndicators: Object.freeze([
        '[data-testid="accounts-profile-button"][role="button"]:not([aria-label="Open profile menu"])',
      ]),
      loginIndicators: Object.freeze([
        'a[href*="/auth/login"]',
        'button:has-text("Log in")',
        'button:has-text("Sign up")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="captcha"]',
        '[aria-label*="captcha" i]',
        'text=/rate limit|too many requests/i',
        'text=/upgrade required|upgrade your plan/i',
      ]),
      busySelectors: Object.freeze([
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop generating" i]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider, createBaseProviderCapabilities(provider))
  }
}
