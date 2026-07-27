import { BaseProvider } from './base-provider.js'
import {
  createBaseProviderCapabilities,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { GrokEntitlementAccountInspector } from './grok-account-inspector.js'
import { GrokChoiceAvailability } from './grok-choice-availability.js'

export class GrokProvider extends BaseProvider<'grok'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'grok',
      label: 'Grok',
      stage: 'supported',
      setupOrder: 3,
      navigation: Object.freeze({
        homeUrl: 'https://grok.com/',
        origins: Object.freeze(['https://grok.com']),
        trustedSignInOrigins: Object.freeze([]),
      }),
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['grok.com', 'x.ai']),
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
        inspector: new GrokEntitlementAccountInspector(),
        freePlanLabels: Object.freeze(['Free']),
        paidPlanLabels: Object.freeze(['SuperGrok']),
      }),
      composerSelectors: Object.freeze([
        'div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]',
        'textarea[aria-label="Ask Grok anything"][placeholder="What do you want to know?"]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea',
      ]),
      submitSelectors: Object.freeze([
        'button[data-testid="chat-submit"][aria-label="Submit"][type="submit"]',
        'button[aria-label*="Submit" i]',
      ]),
      answerSelectors: Object.freeze([
        'div[data-testid="assistant-message"]',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"][name="files"]',
        'input[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[data-testid="attach-button"][aria-label="Attach"]',
        'button[aria-label="Attach"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[role="menuitem"]:has-text("Upload a file")',
      ]),
      modelControlSelectors: Object.freeze([
        'button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]',
        'button[aria-label*="model" i]',
        'button:has-text("Grok")',
      ]),
      effortControlSelectors: Object.freeze([
        'button[aria-label*="thinking" i]',
        'button:has-text("Think")',
      ]),
      authIndicators: Object.freeze([
        'button:has(img[alt="pfp"])',
      ]),
      loginIndicators: Object.freeze([
        'div[data-testid="anon-paywall-sign-up-card"]',
        'button:has-text("Sign in")',
      ]),
      blockerSelectors: Object.freeze([
        'div[data-testid="anon-paywall-sign-up-card"]',
        'text=/rate limit|too many requests/i',
        'text=/upgrade required|upgrade your plan/i',
      ]),
      busySelectors: Object.freeze([]),
      choiceAvailability: new GrokChoiceAvailability(),
      capabilities: providerCapabilities(),
    })
    super(provider, createBaseProviderCapabilities(provider))
  }
}
