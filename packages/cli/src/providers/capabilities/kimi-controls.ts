import { firstVisibleLocator } from '../dom-locators.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  Choice,
  ChoiceInspectResult,
  ChoiceSelectResult,
  ProviderCapabilityInspection,
} from '../../playwright/actions.js'

export class KimiModelChoiceCapability implements ProviderActionCapability<'model.inspect' | 'model.select'> {
  readonly capability = PROVIDER_CAPABILITIES.MODEL_CHOICE
  readonly actions = Object.freeze([VISIBLE_ACTIONS.MODEL_INSPECT, VISIBLE_ACTIONS.MODEL_SELECT] as const)
  private readonly provider: ProviderDomDefinition<'kimi'>

  constructor(provider: ProviderDomDefinition<'kimi'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    return await inspectKimiChoiceCapability(page, this.provider, this.capability, this.actions, '.current-model')
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: 'model.inspect' | 'model.select' }>,
    _context: ProviderExecutionContext,
  ): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    const inspection = await inspectKimiModels(page, request.action === VISIBLE_ACTIONS.MODEL_SELECT)
    if (request.action === VISIBLE_ACTIONS.MODEL_INSPECT || !inspection.supported) return inspection
    const option = await exactKimiChoice(page.locator('.models-popover .model-item'), '.model-name', request.payload.label)
    if (!option) return missingChoice()
    await option.click({ timeout: 5_000 })
    const selected = await waitForText(page.locator('.current-model .name'), request.payload.label)
    if (selected) await page.waitForTimeout(750)
    return selectionResult(request.payload.label, selected)
  }
}

export class KimiEffortChoiceCapability implements ProviderActionCapability<'effort.inspect' | 'effort.select'> {
  readonly capability = PROVIDER_CAPABILITIES.EFFORT_CHOICE
  readonly actions = Object.freeze([VISIBLE_ACTIONS.EFFORT_INSPECT, VISIBLE_ACTIONS.EFFORT_SELECT] as const)
  private readonly provider: ProviderDomDefinition<'kimi'>

  constructor(provider: ProviderDomDefinition<'kimi'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    return await inspectKimiChoiceCapability(page, this.provider, this.capability, this.actions, '.current-model .current-effort')
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: 'effort.inspect' | 'effort.select' }>,
    _context: ProviderExecutionContext,
  ): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    const inspection = await inspectKimiEfforts(page, request.action === VISIBLE_ACTIONS.EFFORT_SELECT)
    if (request.action === VISIBLE_ACTIONS.EFFORT_INSPECT || !inspection.supported) return inspection
    const option = await exactKimiChoice(page.locator('.effort-popover .effort-option'), '.effort-name', request.payload.label)
    if (!option) return missingChoice()
    await option.evaluate((element) => (element as HTMLElement).click())
    const selected = await waitForText(page.locator('.current-model .current-effort'), request.payload.label)
    if (selected) await page.waitForTimeout(750)
    return selectionResult(request.payload.label, selected)
  }
}

async function inspectKimiChoiceCapability(
  page: Page,
  provider: ProviderDomDefinition<'kimi'>,
  capability: typeof PROVIDER_CAPABILITIES.MODEL_CHOICE | typeof PROVIDER_CAPABILITIES.EFFORT_CHOICE,
  actions: readonly ('model.inspect' | 'model.select' | 'effort.inspect' | 'effort.select')[],
  selector: string,
): Promise<ProviderCapabilityInspection> {
  const strategy = provider.capabilities[capability]
  const trigger = await firstVisibleLocator(page, [selector])
  const availability = trigger ? 'available' as const : 'unknown' as const
  const visibleProof = trigger ? 'visible-kimi-choice-control' : 'no-visible-kimi-choice-control'
  const reason = trigger ? null : 'visible_kimi_choice_control_not_observed'
  return {
    ...strategy,
    actions,
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

async function inspectKimiModels(page: Page, keepOpen: boolean): Promise<ChoiceInspectResult> {
  const trigger = await firstVisibleLocator(page, ['.current-model'])
  if (!trigger) return { supported: false as const, reason: 'selector_not_available' as const }
  await trigger.click({ timeout: 5_000 })
  const options = page.locator('.models-popover .model-item')
  await options.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  const choices = await collectKimiChoices(options, '.model-name')
  if (!keepOpen) await page.keyboard.press('Escape').catch(() => undefined)
  return { supported: true as const, choices }
}

async function inspectKimiEfforts(page: Page, keepOpen: boolean): Promise<ChoiceInspectResult> {
  const trigger = await firstVisibleLocator(page, ['.current-model'])
  if (!trigger) return { supported: false as const, reason: 'selector_not_available' as const }
  await trigger.click({ timeout: 5_000 })
  const effortTrigger = await firstVisibleLocator(page, ['.models-popover .effort-item'])
  if (!effortTrigger) {
    await page.keyboard.press('Escape').catch(() => undefined)
    return { supported: false as const, reason: 'selector_not_available' as const }
  }
  await effortTrigger.click({ timeout: 5_000 })
  const options = page.locator('.effort-popover .effort-option')
  await options.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  const choices = await collectKimiChoices(options, '.effort-name')
  if (!keepOpen) await page.keyboard.press('Escape').catch(() => undefined)
  return { supported: true as const, choices }
}

async function collectKimiChoices(options: Locator, labelSelector: string): Promise<Choice[]> {
  const choices: Choice[] = []
  const count = Math.min(await options.count(), 20)
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index)
    if (!await option.isVisible({ timeout: 100 }).catch(() => false)) continue
    const label = normalizeLabel(await option.locator(labelSelector).first().textContent().catch(() => ''))
    if (!label) continue
    choices.push({
      label,
      selected: await option.locator('.checked-icon').count() > 0 || await option.evaluate((element) => element.classList.contains('checked')),
      enabled: !await option.evaluate((element) => (
        element.getAttribute('aria-disabled') === 'true' ||
        element.classList.contains('disabled')
      )),
    })
  }
  return choices
}

async function exactKimiChoice(options: Locator, labelSelector: string, label: string): Promise<Locator | null> {
  const count = Math.min(await options.count(), 20)
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index)
    const candidate = normalizeLabel(await option.locator(labelSelector).first().textContent().catch(() => ''))
    if (candidate === label && await option.isVisible({ timeout: 100 }).catch(() => false)) return option
  }
  return null
}

async function waitForText(locator: Locator, expected: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    if (normalizeLabel(await locator.first().textContent().catch(() => '')) === expected) return true
    await locator.page().waitForTimeout(100)
  }
  return false
}

function normalizeLabel(value: string | null) {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

function missingChoice(): ChoiceSelectResult {
  return {
    supported: true as const,
    selectedLabel: '',
    visibleProof: 'exact-label-not-found',
  }
}

function selectionResult(label: string, selected: boolean): ChoiceSelectResult {
  return {
    supported: true as const,
    selectedLabel: selected ? label : '',
    visibleProof: selected ? 'exact-label-selected' : 'selected-label-not-visible',
  }
}
