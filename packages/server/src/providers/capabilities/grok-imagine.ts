import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import { tokenlessError } from '../../browser/errors.js'
import type { Page } from 'playwright-core'
import type { InspectableProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  GrokImagineInspectResult,
  GrokImagineSelectResult,
  ProviderCapabilityInspection,
} from '../../browser/actions.js'

type GrokImagineAction =
  | typeof VISIBLE_ACTIONS.GROK_IMAGINE_INSPECT
  | typeof VISIBLE_ACTIONS.GROK_IMAGINE_SELECT

export class GrokImagineCapability implements InspectableProviderActionCapability<GrokImagineAction> {
  readonly capability = PROVIDER_CAPABILITIES.GROK_IMAGINE
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.GROK_IMAGINE_INSPECT,
    VISIBLE_ACTIONS.GROK_IMAGINE_SELECT,
  ])
  private readonly provider: ProviderDomDefinition<'grok'>

  constructor(provider: ProviderDomDefinition<'grok'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    const surface = await inspectGrokImagineSurface(page)
    const availability = surface === null ? 'unavailable' as const : 'available' as const
    const visibleProof = surface === null
      ? 'grok-imagine-image-surface-not-visible'
      : 'visible-grok-imagine-image-surface'
    const reason = surface === null ? 'visible_grok_imagine_image_surface_not_observed' : null
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
    request: Extract<VisibleActionRequest, { action: GrokImagineAction }>,
    context: ProviderExecutionContext,
  ): Promise<GrokImagineInspectResult | GrokImagineSelectResult> {
    assertNotAborted(context.signal)
    if (request.action === VISIBLE_ACTIONS.GROK_IMAGINE_INSPECT) {
      const surface = await inspectGrokImagineSurface(page)
      if (!surface) return { supported: false, reason: 'selector_not_available' }
      return {
        supported: true,
        activeModality: surface.selectedImage ? 'image' : null,
        visibleProof: 'visible-grok-imagine-image-surface',
      }
    }
    return await selectGrokImagineImageSurface(page, context.signal)
  }
}

class UnsupportedGrokImagineCapability implements InspectableProviderActionCapability<GrokImagineAction> {
  readonly capability = PROVIDER_CAPABILITIES.GROK_IMAGINE
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.GROK_IMAGINE_INSPECT,
    VISIBLE_ACTIONS.GROK_IMAGINE_SELECT,
  ])

  constructor(private readonly provider: ProviderDomDefinition) {}

  async inspect(_page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    return {
      ...strategy,
      actions: this.actions,
      availability: 'unavailable',
      visibleProof: 'grok-imagine-provider-strategy-unavailable',
      reason: 'unsupported_by_provider',
      native: {
        ...strategy.native,
        availability: 'unavailable',
        visibleProof: null,
        reason: 'unsupported_by_provider',
      },
    }
  }

  async execute(): Promise<GrokImagineInspectResult | GrokImagineSelectResult> {
    throw tokenlessError('visible_action_unavailable', 'Grok Imagine actions are available only for the Grok provider.')
  }
}

export function createGrokImagineCapability(provider: ProviderDomDefinition): InspectableProviderActionCapability<GrokImagineAction> & {
  readonly capability: typeof PROVIDER_CAPABILITIES.GROK_IMAGINE
} {
  return provider.descriptor.id === 'grok'
    ? new GrokImagineCapability(provider as ProviderDomDefinition<'grok'>)
    : new UnsupportedGrokImagineCapability(provider)
}

async function selectGrokImagineImageSurface(
  page: Page,
  signal: AbortSignal | undefined,
): Promise<GrokImagineSelectResult> {
  assertNotAborted(signal)
  const current = new URL(page.url())
  if (current.origin !== 'https://grok.com' || current.pathname !== '/imagine') {
    await page.goto('https://grok.com/imagine', { waitUntil: 'commit', timeout: 30_000 })
  }
  const composer = page.locator('[contenteditable="true"][aria-label="Ask Grok anything"]').filter({ visible: true }).last()
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  const group = visibleImagineRadioGroup(page)
  await group.waitFor({ state: 'visible', timeout: 15_000 })
  const image = imageRadio(page)
  await image.waitFor({ state: 'visible', timeout: 15_000 })
  if (!await isSelectedImageRadio(image)) {
    assertNotAborted(signal)
    await image.click({ timeout: 15_000 })
  }
  await page.waitForTimeout(100)
  if (!await isSelectedImageRadio(image)) {
    throw tokenlessError('grok_imagine_surface_not_selected', 'Grok Imagine did not visibly select the Image surface.')
  }
  await selectExactImageCount(page, signal)
  return {
    supported: true,
    selectedModality: 'image',
    visibleProof: 'exact-grok-imagine-image-surface-selected',
  }
}

async function selectExactImageCount(page: Page, signal: AbortSignal | undefined) {
  const control = page.locator('button[aria-label="Image Count"]').filter({ visible: true }).last()
  await control.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await control.innerText()).trim().includes('2')) return
  assertNotAborted(signal)
  await control.click({ timeout: 15_000 })
  const option = page.getByRole('menuitemradio').filter({ hasText: /^×2$/u, visible: true }).last()
  await option.waitFor({ state: 'visible', timeout: 15_000 })
  await option.click({ timeout: 15_000 })
  await page.waitForFunction(() => {
    const controls = [...document.querySelectorAll('button[aria-label="Image Count"]')]
    return controls.some((element) => element instanceof HTMLElement && element.offsetParent !== null && element.innerText.includes('2'))
  }, undefined, { timeout: 15_000 })
}

async function inspectGrokImagineSurface(page: Page) {
  let current: URL
  try {
    current = new URL(page.url())
  } catch {
    return null
  }
  if (current.origin !== 'https://grok.com' || current.pathname !== '/imagine') return null
  const composer = page.locator('[contenteditable="true"][aria-label="Ask Grok anything"]').filter({ visible: true }).last()
  const group = visibleImagineRadioGroup(page)
  if (!await composer.isVisible().catch(() => false) || !await group.isVisible().catch(() => false)) return null
  const image = imageRadio(page)
  if (!await image.isVisible().catch(() => false)) return null
  return { selectedImage: await isSelectedImageRadio(image) }
}

function visibleImagineRadioGroup(page: Page) {
  return page.getByRole('radiogroup').filter({ visible: true }).last()
}

function imageRadio(page: Page) {
  return page.locator('button[aria-label="Image"]').filter({ visible: true }).last()
}

async function isSelectedImageRadio(radio: ReturnType<Page['getByRole']>) {
  const checked = await radio.getAttribute('aria-checked').catch(() => null)
  if (checked !== null) return checked === 'true'
  const state = await radio.getAttribute('data-state').catch(() => null)
  if (state !== null) return state === 'on' || state === 'checked' || state === 'selected'
  return await radio.getAttribute('checked').catch(() => null) !== null
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Grok Imagine action was aborted.')
}
