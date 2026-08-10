import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import { tokenlessError } from '../../playwright/errors.js'
import type { Page } from 'playwright-core'
import type { InspectableProviderActionCapability } from '../capability-set.js'
import type {
  ArenaSurfaceMode,
  ArenaSurfaceModality,
  ArenaSurfaceSelectionPayload,
  VisibleActionRequest,
} from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  ArenaSurfaceInspectResult,
  ArenaSurfaceSelectResult,
  ProviderCapabilityInspection,
} from '../../playwright/actions.js'

type ArenaSurfaceAction =
  | typeof VISIBLE_ACTIONS.ARENA_SURFACE_INSPECT
  | typeof VISIBLE_ACTIONS.ARENA_SURFACE_SELECT

export class ArenaSurfaceCapability implements InspectableProviderActionCapability<ArenaSurfaceAction> {
  readonly capability = PROVIDER_CAPABILITIES.ARENA_SURFACE
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.ARENA_SURFACE_INSPECT,
    VISIBLE_ACTIONS.ARENA_SURFACE_SELECT,
  ])
  private readonly provider: ProviderDomDefinition<'arena'>

  constructor(provider: ProviderDomDefinition<'arena'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    const surface = await inspectArenaSurface(page).catch(() => null)
    const available = surface !== null && ARENA_SURFACE_MODES.every((mode) => surface.modes.includes(mode))
    const availability = available ? 'available' as const : 'unavailable' as const
    const visibleProof = available ? 'visible-arena-surface-control-and-actions' : 'no-complete-visible-arena-surface-control'
    const reason = available ? null : 'visible_arena_surface_control_not_observed'
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
    request: Extract<VisibleActionRequest, { action: ArenaSurfaceAction }>,
    context: ProviderExecutionContext,
  ): Promise<ArenaSurfaceInspectResult | ArenaSurfaceSelectResult> {
    assertNotAborted(context.signal)
    if (request.action === VISIBLE_ACTIONS.ARENA_SURFACE_INSPECT) return await inspectArenaSurface(page)
    return await selectArenaSurface(page, request.payload, context.signal)
  }
}

export async function ensureArenaDirectMode(page: Page) {
  const mode = page.getByRole('combobox').first()
  const selected = normalizeVisibleText(await mode.innerText({ timeout: 5_000 }))
  if (selected === 'Direct') return
  await mode.click({ timeout: 5_000 })
  await page.getByRole('option', {
    name: 'Direct Chat with 1 model at a time',
    exact: true,
  }).click({ timeout: 5_000 })
  await page.getByRole('combobox').filter({ hasText: /^Direct$/ }).waitFor({
    state: 'visible',
    timeout: 5_000,
  })
}

async function inspectArenaSurface(page: Page): Promise<ArenaSurfaceInspectResult> {
  const active = await activeArenaSurface(page)
  const control = page.getByRole('combobox').first()
  await control.click({ timeout: 5_000 })
  const visibleOptions = await page.getByRole('option').filter({ visible: true }).allInnerTexts()
  await page.keyboard.press('Escape')
  const modes = ARENA_SURFACE_MODES.filter((mode) => visibleOptions.some((label) => (
    normalizeVisibleText(label) === ARENA_MODE_OPTION_LABELS[mode]
  )))
  return {
    supported: true,
    active,
    modes,
    modalities: ['text', 'search', 'image', 'code'],
  }
}

async function selectArenaSurface(
  page: Page,
  selection: ArenaSurfaceSelectionPayload,
  signal: AbortSignal | undefined,
): Promise<ArenaSurfaceSelectResult> {
  assertNotAborted(signal)
  await ensureArenaDirectMode(page)
  if (arenaModalityFromUrl(page.url()) !== selection.modality) {
    const trigger = page.locator('button[aria-haspopup="dialog"]:not([disabled])').filter({ visible: true }).first()
    await trigger.click({ timeout: 5_000 })
    await page.getByRole('dialog').filter({ visible: true }).last().getByRole('button', {
      name: selection.modality === 'text'
        ? 'Text'
        : selection.modality === 'search'
          ? 'Search'
          : selection.modality === 'image' ? 'Image' : 'Code',
      exact: true,
    }).click({ timeout: 5_000 })
  }
  assertNotAborted(signal)
  const mode = page.getByRole('combobox').first()
  const selected = normalizeVisibleText(await mode.innerText({ timeout: 5_000 }))
  const expectedMode = ARENA_MODE_VISIBLE_LABELS[selection.mode]
  if (selected !== expectedMode) {
    await mode.click({ timeout: 5_000 })
    await page.getByRole('option', {
      name: ARENA_MODE_OPTION_LABELS[selection.mode],
      exact: true,
    }).click({ timeout: 5_000 })
  }
  await page.waitForURL(arenaSurfaceUrl(selection), { timeout: 5_000 })
  const active = await activeArenaSurface(page)
  if (active.mode !== selection.mode || active.modality !== selection.modality) {
    throw tokenlessError('arena_surface_not_selected', 'Arena did not visibly select the requested mode and modality.')
  }
  return {
    supported: true,
    selectedMode: active.mode,
    selectedModality: active.modality,
    visibleProof: 'exact-arena-surface-selected',
  }
}

async function activeArenaSurface(page: Page) {
  const label = normalizeVisibleText(await page.getByRole('combobox').first().innerText({ timeout: 5_000 }))
  const mode = ARENA_SURFACE_MODES.find((candidate) => ARENA_MODE_VISIBLE_LABELS[candidate] === label)
  if (!mode) throw tokenlessError('arena_surface_not_visible', 'Arena mode control is not visibly available.')
  return {
    mode,
    modality: arenaModalityFromUrl(page.url()),
  }
}

function arenaModalityFromUrl(value: string): ArenaSurfaceModality {
  const pathname = new URL(value).pathname
  if (pathname.startsWith('/search')) return 'search'
  if (pathname.startsWith('/image')) return 'image'
  if (pathname.startsWith('/code')) return 'code'
  return 'text'
}

function arenaSurfaceUrl(selection: ArenaSurfaceSelectionPayload) {
  const suffix = selection.mode === 'direct' ? '/direct' : selection.mode === 'side-by-side' ? '/side-by-side' : ''
  return `https://arena.ai/${selection.modality}${suffix}`
}

function normalizeVisibleText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Arena surface action was aborted.')
}

const ARENA_SURFACE_MODES = ['battle', 'side-by-side', 'direct'] as const satisfies readonly ArenaSurfaceMode[]
const ARENA_MODE_VISIBLE_LABELS: Record<ArenaSurfaceMode, string> = {
  battle: 'Battle Mode',
  'side-by-side': 'Side by Side',
  direct: 'Direct',
}
const ARENA_MODE_OPTION_LABELS: Record<ArenaSurfaceMode, string> = {
  battle: 'Battle Mode Battle 2 anonymous models',
  'side-by-side': 'Side by Side Compare 2 models of your choice',
  direct: 'Direct Chat with 1 model at a time',
}
