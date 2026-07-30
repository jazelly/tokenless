import { BaseProvider } from './base-provider.js'
import {
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { GrokEntitlementAccountInspector } from './grok-account-inspector.js'
import { GrokChoiceAvailability } from './grok-choice-availability.js'
import { NativeProjectWorkspaceCapability } from './capabilities/native-project-workspace.js'

export class GrokProvider extends BaseProvider<'grok'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'grok',
      label: 'Grok',
      stage: 'supported',
      setupOrder: 3,
      protocolCompatibility: Object.freeze({
        legacyRequests: true,
      }),
      navigation: Object.freeze({
        homeUrl: 'https://grok.com/',
        origins: Object.freeze(['https://grok.com']),
        trustedSignInOrigins: Object.freeze([
          Object.freeze({
            origin: 'https://accounts.x.ai',
            pathPrefixes: Object.freeze(['/check-login']),
          }),
        ]),
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
      capabilities: providerCapabilities({ nativeWorkspace: true }),
    })
    super(provider, {
      workspace: new NativeProjectWorkspaceCapability(provider, {
        listUrl: 'https://grok.com/',
        projectPath: /^\/(?:project|projects)\/(?<resourceId>[A-Za-z0-9_-]+)(?:\/|$)/u,
        projectLinkSelectors: Object.freeze([
          'a[href*="/project/"]',
          'a[href*="/projects/"]',
        ]),
        createTriggerSelectors: Object.freeze([
          'button:has-text("New Project")',
          'button:has-text("Create Project")',
          'a:has-text("New Project")',
        ]),
        nameInputSelectors: Object.freeze([
          'input[aria-label="Project name"]',
        ]),
        instructionsInputSelectors: Object.freeze([
          'textarea[aria-label="Project Instructions"]',
          'textarea[placeholder*="instructions" i]',
        ]),
        createSubmitSelectors: Object.freeze([
          '[role="dialog"][aria-label="New Project"] button:has-text("Next")',
          '[role="dialog"] button:has-text("Create Project")',
          '[role="dialog"] button:has-text("Create")',
        ]),
        instructionOpenSelectors: Object.freeze([
          'button:has-text("Project Instructions")',
          'button:has-text("Add instructions")',
          'button:has-text("Edit instructions")',
        ]),
        instructionSaveSelectors: Object.freeze([
          '[role="dialog"] button:has-text("Save")',
          'button:has-text("Save instructions")',
        ]),
        stableUnavailableSelectors: Object.freeze([
          'text=/projects (?:are )?(?:not available|unavailable) on your plan/i',
          'text=/upgrade to (?:create|use) projects/i',
        ]),
      }),
    })
  }
}
