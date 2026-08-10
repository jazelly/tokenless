import { firstVisibleLocator } from '../dom-locators.js'
import { inputDomPrompt, submitDomPrompt } from './prompt.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import type { Page } from 'playwright-core'
import type {
  ImageGenerationCapability,
  ImageGenerationCursor,
  ImageGenerationObservation,
  ImageGenerationRead,
  ImageGenerationStart,
} from './image-generation.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderCapabilityInspection } from '../../playwright/actions.js'

const META_IMAGE_SELECTOR = 'img[data-testid="ur-image-tile"]'
const META_STOP_SELECTOR = '[data-testid="composer-stop-button"]'

type MetaImage = {
  url: string
  alt: string | null
}

type MetaImageOperation = {
  cursor: ImageGenerationCursor
  baselineUrls: ReadonlySet<string>
}

export class MetaImageGenerationCapability implements ImageGenerationCapability {
  readonly capability = PROVIDER_CAPABILITIES.IMAGE_GENERATION
  private readonly provider: ProviderDomDefinition<'meta'>
  private readonly operations = new Map<string, MetaImageOperation>()

  constructor(provider: ProviderDomDefinition<'meta'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const composer = await firstVisibleLocator(page, this.provider.composerSelectors)
    const availability = composer ? 'available' as const : 'unknown' as const
    const visibleProof = composer ? 'meta-visible-image-generation-composer' : 'meta-image-generation-composer-not-visible'
    const reason = composer ? null : 'visible_composer_not_observed'
    return {
      capability: this.capability,
      availability,
      visibleProof,
      reason,
      native: {
        resourceKind: 'visible_action',
        availability,
        visibleProof,
        reason,
      },
      fallback: {
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'no_provider_neutral_image_generation_fallback',
      },
      stability: 'experimental',
      actions: [],
    }
  }

  async cursor(page: Page, context: ProviderExecutionContext): Promise<ImageGenerationCursor> {
    const cursor: ImageGenerationCursor = Object.freeze({
      schema: 'tokenless.provider.image-generation-cursor.v1',
      value: Object.freeze({
        operationId: context.operationId,
        startedAt: new Date().toISOString(),
      }),
    })
    this.operations.set(context.operationId, {
      cursor,
      baselineUrls: new Set((await visibleMetaImages(page)).map((image) => image.url)),
    })
    return cursor
  }

  async start(page: Page, prompt: string, context: ProviderExecutionContext): Promise<ImageGenerationStart> {
    const operation = this.operations.get(context.operationId)
    const cursor = operation?.cursor ?? await this.cursor(page, context)
    await inputDomPrompt(this.provider, page, prompt, context.signal)
    await submitDomPrompt(this.provider, page, context.signal)
    return {
      operationId: context.operationId,
      cursor,
      visibleProof: 'meta-visible-image-generation-submission',
    }
  }

  async observe(page: Page, operationId: string, _context: ProviderExecutionContext): Promise<ImageGenerationObservation> {
    const operation = this.operations.get(operationId)
    if (!operation) {
      return {
        state: 'unknown',
        visibleProof: null,
        reason: 'image_generation_operation_not_observed',
      }
    }
    const stopVisible = await page.locator(META_STOP_SELECTOR).filter({ visible: true }).first()
      .isVisible({ timeout: 100 }).catch(() => false)
    const images = await newMetaImages(page, operation)
    if (stopVisible || images.length === 0) {
      return {
        state: 'running',
        visibleProof: stopVisible ? 'meta-visible-generation-stop-control' : 'meta-image-result-not-yet-visible',
        reason: null,
      }
    }
    return {
      state: 'completed',
      visibleProof: 'meta-new-visible-image-tile',
      reason: null,
    }
  }

  async read(page: Page, operationId: string, _context: ProviderExecutionContext): Promise<ImageGenerationRead> {
    const operation = this.operations.get(operationId)
    if (!operation) {
      return {
        images: [],
        visibleProof: null,
      }
    }
    const images = await newMetaImages(page, operation)
    return {
      images: images.map((image) => ({
        url: image.url,
        alt: image.alt,
        visibleProof: 'meta-visible-image-tile',
      })),
      visibleProof: images.length > 0 ? 'meta-new-visible-image-tiles-read' : null,
    }
  }
}

async function newMetaImages(page: Page, operation: MetaImageOperation) {
  return (await visibleMetaImages(page)).filter((image) => !operation.baselineUrls.has(image.url))
}

async function visibleMetaImages(page: Page): Promise<MetaImage[]> {
  return await page.locator(META_IMAGE_SELECTOR).evaluateAll((elements) => elements.flatMap((element) => {
    if (!(element instanceof HTMLImageElement)) return []
    const style = window.getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    const url = element.currentSrc || element.src
    if (
      !url.startsWith('https://') ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0 ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      element.naturalWidth <= 0 ||
      element.naturalHeight <= 0
    ) return []
    return [{
      url,
      alt: element.getAttribute('alt'),
    }]
  }))
}
