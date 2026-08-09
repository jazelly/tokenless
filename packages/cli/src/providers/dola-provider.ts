import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

export class DolaProvider extends BaseProvider<'dola'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'dola',
      label: 'Dola',
      stage: 'experimental',
      setupOrder: 10,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.dola,
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['dola.com']),
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
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze(['Pro']),
      }),
      composerSelectors: Object.freeze([
        'textarea.semi-input-textarea[placeholder="Message..."]',
      ]),
      submitSelectors: Object.freeze([
        '.send-btn-wrapper > button:not([disabled])',
      ]),
      answerSelectors: Object.freeze([
        '[data-render-engine="node"]:not(.justify-end) [data-streaming].md-box-root',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"][multiple][accept*=".md"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'div.max-w-full.min-w-0.flex-1.relative.flex.items-center.h-36 > div:first-child button[data-dbx-name="button"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([
        'button[data-slot="dropdown-menu-trigger"]:has-text("Fast")',
        'button[data-slot="dropdown-menu-trigger"]:has-text("Pro")',
      ]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        'button[aria-haspopup="menu"]:has(img)',
      ]),
      loginIndicators: Object.freeze([
        'button:has-text("Log in")',
        'button:has-text("Sign in")',
        'button:has-text("Continue with Google")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/rate limit|too many requests|service unavailable|server is busy/i',
        'text=/upgrade required|upgrade your plan/i',
      ]),
      busySelectors: Object.freeze([
        '[data-render-engine="node"]:not(.justify-end) [data-streaming="true"].md-box-root',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }
}
