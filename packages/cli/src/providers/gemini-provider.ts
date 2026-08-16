import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { GeminiAccountInspector } from './gemini-account-inspector.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import { tokenlessError } from '../playwright/errors.js'
import { persistGeminiImageAsset } from '../playwright/image-assets.js'
import { VISIBLE_ACTIONS } from './contracts.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { VisibleActionResult } from '../playwright/actions.js'
import type {
  ProviderActionObservation,
  ProviderActionPreparation,
  VisibleActionRequest,
} from './contracts.js'

const GEMINI_IMAGE_SELECTOR = 'message-content response-element generated-image single-image img.image.animate.loaded'
const GEMINI_BUSY_SELECTOR = 'button[aria-label="Stop response"]'
const GEMINI_DONE_SELECTOR = 'image-loading-overlay .done-generating'
const GEMINI_IMAGE_CURSOR_SCHEMA = 'tokenless.provider.gemini-images-response-cursor.v1'

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
        'button[aria-label="Upload & tools"]',
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
      capabilities: providerCapabilities({ imageGeneration: true, geminiImageSurface: true }),
    })
    super(provider)
  }

  protected override async readResponse(
    page: Page,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    if (context.requirements?.includes('image.generation') === true) {
      return await readGeminiImageResponse(page, context)
    }
    return super.readResponse(page, context)
  }

  override async prepareAction(page: Page, request: VisibleActionRequest): Promise<ProviderActionPreparation | null> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT && isGeminiImagesRoot(page.url())) {
      return await prepareGeminiImageCursor(page)
    }
    return await super.prepareAction(page, request)
  }

  override validatePreparation(
    preparation: ProviderActionPreparation,
    expected: { action: VisibleActionRequest['action'] },
  ): ProviderActionPreparation {
    if (preparation.schema !== GEMINI_IMAGE_CURSOR_SCHEMA) {
      return super.validatePreparation(preparation, expected)
    }
    parseGeminiImageCursor(preparation, expected.action)
    return preparation
  }

  override async observeAction(
    page: Page,
    request: VisibleActionRequest,
    preparation: ProviderActionPreparation,
  ): Promise<ProviderActionObservation> {
    if (
      request.action !== VISIBLE_ACTIONS.RESPONSE_READ ||
      preparation.schema !== GEMINI_IMAGE_CURSOR_SCHEMA
    ) {
      return await super.observeAction(page, request, preparation)
    }
    if (!isGeminiConversationPage(page.url())) return { state: 'pending' }
    const baseline = parseGeminiImageCursor(
      this.validatePreparation(preparation, { action: VISIBLE_ACTIONS.RESPONSE_READ }),
      VISIBLE_ACTIONS.RESPONSE_READ,
    )
    const observed = await observeGeminiImageResponse(page, baseline)
    if (!observed || !geminiImagesReady(observed, baseline)) return { state: 'pending' }
    await page.waitForTimeout(750)
    const confirmation = await observeGeminiImageResponse(page, baseline)
    return confirmation !== null && geminiImagesReady(confirmation, baseline) && sameGeminiImageUrls(observed.urls, confirmation.urls)
      ? { state: 'ready' }
      : { state: 'pending' }
  }
}

async function prepareGeminiImageCursor(page: Page): Promise<ProviderActionPreparation> {
  const baseline = await observeGeminiImageBlobUrls(page)
  return Object.freeze({
    provider: 'gemini',
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    schema: GEMINI_IMAGE_CURSOR_SCHEMA,
    value: Object.freeze({ baselineUrls: Object.freeze(baseline) }),
  })
}

function parseGeminiImageCursor(
  preparation: ProviderActionPreparation,
  expectedAction: VisibleActionRequest['action'],
) {
  if (
    preparation.provider !== 'gemini' ||
    preparation.action !== expectedAction ||
    preparation.schema !== GEMINI_IMAGE_CURSOR_SCHEMA
  ) {
    throw new Error('Gemini Images response cursor envelope is invalid.')
  }
  const value = preparation.value
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray((value as { baselineUrls?: unknown }).baselineUrls)
  ) {
    throw new Error('Gemini Images response cursor value is invalid.')
  }
  const urls = (value as { baselineUrls: unknown[] }).baselineUrls
  if (urls.length > 100 || urls.some((url) => typeof url !== 'string' || !isGeminiBlobUrl(url))) {
    throw new Error('Gemini Images response cursor URLs are invalid.')
  }
  return urls as string[]
}

async function readGeminiImageResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  if (!context.responsePreparation) {
    throw tokenlessError(
      'gemini_image_response_cursor_missing',
      'Gemini Images generation requires its pre-submit blob baseline.',
      { retryable: false },
    )
  }
  const baseline = parseGeminiImageCursor(context.responsePreparation, VISIBLE_ACTIONS.RESPONSE_READ)
  const visible = await waitForStableGeminiImageResponse(page, baseline, context.signal)
  if (!visible) {
    throw tokenlessError(
      'gemini_image_response_not_visible',
      'No Gemini Images result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-gemini-image-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'gemini_image_response_unstable',
      'Gemini Images did not expose stable completed image results before the read deadline.',
      { retryable: true, details: { visibleProof: 'gemini-image-result-not-stable' } },
    )
  }
  if (!context.assetRoot) {
    throw tokenlessError(
      'gemini_image_asset_unavailable',
      'Gemini Images generation requires a Tokenless asset root before the job can complete.',
      { retryable: false },
    )
  }

  const assets = []
  for (const [index, source] of visible.sources.entries()) {
    assertNotAborted(context.signal)
    assets.push(await persistGeminiImageAsset(page, source, {
      assetRoot: context.assetRoot,
      jobId: context.jobId ?? context.operationId,
      taskId: context.taskId ?? null,
      provider: 'gemini',
      now: context.now,
      signal: context.signal,
    }, index))
  }
  const text = visible.text.slice(0, 32_000)
  if (text) context.captureVisibleOutput?.(text)
  return {
    text,
    citations: [],
    artifacts: assets,
    visibleProof: 'visible-gemini-images-current-response-image-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount: 0,
      generationStopVisible: false,
    },
  }
}

async function waitForStableGeminiImageResponse(
  page: Page,
  baseline: readonly string[],
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 180_000
  let previous = ''
  let stableObservations = 0
  let latest: Awaited<ReturnType<typeof observeGeminiImageResponse>> & { terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    const observed = await observeGeminiImageResponse(page, baseline)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.urls)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleGeminiBusyCount(page) === 0 && await visibleGeminiDoneCount(page) > 0 && geminiImagesReady(observed, baseline) && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeGeminiImageResponse(page: Page, baseline: readonly string[]) {
  const urls = await observeGeminiImageBlobUrls(page)
  const newUrls = urls.filter((url) => !new Set(baseline).has(url))
  if (newUrls.length !== 1) return null
  const sources = await observeGeminiImageSources(page, new Set(newUrls))
  if (sources.length !== 1) return null
  return {
    urls: newUrls,
    sources,
    text: normalizeGeminiImageText(await visibleGeminiImageText(page)),
  }
}

async function observeGeminiImageBlobUrls(page: Page): Promise<string[]> {
  return await page.locator(GEMINI_IMAGE_SELECTOR).filter({ visible: true }).evaluateAll((images) => {
    const urls: string[] = []
    for (const image of images) {
      if (!(image instanceof HTMLImageElement)) continue
      const source = image.currentSrc || image.src
      if (!source.startsWith('blob:https://gemini.google.com/')) continue
      if (!urls.includes(source)) urls.push(source)
    }
    return urls
  })
}

async function observeGeminiImageSources(page: Page, selected: ReadonlySet<string>) {
  return await page.locator(GEMINI_IMAGE_SELECTOR).filter({ visible: true }).evaluateAll((images, selectedUrls) => {
    const sources: Array<{
      url: string
      mediaType: string | null
      alt: string | null
      width: number | null
      height: number | null
      visibleProof: string
    }> = []
    for (const image of images) {
      if (!(image instanceof HTMLImageElement)) continue
      const source = image.currentSrc || image.src
      if (!selectedUrls.includes(source) || sources.some((entry) => entry.url === source)) continue
      sources.push({
        url: source,
        mediaType: null,
        alt: image.alt.trim().slice(0, 500) || null,
        width: image.naturalWidth || null,
        height: image.naturalHeight || null,
        visibleProof: 'visible-gemini-images-current-response-image',
      })
    }
    return sources
  }, [...selected])
}

function geminiImagesReady(
  observed: { urls: readonly string[]; sources: readonly unknown[] } | null,
  baseline: readonly string[],
) {
  return observed !== null && new Set(observed.urls).size === 1 && observed.urls.every((url) => !baseline.includes(url)) && observed.sources.length === 1
}

async function visibleGeminiImageText(page: Page) {
  const answer = page.locator('message-content').filter({ visible: true }).last()
  return await answer.innerText().catch(() => '')
}

async function visibleGeminiBusyCount(page: Page) {
  return await page.locator(GEMINI_BUSY_SELECTOR).filter({ visible: true }).count()
}

async function visibleGeminiDoneCount(page: Page) {
  return await page.locator(GEMINI_DONE_SELECTOR).filter({ visible: true }).count()
}

function sameGeminiImageUrls(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((url, index) => url === right[index])
}

function normalizeGeminiImageText(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}

function isGeminiImagesRoot(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.origin === 'https://gemini.google.com' && parsed.pathname === '/images'
  } catch {
    return false
  }
}

function isGeminiConversationPage(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.origin === 'https://gemini.google.com' && parsed.pathname.startsWith('/app/')
  } catch {
    return false
  }
}

function isGeminiBlobUrl(value: string) {
  return value.startsWith('blob:https://gemini.google.com/')
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Gemini Images image read was aborted.')
}
