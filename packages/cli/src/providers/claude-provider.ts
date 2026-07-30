import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { MenuTextAccountInspector } from './account-inspectors.js'
import { NativeProjectWorkspaceCapability } from './capabilities/native-project-workspace.js'

export class ClaudeProvider extends BaseProvider<'claude'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'claude',
      label: 'Claude',
      stage: 'supported',
      setupOrder: 1,
      protocolCompatibility: Object.freeze({
        legacyRequests: true,
      }),
      navigation: Object.freeze({
        homeUrl: 'https://claude.ai/new',
        origins: Object.freeze(['https://claude.ai']),
        trustedSignInOrigins: Object.freeze([
          Object.freeze({ origin: 'https://accounts.google.com' }),
        ]),
      }),
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['claude.ai', 'anthropic.com']),
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
        freePlanLabels: Object.freeze(['Free']),
        paidPlanLabels: Object.freeze(['Pro', 'Max', 'Team', 'Enterprise']),
      }),
      composerSelectors: Object.freeze([
        'div[data-testid="chat-input"][contenteditable="true"][role="textbox"]',
        'div[aria-label="Write your prompt to Claude"][contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][role="textbox"]',
        'div.ProseMirror[contenteditable="true"]',
        'textarea',
      ]),
      submitSelectors: Object.freeze([
        'button[data-cds="Button"][aria-label="Send message"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
        'button[type="submit"]',
      ]),
      answerSelectors: Object.freeze([
        '[data-testid="virtual-message-list"] .font-claude-response-body',
        'main .font-claude-response-body',
        '.font-claude-response-body',
      ]),
      fileInputSelectors: Object.freeze([
        'input#chat-input-file-upload-onpage[data-testid="file-upload"][type="file"]',
        'input[data-testid="file-upload"][type="file"]',
        'input[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[aria-label="Add files, connectors, and more"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[role="menuitem"]:has-text("Add files or photos")',
      ]),
      modelControlSelectors: Object.freeze([
        'button[aria-label*="model" i]',
        'button:has-text("Claude")',
      ]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        'button[data-testid="user-menu-button"]',
      ]),
      loginIndicators: Object.freeze([
        'button[data-testid="login-with-google"]',
        'input[placeholder="Enter your email"]',
        'button:has-text("Continue")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="captcha"]',
        'iframe[src*="challenges.cloudflare.com"]',
        'input[placeholder="Enter your email"]',
        'text=/rate limit|too many requests/i',
        'text=/upgrade required|upgrade your plan/i',
      ]),
      busySelectors: Object.freeze([
        '[data-testid="virtual-message-list"] [data-is-streaming="true"]',
        'button[aria-label*="Stop" i]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities({ nativeWorkspace: true }),
    })
    super(provider, {
      workspace: new NativeProjectWorkspaceCapability(provider, {
        listUrl: 'https://claude.ai/projects',
        projectPath: /^\/project\/(?<resourceId>[A-Za-z0-9_-]+)(?:\/|$)/u,
        projectLinkSelectors: Object.freeze([
          'ul[aria-label="Projects"] a[href*="/project/"]',
          'a[href*="/project/"]',
        ]),
        createTriggerSelectors: Object.freeze([
          'button:has-text("New project")',
          'button:has-text("Create project")',
        ]),
        nameInputSelectors: Object.freeze([
          'input[aria-label="Project name"]',
          'input[placeholder*="project name" i]',
          '[role="dialog"] input[type="text"]',
        ]),
        instructionsInputSelectors: Object.freeze([
          'textarea[aria-label*="project instructions" i]',
          'textarea[placeholder*="instructions" i]',
          '[role="dialog"] textarea',
        ]),
        createSubmitSelectors: Object.freeze([
          '[role="dialog"] button:has-text("Create project")',
          '[role="dialog"] button:has-text("Create")',
        ]),
        instructionOpenSelectors: Object.freeze([
          'button:has-text("Set project instructions")',
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
