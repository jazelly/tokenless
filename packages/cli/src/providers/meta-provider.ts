import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import { tokenlessError } from '../playwright/errors.js'
import { persistMetaImageAsset } from '../playwright/image-assets.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { VisibleActionResult } from '../playwright/actions.js'

const META_ASSISTANT_SELECTOR = '[data-testid="assistant-message"]'
const META_IMAGE_SELECTOR = 'button[aria-label="View media"] img[data-testid="ur-image-tile"]'

export class MetaProvider extends BaseProvider<'meta'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'meta',
      label: 'Meta AI',
      stage: 'experimental',
      setupOrder: 12,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.meta,
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
        'textarea[data-testid="composer-input"]',
        '[data-testid="composer-input"][contenteditable="true"]',
      ]),
      submitSelectors: Object.freeze([
        '[data-testid="composer-send-button"]',
      ]),
      answerSelectors: Object.freeze([
        '[data-testid="assistant-message"]',
      ]),
      fileInputSelectors: Object.freeze([
        '[data-testid="composer-attachment-dropzone"] input[type="file"][multiple]',
        'input[type="file"][multiple]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        '[data-testid="composer-add-attachment-button"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[data-testid="composer-attachment-dropzone"]',
      ]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([
        '[data-testid="composer-mode-dropdown-button"]',
      ]),
      authIndicators: Object.freeze([
        '[data-testid="user-menu-button"]',
      ]),
      loginIndicators: Object.freeze([]),
      blockerSelectors: Object.freeze([
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/rate limit|too many requests|service unavailable/i',
      ]),
      busySelectors: Object.freeze([
        '[data-testid="composer-stop-button"]',
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
      return await readMetaImageResponse(page, context)
    }
    return super.readResponse(page, context)
  }
}

async function readMetaImageResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  const visible = await waitForStableMetaImageResponse(page, context.signal)
  if (!visible) {
    throw tokenlessError(
      'response_not_visible',
      'No Meta AI image result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-meta-image-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'meta_response_unstable',
      'Meta AI did not expose a stable completed image before the read deadline.',
      { retryable: true, details: { visibleProof: 'meta-image-result-not-stable' } },
    )
  }
  if (!context.assetRoot) {
    throw tokenlessError(
      'meta_image_asset_unavailable',
      'Meta AI image generation requires a Tokenless asset root before the job can complete.',
      { retryable: false },
    )
  }
  const text = visible.text.slice(0, 32_000)
  if (text) context.captureVisibleOutput?.(text)
  const assets = await Promise.all(visible.artifacts.map((artifact, index) => persistMetaImageAsset(page, artifact, {
    assetRoot: context.assetRoot!,
    jobId: context.jobId ?? context.operationId,
    taskId: context.taskId ?? null,
    provider: 'meta',
    now: context.now,
    signal: context.signal,
  }, index)))
  const visibleBusyCount = await visibleMetaBusyCount(page)
  return {
    text,
    citations: [],
    artifacts: assets,
    visibleProof: 'visible-meta-current-turn-image-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount,
      generationStopVisible: visibleBusyCount > 0,
    },
  }
}

async function waitForStableMetaImageResponse(
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 180_000
  let previous = ''
  let stableObservations = 0
  let latest: Awaited<ReturnType<typeof observeMetaImageResponse>> & { terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
    const observed = await observeMetaImageResponse(page)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.artifacts)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleMetaBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeMetaImageResponse(page: Page) {
  const assistant = currentMetaImageAssistant(page)
  if (!await assistant.isVisible().catch(() => false)) return null
  const artifacts = await assistant.locator(META_IMAGE_SELECTOR).filter({ visible: true }).evaluateAll((images) => images
    .slice(0, 8)
    .flatMap((image) => {
      if (!(image instanceof HTMLImageElement)) return []
      const url = image.currentSrc || image.src
      if (!url.startsWith('https://') || image.naturalWidth < 1 || image.naturalHeight < 1) return []
      let mediaType: string | null = null
      try {
        const pathname = new URL(url).pathname.toLowerCase()
        if (pathname.endsWith('.png')) mediaType = 'image/png'
        else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mediaType = 'image/jpeg'
        else if (pathname.endsWith('.webp')) mediaType = 'image/webp'
      } catch {
        return []
      }
      return [{
        kind: 'image' as const,
        url,
        mediaType,
        alt: image.alt.trim().slice(0, 500) || null,
        width: image.naturalWidth || null,
        height: image.naturalHeight || null,
        visibleProof: 'visible-meta-current-turn-image',
      }]
    }))
  if (artifacts.length === 0) return null
  return {
    text: normalizeMetaText(await assistant.innerText()).slice(0, 32_000),
    artifacts,
  }
}

function currentMetaImageAssistant(page: Page) {
  return page.locator(META_ASSISTANT_SELECTOR).filter({ visible: true }).last()
}

async function visibleMetaBusyCount(page: Page) {
  return await page.locator('[data-testid="composer-stop-button"]').filter({ visible: true }).count()
}

function normalizeMetaText(value: string) {
  return value
    .replace(/\u00a0/gu, ' ')
    .replace(/(?:^|\n)[ \t]*(?:View media|Download|Stop)[ \t]*(?=\n|$)/giu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}
