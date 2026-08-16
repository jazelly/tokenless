import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { MenuTextAccountInspector } from './account-inspectors.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import { tokenlessError } from '../playwright/errors.js'
import { persistChatGptImageAsset } from '../playwright/image-assets.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { VisibleActionResult } from '../playwright/actions.js'

const CHATGPT_ASSISTANT_SELECTOR = 'section[data-turn="assistant"]'
const CHATGPT_IMAGE_SELECTOR = '[id^="image-"] img'
const CHATGPT_BUSY_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop generating" i]'

export class ChatGptProvider extends BaseProvider<'chatgpt'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'chatgpt',
      label: 'ChatGPT',
      stage: 'supported',
      setupOrder: 0,
      protocolCompatibility: Object.freeze({
        legacyRequests: true,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.chatgpt,
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
        'section[data-turn="assistant"]',
        '[data-message-author-role="assistant"]',
        'article[data-testid*="conversation-turn"]',
        'main article',
      ]),
      fileInputSelectors: Object.freeze([
        'input#upload-files[type="file"]',
        'input[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[data-testid="composer-plus-btn"]',
        'button[aria-label="Add files and more"]',
        'button[aria-label*="Add photos" i]',
        'button[aria-label*="Add files" i]',
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[role="menuitem"]:has-text("Upload from computer")',
        '.__menu-item:has-text("Upload from computer")',
        '[role="menuitem"]:has-text("Add photos & files")',
        '[role="menuitem"]:has-text("Add photos and files")',
        '[role="menuitem"]:has-text("Add files or photos")',
        '[role="menuitem"]:has-text("Add files")',
        '[role="menuitem"]:has-text("Upload files")',
        'button[role="menuitem"][aria-label*="Upload files" i]',
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
      capabilities: providerCapabilities({ imageGeneration: true }),
    })
    super(provider)
  }

  protected override async readResponse(
    page: Page,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    if (context.requirements?.includes('image.generation') === true) {
      return await readChatGptImageResponse(page, context)
    }
    return super.readResponse(page, context)
  }
}

async function readChatGptImageResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  const visible = await waitForStableChatGptImageResponse(page, context.signal)
  if (!visible) {
    throw tokenlessError(
      'chatgpt_image_response_not_visible',
      'No ChatGPT image result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-chatgpt-image-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'chatgpt_image_response_unstable',
      'ChatGPT did not expose a stable completed image before the read deadline.',
      { retryable: true, details: { visibleProof: 'chatgpt-image-result-not-stable' } },
    )
  }
  if (!context.assetRoot) {
    throw tokenlessError(
      'chatgpt_image_asset_unavailable',
      'ChatGPT image generation requires a Tokenless asset root before the job can complete.',
      { retryable: false },
    )
  }
  const text = visible.text.slice(0, 32_000)
  if (text) context.captureVisibleOutput?.(text)
  const assets = await Promise.all(visible.artifacts.map((artifact, index) => persistChatGptImageAsset(page, artifact, {
    assetRoot: context.assetRoot!,
    jobId: context.jobId ?? context.operationId,
    taskId: context.taskId ?? null,
    provider: 'chatgpt',
    now: context.now,
    signal: context.signal,
  }, index)))
  const visibleBusyCount = await visibleChatGptBusyCount(page)
  return {
    text,
    citations: [],
    artifacts: assets,
    visibleProof: 'visible-chatgpt-current-turn-image-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount,
      generationStopVisible: visibleBusyCount > 0,
    },
  }
}

async function waitForStableChatGptImageResponse(
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 180_000
  let previous = ''
  let stableObservations = 0
  let latest: Awaited<ReturnType<typeof observeChatGptImageResponse>> & { terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
    const observed = await observeChatGptImageResponse(page)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.artifacts)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleChatGptBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeChatGptImageResponse(page: Page) {
  const assistant = currentChatGptImageAssistant(page)
  if (!await assistant.isVisible().catch(() => false)) return null
  const artifacts = await assistant.locator(CHATGPT_IMAGE_SELECTOR).filter({ visible: true }).evaluateAll((images) => {
    const seen = new Set<string>()
    return images
      .slice(0, 16)
      .flatMap((image) => {
        if (!(image instanceof HTMLImageElement)) return []
        const source = image.currentSrc || image.src
        let parsed: URL
        try {
          parsed = new URL(source, document.baseURI)
          if (parsed.protocol !== 'https:') return []
          parsed.hash = ''
        } catch {
          return []
        }
        const url = parsed.toString()
        if (seen.has(url) || image.naturalWidth < 1 || image.naturalHeight < 1) return []
        seen.add(url)
        let mediaType: string | null = null
        const pathname = parsed.pathname.toLowerCase()
        if (pathname.endsWith('.png')) mediaType = 'image/png'
        else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mediaType = 'image/jpeg'
        else if (pathname.endsWith('.webp')) mediaType = 'image/webp'
        return [{
          kind: 'image' as const,
          url,
          mediaType,
          alt: image.alt.trim().slice(0, 500) || null,
          width: image.naturalWidth || null,
          height: image.naturalHeight || null,
          visibleProof: 'visible-chatgpt-current-turn-image',
        }]
      })
  })
  if (artifacts.length === 0) return null
  return {
    text: normalizeChatGptText(await assistant.evaluate((element) => {
      const clone = element.cloneNode(true) as HTMLElement
      for (const control of clone.querySelectorAll('button, [role="button"]')) control.remove()
      return clone.innerText
    })).slice(0, 32_000),
    artifacts,
  }
}

function currentChatGptImageAssistant(page: Page) {
  return page.locator(CHATGPT_ASSISTANT_SELECTOR).filter({ visible: true }).last()
}

async function visibleChatGptBusyCount(page: Page) {
  return await page.locator(CHATGPT_BUSY_SELECTOR).filter({ visible: true }).count()
}

function normalizeChatGptText(value: string) {
  return value
    .replace(/\u00a0/gu, ' ')
    .replace(/(?:^|\n)[ \t]*(?:Edit image|Share|Response actions|Download|Stop generating|Stop)[ \t]*(?=\n|$)/giu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}
