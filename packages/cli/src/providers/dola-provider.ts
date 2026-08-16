import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import { VISIBLE_ACTIONS } from './contracts.js'
import { tokenlessError } from '../playwright/errors.js'
import { persistDolaImageAsset } from '../playwright/image-assets.js'
import { DolaImageSurfaceCapability } from './capabilities/dola-image-surface.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { VisibleActionResult } from '../playwright/actions.js'
import type {
  ProviderActionObservation,
  ProviderActionPreparation,
  VisibleActionRequest,
} from './contracts.js'

const DOLA_BUSY_SELECTOR = '[data-render-engine="node"]:not(.justify-end) [data-streaming="true"].md-box-root'
const DOLA_IMAGE_CURSOR_SCHEMA = 'tokenless.provider.dola-image-response-cursor.v1'

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
        'div[contenteditable="true"][role="textbox"]',
      ]),
      submitSelectors: Object.freeze([
        '.send-btn-wrapper > button:not([disabled])',
        'button.bg-dbx-text-highlight[aria-label=""]',
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
      capabilities: providerCapabilities({ imageGeneration: true, dolaImageSurface: true }),
    })
    super(provider, {
      dolaImageSurface: new DolaImageSurfaceCapability(provider),
    })
  }

  protected override async readResponse(
    page: Page,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    if (context.requirements?.includes('image.generation') === true) {
      return await readDolaImageResponse(page, context)
    }
    return super.readResponse(page, context)
  }

  override async prepareAction(page: Page, request: VisibleActionRequest): Promise<ProviderActionPreparation | null> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT && contextIsDolaImageSurface(page.url())) {
      return await prepareDolaImageCursor(page)
    }
    return await super.prepareAction(page, request)
  }

  override validatePreparation(
    preparation: ProviderActionPreparation,
    expected: { action: VisibleActionRequest['action'] },
  ): ProviderActionPreparation {
    if (preparation.schema !== DOLA_IMAGE_CURSOR_SCHEMA) {
      return super.validatePreparation(preparation, expected)
    }
    parseDolaImageCursor(preparation, expected.action)
    return preparation
  }

  override async observeAction(
    page: Page,
    request: VisibleActionRequest,
    preparation: ProviderActionPreparation,
  ): Promise<ProviderActionObservation> {
    if (request.action !== VISIBLE_ACTIONS.RESPONSE_READ || preparation.schema !== DOLA_IMAGE_CURSOR_SCHEMA) {
      return await super.observeAction(page, request, preparation)
    }
    const baseline = parseDolaImageCursor(
      this.validatePreparation(preparation, { action: VISIBLE_ACTIONS.RESPONSE_READ }),
      VISIBLE_ACTIONS.RESPONSE_READ,
    )
    const observed = await observeDolaImageResponse(page, baseline)
    if (!observed || !dolaImagesReady(observed, baseline) || await visibleDolaBusyCount(page) > 0) {
      return { state: 'pending' }
    }
    await page.waitForTimeout(750)
    const confirmation = await observeDolaImageResponse(page, baseline)
    return confirmation !== null &&
      dolaImagesReady(confirmation, baseline) &&
      await visibleDolaBusyCount(page) === 0 &&
      sameStrings(observed.urls, confirmation.urls)
      ? { state: 'ready' }
      : { state: 'pending' }
  }
}

async function prepareDolaImageCursor(page: Page): Promise<ProviderActionPreparation> {
  const baseline = await observeDolaImageUrls(page)
  return Object.freeze({
    provider: 'dola',
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    schema: DOLA_IMAGE_CURSOR_SCHEMA,
    value: Object.freeze({ baselineUrls: Object.freeze(baseline) }),
  })
}

function parseDolaImageCursor(
  preparation: ProviderActionPreparation,
  expectedAction: VisibleActionRequest['action'],
) {
  if (
    preparation.provider !== 'dola' ||
    preparation.action !== expectedAction ||
    preparation.schema !== DOLA_IMAGE_CURSOR_SCHEMA
  ) throw new Error('Dola image response cursor envelope is invalid.')
  const value = preparation.value
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray((value as { baselineUrls?: unknown }).baselineUrls)
  ) throw new Error('Dola image response cursor value is invalid.')
  const urls = (value as { baselineUrls: unknown[] }).baselineUrls
  if (urls.length > 100 || urls.some((url) => typeof url !== 'string' || !isHttpsUrl(url))) {
    throw new Error('Dola image response cursor URLs are invalid.')
  }
  return urls as string[]
}

async function readDolaImageResponse(page: Page, context: ProviderExecutionContext): Promise<VisibleActionResult> {
  if (!context.responsePreparation) {
    throw tokenlessError(
      'dola_image_response_cursor_missing',
      'Dola image generation requires its pre-submit image baseline.',
      { retryable: false },
    )
  }
  const baseline = parseDolaImageCursor(context.responsePreparation, VISIBLE_ACTIONS.RESPONSE_READ)
  const visible = await waitForStableDolaImageResponse(page, baseline, context.signal)
  if (!visible) {
    throw tokenlessError(
      'dola_image_response_not_visible',
      'No Dola image result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-dola-image-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'dola_image_response_unstable',
      'Dola did not expose stable completed image results before the read deadline.',
      { retryable: true, details: { visibleProof: 'dola-image-result-not-stable' } },
    )
  }
  if (!context.assetRoot) {
    throw tokenlessError(
      'dola_image_asset_unavailable',
      'Dola image generation requires a Tokenless asset root before the job can complete.',
      { retryable: false },
    )
  }
  const conversationId = dolaConversationId(page.url())
  if (!conversationId) {
    throw tokenlessError(
      'dola_image_conversation_identity_unavailable',
      'Dola image generation did not reach an exact conversation URL.',
      { retryable: true },
    )
  }
  const assets = []
  for (const [index, source] of visible.sources.entries()) {
    if (context.signal?.aborted) throw context.signal.reason ?? new Error('Dola image read was aborted.')
    assets.push(await persistDolaImageAsset(page, source, {
      assetRoot: context.assetRoot,
      jobId: context.jobId ?? context.operationId,
      taskId: context.taskId ?? null,
      provider: 'dola',
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
    visibleProof: 'visible-dola-current-turn-image-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount: 0,
      generationStopVisible: false,
    },
  }
}

async function waitForStableDolaImageResponse(page: Page, baseline: readonly string[], signal: AbortSignal | undefined) {
  const deadline = Date.now() + 180_000
  let previous = ''
  let stableObservations = 0
  let latest: Awaited<ReturnType<typeof observeDolaImageResponse>> & { terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Dola image read was aborted.')
    const observed = await observeDolaImageResponse(page, baseline)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.urls)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleDolaBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeDolaImageResponse(page: Page, baseline: readonly string[]) {
  const urls = await observeDolaImageUrls(page)
  const baselineSet = new Set(baseline)
  const newUrls = urls.filter((url) => !baselineSet.has(url))
  if (newUrls.length === 0) return null
  const sources = await observeDolaImageSources(page, new Set(newUrls))
  if (sources.length !== newUrls.length) return null
  return {
    urls: newUrls,
    sources,
    text: normalizeDolaText(await visibleDolaImageText(page)),
  }
}

async function observeDolaImageUrls(page: Page): Promise<string[]> {
  const response = latestDolaResponse(page)
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

async function observeDolaImageSources(page: Page, selected: ReadonlySet<string>) {
  const response = latestDolaResponse(page)
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
        visibleProof: 'visible-dola-current-response-image',
      })
    }
    return sources
  }, [...selected])
}

function dolaImagesReady(observed: { urls: readonly string[], sources: readonly unknown[] } | null, baseline: readonly string[]) {
  return observed !== null && observed.urls.length > 0 && observed.urls.every((url) => !baseline.includes(url)) && observed.sources.length === observed.urls.length
}

async function visibleDolaBusyCount(page: Page) {
  return await page.locator(DOLA_BUSY_SELECTOR).filter({ visible: true }).count()
}

async function visibleDolaImageText(page: Page) {
  return await latestDolaResponse(page).innerText().catch(() => '')
}

function latestDolaResponse(page: Page) {
  return page.locator('[data-render-engine="node"]:not(.justify-end)').filter({ visible: true }).last()
}

function normalizeDolaText(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}

function contextIsDolaImageSurface(value: string) {
  try {
    const current = new URL(value)
    return current.origin === 'https://www.dola.com' && current.pathname === '/chat/create-image'
  } catch {
    return false
  }
}

function dolaConversationId(value: string) {
  try {
    const current = new URL(value)
    const match = current.origin === 'https://www.dola.com'
      ? current.pathname.match(/^\/chat\/([^/]+)$/u)
      : null
    return match?.[1] && match[1] !== 'create-image' ? match[1] : null
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
