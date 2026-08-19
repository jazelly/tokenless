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
import { VISIBLE_ACTIONS } from './contracts.js'
import { tokenlessError } from '../browser/errors.js'
import { persistDoubaoImageAsset } from '../browser/image-assets.js'
import type { VisibleActionResult } from '../browser/actions.js'
import type {
  ProviderActionObservation,
  ProviderActionPreparation,
  VisibleActionRequest,
} from './contracts.js'

const DOUBAO_BUSY_SELECTOR = 'div.flex.flex-col.flex-grow.max-w-full.min-w-0:has(> div[data-message-id].grid):not(:has(button[aria-label="朗读"]))'
const DOUBAO_IMAGE_CURSOR_SCHEMA = 'tokenless.provider.doubao-image-response-cursor.v1'

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
        'div[contenteditable="true"][role="textbox"]',
      ]),
      submitSelectors: Object.freeze([
        'button[aria-label=""][class*="bg-g-send-msg-btn-bg"]',
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
      capabilities: providerCapabilities({ imageGeneration: true, doubaoControls: true }),
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

  protected override async readResponse(
    page: Page,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    if (context.requirements?.includes('image.generation') === true) {
      return await readDoubaoImageResponse(page, context)
    }
    return super.readResponse(page, context)
  }

  override async prepareAction(page: Page, request: VisibleActionRequest): Promise<ProviderActionPreparation | null> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT && await isDoubaoImageSkillSelected(page)) {
      return await prepareDoubaoImageCursor(page)
    }
    return await super.prepareAction(page, request)
  }

  override validatePreparation(
    preparation: ProviderActionPreparation,
    expected: { action: VisibleActionRequest['action'] },
  ): ProviderActionPreparation {
    if (preparation.schema !== DOUBAO_IMAGE_CURSOR_SCHEMA) {
      return super.validatePreparation(preparation, expected)
    }
    parseDoubaoImageCursor(preparation, expected.action)
    return preparation
  }

  override async observeAction(
    page: Page,
    request: VisibleActionRequest,
    preparation: ProviderActionPreparation,
  ): Promise<ProviderActionObservation> {
    if (request.action !== VISIBLE_ACTIONS.RESPONSE_READ || preparation.schema !== DOUBAO_IMAGE_CURSOR_SCHEMA) {
      return await super.observeAction(page, request, preparation)
    }
    const baseline = parseDoubaoImageCursor(
      this.validatePreparation(preparation, { action: VISIBLE_ACTIONS.RESPONSE_READ }),
      VISIBLE_ACTIONS.RESPONSE_READ,
    )
    const observed = await observeDoubaoImageResponse(page, baseline)
    if (!observed || !doubaoImagesReady(observed, baseline) || await visibleDoubaoBusyCount(page) > 0) {
      return { state: 'pending' }
    }
    await page.waitForTimeout(750)
    const confirmation = await observeDoubaoImageResponse(page, baseline)
    return confirmation !== null &&
      doubaoImagesReady(confirmation, baseline) &&
      await visibleDoubaoBusyCount(page) === 0 &&
      sameStrings(observed.urls, confirmation.urls)
      ? { state: 'ready' }
      : { state: 'pending' }
  }
}

async function prepareDoubaoImageCursor(page: Page): Promise<ProviderActionPreparation> {
  const baseline = await observeDoubaoImageUrls(page)
  return Object.freeze({
    provider: 'doubao',
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    schema: DOUBAO_IMAGE_CURSOR_SCHEMA,
    value: Object.freeze({ baselineUrls: Object.freeze(baseline) }),
  })
}

function parseDoubaoImageCursor(
  preparation: ProviderActionPreparation,
  expectedAction: VisibleActionRequest['action'],
) {
  if (
    preparation.provider !== 'doubao' ||
    preparation.action !== expectedAction ||
    preparation.schema !== DOUBAO_IMAGE_CURSOR_SCHEMA
  ) throw new Error('Doubao image response cursor envelope is invalid.')
  const value = preparation.value
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray((value as { baselineUrls?: unknown }).baselineUrls)
  ) throw new Error('Doubao image response cursor value is invalid.')
  const urls = (value as { baselineUrls: unknown[] }).baselineUrls
  if (urls.length > 100 || urls.some((url) => typeof url !== 'string' || !isHttpsUrl(url))) {
    throw new Error('Doubao image response cursor URLs are invalid.')
  }
  return urls as string[]
}

async function readDoubaoImageResponse(page: Page, context: ProviderExecutionContext): Promise<VisibleActionResult> {
  if (!context.responsePreparation) {
    throw tokenlessError(
      'doubao_image_response_cursor_missing',
      'Doubao image generation requires its pre-submit image baseline.',
      { retryable: false },
    )
  }
  const baseline = parseDoubaoImageCursor(context.responsePreparation, VISIBLE_ACTIONS.RESPONSE_READ)
  const visible = await waitForStableDoubaoImageResponse(page, baseline, context.signal)
  if (!visible) {
    throw tokenlessError(
      'doubao_image_response_not_visible',
      'No Doubao image result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-doubao-image-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'doubao_image_response_unstable',
      'Doubao did not expose stable completed image results before the read deadline.',
      { retryable: true, details: { visibleProof: 'doubao-image-result-not-stable' } },
    )
  }
  if (!context.assetRoot) {
    throw tokenlessError(
      'doubao_image_asset_unavailable',
      'Doubao image generation requires a Tokenless asset root before the job can complete.',
      { retryable: false },
    )
  }
  const conversationId = doubaoConversationId(page.url())
  if (!conversationId) {
    throw tokenlessError(
      'doubao_image_conversation_identity_unavailable',
      'Doubao image generation did not reach an exact conversation URL.',
      { retryable: true },
    )
  }
  const assets = []
  for (const [index, source] of visible.sources.entries()) {
    if (context.signal?.aborted) throw context.signal.reason ?? new Error('Doubao image read was aborted.')
    assets.push(await persistDoubaoImageAsset(page, source, {
      assetRoot: context.assetRoot,
      jobId: context.jobId ?? context.operationId,
      taskId: context.taskId ?? null,
      provider: 'doubao',
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
    visibleProof: 'visible-doubao-current-turn-image-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount: 0,
      generationStopVisible: false,
    },
  }
}

async function waitForStableDoubaoImageResponse(page: Page, baseline: readonly string[], signal: AbortSignal | undefined) {
  const deadline = Date.now() + 180_000
  let previous = ''
  let stableObservations = 0
  let latest: Awaited<ReturnType<typeof observeDoubaoImageResponse>> & { terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Doubao image read was aborted.')
    const observed = await observeDoubaoImageResponse(page, baseline)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.urls)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleDoubaoBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeDoubaoImageResponse(page: Page, baseline: readonly string[]) {
  const urls = await observeDoubaoImageUrls(page)
  const baselineSet = new Set(baseline)
  const newUrls = urls.filter((url) => !baselineSet.has(url))
  if (newUrls.length === 0) return null
  const sources = await observeDoubaoImageSources(page, new Set(newUrls))
  if (sources.length !== newUrls.length) return null
  return {
    urls: newUrls,
    sources,
    text: normalizeDoubaoText(await visibleDoubaoImageText(page)),
  }
}

async function observeDoubaoImageUrls(page: Page): Promise<string[]> {
  const response = latestDoubaoResponse(page)
  return await response.locator('img').filter({ visible: true }).evaluateAll((images) => {
    const urls: string[] = []
    for (const image of images) {
      if (!(image instanceof HTMLImageElement)) continue
      const source = image.currentSrc || image.src
      if (!image.complete || !source.startsWith('https://') || image.naturalWidth < 1 || image.naturalHeight < 1) continue
      if (!urls.includes(source)) urls.push(source)
    }
    return urls
  })
}

async function observeDoubaoImageSources(page: Page, selected: ReadonlySet<string>) {
  const response = latestDoubaoResponse(page)
  return await response.locator('img').filter({ visible: true }).evaluateAll((images, selectedUrls) => {
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
      if (!image.complete || !selectedUrls.includes(source) || sources.some((entry) => entry.url === source)) continue
      sources.push({
        url: source,
        mediaType: null,
        alt: image.alt.trim().slice(0, 500) || null,
        width: image.naturalWidth || null,
        height: image.naturalHeight || null,
        visibleProof: 'visible-doubao-current-response-image',
      })
    }
    return sources
  }, [...selected])
}

function doubaoImagesReady(observed: { urls: readonly string[], sources: readonly unknown[] } | null, baseline: readonly string[]) {
  return observed !== null && observed.urls.length > 0 && observed.urls.every((url) => !baseline.includes(url)) && observed.sources.length === observed.urls.length
}

async function visibleDoubaoImageText(page: Page) {
  return await latestDoubaoResponse(page).innerText().catch(() => '')
}

function latestDoubaoResponse(page: Page) {
  return page.locator('div[data-message-id].grid').filter({ visible: true }).last()
}

async function visibleDoubaoBusyCount(page: Page) {
  return await page.locator(DOUBAO_BUSY_SELECTOR).filter({ visible: true }).count()
}

async function isDoubaoImageSkillSelected(page: Page) {
  const legacyTokenSelected = await page.locator('div[data-input-engine-action-source="actionbar"][data-value="3"]')
    .filter({ visible: true })
    .filter({ hasText: /^图像生成$/u })
    .count() > 0
  return legacyTokenSelected || await page.getByText('Seedream 4.5', { exact: true }).filter({ visible: true }).count() > 0
}

function normalizeDoubaoText(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}

function doubaoConversationId(value: string) {
  try {
    const current = new URL(value)
    const match = current.origin === 'https://www.doubao.com'
      ? current.pathname.match(/^\/chat\/([^/]+)$/u)
      : null
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
