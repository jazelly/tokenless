import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import {
  KimiEffortChoiceCapability,
  KimiLibraryChoiceCapability,
  KimiModelChoiceCapability,
  KimiSearchChoiceCapability,
} from './capabilities/kimi-controls.js'
import { NativeProjectWorkspaceCapability } from './capabilities/native-project-workspace.js'

export class KimiProvider extends BaseProvider<'kimi'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'kimi',
      label: 'Kimi',
      stage: 'experimental',
      setupOrder: 9,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.kimi,
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['kimi.com']),
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
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        '.chat-input-editor[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea[placeholder*="Ask" i]',
        'textarea[placeholder*="Kimi" i]',
      ]),
      submitSelectors: Object.freeze([
        '.send-button-container:not(.disabled)',
        'button[type="submit"]',
        'button[aria-label*="Send" i]',
      ]),
      answerSelectors: Object.freeze([
        '.chat-content-item-assistant .markdown-container:not(.toolcall-content-text)',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        '.project-knowledge .knowledge-upload-action',
        '.toolkit-trigger-btn',
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        'label.toolkit-item:has-text("Add files & photos")',
        '[role="menuitem"]:has-text("Upload")',
        'button:has-text("Upload")',
      ]),
      modelControlSelectors: Object.freeze([
        '.current-model',
      ]),
      effortControlSelectors: Object.freeze([
        '.current-model .current-effort',
      ]),
      authIndicators: Object.freeze([
        'button.user-profile-trigger',
        'button[aria-label*="Account" i]',
        'button[aria-label*="Profile" i]',
        '[data-testid*="avatar" i]',
      ]),
      loginIndicators: Object.freeze([
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/rate limit|too many requests/i',
        'text=/Too many people are chatting with Kimi right now/i',
        'text=/Subscribe to enter a dedicated priority queue/i',
      ]),
      busySelectors: Object.freeze([
        '.send-button-container.stop',
        'button[aria-label*="Stop" i]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities({ nativeWorkspace: true, kimiControls: true }),
    })
    super(provider, {
      modelChoice: new KimiModelChoiceCapability(provider),
      effortChoice: new KimiEffortChoiceCapability(provider),
      workspace: new NativeProjectWorkspaceCapability(provider, {
        createTriggerActivation: 'dom',
        instructionActivation: 'dom',
        listUrl: 'https://www.kimi.com/',
        projectPath: /^\/project\/(?<resourceId>[A-Za-z0-9_-]+)\/?$/u,
        projectLinkSelectors: Object.freeze([
          'a.next-sidebar-project-item[href^="/project/"]',
        ]),
        createTriggerSelectors: Object.freeze([
          'button.next-sidebar-project-list__create',
        ]),
        nameInputSelectors: Object.freeze([
          'input.project-create-input[placeholder="Give it a name"]',
        ]),
        instructionsInputSelectors: Object.freeze([
          '.project-prompt-edit-modal textarea.prompt-editor',
        ]),
        createSubmitSelectors: Object.freeze([
          'button.project-create-submit',
        ]),
        instructionOpenSelectors: Object.freeze([
          '.project-knowledge .knowledge-action',
        ]),
        instructionSaveSelectors: Object.freeze([
          '.project-prompt-edit-modal button.confirm-btn',
        ]),
        stableUnavailableSelectors: Object.freeze([
          'text=/Projects are unavailable|Project is unavailable/i',
        ]),
      }),
      extensions: Object.freeze([
        new KimiSearchChoiceCapability(),
        new KimiLibraryChoiceCapability('kimi.plugin'),
        new KimiLibraryChoiceCapability('kimi.skill'),
      ]),
    })
  }
}
