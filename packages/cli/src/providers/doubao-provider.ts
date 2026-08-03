import { BaseProvider } from './base-provider.js'
import { DoubaoAccountInspector } from './doubao-account-inspector.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import type { ProviderExecutionContext } from './execution-context.js'
import type { Page } from 'playwright-core'
import {
  DoubaoAttachmentCapability,
  DoubaoModeCapability,
  DoubaoSkillCapability,
} from './capabilities/doubao-controls.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

export class DoubaoProvider extends BaseProvider<'doubao'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'doubao',
      label: 'Doubao / 豆包',
      stage: 'experimental',
      setupOrder: 8,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.doubao,
      profileImport: Object.freeze({
        cookieDomains: Object.freeze(['doubao.com']),
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
        inspector: new DoubaoAccountInspector(),
        freePlanLabels: Object.freeze(['免费版']),
        paidPlanLabels: Object.freeze(['标准套餐', '加强套餐', '高级套餐']),
      }),
      composerSelectors: Object.freeze([
        'textarea.semi-input-textarea',
      ]),
      submitSelectors: Object.freeze([
        'button.bg-dbx-text-highlight[aria-label=""]',
      ]),
      answerSelectors: Object.freeze([
        'div[data-message-id].grid',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"][multiple][accept*=".pdf"][accept*="py"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'div.max-w-full.min-w-0.flex-1.relative.flex.items-center.h-36 > div:first-child > button[data-dbx-name="button"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        '#flow_chat_sidebar button.w-full.h-full:has(img)',
      ]),
      loginIndicators: Object.freeze([
        'text=/受区域限制，请先登录再使用豆包/',
        'text=/^登录$/',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="rmc.bytedance.com/verifycenter/captcha" i]',
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/请求过于频繁|稍后再试|服务繁忙|达到.*上限|额度已用完/',
      ]),
      busySelectors: Object.freeze([
        'div.flex.flex-col.flex-grow.max-w-full.min-w-0:has(> div[data-message-id].grid):not(:has(button[aria-label="朗读"]))',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities({ doubaoControls: true }),
    })
    super(provider, {
      fileUpload: new DoubaoAttachmentCapability(provider),
      extensions: Object.freeze([
        new DoubaoModeCapability(provider),
        new DoubaoSkillCapability(provider),
      ]),
    })
  }

  protected override async submitPrompt(page: Page, context: ProviderExecutionContext) {
    await page.waitForTimeout(400)
    return await super.submitPrompt(page, context)
  }
}
