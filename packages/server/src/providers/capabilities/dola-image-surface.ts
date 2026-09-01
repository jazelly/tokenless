import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import { tokenlessError } from '../../browser/errors.js'
import type { Page } from 'playwright-core'
import type { InspectableProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { DolaImageSelectResult, ProviderCapabilityInspection } from '../../browser/actions.js'

const DOLA_IMAGE_SURFACE_URL = 'https://www.dola.com/chat/create-image'
const DOLA_IMAGE_COMPOSER_SELECTOR = 'div[contenteditable="true"][role="textbox"]'

export class DolaImageSurfaceCapability implements InspectableProviderActionCapability<typeof VISIBLE_ACTIONS.DOLA_IMAGE_SELECT> {
  readonly capability = PROVIDER_CAPABILITIES.DOLA_IMAGE_SURFACE
  readonly actions = Object.freeze([VISIBLE_ACTIONS.DOLA_IMAGE_SELECT])

  constructor(private readonly provider: ProviderDomDefinition<'dola'>) {}

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    const available = await isDolaImageSurfaceVisible(page)
    const availability = available ? 'available' as const : 'unknown' as const
    const visibleProof = available
      ? 'visible-dola-create-image-surface'
      : 'dola-create-image-surface-not-visible'
    const reason = available ? null : 'visible_dola_create_image_surface_not_observed'
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
    request: Extract<VisibleActionRequest, { action: typeof VISIBLE_ACTIONS.DOLA_IMAGE_SELECT }>,
    context: ProviderExecutionContext,
  ): Promise<DolaImageSelectResult> {
    if (request.payload.modality !== 'image') {
      throw tokenlessError('dola_image_modality_unsupported', 'Dola image surface only supports image modality.')
    }
    if (new URL(page.url()).toString() !== DOLA_IMAGE_SURFACE_URL) {
      await page.goto(DOLA_IMAGE_SURFACE_URL, { waitUntil: 'commit', timeout: 30_000 })
    }
    const composer = page.locator(DOLA_IMAGE_COMPOSER_SELECTOR).filter({ visible: true }).last()
    await composer.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined)
    if (await composer.count() === 0 || !await composer.isVisible().catch(() => false)) {
      return { supported: false, reason: 'selector_not_available' }
    }
    if (context.signal?.aborted) throw context.signal.reason ?? new Error('Dola image surface action was aborted.')
    return {
      supported: true,
      selectedModality: 'image',
      visibleProof: 'exact-dola-create-image-surface-selected',
    }
  }
}

class UnsupportedDolaImageSurfaceCapability implements InspectableProviderActionCapability<typeof VISIBLE_ACTIONS.DOLA_IMAGE_SELECT> {
  readonly capability = PROVIDER_CAPABILITIES.DOLA_IMAGE_SURFACE
  readonly actions = Object.freeze([VISIBLE_ACTIONS.DOLA_IMAGE_SELECT])

  constructor(private readonly provider: ProviderDomDefinition) {}

  async inspect(_page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    return {
      ...strategy,
      actions: this.actions,
      availability: 'unavailable',
      visibleProof: 'dola-create-image-provider-strategy-unavailable',
      reason: 'unsupported_by_provider',
      native: {
        ...strategy.native,
        availability: 'unavailable',
        visibleProof: null,
        reason: 'unsupported_by_provider',
      },
    }
  }

  async execute(): Promise<DolaImageSelectResult> {
    throw tokenlessError('visible_action_unavailable', 'Dola image actions are available only for the Dola provider.')
  }
}

export function createDolaImageSurfaceCapability(provider: ProviderDomDefinition): InspectableProviderActionCapability<typeof VISIBLE_ACTIONS.DOLA_IMAGE_SELECT> & {
  readonly capability: typeof PROVIDER_CAPABILITIES.DOLA_IMAGE_SURFACE
} {
  return provider.id === 'dola'
    ? new DolaImageSurfaceCapability(provider as ProviderDomDefinition<'dola'>)
    : new UnsupportedDolaImageSurfaceCapability(provider)
}

async function isDolaImageSurfaceVisible(page: Page) {
  try {
    const current = new URL(page.url())
    if (current.origin !== 'https://www.dola.com' || current.pathname !== '/chat/create-image') return false
  } catch {
    return false
  }
  return await page.locator(DOLA_IMAGE_COMPOSER_SELECTOR).filter({ visible: true }).count() > 0
}
