import { BaseProvider } from './base-provider.js'
import { waitForVisibleLocator } from './dom-locators.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { MenuTextAccountInspector } from './account-inspectors.js'
import { tokenlessError } from '../browser/errors.js'
import { persistQwenImageAsset } from '../browser/image-assets.js'
import { QwenModeCapability } from './capabilities/qwen-mode.js'
import { VISIBLE_ACTIONS } from './contracts.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { ProviderDomDefinition } from './provider-definition.js'
import type { VisibleActionResult } from '../browser/actions.js'
import type {
  ProviderActionObservation,
  ProviderActionPreparation,
  VisibleActionRequest,
} from './contracts.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'

const QWEN_APP_HYDRATION_AGE_MS = 3_000
const QWEN_IMAGE_SELECTOR = '.qwen-chat-message-assistant img.qwen-image'
const QWEN_IMAGE_CURSOR_SCHEMA = 'tokenless.provider.qwen-image-response-cursor.v1'

export class QwenProvider extends BaseProvider<'qwen'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'qwen',
      label: 'Qwen / 千问',
      stage: 'experimental',
      setupOrder: 4,
      subscriptionSupport: 'supported',
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.qwen,
      controls: Object.freeze({
        chatSurface: false,
      }),
    })
    const provider = defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'supported',
        guestContinueControlNames: Object.freeze([]),
      }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        'textarea.message-input-textarea',
      ]),
      submitSelectors: Object.freeze([
        'button.send-button',
      ]),
      answerSelectors: Object.freeze([
        '.qwen-chat-message-assistant .chat-response-message .qwen-markdown',
        '.qwen-chat-message-assistant .qwen-markdown',
      ]),
      fileInputSelectors: Object.freeze([
        '#filesUpload[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        '[role="button"][aria-label="Select Mode"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[role="menuitem"].mode-select-common-item:has-text("Upload attachment")',
      ]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([
        '.qwen-thinking-selector',
      ]),
      authIndicators: Object.freeze([
        'button:has(img[alt="User profile"])',
        'button[aria-label^="User profile"]',
      ]),
      loginIndicators: Object.freeze([
        'button:has-text("Log in")',
        'button:has-text("Sign up")',
        'button:has-text("登录")',
      ]),
      blockerSelectors: Object.freeze([]),
      busySelectors: Object.freeze([
        'button.stop-button',
      ]),
      interactionTimings: Object.freeze({
        attachmentReadyTimeoutMs: 120_000,
        promptControlTimeoutMs: 30_000,
        submissionAcceptanceTimeoutMs: 30_000,
      }),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities({ qwenMode: true }),
    })
    super(provider, {
      extensions: Object.freeze([
        new QwenModeCapability(provider),
      ]),
    })
  }

  protected override async readResponse(
    page: Page,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    if (
      context.requirements?.includes('image.generation') === true ||
      context.requirements?.includes('image.edit') === true
    ) {
      return await readQwenImageResponse(page, context)
    }
    return super.readResponse(page, context)
  }

  override async prepareAction(page: Page, request: VisibleActionRequest): Promise<ProviderActionPreparation | null> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT && await isQwenImageMode(page)) {
      return await prepareQwenImageCursor(page)
    }
    return await super.prepareAction(page, request)
  }

  override validatePreparation(
    preparation: ProviderActionPreparation,
    expected: { action: VisibleActionRequest['action'] },
  ): ProviderActionPreparation {
    if (preparation.schema !== QWEN_IMAGE_CURSOR_SCHEMA) {
      return super.validatePreparation(preparation, expected)
    }
    parseQwenImageCursor(preparation, expected.action)
    return preparation
  }

  override async observeAction(
    page: Page,
    request: VisibleActionRequest,
    preparation: ProviderActionPreparation,
  ): Promise<ProviderActionObservation> {
    if (request.action !== VISIBLE_ACTIONS.RESPONSE_READ || preparation.schema !== QWEN_IMAGE_CURSOR_SCHEMA) {
      return await super.observeAction(page, request, preparation)
    }
    const baseline = parseQwenImageCursor(
      this.validatePreparation(preparation, { action: VISIBLE_ACTIONS.RESPONSE_READ }),
      VISIBLE_ACTIONS.RESPONSE_READ,
    )
    const observed = await observeQwenImageResponse(page, baseline)
    if (!observed || !qwenImagesReady(observed, baseline) || await visibleQwenBusyCount(page) > 0) {
      return { state: 'pending' }
    }
    await page.waitForTimeout(750)
    const confirmation = await observeQwenImageResponse(page, baseline)
    return confirmation !== null &&
      qwenImagesReady(confirmation, baseline) &&
      await visibleQwenBusyCount(page) === 0 &&
      sameQwenImageUrls(observed.urls, confirmation.urls)
      ? { state: 'ready' }
      : { state: 'pending' }
  }

  protected override async inputPrompt(page: Page, text: string, context: ProviderExecutionContext) {
    const timeoutMs = this.definition.interactionTimings.promptControlTimeoutMs
    const deadline = Date.now() + timeoutMs
    assertNotAborted(context.signal)
    await waitForQwenAppHydration(page, deadline)
    let composerObserved = false
    do {
      assertNotAborted(context.signal)
      const composer = await waitForVisibleLocator(
        page,
        this.definition.composerSelectors,
        Math.max(1, deadline - Date.now()),
      )
      if (!composer) break
      composerObserved = true
      if (await writeQwenPrompt(page, composer, this.definition, text, deadline)) {
        return {
          visible: true as const,
          inputProof: 'prompt-text-visible',
        }
      }
      if (Date.now() < deadline) {
        await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())))
      }
    } while (Date.now() < deadline)

    if (!composerObserved) {
      throw tokenlessError(
        'prompt_input_visibility_timeout',
        `Timed out after ${timeoutMs}ms waiting for a visible prompt input.`,
        { retryable: true },
      )
    }
    throw tokenlessError(
      'prompt_input_failed',
      'The visible prompt input remained empty after input.',
      { retryable: true },
    )
  }
}

async function readQwenImageResponse(page: Page, context: ProviderExecutionContext): Promise<VisibleActionResult> {
  if (!context.responsePreparation) {
    throw tokenlessError(
      'qwen_image_response_cursor_missing',
      'Qwen image generation requires its pre-submit image baseline.',
      { retryable: false },
    )
  }
  const baseline = parseQwenImageCursor(context.responsePreparation, VISIBLE_ACTIONS.RESPONSE_READ)
  const visible = await waitForStableQwenImageResponse(page, baseline, context.signal)
  if (!visible) {
    throw tokenlessError(
      'qwen_image_response_not_visible',
      'No Qwen image result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-qwen-image-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'qwen_image_response_unstable',
      'Qwen did not expose stable completed image results before the read deadline.',
      { retryable: true, details: { visibleProof: 'qwen-image-result-not-stable' } },
    )
  }
  if (!context.assetRoot) {
    throw tokenlessError(
      'qwen_image_asset_unavailable',
      'Qwen image generation requires a Tokenless asset root before the job can complete.',
      { retryable: false },
    )
  }
  const assets = []
  for (const [index, source] of visible.sources.entries()) {
    assertNotAborted(context.signal)
    assets.push(await persistQwenImageAsset(page, source, {
      assetRoot: context.assetRoot,
      jobId: context.jobId ?? context.operationId,
      taskId: context.taskId ?? null,
      provider: 'qwen',
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
    visibleProof: 'visible-qwen-current-turn-image-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount: 0,
      generationStopVisible: false,
    },
  }
}

async function waitForStableQwenImageResponse(
  page: Page,
  baseline: readonly string[],
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 180_000
  let previous = ''
  let stableObservations = 0
  let latest: Awaited<ReturnType<typeof observeQwenImageResponse>> & { terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    const observed = await observeQwenImageResponse(page, baseline)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.urls)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleQwenBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeQwenImageResponse(page: Page, baseline: readonly string[]) {
  const urls = await observeQwenImageUrls(page)
  const baselineSet = new Set(baseline)
  const newUrls = urls.filter((url) => !baselineSet.has(url))
  if (newUrls.length === 0) return null
  const sources = await observeQwenImageSources(page, new Set(newUrls))
  if (sources.length !== newUrls.length) return null
  return {
    urls: newUrls,
    sources,
    text: normalizeQwenImageText(await visibleQwenImageText(page)),
  }
}

async function observeQwenImageUrls(page: Page): Promise<string[]> {
  return await page.locator(QWEN_IMAGE_SELECTOR).filter({ visible: true }).evaluateAll((images) => {
    const urls: string[] = []
    for (const image of images) {
      if (!(image instanceof HTMLImageElement)) continue
      const source = image.currentSrc || image.src
      if (!source.startsWith('https://') || image.naturalWidth < 1 || image.naturalHeight < 1) continue
      if (!urls.includes(source)) urls.push(source)
    }
    return urls
  })
}

async function observeQwenImageSources(page: Page, selected: ReadonlySet<string>) {
  return await page.locator(QWEN_IMAGE_SELECTOR).filter({ visible: true }).evaluateAll((images, selectedUrls) => {
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
      let mediaType: string | null = null
      try {
        const pathname = new URL(source).pathname.toLowerCase()
        if (pathname.endsWith('.png')) mediaType = 'image/png'
        else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mediaType = 'image/jpeg'
        else if (pathname.endsWith('.webp')) mediaType = 'image/webp'
      } catch {
        continue
      }
      sources.push({
        url: source,
        mediaType,
        alt: image.alt.trim().slice(0, 500) || null,
        width: image.naturalWidth || null,
        height: image.naturalHeight || null,
        visibleProof: 'visible-qwen-current-turn-image',
      })
    }
    return sources
  }, [...selected])
}

async function prepareQwenImageCursor(page: Page): Promise<ProviderActionPreparation> {
  const baselineUrls = await observeQwenImageUrls(page)
  return Object.freeze({
    provider: 'qwen',
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    schema: QWEN_IMAGE_CURSOR_SCHEMA,
    value: Object.freeze({ baselineUrls: Object.freeze(baselineUrls) }),
  })
}

function parseQwenImageCursor(
  preparation: ProviderActionPreparation,
  expectedAction: VisibleActionRequest['action'],
) {
  if (
    preparation.provider !== 'qwen' ||
    preparation.action !== expectedAction ||
    preparation.schema !== QWEN_IMAGE_CURSOR_SCHEMA
  ) throw new Error('Qwen image response cursor envelope is invalid.')
  const value = preparation.value
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray((value as { baselineUrls?: unknown }).baselineUrls)
  ) throw new Error('Qwen image response cursor value is invalid.')
  const urls = (value as { baselineUrls: unknown[] }).baselineUrls
  if (urls.length > 100 || urls.some((url) => typeof url !== 'string' || !isHttpsUrl(url))) {
    throw new Error('Qwen image response cursor URLs are invalid.')
  }
  return urls as string[]
}

function qwenImagesReady(
  observed: { urls: readonly string[]; sources: readonly unknown[] } | null,
  baseline: readonly string[],
) {
  return observed !== null && observed.urls.length > 0 && observed.urls.every((url) => !baseline.includes(url)) && observed.sources.length === observed.urls.length
}

function sameQwenImageUrls(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((url, index) => url === right[index])
}

async function visibleQwenImageText(page: Page) {
  const answer = page.locator('.qwen-chat-message-assistant').filter({ visible: true }).last()
  return await answer.innerText().catch(() => '')
}

async function visibleQwenBusyCount(page: Page) {
  return await page.locator('button.stop-button').filter({ visible: true }).count()
}

async function isQwenImageMode(page: Page) {
  const active = page.locator('.mode-select').filter({ visible: true }).last()
  if (await active.count() === 0 || !await active.isVisible().catch(() => false)) return false
  const label = (await active.innerText().catch(() => '')).replace(/\s+/gu, ' ').trim().toLowerCase()
  return label === 'create image' || label === 'image'
}

function normalizeQwenImageText(value: string) {
  return value
    .replace(/\s+/gu, ' ')
    .trim()
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
}

async function waitForQwenAppHydration(page: Page, deadline: number) {
  const pageAgeMs = await page.evaluate(() => performance.now()).catch(() => 0)
  const remainingHydrationMs = Math.max(0, QWEN_APP_HYDRATION_AGE_MS - pageAgeMs)
  if (remainingHydrationMs > 0) {
    await page.waitForTimeout(Math.min(remainingHydrationMs, Math.max(1, deadline - Date.now())))
  }
}

async function writeQwenPrompt(
  page: Page,
  composer: Locator,
  provider: ProviderDomDefinition,
  text: string,
  deadline: number,
) {
  await composer.fill(text, { timeout: Math.min(2000, Math.max(1, deadline - Date.now())) }).catch(() => undefined)
  if (await qwenComposerHasExpectedText(page, provider, text, deadline)) return true

  const freshComposer = await waitForVisibleLocator(
    page,
    provider.composerSelectors,
    Math.max(1, deadline - Date.now()),
  )
  if (!freshComposer) return false
  try {
    await focusQwenComposer(freshComposer)
  } catch {
    return false
  }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => undefined)
  await page.keyboard.press('Backspace').catch(() => undefined)
  const clearedComposer = await waitForVisibleLocator(
    page,
    provider.composerSelectors,
    Math.max(1, deadline - Date.now()),
  )
  if (!clearedComposer) return false
  try {
    await focusQwenComposer(clearedComposer)
  } catch {
    return false
  }
  if (text.length > 0) {
    await page.keyboard.insertText(text).catch(() => undefined)
  }
  return await qwenComposerHasExpectedText(page, provider, text, deadline)
}

async function focusQwenComposer(composer: Locator) {
  await composer.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => undefined)
  await composer.click({ timeout: 1000 })
}

async function qwenComposerHasExpectedText(
  page: Page,
  provider: ProviderDomDefinition,
  expected: string,
  deadline: number,
) {
  const composer = await waitForVisibleLocator(
    page,
    provider.composerSelectors,
    Math.max(1, deadline - Date.now()),
  )
  if (!composer) return false
  return await composer.evaluate((element, value) => {
    const normalizeSlateText = (input: string) => input
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : (() => {
          const clone = element.cloneNode(true) as Element
          clone.querySelectorAll('[data-slate-placeholder="true"], [data-slate-zero-width]').forEach((node) => node.remove())
          return clone.textContent ?? ''
        })()
    const normalized = normalizeSlateText(text)
    const expected = normalizeSlateText(value)
    return expected.length === 0 ? normalized.length === 0 : normalized === expected
  }, expected).catch(() => false)
}
