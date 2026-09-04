import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import { tokenlessError } from '../../browser/errors.js'
import type { Locator, Page } from 'playwright-core'
import type { InspectableProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  GeminiImageInspectResult,
  GeminiImageSelectResult,
  ProviderCapabilityInspection,
} from '../../browser/actions.js'

type GeminiImageSurfaceAction =
  | typeof VISIBLE_ACTIONS.GEMINI_IMAGE_INSPECT
  | typeof VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT

const GEMINI_IMAGE_SURFACE_URL = 'https://gemini.google.com/images'

export class GeminiImageSurfaceCapability implements InspectableProviderActionCapability<GeminiImageSurfaceAction> {
  readonly capability = PROVIDER_CAPABILITIES.GEMINI_IMAGE_SURFACE
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.GEMINI_IMAGE_INSPECT,
    VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT,
  ])
  private readonly provider: ProviderDomDefinition<'gemini'>

  constructor(provider: ProviderDomDefinition<'gemini'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    const available = await isGeminiImageSurfaceVisible(page, this.provider)
    const availability = available ? 'available' as const : 'unavailable' as const
    const visibleProof = available
      ? 'visible-gemini-images-surface'
      : 'gemini-images-surface-not-visible'
    const reason = available ? null : 'visible_gemini_images_surface_not_observed'
    return {
      ...strategy,
      actions: this.actions,
      availability,
      visibleProof,
      reason,
      native: {
        ...strategy.native,
        availability,
        visibleProof,
        reason,
      },
    }
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: GeminiImageSurfaceAction }>,
    context: ProviderExecutionContext,
  ): Promise<GeminiImageInspectResult | GeminiImageSelectResult> {
    assertNotAborted(context.signal)
    if (request.action === VISIBLE_ACTIONS.GEMINI_IMAGE_INSPECT) {
      const available = await isGeminiImageSurfaceVisible(page, this.provider)
      return available
        ? { supported: true, activeModality: 'image', visibleProof: 'visible-gemini-images-surface' }
        : { supported: false, reason: 'selector_not_available' }
    }
    return await selectGeminiImageSurface(page, this.provider, context.signal)
  }
}

class UnsupportedGeminiImageSurfaceCapability implements InspectableProviderActionCapability<GeminiImageSurfaceAction> {
  readonly capability = PROVIDER_CAPABILITIES.GEMINI_IMAGE_SURFACE
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.GEMINI_IMAGE_INSPECT,
    VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT,
  ])

  constructor(private readonly provider: ProviderDomDefinition) {}

  async inspect(_page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    return {
      ...strategy,
      actions: this.actions,
      availability: 'unavailable',
      visibleProof: 'gemini-images-provider-strategy-unavailable',
      reason: 'unsupported_by_provider',
      native: {
        ...strategy.native,
        availability: 'unavailable',
        visibleProof: null,
        reason: 'unsupported_by_provider',
      },
    }
  }

  async execute(): Promise<GeminiImageInspectResult | GeminiImageSelectResult> {
    throw tokenlessError('visible_action_unavailable', 'Gemini Images actions are available only for the Gemini provider.')
  }
}

export function createGeminiImageSurfaceCapability(provider: ProviderDomDefinition): InspectableProviderActionCapability<GeminiImageSurfaceAction> & {
  readonly capability: typeof PROVIDER_CAPABILITIES.GEMINI_IMAGE_SURFACE
} {
  return provider.descriptor.id === 'gemini'
    ? new GeminiImageSurfaceCapability(provider as ProviderDomDefinition<'gemini'>)
    : new UnsupportedGeminiImageSurfaceCapability(provider)
}

async function selectGeminiImageSurface(
  page: Page,
  provider: ProviderDomDefinition<'gemini'>,
  signal: AbortSignal | undefined,
): Promise<GeminiImageSelectResult> {
  assertNotAborted(signal)
  let current = new URL(page.url())
  if (current.origin !== 'https://gemini.google.com' || current.pathname !== '/images') {
    await page.goto(GEMINI_IMAGE_SURFACE_URL, { waitUntil: 'commit', timeout: 30_000 })
    current = new URL(page.url())
  }
  const composer = await waitForVisibleComposer(page, provider, signal)
  if (!composer) {
    throw tokenlessError('gemini_image_surface_not_visible', 'Gemini Images did not expose its visible composer.')
  }
  return {
    supported: true,
    selectedModality: 'image',
    visibleProof: 'exact-gemini-images-surface-selected',
  }
}

async function waitForVisibleComposer(
  page: Page,
  provider: ProviderDomDefinition<'gemini'>,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    assertNotAborted(signal)
    const composer = await visibleComposer(page, provider)
    if (composer) return composer
    await page.waitForTimeout(250)
  }
  return null
}

async function isGeminiImageSurfaceVisible(page: Page, provider: ProviderDomDefinition<'gemini'>) {
  let current: URL
  try {
    current = new URL(page.url())
  } catch {
    return false
  }
  if (current.origin !== 'https://gemini.google.com' || current.pathname !== '/images') return false
  return (await visibleComposer(page, provider)) !== null
}

async function visibleComposer(page: Page, provider: ProviderDomDefinition<'gemini'>): Promise<Locator | null> {
  for (const selector of provider.composerSelectors) {
    const locator = page.locator(selector).filter({ visible: true }).last()
    if (await locator.isVisible().catch(() => false)) return locator
  }
  return null
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Gemini Images action was aborted.')
}
