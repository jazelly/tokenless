import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'

export class GitHubCopilotProvider extends BaseProvider<'github-copilot'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'github-copilot',
      label: 'GitHub Copilot',
      stage: 'experimental',
      setupOrder: 14,
      subscriptionSupport: 'supported',
      navigation: PROVIDER_NAVIGATION_CATALOG['github-copilot'],
      controls: Object.freeze({ chatSurface: false }),
    })
    super(defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'unsupported',
        guestContinueControlNames: Object.freeze([]),
      }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze(['Copilot Free']),
        paidPlanLabels: Object.freeze(['Copilot Pro', 'Copilot Pro+', 'Copilot Business', 'Copilot Enterprise']),
      }),
      composerSelectors: Object.freeze(['textarea#copilot-chat-textarea']),
      submitSelectors: Object.freeze(['button:has(svg.octicon-paper-airplane)']),
      answerSelectors: Object.freeze(['[class*="ChatMessage-module__ai__"] .markdown-body']),
      fileInputSelectors: Object.freeze(['input#image-uploader[type="file"][multiple]']),
      fileUploadTriggerSelectors: Object.freeze(['[data-testid="attachment-menu-button"]']),
      fileUploadLocalSelectors: Object.freeze(['[role="menuitem"]:has-text("Upload from computer")']),
      modelControlSelectors: Object.freeze(['button[class*="ModelPicker-module__menuButton"]']),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze(['button[aria-label*="Copilot Pro"]']),
      loginIndicators: Object.freeze(['input#login_field', 'a[href^="/login"]']),
      blockerSelectors: Object.freeze([]),
      busySelectors: Object.freeze(['form button:has(svg.octicon-square-fill)']),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    }))
  }

  protected override async clearPrompt(page: Page, context: ProviderExecutionContext) {
    const result = await super.clearPrompt(page, context)
    const cards = page.locator('form [role="toolbar"][aria-label="Attachments"] a[class*="ReferenceToken-module__referenceToken"]')
      .filter({ visible: true })
    const count = await cards.count()
    for (let index = 0; index < count; index += 1) {
      const card = cards.first()
      const name = await card.locator('[class*="ReferenceToken-module__name__"]').innerText()
      await card.locator('button').click({ timeout: 5000 })
      await cards.filter({ hasText: name }).waitFor({ state: 'hidden', timeout: 5000 })
    }
    return result
  }
}
